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
import {
  guardVote,
  guardNightAction,
  guardMarking,
  guardTriggerAction,
} from './AIDecisionGuard';

import { getPersona, type AIPersona } from './AIPersona';



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

function getRandomDelay(type: string, maxTimeout?: number, persona?: AIPersona): number {
  const [min, max] = DELAY_RANGES[type] || [2000, 5000];

  // 基础延迟：改用偏向短耗时的分布（两次随机取小值），
  // 使多数决策偏快、少数偏慢，比均匀分布更接近真人的长尾反应时间。
  const r = Math.min(Math.random(), Math.random());
  let delay = min + r * (max - min);

  // 人格节奏：急性子整体偏快，谨慎型整体偏慢
  if (persona) {
    delay *= persona.paceFactor;
  }

  // 少量异常值：真人偶尔会突然秒交或长时间卡住
  const dice = Math.random();
  if (dice < 0.05) {
    delay *= 0.3; // 突然快速决策
  } else if (dice > 0.96) {
    delay *= 1.8; // 突然卡住
  }

  delay = Math.max(800, Math.floor(delay));

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

type TargetDetail = { userId: string; nickname: string; seatNumber: number };

function targetUserIdFromSeat(target: unknown, targets: TargetDetail[]): string | undefined {
  const seatNumber = typeof target === 'number'
    ? target
    : typeof target === 'string' && /^\\d+$/.test(target)
      ? Number(target)
      : NaN;
  if (!Number.isInteger(seatNumber)) return undefined;
  return targets.find(t => t.seatNumber === seatNumber)?.userId;
}

function normalizeTarget(parsed: Record<string, unknown> | null, targets: TargetDetail[]): Record<string, unknown> | null {
  if (!parsed) return null;
  if (parsed.target === null) return parsed;
  return { ...parsed, target: targetUserIdFromSeat(parsed.target, targets) };
}

function normalizeEvaluationTargets(
  parsed: Record<string, unknown> | null,
  targets: TargetDetail[],
): Record<string, unknown> | null {
  if (!parsed || !Array.isArray(parsed.evaluations)) return parsed;
  const evaluations = parsed.evaluations.map(raw => {
    if (!raw || typeof raw !== 'object') return raw;
    const evaluation = raw as Record<string, unknown>;
    return { ...evaluation, target: targetUserIdFromSeat(evaluation.target, targets) };
  });
  return { ...parsed, evaluations };
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

  const systemPrompt = getSystemPrompt(ctx.seatNumber, ctx.role, ctx.faction, room.settings.winCondition);

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
      victimSeat: victimPlayer?.seatNumber,
    };
  }

  const actionPrompt = getNightActionPrompt(promptParams);
  const userPrompt = `${contextText}\n\n${actionPrompt}`;

  // 模拟思考延迟
  await sleep(getRandomDelay('night', undefined, getPersona(state.roomId, aiPlayer.userId)));


  // 调用 LLM
  let result = await callLLM({ systemPrompt, userPrompt, maxTokens: 500 });
  let parsed = result.success ? normalizeTarget(extractJSON(result.content), targetDetails) : null;
  let retried = false;
  let fallback = false;

  // 重试一次
  if (!parsed || (!isValidTarget(parsed.target, availableTargets) && aiPlayer.role !== ROLES.WITCH && parsed.target !== null)) {
    retried = true;
    result = await callLLM({
      systemPrompt,
      userPrompt: userPrompt + '\n\n注意：你必须严格返回合法的 JSON，target 必须是提供的座位号之一（数字）。不要输出 JSON 以外的内容。',
      maxTokens: 300,
    });
    parsed = result.success ? normalizeTarget(extractJSON(result.content), targetDetails) : null;
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
    const built = buildNightActionResult(aiPlayer.role, parsed, availableTargets);
    const { target, corrections } = guardNightAction(
      state,
      aiPlayer,
      built.action,
      built.target,
      availableTargets,
    );
    if (corrections.length > 0) {
      console.warn(
        `[AIGuard] ${ctx.seatNumber}号${ctx.nickname} 夜间行动被纠正：` +
        corrections.map(c => `${c.from}→${c.to}(${c.reason})`).join('; '),
      );
      built.target = target;
    }
    return built;
  }


  // Fallback
  fallback = true;
  console.warn(`[AIController] ${ctx.nickname} 夜晚行动 fallback`);
  return fallbackNightAction(aiPlayer.role, availableTargets, witchInfo, state);
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

