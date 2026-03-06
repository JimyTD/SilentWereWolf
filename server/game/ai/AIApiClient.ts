import { ZhipuAI } from 'zhipuai';

const apiKey = process.env.ZHIPU_API_KEY || '';
const model = process.env.ZHIPU_MODEL || 'glm-4-flash';

let client: ZhipuAI | null = null;

function getClient(): ZhipuAI {
  if (!client) {
    if (!apiKey) {
      throw new Error('ZHIPU_API_KEY 环境变量未设置');
    }
    client = new ZhipuAI({ apiKey });
  }
  return client;
}

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

/**
 * 调用智谱 LLM API
 */
export async function callLLM(options: AICallOptions): Promise<AICallResult> {
  const { systemPrompt, userPrompt, maxTokens = 300, temperature = 0.75 } = options;

  try {
    const ai = getClient();
    const response = await Promise.race([
      ai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM 调用超时(30s)')), 30000)
      ),
    ]);

    const content = response.choices?.[0]?.message?.content || '';

    if (!content) {
      return { success: false, content: '', error: 'LLM 返回内容为空' };
    }

    return { success: true, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[AIApiClient] LLM 调用失败:', message);
    return { success: false, content: '', error: message };
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
      userPrompt: `请生成一个自然的中文名字（像真人玩家的昵称），不要与以下名字重复：${existingNames.join('、')}。只返回名字本身。`,
      maxTokens: 20,
      temperature: 0.9,
    });

    if (result.success && result.content) {
      const name = result.content.trim().replace(/["""''。，！？\s]/g, '');
      if (name.length >= 2 && name.length <= 8 && !existingNames.includes(name)) {
        return name;
      }
    }
    return null;
  } catch {
    return null;
  }
}
