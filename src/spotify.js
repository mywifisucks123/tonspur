// Spotify-Playlists und -Alben übernehmen: Titelliste von Spotify holen, jeden Titel
// bei Deezer suchen. Abgespielt und geladen wird dann ganz normal über Deezer/YouTube.
//
// Ohne Zugangsdaten liest Tonspur die öffentliche Einbettungsseite (open.spotify.com/embed),
// die funktioniert auch für Spotifys eigene Playlists, liefert aber höchstens ~100 Titel.
//
// Mit eigener Spotify-App (SPOTIFY_CLIENT_ID/SECRET) und "Spotify verbinden" kommen außerdem
// die Lieblingssongs und die eigenen Playlists komplett. Seit Februar 2026 gilt für solche Apps:
// Der App-Besitzer braucht Premium (sonst antwortet die API nicht mehr), und Inhalte gibt es
// nur für eigene bzw. gemeinsame Playlists. Alles andere läuft weiter über die Einbettungsseite.
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import * as deezer from './deezer.js';
import * as notify from './notify.js';
import { HttpError, log, norm, readJson, writeJson } from './util.js';

// *_URL nur zum Testen gegen einen Mock
const OPEN = (process.env.SPOTIFY_OPEN_URL || 'https://open.spotify.com').replace(/\/+$/, '');
const API = (process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1').replace(/\/+$/, '');
const ACCOUNTS = (process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const AUTH_FILE = path.join(config.dataDir, 'spotify-auth.json');
const MATCH_FILE = path.join(config.dataDir, 'spotify-matches.json');
const SCOPES = 'user-library-read playlist-read-private playlist-read-collaborative';
const LIKED_MAX = 5000;

/** @type {null | {access: string, refresh: string, expires: number, user?: {id: string, name: string}, connectedAt: number, error?: string|null}} */
let auth = null;
let matchCache = {};

export async function init() {
  auth = await readJson(AUTH_FILE, null);
  matchCache = await readJson(MATCH_FILE, {});
}
const saveAuth = () => writeJson(AUTH_FILE, auth).catch((err) => log('spotify', err.message));

export const hasCredentials = () => Boolean(config.spotify.clientId && config.spotify.clientSecret);

/** open.spotify.com/(intl-de/)playlist/ID?si=… oder spotify:playlist:ID; Lieblingssongs: open.spotify.com/collection/tracks */
export function parseLink(input) {
  if (/open\.spotify\.com\/(?:intl-[a-z-]+\/)?collection\/tracks|spotify:(?:user:[^:]+:)?collection(?::tracks)?$/.test(String(input).trim())) {
    return { type: 'liked', id: 'me' };
  }
  const m =
    /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{10,})/.exec(input) ||
    /spotify:(playlist|album):([A-Za-z0-9]{10,})/.exec(input);
  return m ? { type: m[1], id: m[2] } : null;
}

export const canonicalLink = (ref) =>
  ref.type === 'liked' ? 'https://open.spotify.com/collection/tracks' : `https://open.spotify.com/${ref.type}/${ref.id}`;
export const importId = (ref) => `sp-${ref.type}-${ref.id}`;

// --- Web-API (optional) ----------------------------------------------------

async function tokenRequest(params) {
  const { clientId, clientSecret } = config.spotify;
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new HttpError(502, `Spotify-Login: ${j.error_description ?? j.error ?? res.status}`), { code: j.error });
  }
  return j;
}

// App-Token (ohne Benutzer) – reicht nur für Alben; Playlists liefert Spotify damit nicht mehr
let appToken = null;
async function clientToken() {
  if (appToken && appToken.expires > Date.now() + 60000) return appToken.value;
  const j = await tokenRequest({ grant_type: 'client_credentials' });
  appToken = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return appToken.value;
}

async function userToken() {
  if (!auth?.refresh) return null;
  if (auth.access && auth.expires > Date.now() + 60000) return auth.access;
  try {
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh });
    Object.assign(auth, { access: j.access_token, expires: Date.now() + j.expires_in * 1000 });
    if (j.refresh_token) auth.refresh = j.refresh_token;
  } catch (err) {
    if (err.code === 'invalid_grant') {
      // Zugriff in Spotify widerrufen → neu verbinden nötig
      auth = { ...auth, access: null, refresh: null, error: 'Verbindung von Spotify beendet – bitte neu verbinden' };
      notify.quiet('Spotify getrennt', 'Tonspur hat keinen Zugriff mehr auf dein Spotify-Konto. In Tonspur unter Bibliothek → Spotify neu verbinden.', { tags: ['warning'], dedupe: 'spotify-auth', dedupeHours: 24 });
    }
    throw err;
  } finally {
    await saveAuth();
  }
  return auth.access;
}

