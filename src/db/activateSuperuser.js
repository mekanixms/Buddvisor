#!/usr/bin/env node
/**
 * Activates the configured `SUPERUSER_NAME` user by setting `users.is_active = 1`.
 *
 * Intended first-run workflow:
 * 1) Set `SUPERUSER_NAME` in `.env`
 * 2) Register that user in the frontend (account is created as inactive)
 * 3) Run: `npm activate_superuser`
 * 4) Log in as the superuser
 */

require('dotenv').config();

const { dbGet, dbRun, closeDatabase, runMigrations } = require('../../config/database');
const logger = require('../utils/logger');

const superuserName = (process.env.SUPERUSER_NAME || '').trim();

if (!superuserName) {
  console.error('SUPERUSER_NAME is empty. Set it in your .env before running `npm activate_superuser`.');
  process.exit(1);
}

const run = async () => {
  console.log(`Activating superuser account: "${superuserName}"`);

  try {
    // Ensure schema is up to date (includes `users.is_active`).
    await runMigrations();

    const user = await dbGet(
      'SELECT id, username, is_active FROM users WHERE username = ?',
      [superuserName]
    );

    if (!user) {
      console.error(
        `No user found with username "${superuserName}". Register this user in the frontend first, then re-run the command.`
      );
      process.exit(1);
    }

    if (user.is_active) {
      console.log(`User "${superuserName}" is already active (id: ${user.id}).`);
      return;
    }

    await dbRun(
      'UPDATE users SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [user.id]
    );

    console.log(`✅ Activated user "${superuserName}" (id: ${user.id}).`);
  } catch (error) {
    console.error('Failed to activate superuser:', error?.message || error);
    logger.error('activateSuperuser script error:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
};

run();

