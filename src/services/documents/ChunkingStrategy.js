const logger = require('../../utils/logger');

/**
 * Chunking Strategy for splitting documents into smaller pieces
 * Optimized for embedding generation
 */
class ChunkingStrategy {
  /**
   * Default chunking configuration
   */
  static defaultConfig = {
    chunkSize: 512,           // Target chunk size in characters
    chunkOverlap: 50,         // Overlap between chunks
    minChunkSize: 100,        // Minimum chunk size
    maxChunkSize: 1000,       // Maximum chunk size
    separators: ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' '],
  };

  /**
   * Split text into chunks
   * @param {string} text - Text to split
   * @param {object} config - Chunking configuration
   * @returns {Array<{text: string, startIndex: number, endIndex: number, chunkIndex: number}>}
   */
  static chunk(text, config = {}) {
    const settings = { ...this.defaultConfig, ...config };

    if (!text || text.length === 0) {
      return [];
    }

    // If text is smaller than chunk size, return as single chunk
    if (text.length <= settings.chunkSize) {
      return [{
        text: text.trim(),
        startIndex: 0,
        endIndex: text.length,
        chunkIndex: 0,
      }];
    }

    const chunks = [];
    let startIndex = 0;
    let chunkIndex = 0;

    while (startIndex < text.length) {
      // Calculate end index
      let endIndex = Math.min(startIndex + settings.chunkSize, text.length);

      // If we're not at the end, find a good split point
      if (endIndex < text.length) {
        const splitPoint = this.findSplitPoint(
          text,
          startIndex,
          endIndex,
          settings.separators
        );

        if (splitPoint > startIndex) {
          endIndex = splitPoint;
        }
      }

      // Extract chunk
      let chunkText = text.slice(startIndex, endIndex).trim();

      // Only add if chunk meets minimum size
      if (chunkText.length >= settings.minChunkSize || endIndex >= text.length) {
        chunks.push({
          text: chunkText,
          startIndex,
          endIndex,
          chunkIndex,
        });
        chunkIndex++;
      }

      // Move start index with overlap
      if (endIndex >= text.length) {
        break;
      }

      startIndex = endIndex - settings.chunkOverlap;
      if (startIndex <= chunks[chunks.length - 1]?.startIndex) {
        startIndex = endIndex; // Prevent infinite loop
      }
    }

    logger.debug(`Split text into ${chunks.length} chunks`);

    return chunks;
  }

  /**
   * Find the best split point near the target index
   */
  static findSplitPoint(text, startIndex, targetIndex, separators) {
    // Search backward from target for a separator
    const searchStart = Math.max(startIndex, targetIndex - 100);
    const searchEnd = Math.min(text.length, targetIndex + 50);
    const searchText = text.slice(searchStart, searchEnd);

    for (const separator of separators) {
      // Find the last occurrence of separator before target
      const lastIndex = searchText.lastIndexOf(separator, targetIndex - searchStart);
      if (lastIndex !== -1 && lastIndex > 50) { // Ensure we're not too close to start
        return searchStart + lastIndex + separator.length;
      }
    }

    // If no separator found, just use target
    return targetIndex;
  }

  /**
   * Chunk by sentences
   * @param {string} text - Text to split
   * @param {number} sentencesPerChunk - Number of sentences per chunk
   * @returns {Array<{text: string, startIndex: number, endIndex: number, chunkIndex: number}>}
   */
  static chunkBySentences(text, sentencesPerChunk = 5) {
    if (!text) return [];

    // Split into sentences
    const sentenceRegex = /[^.!?]*[.!?]+/g;
    const sentences = text.match(sentenceRegex) || [text];

    const chunks = [];
    let chunkIndex = 0;
    let currentIndex = 0;

    for (let i = 0; i < sentences.length; i += sentencesPerChunk) {
      const chunkSentences = sentences.slice(i, i + sentencesPerChunk);
      const chunkText = chunkSentences.join(' ').trim();

      if (chunkText.length > 0) {
        const startIndex = currentIndex;
        const endIndex = currentIndex + chunkText.length;

        chunks.push({
          text: chunkText,
          startIndex,
          endIndex,
          chunkIndex,
          sentenceCount: chunkSentences.length,
        });

        currentIndex = endIndex;
        chunkIndex++;
      }
    }

    return chunks;
  }

  /**
   * Chunk by paragraphs
   * @param {string} text - Text to split
   * @param {number} maxParagraphsPerChunk - Max paragraphs per chunk
   * @returns {Array<{text: string, startIndex: number, endIndex: number, chunkIndex: number}>}
   */
  static chunkByParagraphs(text, maxParagraphsPerChunk = 3) {
    if (!text) return [];

    // Split by double newlines (paragraphs)
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);

    const chunks = [];
    let chunkIndex = 0;
    let currentIndex = 0;

    for (let i = 0; i < paragraphs.length; i += maxParagraphsPerChunk) {
      const chunkParagraphs = paragraphs.slice(i, i + maxParagraphsPerChunk);
      const chunkText = chunkParagraphs.join('\n\n').trim();

      if (chunkText.length > 0) {
        const startIndex = text.indexOf(chunkParagraphs[0], currentIndex);
        const endIndex = startIndex + chunkText.length;

        chunks.push({
          text: chunkText,
          startIndex,
          endIndex,
          chunkIndex,
          paragraphCount: chunkParagraphs.length,
        });

        currentIndex = endIndex;
        chunkIndex++;
      }
    }

    return chunks;
  }

  /**
   * Chunk with semantic awareness (respects headers, lists, etc.)
   * @param {string} text - Text to split
   * @param {object} config - Configuration
   * @returns {Array<{text: string, type: string, chunkIndex: number}>}
   */
  static chunkSemantic(text, config = {}) {
    const settings = {
      chunkSize: config.chunkSize || 512,
      respectHeaders: config.respectHeaders !== false,
    };

    if (!text) return [];

    const chunks = [];
    let chunkIndex = 0;

    // Detect document structure
    const sections = this.detectSections(text);

    for (const section of sections) {
      // If section is small enough, keep as single chunk
      if (section.content.length <= settings.chunkSize) {
        chunks.push({
          text: section.content,
          type: section.type,
          header: section.header,
          chunkIndex,
        });
        chunkIndex++;
      } else {
        // Split large sections
        const subChunks = this.chunk(section.content, settings);
        for (const subChunk of subChunks) {
          chunks.push({
            text: subChunk.text,
            type: section.type,
            header: section.header,
            chunkIndex,
          });
          chunkIndex++;
        }
      }
    }

    return chunks;
  }

  /**
   * Detect sections in text (headers, lists, paragraphs)
   */
  static detectSections(text) {
    const sections = [];
    const lines = text.split('\n');

    let currentSection = { type: 'paragraph', header: null, content: '' };

    for (const line of lines) {
      // Check for markdown headers
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        // Save current section
        if (currentSection.content.trim()) {
          sections.push({ ...currentSection, content: currentSection.content.trim() });
        }
        // Start new section
        currentSection = {
          type: 'section',
          header: headerMatch[2],
          headerLevel: headerMatch[1].length,
          content: line + '\n',
        };
        continue;
      }

      // Check for list items
      const listMatch = line.match(/^[\s]*[-*\d.]+[\s]+/);
      if (listMatch && currentSection.type !== 'list') {
        if (currentSection.content.trim()) {
          sections.push({ ...currentSection, content: currentSection.content.trim() });
        }
        currentSection = { type: 'list', header: null, content: line + '\n' };
        continue;
      }

      currentSection.content += line + '\n';
    }

    // Add final section
    if (currentSection.content.trim()) {
      sections.push({ ...currentSection, content: currentSection.content.trim() });
    }

    return sections;
  }

  /**
   * Estimate number of tokens (rough approximation)
   * @param {string} text - Text to estimate
   * @returns {number} - Estimated token count
   */
  static estimateTokens(text) {
    if (!text) return 0;
    // Rough estimate: ~4 characters per token for English
    return Math.ceil(text.length / 4);
  }

  /**
   * Get optimal chunk configuration for a model
   * @param {string} model - Model name
   * @returns {object} - Chunk configuration
   */
  static getConfigForModel(model) {
    // Different models have different optimal chunk sizes
    const configs = {
      'all-MiniLM-L6-v2': {
        chunkSize: 256,
        chunkOverlap: 25,
        minChunkSize: 50,
        maxChunkSize: 512,
      },
      'all-mpnet-base-v2': {
        chunkSize: 384,
        chunkOverlap: 50,
        minChunkSize: 100,
        maxChunkSize: 768,
      },
      'default': {
        chunkSize: 512,
        chunkOverlap: 50,
        minChunkSize: 100,
        maxChunkSize: 1000,
      },
    };

    return configs[model] || configs['default'];
  }
}

module.exports = ChunkingStrategy;
