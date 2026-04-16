/**
 * SQLite Local Database Tool
 * Allows agents to interact with a local SQLite database assigned per agent
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');

// Ensure storage directory exists
const STORAGE_DIR = path.join(process.cwd(), 'storage', 'agents-dbs');

async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    logger.error('Error creating storage directory:', error);
    throw error;
  }
}

/**
 * Get database path for a given database name
 * @param {string} dbName - User-provided database name
 * @param {number} sessionId - Session ID
 * @param {number} agentId - Agent ID
 * @returns {string} - Full path to database file
 */
function getDatabasePath(dbName, sessionId, agentId) {
  // Create a unique identifier: hash of sessionId + agentId + dbName
  const uniqueId = crypto
    .createHash('sha256')
    .update(`${sessionId}-${agentId}-${dbName}`)
    .digest('hex')
    .substring(0, 16);
  
  // Sanitize dbName for filename
  const sanitized = dbName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const filename = `${sanitized}_${uniqueId}.db`;
  
  // Use absolute path to avoid any path resolution issues
  const dbPath = path.resolve(STORAGE_DIR, filename);
  return dbPath;
}

/**
 * Get database connection for agent
 * @param {object} context - Execution context (sessionId, agentId)
 * @returns {Database} - SQLite database connection
 */
function getDatabase(context) {
  const { sessionId, agentId } = context;
  
  if (!sessionId || !agentId) {
    throw new Error('sessionId and agentId are required in context');
  }

  // Get tool config from session
  // We need to retrieve this from the database
  // For now, we'll get it from context.toolConfig if provided
  const toolConfig = context.toolConfig || {};
  const dbName = toolConfig?.database_name;

  if (!dbName || typeof dbName !== 'string' || dbName.trim() === '') {
    throw new Error('Database name not configured for this agent. Please configure the database name in Session Settings → Tools.');
  }

  const dbPath = getDatabasePath(dbName.trim(), sessionId, agentId);
  
  // Log the path for debugging
  logger.info(`[sqlite_local_db_info] Database path: ${dbPath}`);
  logger.info(`[sqlite_local_db_info] process.cwd(): ${process.cwd()}`);
  logger.info(`[sqlite_local_db_info] STORAGE_DIR: ${STORAGE_DIR}`);
  
  // Ensure parent directory exists (better-sqlite3 doesn't create directories)
  const dir = path.dirname(dbPath);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
    logger.info(`[sqlite_local_db_info] Created directory: ${dir}`);
  }
  
  // Open database connection (creates file if it doesn't exist)
  // Use absolute path to ensure consistency
  const absolutePath = path.resolve(dbPath);
  let db;
  try {
    db = new Database(absolutePath);
    logger.info(`[sqlite_local_db] Successfully opened database: ${absolutePath}`);
    
    // Force a write to ensure the file is created on disk
    db.pragma('synchronous = NORMAL');
    db.pragma('journal_mode = WAL'); // Use WAL mode for better concurrency
    
    // Verify the file was created immediately
    if (fsSync.existsSync(absolutePath)) {
      const stats = fsSync.statSync(absolutePath);
      logger.info(`[sqlite_local_db] Database file exists: ${absolutePath} (${stats.size} bytes)`);
    } else {
      logger.warn(`[sqlite_local_db] WARNING: Database file not found at: ${absolutePath}`);
      logger.warn(`[sqlite_local_db] Directory exists: ${fsSync.existsSync(path.dirname(absolutePath))}`);
      logger.warn(`[sqlite_local_db] Directory is writable: ${fsSync.accessSync ? 'checking...' : 'unknown'}`);
    }
  } catch (error) {
    logger.error(`[sqlite_local_db] Error opening database at ${absolutePath}:`, error);
    logger.error(`[sqlite_local_db] Error details:`, error.message, error.stack);
    throw error;
  }
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  return db;
}

/**
 * Register SQLite Local DB tool
 */