export function fallbackNightAction(
  role: string,
  validTargets: string[],
  witchInfo?: { victim: string | null; hasAntidote: boolean; hasPoison: boolean; canSelfSave: boolean },
  state?: GameState,
): NightActionResult {
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
      // 女巫用药属于可选行动，模型失败或超时时默认不使用药物。
      return { action: 'usePotion', potion: 'none' };
    case ROLES.GUARD:
      return { action: 'guard', target: randomTarget };
    case ROLES.GRAVEDIGGER:
      return randomTarget
        ? { action: 'autopsy', target: randomTarget }
        : { action: 'autopsy' };
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
  const systemPrompt = getSystemPrompt(ctx.seatNumber, ctx.role, ctx.faction, room.settings.winCondition);

  // 可评价的目标（排除自己）
  const targets = state.players
    .filter(p => p.alive && p.userId !== aiPlayer.userId)
    .map(p => ({
      userId: p.userId,
      nickname: room.players.find(rp => rp.userId === p.userId)?.nickname || '未知',
      seatNumber: p.seatNumber,
    }));

  // 根据实际历史数据动态提供可选理由，避免AI在无数据时凭空使用分析类理由
  const availableReasons = ['直觉判断(intuition)'];
  if (state.history.votes.length > 0) {
    availableReasons.push('投票分析(vote_analysis)');
  }
  if (state.history.marks.length > 0) {
    availableReasons.push('标记分析(mark_analysis)');
  }
  if (state.history.deaths.length > 0) {
    availableReasons.push('日志推理(log_reasoning)');
  }
  // 特殊理由仅对应角色可用
  if (aiPlayer.role === ROLES.SEER || aiPlayer.role === ROLES.GRAVEDIGGER) {
    availableReasons.push('查验结论(investigation)');
  }
  if (aiPlayer.role === ROLES.WITCH) {
    availableReasons.push('用药结果(potion_result)');
  }

  const persona = getPersona(state.roomId, aiPlayer.userId);
  const actionPrompt = getMarkingPrompt({
    evaluationMarkCount,
    availableIdentities,
    availableTargets: targets,
    availableReasons,
    analysisPreference: persona.analysisPreference,
  });

  const userPrompt = `${contextText}\n\n${actionPrompt}`;

  await sleep(getRandomDelay('marking', undefined, persona));


  let result = await callLLM({ systemPrompt, userPrompt, maxTokens: 1000 });
  let parsed = result.success ? normalizeEvaluationTargets(extractJSON(result.content), targets) : null;
  let retried = false;

  // 校验是否需要重试：结构不完整、评价目标无效，或狼人声称了"狼人"
  const needsRetry = (p: Record<string, unknown> | null): boolean => {
    if (!p || !p.identity || !Array.isArray(p.evaluations)) return true;
    // 狼人声称身份为"狼人"是致命错误
    if (aiPlayer.faction === 'evil' && p.identity === '狼人') return true;
    // 检查评价目标是否已映射为合法 userId
    const validTargetIds = targets.map(t => t.userId);
    const evals = p.evaluations as Array<Record<string, unknown>>;
    const validEvalCount = evals.filter(e => validTargetIds.includes(e.target as string)).length;
    if (validEvalCount === 0 && evals.length > 0) return true;
    return false;
  };

  if (needsRetry(parsed)) {
    retried = true;
    let retryHint = '\n\n注意：必须返回合法 JSON，包含 analysis、identity、reason、evaluations 字段。evaluations 是数组。不要输出 JSON 以外的内容。';
    retryHint += '\n⚠️ evaluations 中的 target 必须是可选列表中的座位号数字，不要填写昵称、userId 或其他字符串。';
    if (aiPlayer.faction === 'evil') {
      retryHint += '\n⚠️ 你是狼人阵营，identity 字段绝对不能填 "狼人"，必须伪装成好人阵营的身份。';
    }
    result = await callLLM({
      systemPrompt,
      userPrompt: userPrompt + retryHint,
      maxTokens: 800,
    });
    parsed = result.success ? normalizeEvaluationTargets(extractJSON(result.content), targets) : null;
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
    const markResult = buildMarkingResult(parsed, targets, evaluationMarkCount, availableIdentities, state, aiPlayer, persona);

    // 语义校验：狼人自曝、查验矛盾、指控队友、越权理由
    const corrections = guardMarking(
      state,
      aiPlayer,
      markResult.identityMark,
      markResult.evaluationMarks,
    );
    if (corrections.length > 0) {
      console.warn(
        `[AIGuard] ${ctx.seatNumber}号${ctx.nickname} 标记被纠正：` +
        corrections.map(c => `${c.field} ${c.from}→${c.to}(${c.reason})`).join('; '),
      );
    }
    return markResult;
  }


  // Fallback
  return fallbackMarking(aiPlayer, targets, evaluationMarkCount, availableIdentities, state);
}

