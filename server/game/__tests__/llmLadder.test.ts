/**
 * 阶梯模型链 · 离线用例（不触网：fetch 全部由桩替换）
 *
 * 覆盖照抄自 QQBotForFun `tests/core/test_llm_ladder.py` 的关键行为：
 * 降档、冷却跳过、限流就地重试、401006 特判、缺 key 不穿透、空/非法 JSON 处理、
 * `/v1/models` 黑名单裁剪、quirks 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CHAIN,
  KIND_FATAL,
  KIND_QUOTA,
  KIND_TRANSIENT,
  classifyFailure,
  cooldownSecondsFor,
  getLlmConfig,
  getSlotHealth,
  ladderSnapshot,
  logLadderOnce,
  markSlotFailed,
  markSlotOk,
  parseChain,
  refreshOnlineModels,
  resetLlmLadder,
  type ChainSlot,
} from '../ai/AIProviderLadder';
import { callLLM } from '../ai/AIApiClient';

interface RecordedCall {
  model: string;
  url: string;
  body: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OK_BODY = { choices: [{ message: { content: 'ok' } }] };
const JSON_BODY = { choices: [{ message: { content: '{"target":1}' } }] };

/** 替换全局 fetch，并记录每次请求的 model / url / body */
function stubFetch(handler: (call: RecordedCall) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const call: RecordedCall = { model: String(body.model ?? ''), url, body };
    calls.push(call);
    return handler(call);
  };
  vi.stubGlobal('fetch', stub);
  return calls;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 用一个短链 + 两个可用 key 作为多数用例的基线 */
function useShortChain(chain: string): void {
  vi.stubEnv('TOKENHUB_API_KEY', 'tokenhub-test-key');
  vi.stubEnv('ZHIPU_API_KEY', 'zhipu-test-key');
  vi.stubEnv('LLM_MODEL_CHAIN', chain);
  resetLlmLadder();
}

describe('链配置', () => {
  it('默认链 = QQBotForFun silent_mark_ai 原文，链尾是智谱', () => {
    const chain = getLlmConfig().chain;
    expect(chain.map(slot => slot.key)).toEqual([...DEFAULT_MODEL_CHAIN]);
    expect(chain).toHaveLength(14);
    expect(chain[chain.length - 1].key).toBe('zhipu:glm-4-flash-250414');
  });

  it('只在第一个冒号处切分，模型名里的斜杠不丢', () => {
    const slots = parseChain(['tokenhub:deepseek/deepseek-flash']);
    expect(slots).toHaveLength(1);
    expect(slots[0].provider).toBe('tokenhub');
    expect(slots[0].model).toBe('deepseek/deepseek-flash');
  });

  it('空串 / 未知 provider / 缺模型名 / 重复档 全部剔除', () => {
    const slots = parseChain(['', '   ', 'nvidia:foo', 'tokenhub:', 'tokenhub:a', 'tokenhub:a']);
    expect(slots.map(slot => slot.key)).toEqual(['tokenhub:a']);
  });
});

