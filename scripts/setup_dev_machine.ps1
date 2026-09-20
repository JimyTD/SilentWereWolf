#requires -Version 5.1
<#
.SYNOPSIS
    Create the agent-neutral SSH MCP connection for SilentWerewolf.

.DESCRIPTION
    This script is intentionally ASCII-only. Windows PowerShell 5.1 can decode a
    UTF-8 file without a BOM using the local ANSI code page, so non-ASCII source
    text can corrupt a script before PowerShell parses it.
#>
[CmdletBinding()]
param(
    [string]$SshHost = '106.55.228.236',
    [string]$SshUser = 'root',
    [string]$ConnectionName = 'silentwerewolf',
    [string]$RemoteProjectDir = '/root/silentwerewolf-releases',
    [string]$KeyPath,
    [string]$BaseDir,
    [string[]]$Target = @('codex'),
    [switch]$Verify
)

$ErrorActionPreference = 'Stop'

function Info([string]$Message) { Write-Host "[setup] $Message" }
function Fail([string]$Message) { Write-Host "[fail ] $Message" -ForegroundColor Red; exit 1 }
function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}
function Read-JsonFile([string]$Path) {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}
function Merge-JsonServer([string]$Path, [string]$RootKey, [string]$Name, $Entry) {
    $servers = [ordered]@{}
    if (Test-Path -LiteralPath $Path) {
        Copy-Item -LiteralPath $Path -Destination "$Path.bak" -Force
        $existing = Read-JsonFile $Path
        $root = $existing.PSObject.Properties | Where-Object { $_.Name -eq $RootKey }
        if ($root) {
            foreach ($property in $root.Value.PSObject.Properties) { $servers[$property.Name] = $property.Value }
        }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    }
    $servers[$Name] = $Entry
    Write-Utf8NoBom $Path (([ordered]@{ $RootKey = $servers } | ConvertTo-Json -Depth 14))
}

$profilePath = $env:USERPROFILE
if (-not $KeyPath) { $KeyPath = Join-Path $profilePath '.ssh\silentwerewolf_deploy' }
if (-not $BaseDir) { $BaseDir = Join-Path $profilePath '.ssh-mcp' }

$serverDir = Join-Path $BaseDir 'server'
$configPath = Join-Path $BaseDir 'config.json'
$serverEntry = Join-Path $serverDir 'node_modules\@fangjunjie\ssh-mcp-server\build\index.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js >= 18 is required.' }
$nodeVersion = (& node -v).Trim().TrimStart('v')
if ([int]$nodeVersion.Split('.')[0] -lt 18) { Fail "Node.js >= 18 is required; found $nodeVersion." }

$validTargets = @('codex', 'codebuddy', 'cursor', 'none')
foreach ($item in $Target) {
    if ($validTargets -notcontains $item.ToLowerInvariant()) { Fail "Unknown target '$item'." }
}
if ($Target -contains 'none') { $Target = @() }

Write-Host ''
Write-Host '=== SilentWerewolf SSH MCP setup ===' -ForegroundColor Cyan
Info "host: $SshUser@$SshHost"
Info "key: $KeyPath"
Info "config: $configPath"

if (-not (Test-Path -LiteralPath $KeyPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $KeyPath) | Out-Null
    $tempCmd = Join-Path $env:TEMP "silentwerewolf_genkey_$PID.cmd"
    $comment = "$([System.Net.Dns]::GetHostName())-silentwerewolf"
    @"
@echo off
ssh-keygen -q -t ed25519 -f "$KeyPath" -C "$comment" -N "" < nul
"@ | Set-Content -LiteralPath $tempCmd -Encoding ASCII
    try { & cmd.exe /c $tempCmd | Out-Host } finally { Remove-Item -LiteralPath $tempCmd -Force -ErrorAction SilentlyContinue }
    if (-not (Test-Path -LiteralPath $KeyPath)) { Fail "ssh-keygen did not create $KeyPath" }
    Info 'created an ed25519 deployment key'
} else {
    Info 'deployment key already exists'
}

if (-not (Test-Path -LiteralPath "$KeyPath.pub")) {
    & ssh-keygen -y -f $KeyPath | Set-Content -LiteralPath "$KeyPath.pub" -Encoding ASCII
}
$publicKey = (Get-Content -LiteralPath "$KeyPath.pub" -Raw).Trim()
Info ((& ssh-keygen -l -f "$KeyPath.pub" 2>&1) -join ' ')

if (-not (Test-Path -LiteralPath $serverEntry)) {
    New-Item -ItemType Directory -Force -Path $serverDir | Out-Null
    Info 'installing @fangjunjie/ssh-mcp-server'
    & npm install --prefix $serverDir '@fangjunjie/ssh-mcp-server' --no-fund --no-audit --loglevel=error | Out-Host
    if (-not (Test-Path -LiteralPath $serverEntry)) { Fail 'ssh-mcp-server installation failed.' }
} else {
    Info 'ssh-mcp-server already installed'
}

