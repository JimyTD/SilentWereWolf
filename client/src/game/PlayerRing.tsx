import { useEffect, useRef, useState } from 'react';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // 监听容器宽度变化，实现响应式
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  if (players.length === 0) return null;

  const sorted = [...players].sort((a, b) => a.seatNumber - b.seatNumber);
  const count = sorted.length;
  const teammateIds = new Set(myTeammates.map(t => t.userId));
  const currentSpeaker = markingTurn?.currentPlayer || null;

  // 响应式半径：基于容器实际宽度计算，留出边距给玩家卡片
  const cardMargin = 40; // 卡片大约半宽
  const maxRadius = count <= 6 ? 100 : count <= 9 ? 115 : 130;
  const dynamicRadius = containerWidth > 0
    ? Math.min(maxRadius, (containerWidth / 2) - cardMargin)
    : maxRadius;
  const radius = Math.max(60, dynamicRadius); // 最小半径 60px
  const containerSize = (radius + cardMargin) * 2;

  return (
    <div ref={containerRef} className="bg-gray-800 rounded-xl p-2 sm:p-3">
      <div className="relative mx-auto" style={{ width: '100%', maxWidth: containerSize, height: containerSize }}>
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
          const myIdx = sorted.findIndex(sp => sp.userId === myUserId);
          const offsetIndex = (i - myIdx + count) % count;
          const angle = (Math.PI / 2) + (offsetIndex / count) * 2 * Math.PI;

          const cx = containerSize / 2;
          const cy = containerSize / 2;
          const x = cx + radius * Math.cos(angle);
          const y = cy + radius * Math.sin(angle);

          // 转为百分比定位，确保不溢出
          const xPct = (x / containerSize) * 100;
          const yPct = (y / containerSize) * 100;

          const roomPlayer = room.players.find(rp => rp.userId === p.userId);
          const isMe = p.userId === myUserId;
          const isTeammate = teammateIds.has(p.userId);
          const isSpeaking = p.userId === currentSpeaker;

          return (
            <div
              key={p.userId}
              className="absolute flex flex-col items-center"
              style={{
                left: `${xPct}%`,
                top: `${yPct}%`,
                transform: 'translate(-50%, -50%)',
              }}
            >
              {isSpeaking && (
                <div className="absolute -inset-1 sm:-inset-1.5 rounded-xl border-2 border-green-400 animate-pulse" />
              )}

              <div
                className={`relative flex flex-col items-center px-1.5 py-1 sm:px-2.5 sm:py-1.5 rounded-lg min-w-[48px] sm:min-w-[58px] transition ${
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
                <span className={`text-[10px] sm:text-[11px] font-bold ${
                  isSpeaking ? 'text-green-400' :
                  isMe ? 'text-indigo-400' :
                  isTeammate ? 'text-red-400' :
                  'text-gray-400'
                }`}>
                  {p.seatNumber}号
                </span>
                <span className={`text-[11px] sm:text-xs font-medium truncate max-w-[42px] sm:max-w-[52px] ${
                  p.alive ? 'text-white' : 'text-gray-500 line-through'
                }`}>
                  {roomPlayer?.nickname || '???'}
                </span>
                {!p.alive && (
                  <span className="text-[8px] sm:text-[9px] text-gray-500">出局</span>
                )}
                {isTeammate && p.alive && (
                  <span className="text-[8px] sm:text-[9px] text-red-400">同伴</span>
                )}
                {isMe && p.alive && (
                  <span className="text-[8px] sm:text-[9px] text-indigo-400">我</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
