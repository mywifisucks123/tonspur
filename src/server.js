import express from 'express';
import path from 'node:path';
import { config } from './config.js';
import * as deemix from './deemix.js';
import * as deezer from './deezer.js';
import * as downloads from './downloads.js';
import * as favorites from './favorites.js';
import * as imports from './imports.js';
import * as jellyfin from './jellyfin.js';
import { proxy, proxyChunked } from './proxy.js';
import * as resolver from './resolver.js';
import * as soundcloud from './soundcloud.js';
import * as spotify from './spotify.js';
import { HttpError, log } from './util.js';
import * as yt from './ytdlp.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

const api = express.Router();

// --- Suche & Metadaten -------------------------------------------------------

api.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [], local: [], soundcloud: null });

  const [remote, local, sc] = await Promise.all([
    deezer.search(q),
    jellyfin.isConfigured() ? jellyfin.searchTracks(q, 25).catch(() => []) : [],
    soundcloud.search(q).catch((err) => {
      log('soundcloud', `Suche: ${err.message}`);
      return { tracks: [], playlists: [], error: err.message };
    }),
  ]);
  // Deezer-Treffer markieren, die schon auf dem Mac Mini liegen
  for (const t of remote.tracks) {
    t.local = local.some((l) => jellyfin.matches(t, l));
  }
  res.json({ ...remote, local: local.slice(0, 8), soundcloud: sc });
});

api.get('/charts', async (_req, res) => res.json(await deezer.chart()));
api.get('/album/:id', async (req, res) => res.json(await deezer.album(req.params.id)));
api.get('/artist/:id', async (req, res) => res.json(await deezer.artist(req.params.id)));
api.get('/playlist/:id', async (req, res) => res.json(await deezer.playlist(req.params.id)));
api.get('/sc/playlist/:id', async (req, res) => res.json(await soundcloud.playlist(req.params.id)));

// --- Links importieren (Spotify-Playlist/-Album, SoundCloud-Song/-Playlist) ----

