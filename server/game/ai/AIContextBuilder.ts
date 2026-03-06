import type { GameState, GamePlayer, PlayerMarks, VoteRecord, DeathRecord, WitchState, GuardState } from '../../../shared/types/game';
import type { Room } from '../../../shared/types/room';
import { ROLES, FACTIONS, ROLE_FACTION } from '../../../shared/constants';

/**
 * AI 信息上下文构建器
 * 严格按角色身份过滤信息，确保 AI 不能"开天眼"
 * 这是 AI 获取游戏信息的唯一出口
 */

export interface AIContext {
  // 基础信息
  nickname: string;
  seatNumber: number;
  role: string;
  faction: string;
  round: number;
  phase: string;

  // 公开信息
  alivePlayers: { userId: string; nickname: string; seatNumber: number }[];
  deadPlayers: { userId: string; nickname: string; seatNumber: number; cause: string; round: number; relics: string[] }[];

  // 历史标记记录（公开）
  markHistory: { round: number; player: string; playerNickname: string; seatNumber: number; identity: string; reason: string; evaluations: { target: string; targetNickname: string; targetSeat: number; identity: string; reason: string }[] }[];

  // 历史投票记录（公开）
  voteHistory: { round: number; votes: { voter: string; voterNickname: string; voterSeat: number; target: string; targetNickname: string; targetSeat: number }[]; exiled: string | null }[];

  // 角色私有信息（仅该角色可见）
  privateInfo: string[];

