import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';
import type { RoomManager } from '../rooms/RoomManager';
import type { GameManager } from '../game/GameManager';
import type { PlayerMarks, VoteRecord, DeathRecord } from '../../shared/types/game';
import { ROLE_FACTION, ROLES } from '../../shared/constants';
import {
  decideNightAction,
  decideMarking,
  decideVote,
  decideTriggerAction,
  fallbackNightAction,
  fallbackMarking,
  fallbackVote,
} from '../game/ai/AIPlayerController';
import { flushLogs, logGameEvent } from '../game/ai/AILogger';
import { testAIConnection } from '../game/ai/AIApiClient';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
const AI_ACTION_TIMEOUT_MS = 60000;

/**
 * 已触发过 AI 决策的行动去重表（key: roomId:actionId:actor）。
 * 玩家断线重连时服务端会重发当前阶段事件（如 onVotingStart）用于同步真人客户端状态，
 * 但事件回调会连带重复触发 AI 决策管线——导致 LLM 重复调用、
 * 幂等拒绝和「投票未被接受→兜底→最终提交失败」风暴。此处按 actionId 去重阻断。
 */
const handledAIActionKeys = new Set<string>();

function shouldRunAIAction(key: string): boolean {
  if (handledAIActionKeys.has(key)) return false;
  handledAIActionKeys.add(key);
  return true;
}

