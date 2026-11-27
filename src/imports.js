// Importierte Spotify-Playlists (mit den bei Deezer gefundenen Titeln) dauerhaft speichern.
import path from 'node:path';
import { config } from './config.js';
import { HttpError, readJson, writeJson } from './util.js';

const FILE = path.join(config.dataDir, 'imports.json');
let data = {};

export async function init() {
  data = await readJson(FILE, {});
}

export async function save(playlist) {
  data[playlist.id] = playlist;
  await writeJson(FILE, data);
  return playlist;
}

export function get(id) {
  const p = data[id];
  if (!p) throw new HttpError(404, 'Import nicht gefunden');
  return p;
}

export function list() {
  return Object.values(data)
    .sort((a, b) => b.importedAt - a.importedAt)
    .map(({ tracks, missing, ...rest }) => rest);
}

export async function remove(id) {
  delete data[id];
  await writeJson(FILE, data);
}
