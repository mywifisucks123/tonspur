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
import { HttpError, debounce, log, readJson, writeJson } from './util.js';

const FILE = path.join(config.dataDir, 'sync.json');
/** @type {Record<string, {enabled: boolean, mode?: 'mirror'|'keep', history?: object[], jellyfinId?: string, lastRefresh?: number, lastBuild?: number, result?: object, error?: string|null}>} */
let state = {};
const running = new Set();

const save = () => writeJson(FILE, state).catch((err) => log('sync', `Speichern: ${err.message}`));

export async function init() {
  state = await readJson(FILE, {});

  // Playlists aus der .env übernehmen (praktisch ohne Oberfläche, z. B. im Docker-Betrieb).
  // Ein angehängtes "|behalten" schaltet den Modus "Songs behalten" ein.
  for (const entry of config.sync.playlists) {
    const [link, flag] = entry.split('|');
    const ref = spotify.parseLink(link);
    if (!ref) {
      log('sync', `Kein Spotify-Link: ${link}`);
      continue;
    }
    const id = `sp-${ref.type}-${ref.id}`;
    if (!state[id]) state[id] = { enabled: true, mode: /^(behalten|keep)$/i.test(flag ?? '') ? 'keep' : 'mirror' };
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
    const { history, ...rest } = s;
    return { id, title, mode: 'mirror', ...rest, kept: history?.length ?? 0 };
  });
}

export function get(id) {
  const s = state[id] ?? { enabled: false };
  // Den Verlauf braucht die Oberfläche nicht, nur seine Größe
  const { history, ...rest } = s;
  return { mode: 'mirror', ...rest, kept: history?.length ?? 0 };
}

/**
 * Modus pro Playlist:
 *   mirror – exakt wie bei Spotify, entfernte Songs fliegen raus (z. B. Charts)
 *   keep   – neue Songs kommen dazu, alte bleiben in der Playlist (z. B. "meine Musik")
 */
export async function setMode(id, mode) {
  if (!['mirror', 'keep'].includes(mode)) throw new HttpError(400, 'mode muss mirror oder keep sein');
  imports.get(id);
  state[id] = { ...(state[id] ?? { enabled: false }), mode };
  // Beim Wechsel auf "behalten" zählt der aktuelle Spotify-Stand als Ausgangspunkt;
  // ein alter Verlauf von früher würde längst entfernte Songs zurückholen
  if (mode === 'mirror') delete state[id].history;
  await save();
  if (state[id].enabled) await build(id).catch((err) => log('sync', `${id}: ${err.message}`));
  return get(id);
}

export async function setEnabled(id, enabled) {
  const imp = imports.get(id); // wirft 404, wenn es den Import nicht gibt
  state[id] = { mode: 'mirror', ...(state[id] ?? {}), enabled, link: imp.link };
  await save();
  if (enabled) refresh(id).catch(() => {});
  return get(id);
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
  const current = [...playlist.tracks, ...(playlist.missingTracks ?? [])];
  // Reihenfolge wie bei Spotify; Deezer-Titel und Nur-YouTube-Titel stehen getrennt im Import,
  // deshalb über die Original-Position sortieren, falls vorhanden
  current.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  let wanted = current;
  if (s.mode === 'keep') {
    // Alles merken, was je in der Playlist war. Aktuelle Spotify-Titel stehen vorn in
    // Spotify-Reihenfolge, bei Spotify entfernte Titel bleiben dahinter erhalten.
    const key = (t) => `${t.source}:${t.id}`;
    s.history ??= [];
    const known = new Set(s.history.map(key));
    for (const t of current) {
      if (known.has(key(t))) continue;
      s.history.push({ id: t.id, source: t.source, title: t.title, artist: t.artist, artists: t.artists, album: t.album, duration: t.duration });
      known.add(key(t));
    }
    const now = new Set(current.map(key));
    wanted = [...current, ...s.history.filter((t) => !now.has(key(t)))];
  }

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
    s.result = { total: wanted.length, current: current.length, inLibrary: 0, pending };
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
  s.result = { total: wanted.length, current: current.length, inLibrary: ids.length, pending };
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
