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
import { join } from 'node:path';
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

function createWindowsCli(root) {
  const shim = join(root, 'node_modules', '.bin', 'uxp.cmd');
  const entry = join(root, nodeEntry);
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '@adobe', 'uxp-devtools-cli', 'src'), { recursive: true });
  writeFileSync(shim, '@echo off');
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

test('packageUxp falls back after a Windows shim EINVAL failure', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { shim } = createWindowsCli(root);
  let offlineCalls = 0;

  const result = await packageUxp({
    root,
    outputDir,
    cliPath: shim,
    processImpl: windowsProcess(),
    execFile: () => {
      throw Object.assign(new Error('spawnSync EINVAL'), { code: 'EINVAL' });
    },
    packageOffline: async () => {
      offlineCalls += 1;
      writePackage(outputDir);
      return [{ success: true, host: 'ID' }];
    },
  });

  assert.equal(offlineCalls, 1);
  assert.equal(result.ccxPath, join(outputDir, packageName));
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
  let offlineCalls = 0;

  await assert.rejects(
    packageUxp({
      root,
      outputDir: join(root, 'out'),
      cliPath: shim,
      processImpl: windowsProcess(),
      execFile: () => 'Plugin package command failed: invalid arguments',
      packageOffline: async () => {
        offlineCalls += 1;
        return [{ success: true, host: 'ID' }];
      },
    }),
    /did not produce.*\.ccx/i,
  );
  assert.equal(offlineCalls, 0);
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
  createWindowsCli(root);
  const envCli = join(root, 'custom-uxp.js');
  writeFileSync(envCli, '// custom CLI');
  const processImpl = windowsProcess();
  processImpl.env.UXP_CLI_PATH = envCli;
  const calls = [];

  await packageUxp({
    root,
    outputDir,
    processImpl,
    execFile: (file) => {
      calls.push(file);
      writePackage(outputDir);
      return '';
    },
  });

  assert.deepEqual(calls, [processImpl.execPath]);
});

test('packageUxp resolves the local Windows npm CLI to Adobe src/uxp.js', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { entry } = createWindowsCli(root);
  const calls = [];

  await packageUxp({
    root,
    outputDir,
    processImpl: windowsProcess(),
    execFile: (file, args) => {
      calls.push({ file, entry: args[0] });
      writePackage(outputDir);
      return '';
    },
  });

  assert.deepEqual(calls, [{ file: 'C:\\Program Files\\nodejs\\node.exe', entry }]);
});

test('packageUxp falls back to the pinned Node entry point on Windows PATH lookup', async (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const { entry } = createWindowsCli(root);
  const calls = [];

  await packageUxp({
    root,
    outputDir,
    processImpl: windowsProcess(),
    exists: () => false,
    execFile: (file, args) => {
      calls.push({ file, entry: args[0] });
      writePackage(outputDir);
      return '';
    },
  });

  assert.deepEqual(calls, [{ file: 'C:\\Program Files\\nodejs\\node.exe', entry }]);
});
