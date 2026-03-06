import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from '@shared/types/room';
import { useGameStore } from '../stores/gameStore';
import { PHASES } from '@shared/constants';
import PlayerRing from './PlayerRing';
import InfoPanel from './InfoPanel';
import NightActionPanel from './NightActionPanel';
import MarkingPanel from './MarkingPanel';
import VotingPanel from './VotingPanel';
import GameOverPanel from './GameOverPanel';
import TriggerPanel from './TriggerPanel';
import PhaseHeader from './PhaseHeader';
import EventToast, { type EventToastData } from '../components/EventToast';

const ROLE_LABELS: Record<string, string> = {
  werewolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人',
  guard: '守卫', villager: '平民', gravedigger: '守墓人',
  fool: '白痴', knight: '骑士', wolfKing: '白狼王',
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  werewolf: '每晚可以选择袭击一名玩家',
  wolfKing: '狼人阵营，被放逐时可带走一名玩家',
  seer: '每晚可以查验一名玩家的阵营',
  witch: '拥有一瓶解药和一瓶毒药，各限用一次',
  hunter: '死亡时（非毒杀）可以开枪带走一名玩家',
  guard: '每晚可以守护一名玩家，不能连续守同一人',
  gravedigger: '每晚可以查验一名已死亡玩家的身份',
  knight: '白天可以发起决斗，与目标同归于尽；若目标是狼人则仅狼人死亡',
  fool: '首次被投票放逐时免疫死亡，但之后失去投票权',
  villager: '没有特殊技能，依靠分析和投票推动游戏',
};

interface Props {
  room: Room;
}

function playerLabel(userId: string, players: { userId: string; nickname: string; seatNumber: number }[]): string {
  const p = players.find(x => x.userId === userId);
  return p ? `${p.seatNumber}号·${p.nickname}` : userId;
}