# These expressions enforce this project's shared-host safety rules. Do not add
# git reset --hard: releases are immutable directories and the command is not used.
$blacklist = @(
    '\brm\s+(-[a-zA-Z]*\s+)*-?[rf]{1,2}[a-zA-Z]*\s+/(?:\s|$|\*)',
    '\bmkfs(\.\w+)?\b',
    '\bdd\b[^\n]*\bof=/dev/',
    '\b(shutdown|reboot|halt|poweroff)\b',
    '\biptables\s+-F\b',
    '\bufw\s+(disable|reset)\b',
    '\bdocker\s+(system|builder)\s+prune\b',
    '\bdocker\s+(volume|network)\s+rm\b',
    '\bdocker\s+compose\s+down\b',
    '\bdocker\s+compose\s+(rm|stop|kill)\b',
    '\bgit\s+clean\b',
    '\bgit\s+pull\b',
    '\bqqbot[-_a-zA-Z0-9]*\b[^\n]*(?:\b(rm|stop|kill|restart|start|exec)\b)|\b(?:rm|stop|kill|restart|start|exec)\b[^\n]*\bqqbot[-_a-zA-Z0-9]*\b',
    '\bqqbot_default\b',
    '\b(?:rm|mv|chmod|chown|sed|tee)\b[^\n]*/root/qqbot\b',
    '\bsshd_config\b|\b/systemctl\s+(restart|stop)\s+ssh\b',
    ':\s*\(\s*\)\s*\{.*\}\s*;\s*:'
)

$connection = [ordered]@{
    host = $SshHost
    port = 22
    username = $SshUser
    privateKey = ($KeyPath -replace '\\', '/')
    transportMode = 'exec'
    commandTimeoutMs = 900000
    connectionTimeoutMs = 30000
    keepaliveIntervalMs = 30000
    keepaliveCountMax = 5
    allowedRemotePaths = @($RemoteProjectDir)
    commandBlacklist = $blacklist
}

New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
$connections = [ordered]@{}
if (Test-Path -LiteralPath $configPath) {
    Copy-Item -LiteralPath $configPath -Destination "$configPath.bak" -Force
    $existing = Read-JsonFile $configPath
    foreach ($property in $existing.PSObject.Properties) { $connections[$property.Name] = $property.Value }
}
$connections[$ConnectionName] = $connection
Write-Utf8NoBom $configPath ($connections | ConvertTo-Json -Depth 14)
Info "wrote connection '$ConnectionName'"

$mcpEntry = [ordered]@{
    type = 'stdio'
    command = ($node.Source -replace '\\', '/')
    args = @(($serverEntry -replace '\\', '/'), '--config-file', ($configPath -replace '\\', '/'))
}
$serverName = "$ConnectionName-ssh"
if ($Target -contains 'codebuddy') {
    Merge-JsonServer (Join-Path $profilePath '.codebuddy\mcp.json') 'mcpServers' $serverName $mcpEntry
    Info "registered $serverName in ~/.codebuddy/mcp.json"
}
if ($Target -contains 'cursor') {
    Merge-JsonServer (Join-Path $profilePath '.cursor\mcp.json') 'mcpServers' $serverName $mcpEntry
    Info "registered $serverName in ~/.cursor/mcp.json"
}
if ($Target -contains 'codex') {
    $tomlArgs = ($mcpEntry.args | ForEach-Object { '"' + $_.Replace('\', '\\').Replace('"', '\"') + '"' }) -join ', '
    Write-Host ''
    Write-Host 'Add this entry to ~/.codex/config.toml, then open a new Codex task:' -ForegroundColor Yellow
    Write-Host "[mcp_servers.$serverName]"
    Write-Host ('command = "' + $mcpEntry.command + '"')
    Write-Host "args = [$tomlArgs]"
}

$installCommand = "install -d -m 700 /root/.ssh; touch /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; grep -qxF '$publicKey' /root/.ssh/authorized_keys || echo '$publicKey' >> /root/.ssh/authorized_keys"
Write-Host ''
Write-Host 'Use the Tencent Cloud web terminal once to install this machine public key:' -ForegroundColor Yellow
Write-Host $installCommand -ForegroundColor Gray
Write-Host 'After it succeeds, rerun this script with -Verify before changing sshd settings.' -ForegroundColor Yellow

if ($Verify) {
    & ssh -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$SshUser@$SshHost" 'hostname; whoami; test -d /root'
    if ($LASTEXITCODE -ne 0) { Fail 'SSH verification failed. Install the printed public key via the web terminal first.' }
    Info 'SSH verification succeeded'
}