function releaseAIActionKeys(roomId: string): void {
  const prefix = `${roomId}:`;
  for (const key of handledAIActionKeys) {
    if (key.startsWith(prefix)) handledAIActionKeys.delete(key);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => reject(new Error(`${label}超时(${timeoutMs / 1000}s)`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timeoutHandle);
        resolve(value);
      },
      error => {
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

/**
 * 记录真人玩家的行动到对局日志。
 * AI 行动由 AI 决策管线自行记录；本函数只覆盖从 socket 进来的真人提交，
 * 保证复盘时真人用药、投票、标记等关键操作可追溯。
 */
function logHumanAction(
  roomId: string,
  userId: string,
  nickname: string,
  action: string,
  payload: unknown,
  round: number,
): void {
  logGameEvent(roomId, {
    timestamp: new Date().toISOString(),
    eventType: 'humanAction',
    round,
    actorUserId: userId,
    detail: { nickname, action, payload },
  });
  const brief = JSON.stringify(payload);
  console.log(`[真人行动] 房间${roomId} R${round} ${nickname} ${action} ${brief.length > 200 ? brief.slice(0, 200) + '…' : brief}`);
}

export function registerSocketHandlers(
  io: IOServer,
  socket: IOSocket,
  roomManager: RoomManager,
  userId: string,
  nickname: string
): void {
  // 通知连接成功（重连或新连接）
  const existingUser = roomManager.getUser(userId);
  if (existingUser?.roomId) {
    // 重连场景：更新 socketId 和 connected 状态
    const reconnectResult = roomManager.joinRoom(existingUser.roomId, userId, nickname || existingUser.nickname, socket.id);
    const room = roomManager.getRoom(existingUser.roomId);
    if (room) {
      socket.join(existingUser.roomId);
      const gm = roomManager.getGameManager(existingUser.roomId);
      gm?.handlePlayerConnectionChange(userId, true);
      if (gm && room.status === 'playing') {
        const state = gm.getState();
        const player = state.players.find(p => p.userId === userId);
        if (player) {
          // 从死亡历史重建公告
          const announcements = rebuildAnnouncements(state);

          // 重建查验历史（预言家/守墓人）
          const investigations = rebuildInvestigations(state, player);

          socket.emit('server:reconnected', {
            room,
            gameState: {
              myRole: player.role,
              myFaction: player.faction,
              myItems: player.items.map(i => i.type),
              myTeammates: getTeammates(state.players, player),
              players: state.players.map(p => ({
                userId: p.userId,
                nickname: room.players.find(rp => rp.userId === p.userId)?.nickname || '',
                seatNumber: p.seatNumber,
                alive: p.alive,
              })),
              phase: state.phase,
              round: state.round,
              marks: state.history.marks,
              votes: state.history.votes,
              announcements,
              investigations,
            },
          });

          // 重连后重新推送当前阶段的实时操作状态（标记轮次、投票、夜晚操作等）
          gm.resendCurrentPhaseState(userId);

          // 通知房间其他人该玩家已重连
          socket.to(existingUser.roomId).emit('server:roomUpdate', room);
        }
      } else {
        // 等待中的房间：返回 room 数据让前端恢复
        socket.emit('server:connected', { userId, roomId: existingUser.roomId, room });
        // 通知房间其他人
        socket.to(existingUser.roomId).emit('server:roomUpdate', room);
      }
    } else {
      // 房间已不存在
      socket.emit('server:connected', { userId, roomId: null });
    }
  } else {
    socket.emit('server:connected', { userId, roomId: null });
  }

  // ========== 房间事件 ==========

  socket.on('room:create', (data, callback) => {
    console.log(`[room:create] 收到创建房间请求, userId=${userId}, nickname=${nickname}, settings=`, data?.settings?.preset);
    try {
      const result = roomManager.createRoom(userId, nickname, socket.id, data.settings);
      console.log(`[room:create] 创建结果: success=${result.success}, roomId=${result.roomId}, error=${result.error}`);
      if (result.success && result.roomId) {
        socket.join(result.roomId);
      }
      callback(result);
    } catch (err) {
      console.error('[room:create] 异常:', err);
      callback({ success: false, error: 'INTERNAL_ERROR', message: '创建房间失败' });
    }
  });

  socket.on('room:join', (data, callback) => {
    try {
      const result = roomManager.joinRoom(data.roomId, userId, data.nickname || nickname, socket.id);
      if (result.success && result.room) {
        socket.join(data.roomId);
        // 通知房间内其他人
        const player = result.room.players.find(p => p.userId === userId);
        if (player) {
          socket.to(data.roomId).emit('server:playerJoined', player);
        }
      }
      callback(result);
    } catch (err) {
      callback({ success: false, error: 'INTERNAL_ERROR', message: '加入房间失败' });
    }
  });

  socket.on('room:leave', () => {
    try {
      const user = roomManager.getUser(userId);
      const roomId = user?.roomId;
      if (!roomId) return;

      const result = roomManager.leaveRoom(userId);
      socket.leave(roomId);

      if (!result.destroyed && result.room) {
        io.to(roomId).emit('server:playerLeft', { userId });
        if (result.wasHost && result.newHost) {
          io.to(roomId).emit('server:roomUpdate', result.room);
        }
      }
    } catch (err) {
      console.error('[room:leave] 错误:', err);
    }
  });

  socket.on('room:kick', (data) => {
    try {
      // 支持踢 AI 和普通玩家
      if (roomManager.isAI(data.targetUserId)) {
        const result = roomManager.removeAIPlayer(userId, data.targetUserId);
        if (result.success && result.room) {
          io.to(result.room.roomId).emit('server:roomUpdate', result.room);
        }
        return;
      }

      const result = roomManager.kickPlayer(userId, data.targetUserId);
      if (result.success && result.room) {
        // 通知被踢者
        const targetUser = roomManager.getUser(data.targetUserId);
        if (targetUser) {
          io.to(targetUser.socketId).emit('server:kicked', { reason: '你被房主踢出了房间' });
        }
        io.to(result.room.roomId).emit('server:roomUpdate', result.room);
      }
    } catch (err) {
      console.error('[room:kick] 错误:', err);
    }
  });

  socket.on('room:updateSettings', (data) => {
    try {
      const result = roomManager.updateSettings(userId, data.settings);
      if (result.success && result.room) {
        io.to(result.room.roomId).emit('server:roomUpdate', result.room);
      }
    } catch (err) {
      console.error('[room:updateSettings] 错误:', err);
    }
  });

  // ========== AI 管理事件 ==========

  socket.on('room:addAI', async (callback) => {
    try {
      const result = await roomManager.addAIPlayer(userId);
      if (result.success && result.room && result.player) {
        // 通知房间所有人（包括自己）有新玩家加入
        io.to(result.room.roomId).emit('server:roomUpdate', result.room);
      }
      callback({ success: result.success, error: result.error, message: result.message });
    } catch (err) {
      console.error('[room:addAI] 错误:', err);
      callback({ success: false, error: 'INTERNAL_ERROR', message: '添加AI失败' });
    }
  });

  socket.on('room:removeAI', (data) => {
    try {
      const result = roomManager.removeAIPlayer(userId, data.targetUserId);
      if (result.success && result.room) {
        io.to(result.room.roomId).emit('server:roomUpdate', result.room);
      }
    } catch (err) {
      console.error('[room:removeAI] 错误:', err);
    }
  });

  socket.on('room:testAI', async (callback) => {
    try {
      const result = await testAIConnection();
      callback({ success: result.success, message: result.message });
    } catch (err) {
      console.error('[room:testAI] 错误:', err);
      callback({ success: false, message: 'AI 测试失败' });
    }
  });

  // ========== 开始游戏 ==========

  socket.on('room:startGame', (callback) => {
    try {
      const result = roomManager.startGame(userId);
      if (!result.success || !result.gameManager || !result.room) {
        callback({ success: false, error: result.error, message: result.message });
        return;
      }

      const gm = result.gameManager;
      const room = result.room;
      const state = gm.getState();

      // 绑定游戏回调（含 AI 逻辑）
      bindGameCallbacks(io, gm, room.roomId, roomManager);

      // 向每位真人玩家单独推送身份信息（跳过 AI）
      for (const gamePlayer of state.players) {
        if (roomManager.isAI(gamePlayer.userId)) continue;

        const user = roomManager.getUser(gamePlayer.userId);
        if (!user) continue;

        const teammates = getTeammates(state.players, gamePlayer);

        io.to(user.socketId).emit('server:gameStart', {
          role: gamePlayer.role,
          faction: gamePlayer.faction,
          seatNumber: gamePlayer.seatNumber,
          items: gamePlayer.items.map(i => i.type),
          teammates,
          players: state.players.map(p => ({
            userId: p.userId,
            nickname: room.players.find(pr => pr.userId === p.userId)?.nickname || '',
            seatNumber: p.seatNumber,
            alive: p.alive,
          })),
          settings: room.settings,
          phase: state.phase,
          round: state.round,
        });
      }

      // 开始夜晚
      gm.startNight();

      callback({ success: true });
    } catch (err) {
      console.error('[room:startGame] 错误:', err);
      callback({ success: false, error: 'INTERNAL_ERROR', message: '开始游戏失败' });
    }
  });

  // ========== 游戏事件 ==========

  socket.on('client:nightAction', (data) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) return;
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) return;
      logHumanAction(user.roomId, userId, nickname, 'nightAction', data, gm.getState().round);
      gm.handleNightAction(userId, data, data.actionId);
    } catch (err) {
      console.error('[client:nightAction] 错误:', err);
    }
  });

  socket.on('client:submitMarks', (data, callback) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) {
        callback?.({ success: false, error: 'NOT_IN_ROOM', message: '你当前不在房间中' });
        return;
      }
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND', message: '游戏状态不存在' });
        return;
      }

      const marks: PlayerMarks = {
        player: userId,
        round: gm.getState().round,
        identityMark: data.identityMark,
        evaluationMarks: data.evaluationMarks,
      };
      logHumanAction(user.roomId, userId, nickname, 'submitMarks', data, marks.round);
      const submitted = gm.handleSubmitMarks(userId, marks, data.actionId);
      callback?.(submitted
        ? { success: true }
        : { success: false, error: 'INVALID_MARKS', message: '标记内容不符合当前规则，或当前已不是你的标记回合' });
    } catch (err) {
      console.error('[client:submitMarks] 错误:', err);
      callback?.({ success: false, error: 'INTERNAL_ERROR', message: '提交标记失败，请稍后重试' });
    }
  });

  socket.on('client:vote', (data) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) return;
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) return;
      logHumanAction(user.roomId, userId, nickname, 'vote', data, gm.getState().round);
      gm.handleVote(userId, data.target, data.actionId);
    } catch (err) {
      console.error('[client:vote] 错误:', err);
    }
  });

  // ========== 触发链事件 ==========

  socket.on('client:hunterAction', (data) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) return;
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) return;
      logHumanAction(user.roomId, userId, nickname, 'hunterAction', data, gm.getState().round);
      gm.handleHunterAction(userId, data.action, data.target, data.actionId);
    } catch (err) {
      console.error('[client:hunterAction] 错误:', err);
    }
  });

  socket.on('client:knightAction', (data) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) return;
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) return;
      logHumanAction(user.roomId, userId, nickname, 'knightAction', data, gm.getState().round);
      gm.handleKnightAction(userId, data.action, data.target, data.actionId);
    } catch (err) {
      console.error('[client:knightAction] 错误:', err);
    }
  });

  socket.on('client:wolfKingAction', (data) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) return;
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) return;
      logHumanAction(user.roomId, userId, nickname, 'wolfKingAction', data, gm.getState().round);
      gm.handleWolfKingAction(userId, data.action, data.target, data.actionId);
    } catch (err) {
      console.error('[client:wolfKingAction] 错误:', err);
    }
  });

  // ========== 认输退出 ==========
  socket.on('client:resignGame', (callback) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) {
        callback?.({ success: false, error: 'NOT_IN_ROOM', message: '你不在房间中' });
        return;
      }
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) {
        callback?.({ success: false, error: 'GAME_NOT_FOUND', message: '游戏状态不存在' });
        return;
      }
      logHumanAction(user.roomId, userId, nickname, 'resignGame', {}, gm.getState().round);
      const ok = gm.handleResign(userId);
      if (!ok) {
        callback?.({ success: false, error: 'CANNOT_RESIGN', message: '当前无法认输（游戏未开始或你已出局）' });
        return;
      }
      // 释放房间占用：游戏中离开标记掉线并清空 roomId，玩家可立即开新局
      roomManager.leaveRoom(userId);
      callback?.({ success: true });
    } catch (err) {
      console.error('[client:resignGame] 错误:', err);
      callback?.({ success: false, error: 'INTERNAL_ERROR', message: '认输处理失败，请稍后重试' });
    }
  });

  // ========== 断线处理 ==========

  socket.on('disconnect', () => {
    console.log(`[断线] ${nickname}(${userId}) 已断线`);
    const result = roomManager.handleDisconnect(userId);
    if (result.roomId) {
      const gm = roomManager.getGameManager(result.roomId);
      gm?.handlePlayerConnectionChange(userId, false);
      io.to(result.roomId).emit('server:playerLeft', { userId });
    }
  });
}