describe('错误分类与冷却', () => {
  it('额度耗尽冷却 6h → 12h → 24h 封顶', () => {
    expect(cooldownSecondsFor(KIND_QUOTA, 1)).toBe(6 * 3600);
    expect(cooldownSecondsFor(KIND_QUOTA, 2)).toBe(12 * 3600);
    expect(cooldownSecondsFor(KIND_QUOTA, 3)).toBe(24 * 3600);
    expect(cooldownSecondsFor(KIND_QUOTA, 9)).toBe(24 * 3600);
  });

  it('401006 判为瞬态，不能误判成鉴权失败', () => {
    expect(classifyFailure({ status: 401, message: 'HTTP 401 [401006]: endpoint is inactive' })).toBe(KIND_TRANSIENT);
    expect(classifyFailure({ status: 401, message: 'HTTP 401: invalid api key' })).not.toBe(KIND_TRANSIENT);
  });

  it('402 / 429 / 400 / 5xx 各归其类', () => {
    expect(classifyFailure({ status: 402, message: 'HTTP 402 [402001]: quota exhausted' })).toBe(KIND_QUOTA);
    expect(classifyFailure({ status: 429, message: 'HTTP 429: too many requests' })).toBe('rate_limited');
    expect(classifyFailure({ status: 500, message: 'HTTP 500' })).toBe(KIND_TRANSIENT);
    expect(classifyFailure({ isTimeout: true, message: '请求超时(12s)' })).toBe(KIND_TRANSIENT);
    expect(classifyFailure({ status: 400, message: 'HTTP 400: temperature must be 1.0' })).toBe(KIND_FATAL);
    expect(classifyFailure({ status: 400, message: 'HTTP 400: model not found' })).toBe('unavailable');
  });

  it('成功一次清零额度耗尽计数', () => {
    const slot: ChainSlot = { provider: 'tokenhub', model: 'a', key: 'tokenhub:a' };
    markSlotFailed(slot, KIND_QUOTA, 'quota');
    markSlotFailed(slot, KIND_QUOTA, 'quota');
    expect(getSlotHealth(slot.key)?.exhaustCount).toBe(2);

    markSlotOk(slot);
    expect(getSlotHealth(slot.key)?.exhaustCount).toBe(0);
    expect(getSlotHealth(slot.key)?.coolUntil).toBe(0);
  });
});

describe('降档调度', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('链头额度耗尽 → 自动降档并成功返回，chainIndex > 0', async () => {
    useShortChain('tokenhub:a,tokenhub:b,zhipu:c');
    const calls = stubFetch(call =>
      call.model === 'a'
        ? jsonResponse(402, { error: { code: 402001, message: 'quota exhausted' } })
        : jsonResponse(200, OK_BODY),
    );

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(result).toMatchObject({ success: true, content: 'ok', slot: 'tokenhub:b', chainIndex: 1 });
    expect(calls.map(call => call.model)).toEqual(['a', 'b']);
    expect(getSlotHealth('tokenhub:a')?.lastErrorKind).toBe(KIND_QUOTA);
  });

  it('冷却中的档不再被真实调用', async () => {
    useShortChain('tokenhub:a,tokenhub:b');
    const calls = stubFetch(call =>
      call.model === 'a' ? jsonResponse(402, { error: { message: 'quota' } }) : jsonResponse(200, OK_BODY),
    );

    await callLLM({ systemPrompt: 's', userPrompt: 'u' });
    const afterFirst = calls.length;
    await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(calls.slice(afterFirst).map(call => call.model)).toEqual(['b']);
  });

  it('429 就地退避重试，不降档', async () => {
    useShortChain('tokenhub:a,tokenhub:b');
    let attempt = 0;
    const calls = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse(429, { error: { message: 'too many requests' } })
        : jsonResponse(200, OK_BODY);
    });

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.slot).toBe('tokenhub:a');
    expect(result.chainIndex).toBe(0);
    expect(calls.map(call => call.model)).toEqual(['a', 'a']);
  });

  it('400 打冷却后降档（参数错不是模型坏，但本轮不再重试它）', async () => {
    useShortChain('tokenhub:a,tokenhub:b');
    stubFetch(call =>
      call.model === 'a'
        ? jsonResponse(400, { error: { code: 400001, message: 'temperature must be 1.0' } })
        : jsonResponse(200, OK_BODY),
    );

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.slot).toBe('tokenhub:b');
    expect(getSlotHealth('tokenhub:a')?.lastErrorKind).toBe(KIND_FATAL);
  });

  it('缺 TOKENHUB_API_KEY 时该 provider 的档全部跳过，链继续（不抛异常穿透）', async () => {
    vi.stubEnv('TOKENHUB_API_KEY', '');
    vi.stubEnv('ZHIPU_API_KEY', 'zhipu-test-key');
    vi.stubEnv('LLM_MODEL_CHAIN', 'tokenhub:a,zhipu:c');
    resetLlmLadder();
    const calls = stubFetch(() => jsonResponse(200, OK_BODY));

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(result).toMatchObject({ success: true, slot: 'zhipu:c' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('bigmodel.cn');
  });

  it('全链失败时每档只打一次，并返回 success: false', async () => {
    useShortChain('tokenhub:a,tokenhub:b');
    const calls = stubFetch(() => jsonResponse(402, { error: { code: 402001, message: 'quota exhausted' } }));

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('402');
    expect(calls.map(call => call.model)).toEqual(['a', 'b']);
  });

  it('整链预算耗尽后不再打后面的档', async () => {
    useShortChain('tokenhub:a,tokenhub:b');
    vi.stubEnv('LLM_CHAIN_BUDGET_MS', '50');
    resetLlmLadder();
    const calls = stubFetch(async () => {
      await sleep(200);
      return jsonResponse(500, { error: { message: 'boom' } });
    });

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.success).toBe(false);
    expect(calls.map(call => call.model)).toEqual(['a']);
  });

  it('jsonMode 会带 response_format，并给没有 json 字样的 system prompt 补约束', async () => {
    useShortChain('tokenhub:a');
    const calls = stubFetch(() => jsonResponse(200, JSON_BODY));

    const result = await callLLM({ systemPrompt: '你是玩家', userPrompt: 'u', jsonMode: true });

    expect(result.success).toBe(true);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    const messages = calls[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain('valid JSON');
  });

  it('jsonMode 下非 JSON 输出：档内重试后降档，且不定性为档位故障', async () => {
    useShortChain('tokenhub:a,tokenhub:b');
    stubFetch(call =>
      call.model === 'a'
        ? jsonResponse(200, { choices: [{ message: { content: '这不是 JSON' } }] })
        : jsonResponse(200, { choices: [{ message: { content: '{"target":1}' } }] }),
    );

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });

    expect(result).toMatchObject({ success: true, slot: 'tokenhub:b' });
    expect(getSlotHealth('tokenhub:a')?.lastErrorKind).toBeNull();
    expect(getSlotHealth('tokenhub:a')?.coolUntil).toBe(0);
  });

  it('quirks 覆盖调用方 temperature：kimi-k2.5 只接受 1.0', async () => {
    useShortChain('tokenhub:kimi-k2.5');
    const calls = stubFetch(() => jsonResponse(200, OK_BODY));

    await callLLM({ systemPrompt: 's', userPrompt: 'u', temperature: 0.3 });

    expect(calls[0].body.temperature).toBe(1.0);
  });
});

