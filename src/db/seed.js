#!/usr/bin/env node

/**
 * Database Seeding Script
 *
 * This script seeds the database with sample data for development/testing.
 *
 * Usage:
 *   npm run seed
 *   or
 *   node src/db/seed.js
 */

const bcrypt = require('bcrypt');
const { dbRun, closeDatabase } = require('../../config/database');
const logger = require('../utils/logger');

const seedDatabase = async () => {
  console.log('\n🌱 Seeding database with sample data...\n');

  try {
    // Create a test user
    const password = 'password123';
    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await dbRun(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      ['testuser', passwordHash]
    );

    const userId = userResult.lastID;
    console.log(`✓ Created test user: testuser (password: ${password})`);

    // Create a test work session
    const sessionResult = await dbRun(`
      INSERT INTO work_sessions (user_id, name, description, context_length)
      VALUES (?, ?, ?, ?)
    `, [
      userId,
      'Q4 2026 Tax Planning',
      'Planning session for Q4 tax strategy and compliance',
      50
    ]);

    const sessionId = sessionResult.lastID;
    console.log(`✓ Created work session: Q4 2026 Tax Planning`);

    // Create sample agents
    const agents = [
      {
        name: 'Tax Accountant',
        role: 'accounting',
        context: 'You are an expert tax accountant specializing in small business taxation.',
        provider: 'claude',
        config: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', temperature: 0.7 })
      },
      {
        name: 'Business Attorney',
        role: 'legal',
        context: 'You are a business attorney specializing in small business law and contracts.',
        provider: 'openai',
        config: JSON.stringify({ model: 'gpt-4', temperature: 0.7 })
      },
      {
        name: 'Marketing Strategist',
        role: 'marketing',
        context: 'You are a marketing strategist focused on small business growth.',
        provider: 'claude',
        config: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', temperature: 0.8 })
      }
    ];

    for (const agent of agents) {
      const result = await dbRun(`
        INSERT INTO agents (user_id, name, role, initial_context, provider_type, provider_config)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, agent.name, agent.role, agent.context, agent.provider, agent.config]);

      // Assign agent to session
      await dbRun(`
        INSERT INTO session_agents (session_id, agent_id)
        VALUES (?, ?)
      `, [sessionId, result.lastID]);

      console.log(`✓ Created agent: ${agent.name}`);
    }

    console.log('\n✅ Database seeded successfully!\n');
    console.log('You can now login with:');
    console.log('  Username: testuser');
    console.log('  Password: password123\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Seeding failed:', error.message);
    logger.error('Seed script error:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
};

// Run seeding if this script is executed directly
if (require.main === module) {
  seedDatabase();
}

module.exports = seedDatabase;
