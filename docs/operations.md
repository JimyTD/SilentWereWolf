# SilentWerewolf Production Operations

## Scope and safety boundaries

The production host is `106.55.228.236` (Tencent Cloud Lighthouse instance
`lhins-hwnz7rcz`, `ap-guangzhou`, Ubuntu 24.04). SilentWerewolf uses Docker
Compose project `silentwerewolf`, public port `8081`, internal app port `3001`,
and network `silentwerewolf-network`.

The same host runs QQBotForFun. Never operate its `qqbot-*` containers,
`qqbot_default` network, files, or ports `8080` and `6099`. Never expose port
`3001`. Do not run global Docker cleanup commands on this shared host.

Production secrets remain outside releases at:

```text
/root/silentwerewolf-secrets/silentwerewolf.env
```

The directory must be mode `700`, the file mode `600`, and neither belongs in
Git, the Dockerfile, build arguments, or `docker-compose.yml`.

## AI environment configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `ZHIPU_API_KEY` | Yes for AI | Final Zhipu fallback in the model chain. |
| `TOKENHUB_API_KEY` | Optional | Enables the TokenHub model slots. |
| `LLM_MODEL_CHAIN` | Optional | Comma-separated override for model-slot order. |
| `ZHIPU_MODEL` | No | Deprecated and ignored; model names belong in the chain. |
| `NODE_ENV` | Yes | `production`. |
| `PORT` | Yes | Internal application port `3001`. |

Changing the external secrets file does not require a source release, but it
does require recreating the application containers and therefore interrupts
active games. After preserving a protected backup of the secret file and
confirming the maintenance window, run the checked-in helper from the active
release:

```bash
CURRENT=$(readlink -f /root/silentwerewolf-releases/current)
SILENTWEREWOLF_DEPLOY_ACK=active-games-will-end bash "$CURRENT/scripts/recreate-current-release.sh"
```

The helper takes the deployment lock, validates the active Compose file,
recreates without building, waits for health, and checks `/healthz`. It never
prints secrets.

## Operations channel

Lighthouse integration is permanently retired. Do not use its command, upload,
or firewall tools. Its OAuth credentials can expire and its account-level anchor
can point different workspaces at the wrong server.

Use the named SSH MCP connection `silentwerewolf`, with normal OpenSSH as the
fallback. The connection configuration and private key live outside the
repository:

```text
~/.ssh/silentwerewolf_deploy
~/.ssh-mcp/config.json
~/.ssh-mcp/server/
```

Run `scripts/setup_dev_machine.ps1` on every development machine. See
`docs/dev-machine-setup.md` for the one-time public-key installation and MCP
registration steps.

Tencent Cloud's web terminal is the recovery channel for SSH configuration and
Lighthouse firewall rules. It is independent of `sshd` and must remain usable.

## Application release model

Every release is immutable and identified by a full Git commit SHA:

```text
/root/silentwerewolf-releases/<full-commit-sha>
/root/silentwerewolf-releases/current
/root/silentwerewolf-releases/previous
```

`current` and `previous` are server-side symlinks and are the only authoritative
record of active and rollback releases. Each release records `.release-commit`
and `.release-manifest`. Do not infer the active release from a directory name
or edit a release directory after deployment.

Game rooms are in memory. Any release or rollback ends active games. Confirm no
game may be interrupted before setting the required deployment acknowledgement.

## Release scope and risk tiers

Every source release uses the same immutable-commit, preflight, health-check,
and rollback process below. A "small" change never skips those safeguards:
rebuilding the application still ends active games. The tiers instead define
the expected validation depth and whether the release may be expanded while it
is in progress. Classify by affected boundaries and reversibility, not by line
count.

| Tier | Definition | Required preparation |
| --- | --- | --- |
| Localized | Presentation or isolated implementation change with no shared protocol, room/game state, authorization, persistence, configuration, or deployment impact. | Targeted regression test plus the standard local release gate. |
| Standard | Crosses a client/server contract, shared type, room/game state, or a user workflow. Most product features belong here. | Focused automated coverage for the changed contract and a written smoke-test/cleanup sequence before deployment, plus the standard gate. |
| High risk | Changes authorization, secrets, network exposure, game rules or win conditions, persistence/migration, deployment infrastructure, or rollback behavior. | A short release plan stating user impact, test cases, rollback trigger, and maintenance timing before deployment, plus the standard gate. |

Each release is limited to the user-requested outcome and fixes required to
make that outcome safe and correct. Do not add opportunistic refactors or
unrelated findings to an active release window.

When post-deployment verification finds a problem:

1. Roll back or prepare an immediate hotfix only for a security issue, data
   integrity risk, service availability failure, or a defect that blocks the
   requested outcome for users.
2. Record all other findings as a separate follow-up. Do not create a second
   production release in the same maintenance window without explicit user
   direction.
