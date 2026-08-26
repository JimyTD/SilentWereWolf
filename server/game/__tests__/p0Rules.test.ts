import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../shared/constants';
import type { GamePlayer, GameState } from '../../../shared/types/game';
import { Guard } from '../roles/Guard';
import { Gravedigger } from '../roles/Gravedigger';
import { fallbackNightAction } from '../ai/AIPlayerController';

function createPlayer(
  userId: string,
  role: GamePlayer['role'],
  alive = true,
  roleState: GamePlayer['roleState'] = {},
): GamePlayer {
  return {
    userId,
    seatNumber: Number(userId.replace(/\D/g, '')) || 1,
    role,
    faction: role === ROLES.WEREWOLF || role === ROLES.WOLF_KING ? 'evil' : 'good',
    alive,
    items: [],
    roleState,
  };
}

function createState(players: GamePlayer[]): GameState {
  return {
    roomId: 'test-room',
    status: 'playing',
    round: 1,
    phase: 'night',
    players,
    nightActions: {
      guard: null,
      wolves: null,
      witch: null,
      seer: null,
      gravedigger: null,
    },
    markingOrder: [],
    markingCurrent: 0,
    history: { rounds: [], marks: [], votes: [], deaths: [] },
    winner: null,
    nightCurrentRole: null,
    pendingTriggers: [],
  };
}

describe('P0 角色行动规则', () => {
  it('守卫没有目标时不能空守', () => {
    const player = createPlayer('player1', ROLES.GUARD, true, { lastGuardTarget: null });
    const state = createState([player]);

    expect(new Guard().performNightAction(state, player, {})).toBe(false);
    expect(state.nightActions.guard).toBeNull();
  });

  it('守墓人没有死者时可以自动跳过', () => {
    const player = createPlayer('player1', ROLES.GRAVEDIGGER);
    const state = createState([player]);

    expect(new Gravedigger().performNightAction(state, player, {})).toBe(true);
    expect(state.nightActions.gravedigger).toEqual({ target: null });
  });

  it('守墓人有死者时必须选择死者', () => {
    const player = createPlayer('player1', ROLES.GRAVEDIGGER);
    const deadPlayer = createPlayer('player2', ROLES.VILLAGER, false);
    const state = createState([player, deadPlayer]);

    expect(new Gravedigger().performNightAction(state, player, {})).toBe(false);
    expect(state.nightActions.gravedigger).toBeNull();
  });

  it('必选夜晚行动的兜底会选择目标，可选女巫行动默认不使用药物', () => {
    expect(fallbackNightAction(ROLES.GUARD, ['player2'])).toEqual({
      action: 'guard',
      target: 'player2',
    });
    expect(fallbackNightAction(ROLES.GRAVEDIGGER, ['player2'])).toEqual({
      action: 'autopsy',
      target: 'player2',
    });
    expect(fallbackNightAction(ROLES.WITCH, ['player2'])).toEqual({
      action: 'usePotion',
      potion: 'none',
    });
  });
});
