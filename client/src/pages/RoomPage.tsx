import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useRoomStore } from '../stores/roomStore';
import { useGameStore } from '../stores/gameStore';
import { useConnectionStore } from '../stores/connectionStore';
import WaitingLobby from '../components/WaitingLobby';
import GameView from '../game/GameView';

const RECONNECT_WAIT_MS = 3000;

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const room = useRoomStore(s => s.room);
  const inGame = useGameStore(s => s.inGame);
  const gameOverData = useGameStore(s => s.gameOverData);
  const connected = useConnectionStore(s => s.connected);
  const [waited, setWaited] = useState(false);

  // 给 socket 重连一点时间恢复房间数据
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), RECONNECT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    // 只有在已连接且等待超时后，如果还是没有房间数据，才跳转首页
    if (waited && connected && !room && !inGame) {
      navigate('/');
    }
  }, [waited, connected, room, inGame, navigate]);

  if (!room) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-400">
          {connected ? '恢复房间数据中...' : '连接服务器中...'}
        </div>
      </div>
    );
  }

  // 游戏中或游戏结束时显示游戏界面
  if (inGame || gameOverData) {
    return <GameView room={room} />;
  }

  // 等候大厅
  return <WaitingLobby room={room} />;
}