// ========== 辅助函数 ==========

function rebuildAnnouncements(state: import('../../shared/types/game').GameState): import('../../shared/types/socket').DayAnnouncementData[] {
  const announcements: import('../../shared/types/socket').DayAnnouncementData[] = [];
  const deathsByRound = new Map<number, { night: typeof state.history.deaths; exile: typeof state.history.deaths }>();

  for (const death of state.history.deaths) {
    if (!deathsByRound.has(death.round)) {
      deathsByRound.set(death.round, { night: [], exile: [] });
    }
    const group = deathsByRound.get(death.round)!;
    if (death.cause === 'exiled') {
      group.exile.push(death);
    } else {
      group.night.push(death);
    }
  }

  // 按轮次排列，每轮先夜晚公告再放逐公告
  const rounds = Array.from(deathsByRound.keys()).sort((a, b) => a - b);
  for (const round of rounds) {
    const group = deathsByRound.get(round)!;
    // 夜晚公告
    if (group.night.length > 0) {
      announcements.push({
        round,
        type: 'night',
        deaths: group.night.map(d => ({
          userId: d.userId,
          seatNumber: d.seatNumber,
          cause: d.cause,
          relics: d.relics,
        })),
        peacefulNight: false,
      });
    }
    // 放逐公告
    for (const exile of group.exile) {
      announcements.push({
        round,
        type: 'exile',
        deaths: [{
          userId: exile.userId,
          seatNumber: exile.seatNumber,
          cause: exile.cause,
          relics: exile.relics,
        }],
        peacefulNight: false,
      });
    }
  }

  // 如果某轮夜晚没有死人（平安夜），也要补上
  for (let r = 1; r <= state.round; r++) {
    const hasNightAnnounce = announcements.some(a => a.round === r && a.type === 'night');
    if (!hasNightAnnounce && r <= state.history.rounds.length) {
      announcements.push({
        round: r,
        type: 'night',
        deaths: [],
        peacefulNight: true,
      });
    }
  }

  // 最终按 round 排序，同 round 内 night 在 exile 前
  announcements.sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.type === 'night' ? -1 : 1;
  });

  return announcements;
}

