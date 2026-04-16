/**
 * Fetch public model metadata from the Hugging Face Hub API and map to app capability flags.
 * Optionally loads config.json / generation_config.json for context length and default generation params.
 * @see https://huggingface.co/docs/hub/en/api
 */

const path = require('path');
const axios = require('axios');
const logger = require('../../utils/logger');

const HF_API = 'https://huggingface.co/api/models';
const HF_ORIGIN = 'https://huggingface.co';

const VISION_PIPELINES = new Set([
  'image-text-to-text',
  'visual-question-answering',
  'image-to-text',
  'image-segmentation',
  'object-detection',
  'zero-shot-image-classification',
  'image-classification',
]);

const AUDIO_PIPELINES = new Set([
  'automatic-speech-recognition',
  'text-to-speech',
  'text-to-audio',
  'audio-to-audio',
  'audio-classification',
  'audio-text-to-text',
]);

const VIDEO_PIPELINES = new Set(['video-classification', 'video-text-to-text']);

const TEXT_PIPELINES = new Set([
  'text-generation',
  'text2text-generation',
  'translation',
  'summarization',
  'fill-mask',
  'question-answering',
  'conversational',
  'feature-extraction',
]);

/** Prefer these keys when inferring context / sequence length from config.json */
const CONTEXT_KEY_PRIORITY = [
  'max_position_embeddings',
  'model_max_length',
  'n_ctx',
  'max_seq_len',
  'seq_length',
  'max_sequence_length',
  'max_length',
];

/**
 * @param {string} input - org/model or full HF URL
 * @returns {string}
 */
function normalizeRepoId(input) {
  let s = String(input || '').trim();
  if (!s) {
    throw new Error('repo_id is required');
  }

  // Full model page or API URL: capture namespace/model (two path segments)
  const pageMatch = s.match(/huggingface\.co\/(?:api\/models\/)?([\w.-]+)\/([\w.-]+)(?:\/|$|\?|#)/i);
  if (pageMatch) {
    s = `${decodeURIComponent(pageMatch[1])}/${decodeURIComponent(pageMatch[2])}`;
  }

  s = s.replace(/^@+/, '').trim();

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)) {
    throw new Error(
      'repo_id must look like org/model (e.g. Qwen/Qwen2-VL-7B-Instruct or a huggingface.co model URL)'
    );
  }
  if (s.length > 200) {
    throw new Error('repo_id is too long');
  }
  return s;
}

/**
 * Build /api/models URL path (encode each segment; do not encode `/` as %2F).
 */
function modelsApiUrl(repoId) {
  const pathSegments = repoId.split('/').map((seg) => encodeURIComponent(seg));
  return `${HF_API}/${pathSegments.join('/')}`;
}

/**
 * Build raw file URL: https://huggingface.co/ns/name/raw/{revision}/file.json
 */
function rawFileUrl(repoId, revision, filename) {
  const [ns, name] = repoId.split('/');
  const rev = String(revision || 'main');
  const base = path.basename(String(filename || ''));
  if (!base || base === '.' || base === '..') {
    throw new Error('invalid raw filename');
  }
  return `${HF_ORIGIN}/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/raw/${encodeURIComponent(rev)}/${base}`;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickContextFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of CONTEXT_KEY_PRIORITY) {
    const n = numOrNull(obj[key]);
    if (n != null && n > 0) return { value: Math.floor(n), source: key };
  }
  return null;
}

/**
 * Extract context length from Transformers-style config.json (including nested blocks).
 */
function extractContextFromConfig(config) {
  if (!config || typeof config !== 'object') {
    return { context_length: null, context_source: null };
  }

  const nests = [
    config,
    config.text_config,
    config.llm_config,
    config.language_model_config,
    config.language_config,
    config.encoder_config,
    config.decoder_config,
    config.vision_config,
  ].filter(Boolean);

  for (const nest of nests) {
    const picked = pickContextFromObject(nest);
    if (picked) return { context_length: picked.value, context_source: picked.source };
  }

  return { context_length: null, context_source: null };
}

