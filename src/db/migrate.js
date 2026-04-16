#!/usr/bin/env node

/**
 * Database Migration Script
 *
 * This script runs all pending database migrations in order.
 *
 * Usage:
 *   npm run migrate
 *   or
 *   node src/db/migrate.js
 */

const { runMigrations, closeDatabase } = require('../../config/database');
const logger = require('../utils/logger');

const runMigrationScript = async () => {
  console.log('\n🗄️  Running database migrations...\n');

  try {
    await runMigrations();
    console.log('\n✅ All migrations completed successfully!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    logger.error('Migration script error:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
};

// Run migrations if this script is executed directly
if (require.main === module) {
  runMigrationScript();
}

module.exports = runMigrationScript;
