import test from 'node:test';
import assert from 'node:assert/strict';
import { findUpia, installCcx, removeCcx } from '../src/install/uxpInstaller.js';

const STANDARD_UPIA = 'C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe';
const X86_UPIA = 'C:\\Program Files (x86)\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe';

test('findUpia checks standard Creative Cloud paths', () => {
  const calls = [];
  const actual = findUpia({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: (path) => { calls.push(path); return path === STANDARD_UPIA; },
  });
  assert.equal(actual, STANDARD_UPIA);
  assert.ok(calls.includes(STANDARD_UPIA));
});

test('findUpia checks the x86 Creative Cloud path when needed', () => {
  const actual = findUpia({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: (path) => path === X86_UPIA,
  });
  assert.equal(actual, X86_UPIA);
});

test('findUpia ignores non-absolute environment roots', () => {
  const calls = [];
  const actual = findUpia({
    platform: 'win32',
    env: { ProgramFiles: 'Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: (path) => { calls.push(path); return path === X86_UPIA; },
  });
  assert.equal(actual, X86_UPIA);
  assert.deepEqual(calls, [X86_UPIA]);
});

test('findUpia returns null when no documented path exists', () => {
  assert.equal(findUpia({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: () => false,
  }), null);
});

test('findUpia returns null off Windows', () => {
  assert.equal(findUpia({ platform: 'linux', env: {}, exists: () => true }), null);
});

test('installCcx invokes UPIA with /install and waits', () => {
  const calls = [];
  const result = installCcx({
    ccxPath: 'C:\\Temp\\plugin.ccx',
    upiaPath: 'C:\\UPIA.exe',
    execFile: (file, args, options) => calls.push({ file, args, options }),
  });
  assert.equal(result.status, 'installed');
  assert.equal(result.upiaPath, 'C:\\UPIA.exe');
  assert.deepEqual(calls, [{
    file: 'C:\\UPIA.exe',
    args: ['/install', 'C:\\Temp\\plugin.ccx'],
    options: { stdio: 'inherit', windowsHide: true },
  }]);
});

test('removeCcx invokes UPIA with /remove and waits', () => {
  const calls = [];
  const result = removeCcx({
    ccxPath: 'C:\\Temp\\plugin.ccx',
    upiaPath: 'C:\\UPIA.exe',
    execFile: (file, args, options) => calls.push({ file, args, options }),
  });
  assert.equal(result.status, 'removed');
  assert.equal(result.upiaPath, 'C:\\UPIA.exe');
  assert.deepEqual(calls, [{
    file: 'C:\\UPIA.exe',
    args: ['/remove', 'C:\\Temp\\plugin.ccx'],
    options: { stdio: 'inherit', windowsHide: true },
  }]);
});

test('missing UPIA requests ccx fallback for install and remove', () => {
  for (const operation of [installCcx, removeCcx]) {
    const result = operation({ ccxPath: 'C:\\Temp\\plugin.ccx', upiaPath: null });
    assert.equal(result.status, 'fallback_required');
    assert.equal(result.upiaPath, null);
    assert.match(result.error, /UPIA is not installed/);
  }
});

test('UPIA failure requests ccx fallback and reports the error', () => {
  for (const operation of [installCcx, removeCcx]) {
    const result = operation({
      ccxPath: 'C:\\Temp\\plugin.ccx',
      upiaPath: 'C:\\UPIA.exe',
      execFile: () => { throw new Error('access denied'); },
    });
    assert.equal(result.status, 'fallback_required');
    assert.equal(result.upiaPath, 'C:\\UPIA.exe');
    assert.equal(result.error, 'access denied');
  }
});
