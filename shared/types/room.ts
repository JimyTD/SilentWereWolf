import type { GameSettings } from './game';

export interface RoomPlayer {
  userId: string;
  nickname: string;
  seatNumber: number;
  connected: boolean;
  ready: boolean;
}

export interface Room {
  roomId: string;
  status: 'waiting' | 'playing' | 'finished';
  hostUserId: string;
  settings: GameSettings;
  players: RoomPlayer[];
  createdAt: number;
  lastActivityAt: number;
}

export interface UserInfo {
  userId: string;
  nickname: string;
  socketId: string;
  roomId: string | null;
  connected: boolean;
}
