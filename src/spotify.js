// Spotify-Playlists und -Alben übernehmen: Titelliste von Spotify holen, jeden Titel
// bei Deezer suchen. Abgespielt und geladen wird dann ganz normal über Deezer/YouTube.
//
// Ohne Zugangsdaten liest Tonspur die öffentliche Einbettungsseite (open.spotify.com/embed),
// die funktioniert auch für Spotifys eigene Playlists, liefert aber höchstens ~100 Titel.
// Mit SPOTIFY_CLIENT_ID/SECRET kommt die komplette Liste inkl. ISRC über die Web-API.
import { config } from './config.js';
import * as deezer from './deezer.js';
import { HttpError, log, norm } from './util.js';

// *_URL nur zum Testen gegen einen Mock
const OPEN = (process.env.SPOTIFY_OPEN_URL || 'https://open.spotify.com').replace(/\/+$/, '');
const API = (process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1').replace(/\/+$/, '');
const ACCOUNTS = (process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

/** open.spotify.com/(intl-de/)playlist/ID?si=… oder spotify:playlist:ID */
export function parseLink(input) {
  const m =
    /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{10,})/.exec(input) ||
    /spotify:(playlist|album):([A-Za-z0-9]{10,})/.exec(input);
  return m ? { type: m[1], id: m[2] } : null;
}

// --- Web-API (optional) ----------------------------------------------------

let token = null;
async function apiToken() {
  if (token && token.expires > Date.now() + 60000) return token.value;
  const { clientId, clientSecret } = config.spotify;
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new HttpError(502, `Spotify-Login fehlgeschlagen (${res.status}) – Client-ID/Secret prüfen`);
  const j = await res.json();
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

async function api(path) {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    headers: { Authorization: `Bearer ${await apiToken()}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Spotify ${res.status}`);
  return res.json();
}

async function fromApi({ type, id }) {
  const meta = await api(`/${type}s/${id}`);
  const items = [];
  if (type === 'playlist') {
    let next = `/playlists/${id}/tracks?limit=100&fields=items(track(name,artists(name),duration_ms,external_ids(isrc))),next`;
    while (next && items.length < 1000) {
      const page = await api(next);
      for (const it of page.items ?? []) {
        if (it.track?.name) items.push(it.track);
      }
      next = page.next;
    }
  } else {
    items.push(...(meta.tracks?.items ?? []));
  }
  return {
    title: meta.name,
    owner: meta.owner?.display_name ?? meta.artists?.map((a) => a.name).join(', ') ?? '',
    cover: meta.images?.[0]?.url ?? null,
    tracks: items.map((t) => ({
      title: t.name,
      artist: t.artists?.[0]?.name ?? '',
      artists: t.artists?.map((a) => a.name) ?? [],
      duration: Math.round((t.duration_ms ?? 0) / 1000),
      isrc: t.external_ids?.isrc ?? null,
    })),
  };
}

// --- Einbettungsseite (ohne Zugangsdaten) ----------------------------------

function findEntity(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (Array.isArray(node.trackList) && (node.name || node.title)) return node;
  for (const v of Object.values(node)) {
    const hit = findEntity(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function fromEmbed({ type, id }) {
  const res = await fetch(`${OPEN}/embed/${type}/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404) throw new HttpError(404, 'Spotify-Playlist nicht gefunden (privat?)');
  if (!res.ok) throw new HttpError(502, `Spotify ${res.status}`);
  const html = await res.text();
  const m = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new HttpError(502, 'Spotify hat die Einbettungsseite geändert – bitte SPOTIFY_CLIENT_ID/SECRET eintragen');
  const entity = findEntity(JSON.parse(m[1]));
  if (!entity) throw new HttpError(502, 'Spotify-Titelliste nicht gefunden');
  const sources = entity.coverArt?.sources ?? entity.images ?? [];
  const biggest = [...sources].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return {
    title: entity.name ?? entity.title,
    owner: entity.subtitle ?? entity.authors?.map((a) => a.name).join(', ') ?? '',
    cover: biggest?.url ?? null,
    tracks: entity.trackList
      .filter((t) => t.title && t.isPlayable !== false)
      .map((t) => {
        const artists = String(t.subtitle ?? '').split(/,\s*/).filter(Boolean);
        return {
          title: t.title,
          artist: artists[0] ?? '',
          artists,
          duration: Math.round((t.duration ?? 0) / 1000),
          isrc: null,
        };
      }),
  };
}

// --- Abgleich mit Deezer ---------------------------------------------------

function pick(sp, candidates) {
  const title = norm(sp.title.replace(/\s+-\s+.*$/, ''));
  const artist = norm(sp.artist);
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const ct = norm(c.title);
    let s = 0;
    if (ct === title) s += 50;
    else if (ct.startsWith(title) || title.startsWith(ct)) s += 25;
    else continue;
    if (norm(c.artist).includes(artist) || artist.includes(norm(c.artist))) s += 30;
    if (sp.duration && c.duration) {
      const diff = Math.abs(sp.duration - c.duration);
      s += diff <= 3 ? 25 : diff <= 10 ? 10 : -30;
    }
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return bestScore >= 55 ? best : null;
}

async function match(sp) {
  if (sp.isrc) {
    const hit = await deezer.byIsrc(sp.isrc).catch(() => null);
    if (hit) return hit;
  }
  const strict = await deezer.searchTracks(`artist:"${sp.artist}" track:"${sp.title.replace(/"/g, '')}"`, 8).catch(() => []);
  const hit = pick(sp, strict);
  if (hit) return hit;
  const loose = await deezer.searchTracks(`${sp.artist} ${sp.title.replace(/\s+-\s+.*$/, '')}`, 10).catch(() => []);
  return pick(sp, loose);
}

/** Spotify-Link → Playlist mit Deezer-Titeln (nicht gefundene separat). */
export async function importLink(link) {
  const ref = parseLink(link);
  if (!ref) throw new HttpError(400, 'Das ist kein Spotify-Playlist- oder Album-Link');

  let data;
  const hasApi = config.spotify.clientId && config.spotify.clientSecret;
  if (hasApi) {
    try {
      data = await fromApi(ref);
    } catch (err) {
      // Spotifys eigene Playlists sperrt die API für Fremd-Apps → Einbettungsseite
      log('spotify', `API: ${err.message} → Einbettungsseite`);
    }
  }
  data ??= await fromEmbed(ref);

  const started = Date.now();
  const matched = [];
  const missing = [];
  const results = [];
  // Parallel, aber gebremst – Deezer erlaubt ~50 Anfragen / 5 s (Bremse sitzt in deezer.js)
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < data.tracks.length) {
        const i = next++;
        results[i] = await match(data.tracks[i]).catch(() => null);
      }
    }),
  );
  data.tracks.forEach((sp, i) => (results[i] ? matched.push(results[i]) : missing.push(`${sp.artist} – ${sp.title}`)));
  log('spotify', `${data.title}: ${matched.length}/${data.tracks.length} bei Deezer gefunden (${((Date.now() - started) / 1000).toFixed(1)} s)`);

  return {
    id: `sp-${ref.type}-${ref.id}`,
    source: 'sp',
    kind: ref.type,
    link: `https://open.spotify.com/${ref.type}/${ref.id}`,
    title: data.title,
    owner: data.owner,
    cover: data.cover,
    coverSmall: data.cover,
    trackCount: matched.length,
    tracks: matched,
    missing,
    complete: hasApi || data.tracks.length < 100,
    importedAt: Date.now(),
  };
}
