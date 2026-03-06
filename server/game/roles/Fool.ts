import type { GameState, GamePlayer, FoolState } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Fool extends BaseRole {
  readonly roleName = 'fool';
  readonly faction = 'good' as const;
  readonly hasNightAction = false;

  performNightAction(): boolean {
    return false;
  }

  getAvailableTargets(): string[] {
    return [];
  }

  /**
   * 白痴被放逐时免疫一次
   * 返回 true 表示阻止了出局
   */
  onExile(_gameState: GameState, player: GamePlayer): boolean {
    const state = player.roleState as FoolState;
    if (!state.immunityUsed) {
      state.immunityUsed = true;
      return true; // 阻止出局
    }
    return false;
  }
}
