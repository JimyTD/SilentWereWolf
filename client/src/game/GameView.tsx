import type { Room } from '@shared/types/room';
import { useGameStore } from '../stores/gameStore';
import { PHASES } from '@shared/constants';
import PlayerRing from './PlayerRing';
import InfoPanel from './InfoPanel';
import NightActionPanel from './NightActionPanel';
import MarkingPanel from './MarkingPanel';
import VotingPanel from './VotingPanel';
import GameOverPanel from './GameOverPanel';
import PhaseHeader from './PhaseHeader';

interface Props {
  room: Room;
}

export default function GameView({ room }: Props) {
  const phase = useGameStore(s => s.phase);
  const gameOverData = useGameStore(s => s.gameOverData);

  if (gameOverData) {
    return <GameOverPanel room={room} data={gameOverData} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-900">
      {/* 阶段标题 */}
      <PhaseHeader />

      {/* 玩家席位环 */}
      <div className="flex-shrink-0 p-4">
        <PlayerRing room={room} />
      </div>

      {/* 信息面板 */}
      <div className="flex-shrink-0 px-4">
        <InfoPanel />
      </div>

      {/* 操作区 */}
      <div className="flex-1 p-4">
        {phase === PHASES.NIGHT && <NightActionPanel />}
        {phase === PHASES.DAY_ANNOUNCEMENT && <DayAnnouncement />}
        {phase === PHASES.DAY_MARKING && <MarkingPanel room={room} />}
        {phase === PHASES.DAY_VOTING && <VotingPanel room={room} />}
        {phase === PHASES.DAY_TRIGGER && <WaitingMessage text="处理特殊事件中..." />}
        {!phase && <WaitingMessage text="等待游戏数据..." />}
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
            <div key={d.userId} className="flex items-center gap-2">
              <span className="text-red-400 font-bold">{d.seatNumber} 号位</span>
              <span className="text-gray-400">昨夜出局</span>
              {d.relics.length > 0 && (
                <div className="flex gap-1 ml-2">
                  {d.relics.map((r, i) => (
                    <span key={i} className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded">
                      {r.type === 'moonstone' ? `月光石: ${r.value}` : `天平: ${r.value}`}
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
