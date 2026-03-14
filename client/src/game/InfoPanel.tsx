import { useState } from 'react';
import { useGameStore } from '../stores/gameStore';
import type { EvaluationMark } from '@shared/types/game';

type Tab = 'announcements' | 'marks' | 'votes' | 'investigations';

const REASON_LABELS: Record<string, string> = {
  intuition: '直觉判断',
  vote_analysis: '投票分析',
  mark_analysis: '标记分析',
  log_reasoning: '日志推理',
  investigation: '查验结论',
  potion_result: '用药结果',
};

function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] || reason;
}

function playerLabel(userId: string, players: { userId: string; nickname: string; seatNumber: number }[]): string {
  const p = players.find(x => x.userId === userId);
  return p ? `${p.seatNumber}号·${p.nickname}` : userId;
}

export default function InfoPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('announcements');
  const announcements = useGameStore(s => s.announcements);
  const marks = useGameStore(s => s.marks);
  const voteHistory = useGameStore(s => s.voteHistory);
  const investigations = useGameStore(s => s.investigations);
  const myRole = useGameStore(s => s.myRole);
  const players = useGameStore(s => s.players);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'announcements', label: '公告' },
    { key: 'marks', label: '标记' },
    { key: 'votes', label: '投票' },
  ];

  // 预言家/守墓人可看查验记录
  if (myRole === 'seer' || myRole === 'gravedigger') {
    tabs.push({ key: 'investigations', label: '查验' });
  }

  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: '40vh', minHeight: '120px' }}>
      {/* Tab 栏 */}
      <div className="flex border-b border-gray-700 flex-shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-2 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium transition ${
              activeTab === tab.key
                ? 'text-indigo-400 border-b-2 border-indigo-400'
                : 'text-gray-400 hover:text-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 内容 */}
      <div className="p-3 sm:p-4 flex-1 overflow-y-auto">
        {activeTab === 'announcements' && (
          <div className="space-y-3">
            {announcements.length === 0 && <p className="text-gray-500 text-sm">暂无公告</p>}
            {announcements.map((a, i) => (
              <div key={i} className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">
                    R{a.round}
                  </span>
                  <span className="text-xs text-gray-500">
                    {a.type === 'night' ? '夜晚结算' : '投票放逐'}
                  </span>
                </div>
                {a.peacefulNight ? (
                  <span className="text-green-400 text-sm">平安夜，无人死亡</span>
                ) : (
                  <div className="space-y-1.5">
                    {a.deaths.map(d => (
                      <div key={d.userId}>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-red-400 font-medium">
                            {playerLabel(d.userId, players)} 出局
                          </span>
                          <span className="text-gray-600 text-xs">
                            {d.cause === 'exiled' ? '(放逐)' : d.cause === 'attacked' ? '(夜杀)' : d.cause === 'poisoned' ? '(毒杀)' : d.cause === 'shot' ? '(猎人射杀)' : d.cause === 'wolfKingDrag' ? '(白狼王带走)' : d.cause === 'duel' ? '(决斗)' : d.cause === 'guardWitchClash' ? '(同守同救)' : `(${d.cause})`}
                          </span>
                        </div>
                        {d.relics.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1 ml-2">
                            {d.relics.map((r, j) => (
                              <span key={j} className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">
                                {r.type === 'moonstone' ? `月光石: ${r.value}`
                                  : r.type === 'balance' ? `天平: ${r.value === 'balanced' ? '平衡' : '失衡'}`
                                  : `${r.type}: ${r.value}`}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'marks' && (
          <div className="space-y-4">
            {marks.length === 0 && <p className="text-gray-500 text-sm">暂无标记记录</p>}
            {marks.map((m, i) => (
              <div key={i} className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
                {/* 标记者与轮次 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">R{m.round}</span>
                  <span className="text-indigo-300 font-medium text-sm">
                    {playerLabel(m.player, players)}
                  </span>
                </div>
                {/* 身份声明 */}
                <div className="text-sm text-gray-300 mb-2 ml-1">
                  声明身份：
                  <span className="text-white font-medium">{m.identityMark.identity}</span>
                </div>
                {/* 评价列表 */}
                <div className="space-y-1 ml-1">
                  {m.evaluationMarks.map((e: EvaluationMark, j: number) => (
                    <div key={j} className="text-sm flex items-center gap-1.5">
                      <span className="text-gray-500">→</span>
                      <span className="text-gray-500">认为</span>
                      <span className="text-gray-300">{playerLabel(e.target, players)}</span>
                      <span className="text-gray-500">是</span>
                      <span className={e.identity === '狼人' ? 'text-red-400 font-medium' : 'text-blue-400 font-medium'}>
                        {e.identity}
                      </span>
                      <span className="text-gray-600 text-xs">（{reasonLabel(e.reason)}）</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'votes' && (
          <div className="space-y-4">
            {voteHistory.length === 0 && <p className="text-gray-500 text-sm">暂无投票记录</p>}
            {voteHistory.map((v, i) => (
              <div key={i} className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">第{i + 1}轮</span>
                  {v.tie ? (
                    <span className="text-yellow-400 text-sm font-medium">平票，无人出局</span>
                  ) : v.exiled ? (
                    <span className="text-red-400 text-sm font-medium">
                      {playerLabel(v.exiled, players)} 被放逐
                    </span>
                  ) : null}
                </div>
                <div className="space-y-1 ml-1">
                  {v.votes.map((vote, j) => (
                    <div key={j} className="text-sm flex items-center gap-1.5">
                      <span className="text-gray-400">{playerLabel(vote.voter, players)}</span>
                      <span className="text-gray-600">→</span>
                      <span className="text-red-300">{playerLabel(vote.target, players)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'investigations' && (
          <div className="space-y-2">
            {investigations.length === 0 && <p className="text-gray-500 text-sm">暂无查验记录</p>}
            {investigations.map((inv, i) => (
              <div key={i} className="text-sm flex items-center gap-2">
                <span className="text-gray-300">目标:</span>
                <span className={inv.faction === 'good' ? 'text-blue-400' : 'text-red-400'}>
                  {inv.faction === 'good' ? '好人' : '狼人'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
