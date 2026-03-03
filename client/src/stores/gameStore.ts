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

  // 白天公告
  announcements: DayAnnouncementData[];

  // 标记
  markingTurn: MarkingTurnData | null;
  marks: PlayerMarks[];

  // 投票
  votingData: VotingStartData | null;
  votingResult: VotingResultData | null;
  hasVoted: boolean;

  // 游戏结束
  gameOverData: GameOverData | null;

  // Actions
  initGame: (data: GameStartData) => void;
  setFromReconnect: (data: ClientGameState) => void;
  setPhase: (phase: Phase, round: number) => void;
  setNightAction: (data: NightActionPrompt) => void;
  setWitchInfo: (victim: string | null) => void;
  addInvestigation: (target: string, faction: Faction) => void;
  addAnnouncement: (data: DayAnnouncementData) => void;
  setMarkingTurn: (data: MarkingTurnData) => void;
  addMarks: (data: PlayerMarks) => void;
  setVotingStart: (data: VotingStartData) => void;
  setVotingResult: (data: VotingResultData) => void;
  setGameOver: (data: GameOverData) => void;
  reset: () => void;
}

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
  announcements: [],
  markingTurn: null,
  marks: [],
  votingData: null,
  votingResult: null,
  hasVoted: false,
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
      announcements: [],
      marks: [],
      markingTurn: null,
      votingData: null,
      votingResult: null,
      hasVoted: false,
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
      markingTurn: null,
      votingData: null,
      votingResult: null,
      hasVoted: false,
    }),

  setNightAction: (data) => set({ nightAction: data }),
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
      return { votingResult: data, players: updatedPlayers };
    }),

  setGameOver: (data) =>
    set({
      gameOverData: data,
      phase: 'game_over' as Phase,
      inGame: false,
    }),

  reset: () => set(initialState),
}));
