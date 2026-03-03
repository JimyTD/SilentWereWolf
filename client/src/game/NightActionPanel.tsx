import { useState } from 'react';
import { useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { getUserId } from '../utils/userId';
import { useRoomStore } from '../stores/roomStore';

const ROLE_LABELS: Record<string, string> = {
  werewolf: '狼人', seer: '预言家', witch: '女巫', guard: '守卫',
  villager: '平民', wolfKing: '白狼王',
};

export default function NightActionPanel() {
  const nightAction = useGameStore(s => s.nightAction);
  const myRole = useGameStore(s => s.myRole);
  const players = useGameStore(s => s.players);
  const room = useRoomStore(s => s.room);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [selectedPotion, setSelectedPotion] = useState<string>('none');
  const [submitted, setSubmitted] = useState(false);

  const socket = getSocket();

  if (!nightAction) {
    return (
      <div className="bg-night rounded-xl p-6 text-center">
        <div className="text-indigo-300 text-lg mb-2">夜晚降临...</div>
        <div className="text-gray-500 text-sm">等待其他玩家操作</div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="bg-night rounded-xl p-6 text-center">
        <div className="text-green-400 text-lg">操作已提交</div>
        <div className="text-gray-500 text-sm mt-1">等待其他玩家...</div>
      </div>
    );
  }

  const handleSubmit = () => {
    if (!socket) return;

    if (myRole === 'witch') {
      socket.emit('client:nightAction', {
        action: 'usePotion',
        potion: selectedPotion as 'antidote' | 'poison' | 'none',
        target: selectedPotion === 'poison' ? selectedTarget || undefined : undefined,
      });
    } else {
      socket.emit('client:nightAction', {
        action: nightAction.role === 'werewolf' ? 'attack' :
                nightAction.role === 'seer' ? 'investigate' :
                nightAction.role === 'guard' ? 'guard' : 'skip',
        target: selectedTarget || undefined,
      });
    }
    setSubmitted(true);
  };

  const getPlayerName = (userId: string) => {
    const p = players.find(pl => pl.userId === userId);
    const rp = room?.players.find(rpl => rpl.userId === userId);
    return `${p?.seatNumber || '?'}号 ${rp?.nickname || '???'}`;
  };

  return (
    <div className="bg-night rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-indigo-300 font-bold">
          夜晚行动 · {ROLE_LABELS[nightAction.role] || nightAction.role}
        </h3>
        <span className="text-gray-500 text-sm">{nightAction.timeout}s</span>
      </div>

      {/* 女巫特殊面板 */}
      {myRole === 'witch' && nightAction.witchInfo && (
        <div className="mb-4">
          {nightAction.witchInfo.victim && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-3">
              <span className="text-red-300 text-sm">
                今晚 {getPlayerName(nightAction.witchInfo.victim)} 被袭击
              </span>
            </div>
          )}
          <div className="flex gap-2 mb-3">
            {nightAction.witchInfo.hasAntidote && nightAction.witchInfo.victim && (
              <button
                onClick={() => { setSelectedPotion('antidote'); setSelectedTarget(null); }}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  selectedPotion === 'antidote'
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                使用解药
              </button>
            )}
            {nightAction.witchInfo.hasPoison && (
              <button
                onClick={() => setSelectedPotion('poison')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  selectedPotion === 'poison'
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                使用毒药
              </button>
            )}
            <button
              onClick={() => { setSelectedPotion('none'); setSelectedTarget(null); }}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                selectedPotion === 'none'
                  ? 'bg-gray-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              不操作
            </button>
          </div>
        </div>
      )}

      {/* 目标选择（非女巫，或女巫毒药模式） */}
      {(myRole !== 'witch' || selectedPotion === 'poison') && nightAction.availableTargets.length > 0 && (
        <div className="mb-4">
          <div className="text-sm text-gray-400 mb-2">选择目标：</div>
          <div className="grid grid-cols-3 gap-2">
            {nightAction.availableTargets.map(targetId => (
              <button
                key={targetId}
                onClick={() => setSelectedTarget(targetId)}
                className={`p-2 rounded-lg text-sm transition ${
                  selectedTarget === targetId
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {getPlayerName(targetId)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 确认按钮 */}
      <button
        onClick={handleSubmit}
        disabled={myRole !== 'witch' && !selectedTarget && nightAction.availableTargets.length > 0}
        className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 rounded-lg transition"
      >
        确认
      </button>
    </div>
  );
}