/**
 * Merge generation hints from generation_config.json and optional nested config.generation_config.
 */
function extractGenerationHints(configJson, generationConfigJson) {
  const fromFile = generationConfigJson && typeof generationConfigJson === 'object' ? generationConfigJson : {};
  const nested = configJson?.generation_config && typeof configJson.generation_config === 'object'
    ? configJson.generation_config
    : {};

  const g = { ...nested, ...fromFile };
  if (!Object.keys(g).length) {
    return {
      max_new_tokens: null,
      max_length: null,
      temperature: null,
      top_p: null,
      top_k: null,
      do_sample: null,
    };
  }

  return {
    max_new_tokens: numOrNull(g.max_new_tokens),
    max_length: numOrNull(g.max_length),
    temperature: numOrNull(g.temperature),
    top_p: numOrNull(g.top_p),
    top_k: numOrNull(g.top_k),
    do_sample: typeof g.do_sample === 'boolean' ? g.do_sample : null,
  };
}

async function fetchHubJson(url, token) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    validateStatus: (s) => s === 200,
  });
  return response.data;
}

/**
 * Try main then master; optional commit sha from model API works too.
 */
async function fetchConfigFiles(repoId, token, preferredRevision = null) {
  const revisions = [];
  if (preferredRevision && String(preferredRevision).trim()) {
    revisions.push(String(preferredRevision).trim());
  }
  revisions.push('main', 'master');

  const tried = new Set();
  let configJson = null;
  let generationConfigJson = null;
  let usedRevision = null;
  const filesLoaded = [];

  for (const rev of revisions) {
    if (tried.has(rev)) continue;
    tried.add(rev);

    try {
      const cfgUrl = rawFileUrl(repoId, rev, 'config.json');
      configJson = await fetchHubJson(cfgUrl, token);
      usedRevision = rev;
      filesLoaded.push(`config.json@${rev}`);
      break;
    } catch {
      configJson = null;
    }
  }

  if (!configJson) {
    return {
      configJson: null,
      generationConfigJson: null,
      revision: null,
      files_loaded: [],
    };
  }

  if (usedRevision) {
    try {
      const genUrl = rawFileUrl(repoId, usedRevision, 'generation_config.json');
      generationConfigJson = await fetchHubJson(genUrl, token);
      filesLoaded.push(`generation_config.json@${usedRevision}`);
    } catch {
      generationConfigJson = null;
    }
  }

  return {
    configJson,
    generationConfigJson,
    revision: usedRevision,
    files_loaded: filesLoaded,
  };
}

/**
 * Map HF /api/models JSON to stored capability object.
 * @param {object} api - Response body
 * @param {object} [runtimeHints] - hf_runtime_hints
 * @returns {object}
 */
function mapApiToCapabilities(api, runtimeHints = null) {
  const pipeline = String(api.pipeline_tag || '').toLowerCase();
  const tags = (api.tags || []).map((t) => String(t).toLowerCase());
  const tagStr = tags.join(' ');
  const idLower = String(api.id || '').toLowerCase();

  const vision =
    VISION_PIPELINES.has(pipeline) ||
    tagStr.includes('vision') ||
    tagStr.includes('image-to-text') ||
    tagStr.includes('multimodal') ||
    /\bvl\b|llava|pixtral|qwen2-vl|qwen3-vl|internvl|smolvlm/.test(idLower);

  const audio =
    AUDIO_PIPELINES.has(pipeline) ||
    tagStr.includes('whisper') ||
    tagStr.includes('speech') ||
    tagStr.includes('audio') ||
    /\bwhisper\b|wav2vec|speecht5/.test(idLower);

  const video =
    VIDEO_PIPELINES.has(pipeline) || tagStr.includes('video') || /video-llm|videollm/.test(idLower);

  const text =
    TEXT_PIPELINES.has(pipeline) ||
    tagStr.includes('llm') ||
    tagStr.includes('text-generation') ||
    (!vision && !audio && !video);

  const thinking =
    tagStr.includes('reasoning') ||
    tagStr.includes('chain-of-thought') ||
    /qwq|deepseek-r1|\br1\b|o1|think|reasoning/.test(idLower);

  const base = {
    text: !!text,
    vision: !!vision,
    audio: !!audio,
    video: !!video,
    thinking: !!thinking,
    prompt_caching_hint: false,
    source: 'huggingface',
    repo_id: api.id,
    fetched_at: new Date().toISOString(),
    pipeline_tag: api.pipeline_tag || null,
    library_name: api.library_name || null,
    tags_sample: (api.tags || []).slice(0, 40),
  };

  if (runtimeHints && typeof runtimeHints === 'object') {
    base.hf_runtime_hints = runtimeHints;
  }

  return base;
}

