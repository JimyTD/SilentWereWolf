import type { Room } from '../../shared/types/room';
import type {
  GameState,
  GamePlayer,
  NightActions,
  PlayerItem,
  PlayerMarks,
  VoteRecord,
  DeathRecord,
  WitchState,
  GuardState,
  GameSettings,
  PendingTrigger,
} from '../../shared/types/game';
import {
  PHASES,
  ROLES,
  FACTIONS,
  ROLE_FACTION,
  NIGHT_ACTION_ORDER,
  ITEMS,
  DEFAULT_TIMERS,
} from '../../shared/constants';
import { getRolesFromSettings } from '../../shared/validators';
import { createRole } from './roles/index';
import {
  checkWinCondition,
  resolveNight,
  resolveVoting,
  getEvaluationMarkCount,
  getAvailableIdentities,
} from './rules';

export class GameManager {
  private room: Room;
  private state!: GameState;
  private roleHandlers = new Map<string, ReturnType<typeof createRole>>();
  private nightActionTimer: NodeJS.Timeout | null = null;
  private markingTimer: NodeJS.Timeout | null = null;
  private votingTimer: NodeJS.Timeout | null = null;
  private collectedVotes: VoteRecord[] = [];

  // 回调，由 socket handler 设置
  public onPhaseChange?: (state: GameState) => void;
  public onNightActionPrompt?: (userId: string, roleName: string, targets: string[], witchInfo?: { victim: string | null; hasAntidote: boolean; hasPoison: boolean; canSelfSave: boolean }) => void;
  public onDayAnnouncement?: (deaths: DeathRecord[], peacefulNight: boolean) => void;
  public onMarkingTurn?: (userId: string, evaluationMarkCount: number, identities: string[]) => void;
  public onMarksRevealed?: (marks: PlayerMarks) => void;
  public onVotingStart?: (candidates: string[]) => void;
  public onVotingResult?: (votes: VoteRecord[], exiled: string | null, tie: boolean) => void;
  public onGameOver?: (winner: 'good' | 'evil') => void;
  public onInvestigateResult?: (userId: string, target: string, faction: 'good' | 'evil') => void;

  constructor(room: Room) {
    this.room = room;
  }

  getState(): GameState {
    return this.state;
  }

  // ========== 游戏初始化 ==========

  initializeGame(): void {
    const settings = this.room.settings;
    const roleList = getRolesFromSettings(settings);

    // 随机打乱角色分配
    const shuffledRoles = this.shuffle([...roleList]);

    const players: GamePlayer[] = this.room.players.map((rp, index) => {
      const role = shuffledRoles[index] as GamePlayer['role'];
      const faction = ROLE_FACTION[role] as 'good' | 'evil';
      const items = this.assignItems(settings, this.room.players.length, index);
      const roleState = this.initRoleState(role);

      // 创建角色处理器
      const handler = createRole(role);
      this.roleHandlers.set(rp.userId, handler);

      return {
        userId: rp.userId,
        seatNumber: rp.seatNumber,
        role,
        faction,
        alive: true,
        items,
        roleState,
      };
    });

    // 计算天平徽章
    this.calculateBalanceBadges(players);

    this.state = {
      roomId: this.room.roomId,
      status: 'playing',
      round: 1,
      phase: PHASES.NIGHT,
      players,
      nightActions: this.createEmptyNightActions(),
      markingOrder: [],
      markingCurrent: 0,
      history: {
        rounds: [],
        marks: [],
        votes: [],
        deaths: [],
      },
      winner: null,
      nightCurrentRole: null,
      pendingTriggers: [],
    };
  }

  // ========== 夜晚流程 ==========

  startNight(): void {
    this.state.phase = PHASES.NIGHT;
    this.state.nightActions = this.createEmptyNightActions();
    this.onPhaseChange?.(this.state);

    // 从第一个有夜晚行动的角色开始
    this.processNextNightRole(0);
  }

