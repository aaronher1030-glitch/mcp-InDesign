import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageUxp } from '../scripts/package-uxp.mjs';

const packageName = 'com.ads.indesign-bridge_ID.ccx';

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

function withoutCliPathOverride(t) {
  const previous = process.env.UXP_CLI_PATH;
  delete process.env.UXP_CLI_PATH;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.UXP_CLI_PATH;
    } else {
      process.env.UXP_CLI_PATH = previous;
    }
  });
}

test('packageUxp invokes the Adobe CLI and returns the generated ccx', (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const ccxPath = join(outputDir, packageName);
  const calls = [];
  const result = packageUxp({
    root,
    outputDir,
    cliPath: 'C:\\uxp.cmd',
    execFile: (file, args, options) => {
      calls.push({ file, args, options });
      writePackage(outputDir);
    },
  });

  assert.deepEqual(result, { ccxPath, cliPath: 'C:\\uxp.cmd' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\uxp.cmd');
  assert.deepEqual(calls[0].args, [
    'plugin',
    'package',
    '--manifest', join(root, 'plugin', 'manifest.json'),
    '--apps', 'ID',
    '--outputPath', outputDir,
  ]);
  assert.deepEqual(calls[0].options, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
});

test('packageUxp fails when CLI produces no ccx', (t) => {
  const root = createRoot(t);
  assert.throws(
    () => packageUxp({
      root,
      outputDir: join(root, 'out'),
      cliPath: 'C:\\uxp.cmd',
      execFile: () => {},
    }),
    /did not produce.*\.ccx/i,
  );
});

test('packageUxp fails when CLI produces multiple ambiguous ccx files', (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  assert.throws(
    () => packageUxp({
      root,
      outputDir,
      cliPath: 'C:\\uxp.cmd',
      execFile: () => {
        writePackage(outputDir, packageName);
        writePackage(outputDir, 'another_ID.ccx');
      },
    }),
    /multiple.*\.ccx|ambiguous.*\.ccx/i,
  );
});

test('packageUxp ignores stale ccx files when finding the new package', (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  writePackage(outputDir, 'a-stale.ccx', 'old package');
  const result = packageUxp({
    root,
    outputDir,
    cliPath: 'C:\\uxp.cmd',
    execFile: () => writePackage(outputDir),
  });

  assert.equal(result.ccxPath, join(outputDir, packageName));
});

test('packageUxp recognizes an overwritten ccx as newly produced', (t) => {
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const ccxPath = writePackage(outputDir, packageName, 'old package');
  const result = packageUxp({
    root,
    outputDir,
    cliPath: 'C:\\uxp.cmd',
    execFile: () => writePackage(outputDir, packageName, 'new package contents'),
  });

  assert.equal(result.ccxPath, ccxPath);
});

test('packageUxp uses UXP_CLI_PATH before the local npm CLI', (t) => {
  withoutCliPathOverride(t);
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const localCli = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'uxp.cmd' : 'uxp');
  const envCli = join(root, 'custom-uxp.cmd');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(localCli, 'local');
  writeFileSync(envCli, 'environment');
  process.env.UXP_CLI_PATH = envCli;
  const calls = [];

  packageUxp({
    root,
    outputDir,
    execFile: (file) => {
      calls.push(file);
      writePackage(outputDir);
    },
  });

  assert.deepEqual(calls, [envCli]);
});

test('packageUxp uses the local npm CLI when no override is set', (t) => {
  withoutCliPathOverride(t);
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const localCli = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'uxp.cmd' : 'uxp');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(localCli, 'local');
  const calls = [];

  packageUxp({
    root,
    outputDir,
    execFile: (file) => {
      calls.push(file);
      writePackage(outputDir);
    },
  });

  assert.deepEqual(calls, [localCli]);
});

test('packageUxp falls back to uxp on PATH when no local CLI exists', (t) => {
  withoutCliPathOverride(t);
  const root = createRoot(t);
  const outputDir = join(root, 'out');
  const calls = [];

  packageUxp({
    root,
    outputDir,
    exists: () => false,
    execFile: (file) => {
      calls.push(file);
      writePackage(outputDir);
    },
  });

  assert.deepEqual(calls, ['uxp']);
});
