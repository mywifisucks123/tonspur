// Einstellungen, die man in der App ändert (statt in der .env). Die .env liefert nur Startwerte.
import path from 'node:path';
import { config } from './config.js';
import { HttpError, readJson, writeJson } from './util.js';

const FILE = path.join(config.dataDir, 'settings.json');

const defaults = () => ({
  // Songs löschen, die seit `days` Tagen in keiner Playlist mehr stehen (nur von Tonspur-Syncs geladene)
  cleanup: { enabled: false, days: Math.max(7, config.cleanup.days) },
  // Push aufs Handy über ntfy, z. B. https://ntfy.sh/tonspur-x7k2…
  ntfy: { url: config.ntfyUrl },
});

let data = defaults();

export async function init() {
  const saved = await readJson(FILE, {});
  const d = defaults();
  data = {
    cleanup: { ...d.cleanup, ...saved.cleanup },
    ntfy: { ...d.ntfy, ...saved.ntfy },
  };
}

export const get = () => data;

export async function update(patch = {}) {
  if (patch.cleanup) {
    const { enabled, days } = patch.cleanup;
    if (enabled !== undefined) data.cleanup.enabled = Boolean(enabled);
    if (days !== undefined) {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 7 || n > 365) throw new HttpError(400, 'Tage: 7 bis 365');
      data.cleanup.days = n;
    }
  }
  if (patch.ntfy) {
    const url = String(patch.ntfy.url ?? '').trim();
    if (url && !/^https?:\/\/[^/\s]+\/[\w-]{1,64}$/.test(url)) {
      throw new HttpError(400, 'ntfy-Adresse im Format https://ntfy.sh/mein-thema');
    }
    data.ntfy.url = url;
  }
  await writeJson(FILE, data);
  return data;
}
