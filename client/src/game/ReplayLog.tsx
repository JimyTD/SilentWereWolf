import type { GameOverData } from '@shared/types/socket';
import type { NightActions, DeathRecord, PlayerMarks, VoteRecord, PlayerItem } from '@shared/types/game';

interface Props {
  data: GameOverData;
  onClose: () => void;
}

const ROLE_LABELS: Record<string, string> = {
  werewolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人',
  guard: '守卫', villager: '平民', gravedigger: '守墓人',
  fool: '白痴', knight: '骑士', wolfKing: '白狼王',
};

const DEATH_CAUSE_LABELS: Record<string, string> = {
  attacked: '被狼人袭击',
  poisoned: '被女巫毒杀',
  exiled: '被投票放逐',
  shot: '被猎人射杀',
  wolfKingDrag: '被白狼王带走',
  duel: '骑士决斗出局',
  guardWitchClash: '守卫女巫同守致死',
};

const REASON_LABELS: Record<string, string> = {
  intuition: '直觉判断',
  vote_analysis: '投票分析',
  mark_analysis: '标记分析',
  log_reasoning: '日志推理',
  investigation: '查验结论',
  potion_result: '用药结果',
};

const ITEM_LABELS: Record<string, string> = {
  moonstone: '月光石',
  balance: '天平徽章',
  houndWhistle: '猎犬哨',
};

type PlayerInfo = GameOverData['players'][number];