function registerSqliteLocalDbTool() {
  toolRegistry.register({
    name: 'sqlite_local_db',
    description: 'Execute SQL operations on a local SQLite database assigned to this agent. Supports CREATE TABLE, ALTER TABLE, INSERT, UPDATE, DELETE, SELECT, and other SQL operations. The database is isolated per agent and session.',
    category: 'database',
    parameters: {
      operation: {
        type: 'string',
        description: 'SQL operation to perform',
        required: true,
        enum: [
          'create_table',
          'list_tables',
          'describe_table',
          'alter_table',
          'insert',
          'update',
          'delete',
          'select',
          'execute_sql',
          'drop_table',
          'get_table_info',
        ],
      },
      sql: {
        type: 'string',
        description: 'SQL statement to execute (for execute_sql operation)',
        required: false,
        maxLength: 10000,
      },
      table_name: {
        type: 'string',
        description: 'Name of the table (for table-specific operations)',
        required: false,
        maxLength: 100,
      },
      schema: {
        type: 'string',
        description: 'Table schema definition (for create_table operation). Example: "id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER"',
        required: false,
        maxLength: 2000,
      },
      columns: {
        type: 'array',
        description: 'Column definitions for alter_table. Each item: { action: "add"|"drop"|"modify", column: "column_name", type?: "TEXT", ... }',
        required: false,
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'Action to perform: "add", "drop", or "modify"',
              enum: ['add', 'drop', 'modify'],
            },
            column: {
              type: 'string',
              description: 'Column name',
            },
            type: {
              type: 'string',
              description: 'Column type (required for "add" action, e.g., "TEXT", "INTEGER", "REAL")',
            },
          },
          required: ['action', 'column'],
        },
      },
      data: {
        type: 'object',
        description: 'Data to insert/update (object with column names as keys)',
        required: false,
      },
      where: {
        type: 'string',
        description: 'WHERE clause for UPDATE/DELETE/SELECT (without the WHERE keyword)',
        required: false,
        maxLength: 1000,
      },
      limit: {
        type: 'number',
        description: 'Maximum number of rows to return (for SELECT)',
        required: false,
        minimum: 1,
        maximum: 1000,
      },
      order_by: {
        type: 'string',
        description: 'ORDER BY clause (without the ORDER BY keyword)',
        required: false,
        maxLength: 200,
      },
    },
    handler: async (params, context) => {
      const { operation } = params;
      
      if (!context.sessionId || !context.agentId) {
        throw new Error('sessionId and agentId are required in context');
      }

      // Get tool config from database
      // Check orchestrator tools if agentId is not present, otherwise check agent tools
      const { dbAll } = require('../../../config/database');
      let toolAssignments;
      
      if (!context.agentId) {
        // Orchestrator tool config
        toolAssignments = await dbAll(
          `SELECT tool_config FROM session_orchestrator_tools 
           WHERE session_id = ? AND tool_name = ?`,
          [context.sessionId, 'sqlite_local_db']
        );
      } else {
        // Agent tool config
        toolAssignments = await dbAll(
          `SELECT tool_config FROM session_agent_tools 
           WHERE session_id = ? AND agent_id = ? AND tool_name = ?`,
          [context.sessionId, context.agentId, 'sqlite_local_db']
        );
      }

      if (!toolAssignments || toolAssignments.length === 0) {
        const entity = context.agentId ? 'agent' : 'orchestrator';
        throw new Error(`sqlite_local_db tool is not configured for this ${entity}. Please configure it in Session Settings → Tools.`);
      }

      let toolConfig = toolAssignments[0].tool_config;
      if (typeof toolConfig === 'string') {
        try {
          toolConfig = JSON.parse(toolConfig);
        } catch (e) {
          throw new Error('Invalid tool configuration. Please reconfigure the database name in Session Settings → Tools.');
        }
      }

      if (!toolConfig || !toolConfig.database_name || toolConfig.database_name.trim() === '') {
        const entity = context.agentId ? 'agent' : 'orchestrator';
        throw new Error(`Database name not configured for this ${entity}. Please configure the database name in Session Settings → Tools.`);
      }

      // Add toolConfig to context
      context.toolConfig = toolConfig;

      await ensureStorageDir();

      let db;
      let dbPath;
      try {
        db = getDatabase(context);
        // Get the path from the database object if possible, or reconstruct it
        const agentId = context.agentId !== undefined ? context.agentId : null;
        dbPath = getDatabasePath(toolConfig.database_name.trim(), context.sessionId, agentId);
        
        // Log the absolute path
        const absolutePath = path.resolve(dbPath);
        logger.info(`[sqlite_local_db] Absolute database path: ${absolutePath}`);

        switch (operation) {
          case 'create_table':
            return await handleCreateTable(db, params);
          case 'list_tables':
            return await handleListTables(db);
          case 'describe_table':
          case 'get_table_info':
            return await handleDescribeTable(db, params);
          case 'alter_table':
            return await handleAlterTable(db, params);
          case 'insert':
            return await handleInsert(db, params);
          case 'update':
            return await handleUpdate(db, params);
          case 'delete':
            return await handleDelete(db, params);
          case 'select':
            return await handleSelect(db, params);
          case 'execute_sql':
            return await handleExecuteSql(db, params);
          case 'drop_table':
            return await handleDropTable(db, params);
          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      } finally {
        if (db) {
          db.close();
          // Verify file exists after closing
          if (dbPath) {
            const absolutePath = path.resolve(dbPath);
            if (fsSync.existsSync(absolutePath)) {
              const stats = fsSync.statSync(absolutePath);
              logger.info(`[sqlite_local_db] Database file confirmed after close: ${absolutePath} (${stats.size} bytes)`);
            } else {
              logger.warn(`[sqlite_local_db] Database file NOT FOUND after close: ${absolutePath}`);
              // Try to find it
              logger.info(`[sqlite_local_db] Searching for database files in: ${STORAGE_DIR}`);
              try {
                const files = fsSync.readdirSync(STORAGE_DIR);
                logger.info(`[sqlite_local_db] Files in storage directory: ${files.join(', ')}`);
              } catch (e) {
                logger.error(`[sqlite_local_db] Error reading storage directory: ${e.message}`);
              }
            }
          }
        }
      }
    },
    examples: [
      {
        operation: 'create_table',
        table_name: 'users',
        schema: 'id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP',
      },
      {
        operation: 'list_tables',
      },
      {
        operation: 'insert',
        table_name: 'users',
        data: { name: 'John Doe', email: 'john@example.com' },
      },
      {
        operation: 'select',
        table_name: 'users',
        where: 'email = ?',
        limit: 10,
      },
    ],
    requiresAuth: true,
  });
}