/**
 * 重建查验历史（预言家/守墓人的历史查验结果）
 * 从夜晚行动历史中提取该玩家的查验目标，并查找目标的阵营
 */
function rebuildInvestigations(
  state: import('../../shared/types/game').GameState,
  player: import('../../shared/types/game').GamePlayer,
): { target: string; faction: import('../../shared/types/game').Faction }[] {
  const investigations: { target: string; faction: import('../../shared/types/game').Faction }[] = [];

  if (player.role === ROLES.SEER) {
    // 预言家：从每轮夜晚行动中提取 seer 查验的目标
    for (const round of state.history.rounds) {
      if (round.seer?.target) {
        const target = state.players.find(p => p.userId === round.seer!.target);
        if (target) {
          investigations.push({ target: target.userId, faction: target.faction });
        }
      }
    }
  } else if (player.role === ROLES.GRAVEDIGGER) {
    // 守墓人：从每轮夜晚行动中提取 gravedigger 查验的目标
    for (const round of state.history.rounds) {
      if (round.gravedigger?.target) {
        const target = state.players.find(p => p.userId === round.gravedigger!.target);
        if (target) {
          investigations.push({ target: target.userId, faction: target.faction });
        }
      }
    }
  }

  return investigations;
}

function getTeammates(
  players: { userId: string; seatNumber: number; role: string; faction: string }[],
  currentPlayer: { userId: string; faction: string }
): { userId: string; seatNumber: number }[] {
  if (currentPlayer.faction !== 'evil') return [];
  return players
    .filter(p => p.faction === 'evil' && p.userId !== currentPlayer.userId)
    .map(p => ({ userId: p.userId, seatNumber: p.seatNumber }));
}

// ========== 游戏回调绑定（含 AI 逻辑） ==========

