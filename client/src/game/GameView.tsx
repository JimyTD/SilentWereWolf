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
    <div className="min-h-screen min-h-[100dvh] flex flex-col bg-gray-900">
      {/* 事件弹窗 */}
      <EventToast events={toasts} onDismiss={dismissToast} />

      {/* 阶段标题 — 固定在顶部 */}
      <div className="sticky top-0 z-20">
        <PhaseHeader />
      </div>

      {/* 可滚动的主内容区 */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {/* 玩家圆桌 */}
        <div className="px-3 sm:px-4 pt-2">
          <PlayerRing room={room} />
        </div>

        {/* 操作区 */}
        <div className="px-3 sm:px-4 pt-2 sm:pt-3">
          {phase === PHASES.NIGHT && <NightActionPanel />}
          {phase === PHASES.DAY_ANNOUNCEMENT && <DayAnnouncement />}
          {phase === PHASES.DAY_KNIGHT && <TriggerPanel room={room} />}
          {phase === PHASES.DAY_MARKING && <MarkingPanel room={room} />}
          {phase === PHASES.DAY_VOTING && <VotingPanel room={room} />}
          {phase === PHASES.DAY_TRIGGER && <TriggerPanel room={room} />}
          {!phase && <WaitingMessage text="等待游戏数据..." />}
        </div>

        {/* 信息面板（日志区域） */}
        <div className="px-3 sm:px-4 py-2 sm:py-3">
          <InfoPanel />
        </div>
      </div>
    </div>
  );
}

function DayAnnouncement() {
  const announcements = useGameStore(s => s.announcements);
  const latest = announcements[announcements.length - 1];

  if (!latest) return <WaitingMessage text="等待公告..." />;

  return (
    <div className="bg-gray-800 rounded-xl p-4 sm:p-5">
      <h3 className="text-yellow-400 font-bold mb-2 sm:mb-3">天亮了</h3>
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


