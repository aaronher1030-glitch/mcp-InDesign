import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureMcpClient, configureClients, defaultClientTargets } from '../src/install/mcpConfig.js';

function tempDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempFile(t, contents) {
  const dir = tempDirectory(t);
  const file = join(dir, 'mcp.json');
  if (contents !== undefined) writeFileSync(file, contents, 'utf8');
  return file;
}

test('configure creates only the requested server entry', (t) => {
  const original = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other.exe' } } });
  const file = tempFile(t, original);
  const result = configureMcpClient({ filePath: file, command: 'C:\\Apps\\InDesignAaronV1.1.exe' });
  assert.equal(result.status, 'configured');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.other, { command: 'other.exe' });
  assert.deepEqual(config.mcpServers.indesign, { command: 'C:\\Apps\\InDesignAaronV1.1.exe', args: [] });
  assert.match(result.backupPath, /\.indesign-backup-/);
  assert.equal(readFileSync(result.backupPath, 'utf8'), original);
});

test('configure is idempotent without filesystem writes', (t) => {
  const file = tempFile(t);
  const options = { filePath: file, command: 'C:\\Apps\\InDesignAaronV1.1.exe' };
  configureMcpClient(options);
  const directory = dirname(file);
  const beforeContent = readFileSync(file);
  const beforeMetadata = statSync(file);
  const beforeEntries = readdirSync(directory).sort();

  const second = configureMcpClient(options);

  assert.equal(second.status, 'unchanged');
  assert.equal(second.backupPath, null);
  assert.deepEqual(readFileSync(file), beforeContent);
  const afterMetadata = statSync(file);
  assert.equal(afterMetadata.mtimeMs, beforeMetadata.mtimeMs);
  assert.equal(afterMetadata.ctimeMs, beforeMetadata.ctimeMs);
  assert.equal(afterMetadata.ino, beforeMetadata.ino);
  assert.deepEqual(readdirSync(directory).sort(), beforeEntries);
  assert.equal(beforeEntries.some((name) => name.endsWith('.tmp')), false);
});

test('timestamp collisions preserve every backup with exact original content', (t) => {
  const original = '{\r\n  "theme": "dark"\r\n}\r\n';
  const file = tempFile(t, original);
  t.mock.method(Date.prototype, 'toISOString', () => '2026-11-27T12:34:56.789Z');
  const options = { filePath: file, command: 'C:\\Apps\\server.exe' };

  const first = configureMcpClient(options);
  const firstConfiguredContent = readFileSync(file);
  const second = configureMcpClient({ ...options, remove: true });

  assert.equal(first.status, 'configured');
  assert.equal(second.status, 'removed');
  assert.deepEqual(readFileSync(first.backupPath), Buffer.from(original));
  assert.deepEqual(readFileSync(second.backupPath), firstConfiguredContent);
  assert.notEqual(first.backupPath, second.backupPath);
  assert.match(first.backupPath, /\.indesign-backup-2026-11-27T12-34-56-789Z(?:-\d+)?$/);
  assert.match(second.backupPath, /\.indesign-backup-2026-11-27T12-34-56-789Z(?:-\d+)?$/);
  assert.equal(readdirSync(dirname(file)).filter((name) => name.includes('.indesign-backup-')).length, 2);
});

