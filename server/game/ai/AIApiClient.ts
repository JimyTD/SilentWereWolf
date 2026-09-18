import {
  classifyFailure,
  getLlmConfig,
  getModelQuirk,
  hasAvailableSlot,
  isRetryableKind,
  isSlotAvailable,
  ladderSnapshot,
  logLadderOnce,
  markSlotFailed,
  markSlotOk,
  type ChainSlot,
  type LlmErrorKind,
} from './AIProviderLadder';

export interface AICallOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** 要求模型返回 JSON 对象（对齐 QQBotForFun scene 的 `json_mode_default`） */
  jsonMode?: boolean;
}

export interface AICallResult {
  success: boolean;
  content: string;
  error?: string;
  /** 实际生效的档，如 `tokenhub:qwen3.5-plus` */
  slot?: string;
  /** 命中的档位下标：0 = 链头，>0 = 本次发生过降档 */
  chainIndex?: number;
}

/** 对齐 QQBotForFun `silent_mark_ai` 的 `max_tokens: 1024` */
const DEFAULT_MAX_TOKENS = 1024;
/** 对齐 QQBotForFun `silent_mark_ai` 的 `temperature: 0.3` */
const DEFAULT_TEMPERATURE = 0.3;

/**
 * QQBotForFun 的 `_ensure_json_hint`：要求 JSON 模式时，若 system prompt 里
 * 没有 "json" 字样就补一句约束（部分平台要求提示词里显式提到 JSON）。
 */
const JSON_HINT = 'You MUST respond with valid JSON only. Do not include markdown code fences.';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { code?: string | number; message?: string };
}

/** 单档失败（已记入健康态，由外层负责降档） */
class SlotFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotFailure';
  }
}

/** 单次 HTTP 请求失败，带上分类所需的信息 */
class RequestFailure extends Error {
  status?: number;
  isTimeout: boolean;

  constructor(message: string, status?: number, isTimeout = false) {
    super(message);
    this.name = 'RequestFailure';
    this.status = status;
    this.isTimeout = isTimeout;
  }
}

function isValidJson(text: string): boolean {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    JSON.parse(stripped);
    return true;
  } catch {
    return false;
  }
}

function ensureJsonHint(systemPrompt: string): string {
  return systemPrompt.toLowerCase().includes('json') ? systemPrompt : `${systemPrompt}\n\n${JSON_HINT}`;
}

/**
 * 单次调用（一个档、一次尝试）。
 *
 * 失败时抛 RequestFailure；成功返回原始内容（内容是否合规由调用方判断）。
 */
