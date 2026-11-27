// Aufräumen: Songs löschen, die über einen Spotify-Sync kamen und seit X Tagen in keiner
// Playlist mehr stehen (typisch: aus den Charts gefallen).
//
// Geschützt bleibt alles, was
//   - in irgendeiner Jellyfin-Playlist steht (auch selbst in Finamp angelegte),
//   - in Jellyfin/Finamp oder Tonspur als Favorit markiert ist (Song oder Album),
//   - innerhalb der Frist gehört wurde,
//   - nie über einen Tonspur-Sync in eine Playlist kam (manuelle Downloads, Alben …).
// Ausgeschaltet (Standard) löscht Tonspur nichts, zeigt aber eine Vorschau.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import * as favorites from './favorites.js';
import * as jellyfin from './jellyfin.js';
import * as notify from './notify.js';
import * as settings from './settings.js';
import { HttpError, debounce, log, norm, readJson, writeJson } from './util.js';

const FILE = path.join(config.dataDir, 'cleanup.json');
const DAY = Number(process.env.CLEANUP_DAY_MS) || 24 * 60 * 60 * 1000; // *_MS nur zum Testen
const AUDIO = /\.(mp3|m4a|flac|ogg|opus|aac|wav)$/i;
const SIDECAR = /\.(jpe?g|png|webp|lrc|txt|nfo)$/i;

/** @type {Record<string, {name?: string, lastSeen: number}>} Jellyfin-ID → zuletzt in einer Playlist gesehen */
let ledger = {};
let running = false;
let lastRun = null;

const save = debounce(() => writeJson(FILE, { ledger, lastRun }).catch((err) => log('cleanup', err.message)), 2000);

export async function init() {
  const saved = await readJson(FILE, {});
  ledger = saved.ledger ?? {};
  lastRun = saved.lastRun ?? null;
  // Einmal am Tag (erster Lauf 15 min nach dem Start)
  setTimeout(() => run().catch((err) => log('cleanup', err.message)), 15 * 60 * 1000);
  setInterval(() => run().catch((err) => log('cleanup', err.message)), 24 * 60 * 60 * 1000);
}

/** Vom Sync aufgerufen: diese Songs stehen gerade in einer Tonspur-Playlist. */
export function remember(items) {
  const now = Date.now();
  for (const { id, name } of items) ledger[id] = { name: name ?? ledger[id]?.name, lastSeen: now };
  if (items.length) save();
}

async function tonspurFavorites() {
  const fav = favorites.all();
  const ids = new Set();
  for (const t of fav.tracks) {
    if (t.source === 'jf') ids.add(t.id);
    else {
      const hit = await jellyfin.findLocal(t).catch(() => null);
      if (hit) ids.add(hit.id);
    }
  }
  const albums = fav.albums.map((a) => ({ title: norm(a.title), artist: norm(a.artist) }));
  return { ids, albums };
}

/** Was würde jetzt gelöscht? Aktualisiert nebenbei "zuletzt gesehen" für geschützte Songs. */
export async function evaluate() {
  const { days } = settings.get().cleanup;
  const now = Date.now();
  const cutoff = now - days * DAY;
  const ids = Object.keys(ledger);
  if (!ids.length) return { candidates: [], waiting: 0, tracked: 0, days };

  const inPlaylists = await jellyfin.allPlaylistItemIds();
  for (const id of ids) if (inPlaylists.has(id)) ledger[id].lastSeen = now;

  const old = ids.filter((id) => ledger[id].lastSeen < cutoff);
  const candidates = [];
  if (old.length) {
    const items = await jellyfin.itemsByIds(old);
    const present = new Set(items.map((i) => i.Id));
    for (const id of old) if (!present.has(id)) delete ledger[id]; // Datei gibt es nicht mehr
    const [jfFav, tsFav] = await Promise.all([jellyfin.favorites(), tonspurFavorites()]);

    for (const item of items) {
      const ud = item.UserData ?? {};
      const played = ud.LastPlayedDate && Date.parse(ud.LastPlayedDate) > cutoff;
      const albumFav = tsFav.albums.some(
        (a) => a.title === norm(item.Album ?? '') && (!a.artist || norm(item.AlbumArtist ?? item.Artists?.join(' ') ?? '').includes(a.artist)),
      );
      const fav = ud.IsFavorite || jfFav.tracks.has(item.Id) || jfFav.albums.has(item.AlbumId) || tsFav.ids.has(item.Id) || albumFav;
      if (fav || played) {
        ledger[item.Id].lastSeen = now;
        continue;
      }
      candidates.push({
        id: item.Id,
        name: `${item.Artists?.[0] ?? item.AlbumArtist ?? ''} – ${item.Name}`,
        path: item.Path,
        since: ledger[item.Id].lastSeen,
      });
    }
  }
  save();
  const waiting = Object.entries(ledger).filter(([id, e]) => !inPlaylists.has(id) && e.lastSeen >= cutoff && e.lastSeen < now).length;
  return { candidates, waiting, tracked: Object.keys(ledger).length, days };
}

/** Audiodatei samt Begleitdateien löschen, danach leere Ordner bis hoch zum Musikordner. */
async function removeFile(file) {
  if (!AUDIO.test(file)) throw new Error('keine Audiodatei');
  await fs.unlink(file);
  const base = file.replace(AUDIO, '');
  for (const ext of ['.lrc', '.txt']) await fs.unlink(base + ext).catch(() => {});

  let dir = path.dirname(file);
  const root = path.resolve(config.musicDir);
  while (path.resolve(dir).startsWith(root + path.sep)) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) break;
    // Ordner mit anderer Musik oder Unterordnern bleibt
    if (entries.some((e) => e.isDirectory() || !SIDECAR.test(e.name))) break;
    for (const e of entries) await fs.unlink(path.join(dir, e.name)).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
    dir = path.dirname(dir);
  }
}

export async function run({ manual = false } = {}) {
  const { enabled } = settings.get().cleanup;
  if (!enabled) {
    if (manual) throw new HttpError(409, 'Aufräumen ist ausgeschaltet');
    return null;
  }
  if (running) throw new HttpError(409, 'Aufräumen läuft schon');
  running = true;
  try {
    const { candidates } = await evaluate();
    const deleted = [];
    const skipped = [];
    for (const c of candidates) {
      const file = await jellyfin.localPath(c.path);
      if (!file) {
        skipped.push(c.name);
        continue;
      }
      try {
        await removeFile(file);
        delete ledger[c.id];
        deleted.push(c.name);
        log('cleanup', `gelöscht: ${c.name}`);
      } catch (err) {
        skipped.push(c.name);
        log('cleanup', `${c.name}: ${err.message}`);
      }
    }
    lastRun = { at: Date.now(), deleted: deleted.length, skipped: skipped.length };
    save();
    if (deleted.length) {
      await jellyfin.refreshLibrary().catch(() => {});
      notify.quiet(
        `Aufgeräumt: ${deleted.length} Song${deleted.length === 1 ? '' : 's'} gelöscht`,
        deleted.slice(0, 10).join('\n') + (deleted.length > 10 ? `\n… und ${deleted.length - 10} weitere` : ''),
        { tags: ['wastebasket'] },
      );
    }
    return { deleted, skipped };
  } finally {
    running = false;
  }
}

export async function status() {
  const s = settings.get().cleanup;
  const preview = await evaluate();
  return { ...s, ...preview, lastRun, running };
}