  // 队友信息（仅狼人阵营）
  teammates: { userId: string; nickname: string; seatNumber: number }[];
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
    nickname: getNickname(room, aiPlayer.userId),
    seatNumber: aiPlayer.seatNumber,
    role: aiPlayer.role,
    faction: aiPlayer.faction,
    round: state.round,
    phase: state.phase,
    alivePlayers: [],
    deadPlayers: [],
    markHistory: [],
    voteHistory: [],
    privateInfo: [],
    teammates: [],
  };

  // === 公开信息 ===

  // 存活玩家
  ctx.alivePlayers = state.players
    .filter(p => p.alive)
    .map(p => ({
      userId: p.userId,
      nickname: getNickname(room, p.userId),
      seatNumber: p.seatNumber,
    }))
    .sort((a, b) => a.seatNumber - b.seatNumber);

  // 死亡记录
  ctx.deadPlayers = state.history.deaths.map(d => ({
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
  ctx.markHistory = state.history.marks.map(m => ({
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
  ctx.voteHistory = state.history.votes.map((roundVotes, i) => {
    // 找出该轮被放逐的人
    const deaths = state.history.deaths.filter(d => d.cause === 'exiled' && d.round === i + 1);
    const exiled = deaths.length > 0 ? getNickname(room, deaths[0].userId) : null;

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
    ctx.teammates = state.players
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
function buildPrivateInfo(ctx: AIContext, state: GameState, room: Room, aiPlayer: GamePlayer): void {
  const role = aiPlayer.role;

  switch (role) {
    case ROLES.SEER: {
      // 预言家：历史查验结果
      for (let i = 0; i < state.history.rounds.length; i++) {
        const nightAction = state.history.rounds[i];
        if (nightAction.seer?.target) {
          const target = state.players.find(p => p.userId === nightAction.seer!.target);
          if (target) {
            ctx.privateInfo.push(
              `第${i + 1}轮查验：${getSeatNumber(state, target.userId)}号${getNickname(room, target.userId)} → ${target.faction === FACTIONS.GOOD ? '好人' : '狼人'}阵营`
            );
          }
        }
      }
      break;
    }

    case ROLES.WITCH: {
      const witchState = aiPlayer.roleState as WitchState;
      ctx.privateInfo.push(`解药：${witchState.antidoteUsed ? '已使用' : '未使用'}`);
      ctx.privateInfo.push(`毒药：${witchState.poisonUsed ? '已使用' : '未使用'}`);

      // 当夜被刀信息（如果当前是夜晚且轮到女巫行动）
      if (state.nightActions.wolves?.target) {
        const victim = state.players.find(p => p.userId === state.nightActions.wolves!.target);
        if (victim) {
          ctx.privateInfo.push(
            `今夜被刀：${victim.seatNumber}号${getNickname(room, victim.userId)}`
          );
        }
      }

      // 历史用药记录
      for (let i = 0; i < state.history.rounds.length; i++) {
        const nightAction = state.history.rounds[i];
        if (nightAction.witch && nightAction.witch.action !== 'none') {
          const targetName = nightAction.witch.target
            ? `${getSeatNumber(state, nightAction.witch.target)}号${getNickname(room, nightAction.witch.target)}`
            : '无';
          ctx.privateInfo.push(
            `第${i + 1}轮用药：${nightAction.witch.action === 'antidote' ? '解药' : '毒药'} → ${targetName}`
          );
        }
      }
      break;
    }

    case ROLES.GUARD: {
      const guardState = aiPlayer.roleState as GuardState;
      if (guardState.lastGuardTarget) {
        ctx.privateInfo.push(
          `上轮守护：${getSeatNumber(state, guardState.lastGuardTarget)}号${getNickname(room, guardState.lastGuardTarget)}（不可连守）`
        );
      }
      break;
    }

    case ROLES.WEREWOLF:
    case ROLES.WOLF_KING: {
      // 狼人：每夜刀人目标
      for (let i = 0; i < state.history.rounds.length; i++) {
        const nightAction = state.history.rounds[i];
        if (nightAction.wolves?.target) {
          ctx.privateInfo.push(
            `第${i + 1}轮刀人：${getSeatNumber(state, nightAction.wolves.target)}号${getNickname(room, nightAction.wolves.target)}`
          );
        }
      }
      break;
    }

    case ROLES.GRAVEDIGGER: {
      // 守墓人：验尸结果
      for (let i = 0; i < state.history.rounds.length; i++) {
        const nightAction = state.history.rounds[i];
        if (nightAction.gravedigger?.target) {
          const target = state.players.find(p => p.userId === nightAction.gravedigger!.target);
          if (target) {
            ctx.privateInfo.push(
              `第${i + 1}轮验尸：${getSeatNumber(state, target.userId)}号${getNickname(room, target.userId)} → ${target.faction === FACTIONS.GOOD ? '好人' : '狼人'}阵营`
            );
          }
        }
      }
      break;
    }

    case ROLES.HUNTER: {
      const hunterState = aiPlayer.roleState as { canShoot: boolean };
      ctx.privateInfo.push(`开枪状态：${hunterState.canShoot ? '可开枪' : '不可开枪（被毒死）'}`);
      break;
    }

    case ROLES.KNIGHT: {
      const knightState = aiPlayer.roleState as { duelUsed: boolean };
      ctx.privateInfo.push(`决斗状态：${knightState.duelUsed ? '已使用' : '可决斗'}`);
      break;
    }

    case ROLES.FOOL: {
      const foolState = aiPlayer.roleState as { immunityUsed: boolean };
      ctx.privateInfo.push(`免疫状态：${foolState.immunityUsed ? '已使用' : '未使用'}`);
      break;
    }

    // 平民没有私有信息
    default:
      break;
  }
}

/**
 * 将 AIContext 转换为人类可读的文本（用于 LLM prompt）
 */
export function contextToText(ctx: AIContext): string {
  const lines: string[] = [];

  lines.push(`=== 当前局势 ===`);
  lines.push(`第 ${ctx.round} 轮，当前阶段：${phaseLabel(ctx.phase)}`);
  lines.push(`你是 ${ctx.seatNumber}号"${ctx.nickname}"，身份：${roleLabel(ctx.role)}，阵营：${ctx.faction === 'good' ? '好人' : '狼人'}`);
  lines.push('');

  lines.push(`=== 存活玩家 ===`);
  for (const p of ctx.alivePlayers) {
    const isMe = p.userId === ctx.alivePlayers.find(ap => ap.seatNumber === ctx.seatNumber)?.userId;
    lines.push(`${p.seatNumber}号 ${p.nickname}${isMe ? '（你）' : ''}`);
  }
  lines.push('');

  if (ctx.deadPlayers.length > 0) {
    lines.push(`=== 死亡记录 ===`);
    for (const d of ctx.deadPlayers) {
      const relicStr = d.relics.length > 0 ? `，遗物：${d.relics.map(relicLabel).join('、')}` : '';
      lines.push(`第${d.round}轮 ${d.seatNumber}号${d.nickname} ${causeLabel(d.cause)}${relicStr}`);
    }
    if (ctx.deadPlayers.some(d => d.relics.length > 0)) {
      lines.push(`（遗物说明：月光石数值=该玩家被夜间行动造访的总次数，包括被刀、被查验、被守护、被用药；天平徽章"平衡"=左右邻座同阵营，"失衡"=左右邻座不同阵营；猎犬哨数值=该玩家死亡时存活的狼人数量）`);
    }
    lines.push('');
  }

  if (ctx.teammates.length > 0) {
    lines.push(`=== 你的队友（狼人同伴） ===`);
    for (const t of ctx.teammates) {
      lines.push(`${t.seatNumber}号 ${t.nickname}`);
    }
    lines.push('');
  }

  if (ctx.privateInfo.length > 0) {
    lines.push(`=== 你的私有信息 ===`);
    for (const info of ctx.privateInfo) {
      lines.push(`- ${info}`);
    }
    lines.push('');
  }

  if (ctx.markHistory.length > 0) {
    lines.push(`=== 标记记录 ===`);
    for (const m of ctx.markHistory) {
      lines.push(`第${m.round}轮 - ${m.seatNumber}号${m.playerNickname}：`);
      lines.push(`  声称身份：${m.identity}（${reasonLabel(m.reason)}）`);
      for (const e of m.evaluations) {
        lines.push(`  评价：${e.targetSeat}号${e.targetNickname} = ${e.identity}（${reasonLabel(e.reason)}）`);
      }
    }
    lines.push('');
  }

  if (ctx.voteHistory.length > 0) {
    lines.push(`=== 投票记录 ===`);
    for (const v of ctx.voteHistory) {
      const voteSummary = v.votes
        .map(vote => `${vote.voterSeat}号→${vote.targetSeat}号`)
        .join('，');
      const result = v.exiled ? `→ ${v.exiled}被放逐` : '→ 平票无人出局';
      lines.push(`第${v.round}轮：${voteSummary} ${result}`);
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
