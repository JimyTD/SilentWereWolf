import type { GameState, GamePlayer, MarkReason } from '../../../shared/types/game';
import { ROLES, FACTIONS, COMMON_REASONS, SPECIAL_REASONS } from '../../../shared/constants';

/**
 * AI 决策语义校验层
 *
 * 设计原则：
 * 1. prompt 里的文字约束是"软约束"，模型可能忽略；本模块提供"硬约束"，代码层面保证不出现违背已知信息的决策。
 * 2. 只在决策明确违背 AI 自己的私有信息时才纠正，不干预正常的策略选择空间。
 * 3. 每次纠正都返回原因，便于日志追踪与调试（不要静默改写）。
 */

export interface GuardCorrection {
  field: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * 收集某个预言家已查验的结果
 */
export function collectSeerResults(state: GameState, aiPlayer: GamePlayer): Map<string, 'good' | 'evil'> {
  const results = new Map<string, 'good' | 'evil'>();
  if (aiPlayer.role !== ROLES.SEER) return results;

  for (const round of state.history.rounds) {
    if (round.seer?.target) {
      const target = state.players.find(p => p.userId === round.seer!.target);
      if (target) {
        results.set(target.userId, target.faction === FACTIONS.GOOD ? 'good' : 'evil');
      }
    }
  }
  return results;
}

/**
 * 收集守墓人已验尸的结果
 */
export function collectGravediggerResults(state: GameState, aiPlayer: GamePlayer): Map<string, 'good' | 'evil'> {
  const results = new Map<string, 'good' | 'evil'>();
  if (aiPlayer.role !== ROLES.GRAVEDIGGER) return results;

  for (const round of state.history.rounds) {
    if (round.gravedigger?.target) {
      const target = state.players.find(p => p.userId === round.gravedigger!.target);
      if (target) {
        results.set(target.userId, target.faction === FACTIONS.GOOD ? 'good' : 'evil');
      }
    }
  }
  return results;
}

/**
 * 获取 AI 的狼人队友 userId 集合
 */
export function getTeammateIds(state: GameState, aiPlayer: GamePlayer): Set<string> {
  if (aiPlayer.faction !== FACTIONS.EVIL) return new Set();
  return new Set(
    state.players
      .filter(p => p.faction === FACTIONS.EVIL && p.userId !== aiPlayer.userId)
      .map(p => p.userId),
  );
}

/**
 * 投票决策语义校验
 *
 * 硬约束（违背已知信息，必须纠正）：
 * - 预言家/守墓人：不得投票给自己查验为"好人"的玩家
 * - 狼人阵营：不得投票给队友（除场上只剩队友可投）
 *
 * 软倾向（有更优选择时改投）：
 * - 预言家/守墓人：若已查验出狼人且该狼人在候选中，应优先投他
 *
 * @returns 校验后的投票目标 + 纠正记录
 */
export function guardVote(
  state: GameState,
  aiPlayer: GamePlayer,
  chosen: string,
  validCandidates: string[],
): { target: string; corrections: GuardCorrection[] } {
  const corrections: GuardCorrection[] = [];
  let target = chosen;

  const seatOf = (userId: string): string => {
    const p = state.players.find(pl => pl.userId === userId);
    return p ? `${p.seatNumber}号` : userId.slice(0, 6);
  };

  // === 1. 查验类角色：绝不投已确认的好人 ===
  const verified = new Map<string, 'good' | 'evil'>([
    ...collectSeerResults(state, aiPlayer),
    ...collectGravediggerResults(state, aiPlayer),
  ]);

  if (verified.size > 0) {
    // 已查验出的狼人，且仍在候选列表中 → 最优目标
    const knownWolves = validCandidates.filter(c => verified.get(c) === 'evil');

    if (verified.get(target) === 'good') {
      // 违背硬约束：投了自己查验的好人
      const replacement = knownWolves.length > 0
        ? knownWolves[0]
        : validCandidates.find(c => verified.get(c) !== 'good');

      if (replacement) {
        corrections.push({
          field: 'vote',
          from: seatOf(target),
          to: seatOf(replacement),
          reason: '原目标是本人查验确认的好人，违背私有信息',
        });
        target = replacement;
      }
    } else if (knownWolves.length > 0 && !knownWolves.includes(target)) {
      // 软倾向：手上有确认的狼，却投了别人
      corrections.push({
        field: 'vote',
        from: seatOf(target),
        to: seatOf(knownWolves[0]),
        reason: '本人已查验出狼人且在候选中，应优先投出',
      });
      target = knownWolves[0];
    }
  }

  // === 2. 狼人阵营：不投队友 ===
  const teammates = getTeammateIds(state, aiPlayer);
  if (teammates.size > 0 && teammates.has(target)) {
    const nonTeammates = validCandidates.filter(c => !teammates.has(c));
    if (nonTeammates.length > 0) {
      // 优先投被标记为狼人次数最多的非队友（顺势推锅）
      const wolfMarks = countWolfMarks(state, nonTeammates);
      const sorted = [...nonTeammates].sort(
        (a, b) => (wolfMarks.get(b) || 0) - (wolfMarks.get(a) || 0),
      );
      corrections.push({
        field: 'vote',
        from: seatOf(target),
        to: seatOf(sorted[0]),
        reason: '原目标是狼人队友，违背阵营利益',
      });
      target = sorted[0];
    }
    // 若候选里全是队友，保留原选择（规则允许，属于必然情形）
  }

  return { target, corrections };
}

/**
 * 统计候选人被标记为"狼人"的次数
 */
export function countWolfMarks(state: GameState, candidates: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c, 0);

