import { useState } from 'react';
import type { MarkReason } from '@shared/types/game';
import type { Room } from '@shared/types/room';
import { useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';
import { getUserId } from '../utils/userId';
import { COMMON_REASONS, SPECIAL_REASONS } from '@shared/constants';

const REASON_LABELS: Record<string, string> = {
  [COMMON_REASONS.INTUITION]: '直觉判断',
  [COMMON_REASONS.VOTE_ANALYSIS]: '基于投票的分析',
  [COMMON_REASONS.MARK_ANALYSIS]: '基于标记的分析',
  [COMMON_REASONS.LOG_REASONING]: '基于日志的推理',
  [SPECIAL_REASONS.INVESTIGATION]: '【查验结论】',
  [SPECIAL_REASONS.POTION_RESULT]: '【用药结果】',
};

interface Props {
  room: Room;
}

export default function MarkingPanel({ room }: Props) {
  const markingTurn = useGameStore(s => s.markingTurn);
  const players = useGameStore(s => s.players);
  const myUserId = getUserId();
  const myRole = useGameStore(s => s.myRole);
  const socket = getSocket();

  const [selfIdentity, setSelfIdentity] = useState('');
  const [selfReason, setSelfReason] = useState<string>(COMMON_REASONS.INTUITION);
  const [evaluations, setEvaluations] = useState<{ target: string; identity: string; reason: string }[]>([]);
  const [submitted, setSubmitted] = useState(false);

  if (!markingTurn) {
    return (
      <div className="bg-gray-800 rounded-xl p-5 text-center">
        <div className="text-gray-500">等待标记阶段开始...</div>
      </div>
    );
  }

  if (!markingTurn.yourTurn) {
    const currentPlayer = players.find(p => p.userId === markingTurn.currentPlayer);
    const rp = room.players.find(p => p.userId === markingTurn.currentPlayer);
    return (
      <div className="bg-gray-800 rounded-xl p-5 text-center">
        <div className="text-indigo-300 text-lg mb-2">标记发言中</div>
        <div className="text-gray-400">
          {currentPlayer?.seatNumber}号 {rp?.nickname || '???'} 正在标记...
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="bg-gray-800 rounded-xl p-5 text-center">
        <div className="text-green-400 text-lg">标记已提交</div>
        <div className="text-gray-500 text-sm mt-1">等待其他玩家...</div>
      </div>
    );
  }

  const availableTargets = players.filter(p => p.alive && p.userId !== myUserId);
  const evalCount = markingTurn.evaluationMarkCount;

  const addEvaluation = () => {
    if (evaluations.length >= evalCount) return;
    setEvaluations([...evaluations, { target: '', identity: '', reason: COMMON_REASONS.INTUITION }]);
  };

  const updateEvaluation = (index: number, field: string, value: string) => {
    const updated = [...evaluations];
    (updated[index] as Record<string, string>)[field] = value;
    setEvaluations(updated);
  };

  const removeEvaluation = (index: number) => {
    setEvaluations(evaluations.filter((_, i) => i !== index));
  };

  // 可用的专属理由
  const canUseInvestigation = selfIdentity === '预言家' || selfIdentity === '守墓人';
  const canUsePotionResult = selfIdentity === '女巫';

  const getAvailableReasons = (): string[] => {
    const reasons: string[] = Object.entries(COMMON_REASONS).map(([_, v]) => v);
    if (canUseInvestigation) reasons.push(SPECIAL_REASONS.INVESTIGATION);
    if (canUsePotionResult) reasons.push(SPECIAL_REASONS.POTION_RESULT);
    return reasons;
  };

  const handleSubmit = () => {
    if (!socket || !selfIdentity || evaluations.length < evalCount) return;
    if (evaluations.some(e => !e.target || !e.identity)) return;

    socket.emit('client:submitMarks', {
      identityMark: { identity: selfIdentity, reason: selfReason as MarkReason },
      evaluationMarks: evaluations.map(e => ({
        target: e.target,
        identity: e.identity,
        reason: e.reason as MarkReason,
      })),
    });
    setSubmitted(true);
  };

  const getPlayerName = (userId: string) => {
    const p = players.find(pl => pl.userId === userId);
    const rp = room.players.find(rpl => rpl.userId === userId);
    return `${p?.seatNumber || '?'}号 ${rp?.nickname || '???'}`;
  };

  const isComplete = selfIdentity && evaluations.length === evalCount && evaluations.every(e => e.target && e.identity);

  return (
    <div className="bg-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-green-400 font-bold">你的标记</h3>
        <span className="text-gray-500 text-sm">{markingTurn.timeout}s</span>
      </div>

      {/* 身份声明 */}
      <div>
        <label className="text-sm text-gray-400 mb-2 block">身份声明（必选）</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {markingTurn.availableIdentities.map(id => (
            <button
              key={id}
              onClick={() => setSelfIdentity(id)}
              className={`px-3 py-1.5 rounded-lg text-sm transition ${
                selfIdentity === id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
        <select
          value={selfReason}
          onChange={e => setSelfReason(e.target.value)}
          className="w-full bg-gray-700 text-gray-300 rounded-lg px-3 py-2 text-sm"
        >
          {Object.entries(COMMON_REASONS).map(([_, v]) => (
            <option key={v} value={v}>{REASON_LABELS[v]}</option>
          ))}
        </select>
      </div>

      {/* 评价标记 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm text-gray-400">评价标记（需 {evalCount} 个）</label>
          {evaluations.length < evalCount && (
            <button onClick={addEvaluation} className="text-xs text-indigo-400 hover:text-indigo-300">
              + 添加评价
            </button>
          )}
        </div>
        <div className="space-y-3">
          {evaluations.map((ev, i) => (
            <div key={i} className="bg-gray-900/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">评价 {i + 1}</span>
                <button onClick={() => removeEvaluation(i)} className="text-xs text-red-400 hover:text-red-300">删除</button>
              </div>
              {/* 目标 */}
              <select
                value={ev.target}
                onChange={e => updateEvaluation(i, 'target', e.target.value)}
                className="w-full bg-gray-700 text-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">选择目标</option>
                {availableTargets.map(t => (
                  <option key={t.userId} value={t.userId}>{getPlayerName(t.userId)}</option>
                ))}
              </select>
              {/* 身份评价 */}
              <div className="flex flex-wrap gap-1">
                {[...markingTurn.availableIdentities, '狼人'].map(id => (
                  <button
                    key={id}
                    onClick={() => updateEvaluation(i, 'identity', id)}
                    className={`px-2 py-1 rounded text-xs transition ${
                      ev.identity === id
                        ? id === '狼人' ? 'bg-red-600 text-white' : 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                  >
                    {id}
                  </button>
                ))}
              </div>
              {/* 理由 */}
              <select
                value={ev.reason}
                onChange={e => updateEvaluation(i, 'reason', e.target.value)}
                className="w-full bg-gray-700 text-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                {getAvailableReasons().map(r => (
                  <option key={r} value={r}>{REASON_LABELS[r] || r}</option>
                ))}
              </select>
            </div>
          ))}
          {evaluations.length < evalCount && (
            <button
              onClick={addEvaluation}
              className="w-full border border-dashed border-gray-600 rounded-lg py-3 text-gray-500 text-sm hover:border-gray-500 hover:text-gray-400 transition"
            >
              + 添加评价标记 ({evaluations.length}/{evalCount})
            </button>
          )}
        </div>
      </div>

      {/* 提交 */}
      <button
        onClick={handleSubmit}
        disabled={!isComplete}
        className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 rounded-lg transition"
      >
        提交标记
      </button>
    </div>
  );
}
