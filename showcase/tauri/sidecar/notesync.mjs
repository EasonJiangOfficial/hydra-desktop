// Drawn notes go to Hydra's notes page. The card stays on the Mac until it is closed; this only saves a copy.
const KINDS = new Set(['note', 'card', 'clip', 'list']);

/** The POST body for one drawn mark, or null when it is not a note. */
export function noteBody(mark, clientId) {
  if (!mark || !KINDS.has(mark.kind) || typeof clientId !== 'string' || !clientId) return null;
  const title = String(mark.heading || mark.title || '').trim().slice(0, 120);
  const items = Array.isArray(mark.items) ? mark.items.map((x) => String(x)).join('\n') : '';
  const text = String(mark.text || items || title).trim().slice(0, 20_000);
  if (!text) return null;
  return { ...(title ? { title } : {}), text, source: 'desktop', client_id: clientId.slice(0, 200) };
}

/** Posts each note. Failures are dropped: the card is already on screen. */
export function postDrawnNotes(api, marks, idPrefix) {
  if (!api || !Array.isArray(marks)) return Promise.resolve([]);
  const jobs = [];
  marks.forEach((m, i) => {
    const body = noteBody(m, `${idPrefix}:${m.part || i}`);
    if (!body) return;
    jobs.push(api.req('/api/agent/notes', { method: 'POST', body, timeout: 20_000 }).catch(() => null));
  });
  return Promise.all(jobs);
}
