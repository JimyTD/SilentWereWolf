import { describe, expect, it, vi } from 'vitest';
import { DEATH_CAUSE, FACTIONS, ITEMS, PHASES, ROLES } from '../../../shared/constants';
import { validateGameSettings } from '../../../shared/validators';
import type { GamePlayer, GameSettings, GameState } from '../../../shared/types/game';
import type { Room } from '../../../shared/types/room';
import { checkWinCondition, resolveNight } from '../rules';
import { GameManager } from '../GameManager';
import { targetUserIdFromSeat } from '../ai/AIPlayerController';
import { guardTriggerAction } from '../ai/AIDecisionGuard';
import { getNightActionPrompt } from '../ai/AIPromptTemplates';

function createPlayer(
  userId: string,
  role: GamePlayer['role'],
  alive = true,
  items: GamePlayer['items'] = [],
): GamePlayer {
  return {
    userId,
    seatNumber: Number(userId.replace(/\D/g, '')) || 1,
    role,
    faction: role === ROLES.WEREWOLF || role === ROLES.WOLF_KING ? FACTIONS.EVIL : FACTIONS.GOOD,
    alive,
    items,
    roleState: {},
  };
}

function createState(players: GamePlayer[]): GameState {
  return {
    roomId: 'test-room',
    status: 'playing',
    round: 1,
    phase: PHASES.NIGHT,
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

function createSettings(
  roles: Record<string, number>,
  winCondition: GameSettings['winCondition'] = 'edge',
  withItems = false,
): GameSettings {
  return {
    mode: 'custom',
    roles,
    items: { enabled: withItems, pool: withItems ? [ITEMS.MOONSTONE] : [] },
    timers: { marking: 60, voting: 30, nightAction: 20 },
    lastWords: false,
    deepMode: false,
    winCondition,
  };
}

function createRoom(userIds: string[], settings: GameSettings): Room {
  return {
    roomId: 'test-room',
    status: 'playing',
    hostUserId: userIds[0],
    settings,
    players: userIds.map((userId, index) => ({
      userId,
      nickname: userId,
      seatNumber: index + 1,
      connected: true,
      ready: true,
    })),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

describe('屠边模式的板子校验与胜负判定', () => {
  it('拒绝屠边但没有神职的板子', () => {
    const result = validateGameSettings(
      createSettings({ [ROLES.WEREWOLF]: 1, [ROLES.VILLAGER]: 3 }),
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('屠边');
  });

  it('拒绝屠边但没有平民的板子', () => {
    const result = validateGameSettings(
      createSettings({ [ROLES.WEREWOLF]: 1, [ROLES.SEER]: 1, [ROLES.WITCH]: 2 }),
    );
    expect(result.valid).toBe(false);
  });

  it('屠边板子同时有神职与平民时仍然合法', () => {
    const result = validateGameSettings(
      createSettings({ [ROLES.WEREWOLF]: 1, [ROLES.SEER]: 1, [ROLES.VILLAGER]: 2 }),
    );
    expect(result.valid).toBe(true);
  });

  it('无神职的板子不会在首夜就判狼人胜', () => {
    const state = createState([
      createPlayer('player1', ROLES.WEREWOLF),
      createPlayer('player2', ROLES.VILLAGER),
      createPlayer('player3', ROLES.VILLAGER),
      createPlayer('player4', ROLES.VILLAGER),
    ]);

    expect(checkWinCondition(state, 'edge')).toBeNull();
  });

  it('板子里确实有神职时，神职全灭仍然判狼人胜', () => {
    const state = createState([
      createPlayer('player1', ROLES.WEREWOLF),
      createPlayer('player2', ROLES.SEER, false),
      createPlayer('player3', ROLES.VILLAGER),
      createPlayer('player4', ROLES.VILLAGER),
    ]);

    expect(checkWinCondition(state, 'edge')).toEqual({
      winner: FACTIONS.EVIL,
      reason: 'specials_eliminated',
    });
  });
});

describe('夜晚结算死亡记录', () => {
  it('同守同救只产生一条死亡记录', () => {
    const victim = createPlayer('player2', ROLES.VILLAGER);
    const state = createState([
      createPlayer('player1', ROLES.WEREWOLF),
      victim,
      createPlayer('player3', ROLES.GUARD),
    ]);
    state.nightActions.wolves = { target: victim.userId, votes: {} };
    state.nightActions.guard = { target: victim.userId };
    state.nightActions.witch = { action: 'antidote', target: victim.userId };

    const deaths = resolveNight(state);

    expect(deaths).toHaveLength(1);
    expect(deaths[0].cause).toBe(DEATH_CAUSE.GUARD_WITCH_CLASH);
    expect(deaths[0].userId).toBe(victim.userId);
    expect(state.players.find(p => p.userId === victim.userId)?.alive).toBe(false);
  });

  it('守卫与被女巫解药救下的目标存活，不产生死亡记录', () => {
    const victim = createPlayer('player2', ROLES.VILLAGER);
    const state = createState([
      createPlayer('player1', ROLES.WEREWOLF),
      victim,
      createPlayer('player3', ROLES.GUARD),
    ]);
    state.nightActions.wolves = { target: victim.userId, votes: {} };
    state.nightActions.guard = { target: victim.userId };

    expect(resolveNight(state)).toHaveLength(0);
    expect(state.players.find(p => p.userId === victim.userId)?.alive).toBe(true);
  });
});

describe('认输出局的遗物公开', () => {
  it('认输出局后随身物品公开为遗物', () => {
    const settings = createSettings(
      { [ROLES.WEREWOLF]: 1, [ROLES.GUARD]: 1, [ROLES.WITCH]: 1, [ROLES.VILLAGER]: 1 },
      'edge',
      true,
    );
    const gm = new GameManager(createRoom(['u1', 'u2', 'u3', 'u4'], settings));
    gm.initializeGame();

    const target = gm.getState().players[0];
    expect(target.items).toHaveLength(1);
    expect(target.items[0].revealed).toBe(false);

    expect(gm.handleResign(target.userId)).toBe(true);

    expect(target.alive).toBe(false);
    expect(target.items[0].revealed).toBe(true);
    const death = gm.getState().history.deaths.find(d => d.cause === DEATH_CAUSE.RESIGNED);
    expect(death?.relics).toHaveLength(1);
    expect(death?.relics[0].revealed).toBe(true);
  });
});

describe('AI 守卫/守墓人的提示词与规则层保持一致', () => {
  it('守卫提示词不再提供"不守护"选项', () => {
    const prompt = getNightActionPrompt({
      role: ROLES.GUARD,
      availableTargets: [{ seatNumber: 2 }, { seatNumber: 3 }],
    });

    expect(prompt).not.toContain('不守护');
    expect(prompt).not.toContain('"target": null');
  });

  it('守墓人只在没有可查验死者时才允许跳过', () => {
    const withTarget = getNightActionPrompt({
      role: ROLES.GRAVEDIGGER,
      availableTargets: [{ seatNumber: 2 }],
    });
    expect(withTarget).not.toContain('不验尸');
    expect(withTarget).not.toContain('"target": null');

    const withoutTarget = getNightActionPrompt({
      role: ROLES.GRAVEDIGGER,
      availableTargets: [],
    });
    expect(withoutTarget).toContain('"target": null');
  });
});

describe('AI 座位号解析', () => {
  it('接受数字与数字字符串座位号', () => {
    const targets = [
      { userId: 'u1', nickname: 'a', seatNumber: 1 },
      { userId: 'u6', nickname: 'b', seatNumber: 6 },
    ];

    expect(targetUserIdFromSeat('6', targets)).toBe('u6');
    expect(targetUserIdFromSeat(6, targets)).toBe('u6');
    expect(targetUserIdFromSeat('6号', targets)).toBeUndefined();
    expect(targetUserIdFromSeat('\\6', targets)).toBeUndefined();
  });
});

describe('触发动作语义校验', () => {
  it('白狼王不会带走自己的队友', () => {
    const wolfKing = createPlayer('player1', ROLES.WOLF_KING);
    const teammate = createPlayer('player2', ROLES.WEREWOLF);
    const villager = createPlayer('player3', ROLES.VILLAGER);
    const state = createState([wolfKing, teammate, villager]);

    const { target, corrections } = guardTriggerAction(
      state,
      wolfKing,
      'wolf_king_drag',
      teammate.userId,
      [teammate.userId, villager.userId],
    );

    expect(corrections).toHaveLength(1);
    expect(target).toBe(villager.userId);
  });
});

describe('AI 夜晚行动最终兜底', () => {
  it('兜底动作也被拒绝时会强制推进阶段而不是静默卡住', () => {
    const settings = createSettings({
      [ROLES.WEREWOLF]: 1,
      [ROLES.GUARD]: 1,
      [ROLES.WITCH]: 1,
      [ROLES.VILLAGER]: 1,
    });
    const gm = new GameManager(createRoom(['u1', 'u2', 'u3', 'u4'], settings));
    gm.initializeGame();
    gm.startNight();

    const guard = gm.getState().players.find(p => p.role === ROLES.GUARD);
    expect(guard).toBeDefined();
    expect(gm.getState().nightCurrentRole).toBe(ROLES.GUARD);

    // 模拟所有提交尝试都被规则层拒绝
    vi.spyOn(gm, 'handleNightAction').mockReturnValue(false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(gm.forceNightActionFallback(guard!.userId)).toBe(true);

    // 阶段已推进到下一个夜晚角色，而不是停留在守卫行动上
    expect(gm.getState().nightCurrentRole).toBe(ROLES.WEREWOLF);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
