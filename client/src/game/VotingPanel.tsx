import { useState } from 'react';
import type { Room } from '@shared/types/room';
import { useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { getUserId } from '../utils/userId';

interface Props {
  room: Room;
}

export default function VotingPanel({ room }: Props) {
  const votingData = useGameStore(s => s.votingData);
  const votingResult = useGameStore(s => s.votingResult);
  const hasVoted = useGameStore(s => s.hasVoted);
  const players = useGameStore(s => s.players);
  const myUserId = getUserId();
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const socket = getSocket();

  // 已出局的玩家只能旁观投票结果，不能投票
  const myPlayer = players.find(p => p.userId === myUserId);
  const isAlive = myPlayer?.alive ?? false;

  // 显示投票结果
  if (votingResult) {
    return (
      <div className="bg-gray-800 rounded-xl p-3 sm:p-5">
        <h3 className="text-red-400 font-bold mb-3 sm:mb-4 text-sm sm:text-base">投票结果</h3>
        {votingResult.tie ? (
          <div className="text-yellow-400 text-center text-base sm:text-lg mb-3 sm:mb-4">平票！无人出局</div>
        ) : votingResult.exiled ? (
          <div className="text-center mb-3 sm:mb-4">
            <span className="text-red-400 text-base sm:text-lg font-bold">
              {getPlayerName(votingResult.exiled, players, room)} 被放逐
            </span>
          </div>
        ) : null}
        <div className="space-y-1">
          {votingResult.votes.map((v, i) => (
            <div key={i} className="flex items-center gap-2 text-xs sm:text-sm">
              <span className="text-gray-400">{getPlayerName(v.voter, players, room)}</span>
              <span className="text-gray-600">→</span>
              <span className="text-red-300">{getPlayerName(v.target, players, room)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!votingData) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 sm:p-5 text-center">
        <div className="text-gray-500 text-sm">等待投票阶段...</div>
      </div>
    );
  }

  // 已出局的玩家只显示旁观提示
  if (!isAlive) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 sm:p-5 text-center">
        <div className="text-gray-500 text-base sm:text-lg">你已出局</div>
        <div className="text-gray-600 text-xs sm:text-sm mt-1">等待其他玩家完成投票...</div>
      </div>
    );
  }

  if (hasVoted) {
    return (
      <div className="bg-gray-800 rounded-xl p-4 sm:p-5 text-center">
        <div className="text-green-400 text-base sm:text-lg">已投票</div>
        <div className="text-gray-500 text-xs sm:text-sm mt-1">等待其他玩家投票...</div>
      </div>
    );
  }

  const candidates = votingData.candidates.filter(id => id !== myUserId);

  const handleVote = () => {
    if (!socket || !selectedTarget) return;
    socket.emit('client:vote', { target: selectedTarget });
    useGameStore.getState().hasVoted = true;
    useGameStore.setState({ hasVoted: true });
  };

  return (
    <div className="bg-gray-800 rounded-xl p-3 sm:p-5">
      <div className="flex items-center justify-between mb-3 sm:mb-4">
        <h3 className="text-red-400 font-bold text-sm sm:text-base">放逐投票</h3>
      </div>

      <div className="text-xs sm:text-sm text-gray-400 mb-2 sm:mb-3">选择一名玩家放逐（不可投自己、不可弃票）</div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 sm:gap-2 mb-3 sm:mb-4">
        {candidates.map(candidateId => (
          <button
            key={candidateId}
            onClick={() => setSelectedTarget(candidateId)}
            className={`p-2 sm:p-3 rounded-lg text-xs sm:text-sm transition ${
              selectedTarget === candidateId
                ? 'bg-red-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {getPlayerName(candidateId, players, room)}
          </button>
        ))}
      </div>

      <button
        onClick={handleVote}
        disabled={!selectedTarget}
        className="w-full bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-2.5 sm:py-3 rounded-lg transition"
      >
        确认投票
      </button>
    </div>
  );
}

function getPlayerName(
  userId: string,
  players: { userId: string; seatNumber: number }[],
  room: Room
): string {
  const p = players.find(pl => pl.userId === userId);
  const rp = room.players.find(rpl => rpl.userId === userId);
  return `${p?.seatNumber || '?'}号 ${rp?.nickname || '???'}`;
}