// 中文理由→英文key映射，容错AI返回中文的情况

const REASON_CN_TO_EN: Record<string, string> = {
  '直觉判断': COMMON_REASONS.INTUITION,
  '投票分析': COMMON_REASONS.VOTE_ANALYSIS,
  '标记分析': COMMON_REASONS.MARK_ANALYSIS,
  '日志推理': COMMON_REASONS.LOG_REASONING,
  '查验结论': SPECIAL_REASONS.INVESTIGATION,
  '用药结果': SPECIAL_REASONS.POTION_RESULT,
};

function normalizeReason(raw: string, validReasons: string[]): MarkReason {
  if (validReasons.includes(raw)) return raw as MarkReason;
  // 尝试中文映射
  const mapped = REASON_CN_TO_EN[raw];
  if (mapped && validReasons.includes(mapped)) return mapped as MarkReason;
  // 尝试从 "查验结论(investigation)" 格式中提取英文key
  const match = raw.match(/\((\w+)\)/);
  if (match && validReasons.includes(match[1])) return match[1] as MarkReason;
  return COMMON_REASONS.INTUITION as MarkReason;
}

function buildMarkingResult(
  parsed: Record<string, unknown>,
  targets: { userId: string; nickname: string; seatNumber: number }[],
  evalCount: number,
  availableIdentities: string[],
  state?: GameState,
  aiPlayer?: GamePlayer,
  persona?: AIPersona,
): MarkingResult {

  const validReasons: string[] = [...Object.values(COMMON_REASONS), ...Object.values(SPECIAL_REASONS)];

  const fallbackIdentity = availableIdentities.includes('好人')
    ? '好人'
    : (availableIdentities[0] || '好人');
  const identity = typeof parsed.identity === 'string' && availableIdentities.includes(parsed.identity)
    ? parsed.identity
    : fallbackIdentity;
  const parsedReason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const reason: MarkReason = normalizeReason(parsedReason, validReasons);
  const evaluationIdentities = new Set([...availableIdentities, '狼人']);

  const evaluations = (parsed.evaluations as Array<Record<string, unknown>>)
    .slice(0, evalCount)
    .filter(e => targets.some(t => t.userId === e.target))
    .map(e => {
      const eReason = typeof e.reason === 'string' ? e.reason : '';
      const rawIdentity = typeof e.identity === 'string' ? e.identity : '';
      return {
        target: e.target as string,
        identity: evaluationIdentities.has(rawIdentity) ? rawIdentity : fallbackIdentity,
        reason: normalizeReason(eReason, validReasons),
      };
    });

  // === 补齐评价数量 ===
  // 旧实现按数组顺序 shift() 并硬编码「好人 + 直觉判断」，导致理由分布异常集中、
  // 评价目标呈现固定顺序。改为：按场上嫌疑度排序挑选目标，并根据可用历史数据选择合理理由。
  const usedTargets = new Set(evaluations.map(e => e.target));
  let remaining = targets.filter(t => !usedTargets.has(t.userId));

  if (remaining.length > 0 && evaluations.length < evalCount) {
    // 统计被标记为"狼人"的次数，作为注意力权重
    const suspicion = new Map<string, number>();
    if (state) {
      for (const mark of state.history.marks) {
        for (const ev of mark.evaluationMarks) {
          if (ev.identity === '狼人') {
            suspicion.set(ev.target, (suspicion.get(ev.target) || 0) + 1);
          }
        }
      }
    }
    // 真人的注意力是有偏的：先评价自己更"在意"的人，而不是按 userId 顺序
    remaining = remaining.sort((a, b) => {
      const diff = (suspicion.get(b.userId) || 0) - (suspicion.get(a.userId) || 0);
      return diff !== 0 ? diff : Math.random() - 0.5;
    });

    // 依据实际可用的历史数据挑理由，避免无脑 intuition
    const usableReasons: MarkReason[] = [COMMON_REASONS.INTUITION as MarkReason];
    if (state && state.history.votes.length > 0) {
      usableReasons.push(COMMON_REASONS.VOTE_ANALYSIS as MarkReason);
    }
    if (state && state.history.marks.length > 0) {
      usableReasons.push(COMMON_REASONS.MARK_ANALYSIS as MarkReason);
    }
    if (state && state.history.deaths.length > 0) {
      usableReasons.push(COMMON_REASONS.LOG_REASONING as MarkReason);
    }

    const teammateIds = new Set<string>(
      state && aiPlayer && aiPlayer.faction === 'evil'
        ? state.players.filter(p => p.faction === 'evil' && p.userId !== aiPlayer.userId).map(p => p.userId)
        : [],
    );

    while (evaluations.length < evalCount && remaining.length > 0) {
      const t = remaining.shift()!;
      const sus = suspicion.get(t.userId) || 0;
      // 队友一律标好人；其余按嫌疑度给出有倾向但不绝对的判断
      let evalIdentity = '好人';
      if (!teammateIds.has(t.userId)) {
        if (sus >= 2) {
          evalIdentity = Math.random() < 0.55 ? '狼人' : '好人';
        } else if (sus === 1) {
          evalIdentity = Math.random() < 0.25 ? '狼人' : '好人';
        }
      }
      // 理由选择受人格直觉倾向影响：直觉型多用"直觉判断"，分析型多用分析类理由
      const bias = persona ? persona.intuitionBias : 0.25;
      let pickedReason: MarkReason;
      if (Math.random() < bias) {
        pickedReason = COMMON_REASONS.INTUITION as MarkReason;
      } else if (sus > 0 && usableReasons.includes(COMMON_REASONS.MARK_ANALYSIS as MarkReason)) {
        pickedReason = COMMON_REASONS.MARK_ANALYSIS as MarkReason;
      } else {
        const analytical = usableReasons.filter(r => r !== COMMON_REASONS.INTUITION);
        pickedReason = analytical.length > 0
          ? analytical[Math.floor(Math.random() * analytical.length)]
          : (COMMON_REASONS.INTUITION as MarkReason);
      }


      evaluations.push({
        target: t.userId,
        identity: evalIdentity,
        reason: pickedReason,
      });
    }
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


export function fallbackMarking(
  aiPlayer: GamePlayer,
  targets: { userId: string; nickname: string; seatNumber: number }[],
  evalCount: number,
  availableIdentities: string[],
  state?: GameState,
): MarkingResult {
  const shuffled = [...targets].sort(() => Math.random() - 0.5);

  // 从通用理由中随机选一个（不总是 intuition）
  const commonReasons: MarkReason[] = [
    COMMON_REASONS.INTUITION,
    COMMON_REASONS.VOTE_ANALYSIS,
    COMMON_REASONS.MARK_ANALYSIS,
    COMMON_REASONS.LOG_REASONING,
  ];
  const pickReason = (): MarkReason => commonReasons[Math.floor(Math.random() * commonReasons.length)];

  // 自报身份：好人阵营随机选 "好人" 或具体身份（但神职不轻易暴露）
  // 狼人阵营随机选 "好人" 或 "平民" 伪装
  let identity: string;
  if (aiPlayer.faction === 'good') {
    // 好人阵营：平民直说，神职一般隐藏（30%概率暴露真实身份）
    if (aiPlayer.role === ROLES.VILLAGER) {
      identity = Math.random() < 0.5 ? '平民' : '好人';
    } else {
      identity = Math.random() < 0.3 ? aiPlayer.role : '好人';
    }
  } else {
    // 狼人阵营伪装：随机选平民或好人
    identity = Math.random() < 0.6 ? '平民' : '好人';
  }

  // 基于历史标记统计"被标记为狼人"次数，作为嫌疑参考
  const suspicionCount = new Map<string, number>();
  if (state) {
    for (const mark of state.history.marks) {
      for (const ev of mark.evaluationMarks) {
        if (ev.identity === '狼人') {
          suspicionCount.set(ev.target, (suspicionCount.get(ev.target) || 0) + 1);
        }
      }
    }
  }

  const evaluations: EvaluationMark[] = [];
  const evalTargets = shuffled.slice(0, evalCount);

  if (aiPlayer.faction === 'evil') {
    // 狼人兜底：随机标记 1 个非队友为"狼人"带节奏，其余标记为好人
    const nonTeammates = evalTargets.filter(t => {
      if (!state) return true;
      const tp = state.players.find(p => p.userId === t.userId);
      return tp?.faction !== 'evil';
    });
    const accuseTarget = nonTeammates.length > 0
      ? nonTeammates[Math.floor(Math.random() * nonTeammates.length)]
      : null;

    for (const t of evalTargets) {
      if (accuseTarget && t.userId === accuseTarget.userId && Math.random() < 0.6) {
        evaluations.push({ target: t.userId, identity: '狼人', reason: pickReason() });
      } else {
        evaluations.push({ target: t.userId, identity: '好人', reason: pickReason() });
      }
    }
  } else {
    // 好人兜底：根据嫌疑度决定标记
    for (const t of evalTargets) {
      const sus = suspicionCount.get(t.userId) || 0;
      // 被多人标记为狼人的目标，有更高概率也标记为狼人
      if (sus >= 2 && Math.random() < 0.5) {
        evaluations.push({ target: t.userId, identity: '狼人', reason: COMMON_REASONS.MARK_ANALYSIS });
      } else if (sus >= 1 && Math.random() < 0.3) {
        evaluations.push({ target: t.userId, identity: '狼人', reason: pickReason() });
      } else {
        evaluations.push({ target: t.userId, identity: '好人', reason: pickReason() });
      }
    }
  }

  return {
    identityMark: { identity, reason: pickReason() },
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
  const systemPrompt = getSystemPrompt(ctx.seatNumber, ctx.role, ctx.faction, room.settings.winCondition);

  // 不能投自己
  const validCandidates = candidates.filter(c => c !== aiPlayer.userId);
  const targetDetails = validCandidates.map(userId => {
    const p = state.players.find(pl => pl.userId === userId);
    const nickname = room.players.find(rp => rp.userId === userId)?.nickname || '未知';
    return { userId, nickname, seatNumber: p?.seatNumber || 0 };
  });

  const persona = getPersona(state.roomId, aiPlayer.userId);
  const actionPrompt = getVotingPrompt(targetDetails, {
    seatNumber: ctx.seatNumber,
  }, persona.analysisPreference);
  const userPrompt = `${contextText}\n\n${actionPrompt}`;

  await sleep(getRandomDelay('voting', undefined, persona));


  let result = await callLLM({ systemPrompt, userPrompt, maxTokens: 500 });
  let parsed = result.success ? normalizeTarget(extractJSON(result.content), targetDetails) : null;
  let retried = false;

  if (!parsed || !isValidTarget(parsed.target, validCandidates)) {
    retried = true;
    result = await callLLM({
      systemPrompt,
      userPrompt: userPrompt + '\n\n注意：target 必须是提供的座位号之一（数字）。不要输出 JSON 以外的内容。',
      maxTokens: 300,
    });
    parsed = result.success ? normalizeTarget(extractJSON(result.content), targetDetails) : null;
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
    // 语义校验：LLM 返回了合法格式，但决策可能违背自己的私有信息
    const { target, corrections } = guardVote(state, aiPlayer, parsed.target, validCandidates);
    if (corrections.length > 0) {
      console.warn(
        `[AIGuard] ${ctx.seatNumber}号${ctx.nickname} 投票被纠正：` +
        corrections.map(c => `${c.from}→${c.to}(${c.reason})`).join('; '),
      );
    }
    return target;
  }


  // Fallback: 基于策略投票而非纯随机
  return fallbackVote(state, aiPlayer, validCandidates);
}

/**
 * 投票兜底策略：
 * - 狼人：不投队友，优先投被标记为狼人次数最少（被好人保护）的非队友
 * - 好人：优先投被多人标记为狼人的目标
 */
export function fallbackVote(state: GameState, aiPlayer: GamePlayer, validCandidates: string[]): string {
  // 统计每个候选人被标记为"狼人"的次数
  const wolfMarkCount = new Map<string, number>();
  for (const cand of validCandidates) {
    wolfMarkCount.set(cand, 0);
  }
  for (const mark of state.history.marks) {
    for (const ev of mark.evaluationMarks) {
      if (ev.identity === '狼人' && wolfMarkCount.has(ev.target)) {
        wolfMarkCount.set(ev.target, (wolfMarkCount.get(ev.target) || 0) + 1);
      }
    }
  }

  if (aiPlayer.faction === 'evil') {
    // 狼人：排除队友，从剩余候选中随机投
    const nonTeammates = validCandidates.filter(c => {
      const p = state.players.find(pl => pl.userId === c);
      return p?.faction !== 'evil';
    });
    const pool = nonTeammates.length > 0 ? nonTeammates : validCandidates;
    // 优先投被多人标记为好人（嫌疑低→对狼人威胁大）的目标，加一点随机性
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // 好人：优先投被标记为狼人次数最多的候选人
  const sorted = [...validCandidates].sort((a, b) => {
    return (wolfMarkCount.get(b) || 0) - (wolfMarkCount.get(a) || 0);
  });
  // 最高嫌疑值
  const maxSus = wolfMarkCount.get(sorted[0]) || 0;
  if (maxSus > 0) {
    // 在最高嫌疑的人中随机选一个
    const topSuspects = sorted.filter(c => (wolfMarkCount.get(c) || 0) === maxSus);
    return topSuspects[Math.floor(Math.random() * topSuspects.length)];
  }

  // 没有任何人被标记为狼人，随机投
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
  const systemPrompt = getSystemPrompt(ctx.seatNumber, ctx.role, ctx.faction, room.settings.winCondition);

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

  await sleep(getRandomDelay('trigger', undefined, getPersona(state.roomId, aiPlayer.userId)));


  const result = await callLLM({ systemPrompt, userPrompt, maxTokens: 400 });
  const parsed = result.success ? normalizeTarget(extractJSON(result.content), targetDetails) : null;

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
    const rawTarget = isValidTarget(parsed.target, availableTargets) ? parsed.target : undefined;
    const { target, corrections } = guardTriggerAction(
      state,
      aiPlayer,
      triggerType,
      rawTarget,
      availableTargets,
    );
    if (corrections.length > 0) {
      console.warn(
        `[AIGuard] ${ctx.seatNumber}号${ctx.nickname} ${triggerType} 被纠正：` +
        corrections.map(c => `${c.from}→${c.to}(${c.reason})`).join('; '),
      );
    }
    return { action, target };
  }


  return { action: 'skip' };
}
