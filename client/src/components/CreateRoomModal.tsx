import { useState, useMemo } from 'react';
import { PRESETS, ITEMS, ROLES, ROLE_FACTION, FACTIONS, AVAILABLE_ROLES_FOR_CUSTOM, MIN_PLAYERS, MAX_PLAYERS } from '@shared/constants';
import type { GameSettings, ItemType, WinCondition } from '@shared/types/game';

const PRESET_LABELS: Record<string, string> = {
  '4standard': '4 人标准',
  '5standard': '5 人标准',
  '6standard': '6 人标准',
  '6gods': '6 人神职',
  '7standard': '7 人标准',
  '8wolfking': '8 人白狼王',
  '8knight': '8 人骑士',
  '9standard': '9 人标准',
  '9grave': '9 人守墓人',
  '10guard': '10 人守卫',
  '12standard': '12 人标准',
  '12full': '12 人全角色',
};

const ROLE_LABELS: Record<string, string> = {
  werewolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  villager: '平民',
  gravedigger: '守墓人',
  fool: '白痴',
  knight: '骑士',
  wolfKing: '白狼王',
};

interface Props {
  onClose: () => void;
  onCreate: (settings: GameSettings) => void;
  loading: boolean;
}

export default function CreateRoomModal({ onClose, onCreate, loading }: Props) {
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [selectedPreset, setSelectedPreset] = useState('6standard');
  const [customRoles, setCustomRoles] = useState<Record<string, number>>({
    [ROLES.WEREWOLF]: 2,
    [ROLES.SEER]: 1,
    [ROLES.WITCH]: 1,
    [ROLES.VILLAGER]: 2,
  });
  const [winCondition, setWinCondition] = useState<WinCondition>('edge');

  const currentPreset = PRESETS[selectedPreset];
  const currentRoles = mode === 'preset' ? currentPreset.roles : customRoles;
  const totalPlayers = currentRoles
    ? Object.values(currentRoles).reduce((s, c) => s + c, 0)
    : 0;

  const wolfCount = useMemo(() => {
    if (!currentRoles) return 0;
    return (currentRoles[ROLES.WEREWOLF] || 0) + (currentRoles[ROLES.WOLF_KING] || 0);
  }, [currentRoles]);

  const goodCount = totalPlayers - wolfCount;

  const validationError = useMemo(() => {
    if (totalPlayers < MIN_PLAYERS) return `至少需要 ${MIN_PLAYERS} 人`;
    if (totalPlayers > MAX_PLAYERS) return `最多 ${MAX_PLAYERS} 人`;
    if (wolfCount < 1) return '至少需要 1 个狼人';
    if (goodCount <= wolfCount) return '好人数量必须多于狼人';
    return null;
  }, [totalPlayers, wolfCount, goodCount]);

  const handleCreate = () => {
    if (validationError) return;
    const settings: GameSettings = {
      mode,
      preset: mode === 'preset' ? selectedPreset : undefined,
      roles: currentRoles,
      items: {
        enabled: true,
        pool: [ITEMS.MOONSTONE, ITEMS.BALANCE] as ItemType[],
      },
      lastWords: false,
      deepMode: false,
      winCondition,
    };
    onCreate(settings);
  };

  const adjustRole = (role: string, delta: number) => {
    setCustomRoles(prev => {
      const current = prev[role] || 0;
      const next = Math.max(0, current + delta);
      const updated = { ...prev };
      if (next === 0) {
        delete updated[role];
      } else {
        updated[role] = next;
      }
      return updated;
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-2xl w-full max-w-md p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold text-white">创建房间</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>

        {/* 模式切换 */}
        <div className="flex mb-5 bg-gray-900/50 rounded-lg p-1">
          <button
            onClick={() => setMode('preset')}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition ${
              mode === 'preset' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            预设模板
          </button>
          <button
            onClick={() => setMode('custom')}
            className={`flex-1 py-2 text-sm font-medium rounded-md transition ${
              mode === 'custom' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            自定义
          </button>
        </div>

        {mode === 'preset' ? (
          /* 预设选择 */
          <div className="mb-5">
            <label className="block text-sm text-gray-400 mb-3">选择模板</label>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(PRESET_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => {
                    setSelectedPreset(key);
                    setWinCondition(PRESETS[key].winCondition);
                  }}
                  className={`p-2.5 rounded-lg border text-xs font-medium transition ${
                    selectedPreset === key
                      ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300'
                      : 'border-gray-600 bg-gray-700/50 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* 自定义角色配置 */
          <div className="mb-5">
            <label className="block text-sm text-gray-400 mb-3">配置角色</label>
            <div className="space-y-2">
              {AVAILABLE_ROLES_FOR_CUSTOM.map(role => {
                const count = customRoles[role] || 0;
                const isEvil = ROLE_FACTION[role] === FACTIONS.EVIL;
                return (
                  <div
                    key={role}
                    className="flex items-center justify-between bg-gray-900/50 rounded-lg px-4 py-2.5"
                  >
                    <span className={`text-sm font-medium ${isEvil ? 'text-red-300' : 'text-blue-300'}`}>
                      {ROLE_LABELS[role] || role}
                    </span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => adjustRole(role, -1)}
                        disabled={count === 0}
                        className="w-7 h-7 flex items-center justify-center rounded-md bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed transition text-sm font-bold"
                      >
                        -
                      </button>
                      <span className="w-5 text-center text-white text-sm font-semibold">{count}</span>
                      <button
                        onClick={() => adjustRole(role, 1)}
                        className="w-7 h-7 flex items-center justify-center rounded-md bg-gray-700 text-gray-300 hover:bg-gray-600 transition text-sm font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 角色配置预览 */}
        <div className="mb-5 bg-gray-900/50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-400">
              角色配置（共 {totalPlayers} 人）
            </span>
            <span className="text-xs text-gray-500">
              {wolfCount} 狼 / {goodCount} 好人
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {currentRoles && Object.entries(currentRoles)
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

        {/* 校验提示 */}
        {validationError && (
          <div className="mb-4 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
            {validationError}
          </div>
        )}

        {/* 胜利条件 */}
        <div className="mb-5 bg-gray-900/50 rounded-lg p-4">
          <div className="text-sm text-gray-400 mb-3">狼人胜利条件</div>
          <div className="flex gap-2">
            <button
              onClick={() => setWinCondition('edge')}
              className={`flex-1 py-2.5 text-sm font-medium rounded-lg border transition ${
                winCondition === 'edge'
                  ? 'border-red-500 bg-red-500/20 text-red-300'
                  : 'border-gray-600 bg-gray-700/50 text-gray-400 hover:border-gray-500'
              }`}
            >
              <div>屠边</div>
              <div className="text-xs mt-0.5 opacity-70">杀光神职或平民</div>
            </button>
            <button
              onClick={() => setWinCondition('city')}
              className={`flex-1 py-2.5 text-sm font-medium rounded-lg border transition ${
                winCondition === 'city'
                  ? 'border-red-500 bg-red-500/20 text-red-300'
                  : 'border-gray-600 bg-gray-700/50 text-gray-400 hover:border-gray-500'
              }`}
            >
              <div>屠城</div>
              <div className="text-xs mt-0.5 opacity-70">杀光所有好人</div>
            </button>
          </div>
        </div>

        {/* 物品系统 */}
        <div className="mb-5 bg-gray-900/50 rounded-lg p-4">
          <div className="text-sm text-gray-400 mb-1">物品系统</div>
          <div className="text-sm text-gray-300">月光石 + 天平徽章（默认启用）</div>
        </div>

        {/* 创建按钮 */}
        <button
          onClick={handleCreate}
          disabled={loading || !!validationError}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 rounded-lg transition"
        >
          {loading ? '创建中...' : '创建房间'}
        </button>
      </div>
    </div>
  );
}
