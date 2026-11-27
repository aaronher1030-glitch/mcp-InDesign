#!/usr/bin/env node
/**
 * Smoke-test the MCP stdio surface of a built executable or bundle.
 * Usage: node scripts/smoke-mcp.mjs [path-to-exe-or-bundle]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? 'build/indesign-aaron.cjs');
if (!existsSync(target)) {
  console.error(`Missing ${target}. Run npm run build:bundle first.`);
  process.exit(1);
}

const useNode = /\.(cjs|js|mjs)$/i.test(target);
const command = useNode ? process.execPath : target;
const commandArgs = useNode ? [target, '--mcp'] : ['--mcp'];
const child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (data) => { stdout += data.toString(); });
child.stderr.on('data', (data) => { stderr += data.toString(); });

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'InDesignAaron smoke test', version: '1.0.0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
setTimeout(() => child.stdin.end(), 1200);

const timer = setTimeout(() => {
  console.error('Smoke test timed out.');
  child.kill();
  process.exit(1);
}, 20000);

child.on('exit', (code) => {
  clearTimeout(timer);
  const replies = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const init = replies.find((reply) => reply.id === 1);
  const tools = replies.find((reply) => reply.id === 2);
  const prompts = replies.find((reply) => reply.id === 3);
  const resources = replies.find((reply) => reply.id === 4);

  const summary = {
    exitCode: code,
    server: init?.result?.serverInfo ?? null,
    tools: tools?.result?.tools?.length ?? 0,
    prompts: prompts?.result?.prompts?.length ?? 0,
    resources: resources?.result?.resources?.length ?? 0,
    skillTools: (tools?.result?.tools ?? [])
      .map((tool) => tool.name)
      .filter((name) => ['inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit', 'preview_layout'].includes(name)),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (stderr.trim()) console.log(`\nstderr:\n${stderr.trim().split('\n').slice(0, 6).join('\n')}`);

  const ok = code === 0
    && summary.tools > 100
    && summary.prompts === 6
    && summary.resources >= 8
    && summary.skillTools.length === 6;
  console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
  process.exit(ok ? 0 : 1);
});
