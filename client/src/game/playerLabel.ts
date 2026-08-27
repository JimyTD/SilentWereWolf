export interface SeatPlayer {
  userId: string;
  seatNumber: number;
}

export function getPlayerLabel(userId: string, players: SeatPlayer[]): string {
  const player = players.find(item => item.userId === userId);
  return player ? `${player.seatNumber}号位` : '未知玩家';
}
