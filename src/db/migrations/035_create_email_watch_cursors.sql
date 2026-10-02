-- Last-seen cursor for the email tool's incoming watcher (IMAP IDLE / POP3 poll).
-- A restart uses this so mail already handed to the session is not posted again.
CREATE TABLE IF NOT EXISTS email_watch_cursors (
    watch_key TEXT PRIMARY KEY,
    cursor TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
