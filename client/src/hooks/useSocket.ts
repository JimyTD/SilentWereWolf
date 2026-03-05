import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/types/socket';
import { getUserId, getNickname } from '../utils/userId';
import { useConnectionStore } from '../stores/connectionStore';
import { useRoomStore } from '../stores/roomStore';
import { useGameStore } from '../stores/gameStore';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> | null {
  return socket;
}

export function useSocket() {
  const setConnected = useConnectionStore(s => s.setConnected);
  const setRoom = useRoomStore(s => s.setRoom);
  const updatePlayerList = useRoomStore(s => s.updatePlayerList);
  const removePlayer = useRoomStore(s => s.removePlayer);
  const gameStore = useGameStore;

  useEffect(() => {
    if (socket) return;

    const userId = getUserId();
    const nickname = getNickname();

    socket = io('/', {
      auth: { userId, nickname },
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      setConnected(true);
      console.log('[Socket] 已连接');
    });

    socket.on('disconnect', () => {
      setConnected(false);
      console.log('[Socket] 已断开');
    });

    socket.on('server:connected', (data) => {
      console.log('[Socket] 认证成功, roomId:', data.roomId);
      if (data.roomId) {
        useConnectionStore.getState().setRoomId(data.roomId);
        // 如果服务端返回了 room 数据（刷新重连场景），自动恢复
        if (data.room) {
          useRoomStore.getState().setRoom(data.room);
        }
      }
    });

    socket.on('server:reconnected', (data) => {
      console.log('[Socket] 重连成功');
      setRoom(data.room);
      useGameStore.getState().setFromReconnect(data.gameState);
    });

    socket.on('server:roomUpdate', (room) => {
      setRoom(room);
    });

    socket.on('server:playerJoined', (player) => {
      updatePlayerList(player);
    });

    socket.on('server:playerLeft', (data) => {
      removePlayer(data.userId);
    });

    socket.on('server:kicked', () => {
      setRoom(null);
      useGameStore.getState().reset();
      window.location.href = '/?kicked=1';
    });

    socket.on('server:gameStart', (data) => {
      useGameStore.getState().initGame(data);
    });

    socket.on('server:phaseChange', (data) => {
      useGameStore.getState().setPhase(data.phase, data.round);
    });

    socket.on('server:nightAction', (data) => {
      useGameStore.getState().setNightAction(data);
    });

    socket.on('server:wolfVoteUpdate', (data) => {
      useGameStore.getState().setWolfVotes(data.votes);
    });

    socket.on('server:witchInfo', (data) => {
      useGameStore.getState().setWitchInfo(data.victim);
    });

    socket.on('server:investigateResult', (data) => {
      useGameStore.getState().addInvestigation(data.target, data.faction);
    });

    socket.on('server:dayAnnouncement', (data) => {
      useGameStore.getState().addAnnouncement(data);
    });

    socket.on('server:markingTurn', (data) => {
      useGameStore.getState().setMarkingTurn(data);
    });

    socket.on('server:marksRevealed', (data) => {
      useGameStore.getState().addMarks(data);
    });

    socket.on('server:votingStart', (data) => {
      useGameStore.getState().setVotingStart(data);
    });

    socket.on('server:votingResult', (data) => {
      useGameStore.getState().setVotingResult(data);
    });

    socket.on('server:gameOver', (data) => {
      useGameStore.getState().setGameOver(data);
    });

    socket.on('server:error', (data) => {
      console.error('[Socket] 服务端错误:', data.error, data.message);
      useConnectionStore.getState().setGlobalError(data.message || data.error);
    });

    return () => {
      // 不在 cleanup 中断开连接，保持全局 socket
    };
  }, []);
}
