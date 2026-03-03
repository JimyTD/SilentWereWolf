import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/types/socket';
import type { RoomManager } from '../rooms/RoomManager';
import type { GameManager } from '../game/GameManager';
import type { PlayerMarks, VoteRecord, DeathRecord } from '../../shared/types/game';
import { ROLE_FACTION, ROLES } from '../../shared/constants';

type IOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export function registerSocketHandlers(
  io: IOServer,
  socket: IOSocket,
  roomManager: RoomManager,
  userId: string,
  nickname: string
): void {
  // 通知连接成功
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
              announcements: [],
            },
          });
          // 通知房间其他人该玩家已重连
          socket.to(existingUser.roomId).emit('server:roomUpdate', room);
          return;
        }
      }
      // 等待中的房间：返回 room 数据让前端恢复
      socket.emit('server:connected', { userId, roomId: existingUser.roomId, room });
      // 通知房间其他人
      socket.to(existingUser.roomId).emit('server:roomUpdate', room);
      return;
    }
  }
  socket.emit('server:connected', { userId, roomId: null });

  // ========== 房间事件 ==========

  socket.on('room:create', (data, callback) => {
    try {
      const result = roomManager.createRoom(userId, nickname, socket.id, data.settings);
      if (result.success && result.roomId) {
        socket.join(result.roomId);
      }
      callback(result);
    } catch (err) {
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

      // 绑定游戏回调
      bindGameCallbacks(io, gm, room.roomId, roomManager);

      // 向每位玩家单独推送身份信息
      for (const gamePlayer of state.players) {
        const rp = room.players.find(p => p.userId === gamePlayer.userId);
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

function getTeammates(
  players: { userId: string; seatNumber: number; role: string; faction: string }[],
  currentPlayer: { userId: string; faction: string }
): { userId: string; seatNumber: number }[] {
  if (currentPlayer.faction !== 'evil') return [];
  return players
    .filter(p => p.faction === 'evil' && p.userId !== currentPlayer.userId)
    .map(p => ({ userId: p.userId, seatNumber: p.seatNumber }));
}

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

  gm.onInvestigateResult = (targetUserId, target, faction) => {
    const user = roomManager.getUser(targetUserId);
    if (!user) return;
    io.to(user.socketId).emit('server:investigateResult', { target, faction });
  };

  gm.onDayAnnouncement = (deaths, peacefulNight) => {
    io.to(roomId).emit('server:dayAnnouncement', {
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

    // 通知所有人当前发言者
    io.to(roomId).emit('server:markingTurn', {
      yourTurn: false,
      currentPlayer: targetUserId,
      timeout: room.settings.timers?.marking || 60,
      evaluationMarkCount,
      availableIdentities: identities,
    });

    // 单独通知当前发言者
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
  };

  gm.onVotingResult = (votes, exiled, tie) => {
    io.to(roomId).emit('server:votingResult', { votes, exiled, tie });
  };

  gm.onGameOver = (winner) => {
    const state = gm.getState();
    const room = roomManager.getRoom(roomId);
    if (!room) return;

    io.to(roomId).emit('server:gameOver', {
      winner,
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
      },
    });

    roomManager.endGame(roomId);
  };
}
