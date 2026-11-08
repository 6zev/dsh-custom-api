import fs from 'node:fs';
import path from 'node:path';

/**
 * Plugin: dsh-custom-api
 * Tự động phát hiện model từ Custom API (OpenAI/Anthropic compatible),
 * kết hợp API Endpoint Metadata, models.dev và bộ quy chuẩn Reasoning Ladder theo từng hãng (vendor).
 * Giải quyết triệt để lỗi "không hỗ trợ reasoning effort" khi chuyển mức độ suy nghĩ.
 */

export const name = 'dsh-custom-api';
export const inject = ['llm', 'tools', 'commands', 'configEditor'];

const CACHE_PATH = '/root/.dsh/storages/models-dev-cache.json';
const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export const DEFAULT_CONTEXT_WINDOW = 262144;
export const DEFAULT_MAX_TOKENS = 32768;

/**
 * Các provider chính thống được ưu tiên lấy metadata chuẩn nhất trong models.dev
 */
const PREFERRED_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'zhipuai',
  'z-ai',
  'alibaba',
  'moonshotai',
  'minimax',
  'mistral',
]);

/** Model id chỉ sinh ảnh (image generation), không phải chat model */
const IMAGE_MODEL_ID = /(^|[-_.])(image|imagine)([-_.]|$)/i;

/** Cụm từ mô tả chắc chắn hỗ trợ Vision */
const VISION_DESCRIPTION =
  /\b(vision|visual|multimodal|image input|input images?|accepts? images?|image understanding|image reasoning|text and image)\b/i;

/** Cụm từ mô tả chắc chắn là text-only (bản finetune bỏ vision) */
const TEXT_ONLY_DESCRIPTION = /\btext[- ]only\b|\btext input\b/i;

/** Model ID và từ khóa biểu thị Thinking / Reasoning */
const THINKING_MODEL_ID = /(^|[-_.])(thinking|reasoner|r1|o1|o3|o4|qwq|qvq)([-_.]|$)/i;
const THINKING_DESCRIPTION =
  /\b(thinking|reasoning|reasoner|thought|chain[- ]of[- ]thought|deep thinking)\b/i;

/**
 * Reasoning Ladder chuẩn hóa theo từng hãng từ tài liệu API chính thức:
 * Bao gồm đầy đủ 'off' và các nấc 'low', 'medium', 'high', 'max' để người dùng
 * chuyển bất kỳ nấc nào trên giao diện cũng KHÔNG bao giờ bị báo lỗi "không hỗ trợ".
 */
const FAMILY_EFFORTS = Object.freeze({
  deepseek: { off: 'none', low: 'low', medium: 'high', high: 'high', max: 'max' },
  openai: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  gemini: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
  claude: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  grok: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
  glm: { off: 'none', low: 'high', medium: 'high', high: 'high', max: 'max' },
  qwen: { off: null, low: 'high', medium: 'high', high: 'high' },
  other: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
});

