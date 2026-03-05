import type { Room } from '@shared/types/room';
import { useGameStore } from '../stores/gameStore';
import { getUserId } from '../utils/userId';

interface Props {
  room: Room;
}

export default function PlayerRing({ room }: Props) {
  const players = useGameStore(s => s.players);
  const myTeammates = useGameStore(s => s.myTeammates);
  const markingTurn = useGameStore(s => s.markingTurn);
  const myUserId = getUserId();

  if (players.length === 0) return null;

  // 按座位号排序
  const sorted = [...players].sort((a, b) => a.seatNumber - b.seatNumber);
  const count = sorted.length;
  const teammateIds = new Set(myTeammates.map(t => t.userId));
  const currentSpeaker = markingTurn?.currentPlayer || null;

  // 圆桌半径和尺寸计算（基于玩家数量适配）
  const radius = count <= 6 ? 100 : count <= 9 ? 115 : 130;
  const containerSize = (radius + 45) * 2;

  return (
    <div className="bg-gray-800 rounded-xl p-3">
      <div className="relative mx-auto" style={{ width: containerSize, height: containerSize }}>
        {/* 中央桌面 */}
        <div
          className="absolute rounded-full bg-gray-700/50 border border-gray-600/50"
          style={{
            width: radius * 1.2,
            height: radius * 1.2,
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        />

        {/* 玩家座位 */}
        {sorted.map((p, i) => {
          // 从顶部开始，顺时针排列。自己放底部（如果可以的话）
          const myIdx = sorted.findIndex(sp => sp.userId === myUserId);
          // 以自己为底部中央，重新计算角度偏移
          const offsetIndex = (i - myIdx + count) % count;
          // 从底部(π/2)开始顺时针
          const angle = (Math.PI / 2) + (offsetIndex / count) * 2 * Math.PI;

          const x = containerSize / 2 + radius * Math.cos(angle);
          const y = containerSize / 2 + radius * Math.sin(angle);

          const roomPlayer = room.players.find(rp => rp.userId === p.userId);
          const isMe = p.userId === myUserId;
          const isTeammate = teammateIds.has(p.userId);
          const isSpeaking = p.userId === currentSpeaker;

          return (
            <div
              key={p.userId}
              className="absolute flex flex-col items-center"
              style={{
                left: x,
                top: y,
                transform: 'translate(-50%, -50%)',
              }}
            >
              {/* 发言中指示器 */}
              {isSpeaking && (
                <div className="absolute -inset-1.5 rounded-xl border-2 border-green-400 animate-pulse" />
              )}

              <div
                className={`relative flex flex-col items-center px-2.5 py-1.5 rounded-lg min-w-[58px] transition ${
                  !p.alive
                    ? 'opacity-40 bg-gray-900/60'
                    : isSpeaking
                    ? 'bg-green-600/20 border border-green-500/50'
                    : isMe
                    ? 'bg-indigo-600/20 border border-indigo-500/50'
                    : isTeammate
                    ? 'bg-red-600/20 border border-red-500/30'
                    : 'bg-gray-700/60'
                }`}
              >
                <span className={`text-[11px] font-bold ${
                  isSpeaking ? 'text-green-400' :
                  isMe ? 'text-indigo-400' :
                  isTeammate ? 'text-red-400' :
                  'text-gray-400'
                }`}>
                  {p.seatNumber}号
                </span>
                <span className={`text-xs font-medium truncate max-w-[52px] ${
                  p.alive ? 'text-white' : 'text-gray-500 line-through'
                }`}>
                  {roomPlayer?.nickname || '???'}
                </span>
                {!p.alive && (
                  <span className="text-[9px] text-gray-500">出局</span>
                )}
                {isTeammate && p.alive && (
                  <span className="text-[9px] text-red-400">同伴</span>
                )}
                {isMe && p.alive && (
                  <span className="text-[9px] text-indigo-400">我</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
