// Songtexte von LRCLIB (kostenlos, ohne Konto) als .lrc neben die Musikdatei legen.
// Jellyfin liest die Datei ein, Finamp zeigt den Text mitlaufend an.
//
// Warum nicht das Jellyfin-Plugin "LrcLib"? Es fragt zu schnell (LRCLIB drosselt, das Plugin
// gibt nach zwei Versuchen auf) und braucht ein Künstler-Tag. Tonspur fragt einen Song pro
// Sekunde, wartet bei Drosselung und nimmt den Künstler notfalls aus dem Ordnernamen.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import * as downloads from './downloads.js';
import * as jellyfin from './jellyfin.js';
import { exists } from './media.js';
import { cleanTitle } from './spotify.js';
import { debounce, log, norm, readJson, writeJson } from './util.js';

const API = (process.env.LRCLIB_URL || 'https://lrclib.net/api').replace(/\/+$/, ''); // *_URL nur zum Testen
const UA = 'Tonspur/1.6 (selbst gehosteter Musikserver)';
const FILE = path.join(config.dataDir, 'lyrics.json');
const GAP_MS = Number(process.env.LRCLIB_GAP_MS) || 1100;
const RETRY_NONE = 30 * 24 * 60 * 60 * 1000; // "nicht gefunden" nach 30 Tagen erneut versuchen

/** @type {Record<string, {s: 'synced'|'plain'|'none'|'instrumental'|'had', at: number}>} Jellyfin-ID → Ergebnis */
let state = {};
let running = false;
let progress = null;

const save = () => writeJson(FILE, state).catch((err) => log('lyrics', err.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function init() {
  state = await readJson(FILE, {});
  // Nach neuen Downloads (Scan fertig) und einmal am Tag
  downloads.events.on('scanned', debounce(() => run().catch(() => {}), 2 * 60 * 1000));
  setTimeout(() => run().catch(() => {}), 5 * 60 * 1000);
  setInterval(() => run().catch(() => {}), 24 * 60 * 60 * 1000);
}

async function get(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500) {
      // Gedrosselt: deutlich länger warten als das Plugin
      await sleep((Number(res.headers.get('retry-after')) || 10 * (attempt + 1)) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
    return res.json();
  }
  throw new Error('LRCLIB drosselt dauerhaft');
}

// --- Abgleich ----------------------------------------------------------------
// Häufige Gründe für "nicht gefunden": Künstler-Tag mit mehreren Namen ("David Guetta; Sia",
// "A feat. B"), Titelzusätze ("- Radio Edit", "(Main Version)"), anderes Album oder eine
// Radio-Version mit ein paar Sekunden Unterschied. Deshalb mehrere Anfragen, lockerer Vergleich.

const SPLIT_ARTISTS = /\s*(?:,|;|\/|&|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\bvs\.?|\bund\b|\band\b)\s*/i;

function artistList(raw) {
  const out = [];
  for (const a of raw) for (const part of String(a ?? '').split(SPLIT_ARTISTS)) if (part.trim()) out.push(part.trim());
  return [...new Set(out)];
}

const stripDash = (t) => t.replace(/\s+[-–]\s+.*$/, '').trim() || t;
const stripBrackets = (t) => t.replace(/\s*[([][^)\]]*[)\]]/g, '').trim() || t;
const words = (t) => norm(t).split(' ').filter(Boolean);

function titleFits(want, got) {
  const a = norm(want);
  const b = norm(cleanTitle(stripBrackets(got)));
  if (!a || !b) return false;
  if (a === b || norm(cleanTitle(got)) === a) return true;
  // alle Wörter des kürzeren Titels im längeren ("Nocturne Op. 9 No. 2" ↔ "Nocturne in E-Flat, Op. 9 No. 2")
  const [s, l] = words(a).length <= words(b).length ? [words(a), new Set(words(b))] : [words(b), new Set(words(a))];
  return s.length >= 2 && s.every((w) => l.has(w));
}

/** Bester Treffer aus einer LRCLIB-Liste: Titel und Künstler passen, Länge ±10 s, mitlaufend bevorzugt. */
function pick(list, { titles, artists, duration }) {
  const na = artists.map(norm).filter(Boolean);
  const fits = (list ?? []).filter((r) => {
    if (!r.syncedLyrics && !r.plainLyrics && !r.instrumental) return false;
    const ra = norm(r.artistName ?? '');
    const artistOk = !na.length || na.some((a) => ra.includes(a) || a.includes(ra));
    const durOk = !duration || !r.duration || Math.abs(r.duration - duration) <= 10;
    return artistOk && durOk && titles.some((t) => titleFits(t, r.trackName ?? ''));
  });
  const diff = (r) => (duration && r.duration ? Math.abs(r.duration - duration) : 5);
  fits.sort((x, y) => Number(Boolean(y.syncedLyrics)) - Number(Boolean(x.syncedLyrics)) || diff(x) - diff(y));
  return fits[0] ?? null;
}

