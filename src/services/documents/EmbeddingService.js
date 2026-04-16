const fs = require('fs').promises;
const path = require('path');
const logger = require('../../utils/logger');

// Transformers.js will be loaded dynamically
let pipeline = null;
let embeddingPipeline = null;

/**
 * Embedding Service for generating and managing document embeddings
 * Uses Transformers.js with all-MiniLM-L6-v2 model
 */
class EmbeddingService {
  static model = 'Xenova/all-MiniLM-L6-v2';
  static embeddingDimension = 384;
  static isInitialized = false;
  static initPromise = null;

  /**
   * Initialize the embedding pipeline
   */
  static async initialize() {
    if (this.isInitialized) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        logger.info('Initializing embedding service...');

        // Dynamic import for Transformers.js (ES Module)
        const transformers = await import('@xenova/transformers');
        pipeline = transformers.pipeline;

        // Create embedding pipeline
        embeddingPipeline = await pipeline('feature-extraction', this.model, {
          quantized: true, // Use quantized model for better performance
        });

        this.isInitialized = true;
        logger.info('Embedding service initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize embedding service:', error);
        this.initPromise = null;
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Generate embeddings for text chunks
   * @param {Array<string>} texts - Array of text chunks
   * @param {number} [documentId] - Optional document ID for debug logs
   * @returns {Promise<Array<Float32Array>>} - Array of embedding vectors
   */
  static async generateEmbeddings(texts, documentId = null) {
    await this.initialize();

    if (!texts || texts.length === 0) {
      return [];
    }

    const docTag = documentId != null ? ` doc=${documentId}` : '';
    try {
      const batchSize = 10;
      const totalBatches = Math.ceil(texts.length / batchSize);
      logger.info(`[embed${docTag}] EmbeddingService: processing ${texts.length} texts in ${totalBatches} batches (batchSize=${batchSize})`);

      const embeddings = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batchIndex = Math.floor(i / batchSize) + 1;
        const batch = texts.slice(i, i + batchSize);

        for (const text of batch) {
          const output = await embeddingPipeline(text, {
            pooling: 'mean',
            normalize: true,
          });
          const embedding = Array.from(output.data);
          embeddings.push(new Float32Array(embedding));
        }

        const done = Math.min(i + batchSize, texts.length);
        // Log every 50 batches (~500 chunks) and on first/last to see progress without spam
        if (batchIndex === 1 || batchIndex === totalBatches || batchIndex % 50 === 0) {
          logger.info(`[embed${docTag}] EmbeddingService: batch ${batchIndex}/${totalBatches} done (${done}/${texts.length} embeddings)`);
        }
      }

      logger.info(`[embed${docTag}] EmbeddingService: all batches done, returning ${embeddings.length} embeddings`);
      return embeddings;
    } catch (error) {
      logger.error(`[embed${docTag}] EmbeddingService: error in generateEmbeddings:`, error?.message || error);
      if (error?.stack) logger.error(`[embed${docTag}] EmbeddingService stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Generate embedding for a single text
   * @param {string} text - Text to embed
   * @returns {Promise<Float32Array>} - Embedding vector
   */
  static async generateEmbedding(text) {
    const embeddings = await this.generateEmbeddings([text]);
    return embeddings[0];
  }

  /**
   * Save embeddings to disk
   * @param {string} embeddingPath - Path to save embeddings
   * @param {Array<{text: string, embedding: Float32Array, metadata: object}>} data - Embedding data
   */
  static async saveEmbeddings(embeddingPath, data) {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(embeddingPath), { recursive: true });

      // Prepare data for serialization
      const serializable = data.map(item => ({
        text: item.text,
        embedding: Array.from(item.embedding),
        metadata: item.metadata,
      }));

      await fs.writeFile(embeddingPath, JSON.stringify(serializable));

      logger.debug(`Saved ${data.length} embeddings to ${embeddingPath}`);
    } catch (error) {
      logger.error('Error saving embeddings:', error);
      throw error;
    }
  }

  /**
   * Load embeddings from disk
   * @param {string} embeddingPath - Path to load embeddings from
   * @returns {Promise<Array<{text: string, embedding: Float32Array, metadata: object}>>}
   */
  static async loadEmbeddings(embeddingPath) {
    try {
      const content = await fs.readFile(embeddingPath, 'utf-8');
      const data = JSON.parse(content);

      return data.map(item => ({
        text: item.text,
        embedding: new Float32Array(item.embedding),
        metadata: item.metadata,
      }));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      logger.error('Error loading embeddings:', error);
      throw error;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {Float32Array} a - First vector
   * @param {Float32Array} b - Second vector
   * @returns {number} - Similarity score (0-1)
   */
  static cosineSimilarity(a, b) {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Search for similar chunks
   * @param {string} query - Query text
   * @param {Array<{text: string, embedding: Float32Array, metadata: object}>} embeddings - Document embeddings
   * @param {number} topK - Number of results to return
   * @returns {Promise<Array<{text: string, score: number, metadata: object}>>}
   */
  static async search(query, embeddings, topK = 5) {
    if (!embeddings || embeddings.length === 0) {
      return [];
    }

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    // Calculate similarities
    const results = embeddings.map((item, index) => ({
      text: item.text,
      score: this.cosineSimilarity(queryEmbedding, item.embedding),
      metadata: item.metadata,
      index,
    }));

    // Sort by similarity and return top K
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
  }

  /**
   * Search across multiple documents
   * @param {string} query - Query text
   * @param {Array<{documentId: number, embeddings: Array}>} documents - Document embeddings
   * @param {number} topK - Number of results per document
   * @returns {Promise<Array<{documentId: number, chunks: Array}>>}
   */
  static async searchMultipleDocuments(query, documents, topK = 3) {
    const results = [];

    for (const doc of documents) {
      const chunks = await this.search(query, doc.embeddings, topK);
      if (chunks.length > 0) {
        results.push({
          documentId: doc.documentId,
          chunks,
        });
      }
    }

    // Sort by best match score
    results.sort((a, b) => {
      const aMax = Math.max(...a.chunks.map(c => c.score));
      const bMax = Math.max(...b.chunks.map(c => c.score));
      return bMax - aMax;
    });

    return results;
  }

  /**
   * Get embedding dimension
   */
  static getDimension() {
    return this.embeddingDimension;
  }

  /**
   * Get model info
   */
  static getModelInfo() {
    return {
      model: this.model,
      dimension: this.embeddingDimension,
      pooling: 'mean',
      normalized: true,
    };
  }

  /**
   * Check if service is ready
   */
  static isReady() {
    return this.isInitialized;
  }
}

module.exports = EmbeddingService;
