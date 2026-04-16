const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

/**
 * Document model for managing uploaded documents
 */
class Document {
  /**
   * Create a new document record
   * @param {object} documentData - Document data
   * @returns {Promise<object>} - Created document object
   */
  static async create(documentData) {
    try {
      const {
        user_id,
        filename,
        file_path,
        file_type,
        file_size,
        content_hash,
        embedding_path = null,
        chunk_count = 0,
      } = documentData;

      const result = await dbRun(
        `INSERT INTO documents (
          user_id, filename, file_path, file_type, file_size,
          content_hash, embedding_path, chunk_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [user_id, filename, file_path, file_type, file_size, content_hash, embedding_path, chunk_count]
      );

      logger.info(`Document created: ${filename} (ID: ${result.lastID})`);

      return await this.findById(result.lastID);
    } catch (error) {
      // Handle unique constraint violation for content_hash
      if (error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Document with identical content already exists');
      }
      logger.error('Error creating document:', error);
      throw error;
    }
  }

  /**
   * Find document by ID
   * @param {number} id - Document ID
   * @returns {Promise<object|null>} - Document object or null
   */
  static async findById(id) {
    try {
      const document = await dbGet(
        'SELECT * FROM documents WHERE id = ?',
        [id]
      );
      return document || null;
    } catch (error) {
      logger.error('Error finding document by ID:', error);
      throw error;
    }
  }

  /**
   * Find document by content hash
   * @param {string} contentHash - SHA-256 hash of content
   * @returns {Promise<object|null>} - Document object or null
   */
  static async findByContentHash(contentHash) {
    try {
      const document = await dbGet(
        'SELECT * FROM documents WHERE content_hash = ?',
        [contentHash]
      );
      return document || null;
    } catch (error) {
      logger.error('Error finding document by content hash:', error);
      throw error;
    }
  }

  /**
   * Find all documents for a user
   * @param {number} userId - User ID
   * @param {object} options - Query options
   * @returns {Promise<Array>} - Array of documents
   */
  static async findByUserId(userId, options = {}) {
    try {
      const { fileType, orderBy = 'uploaded_at', order = 'DESC', limit, offset } = options;

      let sql = 'SELECT * FROM documents WHERE user_id = ?';
      const params = [userId];

      if (fileType) {
        sql += ' AND file_type = ?';
        params.push(fileType);
      }

      // Validate orderBy to prevent SQL injection
      const validOrderColumns = ['filename', 'file_type', 'file_size', 'uploaded_at', 'chunk_count'];
      const safeOrderBy = validOrderColumns.includes(orderBy) ? orderBy : 'uploaded_at';
      const safeOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      sql += ` ORDER BY ${safeOrderBy} ${safeOrder}`;

      if (limit) {
        sql += ' LIMIT ?';
        params.push(limit);
        if (offset) {
          sql += ' OFFSET ?';
          params.push(offset);
        }
      }

      return await dbAll(sql, params);
    } catch (error) {
      logger.error('Error finding documents by user ID:', error);
      throw error;
    }
  }

  /**
   * Update document
   * @param {number} id - Document ID
   * @param {object} updates - Fields to update
   * @returns {Promise<object>} - Updated document object
   */
  static async update(id, updates) {
    try {
      const allowedFields = [
        'filename',
        'embedding_path',
        'chunk_count',
      ];

      const updateFields = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          updateFields.push(`${key} = ?`);
          values.push(value);
        }
      }

      if (updateFields.length === 0) {
        throw new Error('No valid fields to update');
      }

      values.push(id);

      const sql = `UPDATE documents SET ${updateFields.join(', ')} WHERE id = ?`;

      await dbRun(sql, values);

      logger.info(`Document updated: ${id}`);

      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating document:', error);
      throw error;
    }
  }

  /**
   * Delete document
   * @param {number} id - Document ID
   */
  static async delete(id) {
    try {
      await dbRun('DELETE FROM documents WHERE id = ?', [id]);
      logger.info(`Document deleted: ${id}`);
    } catch (error) {
      logger.error('Error deleting document:', error);
      throw error;
    }
  }

  /**
   * Get documents assigned to a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<Array>} - Array of documents
   */
  static async getBySession(sessionId) {
    try {
      return await dbAll(
        `SELECT d.* FROM documents d
         WHERE d.id IN (
           SELECT document_id FROM session_documents WHERE session_id = ?
           UNION
           SELECT document_id FROM session_agent_documents WHERE session_id = ?
         )
         ORDER BY d.filename`,
        [sessionId, sessionId]
      );
    } catch (error) {
      logger.error('Error getting documents by session:', error);
      throw error;
    }
  }

  /**
   * Get documents assigned to a specific agent within a session
   */
  static async getBySessionAndAgent(sessionId, agentId) {
    try {
      return await dbAll(
        `SELECT d.* FROM documents d
         INNER JOIN session_agent_documents sad ON d.id = sad.document_id
         WHERE sad.session_id = ? AND sad.agent_id = ?
         ORDER BY d.filename`,
        [sessionId, agentId]
      );
    } catch (error) {
      logger.error('Error getting documents by session and agent:', error);
      throw error;
    }
  }

  /**
   * Check whether a session has any per-agent document assignments configured
   */
  static async hasAgentAssignments(sessionId) {
    try {
      const row = await dbGet(
        'SELECT 1 as one FROM session_agent_documents WHERE session_id = ? LIMIT 1',
        [sessionId]
      );
      return !!row;
    } catch (error) {
      logger.error('Error checking agent assignments for session:', error);
      throw error;
    }
  }

  /**
   * Get count of documents for a user
   * @param {number} userId - User ID
   * @returns {Promise<number>} - Count of documents
   */
  static async countByUser(userId) {
    try {
      const result = await dbGet(
        'SELECT COUNT(*) as count FROM documents WHERE user_id = ?',
        [userId]
      );
      return result?.count || 0;
    } catch (error) {
      logger.error('Error counting documents:', error);
      throw error;
    }
  }

  /**
   * Get total storage used by user
   * @param {number} userId - User ID
   * @returns {Promise<number>} - Total file size in bytes
   */
  static async getTotalStorageByUser(userId) {
    try {
      const result = await dbGet(
        'SELECT SUM(file_size) as total FROM documents WHERE user_id = ?',
        [userId]
      );
      return result?.total || 0;
    } catch (error) {
      logger.error('Error getting total storage:', error);
      throw error;
    }
  }

  /**
   * Search documents by filename
   * @param {number} userId - User ID
   * @param {string} searchTerm - Search term
   * @returns {Promise<Array>} - Matching documents
   */
  static async search(userId, searchTerm) {
    try {
      return await dbAll(
        `SELECT * FROM documents
         WHERE user_id = ? AND filename LIKE ?
         ORDER BY uploaded_at DESC`,
        [userId, `%${searchTerm}%`]
      );
    } catch (error) {
      logger.error('Error searching documents:', error);
      throw error;
    }
  }

  /**
   * Get documents with embeddings
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Documents with embeddings
   */
  static async getWithEmbeddings(userId) {
    try {
      return await dbAll(
        `SELECT * FROM documents
         WHERE user_id = ? AND embedding_path IS NOT NULL AND chunk_count > 0
         ORDER BY uploaded_at DESC`,
        [userId]
      );
    } catch (error) {
      logger.error('Error getting documents with embeddings:', error);
      throw error;
    }
  }

  /**
   * Get supported file types
   * @returns {Array<{extension: string, mimeType: string, description: string}>}
   */
  static getSupportedFileTypes() {
    return [
      { extension: '.txt', mimeType: 'text/plain', description: 'Plain Text' },
      { extension: '.html', mimeType: 'text/html', description: 'HTML Document' },
      { extension: '.htm', mimeType: 'text/html', description: 'HTML Document' },
      { extension: '.pdf', mimeType: 'application/pdf', description: 'PDF Document' },
      { extension: '.doc', mimeType: 'application/msword', description: 'Word Document' },
      { extension: '.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', description: 'Word Document (OOXML)' },
      { extension: '.xls', mimeType: 'application/vnd.ms-excel', description: 'Excel Spreadsheet' },
      { extension: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', description: 'Excel Spreadsheet (OOXML)' },
      { extension: '.csv', mimeType: 'text/csv', description: 'CSV File' },
      { extension: '.md', mimeType: 'text/markdown', description: 'Markdown' },
      { extension: '.json', mimeType: 'application/json', description: 'JSON File' },
      { extension: '.png', mimeType: 'image/png', description: 'PNG Image' },
      { extension: '.jpg', mimeType: 'image/jpeg', description: 'JPEG Image' },
      { extension: '.jpeg', mimeType: 'image/jpeg', description: 'JPEG Image' },
      { extension: '.mp3', mimeType: 'audio/mpeg', description: 'MP3 Audio' },
      { extension: '.wav', mimeType: 'audio/wav', description: 'WAV Audio' },
      { extension: '.m4a', mimeType: 'audio/mp4', description: 'M4A Audio' },
      { extension: '.mp4', mimeType: 'video/mp4', description: 'MP4 Video' },
      { extension: '.mov', mimeType: 'video/quicktime', description: 'MOV Video' },
      { extension: '.webm', mimeType: 'video/webm', description: 'WebM Video' },
    ];
  }
}

module.exports = Document;