function bindGameCallbacks(
  io: IOServer,
  gm: GameManager,
  roomId: string,
  roomManager: RoomManager
): void {
  gm.onPhaseChange = (state) => {
    io.to(roomId).emit('server:phaseChange', {
      phase: state.phase,
      round: state.round,
    });
  };

  gm.onNightActionPrompt = (targetUserId, roleName, targets, witchInfo, actionId) => {
    // AI 玩家：调用 AIPlayerController 决策
    if (roomManager.isAI(targetUserId)) {
      handleAINightAction(gm, roomManager, roomId, targetUserId, roleName, targets, witchInfo, actionId);
      return;
    }

    // 真人玩家：推送 socket 事件
    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    const timeout = gm.getState().players.length > 0
      ? (roomManager.getRoom(roomId)?.settings.timers?.nightAction || 20)
      : 20;

    const prompt: Parameters<ServerToClientEvents['server:nightAction']>[0] = {
      role: roleName,
      actionId,
      timeout,
      availableTargets: targets,
    };
    if (witchInfo) {
      prompt.witchInfo = witchInfo;
    }
    io.to(user.socketId).emit('server:nightAction', prompt);
  };

  gm.onWolfVoteUpdate = (wolfUserIds, votes, actionId) => {
    // 向所有存活的真人狼人推送队友的投票情况
    for (const wolfId of wolfUserIds) {
      if (roomManager.isAI(wolfId)) continue;
      const user = roomManager.getUser(wolfId);
      if (!user) continue;
      io.to(user.socketId).emit('server:wolfVoteUpdate', { votes, actionId });
    }
  };

  gm.onInvestigateResult = (targetUserId, target, faction) => {
    // AI 不需要接收查验结果推送（已在 Context 中获取）
    if (roomManager.isAI(targetUserId)) return;

    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    io.to(user.socketId).emit('server:investigateResult', { target, faction });
  };

  // 守墓人查验结果
  gm.onAutopsyResult = (targetUserId, target, faction) => {
    if (roomManager.isAI(targetUserId)) return;

    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    io.to(user.socketId).emit('server:autopsyResult', { target, faction });
  };

  gm.onDayAnnouncement = (deaths, peacefulNight, round, type) => {
    io.to(roomId).emit('server:dayAnnouncement', {
      round,
      type,
      deaths: deaths.map(d => ({
        userId: d.userId,
        seatNumber: d.seatNumber,
        cause: d.cause,
        relics: d.relics,
      })),
      peacefulNight,
    });
  };

  gm.onMarkingTurn = (targetUserId, evaluationMarkCount, identities, actionId) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    // 通知所有真人当前发言者
    io.to(roomId).emit('server:markingTurn', {
      yourTurn: false,
      currentPlayer: targetUserId,
      actionId,
      timeout: room.settings.timers?.marking || 60,
      evaluationMarkCount,
      availableIdentities: identities,
    });

    // AI 玩家：调用 AIPlayerController 决策
    if (roomManager.isAI(targetUserId)) {
      handleAIMarking(gm, roomManager, roomId, targetUserId, evaluationMarkCount, identities, actionId);
      return;
    }

    // 真人玩家：单独通知
    const user = roomManager.getUser(targetUserId);
    if (user) {
      io.to(user.socketId).emit('server:markingTurn', {
        yourTurn: true,
        currentPlayer: targetUserId,
        actionId,
        timeout: room.settings.timers?.marking || 60,
        evaluationMarkCount,
        availableIdentities: identities,
      });
    }
  };

  gm.onMarksRevealed = (marks) => {
    io.to(roomId).emit('server:marksRevealed', marks);
  };

  gm.onVotingStart = (candidates, actionId) => {
    const room = roomManager.getRoom(roomId);
    io.to(roomId).emit('server:votingStart', {
      actionId,
      timeout: room?.settings.timers?.voting || 30,
      candidates,
    });

    // 所有 AI 玩家自动投票
    handleAIVoting(gm, roomManager, roomId, candidates, actionId);
  };

  gm.onVotingResult = (votes, exiled, tie) => {
    io.to(roomId).emit('server:votingResult', { votes, exiled, tie });
  };

  // ========== 触发链回调 ==========

  gm.onHunterTrigger = (targetUserId, canShoot, targets, actionId) => {
    // AI 猎人自动决策
    if (roomManager.isAI(targetUserId)) {
      handleAIHunterAction(gm, roomManager, roomId, targetUserId, canShoot, targets, actionId);
      return;
    }

    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    io.to(user.socketId).emit('server:hunterTrigger', { canShoot, timeout: 60, actionId });
    // 通知所有人进入猎人阶段
    io.to(roomId).emit('server:phaseChange', { phase: 'day_trigger', round: gm.getState().round });
  };

  gm.onHunterResult = (shooter, target, targetDeath) => {
    io.to(roomId).emit('server:hunterResult', { shooter, target, targetDeath });
  };

  gm.onWolfKingTrigger = (targetUserId, targets, actionId) => {
    // AI 白狼王自动决策
    if (roomManager.isAI(targetUserId)) {
      handleAIWolfKingAction(gm, roomManager, roomId, targetUserId, targets, actionId);
      return;
    }

    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    io.to(user.socketId).emit('server:wolfKingTrigger', { timeout: 60, actionId });
    io.to(roomId).emit('server:phaseChange', { phase: 'day_trigger', round: gm.getState().round });
  };

  gm.onWolfKingResult = (dragger, target) => {
    io.to(roomId).emit('server:wolfKingResult', { dragger, target });
  };

  gm.onFoolImmunity = (foolUserId) => {
    io.to(roomId).emit('server:foolImmunity', { userId: foolUserId });
  };

  gm.onKnightTurn = (targetUserId, canDuel, targets, actionId) => {
    // AI 骑士自动决策
    if (roomManager.isAI(targetUserId)) {
      handleAIKnightAction(gm, roomManager, roomId, targetUserId, canDuel, targets, actionId);
      return;
    }

    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    io.to(user.socketId).emit('server:knightTurn', { canDuel, timeout: 60, actionId });
    // 通知所有人谁可以决斗
    io.to(roomId).emit('server:phaseChange', { phase: 'day_knight', round: gm.getState().round });
  };

  gm.onDuelResult = (knightId, targetId, loserId) => {
    io.to(roomId).emit('server:duelResult', { loser: loserId });
  };

  gm.onPlayerResigned = (resignedUserId) => {
    // 认输视为离局，复用 playerLeft 通知前端更新
    io.to(roomId).emit('server:playerLeft', { userId: resignedUserId });
  };

  gm.onGameOver = (winner, reason) => {
    const state = gm.getState();
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    // 结局快照写入对局日志：胜负原因 + 全员角色揭示 + 完整死亡历史。
    // 没有这份快照，复盘时真人玩家的角色、用药、毒杀目标与胜负原因都无从查证。
    logGameEvent(roomId, {
      timestamp: new Date().toISOString(),
      eventType: 'gameOver',
      round: state.round,
      actorUserId: 'system',
      detail: {
        winner,
        reason,
        players: state.players.map(p => ({
          seatNumber: p.seatNumber,
          nickname: room.players.find(rp => rp.userId === p.userId)?.nickname || '',
          userId: p.userId,
          role: p.role,
          faction: p.faction,
          alive: p.alive,
        })),
        deaths: state.history.deaths,
      },
    });
    console.log(`[游戏结束] 房间${roomId} 第${state.round}轮结束 胜方=${winner} 原因=${reason}`);

    io.to(roomId).emit('server:gameOver', {
      winner,
      reason,
      players: state.players.map(p => ({
        userId: p.userId,
        nickname: room.players.find(rp => rp.userId === p.userId)?.nickname || '',
        seatNumber: p.seatNumber,
        alive: p.alive,
        role: p.role,
        faction: p.faction,
        items: p.items,
      })),
      history: {
        rounds: state.history.rounds,
        marks: state.history.marks,
        votes: state.history.votes,
        deaths: state.history.deaths,
      },
    });

    // 保存 AI 对局日志
    flushLogs(roomId);
    // 清理本局的 AI 决策去重记录
    releaseAIActionKeys(roomId);

    roomManager.endGame(roomId);
  };
}

