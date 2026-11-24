// Entscheidet pro Deezer-Track, woher der Ton kommt:
//   1. Jellyfin (schon in der Bibliothek, volle Qualität)
//   2. YouTube via yt-dlp (kompletter Song, sofort)
//   3. Deezer-Vorschau (30 Sekunden, Notnagel)
import { config } from './config.js';
import * as deezer from './deezer.js';
import * as jellyfin from './jellyfin.js';
import * as yt from './ytdlp.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadChunked, exists, ffmpeg, ffmpegVersion, pruneDir, safeName, tagCopy, touch } from './media.js';
import { Limiter, TtlCache, log, readJson, withTimeout, writeJson } from './util.js';

const ytCache = new TtlCache(3 * 60 * 60 * 1000, 2000);
const ytFailed = new TtlCache(5 * 60 * 1000, 2000);
const limiter = new Limiter(config.yt.concurrency);
let lastError = null;
export const lastYoutubeError = () => lastError;

// Deezer-ID → YouTube-Video-ID, dauerhaft. Beim zweiten Abspielen entfällt die Suche.
const ID_FILE = path.join(config.dataDir, 'yt-ids.json');
let videoIds = {};
let saveTimer;
export async function init() {
  videoIds = await readJson(ID_FILE, {});
  ytLibrary = await readJson(YT_LIB_FILE, {});
}
function rememberVideo(id, videoId) {
  if (videoIds[id] === videoId) return;
  videoIds[id] = videoId;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(ID_FILE, videoIds).catch(() => {}), 1000);
}

async function lookup(track) {
  const known = videoIds[track.id];
  if (known) {
    try {
      return await yt.extract(known);
    } catch (err) {
      log('yt-dlp', `${known} nicht mehr abrufbar (${err.message}), suche neu`);
      delete videoIds[track.id];
    }
  }
  const r = await yt.resolve(track);
  rememberVideo(track.id, r.videoId);
  return r;
}

async function local(track) {
  try {
    return await jellyfin.findLocal(track);
  } catch (err) {
    log('resolver', `Jellyfin-Abgleich fehlgeschlagen: ${err.message}`);
    return null;
  }
}

function youtube(track, { urgent = false } = {}) {
  const hit = ytCache.get(track.id);
  if (hit && hit.expires - Date.now() > 10 * 60 * 1000) return Promise.resolve(hit);
  if (ytFailed.get(track.id)) return Promise.reject(new Error('kürzlich fehlgeschlagen'));
  if (ytCache.pending.has(track.id)) {
    if (urgent) limiter.promote(track.id);
    return ytCache.pending.get(track.id);
  }

  ytCache.delete(track.id);
  return ytCache.wrap(track.id, () =>
    limiter
      .run(() => lookup(track), { urgent, key: track.id })
      .then(
        (r) => {
          log('yt-dlp', `${track.artist} – ${track.title} → ${r.videoId}`);
          return r;
        },
        (err) => {
          ytFailed.set(track.id, true);
          lastError = { message: err.message.slice(0, 300), track: `${track.artist} – ${track.title}`, at: Date.now() };
          log('yt-dlp', `${track.artist} – ${track.title}: ${err.message}`);
          throw err;
        },
      ),
  );
}

/** Für Prefetch: holt die YouTube-Adresse, mit `file` auch gleich die fertige Datei. */
export async function prefetch(id, { file = false } = {}) {
  const track = await deezer.track(id);
  if (await local(track)) return;
  if (!(await yt.version())) return;
  const src = await youtube(track).catch(() => null);
  if (src && file) await youtubeFile(id, src, track).catch(() => {});
}

// --- YouTube-Audio als normale Datei ---------------------------------------
// YouTube liefert fragmentiertes MP4 (fürs Video-Streaming gebaut). Das spielt iOS nicht im
// Hintergrund weiter. Deshalb: komplett laden (dank fester Stücke ~1 s) und mit ffmpeg
// verlustfrei in eine normale M4A umpacken – wie Apple Music sie auch nutzt.

const YT_DIR = path.join(config.cacheDir, 'yt');
const filePending = new Map();

