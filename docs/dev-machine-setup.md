# SilentWerewolf Development Machine Setup

This setup creates an agent-neutral SSH operations channel. The key is standard
OpenSSH, the MCP server uses standard input/output, and raw `ssh` remains an
emergency fallback. No cloud credential or secret is stored in this repository.

## 1. Create local artifacts

On Windows, run from this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup_dev_machine.ps1 -Target codex
```

The script is idempotent. It checks Node.js, creates
`~/.ssh/silentwerewolf_deploy`, installs `@fangjunjie/ssh-mcp-server` under
`~/.ssh-mcp/server`, and adds the `silentwerewolf` connection to
`~/.ssh-mcp/config.json`. The connection includes a command blacklist for the
shared QQBot host.

Use `-Target codebuddy` or `-Target cursor` to register those clients directly.
For Codex, the script prints the TOML block for `~/.codex/config.toml`; add it
without replacing other MCP entries, then start a new task so the tool list is
reloaded.

## 2. Install the public key through the web terminal

The script prints a command containing this machine's public key. In Tencent
Cloud Lighthouse, open the instance web terminal and paste that command once.
This is intentionally a non-SSH bootstrap channel, so it still works when SSH
is unavailable or misconfigured.

Do not install a key through the retired Lighthouse integration. Do not paste a
private key anywhere.

## 3. Verify before hardening SSH

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup_dev_machine.ps1 -Target codex -Verify
```

The verification must report the remote host and `root`. Only after it succeeds
should the server-side hardening command in `docs/operations.md` be run through
the SSH channel. It validates with `sshd -t` and reloads rather than restarts
the service.

## Emergency direct usage

```powershell
ssh -i $HOME/.ssh/silentwerewolf_deploy root@106.55.228.236 "hostname; docker compose ls"
```

The repository includes a direct MCP client for sessions created before the MCP
entry was registered:

```powershell
node scripts/mcp_call.mjs execute-command '{"connectionName":"silentwerewolf","command":"docker compose ls"}'
```

Use the exact MCP tool name and argument shape reported by the installed server.
The deployment workflow itself is documented in `docs/operations.md`.
