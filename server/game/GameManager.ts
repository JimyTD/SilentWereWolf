import type { Room } from '../../shared/types/room';
import type { GameOverReason } from '../../shared/types/socket';
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

  // 鍥炶皟锛岀敱 socket handler 璁剧疆
  public onPhaseChange?: (state: GameState) => void;
  public onNightActionPrompt?: (userId: string, roleName: string, targets: string[], witchInfo?: { victim: string | null; hasAntidote: boolean; hasPoison: boolean; canSelfSave: boolean }) => void;
  public onDayAnnouncement?: (deaths: DeathRecord[], peacefulNight: boolean, round: number, type: 'night' | 'exile') => void;
  public onMarkingTurn?: (userId: string, evaluationMarkCount: number, identities: string[]) => void;
  public onMarksRevealed?: (marks: PlayerMarks) => void;
  public onVotingStart?: (candidates: string[]) => void;
  public onVotingResult?: (votes: VoteRecord[], exiled: string | null, tie: boolean) => void;
  public onGameOver?: (winner: 'good' | 'evil', reason: GameOverReason) => void;
  public onWolfVoteUpdate?: (wolfUserIds: string[], votes: Record<string, string>) => void;
  public onInvestigateResult?: (userId: string, target: string, faction: 'good' | 'evil') => void;
  // 瀹堝浜烘煡楠岀粨鏋?
  public onAutopsyResult?: (userId: string, target: string, faction: 'good' | 'evil') => void;
  // 瑙﹀彂閾惧洖璋?
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

  /** 获取当前已收集的投票（用于重连恢复） */
  getCollectedVotes(): VoteRecord[] {
    return [...this.collectedVotes];
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
            this.onNightActionPrompt?.(userId, player.role, targets);
            // 同时发送已有的狼人投票进度
            if (this.state.nightActions.wolves) {
              const aliveWolves = this.state.players.filter(
                p => p.alive && (p.role === ROLES.WEREWOLF || p.role === ROLES.WOLF_KING)
              );
              const wolfIds = aliveWolves.map(w => w.userId);
              this.onWolfVoteUpdate?.(wolfIds, { ...this.state.nightActions.wolves.votes });
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
            });
          } else {
            this.onNightActionPrompt?.(userId, player.role, targets);
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
          this.onMarkingTurn?.(currentUserId, evalCount, identities);
        }
        break;
      }

      case PHASES.DAY_VOTING: {
        // 投票阶段：重新发送投票候选人
        const candidates = this.state.players
          .filter(p => p.alive)
          .map(p => p.userId);
        this.onVotingStart?.(candidates);
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
                  this.onHunterTrigger?.(trigger.userId, hunterState.canShoot, targets);
                  break;
                }
                case 'wolf_king_drag': {
                  const targets = this.state.players
                    .filter(p => p.alive && p.userId !== trigger.userId)
                    .map(p => p.userId);
                  this.onWolfKingTrigger?.(trigger.userId, targets);
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
            this.onKnightTurn?.(knight.userId, true, targets);
          }
        }
        break;
      }
    }
  }

  private get winCondition() {
    return this.room.settings.winCondition || 'edge';
  }

  // ========== 娓告垙鍒濆鍖?==========

  initializeGame(): void {
    const settings = this.room.settings;
    const roleList = getRolesFromSettings(settings);

    // 闅忔満鎵撲贡瑙掕壊鍒嗛厤
    const shuffledRoles = this.shuffle([...roleList]);

    // 闅忔満鎵撲贡搴т綅鍙?
    const seatNumbers = this.room.players.map((_, i) => i + 1);
    const shuffledSeats = this.shuffle([...seatNumbers]);

    const players: GamePlayer[] = this.room.players.map((rp, index) => {
      const role = shuffledRoles[index] as GamePlayer['role'];
      const faction = ROLE_FACTION[role] as 'good' | 'evil';
      const items = this.assignItems(settings, this.room.players.length, index);
      const roleState = this.initRoleState(role);

      // 鍒涘缓瑙掕壊澶勭悊鍣?
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

    // 璁＄畻澶╁钩寰界珷
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

  // ========== 澶滄櫄娴佺▼ ==========

  startNight(): void {
    this.state.phase = PHASES.NIGHT;
    this.state.nightActions = this.createEmptyNightActions();
    this.onPhaseChange?.(this.state);

    // 浠庣涓€涓湁澶滄櫄琛屽姩鐨勮鑹插紑濮?
    this.processNextNightRole(0);
  }

  private processNextNightRole(fromIndex: number): void {
    for (let i = fromIndex; i < NIGHT_ACTION_ORDER.length; i++) {
      const roleName = NIGHT_ACTION_ORDER[i];

      // 鎵惧埌鎷ユ湁璇ヨ鑹蹭笖瀛樻椿鐨勭帺瀹?
      const playersWithRole = this.state.players.filter(
        p => p.alive && p.role === roleName
      );

      if (playersWithRole.length === 0) continue;

      // 鐙间汉鐗规畩澶勭悊锛氭墍鏈夌嫾浜哄悓鏃惰鍔紙鍚櫧鐙肩帇锛?
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

      // 濂冲帆鐗规畩澶勭悊锛氶渶瑕侀澶栦俊鎭?
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

      // 瀹堝浜虹壒娈婂鐞嗭細鏌ラ獙宸叉浜＄帺瀹?
      if (roleName === ROLES.GRAVEDIGGER) {
        const gd = playersWithRole[0];
        const handler = this.roleHandlers.get(gd.userId);
        if (handler && handler.hasNightAction) {
          const targets = handler.getAvailableTargets(this.state, gd);
          this.state.nightCurrentRole = ROLES.GRAVEDIGGER;
          if (targets.length === 0) {
            // 鏃犳鑰呭彲鏌ワ紝鑷姩璺宠繃
            this.state.nightActions.gravedigger = { target: null };
            continue;
          }
          this.onNightActionPrompt?.(gd.userId, ROLES.GRAVEDIGGER, targets);
          return;
        }
        continue;
      }

      // 閫氱敤瑙掕壊澶勭悊
      const player = playersWithRole[0];
      const handler = this.roleHandlers.get(player.userId);
      if (handler && handler.hasNightAction) {
        this.state.nightCurrentRole = roleName;
        const targets = handler.getAvailableTargets(this.state, player);
        this.onNightActionPrompt?.(player.userId, roleName, targets);
        return;
      }
    }

    // 鎵€鏈夎鑹茶鍔ㄥ畬姣?鈫?缁撶畻澶滄櫄
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

    // 鐙间汉鎶曠エ鍚庨€氱煡闃熷弸
    if ((player.role === ROLES.WEREWOLF || player.role === ROLES.WOLF_KING) && this.state.nightActions.wolves) {
      const aliveWolves = this.state.players.filter(
        p => p.alive && (p.role === ROLES.WEREWOLF || p.role === ROLES.WOLF_KING)
      );
      const wolfIds = aliveWolves.map(w => w.userId);
      this.onWolfVoteUpdate?.(wolfIds, { ...this.state.nightActions.wolves.votes });
    }

    // 棰勮█瀹舵煡楠岀粨鏋滅珛鍗宠繑鍥?
    if (player.role === ROLES.SEER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onInvestigateResult?.(userId, action.target, target.faction);
      }
    }

    // 瀹堝浜烘煡楠岀粨鏋滅珛鍗宠繑鍥?
    if (player.role === ROLES.GRAVEDIGGER && action.target) {
      const target = this.state.players.find(p => p.userId === action.target);
      if (target) {
        this.onAutopsyResult?.(userId, action.target, target.faction);
      }
    }

    // 妫€鏌ュ綋鍓嶈鑹茬粍鏄惁鍏ㄩ儴瀹屾垚
    if (this.isCurrentRoleGroupDone()) {
      const currentIndex = NIGHT_ACTION_ORDER.indexOf(this.state.nightCurrentRole as typeof NIGHT_ACTION_ORDER[number]);
      // 璺宠繃鍚岀粍鐨勭嫾浜鸿鑹?
      let nextIndex = currentIndex + 1;
      if (this.state.nightCurrentRole === ROLES.WEREWOLF) {
        // 璺冲埌鐙间汉涔嬪悗鐨勮鑹?
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

    // 淇濆瓨鏈疆澶滄櫄琛屽姩鍒板巻鍙?
    this.state.history.rounds.push({ ...this.state.nightActions });
    this.state.history.deaths.push(...deaths);

    // 杩涘叆鐧藉ぉ鍏憡
    this.state.phase = PHASES.DAY_ANNOUNCEMENT;
    this.state.nightCurrentRole = null;
    this.onPhaseChange?.(this.state);
    this.onDayAnnouncement?.(deaths, deaths.length === 0, this.state.round, 'night');

    // 妫€鏌ヨ儨璐?
    const winResult = checkWinCondition(this.state, this.winCondition);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
      return;
    }

    // 澶勭悊澶滄櫄姝讳骸鐨勮Е鍙戯紙鐚庝汉琚垁姝诲彲寮€鏋級
    this.processDeathTriggers(deaths, () => {
      // 瑙﹀彂閾惧鐞嗗畬姣曞悗锛屾鏌ユ槸鍚︽湁楠戝＋鍐虫枟
      this.checkKnightDuel();
    });
  }

  // ========== 瑙﹀彂閾剧郴缁?==========

  /**
   * 澶勭悊姝讳骸瑙﹀彂閾?
   * 閬嶅巻姝讳骸鍒楄〃锛屾敹闆嗘墍鏈夐渶瑕佽Е鍙戠殑浜嬩欢锛岀劧鍚庨€愪竴澶勭悊
   */
  private processDeathTriggers(deaths: DeathRecord[], onComplete: () => void): void {
    // 鏀堕泦瑙﹀彂浜嬩欢
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

    // 灏嗚Е鍙戜簨浠跺姞鍏ラ槦鍒楀苟閫愪竴澶勭悊
    this.state.pendingTriggers = triggers;
    this.processNextTrigger(onComplete);
  }

  /**
   * 閫愪竴澶勭悊瑙﹀彂闃熷垪涓殑浜嬩欢
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
        // 瀛樺偍 onComplete 浠ヤ究 handleHunterAction 璋冪敤
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
        // 鏈煡瑙﹀彂绫诲瀷锛岃烦杩?
        this.state.pendingTriggers.shift();
        this.processNextTrigger(onComplete);
        break;
    }
  }

  // 淇濆瓨瑙﹀彂閾惧畬鎴愬洖璋?
  private _triggerOnComplete?: () => void;

  /**
   * 鐚庝汉寮€鏋搷浣?
   */
  handleHunterAction(userId: string, action: 'shoot' | 'skip', target?: string): boolean {
    if (this.state.pendingTriggers.length === 0) return false;
    const trigger = this.state.pendingTriggers[0];
    if (trigger.type !== 'hunter_shoot' || trigger.userId !== userId) return false;

    const hunter = this.state.players.find(p => p.userId === userId);
    if (!hunter) return false;

    // 鏍囪宸茬敤
    const hunterState = hunter.roleState as HunterState;
    hunterState.canShoot = false;

    this.state.pendingTriggers.shift();

    if (action === 'shoot' && target) {
      const victim = this.state.players.find(p => p.userId === target && p.alive);
      if (victim) {
        // 鍑绘潃鐩爣
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

        // 骞挎挱鐚庝汉寮€鏋鑷寸殑姝讳骸鍏憡
        this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

        // 妫€鏌ヨ儨璐?
        const winResult = checkWinCondition(this.state, this.winCondition);
        if (winResult) {
          this.endGame(winResult.winner, winResult.reason);
          return true;
        }

        // 琚寧浜哄皠鏉€鐨勪汉涔熷彲鑳借Е鍙戯紙濡傜寧浜哄皠鏉€浜嗗彟涓€涓寧浜?.. 铏界劧涓嶅お鍙兘锛?
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
        // 灏嗘柊瑙﹀彂浜嬩欢鎻掑叆闃熷垪澶撮儴
        this.state.pendingTriggers = [...newTriggers, ...this.state.pendingTriggers];
      } else {
        this.onHunterResult?.(userId, null, false);
      }
    } else {
      this.onHunterResult?.(userId, null, false);
    }

    // 缁х画澶勭悊瑙﹀彂闃熷垪
    const onComplete = this._triggerOnComplete;
    this._triggerOnComplete = undefined;
    if (onComplete) {
      this.processNextTrigger(onComplete);
    }

    return true;
  }

  /**
   * 鐧界嫾鐜嬪甫浜烘搷浣?
   */
  handleWolfKingAction(userId: string, action: 'drag' | 'skip', target?: string): boolean {
    if (this.state.pendingTriggers.length === 0) return false;
    const trigger = this.state.pendingTriggers[0];
    if (trigger.type !== 'wolf_king_drag' || trigger.userId !== userId) return false;

    this.state.pendingTriggers.shift();

    if (action === 'drag' && target) {
      const victim = this.state.players.find(p => p.userId === target && p.alive);
      if (victim) {
        // 甯﹁蛋鐩爣
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

        // 骞挎挱甯︿汉姝讳骸鍏憡
        this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

        // 妫€鏌ヨ儨璐?
        const winResult = checkWinCondition(this.state, this.winCondition);
        if (winResult) {
          this.endGame(winResult.winner, winResult.reason);
          return true;
        }

        // 琚甫璧扮殑浜轰篃鍙兘瑙﹀彂寮€鏋紙濡傝甯﹁蛋鐨勬槸鐚庝汉锛?
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

    // 缁х画澶勭悊瑙﹀彂闃熷垪
    const onComplete = this._triggerOnComplete;
    this._triggerOnComplete = undefined;
    if (onComplete) {
      this.processNextTrigger(onComplete);
    }

    return true;
  }

  // ========== 楠戝＋鍐虫枟 ==========

  /**
   * 妫€鏌ユ槸鍚︽湁楠戝＋鍙互鍐虫枟锛堝鏅氭浜″叕鍛婂悗銆佹爣璁板彂瑷€鍓嶏級
   */
  private checkKnightDuel(): void {
    const knight = this.state.players.find(
      p => p.alive && p.role === ROLES.KNIGHT
    );

    if (knight) {
      const knightState = knight.roleState as KnightState;
      if (!knightState.duelUsed) {
        // 楠戝＋瀛樻椿涓旀湭浣跨敤鍐虫枟锛岃繘鍏ュ喅鏂楅樁娈?
        this.state.phase = PHASES.DAY_KNIGHT;
        this.onPhaseChange?.(this.state);

        const targets = this.state.players
          .filter(p => p.alive && p.userId !== knight.userId)
          .map(p => p.userId);

        this.onKnightTurn?.(knight.userId, true, targets);
        return;
      }
    }

    // 娌℃湁楠戝＋鎴栧凡鐢ㄨ繃鍐虫枟 鈫?鐩存帴杩涘叆鏍囪鍙戣█
    this.startMarkingPhase();
  }

  /**
   * 楠戝＋鍐虫枟鎿嶄綔
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
        // 鏃犳晥鐩爣锛岃烦杩?
        this.startMarkingPhase();
        return true;
      }

      // 鍐虫枟鍒ゅ畾锛氬鏂规槸鐙间汉 鈫?瀵规柟姝伙紱瀵规柟鏄ソ浜?鈫?楠戝＋姝?
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

      // 骞挎挱鍐虫枟缁撴灉鍏憡
      this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

      // 妫€鏌ヨ儨璐?
      const winResult = checkWinCondition(this.state, this.winCondition);
      if (winResult) {
        this.endGame(winResult.winner, winResult.reason);
        return true;
      }

      // 鍐虫枟瀵艰嚧鐨勬浜′篃鍙兘瑙﹀彂锛堝鍐虫枟杈撶殑涓€鏂规槸鐚庝汉鍙互寮€鏋級
      this.processDeathTriggers([deathRecord], () => {
        this.startMarkingPhase();
      });
    } else {
      // 涓嶅彂鍔ㄥ喅鏂?
      this.startMarkingPhase();
    }

    return true;
  }

  // ========== 鏍囪鍙戣█闃舵 ==========

  private startMarkingPhase(): void {
    this.state.phase = PHASES.DAY_MARKING;
    // 鎸夊骇浣嶅彿鎺掑垪瀛樻椿鐜╁锛堢櫧鐥村厤鐤悗澶卞幓鎶曠エ鏉冧絾浠嶅彲鏍囪锛?
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
      // 鏍囪瀹屾垚 鈫?杩涘叆鎶曠エ
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

  // ========== 鎶曠エ闃舵 ==========

  private startVotingPhase(): void {
    this.state.phase = PHASES.DAY_VOTING;
    this.collectedVotes = [];

    // 鐧界棿鍏嶇柅鍚庡け鍘绘姇绁ㄦ潈锛屼絾浠嶇劧瀛樻椿
    const candidates = this.state.players
      .filter(p => p.alive)
      .map(p => p.userId);

    this.onPhaseChange?.(this.state);
    this.onVotingStart?.(candidates);
  }

  /**
   * 妫€鏌ョ帺瀹舵槸鍚︽湁鎶曠エ鏉冿紙鐧界棿鍏嶇柅鍚庡け鍘绘姇绁ㄦ潈锛?
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
    if (userId === target) return false; // 涓嶅彲鎶曡嚜宸?

    // 涓嶈兘閲嶅鎶曠エ
    if (this.collectedVotes.some(v => v.voter === userId)) return false;

    this.collectedVotes.push({ voter: userId, target });

    // 妫€鏌ユ槸鍚︽墍鏈夋湁鎶曠エ鏉冪殑浜洪兘鎶曚簡
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

    // 寤惰繜5绉掑啀鍒囨崲闃舵锛岃鐜╁鏈夋椂闂存煡鐪嬫姇绁ㄧ粨鏋?
    setTimeout(() => {
      if (result.exiled) {
        this.handleExile(result.exiled);
      } else {
        // 骞崇エ 鈫?鏃犱汉鍑哄眬锛岃繘鍏ュ鏅?
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

    // 妫€鏌ョ櫧鐥村厤鐤?
    const handler = this.roleHandlers.get(userId);
    if (handler) {
      const blocked = handler.onExile(this.state, player);
      if (blocked) {
        // 鐧界棿鍏嶇柅鐢熸晥 鈥?涓嶅嚭灞€锛岃韩浠藉叕寮€
        this.onFoolImmunity?.(userId);

        // 妫€鏌ヨ儨璐燂紙铏界劧鐧界棿娌℃锛屼絾鍙兘鍏朵粬鏉′欢婊¤冻锛?
        const winResult = checkWinCondition(this.state, this.winCondition);
        if (winResult) {
          this.endGame(winResult.winner, winResult.reason);
          return;
        }

        this.advanceToNextNight();
        return;
      }
    }

    // 鎵ц鍑哄眬
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

    // 骞挎挱鏀鹃€愬叕鍛婏紙鍚仐鐗╀俊鎭級
    this.onDayAnnouncement?.([deathRecord], false, this.state.round, 'exile');

    // 妫€鏌ヨ儨璐?
    const winResult = checkWinCondition(this.state, this.winCondition);
    if (winResult) {
      this.endGame(winResult.winner, winResult.reason);
      return;
    }

    // 澶勭悊鏀鹃€愬悗鐨勮Е鍙戦摼锛堢櫧鐙肩帇甯︿汉銆佺寧浜哄紑鏋瓑锛?
    this.processDeathTriggers([deathRecord], () => {
      this.advanceToNextNight();
    });
  }

  private advanceToNextNight(): void {
    this.state.round++;
    this.startNight();
  }

  // ========== 娓告垙缁撴潫 ==========

  private endGame(winner: 'good' | 'evil', reason: GameOverReason): void {
    this.state.phase = PHASES.GAME_OVER;
    this.state.status = 'finished';
    this.state.winner = winner;
    this.onPhaseChange?.(this.state);
    this.onGameOver?.(winner, reason);
  }

  // ========== 杈呭姪鏂规硶 ==========

  private assignItems(settings: GameSettings, playerCount: number, _playerIndex: number): PlayerItem[] {
    if (!settings.items?.enabled) return [];

    const pool = settings.items.pool || [ITEMS.MOONSTONE, ITEMS.BALANCE];
    // 闅忔満鍒嗛厤涓€绉嶇墿鍝?
    const itemType = pool[Math.floor(Math.random() * pool.length)];

    const item: PlayerItem = {
      type: itemType,
      value: itemType === ITEMS.MOONSTONE ? 0 : '', // 澶╁钩寰界珷鍦ㄥ悗闈㈣绠?
      revealed: false,
    };

    return [item];
  }

  private calculateBalanceBadges(players: GamePlayer[]): void {
    // 鎸夊骇浣嶅彿鎺掑簭鍚庤绠楅偦搴э紝褰㈡垚鐜舰搴т綅
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