async function callOnce(
  slot: ChainSlot,
  params: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
    jsonMode: boolean;
    timeoutMs: number;
  },
): Promise<string> {
  const provider = getLlmConfig().providers[slot.provider];

  const body: Record<string, unknown> = {
    model: slot.model,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ],
    temperature: params.temperature,
    max_tokens: params.maxTokens,
  };
  if (params.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    if (isTimeout) {
      throw new RequestFailure(`请求超时(${Math.round(params.timeoutMs / 1000)}s)`, undefined, true);
    }
    throw new RequestFailure(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data: ChatCompletionResponse | null = null;
  try {
    data = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    data = null;
  }

  if (!response.ok) {
    // TokenHub 的业务错误码是 6 位、前三位对应 HTTP 状态（如 401006），
    // 必须把 code 带进 message，否则分类器无法特判。
    const code = data?.error?.code !== undefined ? String(data.error.code) : '';
    const detail = data?.error?.message || text.slice(0, 200);
    throw new RequestFailure(`HTTP ${response.status}${code ? ` [${code}]` : ''}: ${detail}`, response.status);
  }

  return data?.choices?.[0]?.message?.content?.trim() ?? '';
}

async function backoff(attempt: number, deadline: number): Promise<void> {
  const config = getLlmConfig();
  const delay = Math.min(config.backoffBaseMs * 2 ** (attempt - 1), config.backoffMaxMs);
  // 退避不得超出整链预算
  if (Date.now() + delay >= deadline) return;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * 在**单档内**完成调用（含退避重试与 JSON 校验）。
 *
 * 失败时负责记录该档的冷却，再抛 SlotFailure 交给外层降档。
 * 照抄 QQBotForFun `_call_slot` 的失败分流：
 *   - 限流 / 抖动 → 档内退避重试；
 *   - 配额耗尽 / 鉴权失败 / 参数错 / 模型下线 → 打冷却后降档；
 *   - 输出非 JSON → **不算档位故障**（标记该档正常后降档）；
 *   - 不支持 `response_format` → 去掉该字段重发（同档，不降档、不冷却）。
 */
async function callSlot(
  slot: ChainSlot,
  params: {
    systemPrompt: string;
    userPrompt: string;
    maxTokens: number;
    temperature: number;
    jsonMode: boolean;
  },
  deadline: number,
): Promise<string> {
  const config = getLlmConfig();
  const quirk = getModelQuirk(slot.model);
  // quirks 优先级高于调用方传值（kimi-k2.5 只接受 temperature=1.0）
  const temperature = quirk?.temperature ?? params.temperature;
  const attempts = Math.max(1, config.slotAttempts);

  let jsonMode = params.jsonMode;
  let lastFailure: RequestFailure | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // 单次超时不得超过剩余预算，保证整链预算是硬上限
    const timeoutMs = Math.max(1000, Math.min(config.attemptTimeoutMs, remaining));

    let content: string;
    try {
      content = await callOnce(slot, { ...params, jsonMode, temperature, timeoutMs });
    } catch (err) {
      const failure = err instanceof RequestFailure ? err : new RequestFailure(String(err));

      if (jsonMode && failure.status === 400 && /response_format/i.test(failure.message)) {
        console.warn(`[LLMLadder] slot=${slot.key} 不支持 response_format，退化为纯文本 JSON 约束`);
        jsonMode = false;
        attempt -= 1; // 这次退化不算一次尝试
        continue;
      }

      lastFailure = failure;
      const kind: LlmErrorKind = classifyFailure({
        status: failure.status,
        message: failure.message,
        isTimeout: failure.isTimeout,
      });

      if (isRetryableKind(kind) && attempt < attempts) {
        await backoff(attempt, deadline);
        continue;
      }

      markSlotFailed(slot, kind, failure.message);
      throw new SlotFailure(failure.message);
    }

    if (jsonMode && !isValidJson(content)) {
      if (attempt < attempts) {
        console.warn(`[LLMLadder] slot=${slot.key} 输出非 JSON，第 ${attempt} 次重试`);
        await backoff(attempt, deadline);
        continue;
      }
      markSlotOk(slot);
      throw new SlotFailure(`输出非合法 JSON: ${content.slice(0, 200)}`);
    }

    if (!content) {
      // 空内容不是档位故障（多半是 max_tokens 太小），不冷却，直接降下一档
      markSlotOk(slot);
      throw new SlotFailure('LLM 返回内容为空');
    }

    markSlotOk(slot);
    return content;
  }

  // 档内尝试耗尽（只可能是可重试类错误，或预算在重试途中用完）
  const message = lastFailure?.message ?? '档内尝试次数耗尽';
  const kind: LlmErrorKind = lastFailure
    ? classifyFailure({ status: lastFailure.status, message, isTimeout: lastFailure.isTimeout })
    : 'transient';
  markSlotFailed(slot, kind, message);
  throw new SlotFailure(message);
}

/**
 * 调用 LLM（OpenAI 兼容格式，原生 fetch 直连）。
 *
 * 按**阶梯链**依次尝试：冷却中 / 未配置 / 已下线的档直接跳过，
 * 失败按类型决定"就地重试"还是"打冷却降下一档"，全链不可用则返回失败。
 *
 * 不再使用 zhipuai SDK：2026-08-27 实测 SDK v2.0.0 从生产服务器调用
 * 全部 Connection error，而同一 endpoint 直接 fetch 稳定返回 200。
 */
export async function callLLM(options: AICallOptions): Promise<AICallResult> {
  logLadderOnce();

  const config = getLlmConfig();
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const jsonMode = options.jsonMode ?? false;
  const systemPrompt = jsonMode ? ensureJsonHint(options.systemPrompt) : options.systemPrompt;

  const deadline = Date.now() + config.chainBudgetMs;
  const skipped: string[] = [];
  let lastError = '';

  for (let index = 0; index < config.chain.length; index++) {
    const slot = config.chain[index];

    if (!isSlotAvailable(slot)) {
      skipped.push(slot.key);
      continue;
    }
    if (Date.now() >= deadline) {
      lastError = lastError || `整链预算耗尽(${config.chainBudgetMs}ms)`;
      break;
    }

    try {
      const content = await callSlot(
        slot,
        { systemPrompt, userPrompt: options.userPrompt, maxTokens, temperature, jsonMode },
        deadline,
      );

      if (index > 0) {
        console.warn(`[LLMLadder] 本次降档生效 slot=${slot.key} chainIndex=${index}（链头 ${config.chain.length} 档中前 ${index} 档不可用）`);
      }
      return { success: true, content, slot: slot.key, chainIndex: index };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!lastError) {
    lastError = `链上没有可用档（未配置 / 冷却中 / 已下线）: ${skipped.join(', ')}`;
  }
  console.error(`[LLMLadder] 阶梯链全部失败: ${lastError}`);
  return { success: false, content: '', error: lastError };
}

/**
 * 测试 AI 连通性（真打一次，报出**实际生效的档**与是否降档）。
 *
 * 与诊断不同，这是唯一会消耗一次调用的入口；链上无可用档时**不发请求**直接返回。
 */
export async function testAIConnection(): Promise<{ success: boolean; message: string }> {
  logLadderOnce();

  if (!hasAvailableSlot()) {
    const snapshot = ladderSnapshot();
    const cooling = snapshot.filter(item => item.status === 'cooling').length;
    return {
      success: false,
      message: `链上没有可用档（共 ${snapshot.length} 档，${cooling} 档冷却中，其余未配置或已下线）`,
    };
  }

  try {
    const result = await callLLM({
      systemPrompt: '你是一个助手。',
      userPrompt: '请回复"连接成功"四个字。',
      maxTokens: 20,
      temperature: 0,
    });

    if (result.success) {
      const chainIndex = result.chainIndex ?? 0;
      const degraded = chainIndex > 0 ? `，已降档（第 ${chainIndex + 1}/${getLlmConfig().chain.length} 档）` : '';
      return { success: true, message: `AI 连接正常（实际生效档: ${result.slot ?? '未知'}${degraded}）` };
    }
    return { success: false, message: summarizeError(result.error) };
  } catch (err) {
    return { success: false, message: summarizeError(err instanceof Error ? err.message : String(err)) };
  }
}

/**
 * 给前端看的错误摘要。
 *
 * `room:testAI` 的结果会原样回给发起方，而上游错误里可能带着控制台链接等细节，
 * 完整文本只留在服务端日志里，对外只给截断后的摘要。
 */
function summarizeError(error?: string): string {
  if (!error) return 'AI 返回异常';
  return error.length > 120 ? `${error.slice(0, 120)}…` : error;
}

/**
 * 调用 LLM 为 AI 玩家生成昵称
 *
 * ⚠️ 不带 jsonMode（对齐 QQBotForFun `silent_mark_ai_name` 的 `json_mode_default: false`）。
 */
export async function generateAIName(existingNames: string[]): Promise<string | null> {
  try {
    const result = await callLLM({
      systemPrompt: '你是一个中文名字生成器。只返回一个2-4个字的中文名字，不要解释，不要标点。',
      userPrompt: '请生成一个自然的中文名字（像真人玩家的昵称）。只返回名字本身。',
      maxTokens: 20,
      temperature: 0.9,
      jsonMode: false,
    });

    if (result.success && result.content) {
      const name = result.content.trim().replace(/["“”‘’。，！？\s]/g, '');
      if (name.length >= 2 && name.length <= 8 && !existingNames.includes(name)) {
        return name;
      }
    }
    return null;
  } catch {
    return null;
  }
}