const GEMINI_LEVELS = Object.freeze({
  'gemini-4-argon': ['low', 'medium', 'high'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.5-flash-lite': ['minimal', 'low', 'medium', 'high'],
  'gemini-3.1-pro-preview': ['low', 'medium', 'high'],
  'gemini-3.1-flash-lite-image': ['minimal', 'high'],
  'gemini-3-flash-preview': ['minimal', 'low', 'medium', 'high'],
  'gemini-3-pro-preview': ['low', 'high'],
  'gemini-2.5-pro': ['low', 'medium', 'high'],
  'gemini-2.5-flash': ['low', 'medium', 'high'],
  'gemini-2.5-flash-lite': ['low', 'medium', 'high'],
  'gemini-2.0-flash-thinking': ['low', 'medium', 'high'],
});

function geminiEfforts(id) {
  const norm = String(id).toLowerCase();
  const documented = GEMINI_LEVELS[norm] || ['low', 'medium', 'high'];
  const efforts = { off: null };
  for (const level of documented) efforts[level] = level;
  if (!efforts.medium) efforts.medium = efforts.high || 'medium';
  if (!efforts.low) efforts.low = efforts.medium || 'low';
  return efforts;
}

export function normalizeModelId(id) {
  const tail = String(id).toLowerCase().split('/').pop() || '';
  return tail
    .replace(/[._]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// In-memory models.dev index
let exactIndex = new Map();
let normalizedIndex = new Map();
let rawModelsDevData = null;
let isLoaded = false;

function pickBest(candidates) {
  let best = undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    let score = 0;
    if (Array.isArray(candidate.modalities?.input) && candidate.modalities.input.length > 0) score += 4;
    if (Number.isFinite(candidate.limit?.context) && candidate.limit.context > 0) score += 2;
    if (Number.isFinite(candidate.limit?.output) && candidate.limit.output > 0) score += 1;
    if (typeof candidate.reasoning === 'boolean') score += 1;
    if (PREFERRED_PROVIDERS.has(candidate.provider)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function buildModelsDevIndex(data) {
  rawModelsDevData = data;
  exactIndex = new Map();
  normalizedIndex = new Map();

  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider || typeof provider.models !== 'object') continue;
    for (const [mId, mData] of Object.entries(provider.models || {})) {
      if (!mData || typeof mData !== 'object') continue;
      const record = { ...mData, provider: providerId, modelId: mId };

      if (!exactIndex.has(mId)) exactIndex.set(mId, []);
      exactIndex.get(mId).push(record);

      const norm = normalizeModelId(mId);
      if (!normalizedIndex.has(norm)) normalizedIndex.set(norm, []);
      normalizedIndex.get(norm).push(record);
    }
  }
  isLoaded = true;
}

async function initModelsDevDatabase(logger) {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const content = fs.readFileSync(CACHE_PATH, 'utf8');
      const data = JSON.parse(content);
      buildModelsDevIndex(data);
      logger?.info(`models.dev index loaded from cache: ${exactIndex.size} model keys`);
    }
  } catch (err) {
    logger?.warn(`Failed to read models.dev cache: ${err.message}`);
  }

  // Tự động kiểm tra làm mới cache nền
  try {
    let shouldFetch = !fs.existsSync(CACHE_PATH);
    if (!shouldFetch) {
      const stat = fs.statSync(CACHE_PATH);
      if (Date.now() - stat.mtimeMs > MODELS_DEV_TTL_MS) shouldFetch = true;
    }

    if (shouldFetch) {
      fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(15000) })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => {
          fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
          fs.writeFileSync(CACHE_PATH, JSON.stringify(data), 'utf8');
          buildModelsDevIndex(data);
          logger?.info('models.dev database refreshed from online registry');
        })
        .catch((err) => {
          logger?.warn(`models.dev background refresh skipped: ${err.message}`);
        });
    }
  } catch (err) {
    logger?.warn(`models.dev init error: ${err.message}`);
  }
}

