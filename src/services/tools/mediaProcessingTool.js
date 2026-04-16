const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { toolRegistry } = require('./ToolRegistry');
const Document = require('../../models/Document');
const Agent = require('../../models/Agent');
const { decrypt } = require('../../utils/crypto');
const { getWorkspacePathForSessionAgent, getWorkspacePathForOrchestrator } = require('./localWorkingFolderTool');
const WorkSession = require('../../models/WorkSession');
const pdfParse = require('pdf-parse');
const MediaTranscriptionService = require('../documents/MediaTranscriptionService');
const VideoFrameExtractionService = require('../documents/VideoFrameExtractionService');
const PdfPageExtractionService = require('../documents/PdfPageExtractionService');
const logger = require('../../utils/logger');

const PROCESS_MEDIA_CACHE_DIR = '.process_media_cache';

function getProcessMediaCacheFilename(doc) {
  const hash = crypto.createHash('sha256').update(String(doc.content_hash || '')).digest('hex').slice(0, 12);
  return `${doc.id}_${hash}.json`;
}

async function writeProcessMediaCacheIfConfigured(workspacePath, doc, payload) {
  if (!workspacePath) return payload;
  try {
    const cacheDir = path.join(workspacePath, PROCESS_MEDIA_CACHE_DIR);
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, getProcessMediaCacheFilename(doc));
    const toWrite = { ...payload, cached_at: new Date().toISOString() };
    await fsPromises.writeFile(cachePath, JSON.stringify(toWrite, null, 0), 'utf-8');
    logger.info(`process_media cache written: ${doc.filename} -> ${cachePath}`);
    return { ...payload, cache_path: path.join(PROCESS_MEDIA_CACHE_DIR, getProcessMediaCacheFilename(doc)) };
  } catch (e) {
    logger.warn(`process_media cache write failed: ${e?.message || e}`);
    return payload;
  }
}

function normalizeFilename(name) {
  return String(name || '').trim().toLowerCase();
}

function getMimeFromPath(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return fallback;
}

function truncateString(value, maxChars) {
  if (typeof value !== 'string') return value;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + '…';
}

const {
  inferModelCapabilities,
  parseStoredCapabilitiesJson,
  mergeWithStored,
} = require('../../utils/modelCapabilities');

async function getAgentModelInfo(agentId) {
  if (!Number.isFinite(agentId)) return null;
  const agent = await Agent.findById(agentId);
  if (!agent) return null;

  let config = {};
  try {
    config = agent.provider_config ? JSON.parse(decrypt(agent.provider_config)) : {};
  } catch (e) {
    config = {};
  }

  const model = config.model || null;
  const inferred = inferModelCapabilities(agent.provider_type, model);
  const stored = parseStoredCapabilitiesJson(agent.model_capabilities);
  return {
    agentId: agent.id,
    agentName: agent.name,
    providerType: agent.provider_type,
    model,
    baseURL: config.baseURL || null,
    capabilities: mergeWithStored(stored, inferred),
  };
}

/**
 * Get model info for the session's orchestrator (provider + model + capabilities).
 * Used when process_media is invoked by the orchestrator (agentId null).
 */
async function getOrchestratorModelInfo(sessionId) {
  if (!Number.isFinite(sessionId)) return null;
  const session = await WorkSession.findById(sessionId);
  if (!session) return null;

  let config = {};
  try {
    config = session.orchestrator_provider_config
      ? JSON.parse(decrypt(session.orchestrator_provider_config))
      : {};
  } catch (e) {
    config = {};
  }

  const providerType = session.orchestrator_provider_type || 'claude';
  const model = config.model || null;
  return {
    agentId: null,
    agentName: 'Orchestrator',
    providerType,
    model,
    baseURL: config.baseURL || null,
    capabilities: inferModelCapabilities(providerType, model),
  };
}

