#!/usr/bin/env node
/**
 * Call the locally installed SSH MCP server without relying on an agent session.
 * Usage: node scripts/mcp_call.mjs <tool-name> [inline-json-or-json-file]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const serverEntry = process.env.SSH_MCP_SERVER ?? path.join(
  home,
  '.ssh-mcp',
  'server',
  'node_modules',
  '@fangjunjie',
  'ssh-mcp-server',
  'build',
  'index.js',
);
const configPath = process.env.SSH_MCP_CONFIG ?? path.join(home, '.ssh-mcp', 'config.json');
const [toolName, argsArg] = process.argv.slice(2);

if (!toolName) {
  console.error('usage: node scripts/mcp_call.mjs <tool-name> [inline-json-or-json-file]');
  process.exit(2);
}
if (!existsSync(serverEntry) || !existsSync(configPath)) {
  console.error('SSH MCP server or config is missing. Run scripts/setup_dev_machine.ps1 first.');
  process.exit(2);
}

let toolArgs = {};
if (argsArg) {
  toolArgs = JSON.parse(existsSync(argsArg) ? readFileSync(argsArg, 'utf8') : argsArg);
}

const child = spawn(process.execPath, [serverEntry, '--config-file', configPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});
const pending = new Map();
let buffer = '';
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    } catch {
      // Ignore non-protocol output from the server.
    }
  }
});
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timed out waiting for ${method}`));
    }, 300_000).unref();
  });
}

try {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'silentwerewolf-mcp-call', version: '1.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const response = await request('tools/call', { name: toolName, arguments: toolArgs });
  for (const part of response.result?.content ?? []) {
    console.log(part.type === 'text' ? part.text : JSON.stringify(part));
  }
  process.exitCode = response.result?.isError ? 1 : 0;
} catch (error) {
  console.error(`MCP call failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