  for (const mark of state.history.marks) {
    for (const ev of mark.evaluationMarks) {
      if (ev.identity === '狼人' && counts.has(ev.target)) {
        counts.set(ev.target, (counts.get(ev.target) || 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * 夜间行动语义校验
 *
 * 硬约束：
 * - 狼人不得袭击队友
 * - 预言家不得重复查验同一目标（浪费回合）
 * - 守墓人不得重复验尸同一目标
 */
export function guardNightAction(
  state: GameState,
  aiPlayer: GamePlayer,
  action: string,
  target: string | undefined,
  validTargets: string[],
): { target: string | undefined; corrections: GuardCorrection[] } {
  const corrections: GuardCorrection[] = [];
  if (!target) return { target, corrections };

  const seatOf = (userId: string): string => {
    const p = state.players.find(pl => pl.userId === userId);
    return p ? `${p.seatNumber}号` : userId.slice(0, 6);
  };

  let result = target;

  // === 狼人不刀队友 ===
  if (action === 'attack') {
    const teammates = getTeammateIds(state, aiPlayer);
    if (teammates.has(result)) {
      const nonTeammates = validTargets.filter(t => !teammates.has(t));
      if (nonTeammates.length > 0) {
        const replacement = nonTeammates[Math.floor(Math.random() * nonTeammates.length)];
        corrections.push({
          field: 'night_attack',
          from: seatOf(result),
          to: seatOf(replacement),
          reason: '袭击目标是狼人队友',
        });
        result = replacement;
      }
    }
  }

  // === 预言家不重复查验 ===
  if (action === 'investigate') {
    const checked = collectSeerResults(state, aiPlayer);
    if (checked.has(result)) {
      const unchecked = validTargets.filter(t => !checked.has(t));
      if (unchecked.length > 0) {
        const replacement = unchecked[Math.floor(Math.random() * unchecked.length)];
        corrections.push({
          field: 'night_investigate',
          from: seatOf(result),
          to: seatOf(replacement),
          reason: '该目标已在此前查验过，重复查验浪费回合',
        });
        result = replacement;
      }
    }
  }

  // === 守墓人不重复验尸 ===
  if (action === 'autopsy') {
    const checked = collectGravediggerResults(state, aiPlayer);
    if (checked.has(result)) {
      const unchecked = validTargets.filter(t => !checked.has(t));
      if (unchecked.length > 0) {
        corrections.push({
          field: 'night_autopsy',
          from: seatOf(result),
          to: seatOf(unchecked[0]),
          reason: '该死者已验尸过，重复验尸浪费回合',
        });
        result = unchecked[0];
      }
    }
  }

  return { target: result, corrections };
}

/**
 * 猎人开枪 / 骑士决斗 语义校验
 * - 猎人：不应射杀自己查验过的好人（若猎人无查验能力则跳过）
 * - 骑士：不应决斗已被确认为好人的目标（决斗好人 = 自己出局）
 * - 白狼王：不应带走自己的队友
 */
export function guardTriggerAction(
  state: GameState,
  aiPlayer: GamePlayer,
  triggerType: string,
  target: string | undefined,
  validTargets: string[],
): { target: string | undefined; corrections: GuardCorrection[] } {
  const corrections: GuardCorrection[] = [];
  if (!target) return { target, corrections };

  const seatOf = (userId: string): string => {
    const p = state.players.find(pl => pl.userId === userId);
    return p ? `${p.seatNumber}号` : userId.slice(0, 6);
  };

  let result = target;

  // 白狼王不带走队友
  if (triggerType === 'wolf_king_drag') {
    const teammates = getTeammateIds(state, aiPlayer);
    if (teammates.has(result)) {
      const nonTeammates = validTargets.filter(t => !teammates.has(t));
      if (nonTeammates.length > 0) {
        corrections.push({
          field: 'wolf_king_drag',
          from: seatOf(result),
          to: seatOf(nonTeammates[0]),
          reason: '带走目标是狼人队友',
        });
        result = nonTeammates[0];
      }
    }
  }

  return { target: result, corrections };
}

/**
 * 标记评价语义校验（扩展原 enforceSeerConsistency）
 *
 * 硬约束：
 * - 查验类角色的评价必须与自己的查验结论一致
 * - 狼人阵营不得把队友标记为"狼人"
 * - 狼人阵营的身份声称不得为"狼人"
 */
export function guardMarking(
  state: GameState,
  aiPlayer: GamePlayer,
  identityMark: { identity: string; reason: MarkReason },
  evaluationMarks: { target: string; identity: string; reason: MarkReason }[],
): GuardCorrection[] {
  const corrections: GuardCorrection[] = [];

  const seatOf = (userId: string): string => {
    const p = state.players.find(pl => pl.userId === userId);
    return p ? `${p.seatNumber}号` : userId.slice(0, 6);
  };

  // === 1. 狼人不得自曝身份 ===
  if (aiPlayer.faction === FACTIONS.EVIL && identityMark.identity === '狼人') {
    corrections.push({
      field: 'identity',
      from: '狼人',
      to: '好人',
      reason: '狼人阵营自曝身份，立刻暴露',
    });
    identityMark.identity = '好人';
  }

  // === 2. 查验结论一致性 ===
  const verified = new Map<string, 'good' | 'evil'>([
    ...collectSeerResults(state, aiPlayer),
    ...collectGravediggerResults(state, aiPlayer),
  ]);

  for (const ev of evaluationMarks) {
    const v = verified.get(ev.target);
    if (!v) continue;
    const expected = v === 'good' ? '好人' : '狼人';
    if (ev.identity !== expected) {
      corrections.push({
        field: `eval:${seatOf(ev.target)}`,
        from: ev.identity,
        to: expected,
        reason: '与本人查验结论矛盾',
      });
      ev.identity = expected;
      ev.reason = SPECIAL_REASONS.INVESTIGATION as MarkReason;
    } else if (ev.reason !== SPECIAL_REASONS.INVESTIGATION) {
      // 结论对了但理由没用查验，属于信息浪费，一并修正
      ev.reason = SPECIAL_REASONS.INVESTIGATION as MarkReason;
    }
  }

  // === 3. 狼人不得指控队友为狼人 ===
  const teammates = getTeammateIds(state, aiPlayer);
  if (teammates.size > 0) {
    for (const ev of evaluationMarks) {
      if (teammates.has(ev.target) && ev.identity === '狼人') {
        corrections.push({
          field: `eval:${seatOf(ev.target)}`,
          from: '狼人',
          to: '好人',
          reason: '指控自己的狼人队友，等于自曝关系',
        });
        ev.identity = '好人';
        if (ev.reason === SPECIAL_REASONS.INVESTIGATION) {
          ev.reason = COMMON_REASONS.INTUITION as MarkReason;
        }
      }
    }
  }

  // === 4. 非查验角色不得使用 investigation 理由 ===
  const canInvestigate = aiPlayer.role === ROLES.SEER || aiPlayer.role === ROLES.GRAVEDIGGER;
  if (!canInvestigate) {
    if (identityMark.reason === SPECIAL_REASONS.INVESTIGATION) {
      corrections.push({
        field: 'identity_reason',
        from: 'investigation',
        to: 'intuition',
        reason: '本角色没有查验能力，不能使用查验结论作为理由',
      });
      identityMark.reason = COMMON_REASONS.INTUITION as MarkReason;
    }
    for (const ev of evaluationMarks) {
      if (ev.reason === SPECIAL_REASONS.INVESTIGATION) {
        corrections.push({
          field: `eval_reason:${seatOf(ev.target)}`,
          from: 'investigation',
          to: 'intuition',
          reason: '本角色没有查验能力，不能使用查验结论作为理由',
        });
        ev.reason = COMMON_REASONS.INTUITION as MarkReason;
      }
    }
  }

  // === 5. 非女巫不得使用 potion_result 理由 ===
  if (aiPlayer.role !== ROLES.WITCH) {
    if (identityMark.reason === SPECIAL_REASONS.POTION_RESULT) {
      identityMark.reason = COMMON_REASONS.INTUITION as MarkReason;
      corrections.push({
        field: 'identity_reason',
        from: 'potion_result',
        to: 'intuition',
        reason: '本角色没有用药能力',
      });
    }
    for (const ev of evaluationMarks) {
      if (ev.reason === SPECIAL_REASONS.POTION_RESULT) {
        ev.reason = COMMON_REASONS.INTUITION as MarkReason;
        corrections.push({
          field: `eval_reason:${seatOf(ev.target)}`,
          from: 'potion_result',
          to: 'intuition',
          reason: '本角色没有用药能力',
        });
      }
    }
  }

  return corrections;
}
