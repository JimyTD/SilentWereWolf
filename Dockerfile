# ============ 阶段1: 构建前端 ============
FROM node:20-alpine AS frontend-builder

WORKDIR /build

# 先复制依赖文件，利用 Docker 缓存
COPY package.json package-lock.json* ./
COPY client/package.json ./client/
COPY server/package.json ./server/
COPY shared/package.json ./shared/

RUN npm install --workspace=client --include-workspace-root

# 复制源码
COPY shared/ ./shared/
COPY client/ ./client/
COPY tsconfig.base.json ./

# 构建前端
RUN npx vite build client

# ============ 阶段2: 构建后端运行环境 ============
FROM node:20-alpine AS production

WORKDIR /app

# 复制依赖文件
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# 仅安装 server + shared 的生产依赖
RUN npm install --workspace=server --workspace=shared --include-workspace-root --omit=dev

# 复制后端源码和共享类型
COPY server/ ./server/
COPY shared/ ./shared/
COPY tsconfig.base.json ./

# 从阶段1复制前端构建产物
COPY --from=frontend-builder /build/client/dist ./client/dist

# 服务端口
EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

# 启动后端服务
CMD ["npx", "tsx", "server/index.ts"]
