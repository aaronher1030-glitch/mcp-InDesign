import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const HASH_ALGORITHM = 'sha256';

function workflowError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isUsablePath(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && !/^unsaved/i.test(value)
    && !/^untitled$/i.test(value.trim());
}

function pathKey(value) {
  const normalized = resolve(String(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isTemporaryArtifactDirectory(artifactDir) {
  if (!isUsablePath(artifactDir)) return false;
  const root = realpathSync(tmpdir());
  const directory = resolve(artifactDir);
  const path = relative(root, directory);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function assertNoSymlinkComponents(filePath, { allowMissing = false } = {}) {
  const target = resolve(filePath);
  const root = parse(target).root;
  let current = root;
  for (const part of relative(root, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Refusing symlink path component: ${current}`);
  }
}

function ensurePrivateDirectory(directory) {
  const root = realpathSync(tmpdir());
  const target = resolve(directory);
  if (!isTemporaryArtifactDirectory(target)) {
    throw workflowError('BACKUP_REQUIRED', 'Backups must be stored in a private subdirectory of the OS temporary directory.');
  }
  let current = root;
  for (const part of relative(root, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw workflowError('BACKUP_REQUIRED', 'The backup directory must be a private non-symlink directory.');
    }
  }
  if (pathKey(realpathSync(target)) !== pathKey(target)) {
    throw workflowError('BACKUP_REQUIRED', 'The backup directory must be a private non-symlink directory.');
  }
  chmodSync(target, 0o700);
}

function fileIdentity(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function openNoFollow(filePath, flags, mode, { allowMissing = false } = {}) {
  assertNoSymlinkComponents(filePath, { allowMissing });
  const fd = openSync(filePath, flags | NO_FOLLOW, mode);
  try {
    const opened = fstatSync(fd);
    const named = lstatSync(filePath);
    if (named.isSymbolicLink() || !opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
      throw new Error('The file identity changed while it was being opened.');
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readHashedFile(filePath) {
  const fd = openNoFollow(filePath, constants.O_RDONLY);
  try {
    const before = fstatSync(fd);
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameIdentity(fileIdentity(before), fileIdentity(after))) {
      throw new Error('The file changed while it was being read.');
    }
    return {
      contents,
      sha256: createHash(HASH_ALGORITHM).update(contents).digest('hex'),
      identity: fileIdentity(after),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Copy a verifiably saved, unmodified .indd into a private temporary session
 * directory. Source and backup are read through no-follow file handles where
 * the platform supports them. Never saves or writes to the original document.
 */
export function createBackup({ document, artifactDir }) {
  const filePath = document?.filePath;
  if (document?.saved !== true || document?.modified !== false) {
    throw workflowError(
      'BACKUP_REQUIRED',
      'High-risk edits require explicit saved:true and modified:false document state.',
    );
  }
  if (!isUsablePath(filePath)) {
    throw workflowError(
      'BACKUP_REQUIRED',
      'High-risk edits need a saved document so a backup can be created before the edit.',
    );
  }

  const originalPath = resolve(filePath);
  let source;
  try {
    assertNoSymlinkComponents(originalPath);
    source = readHashedFile(originalPath);
  } catch (error) {
    throw workflowError('BACKUP_REQUIRED', `The document file is not safely readable: ${error.message}`);
  }

  try {
    ensurePrivateDirectory(artifactDir);
  } catch (error) {
    if (error.code === 'BACKUP_REQUIRED') throw error;
    throw workflowError('BACKUP_REQUIRED', `A private backup directory could not be created: ${error.message}`);
  }

  const directory = resolve(artifactDir);
  const backupPath = join(directory, `${randomUUID()}-${basename(originalPath)}`);
  let fd;
  try {
    fd = openNoFollow(backupPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600, { allowMissing: true });
    writeFileSync(fd, source.contents);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  try {
    const copied = readHashedFile(backupPath);
    if (copied.sha256 !== source.sha256 || copied.contents.length !== source.contents.length) {
      throw new Error('The backup hash does not match the source.');
    }
    return {
      backupPath,
      originalPath,
      hashAlgorithm: HASH_ALGORITHM,
      sourceSha256: source.sha256,
      backupSha256: copied.sha256,
      sourceIdentity: source.identity,
      backupIdentity: copied.identity,
      size: copied.contents.length,
    };
  } catch (error) {
    throw workflowError('BACKUP_REQUIRED', `The backup could not be verified: ${error.message}`);
  }
}

function verifyRecordedFile(filePath, expectedHash, expectedIdentity) {
  try {
    assertNoSymlinkComponents(filePath);
    const current = readHashedFile(filePath);
    if (current.sha256 !== expectedHash || !sameIdentity(current.identity, expectedIdentity)) {
      throw new Error('Hash or file identity does not match the recorded metadata.');
    }
  } catch (error) {
    throw workflowError('ROLLBACK_FAILED', `Backup/source integrity verification failed: ${error.message}`);
  }
}

function verifyBackup({ backupPath, originalPath, metadata }) {
  if (!metadata || metadata.hashAlgorithm !== HASH_ALGORITHM
      || typeof metadata.sourceSha256 !== 'string' || typeof metadata.backupSha256 !== 'string'
      || !metadata.sourceIdentity || !metadata.backupIdentity) {
    throw workflowError('ROLLBACK_FAILED', 'Backup integrity metadata is missing or incomplete.');
  }
  if (!isUsablePath(backupPath) || !isUsablePath(originalPath)
      || pathKey(metadata.backupPath) !== pathKey(backupPath)
      || pathKey(metadata.originalPath) !== pathKey(originalPath)
      || !isTemporaryArtifactDirectory(dirname(resolve(backupPath)))) {
    throw workflowError('ROLLBACK_FAILED', 'Backup integrity metadata does not match the requested paths.');
  }
  verifyRecordedFile(backupPath, metadata.backupSha256, metadata.backupIdentity);
}

function exactCloseCode(originalPath) {
  const caseFold = process.platform === 'win32' ? '.toLowerCase()' : '';
  return `
    const targetPath = ${JSON.stringify(originalPath)};
    const { SaveOptions } = require('indesign');
    const pathOf = async (doc) => {
      try {
        const value = await doc.filePath;
        return value ? (value.nativePath || value.url || String(value)) : '';
      } catch (_) { return ''; }
    };
    const normalize = (value) => {
      let path = String(value || '').replace(/\\\\/g, '/');
      try {
        if (path.startsWith('file:')) path = decodeURIComponent(new URL(path).pathname).replace(/^\\/([A-Za-z]:)/, '$1');
      } catch (_) {}
      return path.replace(/\\/+$/, '')${caseFold};
    };
    const matches = [];
    for (let index = 0; index < app.documents.length; index += 1) {
      const doc = app.documents.item(index);
      if (normalize(await pathOf(doc)) === normalize(targetPath)) matches.push(doc);
    }
    if (matches.length !== 1) {
      return { success: false, error: 'Expected exactly one open document at the original path, found ' + matches.length };
    }
    const doc = matches[0];
    const documentId = doc.id;
    await doc.close(SaveOptions.no);
    return { success: true, documentId };
  `;
}

async function verifyReopenedBackup({ inspect, backupPath, expectedDocumentFingerprint }) {
  if (typeof inspect !== 'function' || !expectedDocumentFingerprint) {
    throw workflowError('ROLLBACK_FAILED', 'The reopened backup fingerprint could not be verified.');
  }
  let fresh;
  try {
    fresh = await inspect();
  } catch (error) {
    throw workflowError('ROLLBACK_FAILED', `The reopened backup could not be inspected: ${error.message}`);
  }
  if (!isUsablePath(fresh?.document?.filePath) || pathKey(fresh.document.filePath) !== pathKey(backupPath)
      || (fresh.comparableFingerprint ?? fresh.fingerprint) !== expectedDocumentFingerprint) {
    throw workflowError('ROLLBACK_FAILED', 'The reopened backup path or fingerprint does not match the baseline.');
  }
}

/**
 * Open and verify the immutable backup before closing anything. Close the one
 * exact document object at originalPath with DISCARD, never the active document,
 * then verify the still-open backup again. The original is never saved.
 */
export async function restoreOriginal({
  backupPath,
  originalPath,
  metadata,
  currentFingerprint,
  expectedFingerprint,
  expectedDocumentFingerprint,
  callTool,
  inspect,
}) {
  if (!backupPath) throw workflowError('ROLLBACK_FAILED', 'No backup path was recorded.');
  if (!expectedFingerprint || currentFingerprint !== expectedFingerprint) {
    throw workflowError(
      'ROLLBACK_CONFLICT',
      'The document changed after this plan was applied. Refusing to overwrite newer edits.',
    );
  }
  verifyBackup({ backupPath, originalPath, metadata });

  const openResult = await callTool('open_document', { filePath: backupPath });
  if (openResult?.success !== true) {
    throw workflowError('ROLLBACK_FAILED', `The backup could not be opened: ${openResult?.result || openResult?.error || 'malformed response'}`);
  }
  verifyBackup({ backupPath, originalPath, metadata });
  await verifyReopenedBackup({ inspect, backupPath, expectedDocumentFingerprint });

  // Revalidate both immutable files immediately before the destructive close.
  verifyBackup({ backupPath, originalPath, metadata });
  verifyRecordedFile(originalPath, metadata.sourceSha256, metadata.sourceIdentity);
  const closeResult = await callTool('execute_indesign_code', {
    code: exactCloseCode(originalPath),
    dangerousConfirmation: 'I understand this executes arbitrary InDesign code',
  });
  if (closeResult?.success !== true) {
    throw workflowError('ROLLBACK_FAILED', `The exact original document could not be closed: ${closeResult?.result || closeResult?.error || 'malformed response'}`);
  }

  verifyBackup({ backupPath, originalPath, metadata });
  await verifyReopenedBackup({ inspect, backupPath, expectedDocumentFingerprint });
  return { restored: true, backupPath, originalPath, verifiedFingerprint: expectedDocumentFingerprint };
}
