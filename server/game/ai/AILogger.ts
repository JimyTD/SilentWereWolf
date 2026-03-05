import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../../logs/ai');

interface AILogEntry {
  timestamp: string;
  aiUserId: string;
  aiRole: string;
  phase: string;
  round: number;
  prompt: string;
  response: string;
  parsedAction: unknown;
  retried: boolean;
  fallback: boolean;
  error?: string;
}

const sessionLogs = new Map<string, AILogEntry[]>();

/**
 * 记录 AI 决策日志
 */
export function logAIDecision(roomId: string, entry: AILogEntry): void {
  if (!sessionLogs.has(roomId)) {
    sessionLogs.set(roomId, []);
  }
  sessionLogs.get(roomId)!.push(entry);
}

/**
 * 将对局日志持久化到文件
 */
export function flushLogs(roomId: string): void {
  const entries = sessionLogs.get(roomId);
  if (!entries || entries.length === 0) return;

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${roomId}_${timestamp}.json`;
    const filepath = path.join(LOG_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(entries, null, 2), 'utf-8');
    console.log(`[AILogger] 对局日志已保存: ${filename}`);
  } catch (err) {
    console.error('[AILogger] 日志写入失败:', err);
  } finally {
    sessionLogs.delete(roomId);
  }
}
