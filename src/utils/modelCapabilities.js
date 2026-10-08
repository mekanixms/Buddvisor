/**
 * Stored model capability flags. Values come from a Hugging Face or OpenRouter
 * fetch, or from the checkboxes in the agent editor. Nothing is inferred from
 * the provider or model id.
 */

const CAPABILITY_FLAG_KEYS = ['text', 'vision', 'audio', 'video', 'thinking', 'prompt_caching_hint'];

function emptyCapabilityFlags() {
  return {
    text: false,
    vision: false,
    audio: false,
    video: false,
    thinking: false,
    prompt_caching_hint: false,
  };
}

function parseStoredCapabilitiesJson(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a stored capability object. Missing or non-boolean flags are off.
 * @param {object|null} stored
 * @returns {object}
 */
function storedCapabilities(stored) {
  const flags = emptyCapabilityFlags();
  if (!stored || typeof stored !== 'object') return flags;

  for (const key of CAPABILITY_FLAG_KEYS) {
    if (typeof stored[key] === 'boolean') flags[key] = stored[key];
  }

  return {
    ...flags,
    source: stored.source,
    repo_id: stored.repo_id,
    hf_repo_id: stored.hf_repo_id || stored.repo_id,
    fetched_at: stored.fetched_at,
    pipeline_tag: stored.pipeline_tag,
    library_name: stored.library_name,
    tags_sample: stored.tags_sample,
    hf_runtime_hints: stored.hf_runtime_hints,
    openrouter_model_id: stored.openrouter_model_id,
    openrouter_runtime_hints: stored.openrouter_runtime_hints,
  };
}

module.exports = {
  CAPABILITY_FLAG_KEYS,
  emptyCapabilityFlags,
  parseStoredCapabilitiesJson,
  storedCapabilities,
};
