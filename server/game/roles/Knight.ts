import type { GameState, GamePlayer } from '../../../shared/types/game';
import { BaseRole } from './BaseRole';

export class Knight extends BaseRole {
  readonly roleName = 'knight';
  readonly faction = 'good' as const;
  readonly hasNightAction = false;

  performNightAction(): boolean {
    return false;
  }

  getAvailableTargets(): string[] {
    return [];
  }
}
