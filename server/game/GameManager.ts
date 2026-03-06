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
  FoolState,
  KnightState,
  HunterState,
} from '../../shared/types/game';
import {
  PHASES,
  ROLES,
  FACTIONS,
  ROLE_FACTION,
  NIGHT_ACTION_ORDER,
  ITEMS,
  DEATH_CAUSE,
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
  // 守墓人查验结�?
  public onAutopsyResult?: (userId: string, target: string, faction: 'good' | 'evil') => void;
  // 触发链回�?
  public onHunterTrigger?: (userId: string, canShoot: boolean, targets: string[]) => void;
  public onHunterResult?: (shooter: string, target: string | null, targetDeath: boolean) => void;
  public onWolfKingTrigger?: (userId: string, targets: string[]) => void;
  public onWolfKingResult?: (dragger: string, target: string | null) => void;
  public onFoolImmunity?: (userId: string) => void;
  public onKnightTurn?: (userId: string, canDuel: boolean, targets: string[]) => void;
  public onDuelResult?: (knightId: string, targetId: string, loserId: string) => void;

  constructor(room: Room) {
    this.room = room;
  }

  getState(): GameState {
    return this.state;
  }

  private get winCondition() {
    return this.room.settings.winCondition || 'edge';
  }

  // ========== 游戏初始�?==========

  initializeGame(): void {
    const settings = this.room.settings;
    const roleList = getRolesFromSettings(settings);

    // 随机打乱角色分配
    const shuffledRoles = this.shuffle([...roleList]);

    // 随机打乱座位�?
    const seatNumbers = this.room.players.map((_, i) => i + 1);
    const shuffledSeats = this.shuffle([...seatNumbers]);

    const players: GamePlayer[] = this.room.players.map((rp, index) => {
      const role = shuffledRoles[index] as GamePlayer['role'];
      const faction = ROLE_FACTION[role] as 'good' | 'evil';
      const items = this.assignItems(settings, this.room.players.length, index);
      const roleState = this.initRoleState(role);

      // 创建角色处理�?
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

    // 从第一个有夜晚行动的角色开�?
    this.processNextNightRole(0);
  }

  private processNextNightRole(fromIndex: number): void {
    for (let i = fromIndex; i < NIGHT_ACTION_ORDER.length; i++) {
      const roleName = NIGHT_ACTION_ORDER[i];

      // 找到拥有该角色且存活的玩�?
      const playersWithRole = this.state.players.filter(
        p => p.alive && p.role === roleName
      );

      if (playersWithRole.length === 0) continue;

      // 狼人特殊处理：所有狼人同时行动（含白狼王�?
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

      // 女巫特殊处理：需要额外信�?
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

      // 守墓人特殊处理：查验已死亡玩�?
      if (roleName === ROLES.GRAVEDIGGER) {
        const gd = playersWithRole[0];
        const handler = this.roleHandlers.get(gd.userId);
        if (handler && handler.hasNightAction) {
          const targets = handler.getAvailableTargets(this.state, gd);
          this.state.nightCurrentRole = ROLES.GRAVEDIGGER;
          if (targets.length === 0) {
            // 无死者可查，自动跳过
            this.state.nightActions.gravedigger = { target: null };
            continue;
          }
          this.onNightActionPrompt?.(gd.userId, ROLES.GRAVEDIGGER, targets);
          return;
        }
        continue;
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

    // 所有角色行动完�?�?结算夜晚
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

    // 预言家查验结果立即返�?
    if (player.role === ROLES.SEER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onInvestigateResult?.(userId, action.target, target.faction);
      }
    }

    // 守墓人查验结果立即返�?
    if (player.role === ROLES.GRAVEDIGGER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onAutopsyResult?.(userId, action.target, target.faction);
      }
    }

    // 检查当前角色组是否全部完成
    if (this.isCurrentRoleGroupDone()) {
      const currentIndex = NIGHT_ACTION_ORDER.indexOf(this.state.nightCurrentRole as typeof NIGHT_ACTION_ORDER[number]);
      // 跳过同组的狼人角�?
      let nextIndex = currentIndex + 1;
      if (this.state.nightCurrentRole === ROLES.WEREWOLF) {
        // 跳到狼人之后的角�?
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

    // 保存本轮夜晚行动到历�?
    this.state.history.rounds.push({ ...this.state.nightActions });
    this.state.history.deaths.push(...deaths);

    // 进入白天公告
    this.state.phase = PHASES.DAY_ANNOUNCEMENT;
    this.state.nightCurrentRole = null;
    this.onPhaseChange?.(this.state);
    this.onDayAnnouncement?.(deaths, deaths.length === 0, this.state.round, 'night');

    // 检查胜�?
    const winResult = checkWinCondition(this.state, this.winCondition);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
      return;
    }

    // 处理夜晚死亡的触发（猎人被刀死可开枪）
    this.processDeathTriggers(deaths, () => {
      // 触发链处理完毕后，检查是否有骑士决斗
      this.checkKnightDuel();
    });
  }

  // ========== 触发链系�?==========

  /**
   * 处理死亡触发�?
   * 遍历死亡列表，收集所有需要触发的事件，然后逐一处理
   */
  private processDeathTriggers(deaths: DeathRecord[], onComplete: () => void): void {
    // 收集触发事件
    const triggers: PendingTrigger[] = [];
    for (const death of deaths) {
      const handler = this.roleHandlers.get(death.userId);
      if (!handler) continue;

      const trigger = handler.onDeath(this.state, 
        this.state.players.find(p => p.userId === death.userId)!,
        death.cause
      );
      if (trigger) {
        triggers.push({
          type: trigger.type as PendingTrigger['type'],
          userId: trigger.userId,
          timeout: 30,
        });
      }
    }

    if (triggers.length === 0) {
      onComplete();
      return;
    }

    // 将触发事件加入队列并逐一处理
    this.state.pendingTriggers = triggers;
    this.processNextTrigger(onComplete);
  }

  /**
   * 逐一处理触发队列中的事件
   */
  private processNextTrigger(onComplete: () => void): void {
    if (this.state.pendingTriggers.length === 0) {
      onComplete();
      return;
    }

    const trigger = this.state.pendingTriggers[0];
    const player = this.state.players.find(p => p.userId === trigger.userId);
    if (!player) {
      this.state.pendingTriggers.shift();
      this.processNextTrigger(onComplete);
      return;
    }

    this.state.phase = PHASES.DAY_TRIGGER;
    this.onPhaseChange?.(this.state);

    switch (trigger.type) {
      case 'hunter_shoot': {
        const targets = this.state.players
          .filter(p => p.alive && p.userId !== trigger.userId)
          .map(p => p.userId);
        const hunterState = player.roleState as HunterState;
        this.onHunterTrigger?.(trigger.userId, hunterState.canShoot, targets);
        // 存储 onComplete 以便 handleHunterAction 调用
        this._triggerOnComplete = onComplete;
        break;
      }
      case 'wolf_king_drag': {
        const targets = this.state.players
          .filter(p => p.alive && p.userId !== trigger.userId)
          .map(p => p.userId);
        this.onWolfKingTrigger?.(trigger.userId, targets);
        this._triggerOnComplete = onComplete;
        break;
      }
      default:
        // 未知触发类型，跳�?
        this.state.pendingTriggers.shift();
        this.processNextTrigger(onComplete);
        break;
    }
  }

  // 保存触发链完成回�?
  private _triggerOnComplete?: () => void;

  /**
   * 猎人开枪操�?
   */
  handleHunterAction(userId: string, action: 'shoot' | 'skip', target?: string): boolean {
    if (this.state.pendingTriggers.length === 0) return false;
    const trigger = this.state.pendingTriggers[0];
    if (trigger.type !== 'hunter_shoot' || trigger.userId !== userId) return false;

    const hunter = this.state.players.find(p => p.userId === userId);
    if (!hunter) return false;

    // 标记已用
    const hunterState = hunter.roleState as HunterState;
    hunterState.canShoot = false;

    this.state.pendingTriggers.shift();

    if (action === 'shoot' && target) {
      const victim = this.state.players.find(p => p.userId === target && p.alive);
      if (victim) {
        // 击杀目标
        victim.alive = false;
        for (const item of victim.items) {
          item.revealed = true;
        }
        const deathRecord: DeathRecord = {
          userId: victim.userId,
          seatNumber: victim.seatNumber,
          cause: DEATH_CAUSE.SHOT,
          round: this.state.round,
          relics: [...victim.items],
        };
        this.state.history.deaths.push(deathRecord);

        this.onHunterResult?.(userId, target, true);

        // 广播猎人开枪导致的死亡公告
        this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

        // 检查胜�?
        const winResult = checkWinCondition(this.state, this.winCondition);
        if (winResult) {
          this.endGame(winResult.winner, winResult.reason);
          return true;
        }

        // 被猎人射杀的人也可能触发（如猎人射杀了另一个猎�?.. 虽然不太可能�?
        const newTriggers: PendingTrigger[] = [];
        const victimHandler = this.roleHandlers.get(victim.userId);
        if (victimHandler) {
          const newTrigger = victimHandler.onDeath(this.state, victim, DEATH_CAUSE.SHOT);
          if (newTrigger) {
            newTriggers.push({
              type: newTrigger.type as PendingTrigger['type'],
              userId: newTrigger.userId,
              timeout: 30,
            });
          }
        }
        // 将新触发事件插入队列头部
        this.state.pendingTriggers = [...newTriggers, ...this.state.pendingTriggers];
      } else {
        this.onHunterResult?.(userId, null, false);
      }
    } else {
      this.onHunterResult?.(userId, null, false);
    }

    // 继续处理触发队列
    const onComplete = this._triggerOnComplete;
    this._triggerOnComplete = undefined;
    if (onComplete) {
      this.processNextTrigger(onComplete);
    }

    return true;
  }

  /**
   * 白狼王带人操�?
   */
  handleWolfKingAction(userId: string, action: 'drag' | 'skip', target?: string): boolean {
    if (this.state.pendingTriggers.length === 0) return false;
    const trigger = this.state.pendingTriggers[0];
    if (trigger.type !== 'wolf_king_drag' || trigger.userId !== userId) return false;

    this.state.pendingTriggers.shift();

    if (action === 'drag' && target) {
      const victim = this.state.players.find(p => p.userId === target && p.alive);
      if (victim) {
        // 带走目标
        victim.alive = false;
        for (const item of victim.items) {
          item.revealed = true;
        }
        const deathRecord: DeathRecord = {
          userId: victim.userId,
          seatNumber: victim.seatNumber,
          cause: DEATH_CAUSE.WOLF_KING_DRAG,
          round: this.state.round,
          relics: [...victim.items],
        };
        this.state.history.deaths.push(deathRecord);

        this.onWolfKingResult?.(userId, target);

        // 广播带人死亡公告
        this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

        // 检查胜�?
        const winResult = checkWinCondition(this.state, this.winCondition);
        if (winResult) {
          this.endGame(winResult.winner, winResult.reason);
          return true;
        }

        // 被带走的人也可能触发开枪（如被带走的是猎人�?
        const newTriggers: PendingTrigger[] = [];
        const victimHandler = this.roleHandlers.get(victim.userId);
        if (victimHandler) {
          const newTrigger = victimHandler.onDeath(this.state, victim, DEATH_CAUSE.WOLF_KING_DRAG);
          if (newTrigger) {
            newTriggers.push({
              type: newTrigger.type as PendingTrigger['type'],
              userId: newTrigger.userId,
              timeout: 30,
            });
          }
        }
        this.state.pendingTriggers = [...newTriggers, ...this.state.pendingTriggers];
      } else {
        this.onWolfKingResult?.(userId, null);
      }
    } else {
      this.onWolfKingResult?.(userId, null);
    }

    // 继续处理触发队列
    const onComplete = this._triggerOnComplete;
    this._triggerOnComplete = undefined;
    if (onComplete) {
      this.processNextTrigger(onComplete);
    }

    return true;
  }

  // ========== 骑士决斗 ==========

  /**
   * 检查是否有骑士可以决斗（夜晚死亡公告后、标记发言前）
   */
  private checkKnightDuel(): void {
    const knight = this.state.players.find(
      p => p.alive && p.role === ROLES.KNIGHT
    );

    if (knight) {
      const knightState = knight.roleState as KnightState;
      if (!knightState.duelUsed) {
        // 骑士存活且未使用决斗，进入决斗阶�?
        this.state.phase = PHASES.DAY_KNIGHT;
        this.onPhaseChange?.(this.state);

        const targets = this.state.players
          .filter(p => p.alive && p.userId !== knight.userId)
          .map(p => p.userId);

        this.onKnightTurn?.(knight.userId, true, targets);
        return;
      }
    }

    // 没有骑士或已用过决斗 �?直接进入标记发言
    this.startMarkingPhase();
  }

  /**
   * 骑士决斗操作
   */
  handleKnightAction(userId: string, action: 'duel' | 'skip', target?: string): boolean {
    if (this.state.phase !== PHASES.DAY_KNIGHT) return false;

    const knight = this.state.players.find(p => p.userId === userId && p.alive && p.role === ROLES.KNIGHT);
    if (!knight) return false;

    const knightState = knight.roleState as KnightState;
    if (knightState.duelUsed) return false;

    knightState.duelUsed = true;

    if (action === 'duel' && target) {
      const targetPlayer = this.state.players.find(p => p.userId === target && p.alive);
      if (!targetPlayer) {
        // 无效目标，跳�?
        this.startMarkingPhase();
        return true;
      }

      // 决斗判定：对方是狼人 �?对方死；对方是好�?�?骑士�?
      const isTargetWolf = targetPlayer.faction === FACTIONS.EVIL;
      const loser = isTargetWolf ? targetPlayer : knight;

      loser.alive = false;
      for (const item of loser.items) {
        item.revealed = true;
      }

      const deathRecord: DeathRecord = {
        userId: loser.userId,
        seatNumber: loser.seatNumber,
        cause: DEATH_CAUSE.DUEL,
        round: this.state.round,
        relics: [...loser.items],
      };
      this.state.history.deaths.push(deathRecord);

      this.onDuelResult?.(userId, target, loser.userId);

      // 广播决斗结果公告
      this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

      // 检查胜�?
      const winResult = checkWinCondition(this.state, this.winCondition);
      if (winResult) {
        this.endGame(winResult.winner, winResult.reason);
        return true;
      }

      // 决斗导致的死亡也可能触发（如决斗输的一方是猎人可以开枪）
      this.processDeathTriggers([deathRecord], () => {
        this.startMarkingPhase();
      });
    } else {
      // 不发动决�?
      this.startMarkingPhase();
    }

    return true;
  }

  // ========== 标记发言阶段 ==========

  private startMarkingPhase(): void {
    this.state.phase = PHASES.DAY_MARKING;
    // 按座位号排列存活玩家（白痴免疫后失去投票权但仍可标记�?
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
      // 标记完成 �?进入投票
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

    // 白痴免疫后失去投票权，但仍然存活
    const candidates = this.state.players
      .filter(p => p.alive)
      .map(p => p.userId);

    this.onPhaseChange?.(this.state);
    this.onVotingStart?.(candidates);
  }

  /**
   * 检查玩家是否有投票权（白痴免疫后失去投票权�?
   */
  private hasVotingRight(player: GamePlayer): boolean {
    if (player.role === ROLES.FOOL) {
      const foolState = player.roleState as FoolState;
      if (foolState.immunityUsed) return false;
    }
    return true;
  }

  handleVote(userId: string, target: string): boolean {
    if (this.state.phase !== PHASES.DAY_VOTING) return false;

    const voter = this.state.players.find(p => p.userId === userId);
    if (!voter || !voter.alive) return false;
    if (!this.hasVotingRight(voter)) return false;
    if (userId === target) return false; // 不可投自�?

    // 不能重复投票
    if (this.collectedVotes.some(v => v.voter === userId)) return false;

    this.collectedVotes.push({ voter: userId, target });

    // 检查是否所有有投票权的人都投了
    const eligibleVoters = this.state.players.filter(p => p.alive && this.hasVotingRight(p));
    if (this.collectedVotes.length >= eligibleVoters.length) {
      this.resolveVotingPhase();
    }

    return true;
  }

  private resolveVotingPhase(): void {
    const result = resolveVoting(this.collectedVotes);
    this.state.history.votes.push([...this.collectedVotes]);

    this.onVotingResult?.(this.collectedVotes, result.exiled, result.tie);

    // 延迟5秒再切换阶段，让玩家有时间查看投票结�?
    setTimeout(() => {
      if (result.exiled) {
        this.handleExile(result.exiled);
      } else {
        // 平票 �?无人出局，进入夜�?
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

    // 检查白痴免�?
    const handler = this.roleHandlers.get(userId);
    if (handler) {
      const blocked = handler.onExile(this.state, player);
      if (blocked) {
        // 白痴免疫生效 �?不出局，身份公开
        this.onFoolImmunity?.(userId);

        // 检查胜负（虽然白痴没死，但可能其他条件满足�?
        const winResult = checkWinCondition(this.state, this.winCondition);
        if (winResult) {
          this.endGame(winResult.winner, winResult.reason);
          return;
        }

        this.advanceToNextNight();
        return;
      }
    }

    // 执行出局
    player.alive = false;
    for (const item of player.items) {
      item.revealed = true;
    }
    const deathRecord: DeathRecord = {
      userId: player.userId,
      seatNumber: player.seatNumber,
      cause: DEATH_CAUSE.EXILED,
      round: this.state.round,
      relics: [...player.items],
    };
    this.state.history.deaths.push(deathRecord);

    // 广播放逐公告（含遗物信息）
    this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

    // 检查胜�?
    const winResult = checkWinCondition(this.state, this.winCondition);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
      return;
    }

    // 处理放逐后的触发链（白狼王带人、猎人开枪等�?
    this.processDeathTriggers([deathRecord], () => {
      this.advanceToNextNight();
    });
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
    // 随机分配一种物�?
    const itemType = pool[Math.floor(Math.random() * pool.length)];

    const item: PlayerItem = {
      type: itemType,
      value: itemType === ITEMS.MOONSTONE ? 0 : '', // 天平徽章在后面计�?
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
