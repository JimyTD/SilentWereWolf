import { useState } from 'react';
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

const ITEM_LABELS: Record<string, string> = {
  moonstone: '月光石',
  balance: '天平徽章',
  houndWhistle: '猎犬哨',
};

export default function PhaseHeader() {
  const phase = useGameStore(s => s.phase);
  const round = useGameStore(s => s.round);
  const myRole = useGameStore(s => s.myRole);
  const myFaction = useGameStore(s => s.myFaction);
  const myItems = useGameStore(s => s.myItems);
  const [showHelp, setShowHelp] = useState(false);

  const phaseInfo = phase ? PHASE_LABELS[phase] : null;
  const factionInfo = myFaction ? FACTION_LABELS[myFaction] : null;

  return (
    <>
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
            {myItems.length > 0 && myItems.map((item, i) => (
              <span
                key={i}
                className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300"
                title="存活时只知类型，出局后公开内容"
              >
                {ITEM_LABELS[item] || item}
              </span>
            ))}
            {factionInfo && (
              <span className={`text-xs ${factionInfo.color}`}>
                {factionInfo.text}
              </span>
            )}
            <button
              onClick={() => setShowHelp(true)}
              className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-600/50 hover:bg-gray-500/50 text-gray-300 hover:text-white transition text-sm font-bold"
              title="游戏说明"
            >
              ?
            </button>
          </div>
        </div>
      </div>

      {showHelp && <GameHelpModal onClose={() => setShowHelp(false)} />}
    </>
  );
}

function GameHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="bg-gray-800 rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-gray-700 flex-shrink-0">
          <h2 className="text-lg font-bold text-white">游戏说明</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-700 text-gray-400 hover:text-white transition"
          >
            X
          </button>
        </div>
        <div className="p-5 overflow-y-auto space-y-5 text-sm text-gray-300">
          <section>
            <h3 className="text-white font-semibold mb-2">基本规则</h3>
            <ul className="space-y-1 list-disc list-inside">
              <li>玩家分为<span className="text-blue-300">好人阵营</span>和<span className="text-red-300">狼人阵营</span></li>
              <li>好人目标：找出并放逐所有狼人</li>
              <li>狼人目标：通过屠边（消灭所有神职或所有平民）获胜</li>
              <li>本游戏无自由发言，通过「标记」传递信息</li>
            </ul>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-2">游戏流程</h3>
            <ol className="space-y-1 list-decimal list-inside">
              <li><span className="text-indigo-300">夜晚</span>：各角色按顺序执行技能（守卫 - 狼人 - 女巫 - 预言家 - 守墓人）</li>
              <li><span className="text-yellow-300">天亮了</span>：公布昨夜死亡情况和遗物</li>
              <li><span className="text-green-300">标记发言</span>：按座位顺序，每人声明身份并评价他人</li>
              <li><span className="text-red-300">放逐投票</span>：所有人同时投票，得票最高者被放逐，平票则无人出局</li>
            </ol>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-2">标记系统</h3>
            <ul className="space-y-1 list-disc list-inside">
              <li>每轮必须放置 1 个身份声明（声明自己的身份）</li>
              <li>必须放置 2~4 个评价标记（评价他人身份）</li>
              <li>标记提交后立即公开，后发言的人可参考前面的标记</li>
            </ul>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-2">遗物系统</h3>
            <ul className="space-y-1 list-disc list-inside">
              <li>每位玩家开局随机获得一种随身物品</li>
              <li>存活时只知类型，看不到内容</li>
              <li>出局后物品变为遗物，内容向所有人公开</li>
              <li><span className="text-purple-300">月光石</span>：记录被夜间行动造访的次数（被刀/被查/被守/被用药）</li>
              <li><span className="text-purple-300">天平徽章</span>：左右邻座是否同阵营（平衡=同阵营，失衡=不同阵营）</li>
              <li><span className="text-purple-300">猎犬哨</span>：出局时场上存活的狼人数量</li>
            </ul>
          </section>

          <section>
            <h3 className="text-white font-semibold mb-2">角色说明</h3>
            <div className="space-y-1">
              <div><span className="text-blue-300">预言家</span>：每晚查验一人阵营</div>
              <div><span className="text-blue-300">女巫</span>：持有解药和毒药各一瓶，首夜可自救</div>
              <div><span className="text-blue-300">猎人</span>：出局时可开枪带走一人（被毒死除外）</div>
              <div><span className="text-blue-300">守卫</span>：每晚守护一人，不可连续守同一人</div>
              <div><span className="text-blue-300">守墓人</span>：每晚查验一名已死亡玩家的阵营</div>
              <div><span className="text-blue-300">白痴</span>：被放逐时免疫一次，但失去投票权</div>
              <div><span className="text-blue-300">骑士</span>：白天可发动决斗验人（全局一次）</div>
              <div><span className="text-red-300">狼人</span>：夜晚共同选择袭击目标，同阵营互认</div>
              <div><span className="text-red-300">白狼王</span>：被放逐时可带走一人</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
