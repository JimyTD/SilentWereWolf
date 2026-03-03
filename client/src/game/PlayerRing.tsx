import type { Room } from '@shared/types/room';
import { useGameStore } from '../stores/gameStore';
import { getUserId } from '../utils/userId';

interface Props {
  room: Room;
}

export default function PlayerRing({ room }: Props) {
  const players = useGameStore(s => s.players);
  const myTeammates = useGameStore(s => s.myTeammates);
  const myUserId = getUserId();

  if (players.length === 0) return null;

  // 将自己放在底部中央，其他玩家环形排列
  const myIndex = players.findIndex(p => p.userId === myUserId);
  const others = [...players.slice(myIndex + 1), ...players.slice(0, myIndex)];
  const me = players[myIndex];

  const teammateIds = new Set(myTeammates.map(t => t.userId));

  return (
    <div className="bg-gray-800 rounded-xl p-4">
      {/* 其他玩家 */}
      <div className="flex flex-wrap justify-center gap-2 mb-3">
        {others.map((p) => {
          const roomPlayer = room.players.find(rp => rp.userId === p.userId);
          const isTeammate = teammateIds.has(p.userId);
          return (
            <PlayerCard
              key={p.userId}
              seatNumber={p.seatNumber}
              nickname={roomPlayer?.nickname || '???'}
              alive={p.alive}
              isTeammate={isTeammate}
              isMe={false}
            />
          );
        })}
      </div>

      {/* 分割线 */}
      <div className="border-t border-gray-700 my-3" />

      {/* 自己 */}
      {me && (
        <div className="flex justify-center">
          <PlayerCard
            seatNumber={me.seatNumber}
            nickname={room.players.find(rp => rp.userId === me.userId)?.nickname || '你'}
            alive={me.alive}
            isTeammate={false}
            isMe={true}
          />
        </div>
      )}
    </div>
  );
}

interface PlayerCardProps {
  seatNumber: number;
  nickname: string;
  alive: boolean;
  isTeammate: boolean;
  isMe: boolean;
}

function PlayerCard({ seatNumber, nickname, alive, isTeammate, isMe }: PlayerCardProps) {
  return (
    <div
      className={`relative flex flex-col items-center px-3 py-2 rounded-lg min-w-[70px] transition ${
        !alive
          ? 'opacity-40 bg-gray-900/50'
          : isMe
          ? 'bg-indigo-600/20 border border-indigo-500/50'
          : isTeammate
          ? 'bg-red-600/20 border border-red-500/30'
          : 'bg-gray-700/50'
      }`}
    >
      <span className={`text-xs font-bold mb-1 ${
        isMe ? 'text-indigo-400' : isTeammate ? 'text-red-400' : 'text-gray-400'
      }`}>
        {seatNumber}号
      </span>
      <span className={`text-sm font-medium truncate max-w-[60px] ${
        alive ? 'text-white' : 'text-gray-500 line-through'
      }`}>
        {nickname}
      </span>
      {!alive && (
        <span className="text-[10px] text-gray-500 mt-0.5">出局</span>
      )}
      {isTeammate && alive && (
        <span className="text-[10px] text-red-400 mt-0.5">同伴</span>
      )}
    </div>
  );
}
