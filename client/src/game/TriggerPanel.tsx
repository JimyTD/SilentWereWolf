import { useState } from 'react';
import type { Room } from '@shared/types/room';
import { useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { getUserId } from '../utils/userId';

interface Props {
  room: Room;
}

export default function TriggerPanel({ room }: Props) {
  const triggerState = useGameStore(s => s.triggerState);
  const myRole = useGameStore(s => s.myRole);
  const players = useGameStore(s => s.players);
  const myUserId = getUserId();
  const socket = getSocket();
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const getPlayerName = (userId: string) => {
    const p = players.find(pl => pl.userId === userId);
    const rp = room.players.find(rpl => rpl.userId === userId);
    return `${p?.seatNumber || '?'}号 ${rp?.nickname || '???'}`;
  };

  // 白痴免疫提示（所有人可见）
  if (triggerState.type === 'fool_immunity') {
    return (
      <div className="bg-blue-900/30 border border-blue-500/30 rounded-xl p-5 text-center">
        <h3 className="text-blue-400 font-bold text-lg mb-2">白痴免疫！</h3>
        <p className="text-gray-300">
          {triggerState.userId ? getPlayerName(triggerState.userId) : '某位玩家'} 是白痴，首次被放逐免疫出局
        </p>
        <p className="text-gray-500 text-sm mt-1">该玩家身份已公开，但失去投票权</p>
      </div>
    );
  }

  // 猎人开枪
  if (triggerState.type === 'hunter_shoot') {
    if (myRole !== 'hunter') {
      return (
        <div className="bg-orange-900/30 border border-orange-500/30 rounded-xl p-5 text-center">
          <h3 className="text-orange-400 font-bold text-lg mb-2">猎人开枪</h3>
          <p className="text-gray-400">猎人正在选择开枪目标...</p>
        </div>
      );
    }

    if (submitted) {
      return (
        <div className="bg-orange-900/30 border border-orange-500/30 rounded-xl p-5 text-center">
          <div className="text-green-400 text-lg">操作已提交</div>
          <div className="text-gray-500 text-sm mt-1">等待处理...</div>
        </div>
      );
    }

    const targets = players.filter(p => p.alive && p.userId !== myUserId);

    return (
      <div className="bg-orange-900/30 border border-orange-500/30 rounded-xl p-5">
        <h3 className="text-orange-400 font-bold text-lg mb-3">你已出局——猎人可以开枪！</h3>
        {triggerState.canAct ? (
          <>
            <p className="text-gray-400 text-sm mb-3">选择一名玩家带走，或放弃开枪</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {targets.map(p => (
                <button
                  key={p.userId}
                  onClick={() => setSelectedTarget(p.userId)}
                  className={`p-2 rounded-lg text-sm transition ${
                    selectedTarget === p.userId
                      ? 'bg-orange-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {getPlayerName(p.userId)}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!socket || !selectedTarget) return;
                  socket.emit('client:hunterAction', { action: 'shoot', target: selectedTarget });
                  setSubmitted(true);
                }}
                disabled={!selectedTarget}
                className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 rounded-lg transition"
              >
                开枪
              </button>
              <button
                onClick={() => {
                  if (!socket) return;
                  socket.emit('client:hunterAction', { action: 'skip' });
                  setSubmitted(true);
                }}
                className="px-6 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-3 rounded-lg transition"
              >
                放弃
              </button>
            </div>
          </>
        ) : (
          <p className="text-red-400">你被毒死，无法开枪</p>
        )}
      </div>
    );
  }

  // 白狼王带人
  if (triggerState.type === 'wolf_king_drag') {
    if (myRole !== 'wolfKing') {
      return (
        <div className="bg-red-900/30 border border-red-500/30 rounded-xl p-5 text-center">
          <h3 className="text-red-400 font-bold text-lg mb-2">白狼王带人</h3>
          <p className="text-gray-400">白狼王正在选择带走的目标...</p>
        </div>
      );
    }

    if (submitted) {
      return (
        <div className="bg-red-900/30 border border-red-500/30 rounded-xl p-5 text-center">
          <div className="text-green-400 text-lg">操作已提交</div>
          <div className="text-gray-500 text-sm mt-1">等待处理...</div>
        </div>
      );
    }

    const targets = players.filter(p => p.alive && p.userId !== myUserId);

    return (
      <div className="bg-red-900/30 border border-red-500/30 rounded-xl p-5">
        <h3 className="text-red-400 font-bold text-lg mb-3">你被放逐了——可以带走一人！</h3>
        <p className="text-gray-400 text-sm mb-3">选择一名玩家带走，或放弃</p>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {targets.map(p => (
            <button
              key={p.userId}
              onClick={() => setSelectedTarget(p.userId)}
              className={`p-2 rounded-lg text-sm transition ${
                selectedTarget === p.userId
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {getPlayerName(p.userId)}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              if (!socket || !selectedTarget) return;
              socket.emit('client:wolfKingAction', { action: 'drag', target: selectedTarget });
              setSubmitted(true);
            }}
            disabled={!selectedTarget}
            className="flex-1 bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 rounded-lg transition"
          >
            带走
          </button>
          <button
            onClick={() => {
              if (!socket) return;
              socket.emit('client:wolfKingAction', { action: 'skip' });
              setSubmitted(true);
            }}
            className="px-6 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-3 rounded-lg transition"
          >
            放弃
          </button>
        </div>
      </div>
    );
  }

  // 骑士决斗
  if (triggerState.type === 'knight_duel') {
    if (myRole !== 'knight') {
      return (
        <div className="bg-cyan-900/30 border border-cyan-500/30 rounded-xl p-5 text-center">
          <h3 className="text-cyan-400 font-bold text-lg mb-2">骑士决斗阶段</h3>
          <p className="text-gray-400">骑士正在决定是否发动决斗...</p>
        </div>
      );
    }

    if (submitted) {
      return (
        <div className="bg-cyan-900/30 border border-cyan-500/30 rounded-xl p-5 text-center">
          <div className="text-green-400 text-lg">操作已提交</div>
          <div className="text-gray-500 text-sm mt-1">等待处理...</div>
        </div>
      );
    }

    const targets = players.filter(p => p.alive && p.userId !== myUserId);

    return (
      <div className="bg-cyan-900/30 border border-cyan-500/30 rounded-xl p-5">
        <h3 className="text-cyan-400 font-bold text-lg mb-3">骑士决斗（全局一次）</h3>
        <p className="text-gray-400 text-sm mb-1">指定一名玩家进行决斗：</p>
        <p className="text-gray-500 text-xs mb-3">对方是狼人 → 对方出局 | 对方是好人 → 你出局</p>
        {triggerState.canAct ? (
          <>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {targets.map(p => (
                <button
                  key={p.userId}
                  onClick={() => setSelectedTarget(p.userId)}
                  className={`p-2 rounded-lg text-sm transition ${
                    selectedTarget === p.userId
                      ? 'bg-cyan-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {getPlayerName(p.userId)}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!socket || !selectedTarget) return;
                  socket.emit('client:knightAction', { action: 'duel', target: selectedTarget });
                  setSubmitted(true);
                }}
                disabled={!selectedTarget}
                className="flex-1 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 rounded-lg transition"
              >
                决斗
              </button>
              <button
                onClick={() => {
                  if (!socket) return;
                  socket.emit('client:knightAction', { action: 'skip' });
                  setSubmitted(true);
                }}
                className="px-6 bg-gray-700 hover:bg-gray-600 text-gray-300 font-semibold py-3 rounded-lg transition"
              >
                不决斗
              </button>
            </div>
          </>
        ) : (
          <p className="text-gray-500">决斗机会已使用</p>
        )}
      </div>
    );
  }

  // 默认等待状态
  return (
    <div className="flex items-center justify-center h-32">
      <div className="text-gray-500 text-lg">处理特殊事件中...</div>
    </div>
  );
}
