import { create } from 'zustand';

interface ConnectionState {
  connected: boolean;
  roomId: string | null;
  globalError: string | null;
  setConnected: (connected: boolean) => void;
  setRoomId: (roomId: string | null) => void;
  setGlobalError: (error: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connected: false,
  roomId: null,
  globalError: null,
  setConnected: (connected) => set({ connected }),
  setRoomId: (roomId) => set({ roomId }),
  setGlobalError: (error) => {
    set({ globalError: error });
    // 3 秒后自动清除
    if (error) {
      setTimeout(() => set({ globalError: null }), 5000);
    }
  },
}));
