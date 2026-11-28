# One-click Windows Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-user Windows installer that installs the SEA server and UXP `.ccx`, configures MCP clients safely, and supports a fail-closed signed release pipeline.

**Architecture:** Inno Setup packages the existing SEA executable and an Adobe UXP CLI-generated `.ccx`. New SEA CLI modes perform atomic MCP JSON merges and UPIA installation so end users need no Node.js, UXP Developer Tool, or manual JSON editing on the normal path.

**Tech Stack:** Node.js 20+ runtime, Node SEA, Node built-in test runner, Adobe UXP CLI, Inno Setup 7, Windows Authenticode/Azure Artifact Signing.

**Spec:** `docs/superpowers/specs/2026-11-27-one-click-windows-installer-design.md`

## Global Constraints

- Windows 10/11 x64; InDesign 2022 (18.0) or newer.
- Per-user install under `%LOCALAPPDATA%\Programs\InDesignAaronV1.1`.
- Production plugin installation uses `.ccx` and UPIA; never copy into Adobe's plugin database directly.
- Preserve unrelated MCP servers and malformed-config recovery behavior.
- Never store model API keys in installer files or MCP configuration.
- Public release builds require a publicly trusted Authenticode signature and RFC 3161 timestamp; unsigned local builds must be labeled unsigned.
- Generated `.exe`, `.ccx`, installer output, and signing material are excluded from Git.
- Do not mutate live InDesign documents during implementation or tests.
- Do not claim public signing or live InDesign success without direct evidence.

---

### Task 1: Atomic MCP client configuration

**Files:**
- Create: `src/install/mcpConfig.js`
- Create: `tests/test-mcp-config.js`
- Modify: `package.json:16` to include the new test in `npm test`.

**Interfaces:**
- Consumes: Node `fs`, `path`, and `os` modules only.
- Produces:
  - `configureMcpClient({ filePath, command, serverName = 'indesign', remove = false })`
    returning `{ status: 'configured' | 'unchanged' | 'removed', backupPath: string | null }`.
  - `defaultClientTargets({ env = process.env, homeDir = os.homedir(), all = false })`
    returning `{ id, filePath, skipped }[]` for Claude Desktop, Cursor, and Qoder.
  - `configureClients({ command, targets, serverName = 'indesign', remove = false })`
    returning `{ overall: 'ok' | 'failed', results: [{ id, filePath, status, error? }] }`.

- [ ] **Step 1: Write failing tests**

Create `tests/test-mcp-config.js` with tests that use temporary directories:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureMcpClient, configureClients } from '../src/install/mcpConfig.js';

function tempFile(t, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'indesign-mcp-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'mcp.json');
  if (contents !== undefined) writeFileSync(file, contents, 'utf8');
  return file;
}

test('configure creates only the requested server entry', (t) => {
  const file = tempFile(t, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other.exe' } } }));
  const result = configureMcpClient({ filePath: file, command: 'C:\\Apps\\InDesignAaronV1.1.exe' });
  assert.equal(result.status, 'configured');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.other, { command: 'other.exe' });
  assert.deepEqual(config.mcpServers.indesign, { command: 'C:\\Apps\\InDesignAaronV1.1.exe', args: [] });
  assert.ok(result.backupPath);
});

test('configure is idempotent', (t) => {
  const file = tempFile(t);
  const options = { filePath: file, command: 'C:\\Apps\\InDesignAaronV1.1.exe' };
  configureMcpClient(options);
  const second = configureMcpClient(options);
  assert.equal(second.status, 'unchanged');
  assert.equal(second.backupPath, null);
});

