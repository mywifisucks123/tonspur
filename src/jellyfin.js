// Jellyfin: Bibliothek durchsuchen, Songs streamen, Scan anstoßen.
import path from 'node:path';
import { config } from './config.js';
import { exists } from './media.js';
import { HttpError, TtlCache, log, norm } from './util.js';

const { url: BASE, apiKey } = config.jellyfin;
const cache = new TtlCache(60 * 1000, 500);

export const isConfigured = () => Boolean(apiKey);

export function authHeaders() {
  return {
    Authorization: `MediaBrowser Client="Tonspur", Device="Mac Mini", DeviceId="tonspur-backend", Version="1.0.0", Token="${apiKey}"`,
  };
}

async function jf(path, { method = 'GET', timeout = 8000, body } = {}) {
  if (!apiKey) throw new HttpError(503, 'JELLYFIN_API_KEY fehlt');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...authHeaders(),
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new HttpError(res.status === 401 ? 502 : res.status, `Jellyfin ${res.status} ${path}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let userIdPromise;
export function userId() {
  if (config.jellyfin.userId) return Promise.resolve(config.jellyfin.userId);
  userIdPromise ??= jf('/Users')
    .then((users) => {
      const user = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
      if (!user) throw new HttpError(502, 'Kein Jellyfin-User gefunden');
      log('jellyfin', `nutze User "${user.Name}"`);
      return user.Id;
    })
    .catch((err) => {
      userIdPromise = undefined;
      throw err;
    });
  return userIdPromise;
}

const FIELDS = 'Fields=PrimaryImageAspectRatio,DateCreated,ProductionYear';

async function items(query) {
  const uid = await userId();
  const res = await jf(`/Items?userId=${uid}&Recursive=true&${FIELDS}&${query}`);
  return res?.Items ?? [];
}

const image = (id) => (id ? `/api/jf/image/${id}` : null);

export function mapTrack(i) {
  const coverId = i.AlbumPrimaryImageTag ? i.AlbumId : i.ImageTags?.Primary ? i.Id : null;
  return {
    id: i.Id,
    source: 'jf',
    title: i.Name,
    artist: i.Artists?.length ? i.Artists.join(', ') : i.AlbumArtist ?? '',
    artistId: null,
    album: i.Album ?? '',
    albumId: i.AlbumId ?? null,
    cover: image(coverId),
    coverSmall: image(coverId),
    duration: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 1e7) : 0,
    preview: null,
    local: true,
  };
}

export function mapAlbum(i) {
  return {
    id: i.Id,
    source: 'jf',
    title: i.Name,
    artist: i.AlbumArtist ?? i.Artists?.join(', ') ?? '',
    artistId: null,
    cover: i.ImageTags?.Primary ? image(i.Id) : null,
    coverSmall: i.ImageTags?.Primary ? image(i.Id) : null,
    year: i.ProductionYear ? String(i.ProductionYear) : null,
  };
}

export async function searchTracks(term, limit = 25) {
  if (!term) return [];
  const list = await items(
    `IncludeItemTypes=Audio&Limit=${limit}&searchTerm=${encodeURIComponent(term)}`,
  );
  return list.map(mapTrack);
}

export async function recentAlbums(limit = 40) {
  const list = await items(
    `IncludeItemTypes=MusicAlbum&SortBy=DateCreated&SortOrder=Descending&Limit=${limit}`,
  );
  return list.map(mapAlbum);
}

export async function album(id) {
  const uid = await userId();
  const [meta, tracks] = await Promise.all([
    jf(`/Items?userId=${uid}&Ids=${encodeURIComponent(id)}&${FIELDS}`),
    items(
      `ParentId=${encodeURIComponent(id)}&IncludeItemTypes=Audio&SortBy=ParentIndexNumber,IndexNumber,SortName`,
    ),
  ]);
  const a = meta?.Items?.[0];
  if (!a) throw new HttpError(404, 'Album nicht gefunden');
  return { ...mapAlbum(a), tracks: tracks.map(mapTrack) };
}

/** Prüft, ob ein Deezer-Track schon in Jellyfin liegt. */
export function matches(dzTrack, jfTrack) {
  const t1 = norm(dzTrack.title);
  const t2 = norm(jfTrack.title);
  if (!t1 || t1 !== t2) return false;
  const artist = norm(dzTrack.artist);
  const artistOk = artist && norm(jfTrack.artist).includes(artist);
  const durOk =
    dzTrack.duration && jfTrack.duration && Math.abs(dzTrack.duration - jfTrack.duration) <= 4;
  return Boolean(artistOk || durOk);
}

export async function findLocal(dzTrack) {
  if (!isConfigured()) return null;
  return cache.wrap(`match:${dzTrack.id}`, async () => {
    const cleaned = dzTrack.title.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
    let found = await searchTracks(cleaned, 30);
    if (!found.length) {
      const short = cleaned.split(/\s+/).slice(0, 3).join(' ');
      if (short !== cleaned) found = await searchTracks(short, 50);
    }
    return found.find((t) => matches(dzTrack, t)) ?? null;
  });
}

export function forgetMatches() {
  cache.map.clear();
}

export function streamUrl(id) {
  const safe = encodeURIComponent(id);
  if (config.jellyfin.streamMode === 'mp3') {
    return `${BASE}/Audio/${safe}/stream.mp3?audioCodec=mp3&audioBitRate=320000`;
  }
  return `${BASE}/Audio/${safe}/stream?static=true`;
}

export function imageUrl(id, size) {
  return `${BASE}/Items/${encodeURIComponent(id)}/Images/Primary?fillWidth=${size}&fillHeight=${size}&quality=90`;
}

export async function refreshLibrary() {
  const { libraryId } = config.jellyfin;
  if (libraryId) {
    await jf(
      `/Items/${libraryId}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false&ReplaceAllImages=false`,
      { method: 'POST' },
    );
  } else {
    await jf('/Library/Refresh', { method: 'POST' });
  }
  log('jellyfin', 'Bibliothek-Scan gestartet');
}

// --- Playlists (erscheinen in jeder Jellyfin-App, z. B. Finamp) --------------

export async function playlistExists(id) {
  const uid = await userId();
  const res = await jf(`/Items?userId=${uid}&Ids=${encodeURIComponent(id)}`).catch(() => null);
  return Boolean(res?.Items?.length);
}

async function playlistEntries(id) {
  const uid = await userId();
  const res = await jf(`/Playlists/${encodeURIComponent(id)}/Items?userId=${uid}`);
  return (res?.Items ?? []).map((i) => ({ itemId: i.Id, entryId: i.PlaylistItemId }));
}

export async function createPlaylist(name, ids) {
  const uid = await userId();
  const res = await jf('/Playlists', {
    method: 'POST',
    body: { Name: name, Ids: ids, UserId: uid, MediaType: 'Audio', IsPublic: true },
    timeout: 30000,
  });
  log('jellyfin', `Playlist "${name}" angelegt (${ids.length} Titel)`);
  return res.Id;
}

/**
 * Bild (z. B. Spotify-Cover) als Hauptbild eines Eintrags setzen. Jellyfin erwartet den
 * Bildinhalt Base64-kodiert im Body. Klappt das nicht, darf Jellyfin das Bild selbst laden.
 */
export async function setItemImage(id, imageUrl) {
  const item = encodeURIComponent(id);
  try {
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    if (!img.ok) throw new Error(`Bild ${img.status}`);
    const type = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!type.startsWith('image/')) throw new Error(`kein Bild (${type})`);
    const data = Buffer.from(await img.arrayBuffer()).toString('base64');
    const res = await fetch(`${BASE}/Items/${item}/Images/Primary`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': type },
      body: data,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Jellyfin ${res.status}`);
  } catch (err) {
    log('jellyfin', `Cover-Upload: ${err.message} – Jellyfin lädt es selbst`);
    await jf(`/Items/${item}/RemoteImages/Download?type=Primary&imageUrl=${encodeURIComponent(imageUrl)}`, {
      method: 'POST',
      timeout: 20000,
    });
  }
}

