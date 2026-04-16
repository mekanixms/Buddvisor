const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('../../utils/logger');

const execFileAsync = promisify(execFile);

/**
 * Renders PDF pages to PNG images using pdftoppm (poppler-utils).
 * Requires pdftoppm on PATH (e.g. apt install poppler-utils, brew install poppler).
 */
class PdfPageExtractionService {
  /**
   * Extract a set of PDF pages as PNG images for vision processing.
   * @param {string} pdfPath - Path to the PDF file
   * @param {object} options - { maxPages: number, resolution: number }
   * @returns {Promise<{ frames: string[], tmpDir: string, pageCount: number }>}
   */
  static async extractPages(pdfPath, options = {}) {
    const { maxPages = 15, resolution = 150 } = options;

    const timeoutMs = Number(process.env.PDFTOPPM_TIMEOUT_MS) || 120 * 1000; // default 2 min for large PDFs

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-pages-'));
    const outPrefix = path.join(tmpDir, 'page');

    // pdftoppm -png -r 150 input.pdf output_prefix -> page-1.png, page-2.png, ...
    const cmd = process.env.PDFTOPPM_CMD || process.env.PDFTOPPM_PATH || 'pdftoppm';
    const args = [
      '-png',
      '-r', String(resolution),
      pdfPath,
      outPrefix,
    ];

    try {
      await execFileAsync(cmd, args, {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024, // 20MB for high-res multi-page output
      });
    } catch (error) {
      await this.cleanup(tmpDir).catch(() => {});
      throw new Error(
        `PDF page extraction failed (is pdftoppm installed? e.g. poppler-utils): ${error.message || error}`
      );
    }

    const entries = await fs.readdir(tmpDir);
    const frames = entries
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort((a, b) => {
        const numA = parseInt(path.basename(a, '.png').replace(/^page-/, ''), 10);
        const numB = parseInt(path.basename(b, '.png').replace(/^page-/, ''), 10);
        return (numA || 0) - (numB || 0);
      })
      .map(f => path.join(tmpDir, f));

    const capped = frames.length > maxPages ? frames.slice(0, maxPages) : frames;
    if (frames.length > maxPages) {
      logger.info(`PdfPageExtraction: capped from ${frames.length} to ${maxPages} pages`);
    }

    return {
      frames: capped,
      tmpDir,
      pageCount: frames.length,
    };
  }

  static async cleanup(tmpDir) {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {
      logger.warn(`Failed cleaning PDF temp dir ${tmpDir}: ${e.message || e}`);
    }
  }
}

module.exports = PdfPageExtractionService;