3. If the release itself is unhealthy, prefer rollback over expanding the
   scope of a hotfix.

## Local release gate

Run these commands from the repository root. The working tree must be clean and
the exact target commit must be pushed before deployment.

```powershell
npx tsc --noEmit -p server/tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
npm test -- --run
npm run build
git status --short
git rev-parse HEAD
git ls-remote origin HEAD
```

The local SHA and `origin/main` SHA must match. Deploying a floating branch is
not permitted.

## Server preflight

Before each deployment, inspect the host through the SSH connection:

```bash
docker compose ls
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
df -h /root
free -h
docker system df
ss -ltnp
```

Abort if port `8081` is unexpectedly occupied, a QQBot container is unhealthy,
or less than 4 GiB is free. Do not clean Docker build cache automatically; the
host is shared and cache cleanup needs explicit user confirmation.

## First migration bootstrap

After the SSH key is installed and verified, run this once through the SSH
connection. It keeps password authentication enabled until the new key has
already been tested from a separate terminal.

```bash
cat >/etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
EOF
sshd -t && systemctl reload ssh
sshd -T | grep -iE 'passwordauthentication|permitrootlogin|pubkeyauthentication'
```

Do not use `systemctl restart ssh`. If recovery is necessary, use the Tencent
Cloud web terminal, remove the drop-in, validate it, and reload SSH.

## Deploy a precise commit

The server cannot reliably reach `github.com:443`; use the GitHub codeload
archive endpoint, pinned to the exact SHA. In a single SSH command or MCP
execution, replace `<full-commit-sha>` and run:

```bash
set -Eeuo pipefail
COMMIT=<full-commit-sha>
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/source"
curl -fsSL -o "$TMP/release.tar.gz" "https://codeload.github.com/JimyTD/SilentWereWolf/tar.gz/$COMMIT"
tar -xzf "$TMP/release.tar.gz" -C "$TMP/source" --strip-components=1
SILENTWEREWOLF_DEPLOY_ACK=active-games-will-end bash "$TMP/source/scripts/deploy-release.sh" "$COMMIT"
```

The script takes a host-wide `flock`, checks disk space, discovers the legacy
running release when needed, validates Compose, builds the new release, waits
for health, probes `http://127.0.0.1:8081/healthz`, and only then switches the
`current` and `previous` pointers. Once activation has started, a failed health
check automatically recreates the prior release.

Follow the script with an external browser check of the website, Socket.IO room
creation, and an AI action. Verify QQBot remains running with the preflight
container listing.

For any production smoke test that creates state, define the cleanup sequence
before performing the action and verify that it completed. Use a dedicated
temporary identity. For an AI-filled lobby, remove the test AI players while
the temporary host is still present, then leave the empty room; do not leave a
hostless or AI-only room behind. If cleanup fails, stop and report it. Treat a
non-blocking cleanup defect as a follow-up under the release-scope policy
instead of automatically starting another deployment.

## Roll back

Run the rollback script from the current release when the new version is
unhealthy after a deployment, or when the user requests a rollback:

```bash
set -Eeuo pipefail
CURRENT=$(readlink -f /root/silentwerewolf-releases/current)
SILENTWEREWOLF_DEPLOY_ACK=active-games-will-end bash "$CURRENT/scripts/rollback-release.sh"
```

It validates the previous Compose configuration, rebuilds it, waits for health,
checks the local health endpoint, and swaps `current` and `previous` only after
the rollback is healthy.

## Operational checks

```bash
CURRENT=$(readlink -f /root/silentwerewolf-releases/current)
cat "$CURRENT/.release-commit"
cat "$CURRENT/.release-manifest"
docker compose -p silentwerewolf -f "$CURRENT/docker-compose.yml" --project-directory "$CURRENT" ps
docker compose -p silentwerewolf -f "$CURRENT/docker-compose.yml" --project-directory "$CURRENT" logs --tail=200 silentwerewolf
docker compose -p silentwerewolf -f "$CURRENT/docker-compose.yml" --project-directory "$CURRENT" logs --tail=200 nginx
curl -fsS http://127.0.0.1:8081/healthz
```

The health endpoint returns only `{"status":"ok"}`. Never print the secret
file. To inspect configured key names only, use `cut -d= -f1`.

## Prohibited operations

- Lighthouse integration commands, uploads, or configuration anchors.
- `docker-compose`; use `docker compose` only.
- `docker compose down`, `stop`, `kill`, or `rm` for this release workflow.
- `git pull` or `git clean` on the server.
- `docker system prune`, `docker builder prune`, `docker volume rm`, or
  `docker network rm` without explicit user approval.
- Changes to QQBot containers, networks, files, or ports.
- Editing a tracked file in a release directory.
- Copying the secrets file into a release, image, or Git repository.
