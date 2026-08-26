# SilentWerewolf 运维手册

## 1. 文档目的

本文档是 SilentWerewolf 的部署、更新、回滚、密钥管理和故障排查标准流程。

除非另有明确说明，腾讯云操作必须通过 Lighthouse 集成完成，禁止使用 SSH、SCP 或其他绕过流程的远程方式。

## 2. 当前生产架构

```text
公网 :8081
    ↓
silentwerewolf-nginx :80
    ↓  Docker 网络 silentwerewolf-network
silentwerewolf-app :3001
    ↓
Express + Socket.IO + 前端静态文件
```

| 项目 | 当前值 |
|---|---|
| 云服务器 | `106.55.228.236` |
| 实例 ID | `lhins-hwnz7rcz` |
| 地域 | `ap-guangzhou` |
| 系统 | Ubuntu 24.04.4 LTS |
| Docker | 29.4.1 |
| Compose | v5.1.3，命令为 `docker compose` |
| 公网入口 | `http://106.55.228.236:8081` |
| 应用容器 | `silentwerewolf-app` |
| 反向代理容器 | `silentwerewolf-nginx` |
| Docker 网络 | `silentwerewolf-network` |
| 内部应用端口 | `3001` |
| 代码仓库 | `https://github.com/JimyTD/SilentWerewolf.git` |
| 生产分支 | `main` |

服务器上的 QQBotForFun 使用 `8080`、`6099` 和 `qqbot_default` 网络。SilentWerewolf 不得使用这些端口、容器、文件或网络。

## 3. 关键运行约束

- 公网只开放 TCP `8081`。
- 不开放应用内部端口 `3001`。
- 不在宿主机安装或修改 Nginx；反向代理只运行在 `silentwerewolf-nginx` 容器内。
- 不使用 `docker-compose`，统一使用 `docker compose`。
- 更新必须重新构建镜像，不能只执行 `restart`。
- 游戏状态存储在内存中，容器重启或更新会结束正在进行的对局。
- AI 决策日志写入容器内，当前没有持久化卷；容器重建后日志可能丢失。
- 服务器资源有限。清理 Docker 构建缓存前必须先确认，禁止清理 QQBot 数据或容器。

## 4. 密钥管理

### 4.1 使用的环境变量

| 变量 | 是否必需 | 说明 |
|---|---:|---|
| `ZHIPU_API_KEY` | AI 功能必需 | 智谱 API 密钥 |
| `ZHIPU_MODEL` | 否 | 默认 `glm-4-flash` |
| `NODE_ENV` | 是 | 生产环境为 `production` |
| `PORT` | 是 | 容器内部固定为 `3001` |

没有 `ZHIPU_API_KEY` 时，网站和基础游戏可以启动，但 AI 模型调用会失败并使用兜底行为；这不算 AI 功能部署完成。

### 4.2 密钥存放位置

生产密钥存放在发布目录之外：

```text
/root/silentwerewolf-secrets/silentwerewolf.env
```

权限要求：

```text
目录：700
文件：600
```

文件格式示例：

```dotenv
ZHIPU_API_KEY=<在服务器安全录入的真实密钥>
ZHIPU_MODEL=glm-4-flash
```

真实密钥不得：

- 提交到 Git。
- 放进 `Dockerfile` 或镜像构建参数。
- 写进 `docker-compose.yml`。
- 写进 Lighthouse 命令、日志或聊天消息。
- 放进截图、测试输出或错误报告。

仓库的 `docker-compose.yml` 会从上述外部文件读取变量。文件不存在时 Compose 仍可启动，但 AI 功能会降级为兜底逻辑；正式测试前必须确认文件存在且权限正确。

## 5. 本地发布前检查

在推送或部署前，从项目根目录执行：

```powershell
npx tsc --noEmit -p server/tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
npm test -- --run
npm run build
```

必须确认：

- 类型检查通过。
- 测试全部通过。
- 前端构建成功。
- 本次提交已经推送到 `origin/main`。
- 生产端口仍为 `8081`。
- 没有把 `.env`、API 密钥或服务器私有文件加入提交。

## 6. 首次部署流程

### 6.1 Lighthouse 部署前检查

先查询：

1. `ap-guangzhou` 中实例 `lhins-hwnz7rcz` 仍在运行。
2. `8081` 未被服务器进程监听。
3. `8080`、`6099` 仍属于 QQBotForFun，不能触碰。
4. 磁盘、内存和 Docker 空间足以构建镜像。
5. QQBot 容器均正常运行。

推荐检查命令：

```bash
ss -ltnp
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'
df -h /
free -h
docker system df
```

### 6.2 创建服务器密钥文件

在服务器上通过安全方式创建 `/root/silentwerewolf-secrets/silentwerewolf.env`，不要把真实值放进 Lighthouse 命令或聊天内容，然后设置：

```bash
chmod 700 /root/silentwerewolf-secrets
chmod 600 /root/silentwerewolf-secrets/silentwerewolf.env
```

### 6.3 使用 Git 创建发布目录

禁止把本地整个项目通过文件上传作为标准发布方式。使用 Lighthouse 在服务器执行：

```bash
RELEASE=/root/SilentWerewolf_<commit-or-timestamp>
git clone --branch main --depth 1 https://github.com/JimyTD/SilentWerewolf.git "$RELEASE"
cd "$RELEASE"
git rev-parse HEAD
docker compose -p silentwerewolf config --quiet
docker compose -p silentwerewolf up -d --build
```