async function find({ title, artists: rawArtists, album, duration }) {
  const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
  const artists = artistList(rawArtists);
  const artist = artists[0] ?? '';
  const titles = [...new Set([title, cleanTitle(title), stripDash(title), stripBrackets(cleanTitle(title))])];
  const clean = stripBrackets(cleanTitle(title));
  const want = { titles, artists, duration };
  const ok = (r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental);

  // 1. exakt wie getaggt (Künstler-Tag ungeteilt, z. B. "Simon & Garfunkel")
  let r = await get(`${API}/get?${q({ track_name: title, artist_name: rawArtists[0] ?? artist, album_name: album, duration })}`);
  if (ok(r)) return r;
  // 2. bereinigter Titel, ohne Album
  if (clean !== title || album) {
    await sleep(GAP_MS);
    r = await get(`${API}/get?${q({ track_name: clean, artist_name: artist, duration })}`);
    if (ok(r) && pick([r], want)) return r;
  }
  // 3. Suche nach Titel + Hauptkünstler
  await sleep(GAP_MS);
  let hit = pick(await get(`${API}/search?${q({ track_name: clean, artist_name: artist })}`), want);
  if (hit) return hit;
  // 4. Freitextsuche (findet auch, wenn LRCLIB Künstler anders schreibt)
  await sleep(GAP_MS);
  hit = pick(await get(`${API}/search?${q({ q: `${artist} ${clean}`.trim() })}`), want);
  if (hit) return hit;
  // 5. nur der Titel – Künstler muss dann trotzdem passen
  await sleep(GAP_MS);
  return pick(await get(`${API}/search?${q({ track_name: clean })}`), want);
}

const AUDIO = /\.(mp3|m4a|flac|ogg|opus|aac|wav)$/i;

async function one(item) {
  const file = await jellyfin.localPath(item.Path);
  if (!file || !AUDIO.test(file)) return null;
  const base = file.replace(AUDIO, '');
  // Liegt schon ein Songtext daneben (z. B. von Deemix), nichts tun
  if ((await exists(`${base}.lrc`)) || (await exists(`${base}.txt`))) return 'had';

  // Künstler: Tag, sonst Album-Künstler, sonst Ordnername (<Künstler>/<Album>/<Datei>)
  const parts = file.split(path.sep);
  const artists = item.Artists?.length ? item.Artists : [item.AlbumArtist || parts[parts.length - 3] || ''];
  const hit = await find({
    title: item.Name,
    artists,
    album: item.Album,
    duration: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 1e7) : null,
  });
  if (!hit) return 'none';
  if (hit.instrumental && !hit.syncedLyrics && !hit.plainLyrics) return 'instrumental';
  if (hit.syncedLyrics) await fs.writeFile(`${base}.lrc`, hit.syncedLyrics);
  else await fs.writeFile(`${base}.txt`, hit.plainLyrics);
  await jellyfin.refreshItem(item.Id).catch((err) => log('lyrics', `Jellyfin-Refresh: ${err.message}`));
  return hit.syncedLyrics ? 'synced' : 'plain';
}

export async function run({ retryNone = false } = {}) {
  if (running) return progress;
  running = true;
  try {
    const items = await jellyfin.audioItems();
    const todo = items.filter((i) => {
      if (i.HasLyrics) return false; // Text in der Datei oder schon von Jellyfin gefunden
      const st = state[i.Id];
      if (!st) return true;
      return st.s === 'none' && (retryNone || Date.now() - st.at > RETRY_NONE);
    });
    progress = { total: todo.length, done: 0, found: 0 };
    if (todo.length) log('lyrics', `suche Songtexte für ${todo.length} Songs`);
    for (const item of todo) {
      try {
        const s = await one(item);
        if (s) state[item.Id] = { s, at: Date.now(), n: `${item.Artists?.[0] ?? item.AlbumArtist ?? ''} – ${item.Name}` };
        if (s === 'synced' || s === 'plain') progress.found++;
      } catch (err) {
        log('lyrics', `${item.Name}: ${err.message}`);
        if (/drosselt/.test(err.message)) break; // später weiter
      }
      progress.done++;
      if (progress.done % 20 === 0) await save();
      await sleep(GAP_MS);
    }
    if (todo.length) log('lyrics', `${progress.found} von ${todo.length} Songtexten gefunden`);
    return progress;
  } finally {
    running = false;
    await save();
  }
}

export function status() {
  const c = { synced: 0, plain: 0, had: 0, none: 0, instrumental: 0 };
  for (const e of Object.values(state)) c[e.s] = (c[e.s] ?? 0) + 1;
  const missing = Object.values(state).filter((e) => e.s === 'none' && e.n).map((e) => e.n).sort((x, y) => x.localeCompare(y, 'de'));
  return { running, progress, counts: c, missing };
}

export function start(opts) {
  if (!running) run(opts).catch((err) => log('lyrics', err.message));
  return status();
}

// Nur für Tests
export const _test = { artistList, titleFits, pick };