test('failed replacement removes its temporary file and leaves the target unchanged', (t) => {
  const original = '{"theme":"dark"}\r\n';
  const file = tempFile(t, original);
  const failure = new Error('simulated rename failure');
  const options = { filePath: file, command: 'C:\\Apps\\server.exe' };

  assert.throws(
    () => configureMcpClient(options, { renameSync: () => { throw failure; } }),
    (error) => error === failure,
  );

  assert.equal(readFileSync(file, 'utf8'), original);
  const entries = readdirSync(dirname(file));
  const backups = entries.filter((name) => name.includes('.indesign-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dirname(file), backups[0]), 'utf8'), original);
  assert.equal(entries.filter((name) => name.endsWith('.tmp')).length, 0);
});

test('malformed JSON is untouched', (t) => {
  const file = tempFile(t, '{broken');
  assert.throws(() => configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe' }), /JSON/i);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  assert.equal(readdirSync(join(file, '..')).filter((name) => name.includes('backup')).length, 0);
});

test('foreign indesign entry is never overwritten', (t) => {
  const original = JSON.stringify({ mcpServers: { indesign: { command: 'C:\\Other\\server.exe' } } });
  const file = tempFile(t, original);
  assert.throws(() => configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe' }), /owned by another/i);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(readdirSync(join(file, '..')).filter((name) => name.includes('backup')).length, 0);
});

test('remove deletes only an entry owned by this executable', (t) => {
  const file = tempFile(t, JSON.stringify({ mcpServers: {
    indesign: { command: 'C:\\Apps\\server.exe', args: [] },
    other: { command: 'other.exe' },
  } }));
  const result = configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe', remove: true });
  assert.equal(result.status, 'removed');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.mcpServers.indesign, undefined);
  assert.deepEqual(config.mcpServers.other, { command: 'other.exe' });
});

test('remove leaves a foreign entry untouched without a backup', (t) => {
  const original = JSON.stringify({ mcpServers: { indesign: { command: 'C:\\Other\\server.exe' } } });
  const file = tempFile(t, original);
  const result = configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe', remove: true });
  assert.deepEqual(result, { status: 'unchanged', backupPath: null });
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('configureClients reports each target without stopping at the first failure', (t) => {
  const good = tempFile(t);
  const bad = tempFile(t, '{bad');
  const report = configureClients({ command: 'C:\\Apps\\server.exe', targets: [
    { id: 'good', filePath: good },
    { id: 'skipped', filePath: join(good, '..', 'not-installed', 'mcp.json'), skipped: true },
    { id: 'bad', filePath: bad },
  ] });
  assert.equal(report.overall, 'failed');
  assert.equal(report.results[0].status, 'configured');
  assert.equal(report.results[1].status, 'skipped');
  assert.equal(report.results[2].status, 'failed');
});

test('non-object top-level JSON is untouched', (t) => {
  for (const value of [null, [], 'text', 42, true]) {
    const original = JSON.stringify(value);
    const file = tempFile(t, original);
    assert.throws(() => configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe' }), /JSON object/i);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(readdirSync(join(file, '..')).filter((name) => name.includes('backup')).length, 0);
  }
});

test('non-object mcpServers is untouched', (t) => {
  for (const value of [null, [], 'text', 42, true]) {
    const original = JSON.stringify({ theme: 'dark', mcpServers: value });
    const file = tempFile(t, original);
    assert.throws(() => configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe' }), /non-object mcpServers/i);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(readdirSync(join(file, '..')).filter((name) => name.includes('backup')).length, 0);
  }
});

test('defaultClientTargets resolves Windows client paths and skips absent clients', (t) => {
  const homeDir = tempDirectory(t);
  const appData = join(homeDir, 'AppData', 'Roaming');
  mkdirSync(join(appData, 'Claude'), { recursive: true });
  mkdirSync(join(homeDir, '.cursor'), { recursive: true });

  assert.deepEqual(defaultClientTargets({ env: { APPDATA: appData }, homeDir }), [
    { id: 'claude', filePath: join(appData, 'Claude', 'claude_desktop_config.json'), skipped: false },
    { id: 'cursor', filePath: join(homeDir, '.cursor', 'mcp.json'), skipped: false },
    { id: 'qoder', filePath: join(homeDir, '.qoder', 'mcp.json'), skipped: true },
  ]);
  assert.deepEqual(defaultClientTargets({ env: {}, homeDir, all: true }), [
    { id: 'claude', filePath: null, skipped: true },
    { id: 'cursor', filePath: join(homeDir, '.cursor', 'mcp.json'), skipped: false },
    { id: 'qoder', filePath: join(homeDir, '.qoder', 'mcp.json'), skipped: false },
  ]);
});
