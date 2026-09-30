/**
 * SessionTelegram Model
 * Active-record style access to session_telegram_config, session_telegram_pairings
 * and session_telegram_chats.
 */

const { dbRun, dbGet, dbAll } = require('../../config/database');

class SessionTelegram {
  static async getConfig(sessionId) {
    const row = await dbGet(
      'SELECT * FROM session_telegram_config WHERE session_id = ?',
      [sessionId]
    );
    return row || null;
  }

  static async findConfigByBotId(botId) {
    const row = await dbGet(
      'SELECT * FROM session_telegram_config WHERE bot_id = ?',
      [String(botId)]
    );
    return row || null;
  }

  static async listEnabledConfigs() {
    return dbAll(
      `SELECT c.* FROM session_telegram_config c
       JOIN work_sessions s ON s.id = c.session_id
       WHERE c.enabled = 1 AND s.is_active = 1`
    );
  }

  static async upsertConfig({ session_id, bot_token_encrypted, bot_id, bot_username }) {
    await dbRun(
      `INSERT INTO session_telegram_config
         (session_id, bot_token_encrypted, bot_id, bot_username, enabled, last_update_id, last_error, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET
         bot_token_encrypted = excluded.bot_token_encrypted,
         bot_id = excluded.bot_id,
         bot_username = excluded.bot_username,
         enabled = 1,
         last_update_id = 0,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [session_id, bot_token_encrypted, String(bot_id), bot_username || null]
    );
    return this.getConfig(session_id);
  }

  static async setLastUpdateId(sessionId, updateId) {
    await dbRun(
      'UPDATE session_telegram_config SET last_update_id = ? WHERE session_id = ?',
      [updateId, sessionId]
    );
  }

  static async setEnabled(sessionId, enabled, lastError = null) {
    await dbRun(
      `UPDATE session_telegram_config
       SET enabled = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`,
      [enabled ? 1 : 0, lastError, sessionId]
    );
  }

  static async setLastError(sessionId, lastError) {
    await dbRun(
      'UPDATE session_telegram_config SET last_error = ? WHERE session_id = ?',
      [lastError, sessionId]
    );
  }

  static async deleteConfig(sessionId) {
    await dbRun('DELETE FROM session_telegram_pairings WHERE session_id = ?', [sessionId]);
    await dbRun('DELETE FROM session_telegram_chats WHERE session_id = ?', [sessionId]);
    await dbRun('DELETE FROM session_telegram_config WHERE session_id = ?', [sessionId]);
  }

  static async createPairing(sessionId, codeHash, expiresAtIso) {
    await dbRun(
      'DELETE FROM session_telegram_pairings WHERE session_id = ? AND (used_at IS NOT NULL OR expires_at < ?)',
      [sessionId, new Date().toISOString()]
    );
    await dbRun(
      'INSERT INTO session_telegram_pairings (session_id, code_hash, expires_at) VALUES (?, ?, ?)',
      [sessionId, codeHash, expiresAtIso]
    );
  }

  /**
   * Atomically consume a pairing code for a session. Returns true when the code
   * was valid, unused and unexpired.
   */
  static async consumePairing(sessionId, codeHash) {
    const now = new Date().toISOString();
    const result = await dbRun(
      `UPDATE session_telegram_pairings
       SET used_at = ?
       WHERE session_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      [now, sessionId, codeHash, now]
    );
    return result.changes > 0;
  }

  static async listChats(sessionId) {
    return dbAll(
      'SELECT * FROM session_telegram_chats WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId]
    );
  }

  static async findChat(sessionId, chatId) {
    const row = await dbGet(
      'SELECT * FROM session_telegram_chats WHERE session_id = ? AND chat_id = ?',
      [sessionId, String(chatId)]
    );
    return row || null;
  }

  static async addChat({ session_id, chat_id, telegram_user_id, username, display_name }) {
    await dbRun(
      `INSERT INTO session_telegram_chats
         (session_id, chat_id, telegram_user_id, username, display_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, chat_id) DO UPDATE SET
         telegram_user_id = excluded.telegram_user_id,
         username = excluded.username,
         display_name = excluded.display_name`,
      [
        session_id,
        String(chat_id),
        telegram_user_id != null ? String(telegram_user_id) : null,
        username || null,
        display_name || null,
      ]
    );
    return this.findChat(session_id, chat_id);
  }

  static async touchChat(sessionId, chatId) {
    await dbRun(
      'UPDATE session_telegram_chats SET last_message_at = ? WHERE session_id = ? AND chat_id = ?',
      [new Date().toISOString(), sessionId, String(chatId)]
    );
  }

  static async removeChatById(sessionId, id) {
    const result = await dbRun(
      'DELETE FROM session_telegram_chats WHERE session_id = ? AND id = ?',
      [sessionId, id]
    );
    return result.changes > 0;
  }

  static async removeChatByChatId(sessionId, chatId) {
    const result = await dbRun(
      'DELETE FROM session_telegram_chats WHERE session_id = ? AND chat_id = ?',
      [sessionId, String(chatId)]
    );
    return result.changes > 0;
  }
}

module.exports = SessionTelegram;
