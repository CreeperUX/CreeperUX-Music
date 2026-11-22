// Small text helpers shared by the client: case-folding for matching, and lyrics text (LRC timestamps understood).

export const lower = s => String(s ?? '').trim().toLowerCase();

/** "[01:02.50]line" (any number of stamps per line) → lines with times; plain text → lines without. */
export function parseLyrics(text) {
  if (!text || !text.trim()) return null;
  const out = [], stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  let timed = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const times = []; let m; stamp.lastIndex = 0;
    while ((m = stamp.exec(raw))) times.push(+m[1] * 60 + +m[2] + (m[3] ? +`0.${m[3]}` : 0));
    const line = raw.replace(stamp, '').replace(/^\[[a-z]+:.*\]$/i, '').trim(); // drops [ar:…] [ti:…] headers
    if (times.length) { timed = true; for (const time of times) out.push({ time, text: line }); }
    else if (line || out.length) out.push({ text: line });
  }
  if (timed) return out.filter(l => Number.isFinite(l.time)).sort((a, b) => a.time - b.time);
  return out.length ? out : null;
}
