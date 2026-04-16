const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('../../utils/logger');

// Try to use jsdom if available, otherwise fall back to basic normalization
let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  JSDOM = null;
  logger.warn('jsdom not available, using basic HTML normalization');
}

const ARTIFACTS_DIR = path.join(__dirname, '../../../storage/artifacts');

// Ensure artifacts directory exists
async function ensureArtifactsDir() {
  try {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  } catch (error) {
    logger.error('Error creating artifacts directory:', error);
  }
}

// Initialize directory on module load
ensureArtifactsDir();

class ArtifactService {
  /**
   * Extract HTML/iframe code blocks from content
   * @param {string} content - Message content
   * @returns {Array<{code: string, index: number}>} - Array of artifact code blocks
   */
  static extractArtifacts(content) {
    if (!content || typeof content !== 'string') {
      return [];
    }

    const artifacts = [];
    const regex = /```(?:html|iframe)\n([\s\S]*?)```/g;
    let match;
    let index = 0;

    while ((match = regex.exec(content)) !== null) {
      const code = match[1].trim();
      if (code) {
        artifacts.push({
          code,
          index: index++,
        });
      }
    }

    return artifacts;
  }

  /**
   * Normalize HTML content to ensure it's a valid HTML document
   * Uses jsdom if available to parse and fix HTML, otherwise uses basic normalization
   * @param {string} content - Raw HTML content
   * @returns {string} - Normalized HTML document
   */
  static normalizeHtml(content) {
    if (!content || typeof content !== 'string') {
      return '<!DOCTYPE html><html><head><title>Artifact</title></head><body></body></html>';
    }

    // Use jsdom if available for better HTML parsing and fixing
    if (JSDOM) {
      try {
        // Parse the HTML with jsdom - it will fix many common issues automatically
        const dom = new JSDOM(content, {
          contentType: 'text/html',
          includeNodeLocations: false,
          storageQuota: 10000000,
        });

        // Get the serialized HTML (this fixes many structural issues)
        let fixedHtml = dom.serialize();

        // Ensure it has DOCTYPE
        if (!fixedHtml.toLowerCase().startsWith('<!doctype')) {
          fixedHtml = '<!DOCTYPE html>\n' + fixedHtml;
        }

        // Remove any content after </html> tag
        const htmlEndIndex = fixedHtml.toLowerCase().lastIndexOf('</html>');
        if (htmlEndIndex !== -1) {
          fixedHtml = fixedHtml.substring(0, htmlEndIndex + 7).trim();
        }

        return fixedHtml;
      } catch (error) {
        logger.warn('Error parsing HTML with jsdom, falling back to basic normalization:', error.message);
        // Fall through to basic normalization
      }
    }

    // Basic normalization fallback (original logic)
    let trimmed = content.trim();

    // Remove any content after closing </html> tag (if present)
    const htmlEndIndex = trimmed.toLowerCase().lastIndexOf('</html>');
    if (htmlEndIndex !== -1) {
      trimmed = trimmed.substring(0, htmlEndIndex + 7).trim();
    }

    // Check if it already has DOCTYPE
    if (trimmed.toLowerCase().startsWith('<!doctype')) {
      if (!trimmed.toLowerCase().endsWith('</html>')) {
        if (!trimmed.toLowerCase().includes('</html>')) {
          const bodyMatch = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          if (bodyMatch) {
            return trimmed + '\n</html>';
          }
          const htmlMatch = trimmed.match(/<html[^>]*>([\s\S]*)/i);
          if (htmlMatch) {
            return trimmed + '\n</html>';
          }
        }
      }
      return trimmed;
    }

    // Check if it has html tag
    if (trimmed.toLowerCase().startsWith('<html')) {
      if (!trimmed.toLowerCase().endsWith('</html>')) {
        trimmed = trimmed + '\n</html>';
      }
      return '<!DOCTYPE html>\n' + trimmed;
    }

    // Check if it has head or body tags
    if (trimmed.includes('<head>') || trimmed.includes('<body>')) {
      if (!trimmed.toLowerCase().includes('</html>')) {
        trimmed = trimmed + '\n</html>';
      }
      return `<!DOCTYPE html>\n<html>\n${trimmed}`;
    }

    // Plain content, wrap in complete HTML structure
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Artifact</title>
</head>
<body>
${trimmed}
</body>
</html>`;
  }

  /**
   * Create an artifact file from HTML content
   * @param {string} content - HTML content
   * @returns {Promise<{artifactId: string, url: string}>} - Artifact ID and URL
   */
  static async createArtifact(content) {
    if (!content || typeof content !== 'string') {
      throw new Error('Content is required and must be a string');
    }

    // Normalize the HTML to ensure it's a valid document
    const normalizedContent = this.normalizeHtml(content);

    // Generate unique filename
    const artifactId = crypto.randomUUID();
    const filename = `${artifactId}.html`;
    const filePath = path.join(ARTIFACTS_DIR, filename);

    // Write the normalized HTML content to file
    await fs.writeFile(filePath, normalizedContent, 'utf8');

    logger.info(`Artifact created: ${filename}`);

    return {
      artifactId,
      url: `/api/artifacts/${artifactId}`,
    };
  }

  /**
   * Process message content and create artifacts, returning artifact metadata
   * @param {string} content - Message content
   * @returns {Promise<Array<{artifactId: string, url: string, index: number}>>} - Array of created artifacts
   */
  static async processArtifacts(content) {
    const artifacts = this.extractArtifacts(content);
    const createdArtifacts = [];

    for (const artifact of artifacts) {
      try {
        const result = await this.createArtifact(artifact.code);
        createdArtifacts.push({
          artifactId: result.artifactId,
          url: result.url,
          index: artifact.index,
        });
      } catch (error) {
        logger.error('Error creating artifact:', error);
        // Continue processing other artifacts even if one fails
      }
    }

    return createdArtifacts;
  }

  /**
   * Get artifact content by ID
   * @param {string} artifactId - Artifact ID
   * @returns {Promise<string>} - Artifact HTML content
   */
  static async getArtifact(artifactId) {
    const filename = `${artifactId}.html`;
    const filePath = path.join(ARTIFACTS_DIR, filename);

    try {
      await fs.access(filePath);
    } catch (error) {
      throw new Error('Artifact not found');
    }

    return await fs.readFile(filePath, 'utf8');
  }

  /**
   * Delete an artifact file
   * @param {string} artifactId - Artifact ID
   * @returns {Promise<void>}
   */
  static async deleteArtifact(artifactId) {
    const filename = `${artifactId}.html`;
    const filePath = path.join(ARTIFACTS_DIR, filename);

    try {
      await fs.unlink(filePath);
      logger.info(`Artifact deleted: ${filename}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

module.exports = ArtifactService;
