import type { GameState, GamePlayer, WitchState } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Witch extends BaseRole {
  readonly roleName = 'witch';
  readonly faction = 'good' as const;
  readonly hasNightAction = true;

  performNightAction(gameState: GameState, player: GamePlayer, action: { target?: string; potion?: string }): boolean {
    const state = player.roleState as WitchState;

    if (action.potion === 'antidote') {
      if (state.antidoteUsed) return false;
      // 首夜可自救，非首夜不可自救
      const victim = gameState.nightActions.wolves?.target;
      if (victim === player.userId && gameState.round > 1) return false;
      state.antidoteUsed = true;
      gameState.nightActions.witch = { action: 'antidote', target: victim || null };
    } else if (action.potion === 'poison') {
      if (state.poisonUsed) return false;
      if (!action.target) return false;
      state.poisonUsed = true;
      gameState.nightActions.witch = { action: 'poison', target: action.target };
    } else {
      gameState.nightActions.witch = { action: 'none', target: null };
    }

    return true;
  }

  getAvailableTargets(gameState: GameState, player: GamePlayer): string[] {
    // 毒药目标：所有存活的其他玩家
    return gameState.players
      .filter(p => p.alive && p.userId !== player.userId)
      .map(p => p.userId);
  }
}