function lookupModelsDev(id) {
  if (!isLoaded || !id) return null;
  const exact = exactIndex.get(id);
  if (exact && exact.length > 0) return { ...pickBest(exact), matchType: 'exact' };

  const norm = normalizeModelId(id);
  const normalized = normalizedIndex.get(norm);
  if (normalized && normalized.length > 0) return { ...pickBest(normalized), matchType: 'normalized' };

  // Fuzzy Token Overlap
  if (rawModelsDevData) {
    const tokens = id.toLowerCase().split(/[-_./:]/).filter((t) => t.length >= 3);
    if (tokens.length >= 1) {
      for (const [pId, p] of Object.entries(rawModelsDevData)) {
        for (const [mId, mData] of Object.entries(p.models || {})) {
          const ms = mId.toLowerCase();
          const matchedCount = tokens.filter((t) => ms.includes(t)).length;
          if (matchedCount >= 2 || (tokens.length === 1 && ms.includes(tokens[0]))) {
            return {
              ...mData,
              modelId: mId,
              provider: pId,
              matchType: 'fuzzy',
              matchedFrom: mId,
            };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Trích xuất trực tiếp capabilities từ API Endpoint Metadata
 */
function extractFromApiMetadata(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const result = {};

  if (
    raw.modalities?.input?.includes('image') ||
    raw.input_modalities?.includes('image') ||
    (typeof raw.architecture?.modality === 'string' && raw.architecture.modality.includes('image')) ||
    raw.supports_vision === true ||
    raw.capabilities?.vision === true ||
    raw.features?.includes('vision') ||
    raw.model_info?.supports_vision === true ||
    raw.attachment === true
  ) {
    result.vision = true;
  }

  if (
    raw.tool_call === true ||
    raw.supports_function_calling === true ||
    raw.capabilities?.tools === true ||
    raw.features?.includes('tools') ||
    raw.supported_parameters?.includes('tools') ||
    raw.supported_parameters?.includes('tool_choice')
  ) {
    result.toolCall = true;
  }

  if (
    raw.supports_thinking === true ||
    raw.reasoning === true ||
    (Array.isArray(raw.reasoning_options) && raw.reasoning_options.length > 0) ||
    raw.capabilities?.reasoning === true ||
    raw.features?.includes('reasoning') ||
    raw.features?.includes('thinking') ||
    raw.supported_parameters?.includes('reasoning') ||
    raw.supported_parameters?.includes('include_reasoning') ||
    raw.supported_parameters?.includes('reasoning_effort')
  ) {
    result.reasoning = true;
  }

  const context =
    raw.context_length ||
    raw.context_window ||
    raw.contextWindow ||
    raw.max_input_tokens ||
    raw.max_model_len ||
    raw.limit?.context;

  if (typeof context === 'number' && Number.isFinite(context) && context > 0) {
    result.contextWindow = context;
  }

  const output =
    raw.max_output_tokens ||
    raw.max_completion_tokens ||
    raw.maxTokens ||
    raw.max_tokens ||
    raw.limit?.output ||
    raw.top_provider?.max_completion_tokens;

  if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
    result.maxTokens = output;
  }

  return result;
}

/**
 * Nhận diện Family của model (theo chuẩn dc-ai-api)
 */
function identifyModelFamily(id, dev) {
  const s = String(id).toLowerCase();
  const provider = String(dev?.provider || '').toLowerCase();

  if (s.includes('deepseek') || s.startsWith('r1') || s.includes('-r1') || provider === 'deepseek') {
    return 'deepseek';
  }
  if (
    s.startsWith('gpt-') ||
    s.includes('-gpt-') ||
    s.startsWith('o1') ||
    s.startsWith('o3') ||
    s.startsWith('o4') ||
    provider === 'openai'
  ) {
    return 'openai';
  }
  if (s.includes('gemini') || provider === 'google') return 'gemini';
  if (s.includes('claude') || provider === 'anthropic') return 'claude';
  if (s.includes('grok') || provider === 'xai') return 'grok';
  if (s.includes('glm') || provider === 'zhipuai' || provider === 'z-ai') return 'glm';
  if (s.includes('qwen') || provider === 'alibaba') return 'qwen';

  return 'other';
}

/**
 * Xác định Reasoning Efforts chuẩn hóa
 */
function determineReasoningEfforts(id, model, dev, forceThinking) {
  let isThinking = forceThinking;
  if (!isThinking) {
    if (typeof model?.supports_thinking === 'boolean') isThinking = model.supports_thinking;
    else if (dev?.reasoning === true) isThinking = true;
    else if (THINKING_MODEL_ID.test(String(id))) isThinking = true;
    else {
      const desc = typeof model?.description === 'string' ? model.description : '';
      isThinking = THINKING_DESCRIPTION.test(desc);
    }
  }

  if (!isThinking) return false;

  const family = identifyModelFamily(id, dev);
  if (family === 'gemini') return geminiEfforts(id);
  return { ...FAMILY_EFFORTS[family] };
}

/**
 * Phát hiện Vision (Image Input)
 */
function determineVision(id, model, dev, forceVision) {
  if (forceVision) return true;
  const desc = typeof model?.description === 'string' ? model.description : '';
  if (TEXT_ONLY_DESCRIPTION.test(desc)) return false;

  const inputs = dev?.modalities?.input;
  if (Array.isArray(inputs) && inputs.length > 0) {
    return inputs.includes('image');
  }

  if (dev?.attachment === true) return true;
  if (VISION_DESCRIPTION.test(desc)) return true;

  // Fallback pattern matching
  const s = String(id).toLowerCase();
  return (
    s.includes('vision') ||
    s.includes('vl') ||
    s.includes('4o') ||
    s.includes('4-turbo') ||
    s.includes('gemini') ||
    s.includes('claude') ||
    s.includes('pixtral') ||
    s.includes('llava') ||
    s.includes('omni') ||
    s.includes('internvl') ||
    s.includes('multimodal')
  );
}

/**
 * Kiểm tra model có phải thuần Image generation không (không chat được)
 */
function isImageGenerationEndpoint(id, dev) {
  if (IMAGE_MODEL_ID.test(String(id))) return true;
  const output = dev?.modalities?.output;
  return Array.isArray(output) && output.length > 0 && output.every((m) => m !== 'text');
}

/**
 * Giải quyết và gán năng lực hoàn chỉnh cho một model
 */
function resolveCapabilities(rawModel, opts = {}) {
  const id = typeof rawModel === 'string' ? rawModel : rawModel.id;
  const dev = lookupModelsDev(id);
  const apiMeta = extractFromApiMetadata(rawModel);

  const isImageEndpoint = isImageGenerationEndpoint(id, dev);
  const hasVision = determineVision(id, rawModel, dev, opts.forceVision);
  const reasoningEfforts = determineReasoningEfforts(id, rawModel, dev, opts.forceThinking);

  // Tool calls
  const hasToolCall = !isImageEndpoint && (apiMeta.toolCall !== false && dev?.tool_call !== false);

  // Context window & Output limit
  const contextWindow =
    apiMeta.contextWindow ||
    (typeof rawModel === 'object' && rawModel.contextWindow) ||
    dev?.limit?.context ||
    DEFAULT_CONTEXT_WINDOW;

  const rawMaxTokens =
    apiMeta.maxTokens ||
    (typeof rawModel === 'object' && rawModel.maxTokens) ||
    dev?.limit?.output ||
    DEFAULT_MAX_TOKENS;

  // Clamp maxTokens vào contextWindow (tránh lỗi provider từ chối)
  const maxTokens = Math.min(rawMaxTokens, contextWindow);

  const name =
    (typeof rawModel === 'object' && (rawModel.name || rawModel.display_name)) ||
    dev?.name ||
    id;

  const modelEntry = {
    id,
    name,
    contextWindow,
    maxTokens,
    input: hasVision ? ['text', 'image'] : ['text'],
    reasoningEfforts: reasoningEfforts ? reasoningEfforts : false,
  };

  const apiProtocol = opts.api || 'openai-completions';
  if (reasoningEfforts && apiProtocol === 'openai-completions') {
    const s = id.toLowerCase();
    const isDeepSeek = s.includes('deepseek') || s.includes('r1');
    modelEntry.compat = {
      supportsReasoningEffort: true,
      ...(isDeepSeek ? { thinkingFormat: 'deepseek' } : {}),
    };
  }

  return {
    modelEntry,
    hasVision,
    hasThinking: Boolean(reasoningEfforts),
    hasToolCall,
    isImageEndpoint,
    sources: {
      matchedInModelsDev: dev ? dev.modelId : null,
      modelsDevProvider: dev ? dev.provider : null,
      family: identifyModelFamily(id, dev),
    },
  };
}

async function fetchModelsFromApi(baseURL, apiKey, apiProtocol = 'openai-completions') {
  let cleanUrl = baseURL.trim().replace(/\/+$/, '');
  const urlsToTry = cleanUrl.endsWith('/v1')
    ? [`${cleanUrl}/models`]
    : [`${cleanUrl}/v1/models`, `${cleanUrl}/models`];

  const headers = { Accept: 'application/json' };
  if (apiKey) {
    if (apiProtocol === 'anthropic-messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  let lastError = null;
  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, { method: 'GET', headers });
      if (res.ok) {
        const data = await res.json();
        let list = [];
        if (Array.isArray(data)) list = data;
        else if (Array.isArray(data.data)) list = data.data;
        else if (data.models && typeof data.models === 'object') {
          list = Array.isArray(data.models) ? data.models : Object.values(data.models);
        }
        if (list.length > 0) return { url, models: list };
      } else {
        lastError = new Error(`HTTP ${res.status} ${res.statusText} from ${url}`);
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Không thể lấy danh sách model từ ${baseURL}: ${lastError?.message || 'Không tìm thấy models'}`);
}

/**
 * Patch một instance model đã được PiAi resolve để luôn hỗ trợ thinking effort và vision
 */
function patchResolvedModel(resolved, modelId) {
  if (!resolved || typeof resolved !== 'object') return;
  const cap = resolveCapabilities(modelId || resolved.id);

  if (cap.hasThinking) {
    resolved.reasoning = true;
    if (!resolved.thinkingLevelMap || typeof resolved.thinkingLevelMap !== 'object') {
      resolved.thinkingLevelMap = {};
    }
    const efforts = cap.modelEntry.reasoningEfforts || {};
    for (const [lvl, wire] of Object.entries(efforts)) {
      if (wire !== null && wire !== undefined) {
        resolved.thinkingLevelMap[lvl] = wire;
      }
    }

    // Đảm bảo 'off' luôn được hỗ trợ (không bị null)
    if (resolved.thinkingLevelMap.off === null) {
      delete resolved.thinkingLevelMap.off;
    }

    // Đảm bảo các nấc tiêu chuẩn (low, medium, high) không bị null
    if (resolved.thinkingLevelMap.high === null || resolved.thinkingLevelMap.high === undefined) {
      resolved.thinkingLevelMap.high = 'high';
    }
    if (resolved.thinkingLevelMap.medium === null || resolved.thinkingLevelMap.medium === undefined) {
      resolved.thinkingLevelMap.medium = resolved.thinkingLevelMap.high || 'medium';
    }
    if (resolved.thinkingLevelMap.low === null || resolved.thinkingLevelMap.low === undefined) {
      resolved.thinkingLevelMap.low = resolved.thinkingLevelMap.medium || 'low';
    }

    if (!resolved.compat || typeof resolved.compat !== 'object') {
      resolved.compat = {};
    }
    resolved.compat.supportsReasoningEffort = true;
  }

  if (cap.hasVision && Array.isArray(resolved.input) && !resolved.input.includes('image')) {
    resolved.input.push('image');
  }
}

/**
 * Tự động quét và nâng cấp tất cả provider hiện có trong llm-pi-ai trên startup
 */
async function autoEnhanceStoredProfiles(ctx) {
  if (!ctx.configEditor) return;
  try {
    const entries = ctx.configEditor.entries();
    const entry = entries.find(
      (e) => e.options?.id === 'llm-pi-ai' || e.patchId === 'llm-pi-ai' || e.id === 'include:llm-pi-ai'
    );
    if (!entry) return;

    await ctx.configEditor.edit(entry, (current = {}) => {
      const next = structuredClone(current);
      if (!next.providers) return next;

      let hasChanges = false;
      for (const [pid, p] of Object.entries(next.providers)) {
        if (!p || !Array.isArray(p.models)) continue;
        for (const m of p.models) {
          if (!m || typeof m !== 'object') continue;
          const cap = resolveCapabilities(m, { api: p.api });

          if (cap.hasVision && (!m.input || !m.input.includes('image'))) {
            m.input = ['text', 'image'];
            hasChanges = true;
          }

          if (cap.hasThinking && (m.reasoningEfforts === undefined || m.reasoningEfforts === false)) {
            m.reasoningEfforts = cap.modelEntry.reasoningEfforts;
            if (p.api === 'openai-completions') {
              const s = (m.id || '').toLowerCase();
              const isDeepSeek = s.includes('deepseek') || s.includes('r1');
              m.compat = {
                ...m.compat,
                supportsReasoningEffort: true,
                ...(isDeepSeek ? { thinkingFormat: 'deepseek' } : {}),
              };
            }
            hasChanges = true;
          }
        }
      }
      return hasChanges ? next : current;
    });
  } catch (err) {
    ctx.logger?.warn(`autoEnhanceStoredProfiles error: ${err.message}`);
  }
}

export function apply(ctx) {
  initModelsDevDatabase(ctx.logger);
  ctx.logger?.info('Custom Model Discovery Plugin (API Metadata + models.dev + Vendor Reasoning Ladders) active');

  // =========================================================================
  // 1. Hook trực tiếp PiAiAdapter.prototype.modelOf
  //    Đảm bảo ở cấp Engine Adapter, model luôn có reasoning=true và thinkingLevelMap
  //    đầy đủ các mức (off, low, medium, high), triệt tiêu lỗi "không hỗ trợ" khi chuyển mức
  // =========================================================================
  (async () => {
    let PiAiAdapterClass = null;
    try {
      const mod = await import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js');
      PiAiAdapterClass = mod.PiAiAdapter;
    } catch {
      if (ctx.llm?.adapters) {
        for (const reg of ctx.llm.adapters.values()) {
          if (reg?.adapter?.constructor?.name === 'PiAiAdapter') {
            PiAiAdapterClass = reg.adapter.constructor;
            break;
          }
        }
      }
    }

    if (PiAiAdapterClass && typeof PiAiAdapterClass.prototype?.modelOf === 'function') {
      const originalModelOf = PiAiAdapterClass.prototype.modelOf;
      if (!originalModelOf.__dshEnhanced) {
        const patched = function (snapshot, provider, model) {
          const resolved = originalModelOf.call(this, snapshot, provider, model);
          if (resolved) {
            patchResolvedModel(resolved, model);
          }
          return resolved;
        };
        patched.__dshEnhanced = true;
        PiAiAdapterClass.prototype.modelOf = patched;
        ctx.logger?.info('PiAiAdapter.prototype.modelOf successfully hooked with dynamic reasoning & vision enhancer');
      }
    }
  })();

  // =========================================================================
  // 2. Live Hook vào ctx.llm.resolveCallConfig
  //    Bảo vệ lớp LlmRuntime: nếu có yêu cầu reasoningEffort hợp lệ, không bao giờ để ném UNSUPPORTED_REASONING_EFFORT
  // =========================================================================
  if (ctx.llm && typeof ctx.llm.resolveCallConfig === 'function') {
    const originalResolveCallConfig = ctx.llm.resolveCallConfig.bind(ctx.llm);
    ctx.llm.resolveCallConfig = async function (config, signal) {
      try {
        return await originalResolveCallConfig(config, signal);
      } catch (err) {
        if (err && err.code === 'UNSUPPORTED_REASONING_EFFORT') {
          const cap = resolveCapabilities(config.model);
          if (cap.hasThinking) {
            ctx.logger?.info(`resolveCallConfig: gracefully accepted effort "${config.reasoningEffort}" for ${config.provider}/${config.model}`);
            return {
              ...config,
              reasoningEffort: config.reasoningEffort,
            };
          }
        }
        throw err;
      }
    };
    ctx.effect(() => () => {
      ctx.llm.resolveCallConfig = originalResolveCallConfig;
    });
  }

  // =========================================================================
  // 3. Live Hook vào ctx.llm.discoverModels (Web UI Settings -> Models)
  // =========================================================================
  if (ctx.llm && typeof ctx.llm.discoverModels === 'function') {
    const originalDiscoverModels = ctx.llm.discoverModels.bind(ctx.llm);
    ctx.llm.discoverModels = async function (settingsNs, request, signal) {
      const discovered = await originalDiscoverModels(settingsNs, request, signal);
      if (!Array.isArray(discovered)) return discovered;

      return discovered.map((model) => {
        const cap = resolveCapabilities(model);
        return {
          ...model,
          contextWindow: cap.modelEntry.contextWindow,
          maxTokens: cap.modelEntry.maxTokens,
          inputModalities: cap.hasVision ? ['text', 'image'] : ['text'],
        };
      });
    };
    ctx.effect(() => () => {
      ctx.llm.discoverModels = originalDiscoverModels;
    });
  }

  // =========================================================================
  // 4. Live Hook vào ctx.llm.resolveModelInfo
  // =========================================================================
  if (ctx.llm && typeof ctx.llm.resolveModelInfo === 'function') {
    const originalResolveModelInfo = ctx.llm.resolveModelInfo.bind(ctx.llm);
    ctx.llm.resolveModelInfo = async function (provider, model, signal) {
      const info = await originalResolveModelInfo(provider, model, signal);
      if (!info) return info;

      const cap = resolveCapabilities(model);

      if (cap.hasThinking && !info.reasoning) {
        const efforts = cap.modelEntry.reasoningEfforts || {};
        info.reasoning = {
          efforts: Object.keys(efforts).map((lvl) => ({
            id: lvl,
            name: lvl.charAt(0).toUpperCase() + lvl.slice(1),
          })),
          defaultEffort: 'medium',
        };
      }

      if (cap.hasVision) {
        const modalities = new Set(info.inputModalities || ['text']);
        modalities.add('image');
        info.inputModalities = Array.from(modalities);
      }

      return info;
    };
    ctx.effect(() => () => {
      ctx.llm.resolveModelInfo = originalResolveModelInfo;
    });
  }

  // Tự động nâng cấp cấu hình trong llm-pi-ai sau khi host khởi tạo
  setTimeout(() => {
    autoEnhanceStoredProfiles(ctx);
  }, 1000);

  // =========================================================================
  // 5. Hàm lưu cấu hình vào DSH giữ nguyên compat tùy biến (preserveCompat)
  // =========================================================================
  async function updateDshProviderConfig(providerId, providerData) {
    if (!ctx.configEditor) {
      throw new Error('configEditor service is not available');
    }

    const entries = ctx.configEditor.entries();
    const entry = entries.find((e) => e.options?.id === 'llm-pi-ai' || e.patchId === 'llm-pi-ai' || e.id === 'include:llm-pi-ai');
    if (!entry) {
      throw new Error('Không tìm thấy entry include:llm-pi-ai');
    }

    await ctx.configEditor.edit(entry, (current = {}) => {
      const next = structuredClone(current);
      if (!next.providers) next.providers = {};
      const existing = next.providers[providerId] || {};

      const existingCompat = new Map();
      for (const m of existing.models || []) {
        if (m && m.id && m.compat) existingCompat.set(m.id, m.compat);
      }

      const mergedModels = (providerData.models || []).map((m) => {
        if (existingCompat.has(m.id)) {
          return {
            ...m,
            compat: { ...m.compat, ...existingCompat.get(m.id) },
          };
        }
        return m;
      });

      next.providers[providerId] = {
        ...existing,
        ...providerData,
        models: mergedModels,
      };

      return next;
    });
  }

  // =========================================================================
  // 6. Tool: discover_custom_models
  // =========================================================================
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register({
      name: 'discover_custom_models',
      description: 'Tự động quét endpoint Custom API, kết hợp metadata API, models.dev và thang đo reasoning vendor chuẩn để tự gắn Vision, Thinking/Effort và Tool Calls, rồi lưu vào DSH.',
      parameters: {
        type: 'object',
        properties: {
          baseURL: {
            type: 'string',
            description: 'URL của API (ví dụ: https://api.openai.com/v1 hoặc https://dc-ai.dabeecao.org/v1)',
          },
          apiKey: {
            type: 'string',
            description: 'API key (nếu cần xác thực)',
          },
          providerId: {
            type: 'string',
            description: 'ID định danh cho provider trong DSH. Nếu để trống sẽ tự tạo từ hostname.',
          },
          api: {
            type: 'string',
            enum: ['openai-completions', 'openai-responses', 'anthropic-messages'],
            description: 'Giao thức API. Mặc định là openai-completions.',
          },
          forceVision: {
            type: 'boolean',
            description: 'Bật Vision cho tất cả model. Mặc định false.',
          },
          forceThinking: {
            type: 'boolean',
            description: 'Bật Thinking/Reasoning effort cho tất cả model. Mặc định false.',
          },
          autoSave: {
            type: 'boolean',
            description: 'Tự động lưu vào cấu hình DSH ngay lập tức. Mặc định true.',
          },
        },
        required: ['baseURL'],
      },
      output: {
        schema: { type: 'object' },
        render(args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args) {
        const {
          baseURL,
          apiKey = '',
          api = 'openai-completions',
          forceVision = false,
          forceThinking = false,
          autoSave = true,
        } = args;

        let providerId = args.providerId;
        if (!providerId) {
          try {
            const parsed = new URL(baseURL);
            providerId = parsed.hostname.replace(/[^a-zA-Z0-9_-]/g, '_');
          } catch {
            providerId = 'custom_api';
          }
        }

        const { url: discoveredUrl, models: rawModels } = await fetchModelsFromApi(baseURL, apiKey, api);

        const analyzedModels = [];
        let visionCount = 0;
        let thinkingCount = 0;
        let toolCount = 0;
        const details = [];

        for (const raw of rawModels) {
          const cap = resolveCapabilities(raw, {
            forceVision,
            forceThinking,
            api,
          });

          if (cap.isImageEndpoint) continue;

          if (cap.hasVision) visionCount++;
          if (cap.hasThinking) thinkingCount++;
          if (cap.hasToolCall) toolCount++;

          analyzedModels.push(cap.modelEntry);
          details.push({
            id: cap.modelEntry.id,
            name: cap.modelEntry.name,
            family: cap.sources.family,
            vision: cap.hasVision,
            thinking: cap.hasThinking,
            reasoningEfforts: cap.modelEntry.reasoningEfforts,
            toolCall: cap.hasToolCall,
            contextWindow: cap.modelEntry.contextWindow,
            maxTokens: cap.modelEntry.maxTokens,
            modelsDevMatch: cap.sources.matchedInModelsDev,
          });
        }

        let saved = false;
        let saveError = null;
        if (autoSave) {
          try {
            await updateDshProviderConfig(providerId, {
              api,
              baseURL: baseURL.trim().replace(/\/+$/, ''),
              ...(apiKey ? { apiKeyEnv: apiKey } : {}),
              displayName: providerId,
              models: analyzedModels,
            });
            saved = true;
          } catch (err) {
            saveError = err.message;
          }
        }

        return {
          status: 'success',
          providerId,
          discoveredEndpoint: discoveredUrl,
          totalChatModels: analyzedModels.length,
          visionModelsCount: visionCount,
          thinkingModelsCount: thinkingCount,
          toolCallingModelsCount: toolCount,
          savedToDsh: saved,
          saveError,
          models: details,
        };
      },
    });

    // =========================================================================
    // 7. Tool: enhance_existing_providers
    // =========================================================================
    ctx.tools.register({
      name: 'enhance_existing_providers',
      description: 'Quét toàn bộ provider hiện có trong DSH, dùng models.dev và vendor reasoning ladder để nâng cấp Vision, Thinking và Tool Calls.',
      parameters: {
        type: 'object',
        properties: {
          providerId: {
            type: 'string',
            description: 'Chỉ định một provider cụ thể, hoặc để trống để nâng cấp tất cả.',
          },
          forceVision: {
            type: 'boolean',
            description: 'Bật Vision cho tất cả model. Mặc định false.',
          },
          forceThinking: {
            type: 'boolean',
            description: 'Bật Thinking cho tất cả model. Mặc định false.',
          },
        },
      },
      output: {
        schema: { type: 'object' },
        render(args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
        },
      },
      async execute(args = {}) {
        if (!ctx.configEditor) {
          throw new Error('configEditor service is not available');
        }

        const entries = ctx.configEditor.entries();
        const entry = entries.find((e) => e.options?.id === 'llm-pi-ai' || e.patchId === 'llm-pi-ai' || e.id === 'include:llm-pi-ai');
        if (!entry) {
          throw new Error('Không tìm thấy entry include:llm-pi-ai');
        }

        let updatedReport = {};

        await ctx.configEditor.edit(entry, (current = {}) => {
          const next = structuredClone(current);
          if (!next.providers) return next;

          const targetProviders = args.providerId ? [args.providerId] : Object.keys(next.providers);

          for (const pid of targetProviders) {
            const p = next.providers[pid];
            if (!p || !Array.isArray(p.models)) continue;

            let modified = 0;
            let visionEnhanced = 0;
            let thinkingEnhanced = 0;

            p.models = p.models.map((m) => {
              const cap = resolveCapabilities(m, {
                forceVision: args.forceVision,
                forceThinking: args.forceThinking,
                api: p.api,
              });

              const merged = {
                ...cap.modelEntry,
                ...m,
                input: (cap.hasVision || m.input?.includes('image')) ? ['text', 'image'] : (m.input || ['text']),
                contextWindow: m.contextWindow || cap.modelEntry.contextWindow,
                maxTokens: Math.min(m.maxTokens || cap.modelEntry.maxTokens, m.contextWindow || cap.modelEntry.contextWindow),
              };

              if (cap.hasThinking && (!merged.reasoningEfforts || Object.keys(merged.reasoningEfforts).length <= 2)) {
                merged.reasoningEfforts = cap.modelEntry.reasoningEfforts;
                if (p.api === 'openai-completions') {
                  const s = (m.id || '').toLowerCase();
                  const isDeepSeek = s.includes('deepseek') || s.includes('r1');
                  merged.compat = {
                    ...merged.compat,
                    supportsReasoningEffort: true,
                    ...(isDeepSeek ? { thinkingFormat: 'deepseek' } : {}),
                  };
                }
              }

              if (merged.input.includes('image')) visionEnhanced++;
              if (merged.reasoningEfforts) thinkingEnhanced++;
              modified++;
              return merged;
            });

            updatedReport[pid] = {
              totalModels: p.models.length,
              enhancedModels: modified,
              visionModels: visionEnhanced,
              thinkingModels: thinkingEnhanced,
            };
          }

          return next;
        });

        return {
          status: 'success',
          updatedReport,
        };
      },
    });
  }

  // =========================================================================
  // 8. Slash Commands: /discover-models và /enhance-models
  // =========================================================================
  if (ctx.commands && typeof ctx.commands.register === 'function') {
    ctx.commands.register({
      name: 'discover-models',
      description: 'Tự động phát hiện model từ Custom API (API metadata + models.dev + Vendor Ladders)',
      input: {
        hint: '<baseURL> [apiKey] [providerId]',
      },
      async handler(invocation) {
        const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          return {
            kind: 'error',
            text: 'Cú pháp: /discover-models <baseURL> [apiKey] [providerId]\nVí dụ: /discover-models https://dc-ai.dabeecao.org/v1 dc_xxxx dc-ai',
          };
        }

        const baseURL = parts[0];
        const apiKey = parts[1] || '';
        const providerId = parts[2] || '';

        try {
          const tool = ctx.tools.get('discover_custom_models');
          if (!tool) throw new Error('Tool discover_custom_models chưa sẵn sàng');

          const result = await ctx.tools.execute({
            callId: `cmd_${Date.now()}`,
            name: 'discover_custom_models',
            arguments: { baseURL, apiKey, providerId, autoSave: true },
            signal: invocation.signal,
          });

          if (result.isError) {
            return { kind: 'error', text: `Thất bại: ${result.error?.message || 'Lỗi không xác định'}` };
          }

          const val = result.value;
          return {
            kind: 'success',
            text: `✅ Đã quét thành công ${val.totalChatModels} chat models từ ${val.discoveredEndpoint}!\n- 🖼️ Vision models: ${val.visionModelsCount}\n- 🧠 Thinking models: ${val.thinkingModelsCount}\n- 🛠️ Tool Calling: ${val.toolCallingModelsCount}\n- 💾 Đã lưu vào DSH: ${val.savedToDsh ? 'Thành công (ID: ' + val.providerId + ')' : 'Lỗi: ' + val.saveError}`,
          };
        } catch (err) {
          return { kind: 'error', text: `Lỗi: ${err.message}` };
        }
      },
    });

    ctx.commands.register({
      name: 'enhance-models',
      description: 'Nâng cấp toàn bộ model hiện có trong DSH với thang đo Vendor Thinking & Vision',
      async handler(invocation) {
        try {
          const tool = ctx.tools.get('enhance_existing_providers');
          if (!tool) throw new Error('Tool enhance_existing_providers chưa sẵn sàng');

          const result = await ctx.tools.execute({
            callId: `cmd_${Date.now()}`,
            name: 'enhance_existing_providers',
            arguments: {},
            signal: invocation.signal,
          });

          if (result.isError) {
            return { kind: 'error', text: `Thất bại: ${result.error?.message || 'Lỗi không xác định'}` };
          }

          return {
            kind: 'success',
            text: `✅ Đã nâng cấp các provider hiện có qua models.dev & vendor ladders thành công!\n${JSON.stringify(result.value.updatedReport, null, 2)}`,
          };
        } catch (err) {
          return { kind: 'error', text: `Lỗi: ${err.message}` };
        }
      },
    });
  }
}
