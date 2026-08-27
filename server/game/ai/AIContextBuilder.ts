import type { GameState, GamePlayer, WitchState, GuardState } from '../../../shared/types/game';
import type { Room } from '../../../shared/types/room';
import { ROLES, FACTIONS } from '../../../shared/constants';

/**
 * AI 信息上下文构建器
 * 严格按角色身份过滤信息，确保 AI 不能"开天眼"
 * 这是 AI 获取游戏信息的唯一出口
 */

export interface AIPlayerRef {
  userId: string;
  nickname: string;
  seatNumber: number;
}

export interface AIContext {
  // AI 自身真实身份，不能与公开信息混淆
  self: {
    userId: string;
    nickname: string;
    seatNumber: number;
    role: string;
    faction: string;
  };

  // 所有玩家可见的系统事实
  publicFacts: {
    round: number;
    phase: string;
    alivePlayers: AIPlayerRef[];
    deadPlayers: { userId: string; nickname: string; seatNumber: number; cause: string; round: number; relics: string[] }[];
    voteHistory: { round: number; votes: { voter: string; voterNickname: string; voterSeat: number; target: string; targetNickname: string; targetSeat: number }[]; exiled: number | null }[];
  };

  // 只对当前 AI 可见的系统事实，按真实角色填充
  privateFacts: {
    teammates: AIPlayerRef[];
    investigations: { round: number; kind: 'seer' | 'gravedigger'; targetSeat: number; faction: 'good' | 'evil' }[];
    witch: {
      antidoteUsed: boolean;
      poisonUsed: boolean;
      currentVictimSeat: number | null;
      potionHistory: { round: number; potion: 'antidote' | 'poison'; targetSeat: number | null }[];
    } | null;
    lastGuardTargetSeat: number | null;
    wolfAttacks: { round: number; targetSeat: number }[];
    hunterCanShoot: boolean | null;
    knightDuelUsed: boolean | null;
    foolImmunityUsed: boolean | null;
  };

  // 玩家公开提交的声明与判断，不代表系统确认的身份或阵营
  playerClaims: {
    marks: { round: number; player: string; playerNickname: string; seatNumber: number; identity: string; reason: string; evaluations: { target: string; targetNickname: string; targetSeat: number; identity: string; reason: string }[] }[];
  };
}

function getNickname(room: Room, userId: string): string {
  return room.players.find(p => p.userId === userId)?.nickname || '未知';
}

function getSeatNumber(state: GameState, userId: string): number {
  return state.players.find(p => p.userId === userId)?.seatNumber || 0;
}

/**
 * 构建 AI 可见的信息上下文
 */
