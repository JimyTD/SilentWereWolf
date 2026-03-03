import { create } from 'zustand';
import type { Room, RoomPlayer } from '@shared/types/room';

interface RoomState {
  room: Room | null;
  setRoom: (room: Room | null) => void;
  updatePlayerList: (player: RoomPlayer) => void;
  removePlayer: (userId: string) => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  room: null,

  setRoom: (room) => set({ room }),

  updatePlayerList: (player) =>
    set((state) => {
      if (!state.room) return state;
      const exists = state.room.players.some(p => p.userId === player.userId);
      const players = exists
        ? state.room.players.map(p => (p.userId === player.userId ? player : p))
        : [...state.room.players, player];
      return { room: { ...state.room, players } };
    }),

  removePlayer: (userId) =>
    set((state) => {
      if (!state.room) return state;
      return {
        room: {
          ...state.room,
          players: state.room.players.filter(p => p.userId !== userId),
        },
      };
    }),
}));