/**
 * @param {string} repoIdInput
 * @returns {Promise<{ capabilities: object, hf: object }>}
 */
async function fetchModelCapabilities(repoIdInput) {
  const repoId = normalizeRepoId(repoIdInput);
  const token = process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN || '';
  const url = modelsApiUrl(repoId);

  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      validateStatus: (s) => s === 200 || s === 404,
    });

    if (response.status === 404) {
      throw new Error(`Model not found on Hugging Face Hub: ${repoId}`);
    }

    const api = response.data;
    if (!api || typeof api !== 'object' || !api.id) {
      throw new Error('Unexpected response from Hugging Face API');
    }

    let runtimeHints = {
      context_length: null,
      context_source: null,
      max_new_tokens: null,
      max_length: null,
      temperature: null,
      top_p: null,
      top_k: null,
      do_sample: null,
      config_revision: null,
      config_files_loaded: [],
    };

    try {
      const sha = api.sha && String(api.sha).length >= 7 ? api.sha : null;
      const { configJson, generationConfigJson, revision, files_loaded } = await fetchConfigFiles(
        repoId,
        token,
        sha
      );

      if (configJson) {
        const ctx = extractContextFromConfig(configJson);
        runtimeHints.context_length = ctx.context_length;
        runtimeHints.context_source = ctx.context_source;
        runtimeHints.config_revision = revision;
        runtimeHints.config_files_loaded = files_loaded;

        const gen = extractGenerationHints(configJson, generationConfigJson);
        runtimeHints.max_new_tokens = gen.max_new_tokens;
        runtimeHints.max_length = gen.max_length;
        runtimeHints.temperature = gen.temperature;
        runtimeHints.top_p = gen.top_p;
        runtimeHints.top_k = gen.top_k;
        runtimeHints.do_sample = gen.do_sample;
      }
    } catch (cfgErr) {
      logger.warn(`[huggingface] optional config fetch failed for ${repoId}: ${cfgErr.message}`);
    }

    const capabilities = mapApiToCapabilities(api, runtimeHints);

    const hf = {
      id: api.id,
      pipeline_tag: api.pipeline_tag,
      library_name: api.library_name,
      likes: api.likes,
      downloads: api.downloads,
      tags_count: Array.isArray(api.tags) ? api.tags.length : 0,
      runtime_hints: capabilities.hf_runtime_hints || null,
    };

    return { capabilities, hf };
  } catch (error) {
    const msg = error.response?.data?.error || error.message;
    logger.warn(`[huggingface] fetch failed for ${repoId}: ${msg}`);
    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error(
        'Hugging Face rejected the request. Set HUGGINGFACE_API_KEY (or HF_TOKEN) for private or gated models.'
      );
    }
    throw new Error(typeof msg === 'string' ? msg : 'Failed to fetch model from Hugging Face');
  }
}

module.exports = {
  normalizeRepoId,
  fetchModelCapabilities,
  mapApiToCapabilities,
  modelsApiUrl,
  extractContextFromConfig,
  extractGenerationHints,
};