async function api(pathOrUrl, { user = true, attempt = 0 } = {}) {
  const token = (user && (await userToken())) || (await clientToken());
  const res = await fetch(pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429 && attempt < 3) {
    const wait = Math.min(30, Number(res.headers.get('retry-after')) || 5);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return api(pathOrUrl, { user, attempt: attempt + 1 });
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new HttpError(res.status === 404 ? 404 : 502, `Spotify ${res.status}${j.error?.message ? ` (${j.error.message})` : ''}`);
  }
  return res.json();
}

/** 403 auf eigene Daten = App gesperrt, meist weil das Premium des App-Besitzers abgelaufen ist. */
function apiBlocked(err) {
  const blocked = /Spotify 403/.test(err.message);
  if (blocked && auth) {
    auth.error = 'Spotify verweigert den Zugriff (Premium abgelaufen?). Playlists bleiben auf dem letzten Stand.';
    saveAuth();
    notify.quiet('Spotify-Zugriff gesperrt', 'Spotify antwortet der Tonspur-App nicht mehr – meist ist das Premium abgelaufen. Lieblingssongs und eigene Playlists bleiben auf dem letzten Stand, öffentliche Playlists laufen weiter (max. ~100 Titel).', { tags: ['warning'], dedupe: 'spotify-403', dedupeHours: 72 });
  }
  return blocked;
}

const mapApiTrack = (t) => ({
  title: t.name,
  artist: t.artists?.[0]?.name ?? '',
  artists: t.artists?.map((a) => a.name) ?? [],
  duration: Math.round((t.duration_ms ?? 0) / 1000),
  isrc: t.external_ids?.isrc ?? null,
});

async function pages(first, max, pick) {
  const out = [];
  let next = first;
  while (next && out.length < max) {
    const page = await api(next);
    for (const it of page.items ?? []) {
      const t = pick(it);
      if (t?.name && t.type !== 'episode' && !t.is_local) out.push(t);
    }
    next = page.next;
  }
  return out.slice(0, max);
}

async function fromApi({ type, id }) {
  if (type === 'album') {
    const meta = await api(`/albums/${id}`, { user: false });
    return {
      title: meta.name,
      owner: meta.artists?.map((a) => a.name).join(', ') ?? '',
      cover: meta.images?.[0]?.url ?? null,
      tracks: (meta.tracks?.items ?? []).map(mapApiTrack),
      full: true,
    };
  }
  const meta = await api(`/playlists/${id}`);
  // Neuer Pfad /items (seit 2026), alte Apps kennen nur /tracks; Eintrag heißt "item" oder "track"
  let items;
  try {
    items = await pages(`/playlists/${id}/items?limit=100`, 3000, (it) => it.item ?? it.track);
  } catch (err) {
    if (!/Spotify 404/.test(err.message)) throw err;
    items = await pages(`/playlists/${id}/tracks?limit=100`, 3000, (it) => it.track);
  }
  const total = meta.items?.total ?? meta.tracks?.total ?? 0;
  if (!items.length && total) throw new Error('Spotify gibt den Inhalt nicht heraus (fremde Playlist)');
  return {
    title: meta.name,
    owner: meta.owner?.display_name ?? '',
    cover: meta.images?.[0]?.url ?? null,
    tracks: items.map(mapApiTrack),
    full: true,
  };
}

async function fromLiked() {
  if (!auth?.refresh) throw new HttpError(400, 'Spotify ist nicht verbunden (Bibliothek → Spotify)');
  try {
    const items = await pages('/me/tracks?limit=50', LIKED_MAX, (it) => it.track ?? it.item);
    auth.error = null;
    return { title: 'Lieblingssongs (Spotify)', owner: auth.user?.name ?? '', cover: null, tracks: items.map(mapApiTrack), full: items.length < LIKED_MAX };
  } catch (err) {
    apiBlocked(err);
    throw err;
  }
}

// --- Spotify verbinden (OAuth) -----------------------------------------------

const pendingLogins = new Map();