// ========== AI 行动处理函数 ==========

async function handleAINightAction(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  aiUserId: string,
  roleName: string,
  targets: string[],
  witchInfo?: { victim: string | null; hasAntidote: boolean; hasPoison: boolean; canSelfSave: boolean },
  actionId?: string,
): Promise<void> {
  // 防重入：同一 actionId 同一玩家只决策一次（重连同步会重复触发）
  if (!shouldRunAIAction(`${roomId}:${actionId ?? 'legacy'}:${aiUserId}`)) return;
  const state = gm.getState();
  const room = roomManager.getRoom(roomId);
  if (!room) return;

  const aiPlayer = state.players.find(p => p.userId === aiUserId);
  if (!aiPlayer) return;

  let result: Awaited<ReturnType<typeof decideNightAction>>;
  let fallbackUsed = false;
  try {
    result = await withTimeout(
      decideNightAction(state, room, aiPlayer, targets, witchInfo),
      AI_ACTION_TIMEOUT_MS,
      'AI 夜晚决策',
    );
  } catch (err) {
    fallbackUsed = true;
    console.error(`[AI] 夜晚决策失败，使用兜底(${aiUserId}):`, err);
    result = fallbackNightAction(roleName, targets, witchInfo, state);
  }

  console.log(`[AI] ${room.players.find(p => p.userId === aiUserId)?.nickname} 夜晚行动:`, result);
  let submitted = gm.handleNightAction(aiUserId, result, actionId);

  if (!submitted && !fallbackUsed) {
    fallbackUsed = true;
    console.warn(`[AI] 夜晚行动未被接受，使用兜底(${aiUserId})`);
    submitted = gm.handleNightAction(
      aiUserId,
      fallbackNightAction(roleName, targets, witchInfo, state),
      actionId,
    );
  }

  if (!submitted) {
    console.error(`[AI] 夜晚行动最终提交失败(${aiUserId}, actionId=${actionId || 'legacy'})`);
  }
}

