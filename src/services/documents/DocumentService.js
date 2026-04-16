const fs = require('fs').promises;
const path = require('path');
const Document = require('../../models/Document');
const DocumentProcessor = require('./DocumentProcessor');
const ChunkingStrategy = require('./ChunkingStrategy');
const EmbeddingService = require('./EmbeddingService');
const DuplicateDetector = require('./DuplicateDetector');
const logger = require('../../utils/logger');

// Storage paths from environment
const DOCUMENTS_PATH = process.env.DOCUMENTS_PATH || './storage/documents';
const EMBEDDINGS_PATH = process.env.EMBEDDINGS_PATH || './storage/embeddings';

/**
 * Document Service - Main orchestrator for document operations
 */
class DocumentService {
  /**
   * Upload and process a document
   * @param {number} userId - User ID
   * @param {object} file - Uploaded file object from Multer
   * @param {object} options - Processing options
   * @returns {Promise<object>} - Created document with processing status
   */
  static async uploadDocument(userId, file, options = {}) {
    const { generateEmbeddings = true, chunkingConfig = {} } = options;

    try {
      // Check file type
      if (!DocumentProcessor.isSupported(file.mimetype)) {
        throw new Error(`Unsupported file type: ${file.mimetype}`);
      }

      // Check file size
      if (file.size > DocumentProcessor.getMaxFileSize()) {
        throw new Error(`File too large. Maximum size is ${DocumentProcessor.getMaxFileSize() / 1024 / 1024}MB`);
      }

      // Calculate content hash from buffer
      const contentHash = DuplicateDetector.calculateBufferHash(file.buffer);

      // Check for duplicates
      const duplicateCheck = await DuplicateDetector.checkByHash(contentHash);
      if (duplicateCheck.isDuplicate) {
        throw new Error(`Duplicate document detected. This file already exists as "${duplicateCheck.existingDocument.filename}"`);
      }

      // Create user document directory
      const userDocDir = path.join(DOCUMENTS_PATH, userId.toString());
      await fs.mkdir(userDocDir, { recursive: true });

      // Generate unique filename
      const timestamp = Date.now();
      const safeFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storedFilename = `${timestamp}_${safeFilename}`;
      const filePath = path.join(userDocDir, storedFilename);

      // Save file
      await fs.writeFile(filePath, file.buffer);

      // Create document record
      const document = await Document.create({
        user_id: userId,
        filename: file.originalname,
        file_path: filePath,
        file_type: file.mimetype,
        file_size: file.size,
        content_hash: contentHash,
      });

      logger.info(`Document uploaded: ${document.filename} (ID: ${document.id})`);

      // Process document asynchronously
      if (generateEmbeddings) {
        this.processDocumentAsync(document.id, userId, chunkingConfig).catch(err => {
          logger.error(`Async processing failed for document ${document.id}:`, err);
        });
      }

      return {
        document,
        status: generateEmbeddings ? 'processing' : 'uploaded',
        message: generateEmbeddings
          ? 'Document uploaded. Embeddings are being generated.'
          : 'Document uploaded successfully.',
      };
    } catch (error) {
      logger.error('Error uploading document:', error);
      throw error;
    }
  }

