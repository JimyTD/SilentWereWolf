import type { Room } from '@shared/types/room';
import type { GameOverData } from '@shared/types/socket';
import { useNavigate } from 'react-router-dom';
import { useGameStore } from '../stores/gameStore';
import { useRoomStore } from '../stores/roomStore';
import { getUserId } from '../utils/userId';

const ROLE_LABELS: Record<string, string> = {
  werewolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人',
  guard: '守卫', villager: '平民', gravedigger: '守墓人',
  fool: '白痴', knight: '骑士', wolfKing: '白狼王',
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

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* 胜负结果 */}
        <div className={`text-center mb-8 p-8 rounded-2xl ${
          isWinner
            ? 'bg-gradient-to-b from-yellow-900/40 to-transparent'
            : 'bg-gradient-to-b from-gray-800/60 to-transparent'
        }`}>
          <div className={`text-5xl font-bold mb-3 ${isWinner ? 'text-yellow-400' : 'text-gray-400'}`}>
            {isWinner ? '胜利' : '失败'}
          </div>
          <div className={`text-lg ${data.winner === 'good' ? 'text-blue-300' : 'text-red-300'}`}>
            {data.winner === 'good' ? '好人阵营获胜' : '狼人阵营获胜'}
          </div>
        </div>

        {/* 身份揭晓 */}
        <div className="bg-gray-800 rounded-xl p-5 mb-6">
          <h3 className="text-white font-bold mb-4">身份揭晓</h3>
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
                  <div className="flex items-center gap-3">
                    <span className="w-7 h-7 flex items-center justify-center bg-gray-600 rounded-full text-xs font-bold text-gray-300">
                      {p.seatNumber}
                    </span>
                    <span className={`font-medium ${p.alive ? 'text-white' : 'text-gray-500'}`}>
                      {p.nickname}
                    </span>
                    {!p.alive && <span className="text-xs text-gray-600">出局</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      p.faction === 'evil'
                        ? 'bg-red-500/20 text-red-300'
                        : 'bg-blue-500/20 text-blue-300'
                    }`}>
                      {ROLE_LABELS[p.role] || p.role}
                    </span>
                    {p.items.length > 0 && p.items.map((item, i) => (
                      <span key={i} className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                        {item.type === 'moonstone' ? `月光石:${item.value}` : `天平:${item.value}`}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3">
          <button
            onClick={handleGoHome}
            className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 py-3 rounded-lg transition font-medium"
          >
            返回首页
          </button>
          <button
            onClick={handleBackToLobby}
            className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-3 rounded-lg transition font-semibold"
          >
            再来一局
          </button>
        </div>
      </div>
    </div>
  );
}
