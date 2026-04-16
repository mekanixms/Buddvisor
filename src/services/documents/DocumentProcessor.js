const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const xlsx = require('xlsx');
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('../../utils/logger');

const execFileAsync = promisify(execFile);

/**
 * Document Processor for extracting text from various file formats
 */
class DocumentProcessor {
  /**
   * Process a document and extract text content
   * @param {string} filePath - Path to the file
   * @param {string} fileType - MIME type of the file
   * @returns {Promise<{text: string, metadata: object}>}
   */
  static async process(filePath, fileType) {
    const extension = path.extname(filePath).toLowerCase();

    logger.debug(`Processing document: ${filePath} (${fileType})`);

    try {
      switch (extension) {
        case '.txt':
        case '.md':
          return await this.processTextFile(filePath);

        case '.html':
        case '.htm':
          return await this.processHTML(filePath);

        case '.pdf':
          return await this.processPDF(filePath);

        case '.doc':
        case '.docx':
          return await this.processWord(filePath);

        case '.xls':
        case '.xlsx':
          return await this.processExcel(filePath);

        case '.csv':
          return await this.processCSV(filePath);

        case '.json':
          return await this.processJSON(filePath);

        case '.png':
        case '.jpg':
        case '.jpeg':
          return await this.processImage(filePath);

        case '.mp3':
        case '.wav':
        case '.m4a':
          return await this.processAudio(filePath);

        case '.mp4':
        case '.mov':
        case '.webm':
          return await this.processVideo(filePath);

        default:
          throw new Error(`Unsupported file type: ${extension}`);
      }
    } catch (error) {
      logger.error(`Error processing document ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Process plain text files
   */
  static async processTextFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');

    return {
      text: content,
      metadata: {
        type: 'text',
        encoding: 'utf-8',
        lineCount: content.split('\n').length,
        wordCount: this.countWords(content),
      },
    };
  }

  /**
   * Process HTML files - extracts text content and strips HTML tags.
   * Uses linear-time regexes to avoid ReDoS on large files (e.g. 4MB+ HTML).
   */
  static async processHTML(filePath) {
    const htmlContent = await fs.readFile(filePath, 'utf-8');

    // Remove script and style elements and their content.
    // Use [\s\S]*? (non-greedy) to avoid catastrophic backtracking that can
    // hang the process on large HTML. The previous pattern with (?!<\/script>)<[^<]*)*
    // caused exponential ReDoS on 4MB+ files.
    let text = htmlContent.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style\b[\s\S]*?<\/style>/gi, '');

    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");

    // Remove HTML tags
    text = text.replace(/<[^>]+>/g, ' ');

    // Decode additional HTML entities (basic numeric and named entities)
    text = text.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
    text = text.replace(/&#x([a-f\d]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

    // Clean up whitespace - replace multiple spaces/newlines with single space/newline
    text = text.replace(/\s+/g, ' ').trim();

    // Truncate very large extractions to avoid 10k+ chunks and OOM/CPU exhaustion
    // during embedding. 500k chars ~= 2000 chunks at 256; keeps processing viable.
    const maxExtractedLength = 500000;
    let truncated = false;
    const extractedBeforeTruncation = text.length;
    if (text.length > maxExtractedLength) {
      text = text.slice(0, maxExtractedLength);
      truncated = true;
      logger.warn(
        `HTML extracted text truncated from ${extractedBeforeTruncation} to ${maxExtractedLength} chars to avoid excessive chunks`
      );
    }

    return {
      text,
      metadata: {
        type: 'html',
        encoding: 'utf-8',
        originalLength: htmlContent.length,
        extractedLength: text.length,
        truncated,
        wordCount: this.countWords(text),
      },
    };
  }

  /**
   * Process PDF files
   */
  static async processPDF(filePath) {
    const dataBuffer = await fs.readFile(filePath);

    const data = await pdfParse(dataBuffer);

    return {
      text: data.text,
      metadata: {
        type: 'pdf',
        pages: data.numpages,
        info: data.info,
        wordCount: this.countWords(data.text),
      },
    };
  }

  /**
   * Process Word documents (.doc, .docx)
   */
  static async processWord(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });

    return {
      text: result.value,
      metadata: {
        type: 'word',
        messages: result.messages,
        wordCount: this.countWords(result.value),
      },
    };
  }

  /**
   * Process Excel files (.xls, .xlsx)
   */
  static async processExcel(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheets = [];
    let allText = '';

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];

      // Convert to JSON
      const jsonData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

      // Convert to text representation
      const sheetText = jsonData
        .map(row => row.join('\t'))
        .join('\n');

      sheets.push({
        name: sheetName,
        rowCount: jsonData.length,
        text: sheetText,
      });

      allText += `\n--- Sheet: ${sheetName} ---\n${sheetText}\n`;
    }

    return {
      text: allText.trim(),
      metadata: {
        type: 'excel',
        sheetCount: workbook.SheetNames.length,
        sheets: sheets.map(s => ({ name: s.name, rowCount: s.rowCount })),
        wordCount: this.countWords(allText),
      },
    };
  }

  /**
   * Process CSV files
   */
  static async processCSV(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');

    // Parse CSV
    const lines = content.split('\n');
    const headers = lines[0]?.split(',').map(h => h.trim()) || [];

    // Convert to readable text
    let textRepresentation = `Headers: ${headers.join(', ')}\n\n`;

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      const values = lines[i].split(',');
      const row = headers.map((header, idx) => `${header}: ${values[idx]?.trim() || ''}`);
      textRepresentation += `Row ${i}: ${row.join(', ')}\n`;
    }

    return {
      text: textRepresentation,
      metadata: {
        type: 'csv',
        headers,
        rowCount: lines.length - 1,
        wordCount: this.countWords(textRepresentation),
      },
    };
  }

  /**
   * Process JSON files
   */
  static async processJSON(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);

    // Convert JSON to readable text
    const textRepresentation = this.jsonToText(parsed);

    return {
      text: textRepresentation,
      metadata: {
        type: 'json',
        structure: this.getJsonStructure(parsed),
        wordCount: this.countWords(textRepresentation),
      },
    };
  }

  /**
   * Process images using OCR.
   *
   * Notes:
   * - We prefer the system `tesseract` binary when available (fast + uses system tessdata).
   * - `tesseract.js` is installed as a dependency, but it needs its own language-data setup.
   */
  static async processImage(filePath) {
    const filename = path.basename(filePath);
    const cmd = process.env.TESSERACT_CMD || process.env.TESSERACT_PATH || 'tesseract';
    const lang = (process.env.TESSERACT_LANG || 'eng').trim() || 'eng';
    const timeoutMs = parseInt(process.env.TESSERACT_TIMEOUT_MS || '30000', 10);

    try {
      // `tesseract <input> stdout -l eng` prints OCR text to stdout
      const { stdout } = await execFileAsync(
        cmd,
        [filePath, 'stdout', '-l', lang],
        {
          timeout: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
          maxBuffer: 10 * 1024 * 1024, // 10MB text output safety cap
        }
      );

      const text = String(stdout || '').trim();
      logger.info(`Image OCR completed for ${filePath} (lang=${lang}, chars=${text.length})`);

      // Even if OCR finds no text, return a stable placeholder without "not configured" noise.
      const finalText = text.length > 0
        ? text
        : `[Image file: ${filename}]\n\n(No text detected by OCR.)`;

      return {
        text: finalText,
        metadata: {
          type: 'image',
          filename,
          ocr: {
            engine: 'tesseract',
            cmd,
            lang,
            hadText: text.length > 0,
          },
          wordCount: this.countWords(finalText),
        },
      };
    } catch (error) {
      const message = error?.message || String(error);
      logger.warn(`Image OCR failed for ${filePath} (cmd=${cmd}, lang=${lang}): ${message}`);

      // Fallback: keep upload working, but avoid spamming "not configured" everywhere.
      return {
        text: `[Image file: ${filename}]\n\n(OCR failed: ${message})`,
        metadata: {
          type: 'image',
          filename,
          requiresOCR: true,
          ocr: {
            engine: 'tesseract',
            cmd,
            lang,
            error: message,
          },
        },
      };
    }
  }

  /**
   * Process audio files (placeholder; use process_media tool for transcription).
   */
  static async processAudio(filePath) {
    logger.info(`Audio document uploaded: ${filePath} (no text extraction during embedding)`);
    return {
      text: '',
      metadata: {
        type: 'audio',
        filename: path.basename(filePath),
        note: 'Use the process_media tool to transcribe audio.',
      },
    };
  }

  /**
   * Process video files (placeholder; use process_media tool for transcription/frames).
   */
  static async processVideo(filePath) {
    logger.info(`Video document uploaded: ${filePath} (no text extraction during embedding)`);
    return {
      text: '',
      metadata: {
        type: 'video',
        filename: path.basename(filePath),
        note: 'Use the process_media tool to transcribe video and extract/describe frames.',
      },
    };
  }

  /**
   * Convert JSON to readable text
   */
  static jsonToText(obj, prefix = '') {
    let text = '';

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        text += this.jsonToText(item, `${prefix}[${index}]`);
      });
    } else if (obj !== null && typeof obj === 'object') {
      for (const [key, value] of Object.entries(obj)) {
        const newPrefix = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'object' && value !== null) {
          text += this.jsonToText(value, newPrefix);
        } else {
          text += `${newPrefix}: ${value}\n`;
        }
      }
    } else {
      text += `${prefix}: ${obj}\n`;
    }

    return text;
  }

  /**
   * Get JSON structure summary
   */
  static getJsonStructure(obj, depth = 0) {
    if (depth > 3) return '...';

    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      return `[${this.getJsonStructure(obj[0], depth + 1)}] (${obj.length} items)`;
    } else if (obj !== null && typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (keys.length === 0) return '{}';
      return `{${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}}`;
    } else {
      return typeof obj;
    }
  }

  /**
   * Count words in text
   */
  static countWords(text) {
    if (!text) return 0;
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }

  /**
   * Get file extension from MIME type
   */
  static getExtensionFromMimeType(mimeType) {
    const mimeToExt = {
      'text/plain': '.txt',
      'text/markdown': '.md',
      'text/html': '.html',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'text/csv': '.csv',
      'application/json': '.json',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/mp4': '.m4a',
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
    };

    return mimeToExt[mimeType] || null;
  }

  /**
   * Check if file type is supported
   */
  static isSupported(fileType) {
    const supportedTypes = [
      'text/plain',
      'text/markdown',
      'text/html',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/json',
      'image/png',
      'image/jpeg',
      'audio/mpeg',
      'audio/wav',
      'audio/mp4',
      'video/mp4',
      'video/quicktime',
      'video/webm',
    ];

    return supportedTypes.includes(fileType);
  }

  /**
   * Get maximum file size in bytes
   */
  static getMaxFileSize() {
    return 50 * 1024 * 1024; // 50MB
  }
}

module.exports = DocumentProcessor;
