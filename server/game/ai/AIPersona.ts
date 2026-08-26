/**
 * AI 人格注册表
 *
 * 设计原则：
 * 1. 人格是纯 AI 实现细节，与游戏规则无关 —— 因此不写入 GameState / GamePlayer，
 *    避免污染 shared/types 里的规则层类型定义。
 * 2. 人格在「一局游戏开始时」分配，整局固定不变。
 *    旧实现用 seatNumber 做 personalityIndex，导致人格与座位号强绑定
 *    （同一座位每局人格相同、相邻座位人格也相邻），可预测性太强。
 * 3. 同一房间内尽量不重复分配同一种人格，保证场上分析视角多样。
 */

/** 人格定义：只影响 AI 的分析视角与行为节奏，不改变任何游戏规则 */
export interface AIPersona {
  /** 人格标识，用于日志追踪 */
  id: string;
  /** human-readable 名称，仅用于日志 */
  label: string;
  /** 注入 prompt 的分析偏好描述 */
  analysisPreference: string;
  /**
   * 决策速度倾向：影响模拟思考延迟的基准倍率。
   * < 1 偏快（急性子），> 1 偏慢（谨慎型）。
   */
  paceFactor: number;
  /**
   * 直觉倾向：0~1。越高越倾向使用"直觉判断"作为理由，
   * 越低越倾向使用分析类理由。用于修正理由分布过于集中的问题。
   */
  intuitionBias: number;
}

/**
 * 人格池
 * analysisPreference 沿用原 VOTING_PERSONALITIES 的五种分析视角，
 * 保持既有设计意图不变，只是从"每次随机抽"改为"整局固定"。
 */
export const AI_PERSONAS: AIPersona[] = [
  {
    id: 'mark_reader',
    label: '标记细读型',
    analysisPreference:
      '你更擅长从标记发言内容中找矛盾。重点关注：谁的声称前后不一致？谁的评价和事实对不上？有人声称相同的身份吗？',
    paceFactor: 1.15,
    intuitionBias: 0.15,
  },
  {
    id: 'vote_tracker',
    label: '投票追踪型',
    analysisPreference:
      '你更擅长分析投票行为模式。重点关注：谁的投票总是和结果一致（可能是跟风狼）？谁从不投某些人（可能在保队友）？有没有可疑的投票同盟？',
    paceFactor: 1.2,
    intuitionBias: 0.1,
  },
  {
    id: 'silence_watcher',
    label: '关注低调型',
    analysisPreference:
      '你倾向于关注低调的玩家。重点关注：谁说的话最少、评价最模糊？低调可能是在伪装。不要只看被多人指控的热门目标，也要考虑被忽略的玩家。',
    paceFactor: 0.9,
    intuitionBias: 0.35,
  },
  {
    id: 'death_reader',
    label: '死亡线索型',
    analysisPreference:
      '你更擅长从死亡记录和遗物中推理。重点关注：谁被狼人刀了——说明他可能对狼人有威胁，他之前指控过谁？遗物透露了什么信息？',
    paceFactor: 1.05,
    intuitionBias: 0.2,
  },
  {
    id: 'contrarian',
    label: '独立思考型',
    analysisPreference:
      '你倾向于独立思考，不轻易从众。如果很多人都指向同一个目标，你要想：这是因为证据确凿，还是被带节奏了？也许真正的狼人正在利用多数人的判断来甩锅。',
    paceFactor: 1.1,
    intuitionBias: 0.25,
  },
  {
    id: 'gut_player',
    label: '直觉流',
    analysisPreference:
      '你不喜欢复杂推理，更相信第一感觉。你会快速给出判断，不会反复权衡。如果没有明确证据，你就凭感觉选一个，不强求理由充分。',
    paceFactor: 0.7,
    intuitionBias: 0.6,
  },
];

/** roomId → (userId → persona) */
const registry = new Map<string, Map<string, AIPersona>>();

/**
 * 为一局游戏中的所有 AI 玩家分配人格（整局固定）
 * 同一房间内优先不重复，人数超过人格池时循环复用。
 */
export function assignPersonas(roomId: string, aiUserIds: string[]): void {
  const pool = [...AI_PERSONAS];
  // Fisher-Yates 洗牌，保证分配与座位号无关
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const roomMap = new Map<string, AIPersona>();
  aiUserIds.forEach((userId, idx) => {
    roomMap.set(userId, pool[idx % pool.length]);
  });
  registry.set(roomId, roomMap);

  if (aiUserIds.length > 0) {
    const summary = aiUserIds
      .map(id => `${id.slice(0, 6)}=${roomMap.get(id)?.label}`)
      .join(', ');
    console.log(`[AIPersona] 房间 ${roomId} 人格分配：${summary}`);
  }
}

/**
 * 获取某个 AI 玩家本局的人格。
 * 若未分配（例如中途加入或历史房间），按 userId 稳定哈希兜底，
 * 保证同一局内多次调用结果一致，不会出现"这轮急性子下轮慢性子"。
 */
export function getPersona(roomId: string, userId: string): AIPersona {
  const roomMap = registry.get(roomId);
  const found = roomMap?.get(userId);
  if (found) return found;

  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) % 100000;
  }
  return AI_PERSONAS[hash % AI_PERSONAS.length];
}

/** 一局结束时清理，避免内存泄漏 */
export function clearPersonas(roomId: string): void {
  registry.delete(roomId);
}