  private processNextNightRole(fromIndex: number): void {
    for (let i = fromIndex; i < NIGHT_ACTION_ORDER.length; i++) {
      const roleName = NIGHT_ACTION_ORDER[i];

      // 找到拥有该角色且存活的玩家
      const playersWithRole = this.state.players.filter(
        p => p.alive && p.role === roleName
      );

      if (playersWithRole.length === 0) continue;

      // 狼人特殊处理：所有狼人同时行动
      if (roleName === ROLES.WEREWOLF || roleName === (ROLES.WOLF_KING as string)) {
        const wolves = this.state.players.filter(
          p => p.alive && (p.role === ROLES.WEREWOLF || p.role === ROLES.WOLF_KING)
        );
        if (wolves.length > 0) {
          this.state.nightCurrentRole = ROLES.WEREWOLF;
          for (const wolf of wolves) {
            const handler = this.roleHandlers.get(wolf.userId);
            if (handler) {
              const targets = handler.getAvailableTargets(this.state, wolf);
              this.onNightActionPrompt?.(wolf.userId, wolf.role, targets);
            }
          }
          this.startNightActionTimer(() => this.handleNightTimeout(ROLES.WEREWOLF, i));
          return;
        }
        continue;
      }

      // 女巫特殊处理：需要额外信息
      if (roleName === ROLES.WITCH) {
        const witch = playersWithRole[0];
        const witchState = witch.roleState as WitchState;
        const victim = this.state.nightActions.wolves?.target || null;
        this.state.nightCurrentRole = ROLES.WITCH;
        const targets = this.roleHandlers.get(witch.userId)?.getAvailableTargets(this.state, witch) || [];
        this.onNightActionPrompt?.(witch.userId, ROLES.WITCH, targets, {
          victim,
          hasAntidote: !witchState.antidoteUsed,
          hasPoison: !witchState.poisonUsed,
          canSelfSave: this.state.round === 1,
        });
        this.startNightActionTimer(() => this.handleNightTimeout(ROLES.WITCH, i));
        return;
      }

      // 通用角色处理
      const player = playersWithRole[0];
      const handler = this.roleHandlers.get(player.userId);
      if (handler && handler.hasNightAction) {
        this.state.nightCurrentRole = roleName;
        const targets = handler.getAvailableTargets(this.state, player);
        this.onNightActionPrompt?.(player.userId, roleName, targets);
        this.startNightActionTimer(() => this.handleNightTimeout(roleName, i));
        return;
      }
    }

    // 所有角色行动完毕 → 结算夜晚
    this.resolveNightPhase();
  }

  handleNightAction(userId: string, action: { action: string; target?: string; potion?: string }): boolean {
    const player = this.state.players.find(p => p.userId === userId);
    if (!player || !player.alive) return false;

    const handler = this.roleHandlers.get(userId);
    if (!handler) return false;

    const success = handler.performNightAction(this.state, player, {
      target: action.target,
      potion: action.potion,
    });

    if (!success) return false;

    // 预言家查验结果立即返回
    if (player.role === ROLES.SEER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onInvestigateResult?.(userId, action.target, target.faction);
      }
    }

    // 检查当前角色组是否全部完成
    if (this.isCurrentRoleGroupDone()) {
      this.clearNightActionTimer();
      const currentIndex = NIGHT_ACTION_ORDER.indexOf(this.state.nightCurrentRole as typeof NIGHT_ACTION_ORDER[number]);
      // 跳过同组的狼人角色
      let nextIndex = currentIndex + 1;
      if (this.state.nightCurrentRole === ROLES.WEREWOLF) {
        // 跳到狼人之后的角色
        nextIndex = NIGHT_ACTION_ORDER.indexOf(ROLES.WITCH);
        if (nextIndex === -1) nextIndex = currentIndex + 1;
      }
      this.processNextNightRole(nextIndex);
    }

