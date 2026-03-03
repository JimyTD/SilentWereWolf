import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ClientToServerEvents, ServerToClientEvents } from '../shared/types/socket';
import { registerSocketHandlers } from './socket/handlers';
import { RoomManager } from './rooms/RoomManager';
import { startRoomCleanup } from './rooms/cleanup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);

const isProduction = process.env.NODE_ENV === 'production';
const PORT = parseInt(process.env.PORT || '3000', 10);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: isProduction
    ? undefined
    : {
        origin: ['http://localhost:5173'],
        methods: ['GET', 'POST'],
      },
  pingTimeout: 30000,
  pingInterval: 10000,
});

const roomManager = new RoomManager();

// 启动房间空闲清理定时器
startRoomCleanup(roomManager);

// 生产环境托管前端静态文件
if (isProduction) {
  const clientDist = path.resolve(__dirname, '../client/dist');
  app.use(express.static(clientDist));
  // SPA 回退：所有非 API/socket 请求返回 index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

io.on('connection', (socket) => {
  const userId = socket.handshake.auth.userId as string;
  const nickname = socket.handshake.auth.nickname as string;

  if (!userId) {
    socket.disconnect(true);
    return;
  }

  console.log(`[连接] ${nickname || '未知'}(${userId}) 已连接, socketId=${socket.id}`);

  registerSocketHandlers(io, socket, roomManager, userId, nickname);
});

httpServer.listen(PORT, () => {
  console.log(`[服务器] 静夜标记服务器运行在 http://localhost:${PORT}`);
});
