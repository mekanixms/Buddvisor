/**
 * Model capability hints for UI and tools (best-effort; actual support depends on provider integration).
 */

function inferModelCapabilities(providerType, modelId) {
  const t = String(providerType || '').toLowerCase();
  const m = String(modelId || '').toLowerCase();

  let vision = false;

  if (t === 'openai') {
    vision = m.includes('4o') || m.includes('vision');
  } else if (t === 'xai') {
    vision = m.includes('vision');
  } else if (t === 'gemini') {
    vision = true;
  } else if (t === 'claude') {
    vision = true;
  } else if (t === 'ollama') {
    vision =
      m.includes('vl') ||
      m.includes('vision') ||
      m.includes('llava') ||
      m.includes('moondream');
  } else if (t === 'kimi') {
    vision = m.includes('k2');
  }

  return {
    text: true,
    vision,
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
 * Merge HF/stored capabilities with heuristics from provider + local model id.
 * Explicit booleans in `stored` win over inferred values.
 */
function mergeWithStored(stored, inferred) {
  const inf = inferred || inferModelCapabilities(null, null);
  if (!stored || typeof stored !== 'object') {
    return { ...inf };
  }
  return {
    text: typeof stored.text === 'boolean' ? stored.text : inf.text,
    vision: typeof stored.vision === 'boolean' ? stored.vision : inf.vision,
    audio: typeof stored.audio === 'boolean' ? stored.audio : inf.audio,
    video: typeof stored.video === 'boolean' ? stored.video : inf.video,
    thinking: typeof stored.thinking === 'boolean' ? stored.thinking : inf.thinking,
    prompt_caching_hint:
      typeof stored.prompt_caching_hint === 'boolean'
        ? stored.prompt_caching_hint
        : inf.prompt_caching_hint,
    source: stored.source,
    repo_id: stored.repo_id,
    hf_repo_id: stored.hf_repo_id || stored.repo_id,
    fetched_at: stored.fetched_at,
    pipeline_tag: stored.pipeline_tag,
    library_name: stored.library_name,
    tags_sample: stored.tags_sample,
  };
}

module.exports = {
  inferModelCapabilities,
  parseStoredCapabilitiesJson,
  mergeWithStored,
};
