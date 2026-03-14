import { useState } from 'react';
import type { Room } from '@shared/types/room';
import { getSocket } from '../hooks/useSocket';
import { getUserId } from '../utils/userId';
import { useNavigate } from 'react-router-dom';
import { ROLE_LABELS } from '@shared/constants';

interface Props {
  room: Room;
}

export default function WaitingLobby({ room }: Props) {
  const navigate = useNavigate();
  const socket = getSocket();
  const myUserId = getUserId();
  const isHost = room.hostUserId === myUserId;
  const [error, setError] = useState('');
  const [addingAI, setAddingAI] = useState(false);
  const [testingAI, setTestingAI] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const totalNeeded = Object.values(room.settings.roles).reduce((s, c) => s + c, 0);
  const canStart = room.players.length === totalNeeded;
  const canAddAI = room.players.length < totalNeeded;

  const handleStartGame = () => {
    if (!socket) return;
    setError('');
    socket.emit('room:startGame', (res) => {
      if (!res.success) {
        setError(res.message || '开始游戏失败');
      }
    });
  };

  const handleLeave = () => {
    socket?.emit('room:leave');
    navigate('/');
  };

  const handleKick = (targetUserId: string) => {
    socket?.emit('room:kick', { targetUserId });
  };

  const handleAddAI = () => {
    if (!socket || addingAI) return;
    setError('');
    setAddingAI(true);
    socket.emit('room:addAI', (res) => {
      setAddingAI(false);
      if (!res.success) {
        setError(res.message || '添加AI失败');
      }
    });
  };

  const handleTestAI = () => {
    if (!socket || testingAI) return;
    setTestResult(null);
    setTestingAI(true);
    socket.emit('room:testAI', (res) => {
      setTestingAI(false);
      setTestResult({ success: res.success, message: res.message || (res.success ? 'AI 连接正常' : 'AI 连接失败') });
    });
  };

  const handleCopyRoomId = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(room.roomId);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = room.roomId;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* 房间号 */}
        <div className="text-center mb-8">
          <div className="text-gray-400 text-sm mb-1">房间号</div>
          <button
            onClick={handleCopyRoomId}
            className="text-4xl font-bold tracking-[0.3em] text-indigo-400 hover:text-indigo-300 transition"
            title="点击复制"
          >
            {room.roomId}
          </button>
          <div className="text-gray-500 text-xs mt-1">点击复制</div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="bg-red-500/20 border border-red-500/50 text-red-300 px-4 py-2 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}

        {testResult && (
          <div className={`px-4 py-2 rounded-lg mb-4 text-sm border ${
            testResult.success
              ? 'bg-green-500/20 border-green-500/50 text-green-300'
              : 'bg-red-500/20 border-red-500/50 text-red-300'
          }`}>
            {testResult.message}
          </div>
        )}

        {/* 玩家列表 */}
        <div className="bg-gray-800 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-semibold">
              玩家 ({room.players.length}/{totalNeeded})
            </h3>
            {isHost && canAddAI && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleTestAI}
                  disabled={testingAI}
                  className="text-xs bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:cursor-wait text-gray-200 px-3 py-1.5 rounded-lg transition font-medium"
                >
                  {testingAI ? '测试中...' : '测试 AI'}
                </button>
                <button
                  onClick={handleAddAI}
                  disabled={addingAI}
                  className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-600 disabled:cursor-wait text-white px-3 py-1.5 rounded-lg transition font-medium"
                >
                  {addingAI ? '添加中...' : '+ 添加 AI'}
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            {Array.from({ length: totalNeeded }, (_, i) => {
              const player = room.players.find(p => p.seatNumber === i + 1);
              return (
                <div
                  key={i}
                  className={`flex items-center justify-between px-4 py-3 rounded-lg ${
                    player ? 'bg-gray-700/50' : 'bg-gray-900/30 border border-dashed border-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="w-7 h-7 flex items-center justify-center bg-gray-600 rounded-full text-xs font-bold text-gray-300">
                      {i + 1}
                    </span>
                    {player ? (
                      <span className="text-white">
                        {player.nickname}
                        {player.userId === room.hostUserId && (
                          <span className="ml-2 text-xs text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded">房主</span>
                        )}
                        {player.userId === myUserId && (
                          <span className="ml-2 text-xs text-indigo-400 bg-indigo-400/10 px-2 py-0.5 rounded">你</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-500">等待加入...</span>
                    )}
                  </div>
                  {isHost && player && player.userId !== myUserId && (
                    <button
                      onClick={() => handleKick(player.userId)}
                      className="text-xs text-red-400 hover:text-red-300 transition"
                    >
                      踢出
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 角色配置 */}
        <div className="bg-gray-800 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-semibold">角色配置</h3>
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
              room.settings.winCondition === 'edge'
                ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                : 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
            }`}>
              {room.settings.winCondition === 'edge' ? '屠边模式' : '屠城模式'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(room.settings.roles)
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
          <div className="mt-3 text-xs text-gray-500">
            {room.settings.winCondition === 'edge'
              ? '狼人胜利条件：杀光所有神职 或 杀光所有平民'
              : '狼人胜利条件：杀光所有好人（神职+平民）'}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3">
          <button
            onClick={handleLeave}
            className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-300 py-3 rounded-lg transition font-medium"
          >
            离开房间
          </button>
          {isHost && (
            <button
              onClick={handleStartGame}
              disabled={!canStart}
              className={`flex-1 py-3 rounded-lg transition font-semibold ${
                canStart
                  ? 'bg-green-600 hover:bg-green-500 text-white'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              {canStart ? '开始游戏' : `等待玩家 (${room.players.length}/${totalNeeded})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
