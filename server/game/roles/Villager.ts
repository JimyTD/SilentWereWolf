import type { GameState, GamePlayer } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Villager extends BaseRole {
  readonly roleName = 'villager';
  readonly faction = 'good' as const;
  readonly hasNightAction = false;

  performNightAction(): boolean {
    return false;
  }

  getAvailableTargets(): string[] {
    return [];
  }
}