export default function GameView({ room }: Props) {
  const phase = useGameStore(s => s.phase);
  const gameOverData = useGameStore(s => s.gameOverData);
  const announcements = useGameStore(s => s.announcements);
  const votingResult = useGameStore(s => s.votingResult);
  const marks = useGameStore(s => s.marks);
  const players = useGameStore(s => s.players);
  const [toasts, setToasts] = useState<EventToastData[]>([]);
  const [showRules, setShowRules] = useState(false);

  // 追踪已处理的事件，避免重复弹窗
  const processedRef = useRef<Set<string>>(new Set());

  const addToast = useCallback((toast: EventToastData) => {
    if (processedRef.current.has(toast.id)) return;
    processedRef.current.add(toast.id);
    setToasts(prev => [...prev, toast]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // 白天公告弹窗
  useEffect(() => {
    if (announcements.length === 0) return;
    const latest = announcements[announcements.length - 1];
    const toastId = `announce-${announcements.length}`;

    if (latest.peacefulNight) {
      addToast({
        id: toastId,
        title: '天亮了',
        type: 'peace',
        content: <span>昨夜是平安夜，无人死亡</span>,
      });
    } else {
      const title = latest.type === 'exile' ? '投票结果' : '天亮了';
      addToast({
        id: toastId,
        title,
        type: 'death',
        content: (
          <div className="space-y-1">
            {latest.deaths.map(d => (
              <div key={d.userId}>
                <span className="text-red-400 font-bold">{d.seatNumber}号位</span>
                <span className="ml-1">
                  {latest.type === 'exile' ? '被放逐' : '昨夜出局'}
                </span>
                {d.relics.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {d.relics.map((r, i) => (
                      <span key={i} className="text-xs bg-purple-500/30 text-purple-300 px-1.5 py-0.5 rounded">
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
        ),
      });
    }
  }, [announcements.length, addToast]);

  // 投票结果弹窗
  useEffect(() => {
    if (!votingResult) return;
    const toastId = `vote-${Date.now()}`;

    if (votingResult.tie) {
      addToast({
        id: toastId,
        title: '投票结果',
        type: 'vote',
        content: (
          <div>
            <div className="text-yellow-400 font-bold mb-2">平票！无人出局</div>
            <div className="space-y-0.5">
              {votingResult.votes.map((v, i) => (
                <div key={i} className="text-xs text-gray-400">
                  {playerLabel(v.voter, players)} → {playerLabel(v.target, players)}
                </div>
              ))}
            </div>
          </div>
        ),
      });
    } else if (votingResult.exiled) {
      addToast({
        id: toastId,
        title: '投票结果',
        type: 'vote',
        content: (
          <div>
            <div className="text-red-400 font-bold mb-2">
              {playerLabel(votingResult.exiled, players)} 被放逐
            </div>
            <div className="space-y-0.5">
              {votingResult.votes.map((v, i) => (
                <div key={i} className="text-xs text-gray-400">
                  {playerLabel(v.voter, players)} → {playerLabel(v.target, players)}
                </div>
              ))}
            </div>
          </div>
        ),
      });
    }
  }, [votingResult, addToast, players]);

  // 标记公布弹窗
  useEffect(() => {
    if (marks.length === 0) return;
    const latest = marks[marks.length - 1];
    const toastId = `mark-${marks.length}`;

    const markerLabel = playerLabel(latest.player, players);
    addToast({
      id: toastId,
      title: '标记公布',
      type: 'mark',
      content: (
        <div>
          <div className="text-indigo-300 font-bold mb-1">{markerLabel}</div>
          <div className="text-sm text-gray-300 mb-1">
            声明身份：<span className="text-white font-medium">{latest.identityMark.identity}</span>
          </div>
          {latest.evaluationMarks.length > 0 && (
            <div className="space-y-0.5">
              {latest.evaluationMarks.map((e, i) => (
                <div key={i} className="text-xs text-gray-400">
                  认为 {playerLabel(e.target, players)} 是
                  <span className={e.identity === '好人' ? ' text-green-400' : ' text-red-400'}> {e.identity}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ),
    });
  }, [marks.length, addToast, players, marks]);

  if (gameOverData) {
    return <GameOverPanel room={room} data={gameOverData} />;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-900 overflow-hidden">
      {/* 事件弹窗 */}
      <EventToast events={toasts} onDismiss={dismissToast} />

      {/* 规则说明弹窗 */}
      {showRules && <RulesModal room={room} onClose={() => setShowRules(false)} />}

      {/* 阶段标题 + 规则按钮 */}
      <div className="relative">
        <PhaseHeader />
        <button
          onClick={() => setShowRules(true)}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-gray-700/80 text-gray-400 hover:text-white hover:bg-gray-600 transition text-sm"
          title="规则说明"
        >
          ?
        </button>
      </div>

      {/* 玩家圆桌 */}
      <div className="flex-shrink-0 px-4 pt-2">
        <PlayerRing room={room} />
      </div>

      {/* 操作区 */}
      <div className="flex-shrink-0 px-4 pt-3">
        {phase === PHASES.NIGHT && <NightActionPanel />}
        {phase === PHASES.DAY_ANNOUNCEMENT && <DayAnnouncement />}
        {phase === PHASES.DAY_KNIGHT && <TriggerPanel room={room} />}
        {phase === PHASES.DAY_MARKING && <MarkingPanel room={room} />}
        {phase === PHASES.DAY_VOTING && <VotingPanel room={room} />}
        {phase === PHASES.DAY_TRIGGER && <TriggerPanel room={room} />}
        {!phase && <WaitingMessage text="等待游戏数据..." />}
      </div>

      {/* 信息面板（日志区域）— 占据剩余空间，内部滚动 */}
      <div className="flex-1 min-h-0 px-4 py-3">
        <InfoPanel />
      </div>
    </div>
  );
}

function DayAnnouncement() {
  const announcements = useGameStore(s => s.announcements);
  const latest = announcements[announcements.length - 1];

  if (!latest) return <WaitingMessage text="等待公告..." />;

  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <h3 className="text-yellow-400 font-bold mb-3">天亮了</h3>
      {latest.peacefulNight ? (
        <p className="text-gray-300">昨夜是平安夜，无人死亡。</p>
      ) : (
        <div className="space-y-2">
          {latest.deaths.map((d) => (
            <div key={d.userId}>
              <div className="flex items-center gap-2">
                <span className="text-red-400 font-bold">{d.seatNumber} 号位</span>
                <span className="text-gray-400">昨夜出局</span>
              </div>
              {d.relics.length > 0 && (
                <div className="flex gap-1 ml-2 mt-1">
                  {d.relics.map((r, i) => (
                    <span key={i} className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
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
  );
}

function WaitingMessage({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-32">
      <div className="text-gray-500 text-lg">{text}</div>
    </div>
  );
}

function RulesModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const roles = room.settings.roles;
  const winCondition = room.settings.winCondition;

  const wolfCount = Object.entries(roles)
    .filter(([role]) => role === 'werewolf' || role === 'wolfKing')
    .reduce((sum, [_, count]) => sum + count, 0);
  const totalCount = Object.values(roles).reduce((sum, count) => sum + count, 0);
  const goodCount = totalCount - wolfCount;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gray-800 rounded-2xl w-full max-w-md max-h-[85vh] overflow-y-auto shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-gray-800 border-b border-gray-700 px-5 py-4 flex items-center justify-between rounded-t-2xl">
          <h2 className="text-lg font-bold text-white">规则说明</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>

        <div className="p-5 space-y-5">
          {/* 胜利条件 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">胜利条件</h3>
            <div className={`rounded-lg p-3 border ${
              winCondition === 'edge'
                ? 'bg-red-500/10 border-red-500/30'
                : 'bg-orange-500/10 border-orange-500/30'
            }`}>
              <div className={`font-bold text-sm mb-1 ${
                winCondition === 'edge' ? 'text-red-300' : 'text-orange-300'
              }`}>
                {winCondition === 'edge' ? '屠边模式' : '屠城模式'}
              </div>
              <div className="text-xs text-gray-400">
                {winCondition === 'edge' ? (
                  <>
                    <div>好人阵营：投票放逐所有狼人即可获胜</div>
                    <div>狼人阵营：杀光所有<span className="text-red-300">神职</span>或杀光所有<span className="text-red-300">平民</span>即可获胜</div>
                  </>
                ) : (
                  <>
                    <div>好人阵营：投票放逐所有狼人即可获胜</div>
                    <div>狼人阵营：杀光<span className="text-red-300">所有好人</span>（神职+平民）即可获胜</div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 角色配置 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">
              角色配置
              <span className="ml-2 text-xs font-normal text-gray-500">
                共 {totalCount} 人（{wolfCount} 狼 / {goodCount} 好人）
              </span>
            </h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {Object.entries(roles)
                .filter(([_, count]) => count > 0)
                .map(([role, count]) => (
                  <span
                    key={role}
                    className={`px-3 py-1 rounded-full text-xs font-medium ${
                      role === 'werewolf' || role === 'wolfKing'
                        ? 'bg-red-500/20 text-red-300'
                        : 'bg-blue-500/20 text-blue-300'
                    }`}
                  >
                    {ROLE_LABELS[role] || role} ×{count}
                  </span>
                ))}
            </div>
          </div>

          {/* 角色技能说明 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">角色技能</h3>
            <div className="space-y-2">
              {Object.entries(roles)
                .filter(([_, count]) => count > 0)
                .map(([role]) => (
                  <div key={role} className="bg-gray-900/50 rounded-lg px-3 py-2.5">
                    <div className={`text-sm font-medium mb-0.5 ${
                      role === 'werewolf' || role === 'wolfKing' ? 'text-red-300' : 'text-blue-300'
                    }`}>
                      {ROLE_LABELS[role] || role}
                    </div>
                    <div className="text-xs text-gray-400">
                      {ROLE_DESCRIPTIONS[role] || '暂无说明'}
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* 游戏流程 */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">游戏流程</h3>
            <div className="text-xs text-gray-400 space-y-1.5">
              <div className="flex items-start gap-2">
                <span className="bg-indigo-500/20 text-indigo-300 px-1.5 py-0.5 rounded shrink-0">夜晚</span>
                <span>狼人选择袭击目标，神职按顺序依次行动</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="bg-yellow-500/20 text-yellow-300 px-1.5 py-0.5 rounded shrink-0">公告</span>
                <span>公布昨夜结果，死亡玩家掉落遗物</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="bg-green-500/20 text-green-300 px-1.5 py-0.5 rounded shrink-0">标记</span>
                <span>存活玩家轮流发言并标记其他玩家身份</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded shrink-0">投票</span>
                <span>所有存活玩家投票放逐一名可疑玩家</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
