const apiKey = process.env.ZHIPU_API_KEY || '';
const model = process.env.ZHIPU_MODEL || 'glm-4-flash';
const baseUrl = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const REQUEST_TIMEOUT_MS = 60000;

export interface AICallOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AICallResult {
  success: boolean;
  content: string;
  error?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { code?: string; message?: string };
}

/**
 * 调用 LLM API（OpenAI 兼容格式，原生 fetch 直连）
 *
 * 不再使用 zhipuai SDK：2026-08-27 实测 SDK v2.0.0 从生产服务器调用
 * 全部 Connection error，而同一 endpoint 直接 fetch 稳定返回 200。
 * 改用原生 fetch 也为后续切换其他 OpenAI 兼容平台铺路：
 * 只需调整 ZHIPU_BASE_URL / ZHIPU_API_KEY / ZHIPU_MODEL 环境变量。
 */
export async function callLLM(options: AICallOptions): Promise<AICallResult> {
  const { systemPrompt, userPrompt, maxTokens = 300, temperature = 0.6 } = options;

  if (!apiKey) {
    return { success: false, content: '', error: 'ZHIPU_API_KEY 环境变量未设置' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });

    const data = (await response.json()) as ChatCompletionResponse;

    if (!response.ok) {
      const errMsg = data.error?.message ? `HTTP ${response.status}: ${data.error.message}` : `HTTP ${response.status}`;
      console.error('[AIApiClient] LLM 调用失败:', errMsg);
      return { success: false, content: '', error: errMsg };
    }

    const content = data.choices?.[0]?.message?.content || '';

    if (!content) {
      return { success: false, content: '', error: 'LLM 返回内容为空' };
    }

    return { success: true, content };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const errMsg = `LLM 调用超时(${REQUEST_TIMEOUT_MS / 1000}s)`;
      console.error('[AIApiClient] LLM 调用失败:', errMsg);
      return { success: false, content: '', error: errMsg };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[AIApiClient] LLM 调用失败:', message);
    return { success: false, content: '', error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 测试 AI 连通性（验证 API Key 是否可用）
 */
export async function testAIConnection(): Promise<{ success: boolean; message: string }> {
  if (!apiKey) {
    return { success: false, message: 'ZHIPU_API_KEY 未配置' };
  }

  try {
    const result = await callLLM({
      systemPrompt: '你是一个助手。',
      userPrompt: '请回复"连接成功"四个字。',
      maxTokens: 20,
      temperature: 0,
    });

    if (result.success) {
      return { success: true, message: `AI 连接正常（模型: ${model}）` };
    }
    return { success: false, message: result.error || 'AI 返回异常' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}

/**
 * 调用 LLM 为 AI 玩家生成昵称
 */
export async function generateAIName(existingNames: string[]): Promise<string | null> {
  try {
    const result = await callLLM({
      systemPrompt: '你是一个中文名字生成器。只返回一个2-4个字的中文名字，不要解释，不要标点。',
      userPrompt: '请生成一个自然的中文名字（像真人玩家的昵称）。只返回名字本身。',
      maxTokens: 20,
      temperature: 0.9,
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
