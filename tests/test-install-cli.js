import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uxpExitCode } from '../src/install/uxpInstaller.js';

const ROOT = dirname(dirname(fileURLToPath(new URL('../src/index.js', import.meta.url))));
const ENTRY = join(ROOT, 'src', 'index.js');

function tempProfile(t) {
  const home = mkdtempSync(join(tmpdir(), 'indesign-install-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const appData = join(home, 'AppData', 'Roaming');
  return {
    home,
    env: { APPDATA: appData, USERPROFILE: home, HOME: home },
    files: {
      claude: join(appData, 'Claude', 'claude_desktop_config.json'),
      cursor: join(home, '.cursor', 'mcp.json'),
      qoder: join(home, '.qoder', 'mcp.json'),
    },
  };
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

function runCli(profile, flags) {
  return spawnSync(process.execPath, [ENTRY, ...flags], {
    cwd: ROOT,
    env: { ...process.env, ...profile.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
}

function assertCompleted(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
}

test('--configure-clients --all-clients writes all profiles and preserves unrelated data', (t) => {
  const profile = tempProfile(t);
  for (const [id, filePath] of Object.entries(profile.files)) {
    writeJson(filePath, { client: id, mcpServers: { other: { command: 'other.exe', args: ['--keep'] } } });
  }

  const result = runCli(profile, ['--configure-clients', '--all-clients']);

  assertCompleted(result);
  assert.equal(result.status, 0, result.stderr);
  for (const [id, filePath] of Object.entries(profile.files)) {
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(config.client, id);
    assert.deepEqual(config.mcpServers.other, { command: 'other.exe', args: ['--keep'] });
    assert.deepEqual(config.mcpServers.indesign, { command: ENTRY, args: [] });
    assert.match(result.stdout, new RegExp(`^${id}: configured - ${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.match(result.stdout, /configured/g);
});

test('--configure-clients accepts a custom server name', (t) => {
  const profile = tempProfile(t);
  const result = runCli(profile, ['--configure-clients', '--all-clients', '--server-name', 'studio']);

  assertCompleted(result);
  assert.equal(result.status, 0, result.stderr);
  for (const filePath of Object.values(profile.files)) {
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.deepEqual(config.mcpServers.studio, { command: ENTRY, args: [] });
    assert.equal(config.mcpServers.indesign, undefined);
  }
});

test('--configure-clients reports malformed Claude JSON without changing it', (t) => {
  const profile = tempProfile(t);
  const original = '{"mcpServers": {"indesign": ';
  mkdirSync(dirname(profile.files.claude), { recursive: true });
  writeFileSync(profile.files.claude, original, 'utf8');

  const result = runCli(profile, ['--configure-clients', '--all-clients']);

  assertCompleted(result);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(profile.files.claude, 'utf8'), original);
  assert.equal(readdirSync(dirname(profile.files.claude)).some((name) => name.includes('.indesign-backup-')), false);
  assert.match(result.stdout, /^claude: failed /m);
  assert.match(result.stdout, /^cursor: configured /m);
  assert.match(result.stdout, /^qoder: configured /m);
});

test('--configure-clients preserves a foreign server entry and exits nonzero', (t) => {
  const profile = tempProfile(t);
  const original = JSON.stringify({ mcpServers: { indesign: { command: 'C:\\Other\\server.exe', args: [] } } });
  writeJson(profile.files.claude, JSON.parse(original));

  const result = runCli(profile, ['--configure-clients', '--all-clients']);

  assertCompleted(result);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(profile.files.claude, 'utf8'), original);
  assert.equal(readdirSync(dirname(profile.files.claude)).some((name) => name.includes('.indesign-backup-')), false);
  assert.match(result.stdout, /^claude: failed .*owned by another executable/m);
});

test('--remove-clients --all-clients removes only entries owned by this executable', (t) => {
  const profile = tempProfile(t);
  const foreign = { command: 'C:\\Other\\server.exe', args: ['--keep'] };
  for (const [id, filePath] of Object.entries(profile.files)) {
    writeJson(filePath, {
      client: id,
      mcpServers: {
        indesign: { command: ENTRY, args: [] },
        other: foreign,
      },
    });
  }

  const result = runCli(profile, ['--remove-clients', '--all-clients']);

  assertCompleted(result);
  assert.equal(result.status, 0, result.stderr);
  for (const [id, filePath] of Object.entries(profile.files)) {
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(config.client, id);
    assert.equal(config.mcpServers.indesign, undefined);
    assert.deepEqual(config.mcpServers.other, foreign);
    assert.match(result.stdout, new RegExp(`^${id}: removed - ${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

test('--help lists all installer modes', (t) => {
  const profile = tempProfile(t);
  const result = runCli(profile, ['--help']);

  assertCompleted(result);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--configure-clients/);
  assert.match(result.stdout, /--remove-clients/);
  assert.match(result.stdout, /--install-uxp <ccx-path>/);
  assert.match(result.stdout, /--remove-uxp <ccx-path>/);
});

for (const flag of ['--install-uxp', '--remove-uxp']) {
  test(`${flag} rejects missing, blank, and option-like CCX paths`, async (t) => {
    const cases = [
      ['missing value', [flag]],
      ['empty equals value', [`${flag}=`]],
      ['blank equals value', [`${flag}=   `]],
      ['option-like next value', [flag, '--selftest']],
      ['option-like equals value', [`${flag}=--selftest`]],
    ];
    for (const [name, flags] of cases) {
      await t.test(name, (t) => {
        const profile = tempProfile(t);
        const result = runCli(profile, flags);

        assertCompleted(result);
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, new RegExp(`${flag} requires a non-empty CCX path`));
        assert.match(result.stderr, /Usage: .*--(?:install|remove)-uxp <ccx-path>/);
        assert.doesNotMatch(result.stdout, /fallback_required|live self test/);
      });
    }
  });
}

test('UPIA CLI exit-code mapping runs on every platform', () => {
  const cases = [
    [{ status: 'installed' }, false, 0],
    [{ status: 'fallback_required' }, false, 3],
    [{ status: 'removed' }, true, 0],
    [{ status: 'fallback_required' }, true, 4],
  ];
  for (const [result, remove, expected] of cases) {
    assert.equal(uxpExitCode(result, remove), expected);
  }
});

test('--install-uxp returns fallback exit code 3 off Windows', { skip: process.platform === 'win32' }, (t) => {
  const profile = tempProfile(t);
  const result = runCli(profile, ['--install-uxp', join(profile.home, 'missing.ccx')]);

  assertCompleted(result);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /fallback_required/);
  assert.match(result.stdout, /UPIA is not installed/);
});

test('--remove-uxp returns fallback exit code 4 off Windows', { skip: process.platform === 'win32' }, (t) => {
  const profile = tempProfile(t);
  const result = runCli(profile, ['--remove-uxp', join(profile.home, 'missing.ccx')]);

  assertCompleted(result);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout, /fallback_required/);
  assert.match(result.stdout, /UPIA is not installed/);
});
