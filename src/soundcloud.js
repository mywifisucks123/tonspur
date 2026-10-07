// SoundCloud: Suche und Playlists über die Web-API (wie soundcloud.com selbst),
// Audio über yt-dlp als MP3 in einen Zwischenspeicher. Kein Konto nötig.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { exists, ffmpeg, pruneDir, touch } from './media.js';
import { HttpError, Limiter, TtlCache, log, readJson, writeJson } from './util.js';
import * as yt from './ytdlp.js';

// *_URL nur zum Testen gegen einen Mock
const API = (process.env.SOUNDCLOUD_API_URL || 'https://api-v2.soundcloud.com').replace(/\/+$/, '');
const SITE = (process.env.SOUNDCLOUD_SITE_URL || 'https://soundcloud.com').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const cache = new TtlCache(10 * 60 * 1000, 1000);
const limiter = new Limiter(2);
const CACHE_DIR = path.join(config.cacheDir, 'sc');
const LIB_FILE = path.join(config.dataDir, 'sc-library.json');
let library = {};

export async function init() {
  library = await readJson(LIB_FILE, {});
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

// --- API -------------------------------------------------------------------

// SoundCloud hat keine offene API mehr; die eigene Website nutzt eine client_id,
// die in ihren Skripten steht. yt-dlp macht es genauso.
let clientIdPromise;
function clientId(force = false) {
  if (force) clientIdPromise = undefined;
  clientIdPromise ??= (async () => {
    const get = (u) => fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }).then((r) => r.text());
    const html = await get(`${SITE}/`);
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]).reverse();
    for (const src of scripts) {
      const m = /client_id\s*[:=]\s*"([0-9a-zA-Z]{32})"/.exec(await get(src).catch(() => ''));
      if (m) return m[1];
    }
    throw new HttpError(502, 'SoundCloud: client_id nicht gefunden');
  })().catch((err) => {
    clientIdPromise = undefined;
    throw err;
  });
  return clientIdPromise;
}

async function sc(pathAndQuery) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await clientId(attempt > 0);
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const res = await fetch(`${API}${pathAndQuery}${sep}client_id=${id}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    if (res.status === 404) throw new HttpError(404, 'Nicht auf SoundCloud gefunden');
    if (!res.ok) throw new HttpError(502, `SoundCloud ${res.status}`);
    return res.json();
  }
  throw new HttpError(502, 'SoundCloud verweigert den Zugriff');
}

const cached = (p, ttl) => cache.wrap(p, () => sc(p), ttl);

// Cover in größerer Auflösung: "...-large.jpg" → "...-t500x500.jpg"
const art = (url, size) => (url ? url.replace(/-large(\.\w+)(\?.*)?$/, `-${size}$1`) : null);

// SNIP = nur 30-s-Ausschnitt (Go+), BLOCK = in DE gesperrt
const playable = (t) => t?.title && !['BLOCK', 'SNIP'].includes(t.policy) && t.streamable !== false;

export function mapTrack(t) {
  const cover = t.artwork_url || t.user?.avatar_url;
  return {
    id: String(t.id),
    source: 'sc',
    title: t.title,
    artist: t.publisher_metadata?.artist || t.user?.username || '',
    artistId: null,
    album: '',
    albumId: null,
    cover: art(cover, 't500x500'),
    coverSmall: art(cover, 't300x300'),
    duration: Math.round((t.full_duration ?? t.duration ?? 0) / 1000),
    preview: null,
    permalink: t.permalink_url,
    local: Boolean(library[String(t.id)]),
  };
}

export function mapPlaylist(p) {
  const cover = p.artwork_url || p.tracks?.find((t) => t.artwork_url)?.artwork_url || p.user?.avatar_url;
  return {
    id: String(p.id),
    source: 'sc',
    title: p.title,
    owner: p.user?.username ?? '',
    cover: art(cover, 't500x500'),
    coverSmall: art(cover, 't300x300'),
    trackCount: p.track_count ?? p.tracks?.length ?? null,
  };
}

export async function search(q) {
  const term = encodeURIComponent(q);
  const [tracks, playlists] = await Promise.all([
    cached(`/search/tracks?q=${term}&limit=30`, 5 * 60 * 1000),
    cached(`/search/playlists?q=${term}&limit=15`, 5 * 60 * 1000).catch(() => ({ collection: [] })),
  ]);
  return {
    tracks: (tracks.collection ?? []).filter(playable).map(mapTrack),
    playlists: (playlists.collection ?? []).filter((p) => p.track_count > 0).map(mapPlaylist),
  };
}

export async function track(id) {
  return mapTrack(await cached(`/tracks/${encodeURIComponent(id)}`, 60 * 60 * 1000));
}

export async function playlist(id) {
  const p = await cached(`/playlists/${encodeURIComponent(id)}`, 30 * 60 * 1000);
  // Nur die ersten Titel kommen vollständig, der Rest nur als ID → nachladen (max. 50 pro Abruf)
  const all = p.tracks ?? [];
  const full = new Map(all.filter((t) => t.title).map((t) => [t.id, t]));
  const missing = all.filter((t) => !t.title).map((t) => t.id);
  for (let i = 0; i < missing.length; i += 50) {
    const batch = await cached(`/tracks?ids=${missing.slice(i, i + 50).join(',')}`, 30 * 60 * 1000);
    for (const t of Array.isArray(batch) ? batch : batch.collection ?? []) full.set(t.id, t);
  }
  return {
    ...mapPlaylist(p),
    tracks: all.map((t) => full.get(t.id)).filter(playable).map(mapTrack),
  };
}

/** soundcloud.com-Link → Track oder Playlist */
export async function resolveUrl(url) {
  const r = await sc(`/resolve?url=${encodeURIComponent(url.split('?')[0])}`);
  if (r.kind === 'track') return { kind: 'track', track: mapTrack(r) };
  if (r.kind === 'playlist') return { kind: 'playlist', id: String(r.id) };
  throw new HttpError(400, 'Nur SoundCloud-Songs und -Playlists werden unterstützt');
}

export async function ping() {
  await clientId();
  return { ok: true };
}

// --- Audio -----------------------------------------------------------------

const pending = new Map();

/** Pfad zu einer abspielbaren MP3 – aus der Bibliothek, dem Zwischenspeicher oder frisch geladen. */
export async function audioFile(id, { urgent = false } = {}) {
  const lib = library[id];
  if (lib && (await exists(lib))) return lib;
  const file = path.join(CACHE_DIR, `${id}.mp3`);
  if (await exists(file)) {
    touch(file);
    return file;
  }
  if (!pending.has(id)) {
    const job = limiter
      .run(async () => {
        const t = await track(id);
        const started = Date.now();
        await yt.downloadAudio(t.permalink, path.join(CACHE_DIR, id));
        if (!(await exists(file))) throw new Error('yt-dlp hat keine MP3 erzeugt (ffmpeg installiert?)');
        log('soundcloud', `${t.artist} – ${t.title} geladen (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        pruneCache().catch(() => {});
        return file;
      }, { urgent, key: id })
      .finally(() => pending.delete(id));
    pending.set(id, job);
  } else if (urgent) {
    limiter.promote(id);
  }
  return pending.get(id);
}

