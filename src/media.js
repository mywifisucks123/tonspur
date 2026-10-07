// Gemeinsame Helfer für Audiodateien: ffmpeg, schneller Download, Zwischenspeicher aufräumen.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg ${code}`)),
    );
  });
}

let version;
export function ffmpegVersion() {
  version ??= new Promise((resolve) => {
    const child = spawn(config.ffmpegBin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? (out.split('\n')[0].split(' ')[2] ?? 'ok') : null));
  }).then((v) => {
    if (!v) version = undefined; // nach Installation ohne Neustart erneut prüfen
    return v;
  });
  return version;
}

export const exists = (p) => fs.access(p).then(() => true, () => false);

// Wie im Stream-Proxy: feste Stücke statt offener Anfrage, sonst drosselt YouTube
const CHUNK = 10 * 1024 * 1024;

/** Lädt eine Datei in festen Stücken herunter. Wirft bei 403/410 einen Fehler mit .status. */
export async function downloadChunked(url, headers, dest) {
  const fh = await fs.open(dest, 'w');
  try {
    let pos = 0;
    let total = Infinity;
    while (pos < total) {
      const res = await fetch(url, {
        headers: { ...headers, Range: `bytes=${pos}-${pos + CHUNK - 1}` },
        signal: AbortSignal.timeout(60000),
      });
      if (res.status !== 206 && res.status !== 200) {
        await res.body?.cancel();
        throw Object.assign(new Error(`Download HTTP ${res.status}`), { status: res.status });
      }
      total =
        res.status === 206
          ? Number(res.headers.get('content-range')?.split('/')[1])
          : Number(res.headers.get('content-length')) || Infinity;
      for await (const chunk of res.body) {
        await fh.write(chunk);
        pos += chunk.length;
      }
      if (res.status === 200 || !Number.isFinite(total)) break;
    }
  } finally {
    await fh.close();
  }
}

/** Älteste Dateien löschen, bis der Ordner unter dem Limit liegt. */
export async function pruneDir(dir, limitBytes, isBusy = () => false) {
  const files = [];
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) files.push({ name, size: st.size, at: st.mtimeMs });
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= limitBytes) break;
    if (isBusy(f.name)) continue;
    await fs.unlink(path.join(dir, f.name)).catch(() => {});
    total -= f.size;
  }
}

/** Datei als "zuletzt benutzt" markieren, damit sie beim Aufräumen bleibt. */
export function touch(file) {
  const now = new Date();
  fs.utimes(file, now, now).catch(() => {});
}
