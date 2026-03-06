import type { GameState, GamePlayer } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Gravedigger extends BaseRole {
  readonly roleName = 'gravedigger';
  readonly faction = 'good' as const;
  readonly hasNightAction = true;

  performNightAction(gameState: GameState, _player: GamePlayer, action: { target?: string }): boolean {
    if (!action.target) {
      // 没有可查验的死者，或选择不操作
      gameState.nightActions.gravedigger = { target: null };
      return true;
    }

    // 验证目标确实是已死亡的玩家
    const target = gameState.players.find(p => p.userId === action.target);
    if (!target || target.alive) return false;

    gameState.nightActions.gravedigger = { target: action.target };
    return true;
  }

  getAvailableTargets(gameState: GameState, _player: GamePlayer): string[] {
    // 守墓人可查验所有已死亡的玩家
    return gameState.players
      .filter(p => !p.alive)
      .map(p => p.userId);
  }
}