/** Adresse der Spotify-Anmeldeseite. redirectUri muss genau so in der Spotify-App eingetragen sein. */
export function authorizeUrl(redirectUri) {
  if (!hasCredentials()) throw new HttpError(503, 'SPOTIFY_CLIENT_ID und SPOTIFY_CLIENT_SECRET fehlen in der .env');
  for (const [k, v] of pendingLogins) if (Date.now() - v.at > 15 * 60 * 1000) pendingLogins.delete(k);
  const state = randomBytes(12).toString('hex');
  pendingLogins.set(state, { redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    client_id: config.spotify.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    show_dialog: 'true',
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

export async function finishLogin(code, state) {
  const p = pendingLogins.get(state);
  pendingLogins.delete(state);
  if (!p) throw new HttpError(400, 'Anmeldung abgelaufen – bitte noch einmal auf „Spotify verbinden“');
  const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri });
  auth = { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + j.expires_in * 1000, connectedAt: Date.now(), error: null };
  try {
    const me = await api('/me');
    auth.user = { id: me.id, name: me.display_name || me.id };
  } catch (err) {
    auth.error = apiBlocked(err) ? auth.error : err.message;
  }
  await saveAuth();
  log('spotify', `verbunden als ${auth.user?.name ?? '?'}`);
  return auth.user;
}

export async function disconnect() {
  auth = null;
  await writeJson(AUTH_FILE, null);
}

export function account() {
  return {
    credentials: hasCredentials(),
    connected: Boolean(auth?.refresh),
    user: auth?.user ?? null,
    connectedAt: auth?.connectedAt ?? null,
    error: auth?.error ?? null,
  };
}

/** Eigene und gefolgte Playlists. own = Inhalt kommt komplett über die API. */
export async function myPlaylists() {
  if (!auth?.refresh) throw new HttpError(400, 'Spotify ist nicht verbunden');
  const out = [];
  let next = '/me/playlists?limit=50';
  try {
    while (next && out.length < 500) {
      const page = await api(next);
      for (const p of page.items ?? []) {
        if (!p?.id) continue;
        out.push({
          id: importId({ type: 'playlist', id: p.id }),
          link: canonicalLink({ type: 'playlist', id: p.id }),
          title: p.name,
          owner: p.owner?.display_name ?? '',
          own: p.owner?.id === auth.user?.id || Boolean(p.collaborative),
          cover: p.images?.[0]?.url ?? null,
          trackCount: p.items?.total ?? p.tracks?.total ?? null,
        });
      }
      next = page.next;
    }
    auth.error = null;
  } catch (err) {
    apiBlocked(err);
    throw err;
  }
  return out;
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

// --- Abgleich Spotify → Deezer ----------------------------------------------
// Deezers Suche sortiert oft schlecht (bei "50 Cent Candy Shop" steht das Original nicht
// vorn) und die Detailsuche artist:"…" track:"…" liefert manchmal gar nichts. Deshalb
// mehrere Suchen, alle Treffer bewerten und den besten nehmen.

// Zusätze, die Spotify und Deezer unterschiedlich schreiben
const NOISE = /\s*[([][^)\]]*\b(feat|ft|with|radio edit|edit|remaster(ed)?|version|mono|stereo|original mix|single|explicit|clean)\b[^)\]]*[)\]]|\s+-\s+.*$/gi;
export const cleanTitle = (t) => t.replace(NOISE, '').trim() || t;
const words = (t) => new Set(norm(t).split(' ').filter(Boolean));

/** Titel-Ähnlichkeit 0–50 */
function titleScore(spTitle, dzTitle) {
  const a = norm(spTitle);
  const b = norm(dzTitle);
  if (a === b) return 50;
  const ca = norm(cleanTitle(spTitle));
  const cb = norm(cleanTitle(dzTitle));
  if (ca && ca === cb) return 45;
  // Wortvergleich: "Nocturne Op. 9 No. 2" ⊂ "Nocturne No. 2 in E-Flat Major, Op. 9 No. 2"
  const wa = words(cleanTitle(spTitle));
  const wb = words(cleanTitle(dzTitle));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const contained = common / Math.min(wa.size, wb.size);
  const jaccard = common / (wa.size + wb.size - common);
  if (contained === 1 && Math.min(wa.size, wb.size) >= 2) return 30;
  if (jaccard >= 0.6) return 25;
  return 0;
}

function score(sp, c) {
  const t = titleScore(sp.title, c.title);
  if (!t) return -Infinity;
  let s = t;
  const ca = norm(c.artist);
  const artistHit = (sp.artists?.length ? sp.artists : [sp.artist]).some((a) => {
    const na = norm(a);
    return na && ca && (ca.includes(na) || na.includes(ca));
  });
  if (artistHit) s += 30;
  if (sp.duration && c.duration) {
    const diff = Math.abs(sp.duration - c.duration);
    s += diff <= 3 ? 25 : diff <= 10 ? 10 : -30;
  }
  return s;
}

const GOOD = 55; // genügt, z. B. gleicher Titel + gleiche Länge, oder ähnlicher Titel + Künstler
const SURE = 90; // sicher: Titel + Künstler + Länge – dann nicht weitersuchen

