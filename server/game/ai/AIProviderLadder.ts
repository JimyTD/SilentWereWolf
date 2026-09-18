/**
 * LLM 阶梯模型链 —— 链配置 / 槽位健康态 / 错误分类
 *
 * 设计、链成员与各类取值照抄 QQBotForFun `src/core/llm.py`
 * 及其 `config/llm.yaml` 里的 `scenes.silent_mark_ai.chain`（静夜标记 AI 决策场景）。
 *
 * 本项目只做两处平台适配（其余一律照抄）：
 *   1. 原生 fetch 取代 openai SDK —— 本文件不联网，只提供配置、分类与状态；
 *   2. 单档超时 / 单档尝试次数 / 整链预算收紧：本项目的 AI 决策被
 *      `handlers.ts` 的 withTimeout 包着（外层还含拟人思考延迟），
 *      照抄 30s/3 次会让第一档就吃光外层预算。
 *
 * 照抄的关键语义：
 *   - 各档额度**独立**且**不刷新**：402（未开通 / 额度耗尽）不重试，直接打冷却后降下一档；
 *   - 限流与网络抖动**就地退避重试**，不降档；
 *   - 冷却中的档**直接跳过**，不浪费一次调用；
 *   - 额度耗尽的冷却**指数递增 + 24h 封顶**（固定冷却会周期性白打一个已永久耗尽的档）。
 */

// =====================================================================
// Provider 配置
// =====================================================================

export type LlmProviderName = 'tokenhub' | 'zhipu';

export interface LlmProviderConfig {
  name: LlmProviderName;
  baseUrl: string;
  apiKey: string;
}

/**
 * TokenHub（腾讯云 · 广州站）：单 Key 多模型，OpenAI 兼容。
 * ⚠️ 广州站与新加坡站 Key 不互通。
 */
const DEFAULT_TOKENHUB_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
const DEFAULT_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/**
 * 链路原文 —— 与 QQBotForFun `config/llm.yaml` 的 `silent_mark_ai.chain` 逐字一致。
 * **不增、不减、不重排**。改链序请用 `LLM_MODEL_CHAIN` 环境变量覆盖（逗号分隔）。
 */
export const DEFAULT_MODEL_CHAIN: readonly string[] = [
  'tokenhub:qwen3.5-plus',
  'tokenhub:qwen3.5-flash',
  'tokenhub:hunyuan-role-latest',
  'tokenhub:hy-role',
  'tokenhub:deepseek-v4-flash-202605',
  'tokenhub:deepseek-v4-flash-0731',
  'tokenhub:glm-5.1',
  'tokenhub:glm-5',
  'tokenhub:glm-5-turbo',
  'tokenhub:deepseek-v4-pro-202606',
  'tokenhub:deepseek-v4-pro-0813',
  'tokenhub:kimi-k2.5',
  'tokenhub:minimax-m2.7',
  'zhipu:glm-4-flash-250414',
];

/** 已知的模型脾气：不迁就就是整档 400，白白降级。键为 model 名（不含 provider 前缀）。 */
export interface ModelQuirk {
  /** 覆盖调用方传入的 temperature */
  temperature?: number;
}

export const MODEL_QUIRKS: Record<string, ModelQuirk> = {
  // kimi-k2.5 只接受 temperature=1.0：实测 0.1 / 0.6 一律 400（业务码 400001）。
  // 该档还拒绝 thinking 字段，但本项目从不发送该字段，无需额外声明。
  'kimi-k2.5': { temperature: 1.0 },
};

// =====================================================================
// 错误分类与冷却
// =====================================================================

export const KIND_RATE_LIMITED = 'rate_limited';
export const KIND_QUOTA = 'quota_exhausted';
export const KIND_AUTH = 'auth';
export const KIND_TRANSIENT = 'transient';
export const KIND_FATAL = 'fatal';
export const KIND_UNAVAILABLE = 'unavailable';

