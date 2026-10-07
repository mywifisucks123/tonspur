// yt-dlp als Quelle für die Sofort-Wiedergabe kompletter Songs.
import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.js';
import { log, norm } from './util.js';

// yt-dlp braucht für YouTube eine JavaScript-Runtime. Standard ist Deno; fehlt Deno,
// nehmen wir einfach das Node, mit dem dieser Server läuft.
// Die Option gibt es erst ab yt-dlp 2025.11; ältere Versionen bekommen sie nicht.
let runtimeArgs = [];
function pickRuntime(ver) {
  if (config.yt.extraArgs.includes('--js-runtimes') || ver < '2025.11') return [];
  const deno = spawnSync('deno', ['--version'], { stdio: 'ignore' });
  return deno.status === 0 ? [] : ['--js-runtimes', `node:${process.execPath}`];
}

function run(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.yt.bin, [...runtimeArgs, ...config.yt.extraArgs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').pop() || `yt-dlp exit ${code}`));
    });
  });
}

let available;
export function version() {
  if (!config.yt.enabled) return Promise.resolve(null);
  available ??= run(['--version'], 5000).then(
    (out) => {
      const ver = out.trim();
      runtimeArgs = pickRuntime(ver);
      return ver;
    },
    () => {
      log('yt-dlp', `nicht gefunden (${config.yt.bin}) – Sofort-Wiedergabe nur als 30-s-Vorschau`);
      return null;
    },
  );
  return available;
}

const UNWANTED = ['live', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'slowed', 'reverb', 'nightcore', '8d', 'lyrics', 'reaction', 'acoustic'];

function score(track, entry) {
  const want = norm(`${track.title} ${track.album}`);
  const title = norm(entry.title);
  let s = 0;
  if (title.includes(norm(track.title))) s += 30;
  const who = norm(`${entry.channel ?? ''} ${entry.uploader ?? ''} ${entry.title}`);
  if (who.includes(norm(track.artist))) s += 20;
  if (track.duration && entry.duration) {
    const diff = Math.abs(track.duration - entry.duration);
    s += diff <= 2 ? 40 : diff <= 6 ? 25 : diff <= 15 ? 5 : -40;
  }
  for (const word of UNWANTED) {
    if (title.includes(word) && !want.includes(word)) s -= 25;
  }
  if (/topic$/i.test(entry.channel ?? entry.uploader ?? '')) s += 10;
  return s;
}

async function candidates(query) {
  const sources =
    config.yt.search === 'music'
      ? [`https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`, `ytsearch5:${query}`]
      : [`ytsearch5:${query}`];
  for (const src of sources) {
    try {
      const out = await run(['--flat-playlist', '--playlist-end', '6', '--no-warnings', '-j', src]);
      const list = out
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((e) => e.id && e.id.length === 11);
      if (list.length) return list;
    } catch (err) {
      log('yt-dlp', `Suche fehlgeschlagen (${src.slice(0, 40)}…): ${err.message}`);
    }
  }
  return [];
}

const FORMAT = 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio';
const GOOD_ENOUGH = 60;

function toStream(info) {
  if (!info?.url) throw new Error('keine Audio-URL');
  const expire = Number(new URL(info.url).searchParams.get('expire')) * 1000;
  const mime = info.ext === 'm4a' || info.ext === 'mp4' ? 'audio/mp4' : info.ext === 'webm' ? 'audio/webm' : null;
  return {
    url: info.url,
    headers: info.http_headers ?? {},
    mime,
    videoId: info.id,
    expires: expire || Date.now() + 3 * 60 * 60 * 1000,
  };
}

/** Audio-URL für ein bekanntes Video – ein yt-dlp-Aufruf. */
export async function extract(videoId) {
  const out = await run(['-f', FORMAT, '--no-playlist', '--no-warnings', '-j', `https://www.youtube.com/watch?v=${videoId}`]);
  return toStream(JSON.parse(out));
}

/**
 * Sucht das passende Video und liefert die direkte Audio-URL.
 * Schneller Weg: ersten Song-Treffer von YouTube Music in EINEM Aufruf suchen und auflösen.
 * Passt der nicht (Dauer/Titel), wird breiter gesucht und der beste Treffer aufgelöst.
 */
export async function resolve(track) {
  const query = `${track.artist} - ${track.title}`;

  if (config.yt.search === 'music') {
    try {
      const out = await run([
        '-f', FORMAT, '--no-warnings', '-j', '--playlist-items', '1',
        `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`,
      ]);
      const info = JSON.parse(out.split('\n').find(Boolean));
      if (score(track, info) >= GOOD_ENOUGH) return toStream(info);
    } catch (err) {
      log('yt-dlp', `Schnellsuche fehlgeschlagen: ${err.message}`);
    }
  }

  const list = await candidates(query);
  if (!list.length) throw new Error('kein YouTube-Treffer');
  const best = list.map((e) => ({ e, s: score(track, e) })).sort((a, b) => b.s - a.s)[0].e;
  return extract(best.id);
}

/**
 * Lädt das Audio einer Seite (SoundCloud o. ä.) als MP3 nach `${outBase}.mp3`.
 * Braucht ffmpeg für die Umwandlung; MP3-Quellen werden nur umverpackt.
 */
export async function downloadAudio(url, outBase) {
  await run(
    [
      '-f', 'ba[acodec=mp3]/ba[acodec^=mp4a]/ba',
      '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
      ...(config.ffmpegBin.includes('/') ? ['--ffmpeg-location', config.ffmpegBin] : []),
      '--no-playlist', '--no-warnings', '--no-progress', '--no-part',
      '-o', `${outBase}.%(ext)s`,
      url,
    ],
    180000,
  );
}