describe('启动与诊断', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('启动日志打印完整链序（不含密钥）', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    logLadderOnce();

    const line = log.mock.calls.map(args => String(args[0])).find(text => text.includes('链路'));
    expect(line).toBeDefined();
    expect(line).toContain('tokenhub:qwen3.5-plus');
    expect(line).toContain('zhipu:glm-4-flash-250414');
    expect(line).not.toContain('tokenhub-test-key');
  });

  it('/v1/models 拉取失败时不抛异常、不裁剪链路（不阻断启动）', async () => {
    useShortChain('tokenhub:a,tokenhub:b');
    stubFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND tokenhub.tencentmaas.com');
    });

    await expect(refreshOnlineModels()).resolves.toBeNull();
    expect(ladderSnapshot().some(item => item.status === 'offline')).toBe(false);
  });
});

describe('/v1/models 裁剪', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('保留 pre-offline（仍可调用），只剔已停服的档', async () => {
    useShortChain('tokenhub:dead-model,tokenhub:qwen3.5-plus');
    const calls = stubFetch(call =>
      call.url.endsWith('/models')
        ? jsonResponse(200, {
            data: [
              { id: 'qwen3.5-plus', status: 'pre-offline' },
              { id: 'glm-5.1', status: 'online' },
              { id: 'dead-model', status: 'discontinued' },
            ],
          })
        : jsonResponse(200, OK_BODY),
    );

    const available = await refreshOnlineModels();
    expect(available?.has('qwen3.5-plus')).toBe(true);
    expect(available?.has('dead-model')).toBe(false);

    const result = await callLLM({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.slot).toBe('tokenhub:qwen3.5-plus');
    expect(calls.filter(call => call.model === 'dead-model')).toHaveLength(0);
  });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetLlmLadder();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetLlmLadder();
});