async function analyzeImageWithOllama(imagePath, prompt, options = {}) {
  const {
    baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model = process.env.OLLAMA_VISION_MODEL || 'qwen3-vl',
    maxTokens = 800,
  } = options;

  const imageBase64 = fs.readFileSync(imagePath).toString('base64');

  const res = await fetch(`${baseURL.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: 'user',
          content: prompt,
          images: [imageBase64],
        },
      ],
      options: {
        num_predict: maxTokens,
      },
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error || j?.message || JSON.stringify(j);
    } catch {
      try {
        detail = await res.text();
      } catch {
        detail = '';
      }
    }
    throw new Error(`Ollama vision request failed (${res.status}): ${detail || res.statusText}`);
  }

  const data = await res.json();
  const text = (data?.message?.content || data?.response || '').trim();
  return { text, metadata: { model, provider: 'ollama', baseURL } };
}

async function analyzeImageWithOpenAI(imagePath, prompt, options = {}) {
  const {
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
    maxTokens = 800,
  } = options;

  if (!apiKey) {
    return {
      text: '',
      metadata: { error: 'OPENAI_API_KEY not configured', model },
    };
  }

  const mime = getMimeFromPath(imagePath, 'image/jpeg');
  const base64 = fs.readFileSync(imagePath).toString('base64');
  const client = new OpenAI({ apiKey });

  const resp = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    max_tokens: maxTokens,
  });

  const text = (resp.choices?.[0]?.message?.content || '').trim();
  return { text, metadata: { model, provider: 'openai' } };
}

async function analyzeImageWithGemini(imagePath, prompt, options = {}) {
  const {
    apiKey = process.env.GOOGLE_API_KEY,
    model = process.env.GEMINI_VISION_MODEL || 'gemini-1.5-flash',
    maxTokens = 800,
  } = options;

  if (!apiKey) {
    return {
      text: '',
      metadata: { error: 'GOOGLE_API_KEY not configured', model },
    };
  }

  const mime = getMimeFromPath(imagePath, 'image/jpeg');
  const base64 = fs.readFileSync(imagePath).toString('base64');

  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model });

  const result = await geminiModel.generateContent({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mime, data: base64 } },
        { text: prompt },
      ],
    }],
    generationConfig: { maxOutputTokens: maxTokens },
  });

  const text = (result?.response?.text?.() || '').trim();
  return { text, metadata: { model, provider: 'gemini' } };
}

async function analyzeImageWithKimi(imagePath, prompt, options = {}) {
  const {
    apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY,
    baseURL = process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
    model = process.env.KIMI_VISION_MODEL || 'kimi-k2-instruct',
    maxTokens = 800,
  } = options;

  if (!apiKey) {
    return {
      text: '',
      metadata: { error: 'KIMI_API_KEY or MOONSHOT_API_KEY not configured', model },
    };
  }

  const mime = getMimeFromPath(imagePath, 'image/jpeg');
  const base64 = fs.readFileSync(imagePath).toString('base64');

  const client = new OpenAI({
    apiKey,
    baseURL: baseURL.replace(/\/$/, ''),
  });

  const resp = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    max_tokens: maxTokens,
  });

  const text = (resp.choices?.[0]?.message?.content || '').trim();
  return { text, metadata: { model, provider: 'kimi' } };
}

function registerMediaProcessingTool() {
  toolRegistry.register({
    name: 'process_media',
    description:
      'Process an image/audio/video/PDF document (by filename) assigned to this session (or to this agent) in Configure Session → Documents. Images: vision description. Audio: transcript. Video: transcript + frame descriptions. PDF: extracted text (pdf-parse) + vision description of each page (requires pdftoppm/poppler). When local_working_folder is configured, results are cached there (.process_media_cache/) for quick reuse without reprocessing.',
    category: 'multimodal',
    parameters: {
      document_name: {
        type: 'string',
        description: 'Exact filename of the assigned document (as shown in Configure Session → Documents).',
        required: true,
        minLength: 1,
        maxLength: 500,
      },
      instruction: {
        type: 'string',
        description:
          'What you want extracted (e.g. "extract all text", "summarize", "describe the screenshot", "list UI errors"). If omitted, a sensible default is used.',
        required: false,
        maxLength: 2000,
      },
      max_output_chars: {
        type: 'number',
        description: 'Maximum characters to return across all text fields (default: 20000).',
        required: false,
        minimum: 1000,
        maximum: 200000,
      },
      max_video_frames: {
        type: 'number',
        description: 'Maximum video frames to sample for description (default: 6).',
        required: false,
        minimum: 1,
        maximum: 12,
      },
      max_pdf_pages: {
        type: 'number',
        description: 'Maximum PDF pages to render and describe with vision (default: 10). Only used for PDFs.',
        required: false,
        minimum: 1,
        maximum: 50,
      },
    },
    handler: async (params, context) => {
      const { document_name, instruction, max_output_chars = 20000, max_video_frames = 6, max_pdf_pages = 10 } = params || {};
      const sessionId = context?.sessionId;
      const agentId = context?.agentId;

      if (!Number.isFinite(sessionId)) {
        return {
          error: 'process_media requires sessionId in context.',
        };
      }

      const isOrchestrator = agentId == null || !Number.isFinite(agentId);
      let assignedDocs;
      let workspacePath;
      let agentInfo;

      if (isOrchestrator) {
        assignedDocs = await Document.getBySession(sessionId);
        workspacePath = await getWorkspacePathForOrchestrator(sessionId);
        agentInfo = await getOrchestratorModelInfo(sessionId);
      } else {
        const hasPerAgentAssignments = await Document.hasAgentAssignments(sessionId);
        if (!hasPerAgentAssignments) {
          return {
            error:
              'No per-agent document assignments are configured for this session yet. Open Configure Session → Documents, assign the document to this agent, and click Save.',
          };
        }
        assignedDocs = await Document.getBySessionAndAgent(sessionId, agentId);
        workspacePath = await getWorkspacePathForSessionAgent(sessionId, agentId);
        agentInfo = await getAgentModelInfo(agentId);
      }

      const wanted = normalizeFilename(document_name);
      const doc = assignedDocs.find(d => normalizeFilename(d.filename) === wanted);

      if (!doc) {
        return {
          error: isOrchestrator
            ? `Document "${document_name}" is not assigned to this session. Use a filename from Configure Session → Documents.`
            : `Document "${document_name}" is not assigned to this agent in this session.`,
          available_documents_for_agent: assignedDocs.map(d => d.filename).slice(0, 50),
          note: isOrchestrator
            ? 'Assign the document to the session in Configure Session → Documents, then use the exact filename.'
            : 'Assign the document to this agent in Configure Session → Documents, then ask again using the exact filename.',
        };
      }

      const caps = agentInfo?.capabilities || null;
      const modelHint =
        agentInfo?.model
          ? `${agentInfo.providerType}:${agentInfo.model}`
          : (agentInfo?.providerType || null);

      const fileType = doc.file_type || getMimeFromPath(doc.file_path);
      const filePath = path.isAbsolute(doc.file_path)
        ? doc.file_path
        : path.resolve(process.cwd(), doc.file_path || '');

      if (!filePath || !fs.existsSync(filePath)) {
        return { error: 'Document file is missing on disk.', document: { id: doc.id, filename: doc.filename } };
      }
      const cacheRelativePath = path.join(PROCESS_MEDIA_CACHE_DIR, getProcessMediaCacheFilename(doc));
      if (workspacePath) {
        const cachePath = path.join(workspacePath, cacheRelativePath);
        try {
          if (fs.existsSync(cachePath)) {
            const cached = JSON.parse(await fsPromises.readFile(cachePath, 'utf-8'));
            logger.info(`process_media cache hit: ${doc.filename}`);
            return {
              ...cached,
              from_cache: true,
              cache_path: cacheRelativePath,
            };
          }
        } catch (e) {
          logger.warn(`process_media cache read failed: ${e?.message || e}`);
        }
      }

      if (String(fileType).startsWith('image/')) {
        const prompt =
          instruction?.trim() ||
          'Describe this image in detail. If it contains text, extract ALL text verbatim. If it is a UI screenshot, call out errors/warnings and key UI elements.';

        let vision;
        if (agentInfo?.providerType === 'gemini' && caps?.vision) {
          const model = agentInfo?.model || process.env.GEMINI_VISION_MODEL || 'gemini-1.5-flash';
          vision = await analyzeImageWithGemini(filePath, prompt, { model, maxTokens: 800 });
        } else if (agentInfo?.providerType === 'kimi' && caps?.vision) {
          const baseURL = agentInfo?.baseURL || process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL;
          const model = agentInfo?.model || process.env.KIMI_VISION_MODEL || 'kimi-k2-instruct';
          vision = await analyzeImageWithKimi(filePath, prompt, { baseURL, model, maxTokens: 800 });
        } else if (agentInfo?.providerType === 'ollama' && caps?.vision) {
          // Use the agent's local Ollama vision model (e.g. qwen3-vl) when available.
          const baseURL = agentInfo?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
          const model = agentInfo?.model || process.env.OLLAMA_VISION_MODEL || 'qwen3-vl';
          vision = await analyzeImageWithOllama(filePath, prompt, { baseURL, model, maxTokens: 800 });
        } else {
          // Fallback to OpenAI vision if configured.
          vision = await analyzeImageWithOpenAI(filePath, prompt);
        }

        const warning =
          caps && caps.vision === false
            ? 'Note: this agent model appears text-only; media understanding is being performed via the tool.'
            : null;

        const imagePayload = {
          document: { id: doc.id, filename: doc.filename, file_type: fileType },
          agent_model: modelHint,
          warning,
          result: {
            text: truncateString(vision.text, max_output_chars),
            metadata: vision.metadata,
          },
        };
        return await writeProcessMediaCacheIfConfigured(workspacePath, doc, imagePayload);
      }

      if (String(fileType).startsWith('audio/')) {
        const transcript = await MediaTranscriptionService.transcribeAudioWithWhisper(filePath);
        const audioPayload = {
          document: { id: doc.id, filename: doc.filename, file_type: fileType },
          agent_model: modelHint,
          result: {
            transcript: truncateString(transcript.text, max_output_chars),
            metadata: transcript.metadata,
          },
        };
        return await writeProcessMediaCacheIfConfigured(workspacePath, doc, audioPayload);
      }

      if (String(fileType).startsWith('video/')) {
        // 1) Transcribe
        const transcript = await MediaTranscriptionService.transcribeVideoWithWhisper(filePath);

        // 2) Sample frames and describe each
        let framesTmpDir = null;
        let frames = [];
        try {
          const extracted = await VideoFrameExtractionService.extractFrames(filePath, { maxFrames: max_video_frames });
          framesTmpDir = extracted.tmpDir;
          frames = extracted.frames || [];

          const framePrompt =
            instruction?.trim() ||
            'Describe what is happening in this video frame. If there is on-screen text, extract it verbatim. If it is a UI/video slide, describe key elements.';

          const frameDescriptions = [];
          for (const framePath of frames) {
            let r;
            if (agentInfo?.providerType === 'gemini' && caps?.vision) {
              const model = agentInfo?.model || process.env.GEMINI_VISION_MODEL || 'gemini-1.5-flash';
              r = await analyzeImageWithGemini(framePath, framePrompt, { model, maxTokens: 500 });
            } else if (agentInfo?.providerType === 'kimi' && caps?.vision) {
              const baseURL = agentInfo?.baseURL || process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL;
              const model = agentInfo?.model || process.env.KIMI_VISION_MODEL || 'kimi-k2-instruct';
              r = await analyzeImageWithKimi(framePath, framePrompt, { baseURL, model, maxTokens: 500 });
            } else if (agentInfo?.providerType === 'ollama' && caps?.vision) {
              const baseURL = agentInfo?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
              const model = agentInfo?.model || process.env.OLLAMA_VISION_MODEL || 'qwen3-vl';
              r = await analyzeImageWithOllama(framePath, framePrompt, { baseURL, model, maxTokens: 500 });
            } else {
              r = await analyzeImageWithOpenAI(framePath, framePrompt, { maxTokens: 500 });
            }
            frameDescriptions.push({
              frame: path.basename(framePath),
              description: r.text,
            });
          }

          const warning =
            caps && caps.vision === false
              ? 'Note: this agent model appears text-only; video frame understanding is being performed via the tool.'
              : null;

          const videoPayload = {
            document: { id: doc.id, filename: doc.filename, file_type: fileType },
            agent_model: modelHint,
            warning,
            result: {
              transcript: truncateString(transcript.text, max_output_chars),
              frames: frameDescriptions.map(fd => ({
                ...fd,
                description: truncateString(fd.description, Math.max(2000, Math.floor(max_output_chars / Math.max(1, frameDescriptions.length)))),
              })),
              metadata: {
                transcript: transcript.metadata,
                frames_extracted: frames.length,
              },
            },
          };
          return await writeProcessMediaCacheIfConfigured(workspacePath, doc, videoPayload);
        } catch (e) {
          logger.warn(`process_media video processing failed: ${e?.message || e}`);
          return {
            document: { id: doc.id, filename: doc.filename, file_type: fileType },
            agent_model: modelHint,
            result: {
              transcript: truncateString(transcript.text, max_output_chars),
              metadata: {
                transcript: transcript.metadata,
                frame_extraction_error: e?.message || String(e),
              },
            },
          };
        } finally {
          if (framesTmpDir) {
            await VideoFrameExtractionService.cleanup(framesTmpDir);
          }
        }
      }

      const isPdf =
        String(fileType) === 'application/pdf' ||
        path.extname(filePath || '').toLowerCase() === '.pdf';
      if (isPdf) {
        let pdfText = '';
        let pdfMetadata = { pages: 0 };
        const pdfParseTimeoutMs = Number(process.env.PDF_PARSE_TIMEOUT_MS) || 90 * 1000; // 90s default
        try {
          const dataBuffer = await fs.promises.readFile(filePath);
          const data = await Promise.race([
            pdfParse(dataBuffer),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('pdf-parse timeout')), pdfParseTimeoutMs)
            ),
          ]);
          pdfText = (data.text || '').trim();
          pdfMetadata = { pages: data.numpages || 0, info: data.info };
        } catch (e) {
          logger.warn(`process_media PDF text extraction failed: ${e?.message || e}`);
        }

        let pageDescriptions = [];
        let pdfPagesTmpDir = null;
        let imageExtractionNote = null;
        const pdfVisionTimeoutMs = Number(process.env.PDF_VISION_TIMEOUT_MS) || 5 * 60 * 1000; // 5 min total for all page vision calls
        try {
          const extracted = await PdfPageExtractionService.extractPages(filePath, {
            maxPages: max_pdf_pages,
          });
          pdfPagesTmpDir = extracted.tmpDir;
          const pagePrompt =
            instruction?.trim() ||
            'Describe this PDF page. If it contains text, extract ALL text verbatim. If it has diagrams or figures, describe them.';

          const visionStart = Date.now();
          for (const pagePath of extracted.frames) {
            if (Date.now() - visionStart > pdfVisionTimeoutMs) {
              imageExtractionNote =
                `Vision time budget (${Math.round(pdfVisionTimeoutMs / 1000)}s) reached; only first ${pageDescriptions.length} pages were described. Increase PDF_VISION_TIMEOUT_MS if needed.`;
              logger.warn(`process_media PDF vision timeout after ${pageDescriptions.length} pages`);
              break;
            }
            let r;
            try {
              if (agentInfo?.providerType === 'gemini' && caps?.vision) {
                const model = agentInfo?.model || process.env.GEMINI_VISION_MODEL || 'gemini-1.5-flash';
                r = await analyzeImageWithGemini(pagePath, pagePrompt, { model, maxTokens: 600 });
              } else if (agentInfo?.providerType === 'kimi' && caps?.vision) {
                const baseURL = agentInfo?.baseURL || process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL;
                const model = agentInfo?.model || process.env.KIMI_VISION_MODEL || 'kimi-k2-instruct';
                r = await analyzeImageWithKimi(pagePath, pagePrompt, { baseURL, model, maxTokens: 600 });
              } else if (agentInfo?.providerType === 'ollama' && caps?.vision) {
                const baseURL = agentInfo?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
                const model = agentInfo?.model || process.env.OLLAMA_VISION_MODEL || 'qwen3-vl';
                r = await analyzeImageWithOllama(pagePath, pagePrompt, { baseURL, model, maxTokens: 600 });
              } else {
                r = await analyzeImageWithOpenAI(pagePath, pagePrompt, { maxTokens: 600 });
              }
            } catch (pageErr) {
              logger.warn(`process_media PDF page ${pageDescriptions.length + 1} vision failed: ${pageErr?.message || pageErr}`);
              r = { text: `[Page description failed: ${pageErr?.message || pageErr}]` };
            }
            const pageNum = pageDescriptions.length + 1;
            pageDescriptions.push({
              page: pageNum,
              file: path.basename(pagePath),
              description: r?.text ?? '',
            });
          }

          if (!imageExtractionNote && extracted.pageCount > max_pdf_pages) {
            imageExtractionNote = `Only first ${max_pdf_pages} of ${extracted.pageCount} pages were described (max_pdf_pages).`;
          }
        } catch (e) {
          logger.warn(`process_media PDF page image extraction failed: ${e?.message || e}`);
          imageExtractionNote =
            'Page image extraction was skipped (pdftoppm may be missing; install poppler-utils or poppler to enable vision on PDF pages).';
        } finally {
          if (pdfPagesTmpDir) {
            await PdfPageExtractionService.cleanup(pdfPagesTmpDir);
          }
        }

        const warning =
          caps && caps.vision === false
            ? 'Note: this agent model appears text-only; PDF page understanding is being performed via the tool.'
            : null;

        const pageDescTruncated = pageDescriptions.map(pd => ({
          ...pd,
          description: truncateString(
            pd.description,
            Math.max(1500, Math.floor(max_output_chars / Math.max(1, pageDescriptions.length)))
          ),
        }));

        const pdfPayload = {
          document: { id: doc.id, filename: doc.filename, file_type: fileType },
          agent_model: modelHint,
          warning,
          result: {
            pdf_text: truncateString(pdfText, Math.max(5000, Math.floor(max_output_chars / 2))),
            pdf_metadata: pdfMetadata,
            page_descriptions: pageDescTruncated,
            page_count: pageDescriptions.length,
            image_extraction_note: imageExtractionNote || undefined,
            metadata: {
              pdf_pages: pdfMetadata.pages,
              pages_described: pageDescriptions.length,
            },
          },
        };
        return await writeProcessMediaCacheIfConfigured(workspacePath, doc, pdfPayload);
      }

      return {
        error: `Unsupported media type for process_media: ${fileType}`,
        supported_prefixes: ['image/', 'audio/', 'video/', 'application/pdf'],
        document: { id: doc.id, filename: doc.filename, file_type: fileType },
      };
    },
    examples: [
      {
        description: 'Describe an assigned screenshot',
        parameters: { document_name: 'Screenshot from 2026-01-11 13-48-58.png', instruction: 'Describe what this screenshot shows and extract all text.' },
      },
      {
        description: 'Transcribe an assigned audio file',
        parameters: { document_name: 'meeting.m4a', instruction: 'Transcribe and summarize key action items.' },
      },
      {
        description: 'Process an assigned PDF (text + vision per page)',
        parameters: { document_name: 'report.pdf', instruction: 'Extract all text and describe each page including any figures.', max_pdf_pages: 10 },
      },
    ],
    requiresAuth: true,
    // Longer timeout for PDF/video (vision per page/frame) and transcription
    executionTimeout: Number(process.env.PROCESS_MEDIA_TOOL_TIMEOUT_MS) || 5 * 60 * 1000, // 5 min default
  });

  logger.info('process_media tool registered');
}

/**
 * Get list of assigned documents that have a process_media cache in the agent's workspace.
 * Used to inject "processed and cached at path" into agent context.
 * @param {number} sessionId - Session ID
 * @param {number} agentId - Agent ID
 * @returns {Promise<Array<{ filename: string, cacheRelativePath: string }>>}
 */
async function getProcessedMediaCacheInfo(sessionId, agentId) {
  if (!Number.isFinite(sessionId) || !Number.isFinite(agentId)) return [];
  try {
    const workspacePath = await getWorkspacePathForSessionAgent(sessionId, agentId);
    if (!workspacePath) return [];
    const assignedDocs = await Document.getBySessionAndAgent(sessionId, agentId);
    const result = [];
    for (const doc of assignedDocs) {
      const cacheRelativePath = path.join(PROCESS_MEDIA_CACHE_DIR, getProcessMediaCacheFilename(doc));
      const cachePath = path.join(workspacePath, cacheRelativePath);
      if (fs.existsSync(cachePath)) {
        result.push({ filename: doc.filename, cacheRelativePath });
      }
    }
    return result;
  } catch (e) {
    logger.warn(`getProcessedMediaCacheInfo failed: ${e?.message || e}`);
    return [];
  }
}

module.exports = { registerMediaProcessingTool, getProcessedMediaCacheInfo };

