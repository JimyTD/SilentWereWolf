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
| `ZHIPU_API_KEY` | AI 功能必需 | 智谱 API 密钥（阶梯链最后一档的兜底 provider） |
| `TOKENHUB_API_KEY` | 否 | 腾讯云 TokenHub（广州站）密钥。配上后 AI 优先走链路上的 TokenHub 档 |
| `LLM_MODEL_CHAIN` | 否 | 覆盖阶梯链顺序（逗号分隔，如 `tokenhub:glm-5.1,zhipu:glm-4-flash-250414`）。留空用代码内置链。**调序不需要改代码、不需要重新构建镜像** |
| `ZHIPU_MODEL` | — | **已弃用**：模型名现在写在阶梯链里，该变量不再参与任何逻辑，保留不会报错但改它无效 |
| `NODE_ENV` | 是 | 生产环境为 `production` |
| `PORT` | 是 | 容器内部固定为 `3001` |

两个 AI 密钥都缺失时，网站和基础游戏可以启动，但 AI 模型调用会失败并使用兜底行为；这不算 AI 功能部署完成。只配 `ZHIPU_API_KEY` 时，AI 只会在链路最后一档（智谱）上工作，等于本次改造前的水平。

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
TOKENHUB_API_KEY=<在服务器安全录入的真实密钥>
# LLM_MODEL_CHAIN=   # 只在需要覆盖链路顺序时填写（逗号分隔，不留空格）
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
| AI 全部走兜底 | 密钥文件路径、权限、`ZHIPU_API_KEY` / `TOKENHUB_API_KEY` 是否注入容器 |
| AI 用上了备用模型 | 应用日志搜 `[LLMLadder]`：链路、各档冷却与降档原因都在那里；调序改 `LLM_MODEL_CHAIN` 即可，不用改代码 |
| 容器反复重启 | 应用日志、生产依赖、Docker 构建结果 |
| 更新后旧版本仍响应 | 容器状态、固定容器名、Compose 项目名 |
| 磁盘不足 | `df -h`、`docker system df`；清理前必须确认 |
| 发布时 `git clone` 报 `GnuTLS recv error` 或连接 `github.com:443` 超时 | 服务器到 `github.com` 的网络问题，改用 `codeload.github.com` 归档发布（见 §11.1） |
| Docker Hub 不可达导致构建失败 | `docker images` 是否已有基础镜像、BuildKit 缓存是否完整；不要为此改 `Dockerfile` 的镜像源 |

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

最近核查时间：2026-09-16（提交 `4685d2b` 更新发布，含胜负判定对齐修复）。

- Docker 与 Compose 可用。
- ⚠️ 服务器当前**无法访问 `github.com:443`**（`GnuTLS recv error` / 连接超时 130s+），但 GitHub 官方归档域名 `codeload.github.com` 可达。
- `8080`、`6099` 由 QQBotForFun 占用，`qqbot-bot-1`、`qqbot-redis-1`、`qqbot-postgres-1`、`qqbot-napcat-1` 均正常运行，本次更新未触碰。
- `8081` 已开放并对外提供服务，由 `silentwerewolf-nginx` 映射 `8081:80`。
- `silentwerewolf-app`、`silentwerewolf-nginx` 容器运行中，应用内部端口 `3001` 未对公网开放。
- 当前运行版本：提交 `4685d2b`，发布目录 `/root/SilentWereWolf_4685d2b`。
- 密钥文件 `/root/silentwerewolf-secrets/silentwerewolf.env` 存在，目录 `700`、文件 `600`，容器内已注入 `ZHIPU_API_KEY`。
- 可回滚版本：`/root/SilentWereWolf_38814a1`（v0.2.2，`git clone` 目录）、`/root/SilentWereWolf_20260903100000`、`/root/SilentWereWolf_20260831142146`、`/root/SilentWereWolf_20260827145231`。
- 磁盘：`/` 约 40G，已用约 21G，可用约 18G（55%）。
- 内存：总计约 1.9G，可用约 937Mi，Swap 已使用约 551Mi；构建期间资源偏紧，需持续观察。
- Docker Build Cache 约 9.4G，其中可回收约 8.2G；清理前必须取得用户确认。
- 更新后验证结论：`http://127.0.0.1:8081/` 与 `http://106.55.228.236:8081/` 均返回 200，前端静态资源可加载，Socket.IO 客户端连接正常，容器内 AI 密钥已注入。

### 11.1 GitHub 不可达时的发布方式（例外流程）

`github.com:443` 不可达时，`git clone` 无法完成。此时可用 GitHub 官方归档域名完成同一目的：

```bash
RELEASE=/root/SilentWereWolf_<commit>
mkdir -p "$RELEASE"
curl -fsSL -o /tmp/sw.tar.gz https://codeload.github.com/JimyTD/SilentWerewolf/tar.gz/<commit>
tar -xzf /tmp/sw.tar.gz -C "$RELEASE" --strip-components=1
echo '<commit>' > "$RELEASE/.release-commit"
cd "$RELEASE" && docker compose -p silentwerewolf config --quiet
docker compose -p silentwerewolf up -d --build
```

注意：

- 归档必须按**commit 号**（不要用 `main`），保证发布内容可追溯。
- 该目录不是 Git 工作区，`git -C <目录> rev-parse HEAD` 不可用；核对版本改用 `cat <目录>/.release-commit`。
- 该目录仍可作为回滚目录使用（见 §8）。
- 仍然禁止 SSH/SCP、禁止把本地文件上传作为常规发布方式。

每次更新前仍需重新执行资源、端口、防火墙和 QQBot 状态检查。