async function handleAIMarking(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  aiUserId: string,
  evaluationMarkCount: number,
  identities: string[],
  actionId?: string,
): Promise<void> {
  // 防重入：同一 actionId 同一玩家只决策一次（重连同步会重复触发）
  if (!shouldRunAIAction(`${roomId}:${actionId ?? 'legacy'}:${aiUserId}`)) return;
  const state = gm.getState();
  const room = roomManager.getRoom(roomId);
  if (!room) return;

  const aiPlayer = state.players.find(p => p.userId === aiUserId);
  if (!aiPlayer) return;

  const targets = state.players
    .filter(player => player.alive && player.userId !== aiUserId)
    .map(player => ({
      userId: player.userId,
      nickname: room.players.find(roomPlayer => roomPlayer.userId === player.userId)?.nickname || '未知',
      seatNumber: player.seatNumber,
    }));

  let result: Awaited<ReturnType<typeof decideMarking>>;
  let fallbackUsed = false;
  try {
    result = await withTimeout(
      decideMarking(state, room, aiPlayer, evaluationMarkCount, identities),
      AI_ACTION_TIMEOUT_MS,
      'AI 标记决策',
    );
  } catch (err) {
    fallbackUsed = true;
    console.error(`[AI] 标记决策失败，使用兜底(${aiUserId}):`, err);
    result = fallbackMarking(aiPlayer, targets, evaluationMarkCount, identities, state);
  }

  console.log(`[AI] ${room.players.find(p => p.userId === aiUserId)?.nickname} 标记发言:`, result.identityMark.identity);

  const submit = (markResult: Awaited<ReturnType<typeof decideMarking>>): boolean => {
    const marks: PlayerMarks = {
      player: aiUserId,
      round: state.round,
      identityMark: markResult.identityMark,
      evaluationMarks: markResult.evaluationMarks,
    };
    return gm.handleSubmitMarks(aiUserId, marks, actionId);
  };

  let submitted = submit(result);
  if (!submitted && !fallbackUsed) {
    fallbackUsed = true;
    console.warn(`[AI] 标记未被接受，使用兜底(${aiUserId})`);
    submitted = submit(fallbackMarking(aiPlayer, targets, evaluationMarkCount, identities, state));
  }

  if (!submitted) {
    console.error(`[AI] 标记最终提交失败(${aiUserId}, actionId=${actionId || 'legacy'})`);
  }
}

async function handleAIVoting(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  candidates: string[],
  actionId?: string,
): Promise<void> {
  // 防重入：一次投票行动只跑一轮 AI 决策（重连同步会重复触发）
  if (!shouldRunAIAction(`${roomId}:${actionId ?? 'legacy'}:voting`)) return;
  const state = gm.getState();
  const room = roomManager.getRoom(roomId);
  if (!room) return;

  // 找到所有存活的 AI 玩家
  const aiVoters = state.players.filter(
    p => p.alive && roomManager.isAI(p.userId)
  );

  for (const aiPlayer of aiVoters) {
    const validCandidates = candidates.filter(candidate => candidate !== aiPlayer.userId);
    if (validCandidates.length === 0) {
      console.error(`[AI] 没有合法投票目标(${aiPlayer.userId}, actionId=${actionId || 'legacy'})`);
      continue;
    }

    let target: string;
    let fallbackUsed = false;
    try {
      target = await withTimeout(
        decideVote(state, room, aiPlayer, candidates),
        AI_ACTION_TIMEOUT_MS,
        'AI 投票决策',
      );
    } catch (err) {
      fallbackUsed = true;
      console.error(`[AI] 投票决策失败，使用兜底(${aiPlayer.userId}):`, err);
      target = fallbackVote(state, aiPlayer, validCandidates);
    }

    console.log(`[AI] ${room.players.find(p => p.userId === aiPlayer.userId)?.nickname} 投票: → ${target}`);
    let submitted = gm.handleVote(aiPlayer.userId, target, actionId);

    if (!submitted && !fallbackUsed) {
      // 行动已失效（阶段切换/已被代打）时，兜底提交注定失败，直接放弃避免无效重试
      if (!gm.isActionActive(actionId)) {
        console.warn(`[AI] 投票行动已失效，放弃提交(${aiPlayer.userId}, actionId=${actionId || 'legacy'})`);
        continue;
      }
      fallbackUsed = true;
      console.warn(`[AI] 投票未被接受，使用兜底(${aiPlayer.userId})`);
      submitted = gm.handleVote(
        aiPlayer.userId,
        fallbackVote(state, aiPlayer, validCandidates),
        actionId,
      );
    }

    if (!submitted) {
      console.error(`[AI] 投票最终提交失败(${aiPlayer.userId}, actionId=${actionId || 'legacy'})`);
    }
  }
}

