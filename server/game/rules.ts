import type { GameState, GamePlayer, DeathRecord, NightActions, WinCondition } from '../../shared/types/game';
import { ROLES, FACTIONS, SPECIAL_ROLES, DEATH_CAUSE, ROLE_FACTION } from '../../shared/constants';

export interface WinResult {
  winner: 'good' | 'evil';
  reason: 'wolves_eliminated' | 'specials_eliminated' | 'villagers_eliminated' | 'good_eliminated';
}

/**
 * 胜负判定
 * @param winCondition 'edge' = 屠边（杀光神职或平民），'city' = 屠城（杀光所有好人）
 * 返回 WinResult | null（游戏继续）
 */
export function checkWinCondition(gameState: GameState, winCondition: WinCondition = 'edge'): WinResult | null {
  const alivePlayers = gameState.players.filter(p => p.alive);
  const aliveWolves = alivePlayers.filter(p => p.faction === FACTIONS.EVIL);
  const aliveGood = alivePlayers.filter(p => p.faction === FACTIONS.GOOD);

  // 好人胜：所有狼人出局
  if (aliveWolves.length === 0) return { winner: FACTIONS.GOOD, reason: 'wolves_eliminated' };

  if (winCondition === 'city') {
    // 屠城：所有好人出局
    if (aliveGood.length === 0) return { winner: FACTIONS.EVIL, reason: 'good_eliminated' };
  } else {
    // 屠边：所有神职出局 或 所有平民出局
    const aliveVillagers = alivePlayers.filter(p => p.role === ROLES.VILLAGER);
    const aliveSpecials = aliveGood.filter(p => SPECIAL_ROLES.has(p.role as string));

    if (aliveSpecials.length === 0 && aliveGood.length > 0) return { winner: FACTIONS.EVIL, reason: 'specials_eliminated' };
    if (aliveVillagers.length === 0 && aliveGood.length > 0) return { winner: FACTIONS.EVIL, reason: 'villagers_eliminated' };
  }

  return null;
}

/**
 * 夜晚结算
 * 返回本夜死亡的玩家列表
 */
export function resolveNight(gameState: GameState): DeathRecord[] {
  const deaths: DeathRecord[] = [];
  const { nightActions, round } = gameState;
  const wolfTarget = nightActions.wolves?.target || null;
  const guardTarget = nightActions.guard?.target || null;
  const witchAction = nightActions.witch?.action || 'none';
  const witchTarget = nightActions.witch?.target || null;

  // 1. 处理狼人袭击
  if (wolfTarget) {
    const victim = gameState.players.find(p => p.userId === wolfTarget);
    if (victim) {
      let isGuarded = guardTarget === wolfTarget;
      let isSavedByAntidote = witchAction === 'antidote';

      // 同守同救 → 死亡
      if (isGuarded && isSavedByAntidote) {
        addDeath(deaths, victim, DEATH_CAUSE.GUARD_WITCH_CLASH, round, gameState);
        isGuarded = false;
        isSavedByAntidote = false;
      }

      if (!isGuarded && !isSavedByAntidote) {
        addDeath(deaths, victim, DEATH_CAUSE.ATTACKED, round, gameState);
      }
      // 被守护 → 存活
      // 被解药救 → 存活
    }
  }

  // 2. 处理女巫毒药
  if (witchAction === 'poison' && witchTarget) {
    const poisonVictim = gameState.players.find(p => p.userId === witchTarget);
    if (poisonVictim && poisonVictim.alive) {
      // 检查是否已经在死亡列表中
      if (!deaths.some(d => d.userId === witchTarget)) {
        addDeath(deaths, poisonVictim, DEATH_CAUSE.POISONED, round, gameState);
      }
    }
  }

  // 3. 更新物品（月光石计数）
  updateMoonstone(gameState);

  // 4. 执行死亡
  for (const death of deaths) {
    const player = gameState.players.find(p => p.userId === death.userId);
    if (player) {
      player.alive = false;
      // 公开遗物
      for (const item of player.items) {
        item.revealed = true;
      }
      death.relics = [...player.items];
    }
  }

  return deaths;
}

