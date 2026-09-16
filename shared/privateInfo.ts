import { PHASES, ROLES } from './constants';
import type {
  GameState,
  GamePlayer,
  GuardState,
  HunterState,
  InvestigationRecord,
  KnightState,
  FoolState,
  MyPrivateInfo,
  NightActions,
  PotionRecord,
  WitchState,
  WolfAttackRecord,
  GuardRecord,
} from './types/game';

/**
 * 构建"我的私有信息"：玩家自己的角色资源与操作历史。
 *
 * 服务端下发给真人玩家（开局 / 阶段切换 / 重连）与 AI 上下文共用同一份逻辑，
 * 避免两边各写一套导致信息不一致或逻辑漂移。
 * 只输出该玩家自己有权看到的信息，不包含任何他人私有信息。
 */
export function buildMyPrivateInfo(state: GameState, player: GamePlayer): MyPrivateInfo {
  const info: MyPrivateInfo = {};

  // 已结算的夜晚（history.rounds[i] 对应第 i+1 轮）。
  // 夜晚进行中时把当前轮的行动一并计入，保证刚做出的操作立即可见。
  const rounds: { round: number; actions: NightActions }[] = state.history.rounds
    .map((actions, i) => ({ round: i + 1, actions }));
  if (state.phase === PHASES.NIGHT && state.history.rounds.length < state.round) {
    rounds.push({ round: state.round, actions: state.nightActions });
  }

  const getFaction = (userId: string | null) => {
    if (!userId) return null;
    return state.players.find(p => p.userId === userId)?.faction ?? null;
  };

  switch (player.role) {
    case ROLES.SEER:
    case ROLES.GRAVEDIGGER: {
      const kind = player.role === ROLES.SEER ? 'seer' : 'gravedigger';
      const investigations: InvestigationRecord[] = [];
      for (const { round, actions } of rounds) {
        const target = actions[kind]?.target;
        if (!target) continue;
        const faction = getFaction(target);
        if (!faction) continue;
        investigations.push({ round, kind, target, faction });
      }
      info.investigations = investigations;
      break;
    }

    case ROLES.WITCH: {
      const witchState = player.roleState as WitchState;
      const potionHistory: PotionRecord[] = [];
      for (const { round, actions } of rounds) {
        const action = actions.witch;
        if (!action || action.action === 'none') continue;
        potionHistory.push({ round, potion: action.action, target: action.target });
      }
      info.witch = {
        antidoteUsed: witchState.antidoteUsed,
        poisonUsed: witchState.poisonUsed,
        potionHistory,
      };
      break;
    }

    case ROLES.GUARD: {
      const guardState = player.roleState as GuardState;
      const history: GuardRecord[] = [];
      for (const { round, actions } of rounds) {
        const target = actions.guard?.target;
        if (!target) continue;
        history.push({ round, target });
      }
      info.guard = {
        lastGuardTarget: guardState.lastGuardTarget,
        history,
      };
      break;
    }

    case ROLES.WEREWOLF:
    case ROLES.WOLF_KING: {
      const wolfAttacks: WolfAttackRecord[] = [];
      for (const { round, actions } of rounds) {
        const target = actions.wolves?.target;
        if (!target) continue;
        wolfAttacks.push({ round, target });
      }
      info.wolfAttacks = wolfAttacks;
      break;
    }

    case ROLES.HUNTER: {
      info.hunterCanShoot = (player.roleState as HunterState).canShoot;
      break;
    }

    case ROLES.KNIGHT: {
      info.knightDuelUsed = (player.roleState as KnightState).duelUsed;
      break;
    }

    case ROLES.FOOL: {
      info.foolImmunityUsed = (player.roleState as FoolState).immunityUsed;
      break;
    }

    default:
      break;
  }

  return info;
}