export type LlmErrorKind =
  | typeof KIND_RATE_LIMITED
  | typeof KIND_QUOTA
  | typeof KIND_AUTH
  | typeof KIND_TRANSIENT
  | typeof KIND_FATAL
  | typeof KIND_UNAVAILABLE;

/** 可就地重试的两种；其余（配额 / 鉴权 / 参数 / 下线）重试也白搭，直接降档。 */
const RETRYABLE_KINDS: ReadonlySet<string> = new Set([KIND_RATE_LIMITED, KIND_TRANSIENT]);

const BASE_COOL_SECONDS: Record<string, number> = {
  [KIND_RATE_LIMITED]: 35,
  [KIND_TRANSIENT]: 20,
  [KIND_AUTH]: 30 * 60,
  [KIND_FATAL]: 10 * 60,
  [KIND_UNAVAILABLE]: 24 * 3600,
};

/** 额度耗尽的起步冷却与封顶（6h → 12h → 24h）。封顶而非永久封禁，是给误判留一条自愈路径。 */
const QUOTA_BASE_COOL_SECONDS = 6 * 3600;
const QUOTA_COOL_CAP_SECONDS = 24 * 3600;

export function isRetryableKind(kind: string): boolean {
  return RETRYABLE_KINDS.has(kind);
}

export function cooldownSecondsFor(kind: string, exhaustCount: number): number {
  if (kind === KIND_QUOTA) {
    const n = Math.max(1, exhaustCount);
    return Math.min(QUOTA_BASE_COOL_SECONDS * 2 ** (n - 1), QUOTA_COOL_CAP_SECONDS);
  }
  return BASE_COOL_SECONDS[kind] ?? 10 * 60;
}

export interface FailureInfo {
  /** HTTP 状态码；网络层失败（超时 / DNS / 连接被拒）时为 undefined */
  status?: number;
  /** 错误文本，需包含 TokenHub 的业务码（如 401006） */
  message: string;
  /** 是否为超时 / 中断 */
  isTimeout?: boolean;
}

/**
 * 把一次调用失败归类。
 *
 * ⚠️ 判定顺序（照抄 QQBotForFun，已踩过坑）：
 *   1. `401006` / `endpoint is inactive` 是**瞬态**，但码里带 "401"，
 *      若不优先特判会被通用字符串匹配误判成鉴权失败而白白降档；
 *   2. 其次看 HTTP 状态码；
 *   3. 最后才做字符串匹配。
 * 本项目用原生 fetch，拿不到 SDK 的 status_code，所以第 2 步只能靠我们自己解析出来的状态码。
 */
export function classifyFailure(info: FailureInfo): LlmErrorKind {
  const message = info.message || '';
  const lower = message.toLowerCase();

  if (message.includes('401006') || lower.includes('endpoint is inactive')) return KIND_TRANSIENT;
  if (info.isTimeout) return KIND_TRANSIENT;

  const status = info.status;
  if (status === 402) return KIND_QUOTA;
  if (status === 429) return KIND_RATE_LIMITED;
  if (status === 401 || status === 403) return KIND_AUTH;
  if (status === 404) return KIND_UNAVAILABLE;
  if (status === 400) {
    // 400 多半是 quirks 没配对（不是模型坏）；但也可能是模型名无效。
    if (lower.includes('model') && (lower.includes('not found') || lower.includes('not exist') || lower.includes('invalid'))) {
      return KIND_UNAVAILABLE;
    }
    return KIND_FATAL;
  }
  if (status !== undefined && status >= 500) return KIND_TRANSIENT;

  if (message.includes('额度') || message.includes('未开通') || lower.includes('quota') || lower.includes('insufficient')) {
    return KIND_QUOTA;
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) return KIND_RATE_LIMITED;
  if (lower.includes('not found') || lower.includes('does not exist')) return KIND_UNAVAILABLE;

  return KIND_FATAL;
}

// =====================================================================
// 链解析
// =====================================================================

