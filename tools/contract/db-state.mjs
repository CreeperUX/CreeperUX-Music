// What the writes left in a Navidrome database, table by table, normalized so that two servers' databases compare:
// the tables Sonus clients write through the Subsonic API (annotation, playqueue, playlist, playlist_tracks,
// scrobbles), the averages a rating recomputes, and Navidrome's artwork state of playlists.
//
//   dumpState(file, { since, before })  → { table: [row, …] }, rows sorted
//   compareState(a, b)                 → [{ table, a, b }] the rows only one side has
//   settle(files)                      → waits until Navidrome's artwork worker has taken every playlist's cover from its queue
//
// Normalizing, explicitly:
//   - a time written during the run (at or after `since`) becomes `<now OFFSET>`: when it was written differs between
//     two servers, but not its shape (checked: Navidrome's `2006-01-02 15:04:05.999999999-07:00`, else `<bad time …>`)
//     nor its time zone; a time from before the run is kept as it is, and so is Go's zero time;
//   - an id made during the run (a new play queue's or playlist's: random on each side) becomes `<new playqueue of
//     USER>` or `<new playlist OWNER NAME>`, wherever it appears; ids that were in the database before (`before`, a
//     dump of the database the copies were made from) are kept.
import { DatabaseSync } from 'node:sqlite';

const TIME = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(\.\d{1,9})?([+-]\d\d:\d\d)$/;
const TABLES = {
  annotation: { sql: 'SELECT * FROM annotation', times: ['play_date', 'starred_at', 'rated_at'] },
  playqueue: { sql: 'SELECT * FROM playqueue', times: ['created_at', 'updated_at'] },
  playlist: { sql: 'SELECT * FROM playlist', times: ['created_at', 'updated_at', 'evaluated_at'] },
  playlist_tracks: { sql: 'SELECT * FROM playlist_tracks', times: [] },
  scrobbles: { sql: 'SELECT media_file_id, user_id, submission_time FROM scrobbles', times: [] },
  // a rating recomputes the item's average over every user's
  average_rating: {
    sql: `SELECT 'media_file' AS item_type, id, average_rating FROM media_file WHERE average_rating <> 0
          UNION ALL SELECT 'album', id, average_rating FROM album WHERE average_rating <> 0
          UNION ALL SELECT 'artist', id, average_rating FROM artist WHERE average_rating <> 0
          UNION ALL SELECT 'playlist', id, average_rating FROM playlist WHERE average_rating <> 0`,
    times: [],
  },
  // what Navidrome does to a playlist's cover when the playlist changes: queued for its artwork worker...
  artwork_queue: { sql: "SELECT * FROM artwork_queue WHERE item_kind = 'pl'", times: ['retry_at', 'enqueued_at'] },
  // ... which makes it anew (a grid of the playlist's album covers, picked at random: see below)
  playlist_artwork: { sql: "SELECT * FROM item_artwork WHERE item_kind = 'pl'", times: ['ref_mtime', 'attempted_at', 'updated_at'] },
};

/** Go's time text as a time (ms since 1970), or NaN. */
function parseTime(text) {
  const m = TIME.exec(text);
  if (!m) return NaN;
  return Date.parse(`${m[1].replace(' ', 'T')}${(m[2] ?? '').slice(0, 4)}${m[3]}`);
}

function normalizeTime(value, since) {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string') return value;
  if (value.startsWith('0001-01-01')) return value;
  const m = TIME.exec(value);
  if (!m) return `<bad time ${value}>`;
  return parseTime(value) >= since - 1000 ? `<now ${m[3]}>` : value;
}

/** The rows of every table, as they are (ids not yet replaced). */
function readTables(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = {};
    for (const [table, { sql }] of Object.entries(TABLES)) {
      try { out[table] = db.prepare(sql).all().map(r => ({ ...r })); } catch (e) { out[table] = [{ error: e.message }]; }
    }
    return out;
  } finally { db.close(); }
}

/** The ids a database had before the run: { playqueue: Set, playlist: Set }. */
export function knownIds(file) {
  const t = readTables(file);
  return { playqueue: new Set(t.playqueue.map(r => r.id)), playlist: new Set(t.playlist.map(r => r.id)) };
}

export function dumpState(file, { since = 0, before = { playqueue: new Set(), playlist: new Set() } } = {}) {
  const t = readTables(file);
  const names = new Map();
  for (const q of t.playqueue) if (!before.playqueue.has(q.id)) names.set(q.id, `<new playqueue of ${q.user_id}>`);
  for (const p of t.playlist) if (!before.playlist.has(p.id)) names.set(p.id, `<new playlist ${p.owner_id} ${JSON.stringify(p.name)}>`);
  const rename = v => (typeof v === 'string' && names.has(v) ? names.get(v) : v);
  // a playlist made and deleted during the run leaves its id in the artwork tables only
  const renameItem = v => (names.has(v) ? names.get(v) : before.playlist.has(v) ? v : '<a playlist made and deleted during the run>');
  const out = {};
  for (const [table, { times }] of Object.entries(TABLES)) {
    out[table] = t[table]
      .map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, times.includes(k) ? normalizeTime(v, since) : rename(v)])))
      .map(row => {
        if (table === 'playlist_artwork') {
          // a playlist's artwork state is keyed by the playlist's id
          row.item_id = renameItem(row.item_id);
          // a cover made anew during the run: Navidrome picks the grid's albums at random (resolve.go, "random()"),
          // so two servers' new covers differ even when both made one; that one was made is compared
          if (row.updated_at?.startsWith?.('<now')) { row.hash = '<made anew during the run>'; row.trace = '<…>'; }
        }
        if (table === 'artwork_queue') {
          row.item_id = renameItem(row.item_id);
          // an item the worker cannot find (a playlist deleted after its cover was queued) stays queued, retried on
          // the worker's own schedule: how often it has tried by now differs between two servers
          row.attempts = row.attempts > 0 ? '<tried>' : 0;
          if (row.attempts) row.trace = '<…>';
        }
        return row;
      })
      .map(row => JSON.stringify(row))
      .sort();
  }
  return out;
}

/** The rows one side has and the other has not, per table (a changed row shows as one of each). */
export function compareState(a, b) {
  const out = [];
  for (const table of Object.keys(TABLES)) {
    const left = new Map(), right = new Map();
    for (const r of a[table] ?? []) left.set(r, (left.get(r) ?? 0) + 1);
    for (const r of b[table] ?? []) right.set(r, (right.get(r) ?? 0) + 1);
    for (const [r, n] of left) if ((right.get(r) ?? 0) < n) out.push({ table, a: r });
    for (const [r, n] of right) if ((left.get(r) ?? 0) < n) out.push({ table, b: r });
  }
  return out;
}

/** Row counts per table, for a report. */
export const counts = state => Object.fromEntries(Object.entries(state).map(([t, rows]) => [t, rows.length]));

/**
 * Waits (up to `ms`) until no playlist is left in any of the databases' artwork queues: Navidrome's worker polls its
 * queue every 5 s, so a cover queued by a write is made a few seconds later, at its own moment on each side.
 */
export async function settle(files, { ms = 30_000 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = files.map(f => {
      const db = new DatabaseSync(f, { readOnly: true });
      // (a deleted playlist's cover stays queued, retried: not waited for)
      try { return db.prepare("SELECT count(*) AS n FROM artwork_queue WHERE item_kind = 'pl' AND item_id IN (SELECT id FROM playlist)").get().n; } finally { db.close(); }
    });
    if (left.every(n => n === 0) || Date.now() > deadline) return left;
    await new Promise(done => setTimeout(done, 500));
  }
}
