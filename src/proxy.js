// Range-fähiger Stream-Proxy. Safari auf iOS spielt Audio nur mit Range-Requests (206) sauber ab.
import { Readable } from 'node:stream';

const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/**
 * @returns {Promise<number>} HTTP-Status der Quelle (z. B. 403 → URL abgelaufen)
 */
export async function proxy(req, res, url, { headers = {}, contentType, cache = 'no-store', retryOn } = {}) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  const h = { ...headers };
  if (req.headers.range) h.Range = req.headers.range;
  if (req.headers['if-range']) h['If-Range'] = req.headers['if-range'];

  const upstream = await fetch(url, {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: h,
    signal: ac.signal,
    redirect: 'follow',
  });

  if (retryOn?.includes(upstream.status)) {
    await upstream.body?.cancel();
    return upstream.status;
  }

  res.status(upstream.status);
  for (const k of PASS) {
    const v = upstream.headers.get(k);
    if (v) res.setHeader(k, v);
  }
  const type = upstream.headers.get('content-type') ?? '';
  if (contentType && (!type || /octet-stream|video\//.test(type))) res.setHeader('content-type', contentType);
  res.setHeader('cache-control', cache);

  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return upstream.status;
  }
  Readable.fromWeb(upstream.body)
    .on('error', () => res.destroy())
    .pipe(res);
  return upstream.status;
}

// YouTube drosselt Downloads ohne festes Ende ("bytes=0-" oder ganz ohne Range) auf etwa
// doppelte Abspielgeschwindigkeit. In festen Stücken abgefragt kommt die Datei mit voller
// Bandbreite – so macht es yt-dlp auch. Der Client bekommt trotzdem genau den Bereich, den er wollte.
const CHUNK = 10 * 1024 * 1024;

function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === '' ? null : Number(m[2]) };
}

/**
 * @returns {Promise<number>} HTTP-Status der Quelle beim ersten Stück (403/410 → URL abgelaufen)
 */
export async function proxyChunked(req, res, url, { headers = {}, contentType, retryOn = [] } = {}) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const range = parseRange(req.headers.range);
  const get = (from, to) =>
    fetch(url, { headers: { ...headers, Range: `bytes=${from}-${to}` }, signal: ac.signal, redirect: 'follow' });

  // Suffix-Anfragen ("die letzten N Bytes") brauchen die Gesamtgröße vorab
  let start = range?.start ?? 0;
  let wantEnd = range?.end ?? null;
  if (range?.suffix !== undefined) {
    const probe = await get(0, 0);
    await probe.body?.cancel();
    if (retryOn.includes(probe.status)) return probe.status;
    const total = Number(probe.headers.get('content-range')?.split('/')[1]);
    start = Math.max(0, total - range.suffix);
    wantEnd = total - 1;
  }

  const firstEnd = wantEnd !== null ? Math.min(wantEnd, start + CHUNK - 1) : start + CHUNK - 1;
  const first = await get(start, firstEnd);
  if (retryOn.includes(first.status)) {
    await first.body?.cancel();
    return first.status;
  }
  if (first.status !== 206) {
    // Quelle kann keine Ranges → unverändert durchreichen
    res.status(first.status);
    for (const k of PASS) {
      const v = first.headers.get(k);
      if (v) res.setHeader(k, v);
    }
    if (req.method === 'HEAD' || !first.body) {
      res.end();
      return first.status;
    }
    Readable.fromWeb(first.body).on('error', () => res.destroy()).pipe(res);
    return first.status;
  }

  const total = Number(first.headers.get('content-range')?.split('/')[1]);
  const end = Math.min(wantEnd ?? total - 1, total - 1);
  if (!Number.isFinite(total) || start >= total) {
    await first.body?.cancel();
    res.status(416).setHeader('Content-Range', `bytes */${total}`);
    res.end();
    return 416;
  }

  res.status(range ? 206 : 200);
  res.setHeader('Content-Type', contentType || first.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('Content-Length', String(end - start + 1));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  if (req.method === 'HEAD') {
    await first.body?.cancel();
    res.end();
    return first.status;
  }

  try {
    let upstream = first;
    let pos = start;
    for (;;) {
      for await (const chunk of upstream.body) {
        pos += chunk.length;
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
      if (pos > end || res.destroyed) break;
      upstream = await get(pos, Math.min(end, pos + CHUNK - 1));
      if (upstream.status !== 206) throw new Error(`Stück ab ${pos}: HTTP ${upstream.status}`);
    }
    res.end();
  } catch {
    res.destroy();
  }
  return first.status;
}