export function prefetch(id) {
  return audioFile(id).then(() => {}, () => {});
}

function pruneCache() {
  return pruneDir(CACHE_DIR, config.cacheLimitMb * 1024 * 1024, (name) => pending.has(name.replace(/\.\w+$/, '')));
}

// --- In die Jellyfin-Bibliothek --------------------------------------------

const safe = (s) =>
  String(s || 'Unbekannt')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120) || 'Unbekannt';

export const isInLibrary = (id) => Boolean(library[String(id)]);

/**
 * Legt den Song mit sauberen Tags und Cover im Musikordner ab:
 * <Künstler>/<Titel>/<Titel>.mp3 – Jellyfin zeigt ihn dann als Single.
 */
export async function saveToLibrary(id) {
  const t = await track(id);
  const src = await audioFile(id);
  if (src === library[id]) return src;

  const dir = path.join(config.musicDir, safe(t.artist), safe(t.title));
  const dest = path.join(dir, `${safe(t.title)}.mp3`);
  await fs.mkdir(dir, { recursive: true });

  let cover = null;
  if (t.cover) {
    cover = path.join(CACHE_DIR, `${id}.jpg`);
    try {
      const res = await fetch(t.cover, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(String(res.status));
      await fs.writeFile(cover, Buffer.from(await res.arrayBuffer()));
    } catch {
      cover = null;
    }
  }

  const tags = { title: t.title, artist: t.artist, album_artist: t.artist, album: t.title, comment: t.permalink };
  const build = (withCover) => {
    const args = ['-y', '-loglevel', 'error', '-i', src];
    if (withCover) {
      args.push('-i', cover, '-map', '0:a', '-map', '1:v', '-disposition:v', 'attached_pic');
      args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
    } else {
      args.push('-map', '0:a');
    }
    args.push('-c', 'copy', '-id3v2_version', '3');
    for (const [k, v] of Object.entries(tags)) if (v) args.push('-metadata', `${k}=${v}`);
    args.push(dest);
    return args;
  };

  try {
    await ffmpeg(build(Boolean(cover)));
  } catch (err) {
    if (!cover) throw err;
    // Cover kaputt oder unbekanntes Format → ohne Cover ablegen statt gar nicht
    log('soundcloud', `Cover nicht übernommen (${err.message})`);
    await ffmpeg(build(false));
  }
  if (cover) fs.unlink(cover).catch(() => {});
  library[id] = dest;
  await writeJson(LIB_FILE, library);
  log('soundcloud', `${t.artist} – ${t.title} → ${dest}`);
  return dest;
}

export { ffmpegVersion } from './media.js';
