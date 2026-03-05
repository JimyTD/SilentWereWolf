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
  const wolfVotes = useGameStore(s => s.wolfVotes);
  const myTeammates = useGameStore(s => s.myTeammates);
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [selectedPotion, setSelectedPotion] = useState<string>('none');
  const [submitted, setSubmitted] = useState(false);

  const socket = getSocket();
  const myUserId = getUserId();

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
        {/* 狼人提交后仍可看到队友投票进度 */}
        {isWolf(myRole) && <WolfVoteStatus wolfVotes={wolfVotes} myTeammates={myTeammates} players={players} room={room} myUserId={myUserId} />}
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

  // 获取某个目标被哪些队友选择了
  const getTeammateVotesForTarget = (targetId: string): string[] => {
    if (!isWolf(myRole)) return [];
    const voterIds: string[] = [];
    for (const [voterId, votedTarget] of Object.entries(wolfVotes)) {
      if (votedTarget === targetId && voterId !== myUserId) {
        voterIds.push(voterId);
      }
    }
    return voterIds;
  };

  return (
    <div className="bg-night rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-indigo-300 font-bold">
          夜晚行动 · {ROLE_LABELS[nightAction.role] || nightAction.role}
        </h3>
      </div>

      {/* 狼人队友投票状态 */}
      {isWolf(myRole) && <WolfVoteStatus wolfVotes={wolfVotes} myTeammates={myTeammates} players={players} room={room} myUserId={myUserId} />}

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
            {nightAction.availableTargets.map(targetId => {
              const teammateVoters = getTeammateVotesForTarget(targetId);
              const isSelf = targetId === myUserId;
              return (
                <button
                  key={targetId}
                  onClick={() => setSelectedTarget(targetId)}
                  className={`relative p-2 rounded-lg text-sm transition ${
                    selectedTarget === targetId
                      ? 'bg-indigo-600 text-white'
                      : isSelf
                      ? 'bg-yellow-900/30 text-yellow-300 hover:bg-yellow-900/50 border border-yellow-500/30'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {getPlayerName(targetId)}
                  {isSelf && <span className="text-[10px] ml-0.5">(自己)</span>}
                  {/* 队友选择标记 */}
                  {teammateVoters.length > 0 && (
                    <div className="absolute -top-1.5 -right-1.5 flex gap-0.5">
                      {teammateVoters.map(vid => {
                        const vp = players.find(p => p.userId === vid);
                        return (
                          <span key={vid} className="bg-red-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center font-bold">
                            {vp?.seatNumber || '?'}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </button>
              );
            })}
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

function isWolf(role: string | null): boolean {
  return role === 'werewolf' || role === 'wolfKing';
}

interface WolfVoteStatusProps {
  wolfVotes: Record<string, string>;
  myTeammates: { userId: string; seatNumber: number }[];
  players: { userId: string; seatNumber: number; nickname: string; alive: boolean }[];
  room: { players: { userId: string; nickname: string }[] } | null;
  myUserId: string;
}

function WolfVoteStatus({ wolfVotes, myTeammates, players, room, myUserId }: WolfVoteStatusProps) {
  if (myTeammates.length === 0) return null;

  const getPlayerName = (userId: string) => {
    const p = players.find(pl => pl.userId === userId);
    const rp = room?.players.find(rpl => rpl.userId === userId);
    return `${p?.seatNumber || '?'}号·${rp?.nickname || '???'}`;
  };

  return (
    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-3">
      <div className="text-red-400 text-xs font-medium mb-2">队友选择</div>
      <div className="space-y-1">
        {myTeammates.map(t => {
          const vote = wolfVotes[t.userId];
          return (
            <div key={t.userId} className="flex items-center gap-2 text-xs">
              <span className="text-red-300">{t.seatNumber}号</span>
              <span className="text-gray-600">→</span>
              {vote ? (
                <span className="text-gray-300">{getPlayerName(vote)}</span>
              ) : (
                <span className="text-gray-500 italic">思考中...</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
