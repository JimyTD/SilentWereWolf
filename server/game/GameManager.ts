import { randomUUID } from 'node:crypto';
import type { Room } from '../../shared/types/room';
import type { GameOverReason } from '../../shared/types/socket';
import { clearPersonas } from './ai/AIPersona';
import { logGameEvent } from './ai/AILogger';

import type {
  GameState,
  GamePlayer,
  NightActions,
  PlayerItem,
  PlayerMarks,
  VoteRecord,
  DeathRecord,
  FoolImmunityRecord,
  WitchState,
  GuardState,
  GameSettings,
  PendingTrigger,
  FoolState,
  KnightState,
  HunterState,
  MarkReason,
} from '../../shared/types/game';
import {
  PHASES,
  ROLES,
  FACTIONS,
  ROLE_FACTION,
  NIGHT_ACTION_ORDER,
  ITEMS,
  DEATH_CAUSE,
  COMMON_REASONS,
} from '../../shared/constants';
import { getRolesFromSettings, isMarkReasonAllowedForIdentity } from '../../shared/validators';
import { createRole } from './roles/index';

type ActionType = 'night' | 'marking' | 'voting' | 'hunter_shoot' | 'wolf_king_drag' | 'knight_duel';

interface ActiveAction {
  actionId: string;
  round: number;
  phase: GameState['phase'];
  actionType: ActionType;
  actorUserIds: string[];
  submittedUserIds: Set<string>;
  allowedTargets: string[];
  timeoutHandles: Map<string, ReturnType<typeof setTimeout>>;
}
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
  private activeAction: ActiveAction | null = null;

  // 回调，由 socket handler 设置
  public onPhaseChange?: (state: GameState) => void;
  public onNightActionPrompt?: (userId: string, roleName: string, targets: string[], witchInfo?: { victim: string | null; hasAntidote: boolean; hasPoison: boolean; canSelfSave: boolean }, actionId?: string) => void;
  public onDayAnnouncement?: (deaths: DeathRecord[], peacefulNight: boolean, round: number, type: 'night' | 'exile') => void;
  public onMarkingTurn?: (userId: string, evaluationMarkCount: number, identities: string[], actionId?: string) => void;
  public onMarksRevealed?: (marks: PlayerMarks) => void;
  public onVotingStart?: (candidates: string[], actionId?: string) => void;
  public onVotingResult?: (votes: VoteRecord[], exiled: string | null, tie: boolean) => void;
  public onGameOver?: (winner: 'good' | 'evil', reason: GameOverReason) => void;
  public onPlayerResigned?: (userId: string) => void;
  public onWolfVoteUpdate?: (wolfUserIds: string[], votes: Record<string, string>, actionId?: string) => void;
  public onInvestigateResult?: (userId: string, target: string, faction: 'good' | 'evil') => void;
  // 守墓人查验结果
  public onAutopsyResult?: (userId: string, target: string, faction: 'good' | 'evil') => void;
  // 触发链回调
  public onHunterTrigger?: (userId: string, canShoot: boolean, targets: string[], actionId?: string) => void;
  public onHunterResult?: (shooter: string, target: string | null, targetDeath: boolean) => void;
  public onWolfKingTrigger?: (userId: string, targets: string[], actionId?: string) => void;
  public onWolfKingResult?: (dragger: string, target: string | null) => void;
  public onFoolImmunity?: (event: FoolImmunityRecord) => void;
  public onKnightTurn?: (userId: string, canDuel: boolean, targets: string[], actionId?: string) => void;
  public onDuelResult?: (knightId: string, targetId: string, loserId: string) => void;

  constructor(room: Room) {
    this.room = room;
  }

  getState(): GameState {
    return this.state;
  }

  /** 获取当前已收集的投票（用于重连恢复） */
  getCollectedVotes(): VoteRecord[] {
    return [...this.collectedVotes];
  }

  private beginAction(
    actionType: ActionType,
    actorUserIds: string[],
    allowedTargets: string[] = [],
  ): string {
    const action: ActiveAction = {
      actionId: randomUUID(),
      round: this.state.round,
      phase: this.state.phase,
      actionType,
      actorUserIds: [...actorUserIds],
      submittedUserIds: new Set<string>(),
      allowedTargets: [...allowedTargets],
      timeoutHandles: new Map<string, ReturnType<typeof setTimeout>>(),
    };
    this.activeAction = action;
    for (const actorUserId of action.actorUserIds) {
      const player = this.room.players.find(roomPlayer => roomPlayer.userId === actorUserId);
      if (player && !player.connected) {
        this.handlePlayerConnectionChange(actorUserId, false);
      }
    }
    return action.actionId;
  }

  private invalidateActiveAction(): void {
    if (this.activeAction) {
      for (const timeoutHandle of this.activeAction.timeoutHandles.values()) {
        clearTimeout(timeoutHandle);
      }
    }
    this.activeAction = null;
  }

  /**
   * 处理真人玩家连接状态变化。在线玩家不启用服务端超时；断线玩家等待 60 秒后自动完成当前行动。
   */
  handlePlayerConnectionChange(userId: string, connected: boolean): void {
    const active = this.activeAction;
    if (!active || !active.actorUserIds.includes(userId)) return;

    const existingTimeout = active.timeoutHandles.get(userId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      active.timeoutHandles.delete(userId);
    }

    if (connected || active.submittedUserIds.has(userId)) return;

    const actionId = active.actionId;
    const timeoutHandle = setTimeout(() => {
      const current = this.activeAction;
      const player = this.room.players.find(roomPlayer => roomPlayer.userId === userId);
      if (
        current?.actionId !== actionId ||
        !player ||
        player.connected ||
        current.submittedUserIds.has(userId)
      ) {
        return;
      }
      current.timeoutHandles.delete(userId);
      this.submitDisconnectedFallback(userId, actionId);
    }, 60000);
    active.timeoutHandles.set(userId, timeoutHandle);
  }

  private submitDisconnectedFallback(userId: string, actionId: string): void {
    const active = this.activeAction;
    if (!active || active.actionId !== actionId) return;

    // 断线兜底必须留痕：真人被服务端代打是复盘关键事件，静默处理会导致排查靠猜
    const nickname = this.room.players.find(p => p.userId === userId)?.nickname || userId.slice(0, 6);
    console.log(`[断线兜底] 房间${this.state.roomId} R${this.state.round} ${nickname} 断线超时，服务端代为行动(${active.actionType})`);
    logGameEvent(this.state.roomId, {
      timestamp: new Date().toISOString(),
      eventType: 'humanAction',
      round: this.state.round,
      actorUserId: userId,
      detail: { nickname, action: 'disconnectedFallback', actionType: active.actionType, actionId },
    });

    switch (active.actionType) {
      case 'night': {
        const player = this.state.players.find(candidate => candidate.userId === userId);
        if (!player) return;
        if (player.role === ROLES.WITCH) {
          this.handleNightAction(userId, { action: 'usePotion', potion: 'none' }, actionId);
          return;
        }
        const target = active.allowedTargets[0];
        const action = player.role === ROLES.WEREWOLF || player.role === ROLES.WOLF_KING
          ? 'attack'
          : player.role === ROLES.SEER
            ? 'investigate'
            : player.role === ROLES.GUARD
              ? 'guard'
              : 'autopsy';
        this.handleNightAction(userId, { action, target }, actionId);
        return;
      }
      case 'marking': {
        const identities = getAvailableIdentities(this.state);
        const identity = identities.includes('好人') ? '好人' : identities[0];
        const targets = this.state.players
          .filter(player => player.alive && player.userId !== userId)
          .slice(0, getEvaluationMarkCount(this.state.players.filter(player => player.alive).length));
        const reason = COMMON_REASONS.INTUITION as MarkReason;
        if (!identity || targets.length === 0) return;
        this.handleSubmitMarks(userId, {
          player: userId,
          round: this.state.round,
          identityMark: { identity, reason },
          evaluationMarks: targets.map(target => ({ target: target.userId, identity: '好人', reason })),
        }, actionId);
        return;
      }
      case 'voting': {
        const target = active.allowedTargets.find(candidate => candidate !== userId);
        if (target) this.handleVote(userId, target, actionId);
        return;
      }
      case 'hunter_shoot':
        this.handleHunterAction(userId, 'skip', undefined, actionId);
        return;
      case 'wolf_king_drag':
        this.handleWolfKingAction(userId, 'skip', undefined, actionId);
        return;
      case 'knight_duel':
        this.handleKnightAction(userId, 'skip', undefined, actionId);
        return;
    }
  }

  /**
   * 玩家认输退出：视为死亡（不触发猎人/狼王等任何技能）、
   * 豁免正在等待的行动、检查胜负。调用方需随后释放其房间占用。
   */
  handleResign(userId: string): boolean {
    if (this.state.status !== 'playing') return false;
    const player = this.state.players.find(p => p.userId === userId);
    if (!player || !player.alive) return false;

    // 若正在等待该玩家行动，先按断线兜底代为提交，避免当前阶段卡死
    const active = this.activeAction;
    if (active && active.actorUserIds.includes(userId) && !active.submittedUserIds.has(userId)) {
      this.submitDisconnectedFallback(userId, active.actionId);
    }

    // 兜底提交可能推进阶段并直接结束游戏（如放逐触发胜负判定）
    if (this.state.status !== 'playing') return true;

    // 认输死亡：主动放弃，不触发任何技能
    player.alive = false;
    // 与其它出局路径保持一致：死亡玩家的物品公开为遗物
    for (const item of player.items) {
      item.revealed = true;
    }
    this.state.history.deaths.push({
      userId,
      seatNumber: player.seatNumber,
      cause: DEATH_CAUSE.RESIGNED,
      round: this.state.round,
      relics: [...player.items],
    });

    console.log(`[认输] 房间${this.state.roomId} R${this.state.round} ${this.room.players.find(p => p.userId === userId)?.nickname || userId.slice(0, 6)} 认输出局`);
    logGameEvent(this.state.roomId, {
      timestamp: new Date().toISOString(),
      eventType: 'humanAction',
      round: this.state.round,
      actorUserId: userId,
      detail: { nickname: this.room.players.find(p => p.userId === userId)?.nickname || '', action: 'resignGame', payload: {} },
    });

    this.onPlayerResigned?.(userId);
    const winResult = checkWinCondition(this.state, this.winCondition);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
    }
    return true;
  }

  /** 当前行动是否仍是活跃行动（未被阶段切换作废） */
  isActionActive(actionId: string | undefined): boolean {
    return !!actionId && this.activeAction?.actionId === actionId;
  }

  private validateAction(
    actionId: string | undefined,
    userId: string,
    actionType: ActionType,
    target?: string,
  ): ActiveAction | null {
    const active = this.activeAction;
    if (!active || active.actionType !== actionType) return null;
    if (actionId && actionId !== active.actionId) return null;
    if (active.round !== this.state.round || active.phase !== this.state.phase) return null;
    if (!active.actorUserIds.includes(userId) || active.submittedUserIds.has(userId)) return null;
    if (target && active.allowedTargets.length > 0 && !active.allowedTargets.includes(target)) return null;
    return active;
  }

  private markActionSubmitted(action: ActiveAction, userId: string): void {
    action.submittedUserIds.add(userId);
    const timeoutHandle = action.timeoutHandles.get(userId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      action.timeoutHandles.delete(userId);
    }
  }

  private isActionGroupComplete(action: ActiveAction): boolean {
    return action.actorUserIds.every(userId => action.submittedUserIds.has(userId));
  }

  /**
   * 重连时重新推送当前阶段的实时操作状态
   * 根据当前 phase 和 nightCurrentRole 等状态，对重连的玩家重新触发相应的回调
   */
  resendCurrentPhaseState(userId: string): void {
    const player = this.state.players.find(p => p.userId === userId);
    if (!player) return;

    switch (this.state.phase) {
      case PHASES.NIGHT: {
        // 夜晚阶段：如果当前等待的角色正好是该玩家，重新发送操作提示
        if (!this.state.nightCurrentRole) break;

        const isWolfRole = this.state.nightCurrentRole === ROLES.WEREWOLF || this.state.nightCurrentRole === ROLES.WOLF_KING;
        const isPlayerWolf = player.role === ROLES.WEREWOLF || player.role === ROLES.WOLF_KING;

        if (isWolfRole && isPlayerWolf && player.alive) {
          // 检查该狼人是否已经投过票
          if (this.state.nightActions.wolves?.votes?.[userId]) break;

          const handler = this.roleHandlers.get(userId);
          if (handler) {
            const targets = handler.getAvailableTargets(this.state, player);
            this.onNightActionPrompt?.(userId, player.role, targets, undefined, this.activeAction?.actionId);
            // 同时发送已有的狼人投票进度
            if (this.state.nightActions.wolves) {
              const aliveWolves = this.state.players.filter(
                p => p.alive && (p.role === ROLES.WEREWOLF || p.role === ROLES.WOLF_KING)
              );
              const wolfIds = aliveWolves.map(w => w.userId);
              this.onWolfVoteUpdate?.(wolfIds, { ...this.state.nightActions.wolves.votes }, this.activeAction?.actionId);
            }
          }
        } else if (this.state.nightCurrentRole === player.role && player.alive) {
          // 非狼人角色，且正好是等待该玩家操作
          const handler = this.roleHandlers.get(userId);
          if (!handler) break;

          // 检查是否已经操作过
          if (this.state.nightCurrentRole === ROLES.WITCH && this.state.nightActions.witch !== null) break;
          if (this.state.nightCurrentRole === ROLES.SEER && this.state.nightActions.seer !== null) break;
          if (this.state.nightCurrentRole === ROLES.GUARD && this.state.nightActions.guard !== null) break;
          if (this.state.nightCurrentRole === ROLES.GRAVEDIGGER && this.state.nightActions.gravedigger !== null) break;

          const targets = handler.getAvailableTargets(this.state, player);
          if (player.role === ROLES.WITCH) {
            const witchState = player.roleState as WitchState;
            const victim = this.state.nightActions.wolves?.target || null;
            this.onNightActionPrompt?.(userId, ROLES.WITCH, targets, {
              victim,
              hasAntidote: !witchState.antidoteUsed,
              hasPoison: !witchState.poisonUsed,
              canSelfSave: this.state.round === 1,
            }, this.activeAction?.actionId);
          } else {
            this.onNightActionPrompt?.(userId, player.role, targets, undefined, this.activeAction?.actionId);
          }
        }
        break;
      }

      case PHASES.DAY_MARKING: {
        // 标记阶段：重新发送当前标记轮次信息
        if (this.state.markingCurrent < this.state.markingOrder.length) {
          const currentUserId = this.state.markingOrder[this.state.markingCurrent];
          const alivePlayers = this.state.players.filter(p => p.alive);
          const evalCount = getEvaluationMarkCount(alivePlayers.length);
          const identities = getAvailableIdentities(this.state);

          // 对重连玩家单独发送 markingTurn（通过回调，handlers.ts 中会处理）
          this.onMarkingTurn?.(currentUserId, evalCount, identities, this.activeAction?.actionId);
        }
        break;
      }

      case PHASES.DAY_VOTING: {
        // 投票阶段：重新发送投票候选人
        const candidates = this.state.players
          .filter(p => p.alive)
          .map(p => p.userId);
        this.onVotingStart?.(candidates, this.activeAction?.actionId);
        break;
      }

      case PHASES.DAY_TRIGGER: {
        // 触发链阶段：重新发送触发提示
        if (this.state.pendingTriggers.length > 0) {
          const trigger = this.state.pendingTriggers[0];
          if (trigger.userId === userId) {
            // 正好是该玩家的触发
            const triggerPlayer = this.state.players.find(p => p.userId === trigger.userId);
            if (triggerPlayer) {
              switch (trigger.type) {
                case 'hunter_shoot': {
                  const targets = this.state.players
                    .filter(p => p.alive && p.userId !== trigger.userId)
                    .map(p => p.userId);
                  const hunterState = triggerPlayer.roleState as HunterState;
                  this.onHunterTrigger?.(trigger.userId, hunterState.canShoot, targets, this.activeAction?.actionId);
                  break;
                }
                case 'wolf_king_drag': {
                  const targets = this.state.players
                    .filter(p => p.alive && p.userId !== trigger.userId)
                    .map(p => p.userId);
                  this.onWolfKingTrigger?.(trigger.userId, targets, this.activeAction?.actionId);
                  break;
                }
              }
            }
          }
        }
        break;
      }

      case PHASES.DAY_KNIGHT: {
        // 骑士决斗阶段：重新发送决斗提示
        const knight = this.state.players.find(
          p => p.alive && p.role === ROLES.KNIGHT
        );
        if (knight && knight.userId === userId) {
          const knightState = knight.roleState as KnightState;
          if (!knightState.duelUsed) {
            const targets = this.state.players
              .filter(p => p.alive && p.userId !== knight.userId)
              .map(p => p.userId);
            this.onKnightTurn?.(knight.userId, true, targets, this.activeAction?.actionId);
          }
        }
        break;
      }
    }
  }

  private get winCondition() {
    return this.room.settings.winCondition || 'edge';
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
        foolImmunities: [],
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
    this.invalidateActiveAction();
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

      // 狼人特殊处理：所有狼人同时行动（含白狼王）
      if (roleName === ROLES.WEREWOLF || roleName === (ROLES.WOLF_KING as string)) {
        const wolves = this.state.players.filter(
          p => p.alive && (p.role === ROLES.WEREWOLF || p.role === ROLES.WOLF_KING)
        );
        if (wolves.length > 0) {
          this.state.nightCurrentRole = ROLES.WEREWOLF;
          const wolfTargets = wolves.flatMap(wolf => {
            const handler = this.roleHandlers.get(wolf.userId);
            return handler ? handler.getAvailableTargets(this.state, wolf) : [];
          });
          const actionId = this.beginAction(
            'night',
            wolves.map(wolf => wolf.userId),
            [...new Set(wolfTargets)],
          );
          for (const wolf of wolves) {
            const handler = this.roleHandlers.get(wolf.userId);
            if (handler) {
              const targets = handler.getAvailableTargets(this.state, wolf);
              this.onNightActionPrompt?.(wolf.userId, wolf.role, targets, undefined, actionId);
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
        const actionId = this.beginAction('night', [witch.userId], targets);
        this.onNightActionPrompt?.(witch.userId, ROLES.WITCH, targets, {
          victim,
          hasAntidote: !witchState.antidoteUsed,
          hasPoison: !witchState.poisonUsed,
          canSelfSave: this.state.round === 1,
        }, actionId);
        return;
      }

      // 守墓人特殊处理：查验已死亡玩家
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
          const actionId = this.beginAction('night', [gd.userId], targets);
          this.onNightActionPrompt?.(gd.userId, ROLES.GRAVEDIGGER, targets, undefined, actionId);
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
        const actionId = this.beginAction('night', [player.userId], targets);
        this.onNightActionPrompt?.(player.userId, roleName, targets, undefined, actionId);
        return;
      }
    }

    // 所有角色行动完毕 → 结算夜晚
    this.resolveNightPhase();
  }

  handleNightAction(
    userId: string,
    action: { action: string; target?: string; potion?: string },
    actionId?: string,
  ): boolean {
    const player = this.state.players.find(p => p.userId === userId);
    if (!player || !player.alive) return false;

    const currentRole = this.state.nightCurrentRole;
    const isWolf = player.role === ROLES.WEREWOLF || player.role === ROLES.WOLF_KING;
    if (!currentRole || (currentRole === ROLES.WEREWOLF ? !isWolf : currentRole !== player.role)) return false;

    const expectedAction = isWolf
      ? 'attack'
      : player.role === ROLES.WITCH
        ? 'usePotion'
        : player.role === ROLES.SEER
          ? 'investigate'
          : player.role === ROLES.GUARD
            ? 'guard'
            : 'autopsy';
    if (action.action !== expectedAction) return false;
    if (player.role === ROLES.WITCH && !['antidote', 'poison', 'none'].includes(action.potion || 'none')) return false;

    const active = this.validateAction(actionId, userId, 'night', action.target);
    if (!active) return false;

    const handler = this.roleHandlers.get(userId);
    if (!handler) return false;

    const success = handler.performNightAction(this.state, player, {
      target: action.target,
      potion: action.potion,
    });

    if (!success) return false;
    this.markActionSubmitted(active, userId);

    // 狼人投票后通知队友
    if (isWolf && this.state.nightActions.wolves) {
      const aliveWolves = this.state.players.filter(
        p => p.alive && (p.role === ROLES.WEREWOLF || p.role === ROLES.WOLF_KING)
      );
      const wolfIds = aliveWolves.map(w => w.userId);
      this.onWolfVoteUpdate?.(wolfIds, { ...this.state.nightActions.wolves.votes }, active.actionId);
    }

    // 预言家查验结果立即返回
    if (player.role === ROLES.SEER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onInvestigateResult?.(userId, action.target, target.faction);
      }
    }

    // 守墓人查验结果立即返回
    if (player.role === ROLES.GRAVEDIGGER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onAutopsyResult?.(userId, action.target, target.faction);
      }
    }

    // 检查当前角色组是否全部完成，完成则切换到下一个夜晚角色
    this.advanceAfterNightAction();

    return true;
  }

  /**
   * 当前角色组的夜晚行动已全部提交时，切换到下一个夜晚角色。
   * 幂等：阶段已不是夜晚或没有活跃行动时什么都不做，避免重复推进。
   */
  private advanceAfterNightAction(): void {
    if (this.state.phase !== PHASES.NIGHT) return;
    if (!this.activeAction) return;
    if (!this.isCurrentRoleGroupDone()) return;

    const currentIndex = NIGHT_ACTION_ORDER.indexOf(this.state.nightCurrentRole as typeof NIGHT_ACTION_ORDER[number]);
    // 跳过同组的狼人角色
    let nextIndex = currentIndex + 1;
    if (this.state.nightCurrentRole === ROLES.WEREWOLF) {
      // 跳到狼人之后的角色
      nextIndex = NIGHT_ACTION_ORDER.indexOf(ROLES.WITCH);
      if (nextIndex === -1) nextIndex = currentIndex + 1;
    }
    this.invalidateActiveAction();
    this.processNextNightRole(nextIndex);
  }

  /**
   * AI 夜晚行动的最终兜底：保证 AI 无法提交行动时阶段仍能推进，不会让整局卡死。
   * 1) 先尝试与断线真人相同的确定性兜底动作；
   * 2) 若兜底动作也被规则拒绝，则把该玩家的行动按"放弃本夜行动"记录并推进阶段。
   * @returns 行动是否已提交或阶段已推进
   */
  forceNightActionFallback(userId: string, actionId?: string): boolean {
    const active = this.activeAction;
    if (!active || active.actionType !== 'night') return true;
    if (actionId && active.actionId !== actionId) return true;

    this.submitDisconnectedFallback(userId, active.actionId);

    // 提交成功：handleNightAction 内部已经完成本组行动的推进
    if (this.activeAction !== active || active.submittedUserIds.has(userId)) return true;

    // 兜底动作仍被拒绝：按"放弃本夜行动"处理，确保阶段能推进
    console.error(
      `[AI兜底] 房间${this.state.roomId} ${userId} 夜晚行动无法提交，按放弃行动处理(actionId=${active.actionId})`,
    );
    const player = this.state.players.find(p => p.userId === userId);
    if (player) {
      switch (player.role) {
        case ROLES.GUARD:
          this.state.nightActions.guard = { target: null };
          break;
        case ROLES.SEER:
          this.state.nightActions.seer = { target: null };
          break;
        case ROLES.GRAVEDIGGER:
          this.state.nightActions.gravedigger = { target: null };
          break;
        case ROLES.WITCH:
          this.state.nightActions.witch = { action: 'none', target: null };
          break;
        default:
          // 狼人组：只记录提交，本夜视为不刀人
          break;
      }
    }
    this.markActionSubmitted(active, userId);
    this.advanceAfterNightAction();
    return true;
  }

  private isCurrentRoleGroupDone(): boolean {
    const role = this.state.nightCurrentRole;
    if (!role) return true;

    if (role === ROLES.WEREWOLF || role === ROLES.WOLF_KING) {
      return this.activeAction?.actionType === 'night' && this.isActionGroupComplete(this.activeAction);
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

  private finishAfterDeathChain(nextStep: () => void): void {
    const winResult = checkWinCondition(this.state, this.winCondition);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
      return;
    }
    nextStep();
  }

  private resolveNightPhase(): void {
    this.invalidateActiveAction();
    const deaths = resolveNight(this.state);

    // 保存本轮夜晚行动到历史
    this.state.history.rounds.push({ ...this.state.nightActions });
    this.state.history.deaths.push(...deaths);

    // 进入白天公告
    this.state.phase = PHASES.DAY_ANNOUNCEMENT;
    this.state.nightCurrentRole = null;
    this.onPhaseChange?.(this.state);
    this.onDayAnnouncement?.(deaths, deaths.length === 0, this.state.round, 'night');

    // 先处理死亡触发，再统一检查胜负；死亡触发可能造成新的死亡。
    this.processDeathTriggers(deaths, () => {
      this.finishAfterDeathChain(() => this.checkKnightDuel());
    });
  }

  // ========== 触发链系统 ==========

  /**
   * 处理死亡触发链
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
          timeout: 60,
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
        const actionId = this.beginAction('hunter_shoot', [trigger.userId], targets);
        this.onHunterTrigger?.(trigger.userId, hunterState.canShoot, targets, actionId);
        // 存储 onComplete 以便 handleHunterAction 调用
        this._triggerOnComplete = onComplete;
        break;
      }
      case 'wolf_king_drag': {
        const targets = this.state.players
          .filter(p => p.alive && p.userId !== trigger.userId)
          .map(p => p.userId);
        const actionId = this.beginAction('wolf_king_drag', [trigger.userId], targets);
        this.onWolfKingTrigger?.(trigger.userId, targets, actionId);
        this._triggerOnComplete = onComplete;
        break;
      }
      default:
        // 未知触发类型，跳过
        this.state.pendingTriggers.shift();
        this.processNextTrigger(onComplete);
        break;
    }
  }

  // 保存触发链完成回调
  private _triggerOnComplete?: () => void;

  /**
   * 猎人开枪操作
   */
  handleHunterAction(userId: string, action: 'shoot' | 'skip', target?: string, actionId?: string): boolean {
    if (this.state.pendingTriggers.length === 0) return false;
    const trigger = this.state.pendingTriggers[0];
    if (trigger.type !== 'hunter_shoot' || trigger.userId !== userId) return false;

    const active = this.validateAction(actionId, userId, 'hunter_shoot', action === 'shoot' ? target : undefined);
    if (!active) return false;

    const hunter = this.state.players.find(p => p.userId === userId);
    if (!hunter) return false;

    this.markActionSubmitted(active, userId);
    this.invalidateActiveAction();

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

        // 被猎人射杀的人也可能触发（如猎人射杀了另一个猎人）... 虽然不太可能
        const newTriggers: PendingTrigger[] = [];
        const victimHandler = this.roleHandlers.get(victim.userId);
        if (victimHandler) {
          const newTrigger = victimHandler.onDeath(this.state, victim, DEATH_CAUSE.SHOT);
          if (newTrigger) {
            newTriggers.push({
              type: newTrigger.type as PendingTrigger['type'],
              userId: newTrigger.userId,
              timeout: 60,
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
   * 白狼王带人操作
   */
  handleWolfKingAction(userId: string, action: 'drag' | 'skip', target?: string, actionId?: string): boolean {
    if (this.state.pendingTriggers.length === 0) return false;
    const trigger = this.state.pendingTriggers[0];
    if (trigger.type !== 'wolf_king_drag' || trigger.userId !== userId) return false;

    const active = this.validateAction(actionId, userId, 'wolf_king_drag', action === 'drag' ? target : undefined);
    if (!active) return false;
    this.markActionSubmitted(active, userId);
    this.invalidateActiveAction();

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

        // 被带走的人也可能触发开枪（如被带走的是猎人）
        const newTriggers: PendingTrigger[] = [];
        const victimHandler = this.roleHandlers.get(victim.userId);
        if (victimHandler) {
          const newTrigger = victimHandler.onDeath(this.state, victim, DEATH_CAUSE.WOLF_KING_DRAG);
          if (newTrigger) {
            newTriggers.push({
              type: newTrigger.type as PendingTrigger['type'],
              userId: newTrigger.userId,
              timeout: 60,
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
        // 骑士存活且未使用决斗，进入决斗阶段
        this.state.phase = PHASES.DAY_KNIGHT;
        this.onPhaseChange?.(this.state);

        const targets = this.state.players
          .filter(p => p.alive && p.userId !== knight.userId)
          .map(p => p.userId);

        const actionId = this.beginAction('knight_duel', [knight.userId], targets);
        this.onKnightTurn?.(knight.userId, true, targets, actionId);
        return;
      }
    }

    // 没有骑士或已用过决斗 → 直接进入标记发言
    this.startMarkingPhase();
  }

  /**
   * 骑士决斗操作
   */
  handleKnightAction(userId: string, action: 'duel' | 'skip', target?: string, actionId?: string): boolean {
    if (this.state.phase !== PHASES.DAY_KNIGHT) return false;

    const knight = this.state.players.find(p => p.userId === userId && p.alive && p.role === ROLES.KNIGHT);
    if (!knight) return false;

    const knightState = knight.roleState as KnightState;
    if (knightState.duelUsed) return false;

    if (action === 'duel' && !target) return false;
    const active = this.validateAction(actionId, userId, 'knight_duel', action === 'duel' ? target : undefined);
    if (!active) return false;
    this.markActionSubmitted(active, userId);
    this.invalidateActiveAction();

    if (action === 'duel') {
      knightState.duelUsed = true;
    }

    if (action === 'duel' && target) {
      const targetPlayer = this.state.players.find(p => p.userId === target && p.alive);
      if (!targetPlayer) {
        // 无效目标，跳过
        this.startMarkingPhase();
        return true;
      }

      // 决斗判定：对方是狼人 → 对方死；对方是好人 → 骑士死
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

      // 检查胜负
      // 先处理决斗造成的死亡触发，再统一检查胜负。

      // 决斗导致的死亡也可能触发（如决斗输的一方是猎人可以开枪）
      this.processDeathTriggers([deathRecord], () => {
        this.finishAfterDeathChain(() => this.startMarkingPhase());
      });
    } else {
      // 不发动决斗
      this.startMarkingPhase();
    }

    return true;
  }

  // ========== 标记发言阶段 ==========

  private startMarkingPhase(): void {
    this.state.phase = PHASES.DAY_MARKING;
    this.invalidateActiveAction();
    // 按座位号排列存活玩家（白痴免疫后失去投票权但仍可标记）
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
    const actionId = this.beginAction('marking', [currentUserId]);

    this.onMarkingTurn?.(currentUserId, evalCount, identities, actionId);
  }

  handleSubmitMarks(userId: string, marks: PlayerMarks, actionId?: string): boolean {
    if (this.state.phase !== PHASES.DAY_MARKING) return false;
    if (this.state.markingOrder[this.state.markingCurrent] !== userId) return false;
    const active = this.validateAction(actionId, userId, 'marking');
    if (!active) return false;

    const availableIdentities = new Set(getAvailableIdentities(this.state));
    if (!availableIdentities.has(marks.identityMark.identity)) return false;

    const availableEvaluationIdentities = new Set([...availableIdentities, '狼人']);
    if (!isMarkReasonAllowedForIdentity(marks.identityMark.identity, marks.identityMark.reason)) return false;

    const maxEvaluationCount = getEvaluationMarkCount(
      this.state.players.filter(player => player.alive).length,
    );
    if (marks.evaluationMarks.length > maxEvaluationCount) return false;

    const evaluatedTargets = new Set<string>();
    for (const mark of marks.evaluationMarks) {
      const target = this.state.players.find(player => player.userId === mark.target);
      if (!target || !target.alive || target.userId === userId) return false;
      if (evaluatedTargets.has(mark.target)) return false;
      if (!availableEvaluationIdentities.has(mark.identity)) return false;
      if (!isMarkReasonAllowedForIdentity(marks.identityMark.identity, mark.reason)) return false;
      evaluatedTargets.add(mark.target);
    }

    marks.round = this.state.round;
    marks.player = userId;
    this.state.history.marks.push(marks);
    this.markActionSubmitted(active, userId);
    this.onMarksRevealed?.(marks);

    this.state.markingCurrent++;
    this.invalidateActiveAction();
    this.promptNextMarking();

    return true;
  }

  // ========== 投票阶段 ==========

  private startVotingPhase(): void {
    this.state.phase = PHASES.DAY_VOTING;
    this.invalidateActiveAction();
    this.collectedVotes = [];

    // 白痴免疫后失去投票权，但仍然存活
    const candidates = this.state.players
      .filter(p => p.alive)
      .map(p => p.userId);
    const eligibleVoters = this.state.players
      .filter(p => p.alive && this.hasVotingRight(p))
      .map(p => p.userId);
    const actionId = this.beginAction('voting', eligibleVoters, candidates);

    this.onPhaseChange?.(this.state);
    this.onVotingStart?.(candidates, actionId);
  }

  /**
   * 检查玩家是否有投票权（白痴免疫后失去投票权）
   */
  private hasVotingRight(player: GamePlayer): boolean {
    if (player.role === ROLES.FOOL) {
      const foolState = player.roleState as FoolState;
      if (foolState.immunityUsed) return false;
    }
    return true;
  }

  handleVote(userId: string, target: string, actionId?: string): boolean {
    if (this.state.phase !== PHASES.DAY_VOTING) return false;

    const voter = this.state.players.find(p => p.userId === userId);
    if (!voter || !voter.alive) return false;
    if (!this.hasVotingRight(voter)) return false;
    if (userId === target) return false; // 不可投自己
    if (!this.state.players.some(p => p.alive && p.userId === target)) return false;

    const active = this.validateAction(actionId, userId, 'voting', target);
    if (!active) return false;

    this.collectedVotes.push({ voter: userId, target });
    this.markActionSubmitted(active, userId);

    // 检查是否所有有投票权的人都投了
    const eligibleVoters = this.state.players.filter(p => p.alive && this.hasVotingRight(p));
    if (this.collectedVotes.length >= eligibleVoters.length) {
      this.resolveVotingPhase();
    }

    return true;
  }

  private resolveVotingPhase(): void {
    this.invalidateActiveAction();
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

    // 检查白痴免疫
    const handler = this.roleHandlers.get(userId);
    if (handler) {
      const blocked = handler.onExile(this.state, player);
      if (blocked) {
        // 白痴免疫生效 → 不出局，身份公开
        const event: FoolImmunityRecord = {
          userId,
          seatNumber: player.seatNumber,
          round: this.state.round,
        };
        this.state.history.foolImmunities.push(event);
        this.onFoolImmunity?.(event);

        // 检查胜负（虽然白痴没死，但可能其他条件满足）
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

    // 先处理放逐产生的死亡触发，再统一检查胜负。
    this.processDeathTriggers([deathRecord], () => {
      this.finishAfterDeathChain(() => this.advanceToNextNight());
    });
  }

  private advanceToNextNight(): void {
    this.state.round++;
    this.startNight();
  }

  // ========== 游戏结束 ==========

  private endGame(winner: 'good' | 'evil', reason: GameOverReason): void {
    this.state.phase = PHASES.GAME_OVER;
    this.state.status = 'finished';
    this.state.winner = winner;
    clearPersonas(this.state.roomId);
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
