// Spotify-Playlists dauerhaft als Jellyfin-Playlists spiegeln.
//
// Ablauf pro Playlist:
//   1. aktuelle Titelliste von Spotify holen und mit Deezer abgleichen (spotify.js)
//   2. fehlende Titel laden: Deezer-Treffer über Deemix (Rückfall YouTube),
//      Titel ohne Deezer-Treffer direkt von YouTube
//   3. Jellyfin-Playlist auf genau die Titel setzen, die schon in der Bibliothek liegen
//
// Schritt 1–2 laufen im festen Takt (SYNC_INTERVAL_HOURS), Schritt 3 zusätzlich nach jedem
// Jellyfin-Scan – so wächst die Playlist mit, während Downloads fertig werden.
import path from 'node:path';
import { config } from './config.js';
import * as downloads from './downloads.js';
import * as imports from './imports.js';
import * as jellyfin from './jellyfin.js';
import * as spotify from './spotify.js';
import { debounce, log, readJson, writeJson } from './util.js';

const FILE = path.join(config.dataDir, 'sync.json');
/** @type {Record<string, {enabled: boolean, jellyfinId?: string, lastRefresh?: number, lastBuild?: number, result?: object, error?: string|null}>} */
let state = {};
const running = new Set();

const save = () => writeJson(FILE, state).catch((err) => log('sync', `Speichern: ${err.message}`));

export async function init() {
  state = await readJson(FILE, {});

  // Playlists aus der .env übernehmen (praktisch ohne Oberfläche, z. B. im Docker-Betrieb)
  for (const link of config.sync.playlists) {
    const ref = spotify.parseLink(link);
    if (!ref) {
      log('sync', `Kein Spotify-Link: ${link}`);
      continue;
    }
    const id = `sp-${ref.type}-${ref.id}`;
    if (!state[id]) state[id] = { enabled: true };
    state[id].link = `https://open.spotify.com/${ref.type}/${ref.id}`;
  }
  await save();

  downloads.events.on('scanned', debounce(() => buildAll(), 30000));
  setTimeout(() => refreshAll(), 60 * 1000);
  setInterval(() => refreshAll(), Math.max(1, config.sync.intervalHours) * 60 * 60 * 1000);
}

export function status() {
  return Object.entries(state).map(([id, s]) => {
    let title = null;
    try {
      title = imports.get(id).title;
    } catch {}
    return { id, title, ...s };
  });
}

export function get(id) {
  return state[id] ?? { enabled: false };
}

export async function setEnabled(id, enabled) {
  const imp = imports.get(id); // wirft 404, wenn es den Import nicht gibt
  state[id] = { ...(state[id] ?? {}), enabled, link: imp.link };
  await save();
  if (enabled) refresh(id).catch(() => {});
  return state[id];
}

/** Spotify neu lesen, Downloads anstoßen, Jellyfin-Playlist aktualisieren. */
export async function refresh(id) {
  if (running.has(id)) return state[id];
  running.add(id);
  const s = state[id];
  try {
    let link = s.link;
    if (!link) link = imports.get(id).link;
    const playlist = await imports.save(await spotify.importLink(link));
    s.lastRefresh = Date.now();

    // Deezer-Titel über Deemix (mit YouTube-Rückfall), der Rest direkt über YouTube
    downloads.enqueueMany(playlist.tracks.map((t) => t.id), `Sync ${playlist.title}`).catch(() => {});
    (async () => {
      for (const t of playlist.missingTracks ?? []) {
        await downloads
          .enqueue({ type: 'yt', id: t.id, reason: `Sync ${playlist.title}`, meta: t })
          .catch((err) => log('sync', `${t.artist} – ${t.title}: ${err.message}`));
      }
    })();

    await build(id);
    s.error = null;
  } catch (err) {
    s.error = err.message;
    log('sync', `${id}: ${err.message}`);
  } finally {
    running.delete(id);
    await save();
  }
  return s;
}

/** Jellyfin-Playlist auf den aktuellen Stand der Bibliothek bringen (ohne Spotify zu fragen). */
export async function build(id) {
  const s = state[id];
  if (!s?.enabled) return;
  const playlist = imports.get(id);
  const wanted = [...playlist.tracks, ...(playlist.missingTracks ?? [])];
  // Reihenfolge wie bei Spotify; Deezer-Titel und Nur-YouTube-Titel stehen getrennt im Import,
  // deshalb über die Original-Position sortieren, falls vorhanden
  wanted.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  // Frisch nachsehen: "noch nicht da" darf nicht aus dem Zwischenspeicher kommen
  jellyfin.forgetMatches();
  const ids = [];
  let pending = 0;
  for (const t of wanted) {
    const hit = await jellyfin.findLocal(t).catch(() => null);
    if (hit && !ids.includes(hit.id)) ids.push(hit.id);
    else if (!hit) pending++;
  }

  if (!ids.length && !s.jellyfinId) {
    s.result = { total: wanted.length, inLibrary: 0, pending };
    return;
  }
  if (!s.jellyfinId || !(await jellyfin.playlistExists(s.jellyfinId))) {
    s.jellyfinId = await jellyfin.createPlaylist(playlist.title, ids);
  } else if (await jellyfin.setPlaylistItems(s.jellyfinId, ids)) {
    log('sync', `${playlist.title}: ${ids.length}/${wanted.length} Titel in Jellyfin`);
  }
  // Spotify-Cover als Playlist-Bild – nur wenn es neu ist oder sich geändert hat
  if (playlist.cover && s.coverUrl !== playlist.cover) {
    try {
      await jellyfin.setItemImage(s.jellyfinId, playlist.cover);
      s.coverUrl = playlist.cover;
    } catch (err) {
      log('sync', `${playlist.title}: Cover nicht gesetzt (${err.message})`);
    }
  }
  s.lastBuild = Date.now();
  s.result = { total: wanted.length, inLibrary: ids.length, pending };
  await save();
}

async function refreshAll() {
  for (const [id, s] of Object.entries(state)) {
    if (s.enabled) await refresh(id);
  }
}

async function buildAll() {
  for (const [id, s] of Object.entries(state)) {
    if (!s.enabled || running.has(id)) continue;
    await build(id).catch((err) => log('sync', `${id}: ${err.message}`));
  }
}