export interface ChainSlot {
  provider: LlmProviderName;
  model: string;
  /** `provider:model`，健康态与日志都用它做键 */
  key: string;
}

function isKnownProvider(name: string): name is LlmProviderName {
  return name === 'tokenhub' || name === 'zhipu';
}

/**
 * 解析链元素：`provider:model`。
 * ⚠️ 只在**第一个**冒号处切分，模型名里可能含斜杠（如 `deepseek/deepseek-flash`）。
 */
export function parseChain(raw: readonly string[]): ChainSlot[] {
  const slots: ChainSlot[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const text = item.trim();
    if (!text) continue;

    const separator = text.indexOf(':');
    if (separator <= 0) {
      console.warn(`[LLMLadder] 跳过无法解析的链元素: "${text}"`);
      continue;
    }

    const provider = text.slice(0, separator).trim();
    const model = text.slice(separator + 1).trim();
    if (!model) {
      console.warn(`[LLMLadder] 跳过缺少模型名的链元素: "${text}"`);
      continue;
    }
    if (!isKnownProvider(provider)) {
      // 只支持这两家；未知前缀直接跳过并告警，绝不让异常穿透整条链
      console.warn(`[LLMLadder] 跳过未知 provider 的链元素: "${text}"`);
      continue;
    }

    const key = `${provider}:${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ provider, model, key });
  }

  return slots;
}

// =====================================================================
// 配置（惰性读取 + 缓存）
// =====================================================================

export interface LlmChainConfig {
  providers: Record<LlmProviderName, LlmProviderConfig>;
  chain: ChainSlot[];
  /** 单档单次请求超时 */
  attemptTimeoutMs: number;
  /** 单档最多尝试次数（含首次），只对限流 / 抖动生效 */
  slotAttempts: number;
  /** 一次 callLLM 内所有档的总预算 */
  chainBudgetMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readChainOverride(): string[] | null {
  const raw = process.env.LLM_MODEL_CHAIN;
  if (!raw || !raw.trim()) return null;
  return raw.split(',');
}

function buildConfig(): LlmChainConfig {
  const providers: Record<LlmProviderName, LlmProviderConfig> = {
    tokenhub: {
      name: 'tokenhub',
      baseUrl: (process.env.TOKENHUB_BASE_URL || DEFAULT_TOKENHUB_BASE_URL).replace(/\/+$/, ''),
      apiKey: process.env.TOKENHUB_API_KEY || '',
    },
    zhipu: {
      name: 'zhipu',
      baseUrl: (process.env.ZHIPU_BASE_URL || DEFAULT_ZHIPU_BASE_URL).replace(/\/+$/, ''),
      apiKey: process.env.ZHIPU_API_KEY || '',
    },
  };

  const rawChain = readChainOverride() ?? [...DEFAULT_MODEL_CHAIN];
  const chain = parseChain(rawChain);
  if (chain.length === 0) {
    console.error('[LLMLadder] 链路为空，回退到内置链');
    chain.push(...parseChain(DEFAULT_MODEL_CHAIN));
  }

  return {
    providers,
    chain,
    // 照抄 QQBotForFun 的 30s / 3 次会让第一档就吃光外层预算，这里收紧（见文件头说明）。
    // 预算 20s：正常档 1~3s 就返回，20s 足够扫过 7~10 档；只有挂住的档才会把它吃满。
    attemptTimeoutMs: readPositiveInt('LLM_ATTEMPT_TIMEOUT_MS', 12000),
    slotAttempts: readPositiveInt('LLM_SLOT_ATTEMPTS', 2),
    chainBudgetMs: readPositiveInt('LLM_CHAIN_BUDGET_MS', 20000),
    backoffBaseMs: 1000,
    backoffMaxMs: 10000,
  };
}

let cachedConfig: LlmChainConfig | null = null;

/**
 * 惰性读取配置。
 *
 * ⚠️ 必须惰性：`server/index.ts` 的 `dotenv.config()` 在所有 import 求值**之后**才执行，
 * 模块顶层读 `process.env` 会读到空值（生产靠 Docker env_file 注入才没暴露这个问题）。
 * 惰性读取同时让单测可以注入环境变量。
 */
export function getLlmConfig(): LlmChainConfig {
  if (!cachedConfig) cachedConfig = buildConfig();
  return cachedConfig;
}

/** 清空配置与健康态缓存（测试 / 配置热重载用） */
export function resetLlmLadder(): void {
  cachedConfig = null;
  slotHealth.clear();
  onlineModels = null;
  preOfflineModels.clear();
  ladderLogged = false;
}

// =====================================================================
// 槽位健康态（进程内，重启清零）
// =====================================================================

export interface SlotHealth {
  coolUntil: number;
  lastError: string | null;
  lastErrorKind: string | null;
  lastOkAt: number | null;
  /** 连续「额度耗尽」次数，用于递增冷却；成功一次即清零 */
  exhaustCount: number;
}

const slotHealth = new Map<string, SlotHealth>();
let ladderLogged = false;

export function getSlotHealth(key: string): SlotHealth | undefined {
  return slotHealth.get(key);
}

export function markSlotOk(slot: ChainSlot): void {
  const health = slotHealth.get(slot.key) ?? {
    coolUntil: 0,
    lastError: null,
    lastErrorKind: null,
    lastOkAt: null,
    exhaustCount: 0,
  };
  health.coolUntil = 0;
  health.lastError = null;
  health.lastErrorKind = null;
  health.lastOkAt = Date.now();
  health.exhaustCount = 0;
  slotHealth.set(slot.key, health);
}

export function markSlotFailed(slot: ChainSlot, kind: LlmErrorKind, message: string): void {
  const health = slotHealth.get(slot.key) ?? {
    coolUntil: 0,
    lastError: null,
    lastErrorKind: null,
    lastOkAt: null,
    exhaustCount: 0,
  };
  if (kind === KIND_QUOTA) health.exhaustCount += 1;
  const coolSeconds = cooldownSecondsFor(kind, health.exhaustCount);
  health.coolUntil = Date.now() + coolSeconds * 1000;
  health.lastError = message.slice(0, 400);
  health.lastErrorKind = kind;
  slotHealth.set(slot.key, health);

  console.warn(`[LLMLadder] slot=${slot.key} 失败 kind=${kind} 冷却=${Math.round(coolSeconds)}s: ${message.slice(0, 160)}`);
}

/** `/v1/models` 里**明确不可用**的 status。用黑名单：字段没见过时宁可当成可用。 */
const OFFLINE_STATUSES: ReadonlySet<string> = new Set(['discontinued', 'offline', 'retired']);

/** tokenhub 可调用模型名；null = 未知（不裁剪） */
let onlineModels: Set<string> | null = null;
/** 其中 `pre-offline`（已公告下线、仍在服务）的档，仅用于诊断提示 */
const preOfflineModels = new Set<string>();

/**
 * 该档现在能不能试。
 *
 * 三种情况直接判不可用（让链继续往下走）：
 *   1. provider 没配 api_key —— ⚠️ 必须在这里拦掉，否则配置异常会穿透降档循环、打断整次调用；
 *   2. 被 `/v1/models` 标成已下线；
 *   3. 正在冷却中。
 */
export function isSlotAvailable(slot: ChainSlot): boolean {
  const provider = getLlmConfig().providers[slot.provider];
  if (!provider || !provider.apiKey) return false;
  if (slot.provider === 'tokenhub' && onlineModels !== null && !onlineModels.has(slot.model)) return false;

  const health = slotHealth.get(slot.key);
  return health === undefined || health.coolUntil <= Date.now();
}

/**
 * 拉 TokenHub `/v1/models`，得到当前**可调用**的模型名集合，用于把已停服的档从链上剔除。
 *
 * ⚠️ 必须用黑名单（只剔 `discontinued` / `offline` / `retired`）：
 * 链头那批档（qwen3.5-*、glm-5.*、kimi-k2.5）实测都是 `pre-offline`
 * ——「已公告下线但**仍可调用**」，只认 `online` 会把它们全部误剔，等于把改造的意义整个抹掉。
 * ⚠️ 该接口不反映额度是否耗尽；失败不阻断启动（退化为不裁剪）。
 */
export async function refreshOnlineModels(timeoutMs = 3000): Promise<Set<string> | null> {
  const provider = getLlmConfig().providers.tokenhub;
  if (!provider.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = (await response.json()) as { data?: Array<{ id?: string; status?: string }> };
    const available = new Set<string>();
    const preOffline = new Set<string>();
    for (const item of body.data ?? []) {
      if (!item?.id) continue;
      const status = String(item.status ?? 'online').toLowerCase();
      if (OFFLINE_STATUSES.has(status)) continue;
      available.add(item.id);
      if (status === 'pre-offline') preOffline.add(item.id);
    }
    if (available.size === 0) throw new Error('返回的模型列表为空');

    onlineModels = available;
    preOfflineModels.clear();
    for (const model of preOffline) preOfflineModels.add(model);

    console.log(
      `[LLMLadder] tokenhub 可调用模型 ${available.size} 个` +
        (preOffline.size > 0 ? `，其中 ${preOffline.size} 个已公告下线但仍在服务（应优先烧）` : '') +
        '；已停服的档将被跳过',
    );
    return available;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[LLMLadder] 拉取 tokenhub 模型列表失败，本次不裁剪链路: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// 诊断（只读内存，不发起任何真实调用）
// =====================================================================

export interface SlotSnapshot {
  key: string;
  provider: LlmProviderName;
  model: string;
  status: 'ok' | 'cooling' | 'no_key' | 'offline' | 'imminent_offline';
  coolRemainingSeconds: number;
  exhaustCount: number;
  lastErrorKind: string | null;
  lastError: string | null;
}

export function ladderSnapshot(): SlotSnapshot[] {
  const config = getLlmConfig();
  const now = Date.now();

  return config.chain.map(slot => {
    const health = slotHealth.get(slot.key);
    const coolRemainingSeconds = health && health.coolUntil > now ? Math.ceil((health.coolUntil - now) / 1000) : 0;

    let status: SlotSnapshot['status'] = 'ok';
    if (!config.providers[slot.provider].apiKey) status = 'no_key';
    else if (slot.provider === 'tokenhub' && onlineModels !== null && !onlineModels.has(slot.model)) status = 'offline';
    else if (coolRemainingSeconds > 0) status = 'cooling';
    else if (preOfflineModels.has(slot.model)) status = 'imminent_offline';

    return {
      key: slot.key,
      provider: slot.provider,
      model: slot.model,
      status,
      coolRemainingSeconds,
      exhaustCount: health?.exhaustCount ?? 0,
      lastErrorKind: health?.lastErrorKind ?? null,
      lastError: health?.lastError ?? null,
    };
  });
}

/** 启动时打一次链路（不含密钥），运维一眼看出链序与实际可用档 */
export function logLadderOnce(): void {
  if (ladderLogged) return;
  ladderLogged = true;

  const snapshot = ladderSnapshot();
  const rendered = snapshot
    .map(item => `${item.key}${item.status === 'no_key' ? '(skip: no key)' : ''}`)
    .join(' → ');
  console.log(`[LLMLadder] 链路(${snapshot.length} 档): ${rendered}`);
}

/** 是否还有任何一档现在可试（诊断用，零消耗） */
export function hasAvailableSlot(): boolean {
  return getLlmConfig().chain.some(slot => isSlotAvailable(slot));
}

/** 供调用方按模型名查 quirks */
export function getModelQuirk(model: string): ModelQuirk | undefined {
  return MODEL_QUIRKS[model];
}
