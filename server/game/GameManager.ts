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
  private collectedVotes: VoteRecord[] = [];

  // 回调，由 socket handler 设置
  public onPhaseChange?: (state: GameState) => void;
  public onNightActionPrompt?: (userId: string, roleName: string, targets: string[], witchInfo?: { victim: string | null; hasAntidote: boolean; hasPoison: boolean; canSelfSave: boolean }) => void;
  public onDayAnnouncement?: (deaths: DeathRecord[], peacefulNight: boolean, round: number, type: 'night' | 'exile') => void;
  public onMarkingTurn?: (userId: string, evaluationMarkCount: number, identities: string[]) => void;
  public onMarksRevealed?: (marks: PlayerMarks) => void;
  public onVotingStart?: (candidates: string[]) => void;
  public onVotingResult?: (votes: VoteRecord[], exiled: string | null, tie: boolean) => void;
  public onGameOver?: (winner: 'good' | 'evil', reason: string) => void;
  public onWolfVoteUpdate?: (wolfUserIds: string[], votes: Record<string, string>) => void;
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

    // 随机打乱座位号
    const seatNumbers = this.room.players.map((_, i) => i + 1);
    const shuffledSeats = this.shuffle([...seatNumbers]);

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
        seatNumber: shuffledSeats[index],
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
        return;
      }

      // 通用角色处理
      const player = playersWithRole[0];
      const handler = this.roleHandlers.get(player.userId);
      if (handler && handler.hasNightAction) {
        this.state.nightCurrentRole = roleName;
        const targets = handler.getAvailableTargets(this.state, player);
        this.onNightActionPrompt?.(player.userId, roleName, targets);
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

    // 狼人投票后通知队友
    if ((player.role === ROLES.WEREWOLF || player.role === ROLES.WOLF_KING) && this.state.nightActions.wolves) {
      const aliveWolves = this.state.players.filter(
        p => p.alive && (p.role === ROLES.WEREWOLF || p.role === ROLES.WOLF_KING)
      );
      const wolfIds = aliveWolves.map(w => w.userId);
      this.onWolfVoteUpdate?.(wolfIds, { ...this.state.nightActions.wolves.votes });
    }

    // 预言家查验结果立即返回
    if (player.role === ROLES.SEER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onInvestigateResult?.(userId, action.target, target.faction);
      }
    }

    // 检查当前角色组是否全部完成
    if (this.isCurrentRoleGroupDone()) {
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

  private resolveNightPhase(): void {
    const deaths = resolveNight(this.state);

    // 保存本轮夜晚行动到历史
    this.state.history.rounds.push({ ...this.state.nightActions });
    this.state.history.deaths.push(...deaths);

    // 进入白天公告
    this.state.phase = PHASES.DAY_ANNOUNCEMENT;
    this.state.nightCurrentRole = null;
    this.onPhaseChange?.(this.state);
    this.onDayAnnouncement?.(deaths, deaths.length === 0, this.state.round, 'night');

    // 检查胜负
    const winResult = checkWinCondition(this.state);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
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
  }

  handleSubmitMarks(userId: string, marks: PlayerMarks): boolean {
    if (this.state.phase !== PHASES.DAY_MARKING) return false;
    if (this.state.markingOrder[this.state.markingCurrent] !== userId) return false;

    marks.round = this.state.round;
    marks.player = userId;
    this.state.history.marks.push(marks);
    this.onMarksRevealed?.(marks);

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
      this.resolveVotingPhase();
    }

    return true;
  }

  private resolveVotingPhase(): void {
    const result = resolveVoting(this.collectedVotes);
    this.state.history.votes.push([...this.collectedVotes]);

    this.onVotingResult?.(this.collectedVotes, result.exiled, result.tie);

    // 延迟5秒再切换阶段，让玩家有时间查看投票结果
    setTimeout(() => {
      if (result.exiled) {
        this.handleExile(result.exiled);
      } else {
        // 平票 → 无人出局，进入夜晚
        this.advanceToNextNight();
      }
    }, 5000);
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

    // 广播放逐公告（含遗物信息）
    this.onDayAnnouncement?.([{
      userId: player.userId,
      seatNumber: player.seatNumber,
      cause: 'exiled',
      round: this.state.round,
      relics: [...player.items],
    }], false, this.state.round, 'exile');

    // 检查胜负
    const winResult = checkWinCondition(this.state);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
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

  private endGame(winner: 'good' | 'evil', reason: string): void {
    this.state.phase = PHASES.GAME_OVER;
    this.state.status = 'finished';
    this.state.winner = winner;
    this.onPhaseChange?.(this.state);
    this.onGameOver?.(winner, reason);
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
    // 按座位号排序后计算邻座，形成环形座位
    const sorted = [...players].sort((a, b) => a.seatNumber - b.seatNumber);
    const seatToFaction = new Map<number, GamePlayer['faction']>();
    for (const p of sorted) {
      seatToFaction.set(p.seatNumber, p.faction);
    }

    for (const player of players) {
      for (const item of player.items) {
        if (item.type === ITEMS.BALANCE) {
          const idx = sorted.findIndex(p => p.userId === player.userId);
          const leftIndex = (idx - 1 + sorted.length) % sorted.length;
          const rightIndex = (idx + 1) % sorted.length;
          const leftFaction = sorted[leftIndex].faction;
          const rightFaction = sorted[rightIndex].faction;
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

}
