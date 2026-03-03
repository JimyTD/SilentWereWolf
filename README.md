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

项目使用 Docker Compose 部署，外部端口 8080。

```bash
docker-compose up -d --build
```

## 目录结构

```
client/    前端（React + Vite）
server/    后端（Express + Socket.IO）
shared/    前后端共享类型与常量
docs/      文档
```