// AI 猎人开枪决策
async function handleAIHunterAction(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  aiUserId: string,
  canShoot: boolean,
  targets: string[],
  actionId?: string,
): Promise<void> {
  const submitSkip = (): boolean => gm.handleHunterAction(aiUserId, 'skip', undefined, actionId);
  if (!canShoot || targets.length === 0) {
    submitSkip();
    return;
  }

  const state = gm.getState();
  const room = roomManager.getRoom(roomId);
  const aiPlayer = state.players.find(player => player.userId === aiUserId);
  if (!room || !aiPlayer) {
    submitSkip();
    return;
  }

  try {
    const result = await withTimeout(
      decideTriggerAction(state, room, aiPlayer, 'hunter_shoot', targets, { canShoot }),
      AI_ACTION_TIMEOUT_MS,
      'AI 猎人决策',
    );
    const target = result.action === 'shoot' && targets.includes(result.target || '')
      ? result.target
      : undefined;
    const submitted = target
      ? gm.handleHunterAction(aiUserId, 'shoot', target, actionId)
      : submitSkip();
    if (!submitted) submitSkip();
  } catch (err) {
    console.error(`[AI] 猎人决策失败，跳过开枪(${aiUserId}):`, err);
    submitSkip();
  }
}

// AI 白狼王带人决策
async function handleAIWolfKingAction(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  aiUserId: string,
  targets: string[],
  actionId?: string,
): Promise<void> {
  const submitSkip = (): boolean => gm.handleWolfKingAction(aiUserId, 'skip', undefined, actionId);
  if (targets.length === 0) {
    submitSkip();
    return;
  }

  const state = gm.getState();
  const room = roomManager.getRoom(roomId);
  const aiPlayer = state.players.find(player => player.userId === aiUserId);
  if (!room || !aiPlayer) {
    submitSkip();
    return;
  }

  try {
    const result = await withTimeout(
      decideTriggerAction(state, room, aiPlayer, 'wolf_king_drag', targets),
      AI_ACTION_TIMEOUT_MS,
      'AI 白狼王决策',
    );
    const target = result.action === 'drag' && targets.includes(result.target || '')
      ? result.target
      : undefined;
    const submitted = target
      ? gm.handleWolfKingAction(aiUserId, 'drag', target, actionId)
      : submitSkip();
    if (!submitted) submitSkip();
  } catch (err) {
    console.error(`[AI] 白狼王决策失败，跳过带人(${aiUserId}):`, err);
    submitSkip();
  }
}

// AI 骑士决斗决策
async function handleAIKnightAction(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  aiUserId: string,
  canDuel: boolean,
  targets: string[],
  actionId?: string,
): Promise<void> {
  const submitSkip = (): boolean => gm.handleKnightAction(aiUserId, 'skip', undefined, actionId);
  if (!canDuel || targets.length === 0) {
    submitSkip();
    return;
  }

  const state = gm.getState();
  const room = roomManager.getRoom(roomId);
  const aiPlayer = state.players.find(player => player.userId === aiUserId);
  if (!room || !aiPlayer) {
    submitSkip();
    return;
  }

  try {
    const result = await withTimeout(
      decideTriggerAction(state, room, aiPlayer, 'knight_duel', targets),
      AI_ACTION_TIMEOUT_MS,
      'AI 骑士决策',
    );
    const target = result.action === 'duel' && targets.includes(result.target || '')
      ? result.target
      : undefined;
    const submitted = target
      ? gm.handleKnightAction(aiUserId, 'duel', target, actionId)
      : submitSkip();
    if (!submitted) submitSkip();
  } catch (err) {
    console.error(`[AI] 骑士决策失败，跳过决斗(${aiUserId}):`, err);
    submitSkip();
  }
}
