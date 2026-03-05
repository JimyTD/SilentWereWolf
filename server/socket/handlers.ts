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
} from '../game/ai/AIPlayerController';
import { flushLogs } from '../game/ai/AILogger';
import { testAIConnection } from '../game/ai/AIApiClient';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

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
      if (gm && room.status === 'playing') {
        const state = gm.getState();
        const player = state.players.find(p => p.userId === userId);
        if (player) {
          // 从死亡历史重建公告
          const announcements = rebuildAnnouncements(state);

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
            },
          });
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
      gm.handleNightAction(userId, data);
    } catch (err) {
      console.error('[client:nightAction] 错误:', err);
    }
  });

  socket.on('client:submitMarks', (data) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) return;
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) return;

      const marks: PlayerMarks = {
        player: userId,
        round: gm.getState().round,
        identityMark: data.identityMark,
        evaluationMarks: data.evaluationMarks,
      };
      gm.handleSubmitMarks(userId, marks);
    } catch (err) {
      console.error('[client:submitMarks] 错误:', err);
    }
  });

  socket.on('client:vote', (data) => {
    try {
      const user = roomManager.getUser(userId);
      if (!user?.roomId) return;
      const gm = roomManager.getGameManager(user.roomId);
      if (!gm) return;
      gm.handleVote(userId, data.target);
    } catch (err) {
      console.error('[client:vote] 错误:', err);
    }
  });

  // ========== 断线处理 ==========

  socket.on('disconnect', () => {
    console.log(`[断线] ${nickname}(${userId}) 已断线`);
    const result = roomManager.handleDisconnect(userId);
    if (result.roomId) {
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

  gm.onNightActionPrompt = (targetUserId, roleName, targets, witchInfo) => {
    // AI 玩家：调用 AIPlayerController 决策
    if (roomManager.isAI(targetUserId)) {
      handleAINightAction(gm, roomManager, roomId, targetUserId, roleName, targets, witchInfo);
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
      timeout,
      availableTargets: targets,
    };
    if (witchInfo) {
      prompt.witchInfo = witchInfo;
    }
    io.to(user.socketId).emit('server:nightAction', prompt);
  };

  gm.onWolfVoteUpdate = (wolfUserIds, votes) => {
    // 向所有存活的真人狼人推送队友的投票情况
    for (const wolfId of wolfUserIds) {
      if (roomManager.isAI(wolfId)) continue;
      const user = roomManager.getUser(wolfId);
      if (!user) continue;
      io.to(user.socketId).emit('server:wolfVoteUpdate', { votes });
    }
  };

  gm.onInvestigateResult = (targetUserId, target, faction) => {
    // AI 不需要接收查验结果推送（已在 Context 中获取）
    if (roomManager.isAI(targetUserId)) return;

    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    io.to(user.socketId).emit('server:investigateResult', { target, faction });
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

  gm.onMarkingTurn = (targetUserId, evaluationMarkCount, identities) => {
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    // 通知所有真人当前发言者
    io.to(roomId).emit('server:markingTurn', {
      yourTurn: false,
      currentPlayer: targetUserId,
      timeout: room.settings.timers?.marking || 60,
      evaluationMarkCount,
      availableIdentities: identities,
    });

    // AI 玩家：调用 AIPlayerController 决策
    if (roomManager.isAI(targetUserId)) {
      handleAIMarking(gm, roomManager, roomId, targetUserId, evaluationMarkCount, identities);
      return;
    }

    // 真人玩家：单独通知
    const user = roomManager.getUser(targetUserId);
    if (user) {
      io.to(user.socketId).emit('server:markingTurn', {
        yourTurn: true,
        currentPlayer: targetUserId,
        timeout: room.settings.timers?.marking || 60,
        evaluationMarkCount,
        availableIdentities: identities,
      });
    }
  };

  gm.onMarksRevealed = (marks) => {
    io.to(roomId).emit('server:marksRevealed', marks);
  };

  gm.onVotingStart = (candidates) => {
    const room = roomManager.getRoom(roomId);
    io.to(roomId).emit('server:votingStart', {
      timeout: room?.settings.timers?.voting || 30,
      candidates,
    });

    // 所有 AI 玩家自动投票
    handleAIVoting(gm, roomManager, roomId, candidates);
  };

  gm.onVotingResult = (votes, exiled, tie) => {
    io.to(roomId).emit('server:votingResult', { votes, exiled, tie });
  };

  gm.onGameOver = (winner, reason) => {
    const state = gm.getState();
    const room = roomManager.getRoom(roomId);
    if (!room) return;

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
): Promise<void> {
  try {
    const state = gm.getState();
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const aiPlayer = state.players.find(p => p.userId === aiUserId);
    if (!aiPlayer) return;

    const result = await decideNightAction(state, room, aiPlayer, targets, witchInfo);
    console.log(`[AI] ${room.players.find(p => p.userId === aiUserId)?.nickname} 夜晚行动:`, result);

    gm.handleNightAction(aiUserId, result);
  } catch (err) {
    console.error(`[AI] 夜晚行动出错(${aiUserId}):`, err);
    // 超时会自动处理
  }
}

async function handleAIMarking(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  aiUserId: string,
  evaluationMarkCount: number,
  identities: string[],
): Promise<void> {
  try {
    const state = gm.getState();
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    const aiPlayer = state.players.find(p => p.userId === aiUserId);
    if (!aiPlayer) return;

    const result = await decideMarking(state, room, aiPlayer, evaluationMarkCount, identities);
    console.log(`[AI] ${room.players.find(p => p.userId === aiUserId)?.nickname} 标记发言:`, result.identityMark.identity);

    const marks: PlayerMarks = {
      player: aiUserId,
      round: state.round,
      identityMark: result.identityMark,
      evaluationMarks: result.evaluationMarks,
    };
    gm.handleSubmitMarks(aiUserId, marks);
  } catch (err) {
    console.error(`[AI] 标记发言出错(${aiUserId}):`, err);
    // 超时会自动跳过
  }
}

async function handleAIVoting(
  gm: GameManager,
  roomManager: RoomManager,
  roomId: string,
  candidates: string[],
): Promise<void> {
  const state = gm.getState();
  const room = roomManager.getRoom(roomId);
  if (!room) return;

  // 找到所有存活的 AI 玩家
  const aiVoters = state.players.filter(
    p => p.alive && roomManager.isAI(p.userId)
  );

  for (const aiPlayer of aiVoters) {
    try {
      const target = await decideVote(state, room, aiPlayer, candidates);
      console.log(`[AI] ${room.players.find(p => p.userId === aiPlayer.userId)?.nickname} 投票: → ${target}`);
      gm.handleVote(aiPlayer.userId, target);
    } catch (err) {
      console.error(`[AI] 投票出错(${aiPlayer.userId}):`, err);
      // 超时会随机投票
    }
  }
}