/**
 * Handle CREATE TABLE operation
 */
async function handleCreateTable(db, params) {
  const { table_name, schema } = params;

  if (!table_name || !schema) {
    throw new Error('table_name and schema are required for create_table operation');
  }

  // Sanitize table name
  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');
  
  const sql = `CREATE TABLE IF NOT EXISTS ${sanitizedTableName} (${schema})`;
  
  try {
    db.exec(sql);
    return {
      success: true,
      message: `Table "${sanitizedTableName}" created successfully`,
      table_name: sanitizedTableName,
    };
  } catch (error) {
    throw new Error(`Failed to create table: ${error.message}`);
  }
}

/**
 * Handle LIST TABLES operation
 */
async function handleListTables(db) {
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master 
         WHERE type='table' AND name NOT LIKE 'sqlite_%' 
         ORDER BY name`
      )
      .all()
      .map(row => row.name);

    return {
      success: true,
      tables,
      count: tables.length,
    };
  } catch (error) {
    throw new Error(`Failed to list tables: ${error.message}`);
  }
}

/**
 * Handle DESCRIBE TABLE / GET TABLE INFO operation
 */
async function handleDescribeTable(db, params) {
  const { table_name } = params;

  if (!table_name) {
    throw new Error('table_name is required for describe_table operation');
  }

  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');

  try {
    // Get table schema
    const schema = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .get(sanitizedTableName);

    // Get column info using PRAGMA
    const columns = db.pragma(`table_info(${sanitizedTableName})`);

    // Get indexes
    const indexes = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?`)
      .all(sanitizedTableName);

    // Get row count
    const rowCount = db
      .prepare(`SELECT COUNT(*) as count FROM ${sanitizedTableName}`)
      .get();

    return {
      success: true,
      table_name: sanitizedTableName,
      schema: schema?.sql || null,
      columns: columns.map(col => ({
        name: col.name,
        type: col.type,
        notnull: col.notnull === 1,
        dflt_value: col.dflt_value,
        pk: col.pk === 1,
      })),
      indexes: indexes.map(idx => ({
        name: idx.name,
        sql: idx.sql,
      })),
      row_count: rowCount?.count || 0,
    };
  } catch (error) {
    throw new Error(`Failed to describe table: ${error.message}`);
  }
}

/**
 * Handle ALTER TABLE operation
 */
