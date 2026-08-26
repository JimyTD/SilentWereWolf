# 闭嘴狼人杀 (SilentWerewolf)

基于 Web 的在线多人狼人杀游戏，支持异步操作，适合利用碎片时间游玩。

## 技术栈

- 前端：React 18 + Vite + Tailwind CSS + Zustand
- 后端：Node.js + Express + Socket.IO
- 语言：TypeScript（全栈）
- 测试：Vitest

## 快速开始

```bash
# 安装依赖
npm install

# 启动后端
cd server && npx tsx index.ts

# 启动前端（另一个终端）
cd client && npx vite
```

前端默认 `http://localhost:5173`，后端默认 `http://localhost:3000`。

## 部署

生产环境使用 Docker Compose，公网入口为 `8081`，内部应用端口为 `3001`。完整的腾讯云部署、更新、回滚和密钥管理流程请参阅 `docs/operations.md`。

```bash
docker compose up -d --build
```

## 目录结构

```
client/    前端（React + Vite）
server/    后端（Express + Socket.IO）
shared/    前后端共享类型与常量
docs/      文档
```
