import { useGameStore } from '../stores/gameStore';
import { PHASES } from '@shared/constants';

const PHASE_LABELS: Record<string, { text: string; color: string; bg: string }> = {
  [PHASES.NIGHT]: { text: '夜晚', color: 'text-indigo-300', bg: 'bg-indigo-900/50' },
  [PHASES.DAY_ANNOUNCEMENT]: { text: '天亮了', color: 'text-yellow-300', bg: 'bg-yellow-900/30' },
  [PHASES.DAY_HUNTER]: { text: '猎人开枪', color: 'text-orange-300', bg: 'bg-orange-900/30' },
  [PHASES.DAY_KNIGHT]: { text: '骑士决斗', color: 'text-cyan-300', bg: 'bg-cyan-900/30' },
  [PHASES.DAY_MARKING]: { text: '标记发言', color: 'text-green-300', bg: 'bg-green-900/30' },
  [PHASES.DAY_VOTING]: { text: '放逐投票', color: 'text-red-300', bg: 'bg-red-900/30' },
  [PHASES.DAY_TRIGGER]: { text: '特殊事件', color: 'text-purple-300', bg: 'bg-purple-900/30' },
  [PHASES.GAME_OVER]: { text: '游戏结束', color: 'text-white', bg: 'bg-gray-800' },
};

const ROLE_LABELS: Record<string, string> = {
  werewolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人',
  guard: '守卫', villager: '平民', wolfKing: '白狼王',
};

const FACTION_LABELS: Record<string, { text: string; color: string }> = {
  good: { text: '好人阵营', color: 'text-blue-300' },
  evil: { text: '狼人阵营', color: 'text-red-300' },
};

export default function PhaseHeader() {
  const phase = useGameStore(s => s.phase);
  const round = useGameStore(s => s.round);
  const myRole = useGameStore(s => s.myRole);
  const myFaction = useGameStore(s => s.myFaction);

  const phaseInfo = phase ? PHASE_LABELS[phase] : null;
  const factionInfo = myFaction ? FACTION_LABELS[myFaction] : null;

  return (
    <div className={`p-4 ${phaseInfo?.bg || 'bg-gray-800'}`}>
      <div className="flex items-center justify-between">
        <div>
          <span className={`text-lg font-bold ${phaseInfo?.color || 'text-white'}`}>
            第 {round} 轮 · {phaseInfo?.text || '准备中'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {myRole && (
            <span className={`text-sm font-medium px-3 py-1 rounded-full ${
              myFaction === 'evil' ? 'bg-red-500/20 text-red-300' : 'bg-blue-500/20 text-blue-300'
            }`}>
              {ROLE_LABELS[myRole] || myRole}
            </span>
          )}
          {factionInfo && (
            <span className={`text-xs ${factionInfo.color}`}>
              {factionInfo.text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