async function handleAlterTable(db, params) {
  const { table_name, columns } = params;

  if (!table_name || !columns || !Array.isArray(columns)) {
    throw new Error('table_name and columns array are required for alter_table operation');
  }

  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');

  try {
    const results = [];
    
    for (const col of columns) {
      const { action, column, type, ...otherProps } = col;
      const sanitizedColumn = column.replace(/[^a-zA-Z0-9_]/g, '_');

      if (action === 'add') {
        if (!type) {
          throw new Error(`type is required for ADD column operation`);
        }
        const sql = `ALTER TABLE ${sanitizedTableName} ADD COLUMN ${sanitizedColumn} ${type}`;
        db.exec(sql);
        results.push({ action: 'add', column: sanitizedColumn, success: true });
      } else if (action === 'drop') {
        // SQLite doesn't support DROP COLUMN directly, but we can use workaround
        // For simplicity, we'll throw an error suggesting to recreate the table
        throw new Error('SQLite does not support DROP COLUMN. Consider recreating the table or using a migration script.');
      } else if (action === 'modify') {
        // SQLite doesn't support MODIFY COLUMN directly
        throw new Error('SQLite does not support MODIFY COLUMN. Consider recreating the table or using a migration script.');
      } else {
        throw new Error(`Unknown alter action: ${action}. Supported: add, drop, modify`);
      }
    }

    return {
      success: true,
      message: `Table "${sanitizedTableName}" altered successfully`,
      results,
    };
  } catch (error) {
    throw new Error(`Failed to alter table: ${error.message}`);
  }
}

/**
 * Handle INSERT operation
 */
async function handleInsert(db, params) {
  const { table_name, data } = params;

  if (!table_name || !data || typeof data !== 'object') {
    throw new Error('table_name and data object are required for insert operation');
  }

  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');
  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map(() => '?').join(', ');

  const sql = `INSERT INTO ${sanitizedTableName} (${columns.map(c => c.replace(/[^a-zA-Z0-9_]/g, '_')).join(', ')}) VALUES (${placeholders})`;

  try {
    const stmt = db.prepare(sql);
    const result = stmt.run(...values);
    
    return {
      success: true,
      message: 'Row inserted successfully',
      last_insert_rowid: result.lastInsertRowid,
      changes: result.changes,
    };
  } catch (error) {
    throw new Error(`Failed to insert: ${error.message}`);
  }
}

/**
 * Handle UPDATE operation
 */
async function handleUpdate(db, params) {
  const { table_name, data, where } = params;

  if (!table_name || !data || typeof data !== 'object') {
    throw new Error('table_name and data object are required for update operation');
  }

  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');
  const setClause = Object.keys(data)
    .map(key => `${key.replace(/[^a-zA-Z0-9_]/g, '_')} = ?`)
    .join(', ');
  const values = Object.values(data);

  let sql = `UPDATE ${sanitizedTableName} SET ${setClause}`;
  if (where) {
    sql += ` WHERE ${where}`;
  }

  try {
    const stmt = db.prepare(sql);
    const result = stmt.run(...values);
    
    return {
      success: true,
      message: 'Rows updated successfully',
      changes: result.changes,
    };
  } catch (error) {
    throw new Error(`Failed to update: ${error.message}`);
  }
}

/**
 * Handle DELETE operation
 */
async function handleDelete(db, params) {
  const { table_name, where } = params;

  if (!table_name) {
    throw new Error('table_name is required for delete operation');
  }

  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');

  let sql = `DELETE FROM ${sanitizedTableName}`;
  if (where) {
    sql += ` WHERE ${where}`;
  } else {
    // Safety: require WHERE clause to prevent accidental deletion of all rows
    throw new Error('WHERE clause is required for delete operation to prevent accidental deletion of all rows');
  }

  try {
    const stmt = db.prepare(sql);
    const result = stmt.run();
    
    return {
      success: true,
      message: 'Rows deleted successfully',
      changes: result.changes,
    };
  } catch (error) {
    throw new Error(`Failed to delete: ${error.message}`);
  }
}

/**
 * Handle SELECT operation
 */
