/**
 * Fetch model metadata from OpenRouter and map it to app capability flags.
 * @see https://openrouter.ai/docs/api/api-reference/models/get-models
 */

const axios = require('axios');
const logger = require('../../utils/logger');

const OPENROUTER_API = 'https://openrouter.ai/api/v1';

function normalizeOpenRouterModelId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('model_id is required');
  if (s.length > 240) throw new Error('model_id is too long');
  // OpenRouter model ids are typically like "google/gemini-2.5-pro" or "openai/gpt-4.1"
  if (!/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.\-:]+$/.test(s)) {
    throw new Error('model_id must look like author/slug (e.g. google/gemini-2.5-pro)');
  }
  return s;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

function mapOpenRouterModelToCapabilities(model) {
  const outputModalities = toStringArray(model.output_modalities || model.modalities || []);
  const supportedParams = toStringArray(model.supported_parameters || []);
  const defaults =
    model.default_parameters && typeof model.default_parameters === 'object' ? model.default_parameters : null;

  const idLower = String(model.id || '').toLowerCase();
  const nameLower = String(model.name || '').toLowerCase();
  const descLower = String(model.description || '').toLowerCase();

  const vision =
    outputModalities.includes('image') ||
    outputModalities.includes('images') ||
    supportedParams.includes('images') ||
    /\bvision\b|vl\b|multimodal|llava|pixtral|qwen.*vl|internvl|smolvlm/.test(idLower + ' ' + nameLower + ' ' + descLower);

  const audio =
    outputModalities.includes('audio') ||
    supportedParams.includes('audio') ||
    /\baudio\b|whisper|tts|speech/.test(idLower + ' ' + nameLower + ' ' + descLower);

  const text = outputModalities.includes('text') || (!vision && !audio);

  const runtimeHints = {
    context_length: numOrNull(model.context_length),
    default_parameters: defaults,
    supported_parameters: supportedParams.length ? supportedParams : null,
    output_modalities: outputModalities.length ? outputModalities : null,
  };

  const capabilities = {
    text: !!text,
    vision: !!vision,
    audio: !!audio,
    video: false,
    thinking: /\breasoning\b|r1|o1|think/.test(idLower + ' ' + nameLower),
    prompt_caching_hint: supportedParams.includes('prompt_cache') || supportedParams.includes('prompt_caching'),
    source: 'openrouter',
    openrouter_model_id: model.id || null,
    fetched_at: new Date().toISOString(),
    openrouter_runtime_hints: runtimeHints,
    // Keep some useful metadata (small / bounded)
    openrouter_name: model.name || null,
    openrouter_description: model.description ? String(model.description).slice(0, 500) : null,
    openrouter_pricing: model.pricing && typeof model.pricing === 'object' ? model.pricing : null,
  };

  return { capabilities, runtimeHints };
}

async function fetchOpenRouterModelCapabilities(modelIdInput) {
  const modelId = normalizeOpenRouterModelId(modelIdInput);
  const token = process.env.OPENROUTER_API_KEY || '';

  try {
    const response = await axios.get(`${OPENROUTER_API}/models`, {
      timeout: 20000,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      validateStatus: (s) => s === 200,
    });

    const data = response.data?.data;
    if (!Array.isArray(data)) {
      throw new Error('Unexpected response from OpenRouter models API');
    }

    const model = data.find((m) => m && typeof m === 'object' && String(m.id || '') === modelId);
    if (!model) {
      throw new Error(`Model not found on OpenRouter: ${modelId}`);
    }

    const { capabilities } = mapOpenRouterModelToCapabilities(model);
    const openrouter = {
      id: model.id,
      name: model.name || null,
      description: model.description || null,
      context_length: numOrNull(model.context_length),
      output_modalities: toStringArray(model.output_modalities || model.modalities || []),
      supported_parameters: toStringArray(model.supported_parameters || []),
      default_parameters:
        model.default_parameters && typeof model.default_parameters === 'object' ? model.default_parameters : null,
      pricing: model.pricing && typeof model.pricing === 'object' ? model.pricing : null,
      runtime_hints: capabilities.openrouter_runtime_hints || null,
    };

    return { capabilities, openrouter };
  } catch (error) {
    const msg = error.response?.data?.error || error.message;
    logger.warn(`[openrouter] fetch failed for ${modelId}: ${msg}`);
    if (error.response?.status === 401 || error.response?.status === 403) {
      throw new Error('OpenRouter rejected the request. Set OPENROUTER_API_KEY on the server if needed.');
    }
    throw new Error(typeof msg === 'string' ? msg : 'Failed to fetch model from OpenRouter');
  }
}

module.exports = {
  normalizeOpenRouterModelId,
  fetchOpenRouterModelCapabilities,
  mapOpenRouterModelToCapabilities,
};

