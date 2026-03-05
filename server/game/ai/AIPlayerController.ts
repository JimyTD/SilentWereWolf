import type { GameState, GamePlayer, PlayerMarks, IdentityMark, EvaluationMark, MarkReason } from '../../../shared/types/game';
import type { Room } from '../../../shared/types/room';
import { ROLES, COMMON_REASONS, SPECIAL_REASONS } from '../../../shared/constants';
import { buildAIContext, contextToText } from './AIContextBuilder';
import {
  getSystemPrompt,
  getNightActionPrompt,
  getMarkingPrompt,
  getVotingPrompt,
  getHunterPrompt,
  getKnightPrompt,
  getWolfKingPrompt,
  type NightActionPromptParams,
} from './AIPromptTemplates';
import { callLLM } from './AIApiClient';
import { logAIDecision } from './AILogger';

/**
 * AI 玩家决策控制器
 */

// 模拟思考延迟范围（毫秒）
const DELAY_RANGES: Record<string, [number, number]> = {
  night: [3000, 8000],
  marking: [5000, 15000],
  voting: [2000, 6000],
  trigger: [2000, 5000],
};

function getRandomDelay(type: string, maxTimeout?: number): number {
  const [min, max] = DELAY_RANGES[type] || [2000, 5000];
  const delay = Math.floor(Math.random() * (max - min)) + min;
  // 不超过阶段计时器上限的 80%
  if (maxTimeout) {
    return Math.min(delay, maxTimeout * 800);
  }
  return delay;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从 LLM 返回内容中提取 JSON
 * 增强版：支持从 chain-of-thought 混合文本中提取最后一个完整 JSON 对象
 */
function extractJSON(content: string): Record<string, unknown> | null {
  // 先尝试直接解析
  try {
    return JSON.parse(content);
  } catch {
    // 尝试提取 JSON 块（从 markdown code block 或纯文本中）
    // 先尝试 markdown code block
    const codeBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1]);
      } catch {
        // 继续尝试其他方式
      }
    }

    // 尝试提取最后一个完整的 JSON 对象（chain-of-thought 场景下 JSON 通常在末尾）
    const allMatches: string[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (content[i] === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          allMatches.push(content.substring(start, i + 1));
          start = -1;
        }
      }
    }

    // 从最后一个匹配开始尝试解析（chain-of-thought 中最后的 JSON 通常是结论）
    for (let i = allMatches.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(allMatches[i]);
        // 确保解析出的对象至少有一个有意义的字段
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return parsed;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

/**
 * 校验目标是否在合法列表中
 */
function isValidTarget(target: unknown, validTargets: string[]): target is string {
  return typeof target === 'string' && validTargets.includes(target);
}

// ========== 夜晚行动决策 ==========

export interface NightActionResult {
  action: string;
  target?: string;
  potion?: string;
}

export async function decideNightAction(
  state: GameState,
  room: Room,
  aiPlayer: GamePlayer,
  availableTargets: string[],
  witchInfo?: { victim: string | null; hasAntidote: boolean; hasPoison: boolean; canSelfSave: boolean },
): Promise<NightActionResult> {
  const ctx = buildAIContext(state, room, aiPlayer);
  const contextText = contextToText(ctx);

  const systemPrompt = getSystemPrompt(ctx.nickname, ctx.seatNumber, ctx.role, ctx.faction);

  // 构建可选目标的详细信息
  const targetDetails = availableTargets.map(userId => {
    const p = state.players.find(pl => pl.userId === userId);
    const nickname = room.players.find(rp => rp.userId === userId)?.nickname || '未知';
    return { userId, nickname, seatNumber: p?.seatNumber || 0 };
  });

  const promptParams: NightActionPromptParams = {
    role: aiPlayer.role,
    availableTargets: targetDetails,
  };

  if (witchInfo) {
    const victimPlayer = witchInfo.victim ? state.players.find(p => p.userId === witchInfo.victim) : null;
    promptParams.witchInfo = {
      ...witchInfo,
      victimNickname: victimPlayer ? (room.players.find(rp => rp.userId === victimPlayer.userId)?.nickname || '未知') : undefined,
      victimSeat: victimPlayer?.seatNumber,
    };
  }

  const actionPrompt = getNightActionPrompt(promptParams);
  const userPrompt = `${contextText}\n\n${actionPrompt}`;

  // 模拟思考延迟
  await sleep(getRandomDelay('night'));

  // 调用 LLM
  let result = await callLLM({ systemPrompt, userPrompt, maxTokens: 500 });
  let parsed = result.success ? extractJSON(result.content) : null;
  let retried = false;
  let fallback = false;

  // 重试一次
  if (!parsed || (!isValidTarget(parsed.target, availableTargets) && aiPlayer.role !== ROLES.WITCH && parsed.target !== null)) {
    retried = true;
    result = await callLLM({
      systemPrompt,
      userPrompt: userPrompt + '\n\n注意：你必须严格返回合法的 JSON，target 必须是提供的 userId 之一。不要输出 JSON 以外的内容。',
      maxTokens: 300,
    });
    parsed = result.success ? extractJSON(result.content) : null;
  }

  // 记录日志
  logAIDecision(state.roomId, {
    timestamp: new Date().toISOString(),
    aiUserId: aiPlayer.userId,
    aiRole: aiPlayer.role,
    phase: 'night',
    round: state.round,
    prompt: userPrompt,
    response: result.content,
    parsedAction: parsed,
    retried,
    fallback: false,
    error: result.error,
  });

  // 解析结果
  if (parsed) {
    return buildNightActionResult(aiPlayer.role, parsed, availableTargets);
  }

  // Fallback
  fallback = true;
  console.warn(`[AIController] ${ctx.nickname} 夜晚行动 fallback`);
  return fallbackNightAction(aiPlayer.role, availableTargets);
}

function buildNightActionResult(role: string, parsed: Record<string, unknown>, validTargets: string[]): NightActionResult {
  switch (role) {
    case ROLES.WEREWOLF:
    case ROLES.WOLF_KING:
      if (isValidTarget(parsed.target, validTargets)) {
        return { action: 'attack', target: parsed.target };
      }
      return fallbackNightAction(role, validTargets);

    case ROLES.SEER:
      if (isValidTarget(parsed.target, validTargets)) {
        return { action: 'investigate', target: parsed.target };
      }
      return fallbackNightAction(role, validTargets);

    case ROLES.WITCH: {
      const potion = parsed.potion as string;
      if (potion === 'antidote') {
        return { action: 'usePotion', potion: 'antidote' };
      }
      if (potion === 'poison' && isValidTarget(parsed.target, validTargets)) {
        return { action: 'usePotion', potion: 'poison', target: parsed.target };
      }
      return { action: 'usePotion', potion: 'none' };
    }

    case ROLES.GUARD:
      if (parsed.target === null) {
        return { action: 'guard' };
      }
      if (isValidTarget(parsed.target, validTargets)) {
        return { action: 'guard', target: parsed.target };
      }
      return fallbackNightAction(role, validTargets);

    case ROLES.GRAVEDIGGER:
      if (parsed.target === null) {
        return { action: 'autopsy' };
      }
      if (isValidTarget(parsed.target, validTargets)) {
        return { action: 'autopsy', target: parsed.target };
      }
      return { action: 'autopsy' };

    default:
      return { action: 'skip' };
  }
}

function fallbackNightAction(role: string, validTargets: string[]): NightActionResult {
  const randomTarget = validTargets.length > 0
    ? validTargets[Math.floor(Math.random() * validTargets.length)]
    : undefined;

  switch (role) {
    case ROLES.WEREWOLF:
    case ROLES.WOLF_KING:
      return { action: 'attack', target: randomTarget };
    case ROLES.SEER:
      return { action: 'investigate', target: randomTarget };
    case ROLES.WITCH:
      return { action: 'usePotion', potion: 'none' };
    case ROLES.GUARD:
      return { action: 'guard', target: randomTarget };
    case ROLES.GRAVEDIGGER:
      return { action: 'autopsy' };
    default:
      return { action: 'skip' };
  }
}

// ========== 标记发言决策 ==========

export interface MarkingResult {
  identityMark: IdentityMark;
  evaluationMarks: EvaluationMark[];
}

export async function decideMarking(
  state: GameState,
  room: Room,
  aiPlayer: GamePlayer,
  evaluationMarkCount: number,
  availableIdentities: string[],
): Promise<MarkingResult> {
  const ctx = buildAIContext(state, room, aiPlayer);
  const contextText = contextToText(ctx);
  const systemPrompt = getSystemPrompt(ctx.nickname, ctx.seatNumber, ctx.role, ctx.faction);

  // 可评价的目标（排除自己）
  const targets = state.players
    .filter(p => p.alive && p.userId !== aiPlayer.userId)
    .map(p => ({
      userId: p.userId,
      nickname: room.players.find(rp => rp.userId === p.userId)?.nickname || '未知',
      seatNumber: p.seatNumber,
    }));

  const availableReasons = ['直觉判断(intuition)', '投票分析(vote_analysis)', '标记分析(mark_analysis)', '日志推理(log_reasoning)'];
  // 特殊理由仅对应角色可用
  if (aiPlayer.role === ROLES.SEER || aiPlayer.role === ROLES.GRAVEDIGGER) {
    availableReasons.push('查验结论(investigation)');
  }
  if (aiPlayer.role === ROLES.WITCH) {
    availableReasons.push('用药结果(potion_result)');
  }

  const actionPrompt = getMarkingPrompt({
    evaluationMarkCount,
    availableIdentities,
    availableTargets: targets,
    availableReasons,
  });

  const userPrompt = `${contextText}\n\n${actionPrompt}`;

  await sleep(getRandomDelay('marking'));

  let result = await callLLM({ systemPrompt, userPrompt, maxTokens: 1000 });
  let parsed = result.success ? extractJSON(result.content) : null;
  let retried = false;

  if (!parsed || !parsed.identity || !Array.isArray(parsed.evaluations)) {
    retried = true;
    result = await callLLM({
      systemPrompt,
      userPrompt: userPrompt + '\n\n注意：必须返回合法 JSON，包含 analysis、identity、reason、evaluations 字段。evaluations 是数组。不要输出 JSON 以外的内容。',
      maxTokens: 800,
    });
    parsed = result.success ? extractJSON(result.content) : null;
  }

  logAIDecision(state.roomId, {
    timestamp: new Date().toISOString(),
    aiUserId: aiPlayer.userId,
    aiRole: aiPlayer.role,
    phase: 'marking',
    round: state.round,
    prompt: userPrompt,
    response: result.content,
    parsedAction: parsed,
    retried,
    fallback: !parsed,
    error: result.error,
  });

  if (parsed && parsed.identity && Array.isArray(parsed.evaluations)) {
    return buildMarkingResult(parsed, targets, evaluationMarkCount, availableIdentities);
  }

  // Fallback
  return fallbackMarking(aiPlayer, targets, evaluationMarkCount, availableIdentities);
}

function buildMarkingResult(
  parsed: Record<string, unknown>,
  targets: { userId: string; nickname: string; seatNumber: number }[],
  evalCount: number,
  availableIdentities: string[],
): MarkingResult {
  const validReasons: string[] = [...Object.values(COMMON_REASONS), ...Object.values(SPECIAL_REASONS)];

  const identity = typeof parsed.identity === 'string' ? parsed.identity : '好人';
  const parsedReason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const reason: MarkReason = validReasons.includes(parsedReason)
    ? parsedReason as MarkReason
    : COMMON_REASONS.INTUITION;

  const evaluations = (parsed.evaluations as Array<Record<string, unknown>>)
    .slice(0, evalCount)
    .filter(e => targets.some(t => t.userId === e.target))
    .map(e => {
      const eReason = typeof e.reason === 'string' ? e.reason : '';
      return {
        target: e.target as string,
        identity: typeof e.identity === 'string' ? e.identity : '好人',
        reason: (validReasons.includes(eReason) ? eReason : COMMON_REASONS.INTUITION) as MarkReason,
      };
    });

  // 补齐评价数量
  const usedTargets = new Set(evaluations.map(e => e.target));
  const remaining = targets.filter(t => !usedTargets.has(t.userId));
  while (evaluations.length < evalCount && remaining.length > 0) {
    const t = remaining.shift()!;
    evaluations.push({
      target: t.userId,
      identity: '好人',
      reason: COMMON_REASONS.INTUITION,
    });
  }

  return {
    identityMark: { identity, reason },
    evaluationMarks: evaluations.map(e => ({
      target: e.target,
      identity: e.identity,
      reason: e.reason,
    })),
  };
}

function fallbackMarking(
  aiPlayer: GamePlayer,
  targets: { userId: string; nickname: string; seatNumber: number }[],
  evalCount: number,
  availableIdentities: string[],
): MarkingResult {
  const identity = aiPlayer.faction === 'good' ? '好人' : '平民';
  const shuffled = [...targets].sort(() => Math.random() - 0.5);
  const evaluations = shuffled.slice(0, evalCount).map(t => ({
    target: t.userId,
    identity: '好人',
    reason: COMMON_REASONS.INTUITION as EvaluationMark['reason'],
  }));

  return {
    identityMark: { identity, reason: COMMON_REASONS.INTUITION },
    evaluationMarks: evaluations,
  };
}

// ========== 投票决策 ==========

export async function decideVote(
  state: GameState,
  room: Room,
  aiPlayer: GamePlayer,
  candidates: string[],
): Promise<string> {
  const ctx = buildAIContext(state, room, aiPlayer);
  const contextText = contextToText(ctx);
  const systemPrompt = getSystemPrompt(ctx.nickname, ctx.seatNumber, ctx.role, ctx.faction);

  // 不能投自己
  const validCandidates = candidates.filter(c => c !== aiPlayer.userId);
  const targetDetails = validCandidates.map(userId => {
    const p = state.players.find(pl => pl.userId === userId);
    const nickname = room.players.find(rp => rp.userId === userId)?.nickname || '未知';
    return { userId, nickname, seatNumber: p?.seatNumber || 0 };
  });

  const actionPrompt = getVotingPrompt(targetDetails);
  const userPrompt = `${contextText}\n\n${actionPrompt}`;

  await sleep(getRandomDelay('voting'));

  let result = await callLLM({ systemPrompt, userPrompt, maxTokens: 500 });
  let parsed = result.success ? extractJSON(result.content) : null;
  let retried = false;

  if (!parsed || !isValidTarget(parsed.target, validCandidates)) {
    retried = true;
    result = await callLLM({
      systemPrompt,
      userPrompt: userPrompt + '\n\n注意：target 必须是提供的 userId 之一。不要输出 JSON 以外的内容。',
      maxTokens: 300,
    });
    parsed = result.success ? extractJSON(result.content) : null;
  }

  logAIDecision(state.roomId, {
    timestamp: new Date().toISOString(),
    aiUserId: aiPlayer.userId,
    aiRole: aiPlayer.role,
    phase: 'voting',
    round: state.round,
    prompt: userPrompt,
    response: result.content,
    parsedAction: parsed,
    retried,
    fallback: !parsed || !isValidTarget(parsed.target, validCandidates),
    error: result.error,
  });

  if (parsed && isValidTarget(parsed.target, validCandidates)) {
    return parsed.target;
  }

  // Fallback: 随机投
  return validCandidates[Math.floor(Math.random() * validCandidates.length)];
}

// ========== 特殊触发决策 ==========

export interface TriggerActionResult {
  action: string;
  target?: string;
}

export async function decideTriggerAction(
  state: GameState,
  room: Room,
  aiPlayer: GamePlayer,
  triggerType: 'hunter_shoot' | 'knight_duel' | 'wolf_king_drag',
  availableTargets: string[],
  extraInfo?: { canShoot?: boolean },
): Promise<TriggerActionResult> {
  const ctx = buildAIContext(state, room, aiPlayer);
  const contextText = contextToText(ctx);
  const systemPrompt = getSystemPrompt(ctx.nickname, ctx.seatNumber, ctx.role, ctx.faction);

  const targetDetails = availableTargets.map(userId => {
    const p = state.players.find(pl => pl.userId === userId);
    const nickname = room.players.find(rp => rp.userId === userId)?.nickname || '未知';
    return { userId, nickname, seatNumber: p?.seatNumber || 0 };
  });

  let actionPrompt: string;
  switch (triggerType) {
    case 'hunter_shoot':
      actionPrompt = getHunterPrompt(extraInfo?.canShoot ?? true, targetDetails);
      break;
    case 'knight_duel':
      actionPrompt = getKnightPrompt(targetDetails);
      break;
    case 'wolf_king_drag':
      actionPrompt = getWolfKingPrompt(targetDetails);
      break;
    default:
      return { action: 'skip' };
  }

  const userPrompt = `${contextText}\n\n${actionPrompt}`;

  await sleep(getRandomDelay('trigger'));

  const result = await callLLM({ systemPrompt, userPrompt, maxTokens: 400 });
  const parsed = result.success ? extractJSON(result.content) : null;

  logAIDecision(state.roomId, {
    timestamp: new Date().toISOString(),
    aiUserId: aiPlayer.userId,
    aiRole: aiPlayer.role,
    phase: triggerType,
    round: state.round,
    prompt: userPrompt,
    response: result.content,
    parsedAction: parsed,
    retried: false,
    fallback: !parsed,
    error: result.error,
  });

  if (parsed) {
    const action = typeof parsed.action === 'string' ? parsed.action : 'skip';
    const target = isValidTarget(parsed.target, availableTargets) ? parsed.target : undefined;
    return { action, target };
  }

  return { action: 'skip' };
}
