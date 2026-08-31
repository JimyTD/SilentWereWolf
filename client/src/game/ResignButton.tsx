import { useState } from 'react';
import { useGameStore } from '../stores/gameStore';
import { getSocket } from '../hooks/useSocket';

/**
 * 认输退出按钮：游戏进行中显示。
 * 认输后本人视为出局（不触发技能）并释放房间占用，可立即开新局。
 */
export default function ResignButton() {
  const phase = useGameStore(s => s.phase);
  const gameOverData = useGameStore(s => s.gameOverData);
  const reset = useGameStore(s => s.reset);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const socket = getSocket();

  // 游戏未开始或已结束时不显示
  if (!phase || gameOverData) return null;

  const handleResign = () => {
    if (!socket || busy) return;
    setBusy(true);
    socket.emit('client:resignGame', (res) => {
      if (res.success) {
        reset();
        window.location.href = '/';
      } else {
        setBusy(false);
        setConfirming(false);
        alert(res.message || '认输失败，请稍后重试');
      }
    });
  };

  if (confirming) {
    return (
      <div className="flex items-center justify-end gap-2 px-3 sm:px-4 py-2">
        <span className="text-xs text-gray-400">认输将视为出局并离开本局</span>
        <button
          onClick={handleResign}
          disabled={busy}
          className="px-3 py-1.5 bg-red-900/60 hover:bg-red-800 text-red-300 text-xs sm:text-sm font-semibold rounded-lg transition disabled:opacity-50"
        >
          {busy ? '处理中...' : '确认认输'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs sm:text-sm rounded-lg transition disabled:opacity-50"
        >
          取消
        </button>
      </div>
    );
  }

  return (
    <div className="flex justify-end px-3 sm:px-4 py-1">
      <button
        onClick={() => setConfirming(true)}
        className="text-xs text-gray-500 hover:text-gray-300 transition"
      >
        认输退出
      </button>
    </div>
  );
}