test('malformed JSON is untouched', (t) => {
  const file = tempFile(t, '{broken');
  assert.throws(() => configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe' }), /JSON/i);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  assert.equal(readdirSync(join(file, '..')).filter((name) => name.includes('backup')).length, 0);
});

test('foreign indesign entry is never overwritten', (t) => {
  const file = tempFile(t, JSON.stringify({ mcpServers: { indesign: { command: 'C:\\Other\\server.exe' } } }));
  assert.throws(() => configureMcpClient({ filePath: file, command: 'C:\\Apps\\server.exe' }), /owned by another/i);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.indesign.command, 'C:\\Other\\server.exe');
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
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/test-mcp-config.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/install/mcpConfig.js`.

- [ ] **Step 3: Implement the module**

Create `src/install/mcpConfig.js` with:

```js
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

function atomicWrite(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, filePath);
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
  const backupPath = `${filePath}.indesign-backup-${stamp}`;
  writeFileSync(backupPath, original, 'utf8');
  return backupPath;
}

export function configureMcpClient({ filePath, command, serverName = 'indesign', remove = false }) {
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
  atomicWrite(filePath, `${JSON.stringify(config, null, 2)}\n`);
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
```

Add tests for a non-object top level and non-object `mcpServers`, then verify they fail closed.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/test-mcp-config.js`

Expected: all tests pass.

- [ ] **Step 5: Run related suite**

Run: `npm test`

Expected: existing tests plus the new config tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/install/mcpConfig.js tests/test-mcp-config.js package.json
git commit -m "Add safe MCP client configuration"
```

### Task 2: Configuration and UPIA CLI modes

**Files:**
- Create: `src/install/uxpInstaller.js`
- Create: `tests/test-uxp-installer.js`
- Create: `tests/test-install-cli.js`
- Modify: `src/index.js:135-185,231-268` for new flags and CLI output.
- Modify: `package.json:16` to include both new tests.

**Interfaces:**
- Consumes: Task 1 `configureClients`, `defaultClientTargets`; Node `fs`, `path`, `child_process`.
- Produces:
  - `findUpia({ env = process.env, platform = process.platform, exists = existsSync })`
    returning an absolute executable path or `null`.
  - `installCcx({ ccxPath, upiaPath, execFile = execFileSync })`
    returning `{ status: 'installed' | 'fallback_required', upiaPath, error? }`.
  - `removeCcx({ ccxPath, upiaPath, execFile = execFileSync })`
    returning `{ status: 'removed' | 'fallback_required', upiaPath, error? }`.
  - `--configure-clients [--all-clients] [--server-name NAME]`
  - `--remove-clients [--server-name NAME]`
  - `--install-uxp <ccx-path>` with exit code `0` for installed and `3` for fallback required.
  - `--remove-uxp <ccx-path>` with exit code `0` for removed and `4` for fallback required.

- [ ] **Step 1: Write failing UPIA tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { findUpia, installCcx, removeCcx } from '../src/install/uxpInstaller.js';

test('findUpia checks standard Creative Cloud paths', () => {
  const found = 'C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe';
  const calls = [];
  const actual = findUpia({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: (path) => { calls.push(path); return path === found; },
  });
  assert.equal(actual, found);
  assert.ok(calls.includes(found));
});

test('findUpia returns null off Windows', () => {
  assert.equal(findUpia({ platform: 'linux', env: {}, exists: () => true }), null);
});

test('installCcx invokes UPIA and waits', () => {
  const calls = [];
  const result = installCcx({
    ccxPath: 'C:\\Temp\\plugin.ccx',
    upiaPath: 'C:\\UPIA.exe',
    execFile: (file, args) => calls.push({ file, args }),
  });
  assert.equal(result.status, 'installed');
  assert.deepEqual(calls, [{ file: 'C:\\UPIA.exe', args: ['/install', 'C:\\Temp\\plugin.ccx'] }]);
});

test('missing UPIA requests ccx fallback', () => {
  assert.equal(installCcx({ ccxPath: 'C:\\Temp\\plugin.ccx', upiaPath: null }).status, 'fallback_required');
  assert.equal(removeCcx({ ccxPath: 'C:\\Temp\\plugin.ccx', upiaPath: null }).status, 'fallback_required');
});

test('UPIA failure requests ccx fallback', () => {
  assert.equal(installCcx({
    ccxPath: 'C:\\Temp\\plugin.ccx',
    upiaPath: 'C:\\UPIA.exe',
    execFile: () => { throw new Error('access denied'); },
  }).status, 'fallback_required');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/test-uxp-installer.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement UPIA adapter**

Create `src/install/uxpInstaller.js` using only documented paths:

```js
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const RELATIVE_UPIA = join('Adobe', 'Adobe Desktop Common', 'RemoteComponents', 'UPI', 'UnifiedPluginInstallerAgent', 'UnifiedPluginInstallerAgent.exe');

export function findUpia({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (platform !== 'win32') return null;
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, 'Common Files', RELATIVE_UPIA);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function installCcx({ ccxPath, upiaPath, execFile = execFileSync } = {}) {
  if (!upiaPath) return { status: 'fallback_required', upiaPath: null, error: 'UPIA is not installed.' };
  try {
    execFile(upiaPath, ['/install', ccxPath], { stdio: 'inherit', windowsHide: true });
    return { status: 'installed', upiaPath };
  } catch (error) {
    return { status: 'fallback_required', upiaPath, error: error.message };
  }
}

export function removeCcx({ ccxPath, upiaPath, execFile = execFileSync } = {}) {
  if (!upiaPath) return { status: 'fallback_required', upiaPath: null, error: 'UPIA is not installed.' };
  try {
    execFile(upiaPath, ['/remove', ccxPath], { stdio: 'inherit', windowsHide: true });
    return { status: 'removed', upiaPath };
  } catch (error) {
    return { status: 'fallback_required', upiaPath, error: error.message };
  }
}
```

- [ ] **Step 4: Write failing CLI tests**

Spawn `src/index.js` with a temporary `APPDATA`, `USERPROFILE`, and `HOME`, using `--configure-clients --all-clients`; assert three JSON files exist and unrelated data survives. Spawn with malformed Claude JSON and assert nonzero exit plus untouched input. Spawn `--remove-clients --all-clients` and assert only matching entries are removed. For `--install-uxp`, use a nonexistent `.ccx` on a non-Windows test host and assert exit code `3`; on Windows, inject a fake UPIA only through direct unit tests, never the CLI.

- [ ] **Step 5: Run CLI tests and verify RED**

Run: `node --test tests/test-install-cli.js tests/test-uxp-installer.js`

Expected: CLI tests fail because flags are unrecognized or print help and start the bridge.

- [ ] **Step 6: Implement CLI flags**

In `src/index.js`:

```js
import { configureClients, defaultClientTargets } from './install/mcpConfig.js';
import { findUpia, installCcx, removeCcx } from './install/uxpInstaller.js';

function numericOrStringFlag(name) {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const value = args[index].includes('=') ? args[index].split('=').slice(1).join('=') : args[index + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function configureClientsCli(remove) {
  const command = executablePath();
  const report = configureClients({
    command,
    remove,
    serverName: numericOrStringFlag('--server-name') ?? 'indesign',
    targets: defaultClientTargets({ all: hasFlag('--all-clients') }),
  });
  for (const result of report.results) {
    console.log(`${result.id}: ${result.status}${result.error ? ` (${result.error})` : ''} - ${result.filePath}`);
  }
  return report.overall === 'ok' ? 0 : 1;
}
```

Handle `--configure-clients`, `--remove-clients`, `--install-uxp`, and
`--remove-uxp` before `--selftest`. Use `--install-uxp` exit code `3` and
`--remove-uxp` exit code `4` for fallback. Add all four lines to `printHelp()`.

For source mode tests, `executablePath()` currently returns `src/index.js`,
which is appropriate for MCP config tests. For installed SEA mode it returns
the `.exe` path.

- [ ] **Step 7: Run focused tests**

Run: `node --test tests/test-install-cli.js tests/test-uxp-installer.js tests/test-mcp-config.js`

Expected: all tests pass.

- [ ] **Step 8: Run related suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/index.js src/install/uxpInstaller.js tests/test-uxp-installer.js tests/test-install-cli.js package.json
git commit -m "Add UXP installation and client configuration commands"
```

### Task 3: Adobe UXP packaging

**Files:**
- Create: `scripts/package-uxp.mjs`
- Create: `tests/test-package-uxp.mjs`
- Modify: `package.json` to pin `@adobe/uxp-devtools-cli` and add `package:uxp`.
- Modify: `package-lock.json` through npm.
- Modify: `.gitignore` for `*.ccx` and `dist/`.

**Interfaces:**
- Consumes: Node `child_process`, `fs`, and `path`; local Adobe UXP CLI.
- Produces:
  - `packageUxp({ root, outputDir, cliPath, execFile = execFileSync, exists = existsSync })`
    returning `{ ccxPath, cliPath }`.
  - `npm run package:uxp` writing to `dist/uxp/`.

- [ ] **Step 1: Install the pinned Adobe CLI and inspect it**

Run:

```bash
npm install --save-dev --save-exact @adobe/uxp-devtools-cli@1.2.0
```

Inspect `node_modules/@adobe/uxp-devtools-cli/src/uxp.js` and its package command
to confirm the executable path and output naming. Run `npm audit --omit=dev` and
`npm audit`; any new production vulnerability blocks the task. If the old CLI
cannot run under the current Node version, record the exact error and use the
official UDT Package action as a documented maintainer-only fallback instead of
hand-building a `.ccx`.

- [ ] **Step 2: Write failing packaging tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageUxp } from '../scripts/package-uxp.mjs';

test('packageUxp invokes the Adobe CLI and returns the generated ccx', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'indesign-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ccx = join(root, 'out', 'com.ads.indesign-bridge-indesign.ccx');
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(ccx, 'package');
  const calls = [];
  const result = packageUxp({
    root,
    outputDir: join(root, 'out'),
    cliPath: 'C:\\uxp.cmd',
    execFile: (file, args) => calls.push({ file, args }),
  });
  assert.equal(result.ccxPath, ccx);
  assert.equal(calls[0].args[0], 'plugin');
  assert.equal(calls[0].args[1], 'package');
  assert.ok(calls[0].args.includes('ID'));
});

test('packageUxp fails when CLI produces no ccx', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'indesign-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => packageUxp({ root, outputDir: join(root, 'out'), cliPath: 'C:\\uxp.cmd', execFile: () => {} }), /did not produce/i);
});
```

- [ ] **Step 3: Run and verify RED**

Run: `node --test tests/test-package-uxp.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement the packaging script**

Create `scripts/package-uxp.mjs`. Locate the CLI in this order:
`UXP_CLI_PATH`, `node_modules/.bin/uxp.cmd` on Windows or `node_modules/.bin/uxp`
elsewhere, then `uxp` on `PATH`. Invoke:

```js
execFile(cliPath, ['plugin', 'package', '--manifest', join(root, 'plugin'), '--apps', 'ID', '--outputPath', outputDir], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
```

After success, find exactly one newly produced `.ccx`; if zero or multiple
ambiguous files exist, throw an actionable error. If the official CLI cannot
connect to the UXP Developer Service, invoke the pinned Adobe
`PluginPackageCommand.execute` implementation offline with strict service
validation stubbed and local package validation intact. Do not create a ZIP
manually.

Add npm script:

```json
"package:uxp": "node scripts/package-uxp.mjs"
```

- [ ] **Step 5: Run focused tests and a real package**

Run:

```bash
node --test tests/test-package-uxp.mjs
npm run package:uxp
```

Expected: tests pass and one `.ccx` is created under `dist/uxp/`. Inspect the
package with `tar -tf` or another ZIP reader; it must contain `manifest.json`,
`index.html`, and `index.js` at the package root expected by Adobe tooling.

- [ ] **Step 6: Commit**

```bash
git add scripts/package-uxp.mjs tests/test-package-uxp.mjs package.json package-lock.json .gitignore
git commit -m "Add production UXP package build"
```

### Task 4: Inno Setup installer

**Files:**
- Create: `installer/indesign-aaron.iss`
- Create: `installer/START-HERE.txt`
- Create: `tests/test-installer-source.js`
- Modify: `.gitignore` for installer output.

**Interfaces:**
- Consumes: Task 2 SEA CLI modes, Task 3 `.ccx`, and the SEA executable.
- Produces: `dist/installer/InDesignAaronV1.1-<version>-windows-setup-unsigned.exe` for local builds.

- [ ] **Step 1: Write failing source-contract tests**

Create tests that read `installer/indesign-aaron.iss` and assert:

```js
assert.match(source, /PrivilegesRequired=lowest/);
assert.match(source, /DefaultDirName=\{localappdata\}\\Programs\\InDesignAaronV1\.1/);
assert.match(source, /--configure-clients/);
assert.match(source, /--install-uxp/);
assert.match(source, /Install InDesign Copilot\.ccx/);
assert.match(source, /ArchitecturesAllowed=x64compatible/);
assert.doesNotMatch(source, /PrivilegesRequired=admin/);
```

These are contract tests for deployment-critical settings, not substitutes for
running the installer.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/test-installer-source.js`

Expected: FAIL because the installer source does not exist.

- [ ] **Step 3: Create the Inno script**

Implement `installer/indesign-aaron.iss` with these exact behaviors:

- `ArchitecturesAllowed=x64compatible`, `ArchitecturesInstallIn64BitMode=x64compatible`,
  `PrivilegesRequired=lowest`, `DefaultDirName={localappdata}\Programs\InDesignAaronV1.1`,
  `DisableProgramGroupPage=yes`, `CloseApplications=yes`.
- Define `AppVersion`, `SeaExe`, `CcxPath`, and `OutputDir` through preprocessor
  values supplied by the build script.
- Install the SEA executable, `.ccx`, `START-HERE.txt`, and generated
  `mcp-config.json`.
- Create Start Menu shortcuts for `InDesign Copilot`, `Check Installation`, and
  `Uninstall InDesignAaronV1.1`; create an optional Desktop shortcut only when
  the user selects it on the tasks page.
- Create a per-user Startup shortcut named `InDesignAaron Bridge.lnk` with
  parameters `--bridge` and `sw_showminnoactive`.
- Add a checked **Start InDesign Copilot after setup** task. When selected,
  launch the detected InDesign executable and the bridge; treat launch failure
  as a warning, not as a rollback.
- Use Pascal `Exec` wrappers to run:
  `--install-plugin`, `--install-uxp "<ccx>"`, and `--configure-clients`.
- If `--install-uxp` returns `3`, copy the `.ccx` to `{userdesktop}` as
  `Install InDesign Copilot.ccx` and record `PluginNeedsFallback := True`.
- If configuration returns nonzero, keep going and display the generated
  `mcp-config.json` path with instructions to restart the client.
- Add a finished-page message that separately reports server, plugin, MCP
  configuration, and bridge results. Never say the plugin installed when the
  fallback is pending.
- Uninstall runs `--remove-uxp "<ccx>"` and `--remove-clients`; a UPIA failure
  displays Creative Cloud **Manage Plugins** instructions. Inno removes its own
  shortcuts and application files normally.
- Use Inno Setup `CloseApplications=yes` and `RestartApplications=no` before
  removal. This targets only processes locking files inside `{app}`; do not use
  a machine-wide process-name kill, which could stop unrelated InDesign or MCP
  client processes.
- Detect InDesign by registry App Paths and common Adobe folders. If absent or
  older than 18.0, stop with a clear message before copying files.

Use this helper pattern:

```pascal
function RunApp(Parameters: string): Integer;
var
  ResultCode: Integer;
begin
  if not Exec(ExpandConstant('{app}\InDesignAaronV1.1.exe'), Parameters, '', SW_HIDE,
    ewWaitUntilTerminated, ResultCode) then
    ResultCode := 1;
  Log('InDesignAaron ' + Parameters + ' => ' + IntToStr(ResultCode));
  Result := ResultCode;
end;
```

- [ ] **Step 4: Write START-HERE.txt**

Include: how to open **Window → Plugins → InDesign Copilot**, how to enter a
model and API key in the panel, how to restart Claude/Cursor/Qoder after setup,
how to use the generated `mcp-config.json`, and what to do when
`Install InDesign Copilot.ccx` appears on the Desktop. State that SmartScreen
or Adobe trust prompts may appear and that API keys are not saved.

- [ ] **Step 5: Run source-contract tests**

Run: `node --test tests/test-installer-source.js`

Expected: all tests pass.

- [ ] **Step 6: Compile with a locally downloaded Inno Setup**

Download the official Inno Setup 7 installer from
`https://jrsoftware.org/isdl.php` into a temporary directory and install it
silently to that directory using `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART
/DIR=<temp> /CURRENTUSER`. Do not modify system directories. Invoke its
`ISCC.exe` with a temporary SEA executable and `.ccx` to compile the unsigned
installer. Record the compiler version and output size.

- [ ] **Step 7: Commit**

```bash
git add installer/indesign-aaron.iss installer/START-HERE.txt tests/test-installer-source.js .gitignore
git commit -m "Add per-user Inno Setup installer"
```

### Task 5: Build and fail-closed signing pipeline

**Files:**
- Create: `scripts/build-installer.mjs`
- Create: `scripts/sign-release.mjs`
- Create: `tests/test-sign-release.mjs`
- Modify: `package.json` with `build:installer` and `build:release`.
- Modify: `.gitignore` for `dist/`, `*.exe`, `*.ccx`, and common certificate files.

**Interfaces:**
- Consumes: `scripts/build-exe.mjs`, `scripts/smoke-mcp.mjs`, Task 3 packaging,
  Task 4 Inno source, and `SIGNTOOL_PATH`.
- Produces:
  - `npm run build:installer` producing a filename containing `unsigned`.
  - `npm run build:release` producing a signed filename without `unsigned`.
  - `signAndVerify({ files, mode, env, execFile })` returning
    `{ signed: string[], verified: string[] }`.

- [ ] **Step 1: Write failing signing tests**

Test that:

```js
assert.throws(() => signAndVerify({ files: ['C:\\Temp\\setup.exe'], mode: 'release', env: {}, execFile: () => {} }), /SIGNTOOL_PATH/);
assert.throws(() => signAndVerify({ files: ['C:\\Temp\\setup.exe'], mode: 'release', env: { SIGNTOOL_PATH: 'C:\\signtool.exe' }, execFile: () => {} }), /certificate|Azure/i);
```

Use a fake `execFile` to capture a certificate-mode invocation and assert it
contains `sign`, `/fd`, `sha256`, `/tr`, the RFC 3161 URL, and `/td`, `sha256`.
Use a fake that throws on `verify` and assert the function rejects instead of
returning success.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/test-sign-release.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement signing**

Create `scripts/sign-release.mjs` exporting `signAndVerify`. Supported modes:

- `certificate`: requires `CODE_SIGN_CERT_PATH`, `CODE_SIGN_CERT_PASSWORD`,
  `SIGNTOOL_PATH`, and optional `CODE_SIGN_TIMESTAMP_URL` defaulting to
  `http://timestamp.digicert.com`.
- `azure`: requires `SIGNTOOL_PATH`, `AZURE_SIGN_DLIB_PATH`,
  `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT`, and
  `AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE`; timestamp defaults to
  `http://timestamp.acs.microsoft.com`.

Build arguments without logging environment secrets. For each file, run
`sign`, then `verify /pa /tw`. Any failed command rejects the whole release.

Create `scripts/build-installer.mjs` that:

1. Requires Windows, x64, and Node 24+.
2. Runs `npm run build`, then signs the SEA executable first in release mode.
3. Runs `npm run smoke -- <sea exe>`.
4. Runs `npm run package:uxp`.
5. Locates Inno Setup from `INNO_SETUP_ISCC`, `PATH`, or a documented local
   installation path.
6. Writes `dist/installer/mcp-config.json` from the SEA executable path.
7. Invokes `ISCC.exe` with `/DAppVersion`, `/DSeaExe`, `/DCcxPath`, and
   `/DOutputDir`.
8. In release mode, signs and verifies the final setup executable.
9. Prints a JSON summary containing artifact paths, sizes, SHA-256 hashes, and
   `signed: true | false`.

Add scripts:

```json
"build:installer": "node scripts/build-installer.mjs",
"build:release": "node scripts/build-installer.mjs --release"
```

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/test-sign-release.mjs`

Expected: all tests pass.

- [ ] **Step 5: Run unsigned pipeline**

Run: `npm run build:installer`

Expected: SEA build, smoke test, `.ccx` packaging, and Inno compilation all
succeed; output filename contains `unsigned`; summary says `signed: false`.

- [ ] **Step 6: Verify release fails closed**

Run: `npm run build:release`

Expected: nonzero exit before artifact publication because no signing
credentials are configured. Confirm no unsigned artifact is relabeled as a
release.

- [ ] **Step 7: Commit**

```bash
git add scripts/build-installer.mjs scripts/sign-release.mjs tests/test-sign-release.mjs package.json .gitignore
git commit -m "Add installer build and signed release pipeline"
```

### Task 6: Documentation and full verification

**Files:**
- Modify: `README.md:22-118,195-220` for installer-first quick start and maintainer build commands.
- Modify: `CONTRIBUTING.md` with release/signing instructions.
- Modify: `docs/MCP_INSTRUCTIONS.md` if installer-configured client wording is needed.
- Modify: `package.json` test list for all new tests.

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: user-facing instructions that match implemented behavior.

- [ ] **Step 1: Update README quick start**

Lead with the installer:

1. Run InDesign once.
2. Download and run `InDesignAaronV1.1-<version>-windows-setup.exe` from a
   trusted release.
3. Accept Windows and Adobe prompts.
4. Restart Claude Desktop, Cursor, or Qoder.
5. Open InDesign **Window → Plugins → InDesign Copilot**.
6. Enter model and API key in the panel.

Keep source/portable instructions under **Manual / developer setup**. Remove
the claim that UXP Developer Tool is an end-user requirement. Explain the
`.ccx` fallback and that signed installers can still show SmartScreen until
publisher reputation is established.

- [ ] **Step 2: Update build documentation**

Document:

```bash
npm install
npm test
npm run build
npm run smoke
npm run package:uxp
npm run build:installer
npm run build:release
```

Explain Node 24+ for installer/release builds, the need for Inno Setup 7,
Adobe UXP CLI, and signing credentials for `build:release`. State that the
`.exe`, `.ccx`, and installer output are intentionally not committed.

- [ ] **Step 3: Run syntax and focused checks**

```bash
node --check src/install/mcpConfig.js
node --check src/install/uxpInstaller.js
node --check src/index.js
node --check scripts/package-uxp.mjs
node --check scripts/build-installer.mjs
node --check scripts/sign-release.mjs
node --test tests/test-mcp-config.js tests/test-uxp-installer.js tests/test-install-cli.js tests/test-package-uxp.mjs tests/test-installer-source.js tests/test-sign-release.mjs
```

Expected: all commands exit 0.

- [ ] **Step 4: Run full suite and audits**

```bash
npm test
npm run smoke
npm audit --omit=dev
npm audit
git status --short
```

Expected: all tests and smoke pass; zero known production vulnerabilities;
generated binaries and installer outputs are ignored; no unexpected files are
present.

- [ ] **Step 5: Independent review**

Dispatch a fresh reviewer to compare the complete diff against the spec. The
reviewer must verify config preservation, UPIA fallback truthfulness, uninstall
ownership, release fail-closed behavior, ignored artifacts, and documentation
claims. Fix valid findings with regression tests before completion.

- [ ] **Step 6: Commit**

```bash
git add README.md CONTRIBUTING.md docs/MCP_INSTRUCTIONS.md package.json
git commit -m "Document one-click installer and release workflow"
```

- [ ] **Step 7: Push feature branch**

```bash
git push https://github.com/aaronher1030-glitch/mcp-InDesign.git feature/portable-skill-runtime
```

Expected: push succeeds without force. Report the commit hash and explicitly
state which checks were not performed: public Authenticode signing, UPIA
installation on a clean target profile, and live InDesign panel validation.
