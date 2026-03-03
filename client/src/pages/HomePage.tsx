import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getSocket } from '../hooks/useSocket';
import { getNickname, setNickname as saveNickname } from '../utils/userId';
import { useConnectionStore } from '../stores/connectionStore';
import { useRoomStore } from '../stores/roomStore';
import { PRESETS } from '@shared/constants';
import type { GameSettings } from '@shared/types/game';
import CreateRoomModal from '../components/CreateRoomModal';

export default function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const connected = useConnectionStore(s => s.connected);

  const [nickname, setNickname] = useState(getNickname());
  const [roomCode, setRoomCode] = useState('');
  const [error, setError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (searchParams.get('kicked') === '1') {
      setError('你被房主踢出了房间');
    }
  }, [searchParams]);

  const handleJoinRoom = () => {
    if (!nickname.trim() || nickname.trim().length < 2 || nickname.trim().length > 8) {
      setError('昵称长度需在 2-8 个字符之间');
      return;
    }
    if (!roomCode.trim() || roomCode.trim().length !== 6) {
      setError('请输入 6 位房间号');
      return;
    }

    const socket = getSocket();
    if (!socket || !connected) {
      setError('未连接到服务器，请刷新页面');
      return;
    }

    setLoading(true);
    setError('');
    saveNickname(nickname.trim());

    socket.emit('room:join', { roomId: roomCode.trim(), nickname: nickname.trim() }, (res) => {
      setLoading(false);
      if (res.success && res.room) {
        useRoomStore.getState().setRoom(res.room);
        navigate(`/room/${res.room.roomId}`);
      } else {
        setError(res.message || '加入房间失败');
      }
    });
  };

  const handleCreateRoom = (settings: GameSettings) => {
    if (!nickname.trim() || nickname.trim().length < 2 || nickname.trim().length > 8) {
      setError('昵称长度需在 2-8 个字符之间');
      return;
    }

    const socket = getSocket();
    if (!socket || !connected) {
      setError('未连接到服务器，请刷新页面');
      return;
    }

    setLoading(true);
    setError('');
    saveNickname(nickname.trim());

    socket.emit('room:create', { settings }, (res) => {
      setLoading(false);
      if (res.success && res.room) {
        useRoomStore.getState().setRoom(res.room);
        setShowCreateModal(false);
        navigate(`/room/${res.room.roomId}`);
      } else {
        setError(res.message || '创建房间失败');
      }
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* 标题 */}
        <div className="text-center mb-10">
          <h1 className="text-5xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent mb-3">
            静夜标记
          </h1>
          <p className="text-gray-400 text-lg">Silent Mark</p>
          <p className="text-gray-500 text-sm mt-2">无需发言的狼人杀 · 用标记博弈</p>
        </div>

        {/* 连接状态 */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
          <span className="text-sm text-gray-400">
            {connected ? '已连接' : '连接中...'}
          </span>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="bg-red-500/20 border border-red-500/50 text-red-300 px-4 py-3 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}

        {/* 昵称输入 */}
        <div className="mb-6">
          <label className="block text-sm text-gray-400 mb-2">你的昵称</label>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="2-8 个字符"
            maxLength={8}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition"
          />
        </div>

        {/* 操作按钮 */}
        <div className="space-y-4">
          {/* 创建房间 */}
          <button
            onClick={() => setShowCreateModal(true)}
            disabled={!connected || loading}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold py-3 rounded-lg transition"
          >
            创建房间
          </button>

          {/* 分割线 */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-gray-700" />
            <span className="text-gray-500 text-sm">或</span>
            <div className="flex-1 h-px bg-gray-700" />
          </div>

          {/* 加入房间 */}
          <div className="flex gap-3">
            <input
              type="text"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="输入 6 位房间号"
              maxLength={6}
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 transition text-center tracking-widest text-lg"
            />
            <button
              onClick={handleJoinRoom}
              disabled={!connected || loading || roomCode.length !== 6}
              className="bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold px-6 py-3 rounded-lg transition"
            >
              加入
            </button>
          </div>
        </div>

        {/* 版本号 */}
        <div className="text-center mt-10 text-gray-600 text-xs">
          v0.1.0 · MVP
        </div>
      </div>

      {/* 创建房间弹窗 */}
      {showCreateModal && (
        <CreateRoomModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateRoom}
          loading={loading}
        />
      )}
    </div>
  );
}
