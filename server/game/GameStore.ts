import type { GameState } from '../../shared/types/game';

/**
 * 游戏状态存储抽象层
 * 首版使用内存实现，后续可替换为 Redis/SQLite
 */
export interface IGameStore {
  get(roomId: string): GameState | undefined;
  set(roomId: string, state: GameState): void;
  delete(roomId: string): void;
  has(roomId: string): boolean;
}

export class MemoryGameStore implements IGameStore {
  private store = new Map<string, GameState>();

  get(roomId: string): GameState | undefined {
    return this.store.get(roomId);
  }

  set(roomId: string, state: GameState): void {
    this.store.set(roomId, state);
  }

  delete(roomId: string): void {
    this.store.delete(roomId);
  }

  has(roomId: string): boolean {
    return this.store.has(roomId);
  }
}
