const fs = require('fs').promises;
const { sha256 } = require('../../utils/crypto');
const Document = require('../../models/Document');
const logger = require('../../utils/logger');

/**
 * Duplicate Detector for identifying duplicate documents
 * Uses SHA-256 content hashing
 */
class DuplicateDetector {
  /**
   * Calculate content hash from file
   * @param {string} filePath - Path to file
   * @returns {Promise<string>} - SHA-256 hash
   */
  static async calculateFileHash(filePath) {
    try {
      const content = await fs.readFile(filePath);
      return sha256(content);
    } catch (error) {
      logger.error('Error calculating file hash:', error);
      throw error;
    }
  }

  /**
   * Calculate content hash from buffer
   * @param {Buffer} buffer - File buffer
   * @returns {string} - SHA-256 hash
   */
  static calculateBufferHash(buffer) {
    return sha256(buffer);
  }

  /**
   * Calculate content hash from text
   * @param {string} text - Text content
   * @returns {string} - SHA-256 hash
   */
  static calculateTextHash(text) {
    return sha256(text);
  }

  /**
   * Check if document is duplicate by content hash
   * @param {string} contentHash - SHA-256 hash
   * @returns {Promise<{isDuplicate: boolean, existingDocument: object|null}>}
   */
  static async checkByHash(contentHash) {
    try {
      const existingDocument = await Document.findByContentHash(contentHash);

      return {
        isDuplicate: !!existingDocument,
        existingDocument,
      };
    } catch (error) {
      logger.error('Error checking duplicate by hash:', error);
      throw error;
    }
  }

  /**
   * Check if file is duplicate
   * @param {string} filePath - Path to file
   * @returns {Promise<{isDuplicate: boolean, existingDocument: object|null, contentHash: string}>}
   */
  static async checkFile(filePath) {
    const contentHash = await this.calculateFileHash(filePath);
    const result = await this.checkByHash(contentHash);

    return {
      ...result,
      contentHash,
    };
  }

  /**
   * Check if buffer is duplicate
   * @param {Buffer} buffer - File buffer
   * @returns {Promise<{isDuplicate: boolean, existingDocument: object|null, contentHash: string}>}
   */
  static async checkBuffer(buffer) {
    const contentHash = this.calculateBufferHash(buffer);
    const result = await this.checkByHash(contentHash);

    return {
      ...result,
      contentHash,
    };
  }

  /**
   * Find similar documents by filename
   * @param {number} userId - User ID
   * @param {string} filename - Filename to check
   * @returns {Promise<Array>} - Similar documents
   */
  static async findSimilarByFilename(userId, filename) {
    try {
      // Extract base name without extension
      const baseName = filename.replace(/\.[^/.]+$/, '').toLowerCase();

      // Search for documents with similar names
      const documents = await Document.search(userId, baseName);

      return documents.filter(doc => {
        const docBaseName = doc.filename.replace(/\.[^/.]+$/, '').toLowerCase();
        return this.calculateStringSimilarity(baseName, docBaseName) > 0.7;
      });
    } catch (error) {
      logger.error('Error finding similar documents:', error);
      throw error;
    }
  }

  /**
   * Calculate string similarity (Levenshtein distance based)
   * @param {string} str1 - First string
   * @param {string} str2 - Second string
   * @returns {number} - Similarity score (0-1)
   */
  static calculateStringSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) {
      return 1.0;
    }

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance
   */
  static levenshteinDistance(str1, str2) {
    const m = str1.length;
    const n = str2.length;

    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(
            dp[i - 1][j],     // deletion
            dp[i][j - 1],     // insertion
            dp[i - 1][j - 1]  // substitution
          );
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Check for near-duplicates using content similarity
   * @param {string} text - Text content
   * @param {number} userId - User ID
   * @param {number} threshold - Similarity threshold (0-1)
   * @returns {Promise<Array<{document: object, similarity: number}>>}
   */
  static async findNearDuplicates(text, userId, threshold = 0.9) {
    try {
      // Get user's documents with embeddings
      const documents = await Document.getWithEmbeddings(userId);

      // For each document, compare text similarity
      const nearDuplicates = [];
      const inputHash = this.calculateTextHash(text);

      for (const doc of documents) {
        // Quick check: if hashes match, it's an exact duplicate
        if (doc.content_hash === inputHash) {
          nearDuplicates.push({
            document: doc,
            similarity: 1.0,
            isExact: true,
          });
          continue;
        }

        // For more sophisticated near-duplicate detection,
        // we could compare embeddings here
        // This is a placeholder for future enhancement
      }

      return nearDuplicates.filter(d => d.similarity >= threshold);
    } catch (error) {
      logger.error('Error finding near duplicates:', error);
      throw error;
    }
  }

  /**
   * Generate duplicate report for user's documents
   * @param {number} userId - User ID
   * @returns {Promise<{total: number, duplicates: Array, potentialDuplicates: Array}>}
   */
  static async generateDuplicateReport(userId) {
    try {
      const documents = await Document.findByUserId(userId);

      // Group by content hash
      const hashGroups = {};
      for (const doc of documents) {
        if (!hashGroups[doc.content_hash]) {
          hashGroups[doc.content_hash] = [];
        }
        hashGroups[doc.content_hash].push(doc);
      }

      // Find exact duplicates (same hash, multiple entries)
      const duplicates = Object.values(hashGroups)
        .filter(group => group.length > 1)
        .map(group => ({
          contentHash: group[0].content_hash,
          documents: group,
          count: group.length,
        }));

      // Find potential duplicates (similar filenames)
      const potentialDuplicates = [];
      for (let i = 0; i < documents.length; i++) {
        for (let j = i + 1; j < documents.length; j++) {
          const similarity = this.calculateStringSimilarity(
            documents[i].filename.toLowerCase(),
            documents[j].filename.toLowerCase()
          );

          if (similarity > 0.7 && documents[i].content_hash !== documents[j].content_hash) {
            potentialDuplicates.push({
              documents: [documents[i], documents[j]],
              filenameSimilarity: similarity,
            });
          }
        }
      }

      return {
        total: documents.length,
        duplicates,
        potentialDuplicates,
        duplicateCount: duplicates.reduce((sum, d) => sum + d.count - 1, 0),
        potentialDuplicateCount: potentialDuplicates.length,
      };
    } catch (error) {
      logger.error('Error generating duplicate report:', error);
      throw error;
    }
  }
}

module.exports = DuplicateDetector;