/** Inhalt einer Playlist exakt auf `ids` (in dieser Reihenfolge) setzen. Liefert true bei Änderung. */
export async function setPlaylistItems(id, ids) {
  const uid = await userId();
  const current = await playlistEntries(id);
  if (current.length === ids.length && current.every((e, i) => e.itemId === ids[i])) return false;
  const pid = encodeURIComponent(id);
  // Leeren und in richtiger Reihenfolge neu befüllen – die Playlist-ID bleibt gleich,
  // Apps behalten sie also als dieselbe Playlist (inkl. Offline-Download).
  for (let i = 0; i < current.length; i += 100) {
    const entries = current.slice(i, i + 100).map((e) => e.entryId).join(',');
    await jf(`/Playlists/${pid}/Items?entryIds=${entries}`, { method: 'DELETE', timeout: 30000 });
  }
  for (let i = 0; i < ids.length; i += 100) {
    await jf(`/Playlists/${pid}/Items?ids=${ids.slice(i, i + 100).join(',')}&userId=${uid}`, {
      method: 'POST',
      timeout: 30000,
    });
  }
  return true;
}

// --- Bibliothek als Ganzes (Aufräumen, Qualitäts-Upgrade) --------------------

/** Einträge mit Dateipfad, Bitrate und Nutzerdaten (Favorit, zuletzt gehört). */
export async function itemsByIds(ids) {
  const uid = await userId();
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const res = await jf(`/Items?userId=${uid}&Ids=${ids.slice(i, i + 100).join(',')}&Fields=Path,MediaSources`, { timeout: 30000 });
    out.push(...(res?.Items ?? []));
  }
  return out;
}

