import { useState } from 'react';
import type { Room } from '@shared/types/room';
import type { GameOverData } from '@shared/types/socket';
import { useNavigate } from 'react-router-dom';
import { useGameStore } from '../stores/gameStore';
import { useRoomStore } from '../stores/roomStore';
import { getUserId } from '../utils/userId';
import ReplayLog from './ReplayLog';
import { ROLE_LABELS } from '@shared/constants';

const REASON_LABELS: Record<string, string> = {
  wolves_eliminated: '所有狼人已出局',
  specials_eliminated: '所有神职已出局（屠边）',
  villagers_eliminated: '所有平民已出局（屠边）',
  good_eliminated: '所有好人已出局（屠城）',
  exile: '投票放逐',
};

interface Props {
  room: Room;
  data: GameOverData;
}

export default function GameOverPanel({ room, data }: Props) {
  const navigate = useNavigate();
  const myUserId = getUserId();
  const myFaction = useGameStore(s => s.myFaction);
  const isWinner = data.winner === myFaction;
  const [showReplay, setShowReplay] = useState(false);

  const handleBackToLobby = () => {
    useGameStore.getState().reset();
    useRoomStore.getState().setRoom({ ...room, status: 'waiting' });
    navigate(`/room/${room.roomId}`);
  };

  const handleGoHome = () => {
    useGameStore.getState().reset();
    useRoomStore.getState().setRoom(null);
    navigate('/');
  };

  if (showReplay) {
    return <ReplayLog data={data} onClose={() => setShowReplay(false)} />;
  }

  return (
    <div className="min-h-screen min-h-[100dvh] flex items-center justify-center p-3 sm:p-4">
      <div className="w-full max-w-lg">
        {/* 胜负结果 */}
        <div className={`text-center mb-5 sm:mb-8 p-5 sm:p-8 rounded-2xl ${
          isWinner
            ? 'bg-gradient-to-b from-yellow-900/40 to-transparent'
            : 'bg-gradient-to-b from-gray-800/60 to-transparent'
        }`}>
          <div className={`text-3xl sm:text-5xl font-bold mb-2 sm:mb-3 ${isWinner ? 'text-yellow-400' : 'text-gray-400'}`}>
            {isWinner ? '胜利' : '失败'}
          </div>
          <div className={`text-base sm:text-lg ${data.winner === 'good' ? 'text-blue-300' : 'text-red-300'}`}>
            {data.winner === 'good' ? '好人阵营获胜' : '狼人阵营获胜'}
          </div>
          {data.reason && (
            <div className="text-xs sm:text-sm text-gray-400 mt-1 sm:mt-2">
              {REASON_LABELS[data.reason] || data.reason}
            </div>
          )}
        </div>

        {/* 身份揭晓 */}
        <div className="bg-gray-800 rounded-xl p-3 sm:p-5 mb-4 sm:mb-6">
          <h3 className="text-white font-bold mb-3 sm:mb-4 text-sm sm:text-base">身份揭晓</h3>
          <div className="space-y-2">
            {data.players
              .sort((a, b) => a.seatNumber - b.seatNumber)
              .map(p => (
                <div
                  key={p.userId}
                  className={`flex items-center justify-between px-4 py-3 rounded-lg ${
                    p.userId === myUserId ? 'bg-indigo-600/20 border border-indigo-500/30' : 'bg-gray-700/50'
                  }`}
                >
                  <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                    <span className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center bg-gray-600 rounded-full text-[10px] sm:text-xs font-bold text-gray-300 flex-shrink-0">
                      {p.seatNumber}
                    </span>
                    <span className={`text-sm sm:text-base font-medium truncate ${p.alive ? 'text-white' : 'text-gray-500'}`}>
                      {p.nickname}
                    </span>
                    {!p.alive && <span className="text-[10px] sm:text-xs text-gray-600 flex-shrink-0">出局</span>}
                  </div>
                  <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0 flex-wrap justify-end">
                    <span className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium ${
                      p.faction === 'evil'
                        ? 'bg-red-500/20 text-red-300'
                        : 'bg-blue-500/20 text-blue-300'
                    }`}>
                      {ROLE_LABELS[p.role] || p.role}
                    </span>
                    {p.items.length > 0 && p.items.map((item, i) => (
                      <span key={i} className="hidden sm:inline text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                        {item.type === 'moonstone' ? `月光石: ${item.value}`
                          : item.type === 'balance' ? `天平: ${item.value === 'balanced' ? '平衡' : '失衡'}`
                          : `${item.type}: ${item.value}`}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="space-y-2 sm:space-y-3">
          <button
            onClick={() => setShowReplay(true)}
            className="w-full bg-purple-600 hover:bg-purple-500 text-white py-2.5 sm:py-3 rounded-lg transition font-semibold"
          >
            复盘日志
          </button>
          <div className="flex gap-2 sm:gap-3">
            <button
              onClick={handleGoHome}
              className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 py-2.5 sm:py-3 rounded-lg transition font-medium"
            >
              返回首页
            </button>
            <button
              onClick={handleBackToLobby}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-2.5 sm:py-3 rounded-lg transition font-semibold"
            >
              再来一局
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
