import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function atomicWrite(filePath, text, fileSystem = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  const rename = fileSystem.renameSync ?? renameSync;
  const remove = fileSystem.rmSync ?? rmSync;
  try {
    writeFileSync(temporary, text, 'utf8');
    rename(temporary, filePath);
  } catch (error) {
    try {
      remove(temporary, { force: true });
    } catch {
      // Preserve the original write or rename failure.
    }
    throw error;
  }
}

function readConfig(filePath) {
  if (!existsSync(filePath)) return {};
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

function backup(filePath, original) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const basePath = `${filePath}.indesign-backup-${stamp}`;
  for (let suffix = 0; ; suffix += 1) {
    const backupPath = suffix === 0 ? basePath : `${basePath}-${suffix}`;
    try {
      writeFileSync(backupPath, original, { encoding: 'utf8', flag: 'wx' });
      return backupPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

export function configureMcpClient({ filePath, command, serverName = 'indesign', remove = false }, fileSystem = {}) {
  const original = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  const config = readConfig(filePath);
  const servers = config.mcpServers;
  if (servers !== undefined && (servers === null || Array.isArray(servers) || typeof servers !== 'object')) {
    throw new Error(`${filePath} has a non-object mcpServers value; refusing to replace it.`);
  }
  config.mcpServers = servers ?? {};
  const current = config.mcpServers[serverName];
  const expected = { command, args: [] };
  const owns = current && current.command === command;
  const changed = remove
    ? Boolean(owns)
    : JSON.stringify(current) !== JSON.stringify(expected);
  if (!changed) return { status: remove ? 'unchanged' : 'unchanged', backupPath: null };
  if (!remove && current !== undefined && !owns) {
    throw new Error(`${filePath}: server "${serverName}" is owned by another executable.`);
  }
  const backupPath = original === null ? null : backup(filePath, original);
  if (remove) delete config.mcpServers[serverName];
  else config.mcpServers[serverName] = expected;
  atomicWrite(filePath, `${JSON.stringify(config, null, 2)}\n`, fileSystem);
  return { status: remove ? 'removed' : 'configured', backupPath };
}

export function defaultClientTargets({ env = process.env, homeDir = homedir(), all = false } = {}) {
  return [
    { id: 'claude', filePath: env.APPDATA ? join(env.APPDATA, 'Claude', 'claude_desktop_config.json') : null },
    { id: 'cursor', filePath: join(homeDir, '.cursor', 'mcp.json') },
    { id: 'qoder', filePath: join(homeDir, '.qoder', 'mcp.json') },
  ].map(({ id, filePath }) => ({
    id,
    filePath,
    skipped: !filePath || (!all && !existsSync(dirname(filePath))),
  }));
}

export function configureClients({ command, targets, serverName = 'indesign', remove = false }) {
  const results = targets.map(({ id, filePath, skipped }) => {
    if (skipped) return { id, filePath, status: 'skipped', backupPath: null };
    try {
      return { id, filePath, ...configureMcpClient({ filePath, command, serverName, remove }) };
    } catch (error) {
      return { id, filePath, status: 'failed', error: error.message };
    }
  });
  return { overall: results.some((result) => result.status === 'failed') ? 'failed' : 'ok', results };
}
