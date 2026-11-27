// Qualitäts-Upgrade: Songs unter 320 kbps (YouTube-Rückfälle, alte 128er, SoundCloud)
// noch einmal von Deezer in MP3 320 laden – sinnvoll, solange Deezer Premium läuft.
//
// Ablauf pro Song: alte Datei in "<name>.tonspur-alt" umbenennen (Jellyfin ignoriert sie),
// Deemix lädt neu, nach dem nächsten Jellyfin-Scan wird geprüft, ob der Song jetzt in
// guter Qualität da ist. Ja → alte Datei weg. Nein → alte Datei kommt zurück.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import * as deemix from './deemix.js';
import * as deezer from './deezer.js';
import * as downloads from './downloads.js';
import * as jellyfin from './jellyfin.js';
import { exists } from './media.js';
import * as notify from './notify.js';
import * as spotify from './spotify.js';
import { HttpError, log, readJson, writeJson } from './util.js';

const FILE = path.join(config.dataDir, 'upgrade.json');
const GOOD = 256000; // ab hier gilt ein Song als "gut" (MP3 320 hat ~320 000)
const LOSSLESS = /flac|alac|wav|aiff/;
const GIVE_UP_MS = 45 * 60 * 1000; // fertig geladen, aber nach 45 min nicht in Jellyfin → zurück

/** @type {Record<string, {name: string, status: 'queued'|'done'|'failed'|'nomatch', from?: number, original?: string, backup?: string, dzId?: string, jobKey?: string, error?: string, at: number}>} */
let state = {};
let running = false;

const save = () => writeJson(FILE, state).catch((err) => log('upgrade', err.message));

export async function init() {
  state = await readJson(FILE, {});
  downloads.events.on('scanned', () => verify().catch((err) => log('upgrade', err.message)));
  // Gescheiterte Upgrades sofort zurückrollen, nicht erst beim nächsten Scan
  downloads.events.on('finished', (job) => {
    if (job.upgrade && job.status === 'failed') verify().catch((err) => log('upgrade', err.message));
  });
  // Zusätzlich regelmäßig, falls ein Jellyfin-Scan länger dauert als gedacht
  setInterval(() => {
    if (Object.values(state).some((e) => e.status === 'queued')) verify().catch(() => {});
  }, 10 * 60 * 1000);
}

const isLow = (item) => {
  const { bitrate, codec } = jellyfin.audioInfo(item);
  return Boolean(bitrate) && bitrate < GOOD && !LOSSLESS.test(codec);
};

async function scan() {
  const items = await jellyfin.audioItems();
  return items.filter(isLow).map((i) => ({
    id: i.Id,
    title: i.Name,
    artist: i.Artists?.[0] ?? i.AlbumArtist ?? '',
    name: `${i.Artists?.[0] ?? i.AlbumArtist ?? ''} – ${i.Name}`,
    duration: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 1e7) : 0,
    kbps: Math.round(jellyfin.audioInfo(i).bitrate / 1000),
    path: i.Path,
  }));
}

function counts() {
  const c = { queued: 0, done: 0, failed: 0, nomatch: 0 };
  for (const e of Object.values(state)) c[e.status] = (c[e.status] ?? 0) + 1;
  return c;
}

export async function status() {
  const low = await scan();
  return {
    low: low.length,
    // Songs, die schon einmal ohne Erfolg versucht wurden, extra zählen
    open: low.filter((l) => !state[l.id]).length,
    sample: low.slice(0, 40).map(({ name, kbps }) => ({ name, kbps })),
    quality: deemix.quality(),
    running,
    counts: counts(),
  };
}

