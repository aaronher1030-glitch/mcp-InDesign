import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBackup, restoreOriginal } from '../src/skills/backup.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'indesign-backup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const originalPath = join(dir, 'brief.indd');
  writeFileSync(originalPath, 'original');
  const backup = createBackup({
    document: { filePath: originalPath, saved: true, modified: false },
    artifactDir: join(dir, 'artifacts'),
  });
  return { dir, originalPath, backup };
}

test('copies a saved document with hashes and file identity, and refuses stale restore before tool calls', async (t) => {
  const { originalPath, backup } = fixture(t);
  const expectedHash = createHash('sha256').update('original').digest('hex');
  assert.equal(readFileSync(backup.backupPath, 'utf8'), 'original');
  assert.equal(backup.sourceSha256, expectedHash);
  assert.equal(backup.backupSha256, expectedHash);
  assert.equal(backup.hashAlgorithm, 'sha256');
  assert.equal(backup.size, 8);
  assert.ok(backup.sourceIdentity.dev !== undefined);
  assert.ok(backup.sourceIdentity.ino !== undefined);
  assert.ok(backup.backupIdentity.dev !== undefined);
  assert.ok(backup.backupIdentity.ino !== undefined);
  let calls = 0;
  await assert.rejects(
    () => restoreOriginal({
      backupPath: backup.backupPath,
      originalPath,
      metadata: backup,
      currentFingerprint: 'changed',
      expectedFingerprint: 'expected',
      callTool: async () => { calls += 1; },
    }),
    /ROLLBACK_CONFLICT/,
  );
  assert.equal(calls, 0);
});

test('refuses to back up an unsaved document', () => {
  assert.throws(
    () => createBackup({ document: { filePath: 'Unsaved' }, artifactDir: 'C:/tmp/artifacts' }),
    /BACKUP_REQUIRED/,
  );
});

test('opens and verifies the backup before closing the exact original document without saving it', async (t) => {
  const { originalPath, backup } = fixture(t);
  const calls = [];
  let opened = false;
  const result = await restoreOriginal({
    backupPath: backup.backupPath,
    originalPath,
    metadata: backup,
    currentFingerprint: 'same',
    expectedFingerprint: 'same',
    expectedDocumentFingerprint: 'baseline',
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'open_document') opened = true;
      return { success: true, result: {} };
    },
    inspect: async () => {
      assert.equal(opened, true);
      return { document: { filePath: backup.backupPath }, fingerprint: 'baseline' };
    },
  });
  assert.equal(result.restored, true);
  assert.deepEqual(calls.map((call) => call.name), ['open_document', 'execute_indesign_code']);
  assert.equal(calls[0].args.filePath, backup.backupPath);
  assert.equal(calls[1].args.dangerousConfirmation, 'I understand this executes arbitrary InDesign code');
  assert.ok(calls[1].args.code.includes(JSON.stringify(originalPath)));
  assert.ok(calls[1].args.code.includes('SaveOptions.no'));
  assert.equal(calls.some((call) => call.name === 'save_document' || call.name === 'close_document'), false);
});

test('backup fails closed when saved/modified state is absent or unsafe', (t) => {
  const { dir, originalPath } = fixture(t);
  for (const state of [{}, { saved: false, modified: false }, { saved: true, modified: true }]) {
    assert.throws(
      () => createBackup({ document: { filePath: originalPath, ...state }, artifactDir: join(dir, 'artifacts') }),
      /BACKUP_REQUIRED/,
    );
  }
});

test('backup and artifact directories reject paths outside the temporary root', (t) => {
  const { dir, originalPath, backup } = fixture(t);
  assert.throws(
    () => createBackup({ document: { filePath: originalPath, saved: true, modified: false }, artifactDir: resolve(dir, '..', '..') }),
    /BACKUP_REQUIRED/,
  );
  assert.equal(statSync(backup.backupPath).isFile(), true);
});

