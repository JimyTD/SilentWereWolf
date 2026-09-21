import { useState } from 'react';
import { useGameStore } from '../stores/gameStore';
import type { EvaluationMark, MyPrivateInfo } from '@shared/types/game';
import type { PublicPlayerInfo } from '@shared/types/socket';
import { getPlayerLabel } from './playerLabel';
import { getEvaluationColor, getIdentityColor } from './identityColor';

type Tab = 'announcements' | 'marks' | 'votes' | 'investigations' | 'records';

// 仅用于白天公开事件（放逐、猎人开枪、白狼王、决斗、认输）
const DEATH_CAUSE_LABELS: Record<string, string> = {
  exiled: '放逐',
  shot: '猎人射杀',
  wolfKingDrag: '白狼王带走',
  duel: '决斗',
  resigned: '认输',
};

function deathCauseLabel(cause: string): string {
  return DEATH_CAUSE_LABELS[cause] || cause;
}

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

export default function InfoPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('announcements');
  const announcements = useGameStore(s => s.announcements);
  const marks = useGameStore(s => s.marks);
  const voteHistory = useGameStore(s => s.voteHistory);
  const investigations = useGameStore(s => s.investigations);
  const myRole = useGameStore(s => s.myRole);
  const players = useGameStore(s => s.players);
  const myPrivateInfo = useGameStore(s => s.myPrivateInfo);
  const foolImmunities = useGameStore(s => s.foolImmunities);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'announcements', label: '公告' },
    { key: 'marks', label: '标记' },
    { key: 'votes', label: '投票' },
    { key: 'records', label: '记录' },
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
            {foolImmunities.map(event => (
              <div key={`fool-${event.round}-${event.userId}`} className="border border-blue-500/30 rounded-lg p-3 bg-blue-900/20">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs bg-blue-700/60 text-blue-100 px-1.5 py-0.5 rounded">R{event.round}</span>
                  <span className="text-xs text-blue-300">白痴免疫</span>
                </div>
                <p className="text-sm text-gray-200">
                  {getPlayerLabel(event.userId, players)} 首次被放逐免疫，身份公开为白痴并失去投票权。
                </p>
              </div>
            ))}
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
                            {getPlayerLabel(d.userId, players)} 出局
                          </span>
                          {/* 夜间出局不显示死因，避免泄露女巫用药/守卫守护 */}
                          {a.type === 'exile' && (
                            <span className="text-gray-600 text-xs">
                              ({deathCauseLabel(d.cause)})
                            </span>
                          )}
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
                    {getPlayerLabel(m.player, players)}
                  </span>
                </div>
                {/* 身份声明 */}
                <div className="text-sm text-gray-300 mb-2 ml-1">
                  声明身份：
                  <span className={`${getIdentityColor(m.identityMark.identity)} font-medium`}>{m.identityMark.identity}</span>
                </div>
                {/* 评价列表 */}
                <div className="space-y-1 ml-1">
                  {m.evaluationMarks.map((e: EvaluationMark, j: number) => (
                    <div key={j} className="text-sm flex items-center gap-1.5">
                      <span className="text-gray-500">→</span>
                      <span className="text-gray-500">认为</span>
                      <span className="text-gray-300">{getPlayerLabel(e.target, players)}</span>
                      <span className="text-gray-500">是</span>
                      <span className={`${getEvaluationColor(e.identity)} font-medium`}>
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
                      {getPlayerLabel(v.exiled, players)} 被放逐
                    </span>
                  ) : null}
                </div>
                <div className="space-y-1 ml-1">
                  {v.votes.map((vote, j) => (
                    <div key={j} className="text-sm flex items-center gap-1.5">
                      <span className="text-gray-400">{getPlayerLabel(vote.voter, players)}</span>
                      <span className="text-gray-600">→</span>
                      <span className="text-red-300">{getPlayerLabel(vote.target, players)}</span>
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
                <span className="text-gray-500 text-xs w-5 flex-shrink-0">{i + 1}.</span>
                <span className="text-gray-300">{getPlayerLabel(inv.target, players)}</span>
                <span className="text-gray-600">→</span>
                <span className={inv.faction === 'good' ? 'text-blue-400' : 'text-red-400'}>
                  {inv.faction === 'good' ? '好人' : '狼人'}
                </span>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'records' && (
          <MyRecords info={myPrivateInfo} players={players} />
        )}
      </div>
    </div>
  );
}

interface MyRecordsProps {
  info: MyPrivateInfo | null;
  players: PublicPlayerInfo[];
}

/**
 * 我的记录：展示本人角色的私有资源与操作历史（服务端按角色裁剪后下发）。
 * 这些信息不属于公开信息，只对本人可见。
 */
function MyRecords({ info, players }: MyRecordsProps) {
  if (!info) {
    return <p className="text-gray-500 text-sm">暂无记录</p>;
  }

  const targetLabel = (userId: string | null) =>
    userId ? getPlayerLabel(userId, players) : '未指定';

  const roundTag = (round: number) => (
    <span className="text-xs bg-gray-600 text-gray-300 px-1.5 py-0.5 rounded">R{round}</span>
  );

  const hasAny = Boolean(
    info.witch
    || info.guard
    || info.investigations
    || info.wolfAttacks
    || info.hunterCanShoot !== undefined
    || info.knightDuelUsed !== undefined
    || info.foolImmunityUsed !== undefined,
  );

  if (!hasAny) {
    return <p className="text-gray-500 text-sm">你的角色没有需要记录的私有操作</p>;
  }

  return (
    <div className="space-y-4">
      {/* 女巫：药水剩余与用药历史 */}
      {info.witch && (
        <div className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
          <div className="text-sm text-purple-300 font-medium mb-2">女巫 · 药水</div>
          <div className="flex flex-wrap gap-2 mb-2">
            <span className={`text-xs px-2 py-0.5 rounded ${
              info.witch.antidoteUsed ? 'bg-gray-700 text-gray-500' : 'bg-green-500/20 text-green-300'
            }`}>
              {info.witch.antidoteUsed ? '解药已用完' : '解药未使用'}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded ${
              info.witch.poisonUsed ? 'bg-gray-700 text-gray-500' : 'bg-purple-500/20 text-purple-300'
            }`}>
              {info.witch.poisonUsed ? '毒药已用完' : '毒药未使用'}
            </span>
          </div>
          {info.witch.potionHistory.length === 0 ? (
            <p className="text-gray-500 text-xs">暂无用药记录</p>
          ) : (
            <div className="space-y-1">
              {info.witch.potionHistory.map((p, i) => (
                <div key={i} className="text-sm flex items-center gap-2">
                  {roundTag(p.round)}
                  <span className="text-gray-400">{p.potion === 'antidote' ? '使用解药救' : '使用毒药毒'}</span>
                  <span className="text-gray-200">{targetLabel(p.target)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 守卫：最近守护目标与守护历史 */}
      {info.guard && (
        <div className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
          <div className="text-sm text-blue-300 font-medium mb-2">守卫 · 守护</div>
          <div className="text-sm text-gray-400 mb-2">
            最近守护：<span className="text-gray-200">{targetLabel(info.guard.lastGuardTarget)}</span>
            <span className="text-gray-600 text-xs ml-1">（不可连续守护同一人）</span>
          </div>
          {info.guard.history.length === 0 ? (
            <p className="text-gray-500 text-xs">暂无守护记录</p>
          ) : (
            <div className="space-y-1">
              {info.guard.history.map((g, i) => (
                <div key={i} className="text-sm flex items-center gap-2">
                  {roundTag(g.round)}
                  <span className="text-gray-400">守护</span>
                  <span className="text-gray-200">{targetLabel(g.target)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 狼人 / 白狼王：历轮袭击目标 */}
      {info.wolfAttacks && (
        <div className="border border-gray-700 rounded-lg p-3 bg-gray-800/50">
          <div className="text-sm text-red-300 font-medium mb-2">狼人 · 袭击</div>
          {info.wolfAttacks.length === 0 ? (
            <p className="text-gray-500 text-xs">暂无袭击记录</p>
          ) : (
            <div className="space-y-1">
              {info.wolfAttacks.map((a, i) => (
                <div key={i} className="text-sm flex items-center gap-2">
                  {roundTag(a.round)}
                  <span className="text-gray-400">袭击</span>
                  <span className="text-gray-200">{targetLabel(a.target)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 猎人 / 骑士 / 白痴：技能是否仍可用 */}
      {(info.hunterCanShoot !== undefined
        || info.knightDuelUsed !== undefined
        || info.foolImmunityUsed !== undefined) && (
        <div className="border border-gray-700 rounded-lg p-3 bg-gray-800/50 space-y-1">
          <div className="text-sm text-yellow-300 font-medium mb-1">技能状态</div>
          {info.hunterCanShoot !== undefined && (
            <div className="text-sm text-gray-300">
              猎人：{info.hunterCanShoot ? '仍可开枪' : '已无法开枪'}
            </div>
          )}
          {info.knightDuelUsed !== undefined && (
            <div className="text-sm text-gray-300">
              骑士：{info.knightDuelUsed ? '决斗已发动' : '决斗未发动'}
            </div>
          )}
          {info.foolImmunityUsed !== undefined && (
            <div className="text-sm text-gray-300">
              白痴：{info.foolImmunityUsed ? '免疫已消耗' : '免疫未消耗'}
            </div>
          )}
        </div>
      )}

      {/* 预言家/守墓人的查验历史在「查验」页 */}
      {info.investigations && (
        <p className="text-gray-500 text-xs">查验历史请查看「查验」页</p>
      )}
    </div>
  );
}
