-- Telegram bot connection per session (kept out of work_sessions so the token is never sent to the browser)
CREATE TABLE IF NOT EXISTS session_telegram_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL UNIQUE,
    bot_token_encrypted TEXT NOT NULL,
    bot_id TEXT NOT NULL UNIQUE,
    bot_username TEXT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_update_id INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
);

-- One-time pairing codes (only the SHA-256 hash is stored)
CREATE TABLE IF NOT EXISTS session_telegram_pairings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_telegram_pairings_session_id ON session_telegram_pairings(session_id);

-- Telegram chats linked to a session
CREATE TABLE IF NOT EXISTS session_telegram_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    telegram_user_id TEXT NULL,
    username TEXT NULL,
    display_name TEXT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_message_at TEXT NULL,
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_session_telegram_chats_session_id ON session_telegram_chats(session_id);
