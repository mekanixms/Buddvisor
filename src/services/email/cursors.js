/**
 * Persist the incoming-mail cursor so a process restart does not post the same mail again.
 */

async function getCursor(watchKey) {
  const { dbGet } = require('../../../config/database');
  const row = await dbGet('SELECT cursor FROM email_watch_cursors WHERE watch_key = ?', [watchKey]);
  if (!row || row.cursor == null) return null;
  try {
    return JSON.parse(row.cursor);
  } catch {
    return null;
  }
}

async function setCursor(watchKey, cursor) {
  const { dbRun } = require('../../../config/database');
  await dbRun(
    `INSERT INTO email_watch_cursors (watch_key, cursor, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(watch_key) DO UPDATE SET cursor = excluded.cursor, updated_at = datetime('now')`,
    [watchKey, JSON.stringify(cursor)]
  );
}

module.exports = { getCursor, setCursor };
