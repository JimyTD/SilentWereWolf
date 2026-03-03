import { useState } from 'react';
import { useGameStore } from '../stores/gameStore';

type Tab = 'announcements' | 'marks' | 'votes' | 'investigations';

export default function InfoPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('announcements');
  const announcements = useGameStore(s => s.announcements);
  const marks = useGameStore(s => s.marks);
  const investigations = useGameStore(s => s.investigations);
  const myRole = useGameStore(s => s.myRole);

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
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      {/* Tab 栏 */}
      <div className="flex border-b border-gray-700">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 px-4 py-2 text-sm font-medium transition ${
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
      <div className="p-4 max-h-48 overflow-y-auto">
        {activeTab === 'announcements' && (
          <div className="space-y-2">
            {announcements.length === 0 && <p className="text-gray-500 text-sm">暂无公告</p>}
            {announcements.map((a, i) => (
              <div key={i} className="text-sm">
                {a.peacefulNight ? (
                  <span className="text-green-400">平安夜</span>
                ) : (
                  a.deaths.map(d => (
                    <div key={d.userId} className="flex items-center gap-2">
                      <span className="text-red-400">{d.seatNumber}号位 出局</span>
                      {d.relics.map((r, j) => (
                        <span key={j} className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">
                          {r.type === 'moonstone' ? `月光石:${r.value}` : `天平:${r.value}`}
                        </span>
                      ))}
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'marks' && (
          <div className="space-y-3">
            {marks.length === 0 && <p className="text-gray-500 text-sm">暂无标记记录</p>}
            {marks.map((m, i) => (
              <div key={i} className="text-sm border-b border-gray-700 pb-2">
                <div className="text-indigo-300 mb-1">
                  R{m.round} · 玩家声明: {m.identityMark.identity}（{m.identityMark.reason}）
                </div>
                {m.evaluationMarks.map((e: { identity: string; reason: string }, j: number) => (
                  <div key={j} className="text-gray-400 ml-3">
                    → 评价: {e.identity}（{e.reason}）
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'votes' && (
          <p className="text-gray-500 text-sm">暂无投票记录</p>
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