export function buildAIContext(state: GameState, room: Room, aiPlayer: GamePlayer): AIContext {
  const ctx: AIContext = {
    self: {
      userId: aiPlayer.userId,
      nickname: getNickname(room, aiPlayer.userId),
      seatNumber: aiPlayer.seatNumber,
      role: aiPlayer.role,
      faction: aiPlayer.faction,
    },
    publicFacts: {
      round: state.round,
      phase: state.phase,
      alivePlayers: [],
      deadPlayers: [],
      voteHistory: [],
    },
    privateFacts: {
      teammates: [],
      investigations: [],
      witch: null,
      lastGuardTargetSeat: null,
      wolfAttacks: [],
      hunterCanShoot: null,
      knightDuelUsed: null,
      foolImmunityUsed: null,
    },
    playerClaims: {
      marks: [],
    },
  };

  // === 公开信息 ===

  // 存活玩家
  ctx.publicFacts.alivePlayers = state.players
    .filter(p => p.alive)
    .map(p => ({
      userId: p.userId,
      nickname: getNickname(room, p.userId),
      seatNumber: p.seatNumber,
    }))
    .sort((a, b) => a.seatNumber - b.seatNumber);

  // 死亡记录
  ctx.publicFacts.deadPlayers = state.history.deaths.map(d => ({
    userId: d.userId,
    nickname: getNickname(room, d.userId),
    seatNumber: d.seatNumber,
    cause: d.cause,
    round: d.round,
    relics: d.relics
      .filter(r => r.revealed)
      .map(r => `${r.type}(${r.value})`),
  }));

  // 标记历史
  ctx.playerClaims.marks = state.history.marks.map(m => ({
    round: m.round,
    player: m.player,
    playerNickname: getNickname(room, m.player),
    seatNumber: getSeatNumber(state, m.player),
    identity: m.identityMark.identity,
    reason: m.identityMark.reason,
    evaluations: m.evaluationMarks.map(e => ({
      target: e.target,
      targetNickname: getNickname(room, e.target),
      targetSeat: getSeatNumber(state, e.target),
      identity: e.identity,
      reason: e.reason,
    })),
  }));

  // 投票历史
  ctx.publicFacts.voteHistory = state.history.votes.map((roundVotes, i) => {
    // 找出该轮被放逐的人
    const deaths = state.history.deaths.filter(d => d.cause === 'exiled' && d.round === i + 1);
    const exiled = deaths.length > 0 ? deaths[0].seatNumber : null;

    return {
      round: i + 1,
      votes: roundVotes.map(v => ({
        voter: v.voter,
        voterNickname: getNickname(room, v.voter),
        voterSeat: getSeatNumber(state, v.voter),
        target: v.target,
        targetNickname: getNickname(room, v.target),
        targetSeat: getSeatNumber(state, v.target),
      })),
      exiled,
    };
  });

  // === 阵营信息 ===
  if (aiPlayer.faction === FACTIONS.EVIL) {
    ctx.privateFacts.teammates = state.players
      .filter(p => p.faction === FACTIONS.EVIL && p.userId !== aiPlayer.userId)
      .map(p => ({
        userId: p.userId,
        nickname: getNickname(room, p.userId),
        seatNumber: p.seatNumber,
      }));
  }

  // === 角色私有信息 ===
  buildPrivateInfo(ctx, state, room, aiPlayer);

  return ctx;
}

/**
 * 按角色构建私有信息
 */
function buildPrivateInfo(ctx: AIContext, state: GameState, _room: Room, aiPlayer: GamePlayer): void {
  const role = aiPlayer.role;

  switch (role) {
    case ROLES.SEER:
    case ROLES.GRAVEDIGGER: {
      const kind = role === ROLES.SEER ? 'seer' : 'gravedigger';
      const actionKey = role === ROLES.SEER ? 'seer' : 'gravedigger';
      for (let i = 0; i < state.history.rounds.length; i++) {
        const nightAction = state.history.rounds[i];
        const targetId = nightAction[actionKey]?.target;
        if (!targetId) continue;
        const target = state.players.find(p => p.userId === targetId);
        if (target) {
          ctx.privateFacts.investigations.push({
            round: i + 1,
            kind,
            targetSeat: target.seatNumber,
            faction: target.faction,
          });
        }
      }
      break;
    }

    case ROLES.WITCH: {
      const witchState = aiPlayer.roleState as WitchState;
      const currentVictim = state.nightActions.wolves?.target
        ? state.players.find(p => p.userId === state.nightActions.wolves!.target)
        : undefined;
      const potionHistory: { round: number; potion: 'antidote' | 'poison'; targetSeat: number | null }[] = [];
      for (let i = 0; i < state.history.rounds.length; i++) {
        const nightAction = state.history.rounds[i];
        if (!nightAction.witch || nightAction.witch.action === 'none') continue;
        potionHistory.push({
          round: i + 1,
          potion: nightAction.witch.action,
          targetSeat: nightAction.witch.target ? getSeatNumber(state, nightAction.witch.target) : null,
        });
      }
      ctx.privateFacts.witch = {
        antidoteUsed: witchState.antidoteUsed,
        poisonUsed: witchState.poisonUsed,
        currentVictimSeat: currentVictim?.seatNumber ?? null,
        potionHistory,
      };
      break;
    }

    case ROLES.GUARD: {
      const guardState = aiPlayer.roleState as GuardState;
      ctx.privateFacts.lastGuardTargetSeat = guardState.lastGuardTarget
        ? getSeatNumber(state, guardState.lastGuardTarget)
        : null;
      break;
    }

    case ROLES.WEREWOLF:
    case ROLES.WOLF_KING: {
      for (let i = 0; i < state.history.rounds.length; i++) {
        const target = state.history.rounds[i].wolves?.target;
        if (target) {
          ctx.privateFacts.wolfAttacks.push({
            round: i + 1,
            targetSeat: getSeatNumber(state, target),
          });
        }
      }
      break;
    }

    case ROLES.HUNTER: {
      const hunterState = aiPlayer.roleState as { canShoot: boolean };
      ctx.privateFacts.hunterCanShoot = hunterState.canShoot;
      break;
    }

    case ROLES.KNIGHT: {
      const knightState = aiPlayer.roleState as { duelUsed: boolean };
      ctx.privateFacts.knightDuelUsed = knightState.duelUsed;
      break;
    }

    case ROLES.FOOL: {
      const foolState = aiPlayer.roleState as { immunityUsed: boolean };
      ctx.privateFacts.foolImmunityUsed = foolState.immunityUsed;
      break;
    }

    default:
      break;
  }
}