    return true;
  }

  private isCurrentRoleGroupDone(): boolean {
    const role = this.state.nightCurrentRole;
    if (!role) return true;

    if (role === ROLES.WEREWOLF || role === ROLES.WOLF_KING) {
      return this.state.nightActions.wolves?.target !== null &&
             this.state.nightActions.wolves?.target !== undefined;
    }
    if (role === ROLES.WITCH) {
      return this.state.nightActions.witch !== null;
    }
    if (role === ROLES.SEER) {
      return this.state.nightActions.seer !== null;
    }
    if (role === ROLES.GUARD) {
      return this.state.nightActions.guard !== null;
    }
    if (role === ROLES.GRAVEDIGGER) {
      return this.state.nightActions.gravedigger !== null;
    }
    return true;
  }

  private handleNightTimeout(role: string, orderIndex: number): void {
    // 超时 → 视为不操作
    if (role === ROLES.WEREWOLF || role === ROLES.WOLF_KING) {
      if (!this.state.nightActions.wolves?.target) {
        // 随机选一个已提交的目标，若无则随机选
        const wolves = this.state.nightActions.wolves;
        if (wolves && Object.keys(wolves.votes).length > 0) {
          const targets = Object.values(wolves.votes);
          wolves.target = targets[Math.floor(Math.random() * targets.length)];
        } else {
          // 无人投票，随机选目标
          const validTargets = this.state.players.filter(p => p.alive && p.faction !== FACTIONS.EVIL);
          if (validTargets.length > 0) {
            const randomTarget = validTargets[Math.floor(Math.random() * validTargets.length)];
            if (!this.state.nightActions.wolves) {
              this.state.nightActions.wolves = { target: randomTarget.userId, votes: {} };
            } else {
              this.state.nightActions.wolves.target = randomTarget.userId;
            }
          }
        }
      }
    } else if (role === ROLES.WITCH) {
      if (!this.state.nightActions.witch) {
        this.state.nightActions.witch = { action: 'none', target: null };
      }
    } else if (role === ROLES.SEER) {
      if (!this.state.nightActions.seer) {
        this.state.nightActions.seer = { target: null };
      }
    } else if (role === ROLES.GUARD) {
      if (!this.state.nightActions.guard) {
        this.state.nightActions.guard = { target: null };
      }
    }

    const nextIndex = role === ROLES.WEREWOLF
      ? NIGHT_ACTION_ORDER.indexOf(ROLES.WITCH)
      : orderIndex + 1;

    this.processNextNightRole(nextIndex >= 0 ? nextIndex : orderIndex + 1);
  }

  private resolveNightPhase(): void {
    const deaths = resolveNight(this.state);

    // 保存本轮夜晚行动到历史
    this.state.history.rounds.push({ ...this.state.nightActions });
    this.state.history.deaths.push(...deaths);

    // 进入白天公告
    this.state.phase = PHASES.DAY_ANNOUNCEMENT;
    this.state.nightCurrentRole = null;
    this.onPhaseChange?.(this.state);
    this.onDayAnnouncement?.(deaths, deaths.length === 0);

    // 检查胜负
    const winner = checkWinCondition(this.state);
    if (winner) {
      this.endGame(winner);
      return;
    }

    // 进入标记发言阶段
    this.startMarkingPhase();
  }

  // ========== 标记发言阶段 ==========

  private startMarkingPhase(): void {
    this.state.phase = PHASES.DAY_MARKING;
    // 按座位号排列存活玩家
    const alivePlayers = this.state.players
      .filter(p => p.alive)
      .sort((a, b) => a.seatNumber - b.seatNumber);

    this.state.markingOrder = alivePlayers.map(p => p.userId);
    this.state.markingCurrent = 0;

    this.onPhaseChange?.(this.state);
    this.promptNextMarking();
  }

  private promptNextMarking(): void {
    if (this.state.markingCurrent >= this.state.markingOrder.length) {
      // 标记完成 → 进入投票
      this.startVotingPhase();
      return;
    }

    const currentUserId = this.state.markingOrder[this.state.markingCurrent];
    const alivePlayers = this.state.players.filter(p => p.alive);
    const evalCount = getEvaluationMarkCount(alivePlayers.length);
    const identities = getAvailableIdentities(this.state);

    this.onMarkingTurn?.(currentUserId, evalCount, identities);

    const timeout = this.room.settings.timers?.marking || DEFAULT_TIMERS.MARKING;
    this.startMarkingTimer(() => {
      // 超时 → 跳过该玩家
      this.state.markingCurrent++;
      this.promptNextMarking();
    }, timeout);
  }

  handleSubmitMarks(userId: string, marks: PlayerMarks): boolean {
    if (this.state.phase !== PHASES.DAY_MARKING) return false;
    if (this.state.markingOrder[this.state.markingCurrent] !== userId) return false;

    marks.round = this.state.round;
    marks.player = userId;
    this.state.history.marks.push(marks);
    this.onMarksRevealed?.(marks);

    this.clearMarkingTimer();
    this.state.markingCurrent++;
    this.promptNextMarking();

    return true;
  }

  // ========== 投票阶段 ==========

  private startVotingPhase(): void {
    this.state.phase = PHASES.DAY_VOTING;
    this.collectedVotes = [];

    const candidates = this.state.players
      .filter(p => p.alive)
      .map(p => p.userId);

    this.onPhaseChange?.(this.state);
    this.onVotingStart?.(candidates);

    const timeout = this.room.settings.timers?.voting || DEFAULT_TIMERS.VOTING;
    this.startVotingTimer(() => {
      // 为未投票的玩家随机投票
      this.fillRandomVotes();
      this.resolveVotingPhase();
    }, timeout);
  }

  handleVote(userId: string, target: string): boolean {
    if (this.state.phase !== PHASES.DAY_VOTING) return false;

    const voter = this.state.players.find(p => p.userId === userId);
    if (!voter || !voter.alive) return false;
    if (userId === target) return false; // 不可投自己

    // 不能重复投票
    if (this.collectedVotes.some(v => v.voter === userId)) return false;

    this.collectedVotes.push({ voter: userId, target });

    // 检查是否所有人都投了
    const aliveVoters = this.state.players.filter(p => p.alive);
    if (this.collectedVotes.length >= aliveVoters.length) {
      this.clearVotingTimer();
      this.resolveVotingPhase();
    }

    return true;
  }

  private fillRandomVotes(): void {
    const alivePlayers = this.state.players.filter(p => p.alive);
    const votedUserIds = new Set(this.collectedVotes.map(v => v.voter));

    for (const player of alivePlayers) {
      if (!votedUserIds.has(player.userId)) {
        // 随机投一个非自己的存活玩家
        const targets = alivePlayers.filter(p => p.userId !== player.userId);
        if (targets.length > 0) {
          const randomTarget = targets[Math.floor(Math.random() * targets.length)];
          this.collectedVotes.push({ voter: player.userId, target: randomTarget.userId });
        }
      }
    }
  }

  private resolveVotingPhase(): void {
    const result = resolveVoting(this.collectedVotes);
    this.state.history.votes.push([...this.collectedVotes]);

    this.onVotingResult?.(this.collectedVotes, result.exiled, result.tie);

    if (result.exiled) {
      this.handleExile(result.exiled);
    } else {
      // 平票 → 无人出局，进入夜晚
      this.advanceToNextNight();
    }
  }

  private handleExile(userId: string): void {
    const player = this.state.players.find(p => p.userId === userId);
    if (!player) {
      this.advanceToNextNight();
      return;
    }

    // 执行出局
    player.alive = false;
    for (const item of player.items) {
      item.revealed = true;
    }
    this.state.history.deaths.push({
      userId: player.userId,
      seatNumber: player.seatNumber,
      cause: 'exiled',
      round: this.state.round,
      relics: [...player.items],
    });

    // 检查胜负
    const winner = checkWinCondition(this.state);
    if (winner) {
      this.endGame(winner);
      return;
    }

    // 进入下一个夜晚
    this.advanceToNextNight();
  }

  private advanceToNextNight(): void {
    this.state.round++;
    this.startNight();
  }

  // ========== 游戏结束 ==========

  private endGame(winner: 'good' | 'evil'): void {
    this.state.phase = PHASES.GAME_OVER;
    this.state.status = 'finished';
    this.state.winner = winner;
    this.clearAllTimers();
    this.onPhaseChange?.(this.state);
    this.onGameOver?.(winner);
  }

  // ========== 辅助方法 ==========

  private assignItems(settings: GameSettings, playerCount: number, _playerIndex: number): PlayerItem[] {
    if (!settings.items?.enabled) return [];

    const pool = settings.items.pool || [ITEMS.MOONSTONE, ITEMS.BALANCE];
    // 随机分配一种物品
    const itemType = pool[Math.floor(Math.random() * pool.length)];

    const item: PlayerItem = {
      type: itemType,
      value: itemType === ITEMS.MOONSTONE ? 0 : '', // 天平徽章在后面计算
      revealed: false,
    };

    return [item];
  }

  private calculateBalanceBadges(players: GamePlayer[]): void {
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      for (const item of player.items) {
        if (item.type === ITEMS.BALANCE) {
          const leftIndex = (i - 1 + players.length) % players.length;
          const rightIndex = (i + 1) % players.length;
          const leftFaction = players[leftIndex].faction;
          const rightFaction = players[rightIndex].faction;
          item.value = leftFaction === rightFaction ? 'balanced' : 'unbalanced';
        }
      }
    }
  }

  private initRoleState(role: string): GamePlayer['roleState'] {
    switch (role) {
      case ROLES.WITCH:
        return { antidoteUsed: false, poisonUsed: false };
      case ROLES.GUARD:
        return { lastGuardTarget: null };
      case ROLES.FOOL:
        return { immunityUsed: false };
      case ROLES.KNIGHT:
        return { duelUsed: false };
      case ROLES.HUNTER:
        return { canShoot: true };
      default:
        return {};
    }
  }

  private createEmptyNightActions(): NightActions {
    return {
      guard: null,
      wolves: null,
      witch: null,
      seer: null,
      gravedigger: null,
    };
  }

  private shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // ========== 计时器管理 ==========

  private startNightActionTimer(callback: () => void): void {
    this.clearNightActionTimer();
    const timeout = (this.room.settings.timers?.nightAction || DEFAULT_TIMERS.NIGHT_ACTION) * 1000;
    this.nightActionTimer = setTimeout(callback, timeout);
  }

  private clearNightActionTimer(): void {
    if (this.nightActionTimer) {
      clearTimeout(this.nightActionTimer);
      this.nightActionTimer = null;
    }
  }

  private startMarkingTimer(callback: () => void, seconds: number): void {
    this.clearMarkingTimer();
    this.markingTimer = setTimeout(callback, seconds * 1000);
  }

  private clearMarkingTimer(): void {
    if (this.markingTimer) {
      clearTimeout(this.markingTimer);
      this.markingTimer = null;
    }
  }

  private startVotingTimer(callback: () => void, seconds: number): void {
    this.clearVotingTimer();
    this.votingTimer = setTimeout(callback, seconds * 1000);
  }

  private clearVotingTimer(): void {
    if (this.votingTimer) {
      clearTimeout(this.votingTimer);
      this.votingTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearNightActionTimer();
    this.clearMarkingTimer();
    this.clearVotingTimer();
  }
}
