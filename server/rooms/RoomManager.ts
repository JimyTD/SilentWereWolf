import type { Room, RoomPlayer, UserInfo } from '../../shared/types/room';
import type { GameSettings } from '../../shared/types/game';
import { ROOM_STATUS, ROOM_ID_MIN, ROOM_ID_MAX, RECONNECT_TIMEOUT, PRESETS, MAX_PLAYERS } from '../../shared/constants';
import { validateGameSettings, validateNickname } from '../../shared/validators';
import { GameManager } from '../game/GameManager';

export class RoomManager {
  private rooms = new Map<string, Room>();
  private users = new Map<string, UserInfo>(); // userId → UserInfo
  private gameManagers = new Map<string, GameManager>(); // roomId → GameManager
  private disconnectTimers = new Map<string, NodeJS.Timeout>(); // userId → timer

  // ========== 房间 CRUD ==========

  createRoom(userId: string, nickname: string, socketId: string, settings: GameSettings): { success: boolean; roomId?: string; room?: Room; error?: string; message?: string } {
    const validation = validateGameSettings(settings);
    if (!validation.valid) {
      return { success: false, error: 'INVALID_CONFIG', message: validation.error };
    }

    // 检查用户是否已在其他房间中
    const currentUser = this.users.get(userId);
    if (currentUser?.roomId) {
      const currentRoom = this.rooms.get(currentUser.roomId);
      if (currentRoom) {
        if (currentRoom.status === ROOM_STATUS.PLAYING) {
          return { success: false, error: 'ALREADY_IN_GAME', message: '你正在其他房间的游戏中，无法创建新房间' };
        }
        this.leaveRoom(userId);
      }
    }

    const roomId = this.generateRoomId();

    const player: RoomPlayer = {
      userId,
      nickname,
      seatNumber: 1,
      connected: true,
      ready: false,
    };

    const room: Room = {
      roomId,
      status: ROOM_STATUS.WAITING,
      hostUserId: userId,
      settings,
      players: [player],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.rooms.set(roomId, room);
    this.setUser(userId, nickname, socketId, roomId);

    return { success: true, roomId, room };
  }

  joinRoom(roomId: string, userId: string, nickname: string, socketId: string): { success: boolean; room?: Room; error?: string; message?: string } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: 'ROOM_NOT_FOUND', message: '房间不存在' };
    }

    // 检查是否已在此房间中（重连）
    const existingPlayer = room.players.find(p => p.userId === userId);
    if (existingPlayer) {
      if (room.status !== ROOM_STATUS.WAITING) {
        return this.reconnectToRoom(roomId, userId, nickname, socketId);
      }
      existingPlayer.connected = true;
      existingPlayer.nickname = nickname;
      this.setUser(userId, nickname, socketId, roomId);
      this.clearDisconnectTimer(userId);
      return { success: true, room };
    }

    if (room.status !== ROOM_STATUS.WAITING) {
      return { success: false, error: 'GAME_IN_PROGRESS', message: '游戏进行中，无法加入' };
    }

    // 检查用户是否已在其他房间中
    const currentUser = this.users.get(userId);
    if (currentUser?.roomId && currentUser.roomId !== roomId) {
      const currentRoom = this.rooms.get(currentUser.roomId);
      if (currentRoom) {
        if (currentRoom.status === ROOM_STATUS.PLAYING) {
          return { success: false, error: 'ALREADY_IN_GAME', message: '你正在其他房间的游戏中，无法加入新房间' };
        }
        // 等待中的房间 → 自动离开旧房间
        this.leaveRoom(userId);
      }
    }

    const nicknameCheck = validateNickname(nickname);
    if (!nicknameCheck.valid) {
      return { success: false, error: 'INVALID_NICKNAME', message: nicknameCheck.error };
    }

    // 昵称唯一性
    if (room.players.some(p => p.nickname === nickname)) {
      return { success: false, error: 'NICKNAME_TAKEN', message: '昵称已被使用' };
    }

    // 人数上限
    const totalNeeded = this.getTotalPlayersFromSettings(room.settings);
    if (room.players.length >= totalNeeded) {
      return { success: false, error: 'ROOM_FULL', message: '房间已满' };
    }

    const seatNumber = this.getNextSeat(room);
    const player: RoomPlayer = {
      userId,
      nickname,
      seatNumber,
      connected: true,
      ready: false,
    };

    room.players.push(player);
    room.lastActivityAt = Date.now();
    this.setUser(userId, nickname, socketId, roomId);

    return { success: true, room };
  }

  leaveRoom(userId: string): { room: Room | null; wasHost: boolean; newHost: string | null; destroyed: boolean } {
    const user = this.users.get(userId);
    if (!user || !user.roomId) {
      return { room: null, wasHost: false, newHost: null, destroyed: false };
    }

    const room = this.rooms.get(user.roomId);
    if (!room) {
      this.users.delete(userId);
      return { room: null, wasHost: false, newHost: null, destroyed: false };
    }

    const wasHost = room.hostUserId === userId;

    // 游戏中离开 → 标记掉线，不移除
    if (room.status === ROOM_STATUS.PLAYING) {
      const player = room.players.find(p => p.userId === userId);
      if (player) {
        player.connected = false;
      }
      user.roomId = null;
      return { room, wasHost: false, newHost: null, destroyed: false };
    }

    // 等待中离开 → 直接移除
    room.players = room.players.filter(p => p.userId !== userId);
    user.roomId = null;

    // 房间空了 → 销毁
    if (room.players.length === 0) {
      this.destroyRoom(room.roomId);
      return { room: null, wasHost, newHost: null, destroyed: true };
    }

    // 转移房主
    let newHost: string | null = null;
    if (wasHost) {
      room.hostUserId = room.players[0].userId;
      newHost = room.hostUserId;
    }

    room.lastActivityAt = Date.now();
    return { room, wasHost, newHost, destroyed: false };
  }

  kickPlayer(hostUserId: string, targetUserId: string): { success: boolean; room?: Room; error?: string; message?: string } {
    const user = this.users.get(hostUserId);
    if (!user || !user.roomId) {
      return { success: false, error: 'NOT_IN_ROOM', message: '你不在房间中' };
    }

    const room = this.rooms.get(user.roomId);
    if (!room) {
      return { success: false, error: 'ROOM_NOT_FOUND', message: '房间不存在' };
    }
    if (room.hostUserId !== hostUserId) {
      return { success: false, error: 'NOT_HOST', message: '仅房主可以踢人' };
    }
    if (room.status !== ROOM_STATUS.WAITING) {
      return { success: false, error: 'GAME_IN_PROGRESS', message: '游戏中无法踢人' };
    }
    if (targetUserId === hostUserId) {
      return { success: false, error: 'INVALID_ACTION', message: '不能踢自己' };
    }

    room.players = room.players.filter(p => p.userId !== targetUserId);
    const targetUser = this.users.get(targetUserId);
    if (targetUser) {
      targetUser.roomId = null;
    }
    room.lastActivityAt = Date.now();

    return { success: true, room };
  }

  updateSettings(userId: string, settings: GameSettings): { success: boolean; room?: Room; error?: string; message?: string } {
    const user = this.users.get(userId);
    if (!user || !user.roomId) {
      return { success: false, error: 'NOT_IN_ROOM', message: '你不在房间中' };
    }

    const room = this.rooms.get(user.roomId);
    if (!room) {
      return { success: false, error: 'ROOM_NOT_FOUND', message: '房间不存在' };
    }
    if (room.hostUserId !== userId) {
      return { success: false, error: 'NOT_HOST', message: '仅房主可以修改设置' };
    }
    if (room.status !== ROOM_STATUS.WAITING) {
      return { success: false, error: 'GAME_IN_PROGRESS', message: '游戏中无法修改设置' };
    }

    const validation = validateGameSettings(settings);
    if (!validation.valid) {
      return { success: false, error: 'INVALID_CONFIG', message: validation.error };
    }

    room.settings = settings;
    room.lastActivityAt = Date.now();
    return { success: true, room };
  }

  // ========== 游戏管理 ==========

  startGame(userId: string): { success: boolean; gameManager?: GameManager; room?: Room; error?: string; message?: string } {
    const user = this.users.get(userId);
    if (!user || !user.roomId) {
      return { success: false, error: 'NOT_IN_ROOM', message: '你不在房间中' };
    }

    const room = this.rooms.get(user.roomId);
    if (!room) {
      return { success: false, error: 'ROOM_NOT_FOUND', message: '房间不存在' };
    }
    if (room.hostUserId !== userId) {
      return { success: false, error: 'NOT_HOST', message: '仅房主可以开始游戏' };
    }
    if (room.status !== ROOM_STATUS.WAITING) {
      return { success: false, error: 'GAME_IN_PROGRESS', message: '游戏已在进行中' };
    }

    const totalNeeded = this.getTotalPlayersFromSettings(room.settings);
    if (room.players.length !== totalNeeded) {
      return { success: false, error: 'PLAYER_COUNT_MISMATCH', message: `需要 ${totalNeeded} 人，当前 ${room.players.length} 人` };
    }

    room.status = ROOM_STATUS.PLAYING;
    room.lastActivityAt = Date.now();

    const gm = new GameManager(room);
    this.gameManagers.set(room.roomId, gm);
    gm.initializeGame();

    return { success: true, gameManager: gm, room };
  }

  getGameManager(roomId: string): GameManager | undefined {
    return this.gameManagers.get(roomId);
  }

  endGame(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.status = ROOM_STATUS.FINISHED;
      room.lastActivityAt = Date.now();
    }
    this.gameManagers.delete(roomId);
  }

  resetRoom(roomId: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (room) {
      room.status = ROOM_STATUS.WAITING;
      room.lastActivityAt = Date.now();
      // 重新分配座位
      room.players.forEach((p, i) => {
        p.seatNumber = i + 1;
        p.ready = false;
      });
    }
    this.gameManagers.delete(roomId);
    return room;
  }

  // ========== 掉线/重连 ==========

  handleDisconnect(userId: string): { roomId: string | null; isPlaying: boolean } {
    const user = this.users.get(userId);
    if (!user || !user.roomId) {
      return { roomId: null, isPlaying: false };
    }

    const room = this.rooms.get(user.roomId);
    if (!room) {
      return { roomId: null, isPlaying: false };
    }

    const player = room.players.find(p => p.userId === userId);
    if (player) {
      player.connected = false;
    }
    user.connected = false;

    const isPlaying = room.status === ROOM_STATUS.PLAYING;
    const roomId = user.roomId;

    // 设置超时移除定时器
    this.clearDisconnectTimer(userId);
    const timer = setTimeout(() => {
      this.handleDisconnectTimeout(userId);
    }, RECONNECT_TIMEOUT);
    this.disconnectTimers.set(userId, timer);

    return { roomId, isPlaying };
  }

  private handleDisconnectTimeout(userId: string): void {
    this.disconnectTimers.delete(userId);
    const user = this.users.get(userId);
    if (!user || !user.roomId) return;

    const room = this.rooms.get(user.roomId);
    if (!room) return;

    if (room.status === ROOM_STATUS.WAITING) {
      // 等待中 → 移除玩家
      room.players = room.players.filter(p => p.userId !== userId);
      if (room.players.length === 0) {
        this.destroyRoom(room.roomId);
      } else if (room.hostUserId === userId) {
        room.hostUserId = room.players[0].userId;
      }
    }
    // 游戏中 → 玩家保持在位，由 GameManager 处理超时操作
  }

  private reconnectToRoom(roomId: string, userId: string, nickname: string, socketId: string): { success: boolean; room?: Room; error?: string; message?: string } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { success: false, error: 'ROOM_NOT_FOUND', message: '房间不存在' };
    }

    const player = room.players.find(p => p.userId === userId);
    if (!player) {
      return { success: false, error: 'PLAYER_NOT_FOUND', message: '你不在该房间中' };
    }

    player.connected = true;
    this.setUser(userId, nickname, socketId, roomId);
    this.clearDisconnectTimer(userId);

    return { success: true, room };
  }

  // ========== 查询 ==========

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getUser(userId: string): UserInfo | undefined {
    return this.users.get(userId);
  }

  getUserRoom(userId: string): Room | undefined {
    const user = this.users.get(userId);
    if (!user || !user.roomId) return undefined;
    return this.rooms.get(user.roomId);
  }

  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  // 获取空闲超时的房间
  getIdleRooms(timeout: number): string[] {
    const now = Date.now();
    const idleRooms: string[] = [];
    for (const [roomId, room] of this.rooms) {
      const allDisconnected = room.players.every(p => !p.connected);
      if (allDisconnected && now - room.lastActivityAt > timeout) {
        idleRooms.push(roomId);
      }
    }
    return idleRooms;
  }

  destroyRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      for (const player of room.players) {
        const user = this.users.get(player.userId);
        if (user) {
          user.roomId = null;
        }
        this.clearDisconnectTimer(player.userId);
      }
    }
    this.rooms.delete(roomId);
    this.gameManagers.delete(roomId);
    console.log(`[房间] 房间 ${roomId} 已销毁`);
  }

  // ========== 辅助方法 ==========

  private setUser(userId: string, nickname: string, socketId: string, roomId: string | null): void {
    this.users.set(userId, { userId, nickname, socketId, roomId, connected: true });
  }

  private clearDisconnectTimer(userId: string): void {
    const timer = this.disconnectTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(userId);
    }
  }

  private generateRoomId(): string {
    let roomId: string;
    do {
      roomId = String(Math.floor(Math.random() * (ROOM_ID_MAX - ROOM_ID_MIN + 1)) + ROOM_ID_MIN);
    } while (this.rooms.has(roomId));
    return roomId;
  }

  private getNextSeat(room: Room): number {
    const usedSeats = new Set(room.players.map(p => p.seatNumber));
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!usedSeats.has(i)) return i;
    }
    return room.players.length + 1;
  }

  getTotalPlayersFromSettings(settings: GameSettings): number {
    const roleConfig = settings.mode === 'preset' && settings.preset
      ? PRESETS[settings.preset]
      : settings.roles;
    if (!roleConfig) return 0;
    return Object.values(roleConfig as Record<string, number>).reduce((sum, count) => sum + count, 0);
  }
}
