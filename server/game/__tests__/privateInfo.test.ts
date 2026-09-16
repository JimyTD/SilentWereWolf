import { describe, expect, it } from 'vitest';
import { FACTIONS, PHASES, ROLES } from '../../../shared/constants';
import type { GamePlayer, GameState, NightActions } from '../../../shared/types/game';
import { buildMyPrivateInfo } from '../../../shared/privateInfo';

function createPlayer(
  userId: string,
  role: GamePlayer['role'],
  seatNumber: number,
  roleState: GamePlayer['roleState'] = {},
): GamePlayer {
  return {
    userId,
    seatNumber,
    role,
    faction: role === ROLES.WEREWOLF || role === ROLES.WOLF_KING ? FACTIONS.EVIL : FACTIONS.GOOD,
    alive: true,
    items: [],
    roleState,
  };
}

function emptyNightActions(): NightActions {
  return { guard: null, wolves: null, witch: null, seer: null, gravedigger: null };
}

function createState(players: GamePlayer[], overrides: Partial<GameState> = {}): GameState {
  return {
    roomId: 'room',
    status: 'playing',
    round: 1,
    phase: PHASES.DAY_MARKING,
    players,
    nightActions: emptyNightActions(),
    markingOrder: [],
    markingCurrent: 0,
    history: { rounds: [], marks: [], votes: [], deaths: [] },
    winner: null,
    nightCurrentRole: null,
    pendingTriggers: [],
    ...overrides,
  } as GameState;
}

describe('buildMyPrivateInfo', () => {
  const witch = createPlayer('witch', ROLES.WITCH, 1, { antidoteUsed: true, poisonUsed: false });
  const seer = createPlayer('seer', ROLES.SEER, 2);
  const wolf = createPlayer('wolf', ROLES.WEREWOLF, 3);
  const villager = createPlayer('villager', ROLES.VILLAGER, 4);

  it('女巫：汇总已结算与进行中的用药记录', () => {
    const state = createState([witch, seer, wolf, villager], {
      round: 2,
      phase: PHASES.NIGHT,
      nightActions: { ...emptyNightActions(), witch: { action: 'poison', target: 'villager' } },
      history: {
        rounds: [{ ...emptyNightActions(), witch: { action: 'antidote', target: 'seer' } }],
        marks: [],
        votes: [],
        deaths: [],
      },
    });

    const info = buildMyPrivateInfo(state, witch);
    expect(info.witch?.antidoteUsed).toBe(true);
    expect(info.witch?.poisonUsed).toBe(false);
    expect(info.witch?.potionHistory).toEqual([
      { round: 1, potion: 'antidote', target: 'seer' },
      { round: 2, potion: 'poison', target: 'villager' },
    ]);
  });

  it('白天不把上一轮残留的夜晚行动重复计入', () => {
    const state = createState([witch, seer, wolf, villager], {
      round: 2,
      phase: PHASES.DAY_MARKING,
      nightActions: { ...emptyNightActions(), witch: { action: 'antidote', target: 'seer' } },
      history: {
        rounds: [{ ...emptyNightActions(), witch: { action: 'antidote', target: 'seer' } }],
        marks: [],
        votes: [],
        deaths: [],
      },
    });

    const info = buildMyPrivateInfo(state, witch);
    expect(info.witch?.potionHistory).toEqual([{ round: 1, potion: 'antidote', target: 'seer' }]);
  });

  it('预言家：只包含自己的查验记录与目标阵营', () => {
    const state = createState([witch, seer, wolf, villager], {
      history: {
        rounds: [{ ...emptyNightActions(), seer: { target: 'wolf' } }],
        marks: [],
        votes: [],
        deaths: [],
      },
    });

    const info = buildMyPrivateInfo(state, seer);
    expect(info.investigations).toEqual([
      { round: 1, kind: 'seer', target: 'wolf', faction: FACTIONS.EVIL },
    ]);
    // 预言家不应拿到女巫等其他角色的私有信息
    expect(info.witch).toBeUndefined();
  });

  it('守卫：返回最近守护目标与守护历史', () => {
    const guard = createPlayer('guard', ROLES.GUARD, 5, { lastGuardTarget: 'villager' });
    const state = createState([witch, seer, wolf, villager, guard], {
      history: {
        rounds: [{ ...emptyNightActions(), guard: { target: 'seer' } }],
        marks: [],
        votes: [],
        deaths: [],
      },
    });

    const info = buildMyPrivateInfo(state, guard);
    expect(info.guard).toEqual({
      lastGuardTarget: 'villager',
      history: [{ round: 1, target: 'seer' }],
    });
  });

  it('狼人：返回历轮袭击目标', () => {
    const state = createState([witch, seer, wolf, villager], {
      history: {
        rounds: [
          { ...emptyNightActions(), wolves: { target: 'seer', votes: {} } },
          { ...emptyNightActions(), wolves: { target: 'witch', votes: {} } },
        ],
        marks: [],
        votes: [],
        deaths: [],
      },
    });

    const info = buildMyPrivateInfo(state, wolf);
    expect(info.wolfAttacks).toEqual([
      { round: 1, target: 'seer' },
      { round: 2, target: 'witch' },
    ]);
  });

  it('平民：没有任何私有记录', () => {
    const state = createState([witch, seer, wolf, villager], {
      round: 2,
      phase: PHASES.NIGHT,
      nightActions: { ...emptyNightActions(), wolves: { target: 'seer', votes: {} } },
      history: {
        rounds: [{ ...emptyNightActions(), wolves: { target: 'seer', votes: {} } }],
        marks: [],
        votes: [],
        deaths: [],
      },
    });

    expect(buildMyPrivateInfo(state, villager)).toEqual({});
  });

  it('猎人 / 骑士 / 白痴：返回技能可用状态', () => {
    const hunter = createPlayer('hunter', ROLES.HUNTER, 6, { canShoot: false });
    const knight = createPlayer('knight', ROLES.KNIGHT, 7, { duelUsed: true });
    const fool = createPlayer('fool', ROLES.FOOL, 8, { immunityUsed: true });
    const state = createState([hunter, knight, fool]);

    expect(buildMyPrivateInfo(state, hunter).hunterCanShoot).toBe(false);
    expect(buildMyPrivateInfo(state, knight).knightDuelUsed).toBe(true);
    expect(buildMyPrivateInfo(state, fool).foolImmunityUsed).toBe(true);
  });
});