  /**
   * Process document asynchronously (extract text, chunk, generate embeddings)
   * @param {number} documentId - Document ID
   * @param {number} userId - User ID
   * @param {object} chunkingConfig - Chunking configuration
   */
  static async processDocumentAsync(documentId, userId, chunkingConfig = {}) {
    try {
      const document = await Document.findById(documentId);
      if (!document) {
        throw new Error('Document not found');
      }

      logger.info(`Processing document: ${document.filename}`);

      // Extract text content
      const { text, metadata } = await DocumentProcessor.process(
        document.file_path,
        document.file_type
      );

      if (!text || text.length === 0) {
        logger.warn(`No text extracted from document ${documentId}`);
        return;
      }

      // Chunk the text
      const config = {
        ...ChunkingStrategy.getConfigForModel('all-MiniLM-L6-v2'),
        ...chunkingConfig,
      };
      const chunks = ChunkingStrategy.chunk(text, config);

      if (chunks.length === 0) {
        logger.warn(`No chunks created for document ${documentId}`);
        return;
      }

      // Cap chunks to avoid OOM and 100% CPU when embedding 10k+ chunks (e.g. from 4MB HTML)
      const maxChunks = 4000;
      const chunksToUse = chunks.length > maxChunks ? chunks.slice(0, maxChunks) : chunks;
      if (chunks.length > maxChunks) {
        logger.warn(
          `Document ${documentId}: capping chunks from ${chunks.length} to ${maxChunks} to avoid resource exhaustion`
        );
      }

      logger.debug(`Created ${chunksToUse.length} chunks for document ${documentId}`);

      // Generate embeddings
      const chunkTexts = chunksToUse.map(c => c.text);
      logger.info(`[embed doc=${documentId}] Starting embedding generation for ${chunkTexts.length} chunks`);
      const embeddings = await EmbeddingService.generateEmbeddings(chunkTexts, documentId);
      logger.info(`[embed doc=${documentId}] Embedding generation completed, got ${embeddings.length} vectors`);

      // Prepare embedding data
      const embeddingData = chunksToUse.map((chunk, index) => ({
        text: chunk.text,
        embedding: embeddings[index],
        metadata: {
          chunkIndex: chunk.chunkIndex,
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
          documentId,
          documentMetadata: metadata,
        },
      }));

      // Save embeddings
      const userEmbeddingsDir = path.join(EMBEDDINGS_PATH, userId.toString());
      await fs.mkdir(userEmbeddingsDir, { recursive: true });

      const embeddingPath = path.join(userEmbeddingsDir, `${documentId}.json`);
      logger.info(`[embed doc=${documentId}] Saving ${embeddingData.length} embeddings to ${embeddingPath}`);
      await EmbeddingService.saveEmbeddings(embeddingPath, embeddingData);
      logger.info(`[embed doc=${documentId}] Embeddings saved to disk`);

      // Update document record
      await Document.update(documentId, {
        embedding_path: embeddingPath,
        chunk_count: embeddingData.length,
      });

      logger.info(`[embed doc=${documentId}] Document record updated, processing done`);
    } catch (error) {
      logger.error(`[embed doc=${documentId}] Async processing failed:`, error?.message || error);
      if (error?.stack) logger.error(`[embed doc=${documentId}] stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Get document by ID with permission check
   * @param {number} documentId - Document ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Document object
   */
  static async getDocument(documentId, userId) {
    const document = await Document.findById(documentId);

    if (!document) {
      throw new Error('Document not found');
    }

    if (document.user_id !== userId) {
      throw new Error('Not authorized to access this document');
    }

    return document;
  }

  /**
   * List documents for a user
   * @param {number} userId - User ID
   * @param {object} options - Query options
   * @returns {Promise<Array>} - List of documents
   */
  static async listDocuments(userId, options = {}) {
    return await Document.findByUserId(userId, options);
  }

  /**
   * Delete a document
   * @param {number} documentId - Document ID
   * @param {number} userId - User ID
   */
  static async deleteDocument(documentId, userId) {
    const document = await this.getDocument(documentId, userId);

    // Delete file
    try {
      await fs.unlink(document.file_path);
    } catch (error) {
      logger.warn(`Could not delete file ${document.file_path}:`, error.message);
    }

    // Delete embeddings
    if (document.embedding_path) {
      try {
        await fs.unlink(document.embedding_path);
      } catch (error) {
        logger.warn(`Could not delete embeddings ${document.embedding_path}:`, error.message);
      }
    }

    // Delete database record
    await Document.delete(documentId);

    logger.info(`Document deleted: ${document.filename} (ID: ${documentId})`);
  }

  /**
   * Reprocess a document (regenerate embeddings)
   * @param {number} documentId - Document ID
   * @param {number} userId - User ID
   * @param {object} options - Processing options
   */
  static async reprocessDocument(documentId, userId, options = {}) {
    const document = await this.getDocument(documentId, userId);

    // Delete existing embeddings
    if (document.embedding_path) {
      try {
        await fs.unlink(document.embedding_path);
      } catch (error) {
        // File might not exist
      }
    }

    // Reset embedding info
    await Document.update(documentId, {
      embedding_path: null,
      chunk_count: 0,
    });

    // Reprocess
    await this.processDocumentAsync(documentId, userId, options.chunkingConfig || {});

    return { message: 'Document reprocessing started' };
  }

  /**
   * Search documents by query
   * @param {number} userId - User ID
   * @param {string} query - Search query
   * @param {object} options - Search options
   * @returns {Promise<Array>} - Search results
   */
  static async searchDocuments(userId, query, options = {}) {
    const { topK = 5, documentIds = null } = options;

    try {
      // Get documents with embeddings
      let documents = await Document.getWithEmbeddings(userId);

      // Filter by specific document IDs if provided
      if (documentIds && documentIds.length > 0) {
        documents = documents.filter(d => documentIds.includes(d.id));
      }

      if (documents.length === 0) {
        return [];
      }

      // Load embeddings for each document
      const documentsWithEmbeddings = [];
      for (const doc of documents) {
        try {
          const embeddings = await EmbeddingService.loadEmbeddings(doc.embedding_path);
          if (embeddings.length > 0) {
            documentsWithEmbeddings.push({
              documentId: doc.id,
              filename: doc.filename,
              embeddings,
            });
          }
        } catch (error) {
          logger.warn(`Could not load embeddings for document ${doc.id}`);
        }
      }

      // Search across all documents
      const results = await EmbeddingService.searchMultipleDocuments(
        query,
        documentsWithEmbeddings,
        topK
      );

      // Format results
      return results.map(result => {
        const doc = documents.find(d => d.id === result.documentId);
        return {
          documentId: result.documentId,
          filename: doc?.filename,
          chunks: result.chunks.map(chunk => ({
            text: chunk.text,
            score: chunk.score,
            chunkIndex: chunk.metadata?.chunkIndex,
          })),
        };
      });
    } catch (error) {
      logger.error('Error searching documents:', error);
      throw error;
    }
  }

  /**
   * Get document statistics for a user
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Statistics
   */
  static async getStatistics(userId) {
    const [
      totalDocuments,
      totalStorage,
      documentsWithEmbeddings,
      duplicateReport,
    ] = await Promise.all([
      Document.countByUser(userId),
      Document.getTotalStorageByUser(userId),
      Document.getWithEmbeddings(userId),
      DuplicateDetector.generateDuplicateReport(userId),
    ]);

    // Calculate total chunks
    const totalChunks = documentsWithEmbeddings.reduce(
      (sum, doc) => sum + (doc.chunk_count || 0),
      0
    );

    return {
      totalDocuments,
      totalStorage,
      totalStorageFormatted: this.formatBytes(totalStorage),
      documentsWithEmbeddings: documentsWithEmbeddings.length,
      totalChunks,
      duplicates: duplicateReport.duplicateCount,
      potentialDuplicates: duplicateReport.potentialDuplicateCount,
    };
  }

  /**
   * Get supported file types
   */
  static getSupportedFileTypes() {
    return Document.getSupportedFileTypes();
  }

  /**
   * Format bytes to human readable
   */
  static formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Detect documents explicitly mentioned by filename in a query
   * @param {string} query - User query
   * @param {Array} documents - Available documents
   * @returns {Array} - Documents mentioned by name
   */
  static detectMentionedDocuments(query, documents) {
    const queryLower = query.toLowerCase();
    const mentionedDocs = [];

    for (const doc of documents) {
      // Check for filename or partial filename match
      const filenameLower = doc.filename.toLowerCase();
      const filenameWithoutExt = filenameLower.replace(/\.[^/.]+$/, '');

      // Check various ways user might reference the document
      if (
        queryLower.includes(filenameLower) ||
        queryLower.includes(filenameWithoutExt) ||
        // Check for partial matches (e.g., "ING" document)
        filenameLower.split(/[_\-\s]+/).some(part =>
          part.length > 3 && queryLower.includes(part)
        )
      ) {
        mentionedDocs.push(doc);
      }
    }

    return mentionedDocs;
  }

  /**
   * Get context from documents for a session
   * @param {number} sessionId - Session ID
   * @param {string} query - Query to find relevant context
   * @param {number} maxChunks - Maximum chunks to return
   * @param {number|null} agentId - Optional agent ID to restrict docs to that agent
   * @returns {Promise<Array>} - Array of relevant chunks with {text, filename, score}
   */
  static async getSessionDocumentContext(sessionId, query, maxChunks = 5, agentId = null) {
    try {
      // Get documents assigned to session (optionally restricted to a specific agent)
      let documents = [];
      if (agentId != null) {
        const hasPerAgentAssignments = await Document.hasAgentAssignments(sessionId);
        documents = hasPerAgentAssignments
          ? await Document.getBySessionAndAgent(sessionId, agentId)
          : await Document.getBySession(sessionId);
      } else {
        documents = await Document.getBySession(sessionId);
      }

      if (documents.length === 0) {
        logger.debug(
          agentId != null
            ? `No documents assigned to session ${sessionId} for agent ${agentId}`
            : `No documents assigned to session ${sessionId}`
        );
        return [];
      }

      logger.info(
        agentId != null
          ? `Session ${sessionId} has ${documents.length} documents assigned for agent ${agentId}`
          : `Session ${sessionId} has ${documents.length} documents assigned`
      );

      // Detect explicitly mentioned documents
      const mentionedDocs = this.detectMentionedDocuments(query, documents);
      if (mentionedDocs.length > 0) {
        logger.info(`User explicitly mentioned ${mentionedDocs.length} document(s): ${mentionedDocs.map(d => d.filename).join(', ')}`);
      }

      // Get embeddings for session documents
      const documentsWithEmbeddings = [];
      for (const doc of documents) {
        if (doc.embedding_path) {
          try {
            const embeddings = await EmbeddingService.loadEmbeddings(doc.embedding_path);
            if (embeddings.length > 0) {
              documentsWithEmbeddings.push({
                documentId: doc.id,
                filename: doc.filename,
                embeddings,
                isMentioned: mentionedDocs.some(m => m.id === doc.id),
              });
            }
          } catch (error) {
            logger.warn(`Could not load embeddings for document ${doc.id}: ${error.message}`);
          }
        } else {
          logger.warn(`Document ${doc.id} (${doc.filename}) has no embeddings`);
        }
      }

      if (documentsWithEmbeddings.length === 0) {
        logger.warn(`No embeddings available for session ${sessionId} documents`);
        return [];
      }

      const relevantChunks = [];

      // For explicitly mentioned documents, include more chunks (they are specifically requested)
      const mentionedDocsWithEmbeddings = documentsWithEmbeddings.filter(d => d.isMentioned);
      for (const doc of mentionedDocsWithEmbeddings) {
        // For explicitly mentioned docs, include more chunks to capture the document content
        const chunksToTake = Math.min(5, doc.embeddings.length);
        logger.info(`Including ${chunksToTake} chunks from explicitly mentioned document: ${doc.filename}`);
        for (let i = 0; i < chunksToTake; i++) {
          relevantChunks.push({
            text: doc.embeddings[i].text,
            score: 1.0, // High score for explicitly mentioned docs
            filename: doc.filename,
            source: 'explicit_mention',
          });
        }
      }

      // Search for relevant chunks via semantic similarity
      const results = await EmbeddingService.searchMultipleDocuments(
        query,
        documentsWithEmbeddings,
        Math.ceil(maxChunks / documentsWithEmbeddings.length)
      );

      // Collect semantically relevant chunks
      for (const result of results) {
        for (const chunk of result.chunks) {
          if (chunk.score > 0.3) { // Minimum relevance threshold
            const docInfo = documentsWithEmbeddings.find(d => d.documentId === result.documentId);
            // Avoid duplicates from mentioned documents
            const isDuplicate = relevantChunks.some(
              rc => rc.filename === docInfo?.filename && rc.text === chunk.text
            );
            if (!isDuplicate) {
              relevantChunks.push({
                text: chunk.text,
                score: chunk.score,
                filename: docInfo?.filename,
                source: 'semantic_search',
              });
            }
          }
        }
      }

      // Sort by relevance and take top chunks
      relevantChunks.sort((a, b) => b.score - a.score);
      const topChunks = relevantChunks.slice(0, maxChunks);

      logger.info(`Returning ${topChunks.length} document chunks for context`);

      // Return array of chunks (not formatted string)
      return topChunks;
    } catch (error) {
      logger.error('Error getting session document context:', error);
      return [];
    }
  }
}

module.exports = DocumentService;
