import type { GameState, GamePlayer, GuardState } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Guard extends BaseRole {
  readonly roleName = 'guard';
  readonly faction = 'good' as const;
  readonly hasNightAction = true;

  performNightAction(gameState: GameState, player: GamePlayer, action: { target?: string }): boolean {
    if (!action.target) {
      gameState.nightActions.guard = { target: null };
      return true;
    }

    const state = player.roleState as GuardState;
    // 不可连续守同一人
    if (state.lastGuardTarget === action.target) return false;

    state.lastGuardTarget = action.target;
    gameState.nightActions.guard = { target: action.target };
    return true;
  }

  getAvailableTargets(gameState: GameState, player: GamePlayer): string[] {
    const state = player.roleState as GuardState;
    return gameState.players
      .filter(p => p.alive && p.userId !== state.lastGuardTarget)
      .map(p => p.userId);
  }
}
