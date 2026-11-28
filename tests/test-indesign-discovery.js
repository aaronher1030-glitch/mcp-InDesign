import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectInDesign } from '../src/install/inDesignDiscovery.js';

const INDEX_URL = new URL('../src/index.js', import.meta.url);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'indesign-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeInDesign(root, folderName) {
  const directory = join(root, 'Adobe', folderName);
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, 'InDesign.exe');
  writeFileSync(executable, '');
  return executable;
}

test('packaged discovery prefers the installer-recorded executable over default roots', (t) => {
  const root = fixture(t);
  const runtimeDirectory = join(root, 'installed-app');
  mkdirSync(runtimeDirectory);
  const runtimeExecutable = join(runtimeDirectory, 'InDesignAaronV1.1.exe');
  writeFileSync(runtimeExecutable, '');
  const recordedExecutable = makeInDesign(join(root, 'recorded'), 'Adobe InDesign 2024');
  writeFileSync(join(runtimeDirectory, 'indesign-path.txt'), `${recordedExecutable}\r\n`);
  makeInDesign(join(root, 'default'), 'Adobe InDesign 2026');

  const installations = detectInDesign({
    executablePath: runtimeExecutable,
    roots: [join(root, 'default', 'Adobe')],
  });

  assert.deepEqual(installations, [{
    name: 'Adobe InDesign 2024',
    version: 2024,
    path: recordedExecutable,
  }]);
});

test('packaged discovery rejects stale, relative, and non-executable records before fallback', (t) => {
  const root = fixture(t);
  const runtimeDirectory = join(root, 'installed-app');
  mkdirSync(runtimeDirectory);
  const runtimeExecutable = join(runtimeDirectory, 'InDesignAaronV1.1.exe');
  writeFileSync(runtimeExecutable, '');
  const defaultExecutable = makeInDesign(join(root, 'default'), 'Adobe InDesign 2023');
  const defaultDirectory = dirname(defaultExecutable);
  const manifest = join(runtimeDirectory, 'indesign-path.txt');
  const staleExecutable = join(root, 'missing', 'InDesign.exe');
  const directoryRecord = dirname(defaultExecutable);
  const wrongName = join(root, 'default', 'Adobe', 'Adobe InDesign 2023', 'Other.exe');
  writeFileSync(wrongName, '');

  for (const record of [
    staleExecutable,
    'Adobe InDesign 2023\\InDesign.exe',
    directoryRecord,
    wrongName,
    '',
  ]) {
    writeFileSync(manifest, record);
    const installations = detectInDesign({
      executablePath: runtimeExecutable,
      roots: [join(root, 'default', 'Adobe')],
    });
    assert.deepEqual(installations, [{
      name: 'Adobe InDesign 2023',
      version: 2023,
      path: defaultDirectory,
    }]);
  }
});

test('source discovery keeps existing default-root behavior and ignores installer records', (t) => {
  const root = fixture(t);
  const runtimeDirectory = join(root, 'source');
  mkdirSync(runtimeDirectory);
  const runtimeExecutable = join(runtimeDirectory, 'InDesignAaronV1.1.exe');
  writeFileSync(runtimeExecutable, '');
  const recordedExecutable = makeInDesign(join(root, 'recorded'), 'Adobe InDesign 2025');
  writeFileSync(join(runtimeDirectory, 'indesign-path.txt'), recordedExecutable);
  const olderExecutable = makeInDesign(join(root, 'default'), 'Adobe InDesign 2022');
  const newerExecutable = makeInDesign(join(root, 'default'), 'Adobe InDesign 2024');

  const installations = detectInDesign({
    executablePath: null,
    roots: [join(root, 'default', 'Adobe')],
  });

  assert.deepEqual(installations.map((entry) => entry.path), [dirname(newerExecutable), dirname(olderExecutable)]);
});

test('packaged doctor passes the runtime executable to recorded-path discovery', () => {
  const source = readFileSync(INDEX_URL, 'utf8');
  assert.match(source, /detectInDesign\(\{\s*executablePath:\s*isPackaged\(\)\s*\?\s*process\.execPath\s*:\s*null,?\s*\}\)/);
  assert.match(source, /from\s+['"]\.\/install\/inDesignDiscovery\.js['"]/);
});