async function handleSelect(db, params) {
  const { table_name, where, limit, order_by } = params;

  if (!table_name) {
    throw new Error('table_name is required for select operation');
  }

  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');

  let sql = `SELECT * FROM ${sanitizedTableName}`;
  if (where) {
    sql += ` WHERE ${where}`;
  }
  if (order_by) {
    sql += ` ORDER BY ${order_by}`;
  }
  if (limit) {
    sql += ` LIMIT ${parseInt(limit)}`;
  }

  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    
    return {
      success: true,
      rows,
      count: rows.length,
    };
  } catch (error) {
    throw new Error(`Failed to select: ${error.message}`);
  }
}

/**
 * Handle EXECUTE SQL operation (for advanced use cases)
 */
async function handleExecuteSql(db, params) {
  const { sql } = params;

  if (!sql || typeof sql !== 'string') {
    throw new Error('sql is required for execute_sql operation');
  }

  // Basic safety check: only allow SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP
  const sqlUpper = sql.trim().toUpperCase();
  const allowedKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'PRAGMA'];
  const firstWord = sqlUpper.split(/\s+/)[0];
  
  if (!allowedKeywords.includes(firstWord)) {
    throw new Error(`SQL operation "${firstWord}" is not allowed. Allowed operations: ${allowedKeywords.join(', ')}`);
  }

  try {
    // For SELECT queries, return rows
    if (sqlUpper.startsWith('SELECT') || sqlUpper.startsWith('PRAGMA')) {
      const stmt = db.prepare(sql);
      const rows = stmt.all();
      return {
        success: true,
        rows,
        count: rows.length,
      };
    } else {
      // For other queries, execute and return result
      const stmt = db.prepare(sql);
      const result = stmt.run();
      return {
        success: true,
        message: 'SQL executed successfully',
        changes: result.changes,
        last_insert_rowid: result.lastInsertRowid,
      };
    }
  } catch (error) {
    throw new Error(`Failed to execute SQL: ${error.message}`);
  }
}

/**
 * Handle DROP TABLE operation
 */
async function handleDropTable(db, params) {
  const { table_name } = params;

  if (!table_name) {
    throw new Error('table_name is required for drop_table operation');
  }

  const sanitizedTableName = table_name.replace(/[^a-zA-Z0-9_]/g, '_');

  try {
    const sql = `DROP TABLE IF EXISTS ${sanitizedTableName}`;
    db.exec(sql);
    
    return {
      success: true,
      message: `Table "${sanitizedTableName}" dropped successfully`,
    };
  } catch (error) {
    throw new Error(`Failed to drop table: ${error.message}`);
  }
}

/**
 * Cleanup function to checkpoint all WAL files and ensure data is persisted
 * This should be called during graceful shutdown
 */
async function cleanupAllDatabases() {
  try {
    // Check if storage directory exists
    if (!fsSync.existsSync(STORAGE_DIR)) {
      logger.info('[sqlite_local_db] No agent databases directory found, nothing to cleanup');
      return;
    }

    // Find all .db files in the storage directory
    const files = fsSync.readdirSync(STORAGE_DIR);
    const dbFiles = files.filter(f => f.endsWith('.db'));

    if (dbFiles.length === 0) {
      logger.info('[sqlite_local_db] No agent databases found to cleanup');
      return;
    }

    logger.info(`[sqlite_local_db] Checkpointing ${dbFiles.length} database(s) before shutdown...`);

    let successCount = 0;
    let errorCount = 0;

    for (const dbFile of dbFiles) {
      const dbPath = path.join(STORAGE_DIR, dbFile);
      const absolutePath = path.resolve(dbPath);

      try {
        // Open database
        const db = new Database(absolutePath);
        
        // Checkpoint WAL file (merge WAL into main database)
        // This ensures all uncommitted transactions are written to the main DB file
        db.pragma('wal_checkpoint(TRUNCATE)');
        
        // Close database
        db.close();
        
        successCount++;
        logger.debug(`[sqlite_local_db] Checkpointed: ${dbFile}`);
      } catch (error) {
        errorCount++;
        logger.warn(`[sqlite_local_db] Failed to checkpoint ${dbFile}: ${error.message}`);
      }
    }

    logger.info(`[sqlite_local_db] Cleanup complete: ${successCount} successful, ${errorCount} errors`);
  } catch (error) {
    logger.error('[sqlite_local_db] Error during database cleanup:', error);
  }
}

module.exports = {
  registerSqliteLocalDbTool,
  cleanupAllDatabases,
  getDatabasePath,
};