export async function youtubeFile(id, src, track = src?.track) {
  const file = path.join(YT_DIR, `${id}.m4a`);
  if (await exists(file)) {
    touch(file);
    return file;
  }
  if (!(await ffmpegVersion())) return null;
  if (!filePending.has(id)) {
    const job = (async () => {
      await fs.mkdir(YT_DIR, { recursive: true });
      const tmp = path.join(YT_DIR, `${id}.download`);
      const out = path.join(YT_DIR, `${id}.part.m4a`);
      const started = Date.now();
      try {
        try {
          await downloadChunked(src.url, src.headers, tmp);
        } catch (err) {
          log('yt-dlp', `Download ${id}: ${err.message} – versuche es anders`);
          let done = false;
          // Adresse abgelaufen oder gesperrt → einmal frisch auflösen
          if ((err.status === 403 || err.status === 410) && track) {
            invalidateYoutube(id);
            const fresh = await youtube(track, { urgent: true }).catch(() => null);
            if (fresh) done = await downloadChunked(fresh.url, fresh.headers, tmp).then(() => true, () => false);
          }
          // Letzter Weg: yt-dlp lädt die Datei selbst (kommt mit allen YouTube-Eigenheiten klar)
          if (!done) await yt.downloadVideoAudio(src.videoId, tmp);
        }
        await ffmpeg(['-y', '-loglevel', 'error', '-i', tmp, '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', out]);
        await fs.rename(out, file);
        log('yt-dlp', `Datei ${id} bereit (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        pruneDir(YT_DIR, config.cacheLimitMb * 1024 * 1024, (name) => filePending.has(name.split('.')[0])).catch(() => {});
        return file;
      } finally {
        fs.unlink(tmp).catch(() => {});
        fs.unlink(out).catch(() => {});
      }
    })().finally(() => filePending.delete(id));
    filePending.set(id, job);
  }
  return filePending.get(id);
}

export async function resolve(id, { wait = true } = {}) {
  const track = await deezer.track(id);

  const hit = await local(track);
  if (hit) return { type: 'jellyfin', jellyfinId: hit.id, track };

  if (await yt.version()) {
    const pending = youtube(track, { urgent: true });
    // Fehler werden unten behandelt; ohne diesen Handler würde Node bei wait=false abstürzen
    pending.catch(() => {});
    try {
      const r = wait ? await withTimeout(pending, config.yt.resolveTimeoutMs) : ytCache.get(id);
      if (r) return { type: 'youtube', ...r, track };
    } catch {
      // Timeout oder Fehler → Vorschau. yt-dlp läuft weiter und ist beim nächsten Mal fertig.
    }
  }

  if (track.preview) return { type: 'preview', url: track.preview, track };
  return { type: 'none', track };
}

export function invalidateYoutube(id) {
  ytCache.delete(id);
}

// --- YouTube als Quelle für die Bibliothek --------------------------------
// Rückfall, wenn Deemix einen Titel nicht liefern kann, und für Spotify-Titel, die es bei
// Deezer nicht gibt. Ergebnis: normale M4A mit Tags und Cover im Musikordner.

const YT_LIB_FILE = path.join(config.dataDir, 'yt-library.json');
let ytLibrary = {};

export const isInYoutubeLibrary = (id) => Boolean(ytLibrary[id]);

/** @param track {id, title, artist, album?, duration?, cover?} – id ist Deezer-ID oder "sp-…" */
export async function saveYoutubeToLibrary(track) {
  if (ytLibrary[track.id] && (await exists(ytLibrary[track.id]))) return ytLibrary[track.id];
  if (!(await yt.version())) throw new Error('yt-dlp nicht verfügbar');
  if (!(await ffmpegVersion())) throw new Error('ffmpeg nicht installiert');
  const src = await youtube(track, { urgent: false });
  const file = await youtubeFile(track.id, src, track);
  const album = track.album || track.title;
  const dest = path.join(config.musicDir, safeName(track.artist), safeName(album), `${safeName(track.title)}.m4a`);
  const tags = { title: track.title, artist: track.artist, album_artist: track.artist, album, comment: 'YouTube' };
  await tagCopy(file, dest, tags, track.cover);
  ytLibrary[track.id] = dest;
  await writeJson(YT_LIB_FILE, ytLibrary);
  log('yt-dlp', `${track.artist} – ${track.title} → Bibliothek (YouTube)`);
  return dest;
}
