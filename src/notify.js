// Push-Nachrichten aufs Handy über ntfy (App "ntfy" im App Store, Thema abonnieren).
import * as settings from './settings.js';
import { log } from './util.js';

const lastSent = new Map();

/**
 * @param {string} title
 * @param {string} message
 * @param {{tags?: string[], priority?: number, dedupe?: string, dedupeHours?: number}} opts
 *   dedupe: gleiche Meldung höchstens alle `dedupeHours` Stunden (Standard 12)
 */
export async function send(title, message, { tags = [], priority = 3, dedupe, dedupeHours = 12 } = {}) {
  const url = settings.get().ntfy.url;
  if (!url) return false;
  if (dedupe) {
    const last = lastSent.get(dedupe);
    if (last && Date.now() - last < dedupeHours * 3600 * 1000) return false;
    lastSent.set(dedupe, Date.now());
  }
  // JSON-Variante: Umlaute im Titel gehen sonst in HTTP-Headern kaputt
  const u = new URL(url);
  const topic = u.pathname.replace(/^\/+/, '');
  try {
    const res = await fetch(`${u.origin}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, title, message, tags, priority }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
    return true;
  } catch (err) {
    log('notify', err.message);
    if (dedupe) lastSent.delete(dedupe);
    throw err;
  }
}

/** Fehler nie nach oben durchreichen – eine fehlende Push-Nachricht darf nichts aufhalten. */
export function quiet(title, message, opts) {
  send(title, message, opts).catch(() => {});
}

// Neue Songs pro Playlist sammeln und gebündelt melden (Downloads kommen tröpfchenweise)
const pending = new Map();
let timer = null;
const BATCH_MS = Number(process.env.NOTIFY_BATCH_MS) || 10 * 60 * 1000;

export function newSongs(playlist, names) {
  if (!names.length) return;
  const list = pending.get(playlist) ?? [];
  list.push(...names);
  pending.set(playlist, list);
  clearTimeout(timer);
  timer = setTimeout(flush, BATCH_MS);
}

function flush() {
  for (const [playlist, names] of pending) {
    const shown = names.slice(0, 8).join('\n');
    const more = names.length > 8 ? `\n… und ${names.length - 8} weitere` : '';
    quiet(`${playlist}: ${names.length} neue${names.length === 1 ? 'r Song' : ' Songs'}`, shown + more, { tags: ['musical_note'] });
  }
  pending.clear();
}
