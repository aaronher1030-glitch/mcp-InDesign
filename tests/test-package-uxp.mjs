import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { packageUxp } from '../scripts/package-uxp.mjs';

const packageName = 'com.ads.indesign-bridge_ID.ccx';
const nodeEntry = join(
  'node_modules', '@adobe', 'uxp-devtools-cli', 'src', 'uxp.js',
);

function createRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'indesign-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePackage(outputDir, name = packageName, contents = 'package') {
  mkdirSync(outputDir, { recursive: true });
  const ccxPath = join(outputDir, name);
  writeFileSync(ccxPath, contents);
  return ccxPath;
}

function writeWindowsShim(shim, entry, dp0 = '%dp0%') {
  mkdirSync(dirname(shim), { recursive: true });
  const relativeEntry = win32.relative(win32.dirname(shim), entry);
  writeFileSync(shim, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "${dp0}\\${relativeEntry}" %*`,
    '',
  ].join('\r\n'));
}

function createWindowsCli(root, dp0) {
  const shim = join(root, 'node_modules', '.bin', 'uxp.cmd');
  const entry = join(root, nodeEntry);
  mkdirSync(dirname(entry), { recursive: true });
  writeWindowsShim(shim, entry, dp0);
  writeFileSync(entry, '// Adobe CLI entry point');
  return { shim, entry };
}

function windowsProcess(stdout = () => {}, stderr = () => {}) {
  return {
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: {},
    stdout: { write: stdout },
    stderr: { write: stderr },
  };
}

function createPlugin(root) {
  const pluginDir = join(root, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'manifest.json'), JSON.stringify({
    manifestVersion: 5,
    id: 'com.ads.indesign-bridge',
    name: 'InDesign Copilot',
    version: '1.1.0',
    main: 'index.html',
    host: { app: 'ID', minVersion: '18.0' },
    entrypoints: [{
      type: 'panel',
      id: 'mainPanel',
      label: { default: 'InDesign Copilot' },
    }],
    requiredPermissions: {},
  }));
  writeFileSync(join(pluginDir, 'index.html'), '<html></html>');
  writeFileSync(join(pluginDir, 'index.js'), '// plugin');
  return pluginDir;
}

function zipRootEntries(ccxPath) {
  const archive = readFileSync(ccxPath);
  const centralDirectory = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const entries = [];
  let offset = archive.indexOf(centralDirectory);
  while (offset !== -1) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push(archive.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset = archive.indexOf(centralDirectory, offset + 46 + nameLength + extraLength + commentLength);
  }
  return entries.sort();
}

const serviceFailure = 'Plugin package command failed: Error: Cound not connect to the UXP Developer Service. Start the cli service and try again.';

test('packageUxp invokes the Windows npm shim through the Adobe Node entry point', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const ccxPath = join(outputDir, packageName);
  const { shim, entry } = createWindowsCli(root);
  const calls = [];
  let offlineCalls = 0;

  const result = await packageUxp({
    root,
    outputDir,
    cliPath: shim,
    processImpl: windowsProcess(),
    execFile: (file, args, options) => {
      calls.push({ file, args, options });
      writePackage(outputDir);
      return '';
    },
    packageOffline: async () => {
      offlineCalls += 1;
      throw new Error('offline packager must not run after CLI success');
    },
  });

  assert.deepEqual(result, { ccxPath, cliPath: entry });
  assert.equal(offlineCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(calls[0].args, [
    entry,
    'plugin',
    'package',
    '--manifest', join(root, 'plugin', 'manifest.json'),
    '--apps', 'ID',
    '--outputPath', outputDir,
  ]);
  assert.deepEqual(calls[0].options, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
});

test('packageUxp falls back to the injected offline packager after service failure', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const ccxPath = join(outputDir, packageName);
  const { shim } = createWindowsCli(root);
  const offlineCalls = [];
  const stdout = [];

  const result = await packageUxp({
    root,
    outputDir,
    cliPath: shim,
    processImpl: windowsProcess((text) => stdout.push(text)),
    execFile: () => serviceFailure,
    packageOffline: async (params) => {
      offlineCalls.push(params);
      writePackage(outputDir);
      return [{ success: true, host: 'ID' }];
    },
  });

  assert.equal(result.ccxPath, ccxPath);
  assert.deepEqual(offlineCalls, [{
    manifest: join(root, 'plugin', 'manifest.json'),
    packageDir: outputDir,
    apps: ['ID'],
  }]);
  assert.equal(stdout.join(''), serviceFailure);
});

test('packageUxp inspects and forwards stderr after successful CLI execution', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  const stdout = [];
  const stderr = [];
  let offlineCalls = 0;

  const result = await packageUxp({
    root,
    outputDir,
    cliPath: shim,
    processImpl: windowsProcess((text) => stdout.push(text), (text) => stderr.push(text)),
    execFile: () => ({ status: 0, signal: null, stdout: 'plugin package started\n', stderr: serviceFailure }),
    packageOffline: async () => {
      offlineCalls += 1;
      writePackage(outputDir);
      return [{ success: true, host: 'ID' }];
    },
  });

  assert.equal(result.ccxPath, join(outputDir, packageName));
  assert.equal(offlineCalls, 1);
  assert.equal(stdout.join(''), 'plugin package started\n');
  assert.match(stderr.join(''), /Cound not connect to the UXP Developer Service/);
  assert.match(stderr.join(''), /using Adobe's pinned offline package command/);
});

test('packageUxp does not fall back after an unrelated Windows EINVAL failure', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  const cliError = Object.assign(new Error('spawnSync EINVAL'), { code: 'EINVAL' });
  let offlineCalls = 0;

  await assert.rejects(
    packageUxp({
      root,
      outputDir,
      cliPath: shim,
      processImpl: windowsProcess(),
      execFile: () => ({
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: cliError,
      }),
      packageOffline: async () => {
        offlineCalls += 1;
        writePackage(outputDir);
        return [{ success: true, host: 'ID' }];
      },
    }),
    (error) => error === cliError,
  );
  assert.equal(offlineCalls, 0);
});

test('packageUxp requires an affirmative service-connection failure diagnostic', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  let offlineCalls = 0;

  await assert.rejects(
    packageUxp({
      root,
      outputDir,
      cliPath: shim,
      processImpl: windowsProcess(),
      execFile: () => 'Plugin package command failed: connect to the UXP Developer Service and retry',
      packageOffline: async () => {
        offlineCalls += 1;
        writePackage(outputDir);
        return [{ success: true, host: 'ID' }];
      },
    }),
    /did not produce.*\.ccx/i,
  );
  assert.equal(offlineCalls, 0);
});

test('packageUxp rejects every unsuccessful offline package result', async (t) => {
  const root = createRoot(t);
  const { shim } = createWindowsCli(root);

  for (const results of [
    [],
    [{ success: false, host: 'ID', error: new Error('local validation failed') }],
    [{ success: true, host: 'PS' }, { success: false, host: 'ID' }],
  ]) {
    await assert.rejects(
      packageUxp({
        root,
        outputDir: join(root, 'out'),
        cliPath: shim,
        processImpl: windowsProcess(),
        execFile: () => serviceFailure,
        packageOffline: async () => results,
      }),
      /offline.*(did not return|failed)|every.*succeed/i,
    );
  }
});

test('service fallback uses Adobe offline packaging and preserves ZIP root entries', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  createPlugin(root);

  const result = await packageUxp({
    root,
    outputDir,
    cliPath: shim,
    processImpl: windowsProcess(),
    execFile: () => serviceFailure,
  });

  assert.equal(result.ccxPath, join(outputDir, packageName));
  assert.deepEqual(zipRootEntries(result.ccxPath), ['index.html', 'index.js', 'manifest.json']);
});

test('packageUxp does not hide a non-service CLI failure with offline packaging', async (t) => {
  const root = createRoot(t);
  const { shim } = createWindowsCli(root);
  const cliError = Object.assign(new Error('Plugin package command failed: invalid arguments'), {
    code: 'CLI_FAILED',
    stdout: 'plugin package\n',
    stderr: 'invalid arguments\n',
  });
  const stdout = [];
  const stderr = [];
  let offlineCalls = 0;

  await assert.rejects(
    packageUxp({
      root,
      outputDir: join(root, 'out'),
      cliPath: shim,
      processImpl: windowsProcess((text) => stdout.push(text), (text) => stderr.push(text)),
      execFile: () => { throw cliError; },
      packageOffline: async () => {
        offlineCalls += 1;
        return [{ success: true, host: 'ID' }];
      },
    }),
    (error) => error === cliError,
  );
  assert.equal(offlineCalls, 0);
  assert.equal(stdout.join(''), cliError.stdout);
  assert.equal(stderr.join(''), cliError.stderr);
});

test('packageUxp rejects a nonzero CLI result without offline packaging', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  const stdout = [];
  const stderr = [];
  let offlineCalls = 0;

  await assert.rejects(
    packageUxp({
      root,
      outputDir,
      cliPath: shim,
      processImpl: windowsProcess((text) => stdout.push(text), (text) => stderr.push(text)),
      execFile: () => ({
        status: 2,
        signal: null,
        stdout: 'plugin package\n',
        stderr: 'invalid arguments\n',
      }),
      packageOffline: async () => {
        offlineCalls += 1;
        writePackage(outputDir);
        return [{ success: true, host: 'ID' }];
      },
    }),
    /CLI exited with status 2/,
  );
  assert.equal(offlineCalls, 0);
  assert.equal(stdout.join(''), 'plugin package\n');
  assert.equal(stderr.join(''), 'invalid arguments\n');
});

test('packageUxp fails when CLI produces no ccx', async (t) => {
  const root = createRoot(t);
  const { shim } = createWindowsCli(root);
  await assert.rejects(
    packageUxp({
      root,
      outputDir: join(root, 'out'),
      cliPath: shim,
      processImpl: windowsProcess(),
      execFile: () => '',
      packageOffline: async () => {
        throw new Error('offline packager must not run without a service failure');
      },
    }),
    /did not produce.*\.ccx/i,
  );
});

test('packageUxp fails when CLI produces multiple ambiguous ccx files', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  await assert.rejects(
    packageUxp({
      root,
      outputDir,
      cliPath: shim,
      processImpl: windowsProcess(),
      execFile: () => {
        writePackage(outputDir, packageName);
        writePackage(outputDir, 'another_ID.ccx');
        return '';
      },
    }),
    /multiple.*\.ccx|ambiguous.*\.ccx/i,
  );
});

test('packageUxp ignores stale ccx files when finding the new package', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  writePackage(outputDir, 'a-stale.ccx', 'old package');
  const result = await packageUxp({
    root,
    outputDir,
    cliPath: shim,
    processImpl: windowsProcess(),
    execFile: () => {
      writePackage(outputDir);
      return '';
    },
  });

  assert.equal(result.ccxPath, join(outputDir, packageName));
});

test('packageUxp recognizes an overwritten ccx as newly produced', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  const ccxPath = writePackage(outputDir, packageName, 'old package');
  const result = await packageUxp({
    root,
    outputDir,
    cliPath: shim,
    processImpl: windowsProcess(),
    execFile: () => {
      writePackage(outputDir, packageName, 'new package contents');
      return '';
    },
  });

  assert.equal(result.ccxPath, ccxPath);
});

test('packageUxp uses UXP_CLI_PATH before the local npm CLI', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { entry: localEntry } = createWindowsCli(root);
  const envCli = join(root, 'custom-uxp.js');
  writeFileSync(envCli, '// custom CLI');
  const processImpl = windowsProcess();
  processImpl.env.UXP_CLI_PATH = envCli;
  const calls = [];

  await packageUxp({
    root,
    outputDir,
    processImpl,
    execFile: (file, args) => {
      calls.push({ file, entry: args[0] });
      writePackage(outputDir);
      return '';
    },
  });

  assert.deepEqual(calls, [{ file: processImpl.execPath, entry: envCli }]);
  assert.notEqual(envCli, localEntry);
});

test('packageUxp resolves the local Windows npm CLI before Windows PATH', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { entry } = createWindowsCli(root);
  const globalBin = join(root, 'global bin');
  const globalEntry = join(root, 'global-uxp.js');
  writeWindowsShim(join(globalBin, 'uxp.cmd'), globalEntry);
  writeFileSync(globalEntry, '// global CLI');
  const processImpl = windowsProcess();
  processImpl.env.Path = `"${globalBin}"`;
  const calls = [];

  await packageUxp({
    root,
    outputDir,
    processImpl,
    execFile: (file, args) => {
      calls.push({ file, entry: args[0] });
      writePackage(outputDir);
      return '';
    },
  });

  assert.deepEqual(calls, [{ file: 'C:\\Program Files\\nodejs\\node.exe', entry }]);
});

test('packageUxp selects a distinct global CLI from a quoted Windows PATH yarn shim', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim: localShim, entry: localEntry } = createWindowsCli(root);
  rmSync(localShim);
  const globalBin = join(root, 'global bin');
  const globalEntry = join(root, 'global-uxp.js');
  writeWindowsShim(join(globalBin, 'uxp.cmd'), globalEntry, '%~dp0%');
  writeFileSync(globalEntry, '// distinct global CLI');
  const processImpl = windowsProcess();
  processImpl.env.Path = `"${globalBin}"`;
  const calls = [];

  const result = await packageUxp({
    root,
    outputDir,
    processImpl,
    execFile: (file, args) => {
      calls.push({ file, entry: args[0] });
      writePackage(outputDir);
      return '';
    },
  });

  assert.deepEqual(calls, [{ file: processImpl.execPath, entry: globalEntry }]);
  assert.equal(result.cliPath, globalEntry);
  assert.notEqual(result.cliPath, localEntry);
});

test('packageUxp rejects an unsupported Windows CLI shim without using the pinned entry', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  createWindowsCli(root);
  const unsupportedShim = join(root, 'unsupported.cmd');
  writeFileSync(unsupportedShim, '@echo off\r\nnode "%dp0%\\custom.js" %*\r\n');
  const processImpl = windowsProcess();
  processImpl.env.UXP_CLI_PATH = unsupportedShim;
  let offlineCalls = 0;

  await assert.rejects(
    packageUxp({
      root,
      outputDir,
      processImpl,
      execFile: () => {
        writePackage(outputDir);
        return '';
      },
      packageOffline: async () => { offlineCalls += 1; },
    }),
    /Unsupported Windows UXP CLI shim/,
  );
  assert.equal(offlineCalls, 0);
});

test('packageUxp fails when the Windows PATH has no UXP CLI', async (t) => {
  const root = createRoot(t);
  const { shim } = createWindowsCli(root);
  rmSync(shim);

  await assert.rejects(
    packageUxp({
      root,
      outputDir: join(root, 'out'),
      processImpl: windowsProcess(),
      execFile: () => '',
    }),
    /Cannot find.*UXP CLI.*PATH/,
  );
});
