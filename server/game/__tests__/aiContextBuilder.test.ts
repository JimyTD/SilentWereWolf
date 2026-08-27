import { describe, expect, it } from 'vitest';
import { FACTIONS, PHASES, ROLES } from '../../../shared/constants';
import type { GamePlayer, GameState } from '../../../shared/types/game';
import type { Room } from '../../../shared/types/room';
import { buildAIContext, contextToText } from '../ai/AIContextBuilder';

const players: GamePlayer[] = [
  {
    userId: 'seer',
    seatNumber: 1,
    role: ROLES.SEER,
    faction: FACTIONS.GOOD,
    alive: true,
    items: [],
    roleState: {},
  },
  {
    userId: 'wolf',
    seatNumber: 2,
    role: ROLES.WEREWOLF,
    faction: FACTIONS.EVIL,
    alive: true,
    items: [],
    roleState: {},
  },
  {
    userId: 'villager',
    seatNumber: 3,
    role: ROLES.VILLAGER,
    faction: FACTIONS.GOOD,
    alive: false,
    items: [],
    roleState: {},
  },
];

const state = {
  roomId: 'room',
  status: 'playing',
  round: 2,
  phase: PHASES.DAY_MARKING,
  players,
  nightActions: {
    guard: null,
    wolves: { target: 'villager', votes: {} },
    witch: null,
    seer: { target: 'villager' },
    gravedigger: null,
  },
  markingOrder: [],
  markingCurrent: 0,
  history: {
    rounds: [{
      guard: null,
      wolves: { target: 'villager', votes: {} },
      witch: null,
      seer: { target: 'villager' },
      gravedigger: null,
    }],
    marks: [{
      player: 'wolf',
      round: 1,
      identityMark: { identity: '平民', reason: 'intuition' },
      evaluationMarks: [{ target: 'seer', identity: '狼人', reason: 'mark_analysis' }],
    }],
    votes: [],
    deaths: [{ userId: 'villager', seatNumber: 3, cause: 'attacked', round: 1, relics: [] }],
  },
  winner: null,
  nightCurrentRole: null,
  pendingTriggers: [],
} as GameState;

const room = {
  roomId: 'room',
  players: [
    { userId: 'seer', nickname: '预言家AI', seatNumber: 1, connected: true, ready: true },
    { userId: 'wolf', nickname: '狼人AI', seatNumber: 2, connected: true, ready: true },
    { userId: 'villager', nickname: '玩家', seatNumber: 3, connected: true, ready: true },
  ],
} as Room;

describe('AI context information categories', () => {
  it('keeps public facts, private facts, and player claims separate', () => {
    const seerContext = buildAIContext(state, room, players[0]);
    expect(seerContext.publicFacts.deadPlayers[0]?.seatNumber).toBe(3);
    expect(seerContext.privateFacts.investigations).toEqual([
      { round: 1, kind: 'seer', targetSeat: 3, faction: FACTIONS.GOOD },
    ]);
    expect(seerContext.privateFacts.teammates).toHaveLength(0);
    expect(seerContext.playerClaims.marks[0]?.evaluations[0]?.identity).toBe('狼人');

    const wolfContext = buildAIContext(state, room, players[1]);
    expect(wolfContext.privateFacts.teammates.map(player => player.seatNumber)).toEqual([]);
    expect(wolfContext.privateFacts.investigations).toHaveLength(0);
    expect(wolfContext.privateFacts.wolfAttacks).toEqual([{ round: 1, targetSeat: 3 }]);
  });

  it('labels player claims as unverified in the prompt', () => {
    const text = contextToText(buildAIContext(state, room, players[0]));
    expect(text).toContain('公开系统事实（所有玩家可见，以此为准）');
    expect(text).toContain('私有系统事实（仅你可知）');
    expect(text).toContain('玩家公开声明（不等于真实身份或系统确认）');
  });
});
