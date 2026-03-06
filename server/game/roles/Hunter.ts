import type { GameState, GamePlayer, HunterState } from '../../../shared/types/game';
import { DEATH_CAUSE } from '../../../shared/constants';
import { BaseRole } from './BaseRole';

export class Hunter extends BaseRole {
  readonly roleName = 'hunter';
  readonly faction = 'good' as const;
  readonly hasNightAction = false;

  performNightAction(): boolean {
    return false;
  }

  getAvailableTargets(): string[] {
    return [];
  }

  /**
   * 猎人死亡时触发开枪
   * - 被放逐：可以开枪
   * - 被狼人刀死：可以开枪
   * - 被女巫毒死：不能开枪
   * - 被骑士决斗杀死：可以开枪
   * - 被白狼王带走：可以开枪
   */
  onDeath(
    _gameState: GameState,
    player: GamePlayer,
    cause: string
  ): { type: string; userId: string } | null {
    const state = player.roleState as HunterState;
    if (!state.canShoot) return null;

    // 被毒死不能开枪
    if (cause === DEATH_CAUSE.POISONED) {
      state.canShoot = false;
      return null;
    }

    return { type: 'hunter_shoot', userId: player.userId };
  }
}