/**
 * 更新月光石计数（夜晚结算时）
 */
function updateMoonstone(gameState: GameState): void {
  const { nightActions } = gameState;

  const visitedPlayers = new Set<string>();

  // 狼人袭击目标
  if (nightActions.wolves?.target) {
    visitedPlayers.add(nightActions.wolves.target);
  }
  // 守卫守护目标
  if (nightActions.guard?.target) {
    visitedPlayers.add(nightActions.guard.target);
  }
  // 预言家查验目标
  if (nightActions.seer?.target) {
    visitedPlayers.add(nightActions.seer.target);
  }
  // 女巫用药目标
  if (nightActions.witch?.target && nightActions.witch.action !== 'none') {
    visitedPlayers.add(nightActions.witch.target);
  }

  // 更新月光石
  for (const userId of visitedPlayers) {
    const player = gameState.players.find(p => p.userId === userId);
    if (player) {
      for (const item of player.items) {
        if (item.type === 'moonstone') {
          item.value = (item.value as number) + 1;
        }
      }
    }
  }
}

/**
 * 处理放逐投票
 */
export function resolveVoting(votes: { voter: string; target: string }[]): { exiled: string | null; tie: boolean } {
  if (votes.length === 0) return { exiled: null, tie: false };

  const voteCount: Record<string, number> = {};
  for (const vote of votes) {
    voteCount[vote.target] = (voteCount[vote.target] || 0) + 1;
  }

  let maxVotes = 0;
  const topCandidates: string[] = [];
  for (const [targetId, count] of Object.entries(voteCount)) {
    if (count > maxVotes) {
      maxVotes = count;
      topCandidates.length = 0;
      topCandidates.push(targetId);
    } else if (count === maxVotes) {
      topCandidates.push(targetId);
    }
  }

  if (topCandidates.length > 1) {
    return { exiled: null, tie: true };
  }

  return { exiled: topCandidates[0], tie: false };
}

/**
 * 获取评价标记数量（基于存活人数）
 */
export function getEvaluationMarkCount(aliveCount: number): number {
  if (aliveCount >= 10) return 4;
  if (aliveCount >= 7) return 3;
  return 2;
}

/**
 * 获取当局可用的身份声明选项
 */
export function getAvailableIdentities(gameState: GameState): string[] {
  const identities: string[] = ['神职', '好人'];
  const rolesInGame = new Set(gameState.players.map(p => p.role));

  // 根据当局板子包含的角色动态生成选项
  if (rolesInGame.has(ROLES.SEER)) identities.push('预言家');
  if (rolesInGame.has(ROLES.WITCH)) identities.push('女巫');
  if (rolesInGame.has(ROLES.HUNTER)) identities.push('猎人');
  if (rolesInGame.has(ROLES.GUARD)) identities.push('守卫');
  if (rolesInGame.has(ROLES.GRAVEDIGGER)) identities.push('守墓人');
  if (rolesInGame.has(ROLES.FOOL)) identities.push('白痴');
  if (rolesInGame.has(ROLES.KNIGHT)) identities.push('骑士');
  if (rolesInGame.has(ROLES.VILLAGER)) identities.push('平民');

  return identities;
}

/**
 * 获取评价标记可用的身份选项（多了"狼人"选项）
 */
export function getAvailableEvalIdentities(gameState: GameState): string[] {
  return [...getAvailableIdentities(gameState), '狼人'];
}

function addDeath(
  deaths: DeathRecord[],
  player: GamePlayer,
  cause: string,
  round: number,
  _gameState: GameState
): void {
  deaths.push({
    userId: player.userId,
    seatNumber: player.seatNumber,
    cause: cause as DeathRecord['cause'],
    round,
    relics: [],
  });
}