export async function start() {
  if (running) throw new HttpError(409, 'Upgrade läuft schon');
  if (deemix.quality().bitrate < 3) {
    throw new HttpError(409, 'Deemix lädt gerade nur MP3 128 – erst Premium-ARL eintragen und Tonspur neu starten');
  }
  const low = (await scan()).filter((l) => !state[l.id]);
  running = true;
  (async () => {
    let queued = 0;
    for (const item of low) {
      try {
        const dz = await spotify.findOnDeezer({ title: item.title, artist: item.artist, artists: [item.artist], duration: item.duration });
        // Streng: die alte Datei wird ersetzt, ein falscher Treffer (z. B. DJ-Mix ↔ gleichnamiger
        // Song) wäre ein Verlust. Deshalb muss auch die Länge auf 5 s passen.
        if (!dz || !item.duration || !dz.duration || Math.abs(item.duration - dz.duration) > 5) {
          state[item.id] = { name: item.name, status: 'nomatch', at: Date.now() };
          continue;
        }
        const original = await jellyfin.localPath(item.path);
        if (!original) {
          state[item.id] = { name: item.name, status: 'failed', error: 'Datei nicht gefunden', at: Date.now() };
          continue;
        }
        const backup = `${original}.tonspur-alt`;
        await fs.rename(original, backup);
        state[item.id] = { name: item.name, status: 'queued', from: item.kbps, original, backup, dzId: String(dz.id), at: Date.now() };
        await save();
        const job = await downloads.enqueue({ type: 'track', id: String(dz.id), reason: 'Qualitäts-Upgrade', force: true, meta: { upgrade: true } });
        state[item.id].jobKey = job.key;
        queued++;
        if (job.status === 'failed') await giveBack(item.id, job.error);
      } catch (err) {
        log('upgrade', `${item.name}: ${err.message}`);
        if (state[item.id]?.backup) await giveBack(item.id, err.message);
        else state[item.id] = { name: item.name, status: 'failed', error: err.message, at: Date.now() };
      } finally {
        await save();
      }
    }
    spotify.saveMatches();
    log('upgrade', `${queued} von ${low.length} Songs werden in 320 neu geladen`);
  })()
    .catch((err) => log('upgrade', err.message))
    .finally(() => {
      running = false;
    });
  return { started: low.length };
}

/** Upgrade gescheitert → alte Datei zurück an ihren Platz. */
async function giveBack(id, error) {
  const e = state[id];
  if (await exists(e.backup)) {
    if (await exists(e.original)) await fs.unlink(e.backup); // neue Datei liegt schon dort
    else await fs.rename(e.backup, e.original);
  }
  Object.assign(e, { status: 'failed', error: error ?? 'fehlgeschlagen', at: Date.now() });
  log('upgrade', `${e.name}: ${e.error} – alte Datei bleibt`);
}

let verifying = false;
/** Nach jedem Jellyfin-Scan: Sind die neuen Dateien da und gut? */
export async function verify() {
  if (verifying) return;
  verifying = true;
  let finished = 0;
  try {
    for (const [id, e] of Object.entries(state)) {
      if (e.status !== 'queued' || !e.jobKey) continue;
      const job = downloads.get(e.jobKey);
      if (!job || job.status === 'failed') {
        await giveBack(id, job?.error ?? 'Download verschwunden');
        finished++;
        continue;
      }
      if (job.status !== 'done') continue;
      jellyfin.forgetMatches();
      const track = await deezer.track(e.dzId);
      const hit = await jellyfin.findLocal(track).catch(() => null);
      const [item] = hit ? await jellyfin.itemsByIds([hit.id]) : [];
      if (item && !isLow(item)) {
        await fs.unlink(e.backup).catch(() => {});
        Object.assign(e, { status: 'done', at: Date.now(), to: Math.round(jellyfin.audioInfo(item).bitrate / 1000) });
        finished++;
      } else if (Date.now() - (job.updatedAt ?? 0) > GIVE_UP_MS) {
        await giveBack(id, 'neue Datei nicht in Jellyfin gefunden');
        finished++;
      }
    }
  } finally {
    verifying = false;
    await save();
  }
  const c = counts();
  if (finished && !c.queued && !running) {
    notify.quiet('Qualitäts-Upgrade fertig', `${c.done} ${c.done === 1 ? 'Song' : 'Songs'} jetzt in 320 kbps · ${c.nomatch} nicht bei Deezer · ${c.failed} fehlgeschlagen`, { tags: ['sparkles'] });
  }
}

/** Fehlgeschlagene und nicht gefundene noch einmal versuchen (z. B. nach neuer ARL). */
export async function reset() {
  for (const [id, e] of Object.entries(state)) if (e.status === 'failed' || e.status === 'nomatch') delete state[id];
  await save();
}