/**
 * 将 AIContext 转换为人类可读的文本（用于 LLM prompt）
 */
export function contextToText(ctx: AIContext): string {
  const lines: string[] = [];
  const publicFacts = ctx.publicFacts;
  const privateFacts = ctx.privateFacts;

  lines.push('=== 你的真实身份（仅你可知） ===');
  lines.push(`你是 ${ctx.self.seatNumber}号玩家，身份：${roleLabel(ctx.self.role)}，阵营：${ctx.self.faction === 'good' ? '好人' : '狼人'}`);
  lines.push('');

  lines.push('=== 公开系统事实（所有玩家可见，以此为准） ===');
  lines.push(`第 ${publicFacts.round} 轮，当前阶段：${phaseLabel(publicFacts.phase)}`);
  lines.push('存活玩家：');
  for (const p of publicFacts.alivePlayers) {
    lines.push(`${p.seatNumber}号玩家${p.userId === ctx.self.userId ? '（你）' : ''}`);
  }
  if (publicFacts.deadPlayers.length > 0) {
    lines.push('死亡记录：');
    for (const d of publicFacts.deadPlayers) {
      const relicStr = d.relics.length > 0 ? `，遗物：${d.relics.map(relicLabel).join('、')}` : '';
      lines.push(`第${d.round}轮 ${d.seatNumber}号玩家 ${causeLabel(d.cause)}${relicStr}`);
    }
    if (publicFacts.deadPlayers.some(d => d.relics.length > 0)) {
      lines.push('（遗物说明：月光石数值=该玩家被夜间行动造访的总次数，包括被刀、被查验、被守护、被用药；天平徽章"平衡"=左右邻座同阵营，"失衡"=左右邻座不同阵营；猎犬哨数值=该玩家死亡时存活的狼人数量）');
    }
  }
  if (publicFacts.voteHistory.length > 0) {
    lines.push('投票记录：');
    for (const v of publicFacts.voteHistory) {
      const voteSummary = v.votes
        .map(vote => `${vote.voterSeat}号→${vote.targetSeat}号`)
        .join('，');
      const result = v.exiled ? `→ ${v.exiled}号玩家被放逐` : '→ 平票无人出局';
      lines.push(`第${v.round}轮：${voteSummary} ${result}`);
    }
  }
  lines.push('');

  const privateLines: string[] = [];
  if (privateFacts.teammates.length > 0) {
    privateLines.push(`狼人队友：${privateFacts.teammates.map(t => `${t.seatNumber}号玩家`).join('、')}`);
  }
  for (const result of privateFacts.investigations) {
    privateLines.push(`第${result.round}轮${result.kind === 'seer' ? '查验' : '验尸'}：${result.targetSeat}号玩家 → ${result.faction === 'good' ? '好人' : '狼人'}阵营`);
  }
  if (privateFacts.witch) {
    privateLines.push(`解药：${privateFacts.witch.antidoteUsed ? '已使用' : '未使用'}`);
    privateLines.push(`毒药：${privateFacts.witch.poisonUsed ? '已使用' : '未使用'}`);
    if (privateFacts.witch.currentVictimSeat !== null) {
      privateLines.push(`今夜被刀：${privateFacts.witch.currentVictimSeat}号玩家`);
    }
    for (const potion of privateFacts.witch.potionHistory) {
      privateLines.push(`第${potion.round}轮用药：${potion.potion === 'antidote' ? '解药' : '毒药'} → ${potion.targetSeat === null ? '无' : `${potion.targetSeat}号玩家`}`);
    }
  }
  if (privateFacts.lastGuardTargetSeat !== null) {
    privateLines.push(`上轮守护：${privateFacts.lastGuardTargetSeat}号玩家（不可连守）`);
  }
  for (const attack of privateFacts.wolfAttacks) {
    privateLines.push(`第${attack.round}轮刀人：${attack.targetSeat}号玩家`);
  }
  if (privateFacts.hunterCanShoot !== null) {
    privateLines.push(`开枪状态：${privateFacts.hunterCanShoot ? '可开枪' : '不可开枪（被毒死）'}`);
  }
  if (privateFacts.knightDuelUsed !== null) {
    privateLines.push(`决斗状态：${privateFacts.knightDuelUsed ? '已使用' : '可决斗'}`);
  }
  if (privateFacts.foolImmunityUsed !== null) {
    privateLines.push(`免疫状态：${privateFacts.foolImmunityUsed ? '已使用' : '未使用'}`);
  }
  if (privateLines.length > 0) {
    lines.push('=== 你的私有系统事实（仅你可知） ===');
    lines.push(...privateLines.map(line => `- ${line}`));
    lines.push('');
  }

  if (ctx.playerClaims.marks.length > 0) {
    lines.push('=== 玩家公开声明（不等于真实身份或系统确认） ===');
    for (const m of ctx.playerClaims.marks) {
      lines.push(`第${m.round}轮 - ${m.seatNumber}号玩家：`);
      lines.push(`  声称身份：${m.identity}（${reasonLabel(m.reason)}）`);
      for (const e of m.evaluations) {
        lines.push(`  评价：${e.targetSeat}号玩家 = ${e.identity}（${reasonLabel(e.reason)}）`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    werewolf: '狼人', wolfKing: '白狼王', seer: '预言家', witch: '女巫',
    hunter: '猎人', guard: '守卫', gravedigger: '守墓人', fool: '白痴',
    knight: '骑士', villager: '平民',
  };
  return map[role] || role;
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    night: '夜晚', day_announcement: '白天公告', day_hunter: '猎人阶段',
    day_knight: '骑士阶段', day_marking: '标记发言', day_voting: '投票',
    day_trigger: '特殊触发', game_over: '游戏结束',
  };
  return map[phase] || phase;
}

function causeLabel(cause: string): string {
  const map: Record<string, string> = {
    attacked: '被狼人袭击', poisoned: '被毒死', exiled: '被放逐',
    shot: '被猎人射杀', wolfKingDrag: '被白狼王带走', duel: '决斗出局',
    guardWitchClash: '同守同救出局',
  };
  return map[cause] || cause;
}

function relicLabel(relic: string): string {
  // 将 "moonstone(1)" → "月光石(1)", "balance(balanced)" → "天平徽章(平衡)" 等
  return relic
    .replace('moonstone', '月光石')
    .replace('balance', '天平徽章')
    .replace('houndWhistle', '猎犬哨')
    .replace('balanced', '平衡')
    .replace('unbalanced', '失衡');
}

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    intuition: '直觉判断', vote_analysis: '投票分析',
    mark_analysis: '标记分析', log_reasoning: '日志推理',
    investigation: '查验结论', potion_result: '用药结果',
  };
  return map[reason] || reason;
}
