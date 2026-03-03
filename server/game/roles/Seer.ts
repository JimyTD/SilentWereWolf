import type { GameState, GamePlayer } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Seer extends BaseRole {
  readonly roleName = 'seer';
  readonly faction = 'good' as const;
  readonly hasNightAction = true;

  performNightAction(gameState: GameState, _player: GamePlayer, action: { target?: string }): boolean {
    if (!action.target) return false;
    gameState.nightActions.seer = { target: action.target };
    return true;
  }

  getAvailableTargets(gameState: GameState, player: GamePlayer): string[] {
    return gameState.players
      .filter(p => p.alive && p.userId !== player.userId)
      .map(p => p.userId);
  }
}
