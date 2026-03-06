import { create } from 'zustand';
import type { Phase, Faction, PlayerMarks, VoteRecord } from '@shared/types/game';
import type {
  GameStartData,
  PublicPlayerInfo,
  NightActionPrompt,
  DayAnnouncementData,
  MarkingTurnData,
  VotingStartData,
  VotingResultData,
  GameOverData,
  ClientGameState,
} from '@shared/types/socket';

interface TriggerState {
  type: 'hunter_shoot' | 'wolf_king_drag' | 'knight_duel' | 'fool_immunity' | null;
  userId: string | null;
  canAct: boolean;
  targets: string[];
}

interface GameStoreState {
  // 是否在游戏中
  inGame: boolean;

  // 我的信息
  myRole: string | null;
  myFaction: Faction | null;
  myItems: string[];
  myTeammates: { userId: string; seatNumber: number }[];

  // 公开信息
  players: PublicPlayerInfo[];
  phase: Phase | null;
  round: number;

  // 夜晚操作
  nightAction: NightActionPrompt | null;
  witchVictim: string | null;
  investigations: { target: string; faction: Faction }[];
  wolfVotes: Record<string, string>; // 狼人队友投票情况

  // 白天公告
  announcements: DayAnnouncementData[];

  // 标记
  markingTurn: MarkingTurnData | null;
  marks: PlayerMarks[];

  // 投票
  votingData: VotingStartData | null;
  votingResult: VotingResultData | null;
  hasVoted: boolean;
  voteHistory: VotingResultData[];

  // 触发链状态
  triggerState: TriggerState;

  // 游戏结束
  gameOverData: GameOverData | null;

  // Actions
  initGame: (data: GameStartData) => void;
  setFromReconnect: (data: ClientGameState) => void;
  setPhase: (phase: Phase, round: number) => void;
  setNightAction: (data: NightActionPrompt) => void;
  setWolfVotes: (votes: Record<string, string>) => void;
  setWitchInfo: (victim: string | null) => void;
  addInvestigation: (target: string, faction: Faction) => void;
  addAnnouncement: (data: DayAnnouncementData) => void;
  setMarkingTurn: (data: MarkingTurnData) => void;
  addMarks: (data: PlayerMarks) => void;
  setVotingStart: (data: VotingStartData) => void;
  setVotingResult: (data: VotingResultData) => void;
  setGameOver: (data: GameOverData) => void;
  // 触发链 actions
  setHunterTrigger: (canShoot: boolean) => void;
  setWolfKingTrigger: () => void;
  setKnightTurn: (canDuel: boolean) => void;
  setFoolImmunity: (userId: string) => void;
  clearTrigger: () => void;
  reset: () => void;
}

const initialTriggerState: TriggerState = {
  type: null,
  userId: null,
  canAct: false,
  targets: [],
};

const initialState = {
  inGame: false,
  myRole: null,
  myFaction: null,
  myItems: [],
  myTeammates: [],
  players: [],
  phase: null,
  round: 0,
  nightAction: null,
  witchVictim: null,
  investigations: [],
  wolfVotes: {},
  announcements: [],
  markingTurn: null,
  marks: [],
  votingData: null,
  votingResult: null,
  hasVoted: false,
  voteHistory: [],
  triggerState: initialTriggerState,
  gameOverData: null,
};

export const useGameStore = create<GameStoreState>((set) => ({
  ...initialState,

  initGame: (data) =>
    set({
      inGame: true,
      myRole: data.role,
      myFaction: data.faction,
      myItems: data.items,
      myTeammates: data.teammates,
      players: data.players,
      phase: data.phase,
      round: data.round,
      nightAction: null,
      witchVictim: null,
      investigations: [],
      wolfVotes: {},
      announcements: [],
      marks: [],
      markingTurn: null,
      votingData: null,
      votingResult: null,
      hasVoted: false,
      voteHistory: [],
      triggerState: initialTriggerState,
      gameOverData: null,
    }),

  setFromReconnect: (data) =>
    set({
      inGame: true,
      myRole: data.myRole,
      myFaction: data.myFaction,
      myItems: data.myItems,
      myTeammates: data.myTeammates,
      players: data.players,
      phase: data.phase,
      round: data.round,
      marks: data.marks,
      announcements: data.announcements,
    }),

  setPhase: (phase, round) =>
    set({
      phase,
      round,
      nightAction: null,
      wolfVotes: {},
      markingTurn: null,
      votingData: null,
      votingResult: null,
      hasVoted: false,
    }),

  setNightAction: (data) => set({ nightAction: data }),
  setWolfVotes: (votes) => set({ wolfVotes: votes }),
  setWitchInfo: (victim) => set({ witchVictim: victim }),

  addInvestigation: (target, faction) =>
    set((state) => ({
      investigations: [...state.investigations, { target, faction }],
    })),

  addAnnouncement: (data) =>
    set((state) => {
      // 更新玩家存活状态
      const updatedPlayers = state.players.map(p => {
        const death = data.deaths.find(d => d.userId === p.userId);
        if (death) return { ...p, alive: false };
        return p;
      });
      return {
        announcements: [...state.announcements, data],
        players: updatedPlayers,
      };
    }),

  setMarkingTurn: (data) => set({ markingTurn: data }),

  addMarks: (data) =>
    set((state) => ({ marks: [...state.marks, data] })),

  setVotingStart: (data) => set({ votingData: data, hasVoted: false, votingResult: null }),

  setVotingResult: (data) =>
    set((state) => {
      // 更新被放逐者存活状态
      let updatedPlayers = state.players;
      if (data.exiled) {
        updatedPlayers = state.players.map(p =>
          p.userId === data.exiled ? { ...p, alive: false } : p
        );
      }
      return { votingResult: data, players: updatedPlayers, voteHistory: [...state.voteHistory, data] };
    }),

  // 触发链
  setHunterTrigger: (canShoot) =>
    set((state) => ({
      triggerState: {
        type: 'hunter_shoot',
        userId: null,
        canAct: canShoot,
        targets: state.players.filter(p => p.alive).map(p => p.userId),
      },
    })),

  setWolfKingTrigger: () =>
    set((state) => ({
      triggerState: {
        type: 'wolf_king_drag',
        userId: null,
        canAct: true,
        targets: state.players.filter(p => p.alive).map(p => p.userId),
      },
    })),

  setKnightTurn: (canDuel) =>
    set((state) => ({
      triggerState: {
        type: 'knight_duel',
        userId: null,
        canAct: canDuel,
        targets: state.players.filter(p => p.alive).map(p => p.userId),
      },
    })),

  setFoolImmunity: (userId) =>
    set((state) => {
      // 白痴免疫 → 恢复存活状态（前端之前在投票结果时标记死亡了）
      const updatedPlayers = state.players.map(p =>
        p.userId === userId ? { ...p, alive: true } : p
      );
      return {
        triggerState: {
          type: 'fool_immunity',
          userId,
          canAct: false,
          targets: [],
        },
        players: updatedPlayers,
      };
    }),

  clearTrigger: () => set({ triggerState: initialTriggerState }),

  setGameOver: (data) =>
    set({
      gameOverData: data,
      phase: 'game_over' as Phase,
      inGame: false,
    }),

  reset: () => set(initialState),
}));
