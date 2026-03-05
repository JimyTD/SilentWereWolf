import { useState } from 'react';
import { PRESETS, ITEMS } from '@shared/constants';
import type { GameSettings, ItemType } from '@shared/types/game';

const PRESET_LABELS: Record<string, string> = {
  '4standard': '4 人标准局',
  '5standard': '5 人标准局',
  '6standard': '6 人标准局',
  '9standard': '9 人标准局',
};

interface Props {
  onClose: () => void;
  onCreate: (settings: GameSettings) => void;
  loading: boolean;
}

export default function CreateRoomModal({ onClose, onCreate, loading }: Props) {
  const [selectedPreset, setSelectedPreset] = useState('4standard');

  const handleCreate = () => {
    const settings: GameSettings = {
      mode: 'preset',
      preset: selectedPreset,
      roles: PRESETS[selectedPreset],
      items: {
        enabled: true,
        pool: [ITEMS.MOONSTONE, ITEMS.BALANCE] as ItemType[],
      },
      lastWords: false,
      deepMode: false,
    };
    onCreate(settings);
  };

  const presetRoles = PRESETS[selectedPreset];
  const totalPlayers = presetRoles
    ? Object.values(presetRoles).reduce((s, c) => s + c, 0)
    : 0;

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

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">创建房间</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-2xl leading-none">&times;</button>
        </div>

        {/* 预设选择 */}
        <div className="mb-6">
          <label className="block text-sm text-gray-400 mb-3">选择模板</label>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(PRESET_LABELS).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSelectedPreset(key)}
                className={`p-3 rounded-lg border text-sm font-medium transition ${
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

        {/* 角色配置预览 */}
        <div className="mb-6 bg-gray-900/50 rounded-lg p-4">
          <div className="text-sm text-gray-400 mb-2">角色配置（共 {totalPlayers} 人）</div>
          <div className="flex flex-wrap gap-2">
            {presetRoles && Object.entries(presetRoles).map(([role, count]) => (
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

        {/* 物品系统 */}
        <div className="mb-6 bg-gray-900/50 rounded-lg p-4">
          <div className="text-sm text-gray-400 mb-1">物品系统</div>
          <div className="text-sm text-gray-300">月光石 + 天平徽章（默认启用）</div>
        </div>

        {/* 创建按钮 */}
        <button
          onClick={handleCreate}
          disabled={loading}
          className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 text-white font-semibold py-3 rounded-lg transition"
        >
          {loading ? '创建中...' : '创建房间'}
        </button>
      </div>
    </div>
  );
}