export default function ReplayLog({ data, onClose }: Props) {
  const totalRounds = Math.max(
    data.history.rounds.length,
    data.history.votes.length,
  );

  const pLabel = (userId: string) => {
    const p = data.players.find(x => x.userId === userId);
    return p ? `${p.seatNumber}号·${p.nickname}` : userId;
  };

  const pRole = (userId: string) => {
    const p = data.players.find(x => x.userId === userId);
    return p ? ROLE_LABELS[p.role] || p.role : '';
  };

  const pFaction = (userId: string) => {
    const p = data.players.find(x => x.userId === userId);
    return p?.faction;
  };

  const formatItemValue = (item: PlayerItem) => {
    if (item.type === 'moonstone') return `被造访 ${item.value} 次`;
    if (item.type === 'balance') return item.value === 'balanced' ? '左右邻座同阵营' : '左右邻座不同阵营';
    if (item.type === 'houndWhistle') return `场上存活 ${item.value} 只狼`;
    return String(item.value);
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-900 overflow-y-auto">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 bg-gray-900/95 backdrop-blur border-b border-gray-700 px-4 py-3 flex items-center justify-between">
        <h1 className="text-lg font-bold text-white">复盘日志</h1>
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition text-sm font-medium"
        >
          返回
        </button>
      </div>

      <div className="max-w-2xl mx-auto p-4 space-y-6">
        {/* 身份总览 */}
        <Section title="身份总览">
          <div className="grid grid-cols-2 gap-2">
            {data.players
              .sort((a, b) => a.seatNumber - b.seatNumber)
              .map(p => (
                <div key={p.userId} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/60">
                  <span className="w-6 h-6 flex items-center justify-center bg-gray-600 rounded-full text-xs font-bold text-gray-300 flex-shrink-0">
                    {p.seatNumber}
                  </span>
                  <span className="text-sm text-gray-200 truncate">{p.nickname}</span>
                  <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${
                    p.faction === 'evil' ? 'bg-red-500/20 text-red-300' : 'bg-blue-500/20 text-blue-300'
                  }`}>
                    {ROLE_LABELS[p.role] || p.role}
                  </span>
                </div>
              ))}
          </div>
        </Section>

        {/* 遗物总览 */}
        <Section title="遗物总览">
          <div className="space-y-1.5">
            {data.players
              .sort((a, b) => a.seatNumber - b.seatNumber)
              .map(p => (
                <div key={p.userId} className="flex items-center gap-2 text-sm">
                  <span className="text-gray-400 w-20 flex-shrink-0">{p.seatNumber}号·{p.nickname}</span>
                  {p.items.length > 0 ? p.items.map((item, i) => (
                    <span key={i} className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                      {ITEM_LABELS[item.type] || item.type}：{formatItemValue(item)}
                    </span>
                  )) : (
                    <span className="text-gray-600 text-xs">无遗物</span>
                  )}
                </div>
              ))}
          </div>
        </Section>

        {/* 逐轮复盘 */}
        {Array.from({ length: totalRounds }, (_, i) => i).map(roundIdx => {
          const nightAction = data.history.rounds[roundIdx] as NightActions | undefined;
          const roundMarks = data.history.marks.filter(m => m.round === roundIdx + 1);
          const roundVotes = data.history.votes[roundIdx] || [];
          const roundDeaths = data.history.deaths.filter(d => d.round === roundIdx + 1);

          return (
            <RoundSection
              key={roundIdx}
              round={roundIdx + 1}
              nightAction={nightAction}
              marks={roundMarks}
              votes={roundVotes}
              deaths={roundDeaths}
              players={data.players}
              pLabel={pLabel}
              pRole={pRole}
              pFaction={pFaction}
              formatItemValue={formatItemValue}
            />
          );
        })}

        {/* 结局 */}
        <Section title="结局">
          <div className={`text-center py-4 rounded-xl ${
            data.winner === 'good' ? 'bg-blue-900/20' : 'bg-red-900/20'
          }`}>
            <div className={`text-2xl font-bold mb-1 ${data.winner === 'good' ? 'text-blue-300' : 'text-red-300'}`}>
              {data.winner === 'good' ? '好人阵营获胜' : '狼人阵营获胜'}
            </div>
            <div className="text-sm text-gray-400">
              {data.reason === 'wolves_eliminated' && '所有狼人已被消灭'}
              {data.reason === 'specials_eliminated' && '所有神职已出局（屠边）'}
              {data.reason === 'villagers_eliminated' && '所有平民已出局（屠边）'}
            </div>
          </div>
        </Section>

        {/* 底部留白 */}
        <div className="h-8" />
      </div>
    </div>
  );
}

// ========== 子组件 ==========

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-700/50 border-b border-gray-700">
        <h2 className="text-sm font-bold text-gray-200">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

interface RoundSectionProps {
  round: number;
  nightAction: NightActions | undefined;
  marks: PlayerMarks[];
  votes: VoteRecord[];
  deaths: DeathRecord[];
  players: PlayerInfo[];
  pLabel: (userId: string) => string;
  pRole: (userId: string) => string;
  pFaction: (userId: string) => string | undefined;
  formatItemValue: (item: PlayerItem) => string;
}

function RoundSection({
  round, nightAction, marks, votes, deaths, players, pLabel, pRole, pFaction, formatItemValue,
}: RoundSectionProps) {
  // 按死亡原因分离夜晚死亡和白天死亡
  const nightDeaths = deaths.filter(d => d.cause !== 'exiled');
  const dayDeaths = deaths.filter(d => d.cause === 'exiled');

  return (
    <Section title={`第 ${round} 轮`}>
      <div className="space-y-4">
        {/* 夜晚行动 */}
        {nightAction && (
          <div>
            <h3 className="text-indigo-300 font-semibold text-sm mb-2 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-indigo-400" />
              夜晚行动
            </h3>
            <div className="space-y-1.5 ml-3.5 text-sm">
              {nightAction.guard && nightAction.guard.target && (
                <ActionLine
                  actor="守卫"
                  actorColor="text-blue-300"
                  action="守护了"
                  target={pLabel(nightAction.guard.target)}
                  targetExtra={pRole(nightAction.guard.target)}
                />
              )}
              {nightAction.guard && !nightAction.guard.target && (
                <div className="text-gray-500">守卫：未守护任何人</div>
              )}

              {nightAction.wolves && (
                <div>
                  <ActionLine
                    actor="狼人"
                    actorColor="text-red-300"
                    action={nightAction.wolves.target ? '袭击了' : '空刀（未袭击）'}
                    target={nightAction.wolves.target ? pLabel(nightAction.wolves.target) : ''}
                    targetExtra={nightAction.wolves.target ? pRole(nightAction.wolves.target) : ''}
                  />
                  {nightAction.wolves.votes && Object.keys(nightAction.wolves.votes).length > 1 && (
                    <div className="ml-4 mt-0.5 text-xs text-gray-500">
                      投刀详情：{Object.entries(nightAction.wolves.votes).map(([wolf, target]) => (
                        <span key={wolf} className="mr-2">
                          {pLabel(wolf)} → {target ? pLabel(target) : '弃权'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {nightAction.witch && nightAction.witch.action !== 'none' && (
                <ActionLine
                  actor="女巫"
                  actorColor="text-green-300"
                  action={nightAction.witch.action === 'antidote' ? '使用了解药救了' : '使用了毒药毒了'}
                  target={nightAction.witch.target ? pLabel(nightAction.witch.target) : ''}
                  targetExtra={nightAction.witch.target ? pRole(nightAction.witch.target) : ''}
                />
              )}
              {nightAction.witch && nightAction.witch.action === 'none' && (
                <div className="text-gray-500">女巫：未使用药水</div>
              )}

              {nightAction.seer && nightAction.seer.target && (
                <ActionLine
                  actor="预言家"
                  actorColor="text-yellow-300"
                  action="查验了"
                  target={pLabel(nightAction.seer.target)}
                  targetExtra={`${pRole(nightAction.seer.target)}，${pFaction(nightAction.seer.target) === 'evil' ? '狼人阵营' : '好人阵营'}`}
                />
              )}

              {nightAction.gravedigger && nightAction.gravedigger.target && (
                <ActionLine
                  actor="守墓人"
                  actorColor="text-teal-300"
                  action="验墓了"
                  target={pLabel(nightAction.gravedigger.target)}
                  targetExtra={`${pRole(nightAction.gravedigger.target)}，${pFaction(nightAction.gravedigger.target) === 'evil' ? '狼人阵营' : '好人阵营'}`}
                />
              )}
            </div>
          </div>
        )}

        {/* 夜晚死亡 */}
        {nightDeaths.length > 0 && (
          <div>
            <h3 className="text-yellow-300 font-semibold text-sm mb-2 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-yellow-400" />
              天亮公告
            </h3>
            <div className="space-y-1.5 ml-3.5">
              {nightDeaths.map(d => (
                <DeathLine key={d.userId} death={d} pLabel={pLabel} pRole={pRole} formatItemValue={formatItemValue} />
              ))}
            </div>
          </div>
        )}
        {nightAction && nightDeaths.length === 0 && (
          <div className="ml-3.5 text-sm text-green-400">平安夜，无人死亡</div>
        )}

        {/* 标记 */}
        {marks.length > 0 && (
          <div>
            <h3 className="text-green-300 font-semibold text-sm mb-2 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              标记发言
            </h3>
            <div className="space-y-2 ml-3.5">
              {marks.map((m, i) => (
                <div key={i} className="text-sm border-l-2 border-gray-600 pl-3">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`font-medium ${pFaction(m.player) === 'evil' ? 'text-red-300' : 'text-blue-300'}`}>
                      {pLabel(m.player)}
                    </span>
                    <span className="text-xs text-gray-600">（实际：{pRole(m.player)}）</span>
                  </div>
                  <div className="text-gray-300 text-xs mb-0.5">
                    声明身份：<span className="text-white">{m.identityMark.identity}</span>
                    <span className="text-gray-600 ml-1">（{REASON_LABELS[m.identityMark.reason] || m.identityMark.reason}）</span>
                  </div>
                  {m.evaluationMarks.map((e, j) => (
                    <div key={j} className="text-xs text-gray-400">
                      → 认为 <span className="text-gray-300">{pLabel(e.target)}</span>
                      <span className="text-gray-600">（实际：{pRole(e.target)}）</span>
                      {' '}是{' '}
                      <span className={e.identity === '狼人' ? 'text-red-400' : 'text-blue-400'}>{e.identity}</span>
                      <span className="text-gray-600 ml-1">（{REASON_LABELS[e.reason] || e.reason}）</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 投票 */}
        {votes.length > 0 && (
          <div>
            <h3 className="text-red-300 font-semibold text-sm mb-2 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-400" />
              放逐投票
            </h3>
            <div className="space-y-1 ml-3.5">
              {votes.map((v, i) => (
                <div key={i} className="text-sm flex items-center gap-1.5">
                  <span className={`${pFaction(v.voter) === 'evil' ? 'text-red-300' : 'text-gray-300'}`}>
                    {pLabel(v.voter)}
                  </span>
                  <span className="text-gray-600">→</span>
                  <span className={`${pFaction(v.target) === 'evil' ? 'text-red-300' : 'text-gray-300'}`}>
                    {pLabel(v.target)}
                  </span>
                  <span className="text-xs text-gray-600">
                    （{pRole(v.voter)} 投了 {pRole(v.target)}）
                  </span>
                </div>
              ))}
            </div>
            {dayDeaths.length > 0 && (
              <div className="mt-2 ml-3.5">
                {dayDeaths.map(d => (
                  <DeathLine key={d.userId} death={d} pLabel={pLabel} pRole={pRole} formatItemValue={formatItemValue} />
                ))}
              </div>
            )}
            {dayDeaths.length === 0 && votes.length > 0 && (
              <div className="mt-1 ml-3.5 text-sm text-yellow-400">平票，无人出局</div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function ActionLine({ actor, actorColor, action, target, targetExtra }: {
  actor: string;
  actorColor: string;
  action: string;
  target: string;
  targetExtra?: string;
}) {
  return (
    <div className="text-sm">
      <span className={`font-medium ${actorColor}`}>{actor}</span>
      <span className="text-gray-400"> {action} </span>
      {target && <span className="text-gray-200">{target}</span>}
      {targetExtra && <span className="text-gray-500 text-xs ml-1">（{targetExtra}）</span>}
    </div>
  );
}

function DeathLine({ death, pLabel, pRole, formatItemValue }: {
  death: DeathRecord;
  pLabel: (userId: string) => string;
  pRole: (userId: string) => string;
  formatItemValue: (item: PlayerItem) => string;
}) {
  return (
    <div className="text-sm">
      <span className="text-red-400 font-medium">{pLabel(death.userId)}</span>
      <span className="text-gray-500 text-xs ml-1">（{pRole(death.userId)}）</span>
      <span className="text-gray-400 ml-1">{DEATH_CAUSE_LABELS[death.cause] || death.cause}</span>
      {death.relics.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5 ml-2">
          {death.relics.map((r, i) => (
            <span key={i} className="text-xs bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded">
              {ITEM_LABELS[r.type] || r.type}：{formatItemValue(r)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