test('malformed open and exact-close responses are rollback failures', async (t) => {
  const { originalPath, backup } = fixture(t);
  for (const response of [undefined, {}, { success: false, error: 'nope' }]) {
    await assert.rejects(
      () => restoreOriginal({
        backupPath: backup.backupPath,
        originalPath,
        metadata: backup,
        currentFingerprint: 'same', expectedFingerprint: 'same',
        expectedDocumentFingerprint: 'baseline',
        callTool: async (name) => name === 'execute_indesign_code' ? response : { success: true, result: {} },
        inspect: async () => ({ document: { filePath: backup.backupPath }, fingerprint: 'baseline' }),
      }),
      /ROLLBACK_FAILED/,
    );
  }
  await assert.rejects(
    () => restoreOriginal({
      backupPath: backup.backupPath,
      originalPath,
      metadata: backup,
      currentFingerprint: 'same', expectedFingerprint: 'same',
      expectedDocumentFingerprint: 'baseline',
      callTool: async () => ({}),
      inspect: async () => ({ document: { filePath: backup.backupPath }, fingerprint: 'baseline' }),
    }),
    /ROLLBACK_FAILED/,
  );
});

test('restore rejects a tampered backup before opening or closing any document', async (t) => {
  const { originalPath, backup } = fixture(t);
  writeFileSync(backup.backupPath, 'unrelated document');
  const calls = [];
  await assert.rejects(
    () => restoreOriginal({
      backupPath: backup.backupPath,
      originalPath,
      metadata: backup,
      currentFingerprint: 'same', expectedFingerprint: 'same',
      expectedDocumentFingerprint: 'baseline',
      callTool: async (name) => { calls.push(name); return { success: true }; },
      inspect: async () => ({ document: { filePath: backup.backupPath }, fingerprint: 'baseline' }),
    }),
    /ROLLBACK_FAILED.*integrity/i,
  );
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(originalPath, 'utf8'), 'original');
});

test('restore rejects replaced backup paths and missing integrity metadata before tool calls', async (t) => {
  const { dir, originalPath, backup } = fixture(t);
  const calls = [];
  const options = {
    backupPath: backup.backupPath,
    originalPath,
    currentFingerprint: 'same', expectedFingerprint: 'same',
    expectedDocumentFingerprint: 'baseline',
    callTool: async (name) => { calls.push(name); return { success: true }; },
    inspect: async () => ({ document: { filePath: backup.backupPath }, fingerprint: 'baseline' }),
  };
  await assert.rejects(() => restoreOriginal({ ...options, metadata: undefined }), /ROLLBACK_FAILED.*metadata/i);
  const artifactDir = join(dir, 'artifacts');
  const movedArtifacts = join(dir, 'moved-artifacts');
  renameSync(artifactDir, movedArtifacts);
  const unrelatedDir = join(dir, 'unrelated-artifacts');
  mkdirSync(unrelatedDir);
  writeFileSync(join(unrelatedDir, backup.backupPath.split(/[\\/]/).at(-1)), 'unrelated');
  symlinkSync(unrelatedDir, artifactDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => restoreOriginal({ ...options, metadata: backup }), /ROLLBACK_FAILED.*integrity/i);
  assert.deepEqual(calls, []);
});

test('backup creation rejects a source reached through a symlink or junction', (t) => {
  const { dir, originalPath } = fixture(t);
  const linkedDir = join(dir, 'linked-documents');
  symlinkSync(dir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
  const linkPath = join(linkedDir, originalPath.split(/[\\/]/).at(-1));
  assert.throws(
    () => createBackup({ document: { filePath: linkPath, saved: true, modified: false }, artifactDir: join(dir, 'linked-artifacts') }),
    /BACKUP_REQUIRED.*symlink/i,
  );
});

test('restore verifies the reopened path and baseline fingerprint before exact close', async (t) => {
  const { originalPath, backup } = fixture(t);
  for (const reopened of [
    { document: { filePath: originalPath }, fingerprint: 'baseline' },
    { document: { filePath: backup.backupPath }, fingerprint: 'changed' },
  ]) {
    const calls = [];
    await assert.rejects(
      () => restoreOriginal({
        backupPath: backup.backupPath,
        originalPath,
        metadata: backup,
        currentFingerprint: 'same', expectedFingerprint: 'same',
        expectedDocumentFingerprint: 'baseline',
        callTool: async (name) => { calls.push(name); return { success: true }; },
        inspect: async () => reopened,
      }),
      /ROLLBACK_FAILED.*reopened/i,
    );
    assert.deepEqual(calls, ['open_document']);
  }
});