export async function audioItems() {
  const uid = await userId();
  const out = [];
  for (let start = 0; ; start += 500) {
    const res = await jf(
      `/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Audio&Fields=Path,MediaSources&SortBy=SortName&StartIndex=${start}&Limit=500`,
      { timeout: 60000 },
    );
    out.push(...(res?.Items ?? []));
    if (!res?.Items?.length || out.length >= (res.TotalRecordCount ?? 0)) break;
  }
  return out;
}

/** IDs aller Songs, die in irgendeiner Jellyfin-Playlist stehen (auch selbst angelegte in Finamp). */
export async function allPlaylistItemIds() {
  const uid = await userId();
  const res = await jf(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Playlist`);
  const out = new Set();
  for (const p of res?.Items ?? []) {
    for (const e of await playlistEntries(p.Id)) out.add(e.itemId);
  }
  return out;
}

/** In Jellyfin/Finamp als Favorit markierte Songs und Alben. */
export async function favorites() {
  const uid = await userId();
  const [tracks, albums] = await Promise.all([
    jf(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=Audio&Filters=IsFavorite`),
    jf(`/Items?userId=${uid}&Recursive=true&IncludeItemTypes=MusicAlbum&Filters=IsFavorite`),
  ]);
  return {
    tracks: new Set((tracks?.Items ?? []).map((i) => i.Id)),
    albums: new Set((albums?.Items ?? []).map((i) => i.Id)),
  };
}

/** Bitrate in bit/s und Codec eines Eintrags (aus MediaSources). */
export function audioInfo(item) {
  const src = item.MediaSources?.[0];
  const stream = src?.MediaStreams?.find((m) => m.Type === 'Audio');
  return {
    bitrate: stream?.BitRate ?? src?.Bitrate ?? null,
    codec: String(stream?.Codec ?? src?.Container ?? '').toLowerCase(),
  };
}

// Jellyfin sieht die Musik unter einem anderen Pfad als Tonspur (/media/music vs. /music).
// Den gemeinsamen Teil finden: hinten anfangen, bis die Datei bei uns existiert.
let prefix = null;
export async function localPath(jfPath) {
  if (!jfPath) return null;
  const inside = (p) => {
    const rel = path.relative(config.musicDir, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (prefix && jfPath.startsWith(prefix)) {
    const p = path.join(config.musicDir, jfPath.slice(prefix.length));
    if (inside(p) && (await exists(p))) return p;
  }
  const parts = jfPath.split(/[\\/]+/).filter(Boolean);
  // mindestens Ordner + Datei, damit nicht zufällig eine gleichnamige Datei passt
  for (let i = 0; i <= parts.length - 2; i++) {
    const p = path.join(config.musicDir, ...parts.slice(i));
    if (inside(p) && (await exists(p))) {
      prefix = `/${parts.slice(0, i).join('/')}${i ? '/' : ''}`;
      return p;
    }
  }
  return null;
}

export async function ping() {
  const info = await jf('/System/Info', { timeout: 4000 });
  return { ok: true, version: info?.Version ?? null, name: info?.ServerName ?? null };
}