api.post('/import', async (req, res) => {
  const url = String(req.body?.url ?? '').trim();
  if (spotify.parseLink(url)) {
    const p = await imports.save(await spotify.importLink(url));
    return res.json({ kind: 'import', id: p.id, title: p.title, found: p.tracks.length, missing: p.missing.length });
  }
  if (/soundcloud\.com\//.test(url)) return res.json(await soundcloud.resolveUrl(url));
  throw new HttpError(400, 'Bitte einen Spotify- oder SoundCloud-Link einfügen');
});

api.get('/imports', (_req, res) => res.json(imports.list()));
api.get('/imports/:id', (req, res) => res.json(imports.get(req.params.id)));
api.delete('/imports/:id', async (req, res) => {
  await imports.remove(req.params.id);
  res.json(imports.list());
});

// --- Streaming ---------------------------------------------------------------

api.get('/stream/dz/:id', async (req, res) => {
  const id = req.params.id;
  for (let attempt = 0; attempt < 2; attempt++) {
    const src = await resolver.resolve(id);
    if (src.type === 'jellyfin') {
      return void (await proxy(req, res, jellyfin.streamUrl(src.jellyfinId), {
        headers: jellyfin.authHeaders(),
      }));
    }
    if (src.type === 'youtube') {
      const status = await proxyChunked(req, res, src.url, {
        headers: src.headers,
        contentType: src.mime,
        retryOn: attempt === 0 ? [403, 410] : [],
      });
      if (status === 403 || status === 410) {
        resolver.invalidateYoutube(id);
        continue;
      }
      return;
    }
    if (src.type === 'preview') return res.redirect(302, src.url);
    throw new HttpError(404, 'Keine Audioquelle gefunden');
  }
  throw new HttpError(502, 'Stream nicht verfügbar');
});

api.get('/stream/sc/:id', async (req, res) => {
  const file = await soundcloud.audioFile(req.params.id, { urgent: true });
  res.sendFile(file, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-store' } });
});

api.get('/stream/jf/:id', async (req, res) => {
  await proxy(req, res, jellyfin.streamUrl(req.params.id), { headers: jellyfin.authHeaders() });
});

api.get('/source/dz/:id', async (req, res) => {
  const src = await resolver.resolve(req.params.id, { wait: req.query.wait !== '0' });
  res.json({ type: src.type });
});

// Vorladen: Deezer-Titel bekommen ihre YouTube-Adresse (billig), SoundCloud-Titel werden
// komplett geladen (teurer, deshalb weniger). Alles im Hintergrund mit niedriger Priorität.
api.post('/prefetch', (req, res) => {
  const keys = [...new Set((req.body?.keys ?? (req.body?.ids ?? []).map((id) => `dz:${id}`)).map(String))];
  const dz = keys.filter((k) => k.startsWith('dz:')).slice(0, 40);
  const sc = keys.filter((k) => k.startsWith('sc:')).slice(0, 4);
  for (const k of dz) resolver.prefetch(k.slice(3)).catch(() => {});
  for (const k of sc) soundcloud.prefetch(k.slice(3));
  res.status(202).json({ ok: true, count: dz.length + sc.length });
});

// --- Jellyfin-Bibliothek -----------------------------------------------------

api.get('/library/albums', async (_req, res) => res.json(await jellyfin.recentAlbums(60)));
api.get('/jf/album/:id', async (req, res) => res.json(await jellyfin.album(req.params.id)));

api.get('/jf/image/:id', async (req, res) => {
  const size = Math.min(Math.max(Number(req.query.size) || 600, 64), 1200);
  await proxy(req, res, jellyfin.imageUrl(req.params.id, size), {
    headers: jellyfin.authHeaders(),
    cache: 'public, max-age=86400',
  });
});

// --- Downloads & Favoriten ---------------------------------------------------

api.post('/download', async (req, res) => {
  const { type = 'track', id, reason = 'manual', force = false } = req.body ?? {};
  if (!id) throw new HttpError(400, 'id fehlt');
  if (reason === 'play' && !config.autoDownloadOnPlay) return res.status(204).end();
  if (type === 'playlist') {
    // Playlist = jeder Titel einzeln, damit Künstler-/Album-Ordner sauber bleiben
    const source = req.body?.source ?? 'dz';
    const p =
      source === 'sc' ? await soundcloud.playlist(String(id)) : source === 'sp' ? imports.get(String(id)) : await deezer.playlist(String(id));
    downloads.enqueueMany(p.tracks.map((t) => t.id), `Playlist ${p.title}`, source === 'sc' ? 'sc' : 'track');
    return res.status(202).json({ ok: true, count: p.tracks.length });
  }
  const job = await downloads.enqueue({ type, id: String(id), reason, force: Boolean(force) });
  res.status(202).json(job);
});

api.get('/downloads', (_req, res) => res.json(downloads.list()));
api.delete('/downloads', (_req, res) => {
  downloads.clearFinished();
  res.json(downloads.list());
});

api.get('/favorites', (_req, res) => res.json(favorites.all()));

api.post('/favorites', async (req, res) => {
  const { type, item } = req.body ?? {};
  if (!item?.id || !item?.source) throw new HttpError(400, 'item fehlt');
  const data = await favorites.add(type, item);
  if (item.source === 'dz' && (type === 'track' || type === 'album')) {
    downloads.enqueue({ type, id: item.id, reason: 'favorite' }).catch((err) => log('favorites', err.message));
  }
  if (item.source === 'sc' && type === 'track') {
    downloads.enqueue({ type: 'sc', id: item.id, reason: 'favorite' }).catch((err) => log('favorites', err.message));
  }
  res.json(data);
});

api.delete('/favorites/:type/:source/:id', async (req, res) => {
  const { type, source, id } = req.params;
  res.json(await favorites.remove(type, source, id));
});

// --- Status ------------------------------------------------------------------

api.get('/health', async (_req, res) => {
  const settle = (p) =>
    p.then(
      (v) => v,
      (err) => ({ ok: false, error: err.message }),
    );
  const [jf, dm, ytv, ff, sc] = await Promise.all([
    jellyfin.isConfigured() ? settle(jellyfin.ping()) : { ok: false, error: 'JELLYFIN_API_KEY fehlt' },
    settle(deemix.ping()),
    yt.version(),
    soundcloud.ffmpegVersion(),
    settle(soundcloud.ping()),
  ]);
  res.json({
    jellyfin: jf,
    deemix: dm,
    ytdlp: ytv
      ? { ok: true, version: ytv, lastError: resolver.lastYoutubeError() }
      : { ok: false, error: config.yt.enabled ? 'nicht installiert' : 'deaktiviert' },
    ffmpeg: ff ? { ok: true, version: ff } : { ok: false, error: 'nicht installiert (brew install ffmpeg)' },
    soundcloud: sc,
    spotify: { ok: true, mode: config.spotify.clientId ? 'Web-API' : 'Einbettung (max. ~100 Titel)' },
    autoDownloadOnPlay: config.autoDownloadOnPlay,
  });
});

api.use((_req, _res) => {
  throw new HttpError(404, 'Unbekannter Endpunkt');
});

api.use((err, req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) log('api', `${req.method} ${req.originalUrl}: ${err.message}`);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: err.message });
});

app.use('/api', api);

// --- Frontend ----------------------------------------------------------------

app.use(
  express.static(config.publicDir, {
    setHeaders(res, file) {
      const name = path.basename(file);
      if (name === 'sw.js' || name.endsWith('.html') || name.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
      if (name.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json');
    },
  }),
);

// SPA-Fallback (Hash-Routing braucht ihn kaum, schadet aber nicht)
app.use((req, res, next) => {
  if (req.method !== 'GET' || !req.accepts('html')) return next();
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

await Promise.all([favorites.init(), downloads.init(), resolver.init(), soundcloud.init(), imports.init()]);

app.listen(config.port, config.host, async () => {
  log('server', `läuft auf http://${config.host}:${config.port}`);
  const ytv = await yt.version();
  log('server', `Jellyfin ${config.jellyfin.url} ${jellyfin.isConfigured() ? '' : '(kein API-Key!)'}`);
  log('server', `Deemix ${config.deemix.url} ${config.deemix.arl ? '' : '(kein ARL in .env)'}`);
  log('server', `yt-dlp ${ytv ?? 'nicht verfügbar'}`);
  // Deemix-Login vorwärmen, damit der erste Download nicht wartet
  if (config.deemix.arl) deemix.login().catch((err) => log('deemix', err.message));
});