`RELEASE` 必须是新的目录，不能直接覆盖其他项目，也不能使用 QQBotForFun 的目录。

### 6.4 首次开放防火墙

先查询现有防火墙规则，确认没有 `8081` 规则后，只添加：

```text
Protocol: TCP
Port: 8081
CidrBlock: 0.0.0.0/0
Action: ACCEPT
Description: SilentWerewolf web
```

不要开放 `3001`，不要修改 `22`、`8080`、`6099` 规则。

### 6.5 首次部署验证

```bash
docker compose -p silentwerewolf ps
curl -fsS http://127.0.0.1:8081/ | head -c 200
curl -fsS http://106.55.228.236:8081/ | head -c 200
docker compose -p silentwerewolf logs --tail=100 silentwerewolf
docker ps --filter name=qqbot-bot-1 --filter name=qqbot-napcat-1
```

浏览器验证：

1. 打开 `http://106.55.228.236:8081`。
2. 创建房间。
3. 添加或加入玩家。
4. 开始一局测试。
5. 检查 Socket.IO 实时连接。
6. 检查 AI 是否能行动，且没有 `ZHIPU_API_KEY` 错误。
7. 确认 QQBotForFun 仍可访问。

## 7. 后续更新流程

### 7.1 更新前

- 完成本地发布前检查。
- 确认目标提交已推送到 `main`。
- 记录当前运行目录和当前提交：

```bash
docker inspect silentwerewolf-app --format '{{.Config.Labels}}' 2>/dev/null || true
git -C /root/<current-release> rev-parse HEAD
```

- 确认密钥文件仍在 `/root/silentwerewolf-secrets/`，不要复制到新发布目录。

### 7.2 发布新版本

```bash
RELEASE=/root/SilentWerewolf_<new-commit-or-timestamp>
git clone --branch main --depth 1 https://github.com/JimyTD/SilentWerewolf.git "$RELEASE"
cd "$RELEASE"
git rev-parse HEAD
docker compose -p silentwerewolf config --quiet
docker compose -p silentwerewolf up -d --build
```

Compose 会使用固定的 `silentwerewolf-app`、`silentwerewolf-nginx` 容器名，并替换正在运行的本应用容器；不会加入 `qqbot_default` 网络。

### 7.3 更新后验证

必须重新检查：

```bash
docker compose -p silentwerewolf ps
curl -fsS http://127.0.0.1:8081/
curl -fsS http://106.55.228.236:8081/
docker compose -p silentwerewolf logs --tail=100 silentwerewolf
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Status}}'
```

如果网页、Socket.IO 或 AI 异常，立即停止继续清理旧发布目录，先按回滚流程处理。

## 8. 回滚流程

旧发布目录至少保留最近两个版本。回滚时使用旧目录重新启动：

```bash
cd /root/SilentWerewolf_<previous-release>
docker compose -p silentwerewolf up -d --build
```

回滚后验证网页、实时连接、AI 配置和 QQBot 容器。

禁止使用：

```bash
git clean -fdx
```

因为它可能删除未纳入 Git 的服务器配置。不要删除 `/root/silentwerewolf-secrets/`。

## 9. 日志与故障排查

### 容器状态

```bash
docker compose -p silentwerewolf ps
docker ps -a --filter name=silentwerewolf
```

### 应用日志

```bash
docker compose -p silentwerewolf logs --tail=200 silentwerewolf
```

### Nginx 日志

```bash
docker compose -p silentwerewolf logs --tail=200 nginx
```

### 常见问题

| 现象 | 优先检查 |
|---|---|
| 网页打不开 | `8081` 防火墙、Nginx 容器、端口监听 |
| 网页能开但实时操作失败 | Nginx `/socket.io/` 转发、应用容器日志 |
| AI 全部走兜底 | 密钥文件路径、权限、`ZHIPU_API_KEY` 是否注入容器 |
| 容器反复重启 | 应用日志、生产依赖、Docker 构建结果 |
| 更新后旧版本仍响应 | 容器状态、固定容器名、Compose 项目名 |
| 磁盘不足 | `df -h`、`docker system df`；清理前必须确认 |

## 10. 禁止事项

- 禁止使用 SSH/SCP 代替 Lighthouse。
- 禁止操作 `qqbot-*` 容器、`qqbot_default` 网络和 QQBotForFun 文件。
- 禁止使用 `22`、`8080`、`6099`。
- 禁止把真实 API 密钥提交 Git 或写进命令、日志、镜像。
- 禁止在宿主机安装或修改 Nginx。
- 禁止只 `restart` 不重新构建。
- 禁止删除当前运行版本和最近一个可回滚版本。
- 禁止未经确认清理 Docker Build Cache。
- 禁止把服务器私有配置复制回 Git 仓库。

## 11. 当前部署状态记录

最近核查的服务器状态：

- Docker 与 Compose 可用。
- `8080`、`6099` 已被 QQBotForFun 占用。
- `8081` 当时没有监听服务，防火墙尚未开放。
- 当前尚无 `silentwerewolf-*` 容器。
- GitHub 仓库可从服务器访问。
- 服务器磁盘和内存可以进行一次测试部署，但构建期间仍需观察资源。

正式部署前仍需重新执行资源、端口、防火墙和 QQBot 状态检查。