async function match(sp) {
  if (sp.isrc) {
    const hit = await deezer.byIsrc(sp.isrc).catch(() => null);
    if (hit) return hit;
  }
  const title = sp.title.replace(/"/g, '');
  const clean = cleanTitle(title);
  const artists = (sp.artists?.length ? sp.artists : [sp.artist]).filter(Boolean).slice(0, 3);
  const queries = [
    ...artists.map((a) => [`artist:"${a}" track:"${title}"`, 10]),
    [`track:"${title}"`, 25],
    [`${artists[0] ?? ''} ${clean}`, 25],
  ];
  if (clean !== title) queries.push([`track:"${clean}"`, 25], [`artist:"${artists[0] ?? ''}" track:"${clean}"`, 10]);

  let best = null;
  let bestScore = -Infinity;
  let failures = 0;
  const seen = new Set();
  for (const [q, limit] of queries) {
    if (seen.has(q)) continue;
    seen.add(q);
    const results = await deezer.searchTracks(q, limit).catch((err) => {
      log('spotify', `Deezer-Suche "${q}": ${err.message}`);
      failures++;
      return [];
    });
    for (const c of results) {
      const s = score(sp, c);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    if (bestScore >= SURE) break;
  }
  if (bestScore >= GOOD) return best;
  if (failures) throw new Error('Deezer-Suche fehlgeschlagen');
  return null;
}

// Treffer merken: große Listen (Lieblingssongs) sonst bei jedem Abgleich komplett neu suchen.
// "Nicht gefunden" gilt eine Woche, dann wird neu gesucht (Deezer ergänzt laufend Titel).
const MISS_TTL = 7 * 24 * 60 * 60 * 1000;
const matchKey = (sp) => `${norm(sp.artist)}|${norm(sp.title)}|${sp.isrc ?? sp.duration ?? ''}`;

async function matchCached(sp) {
  const k = matchKey(sp);
  const c = matchCache[k];
  if (c && (c.t || Date.now() - c.at < MISS_TTL)) return c.t;
  const t = await match(sp);
  matchCache[k] = { t, at: Date.now() };
  return t;
}

/** Freie Suche nach einem Song bei Deezer (z. B. für das Qualitäts-Upgrade). */
export const findOnDeezer = (track) => matchCached({ artists: [], isrc: null, ...track });
export const saveMatches = () => writeJson(MATCH_FILE, matchCache).catch((err) => log('spotify', err.message));

/** Spotify-Link → Playlist mit Deezer-Titeln (nicht gefundene separat). */
export async function importLink(link) {
  const ref = parseLink(link);
  if (!ref) throw new HttpError(400, 'Das ist kein Spotify-Playlist- oder Album-Link');

  let data;
  if (ref.type === 'liked') {
    data = await fromLiked();
  } else {
    if (hasCredentials()) {
      try {
        data = await fromApi(ref);
      } catch (err) {
        // Fremde und Spotify-eigene Playlists gibt die API nicht heraus → Einbettungsseite
        log('spotify', `API: ${err.message} → Einbettungsseite`);
      }
    }
    data ??= await fromEmbed(ref);
  }

  const started = Date.now();
  const matched = [];
  const missing = [];
  const missingTracks = [];
  const results = [];
  // Parallel, aber gebremst – Deezer erlaubt ~50 Anfragen / 5 s (Bremse sitzt in deezer.js)
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < data.tracks.length) {
        const i = next++;
        results[i] = await matchCached(data.tracks[i]).catch(() => null);
      }
    }),
  );
  data.tracks.forEach((sp, i) => {
    if (results[i]) return void matched.push({ ...results[i], position: i });
    missing.push(`${sp.artist} – ${sp.title}`);
    // Stabile ID, damit der Titel bei jedem Abgleich derselbe bleibt
    const id = `sp-${createHash('sha1').update(norm(`${sp.artist}|${sp.title}`)).digest('hex').slice(0, 16)}`;
    missingTracks.push({ id, source: 'sp', title: sp.title, artist: sp.artist, album: '', duration: sp.duration, cover: null, position: i });
  });
  saveMatches();
  log('spotify', `${data.title}: ${matched.length}/${data.tracks.length} bei Deezer gefunden (${((Date.now() - started) / 1000).toFixed(1)} s)`);

  return {
    id: importId(ref),
    source: 'sp',
    kind: ref.type,
    link: canonicalLink(ref),
    title: data.title,
    owner: data.owner,
    cover: data.cover,
    coverSmall: data.cover,
    trackCount: matched.length,
    tracks: matched,
    missing,
    missingTracks,
    complete: data.full ?? data.tracks.length < 100,
    importedAt: Date.now(),
  };
}

// Nur für Tests
export const _test = { titleScore, score, cleanTitle };
