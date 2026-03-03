import { ROOM_IDLE_TIMEOUT } from '../../shared/constants';
import type { RoomManager } from './RoomManager';

const CLEANUP_INTERVAL = 5 * 60 * 1000; // 每 5 分钟检查一次

export function startRoomCleanup(roomManager: RoomManager): void {
  setInterval(() => {
    const idleRooms = roomManager.getIdleRooms(ROOM_IDLE_TIMEOUT);
    for (const roomId of idleRooms) {
      roomManager.destroyRoom(roomId);
    }
    if (idleRooms.length > 0) {
      console.log(`[清理] 清理了 ${idleRooms.length} 个空闲房间`);
    }
  }, CLEANUP_INTERVAL);
}
