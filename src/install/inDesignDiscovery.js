import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const INSTALLED_INDESIGN_MANIFEST = 'indesign-path.txt';
const DEFAULT_ROOTS = [
  'C:\\Program Files\\Adobe',
  'C:\\Program Files (x86)\\Adobe',
  '/Applications',
];

function installationEntry(executablePath) {
  if (!isAbsolute(executablePath) || basename(executablePath).toLowerCase() !== 'indesign.exe') {
    return null;
  }
  try {
    if (!statSync(executablePath).isFile()) return null;
  } catch {
    return null;
  }
  const name = basename(dirname(executablePath));
  const version = Number(name.match(/(\d{4})/)?.[1]) || null;
  return { name, version, path: executablePath };
}

function recordedInstallation(executablePath) {
  if (!executablePath) return null;
  const manifest = join(dirname(executablePath), INSTALLED_INDESIGN_MANIFEST);
  try {
    const recordedPath = readFileSync(manifest, 'utf8').trim();
    return recordedPath ? installationEntry(recordedPath) : null;
  } catch {
    return null;
  }
}

export function detectInDesign({ executablePath = null, roots = DEFAULT_ROOTS } = {}) {
  const recorded = recordedInstallation(executablePath);
  if (recorded) return [recorded];

  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/Adobe InDesign/i.test(entry.name)) continue;
      const version = Number(entry.name.match(/(\d{4})/)?.[1]) || null;
      found.push({ name: entry.name, version, path: join(root, entry.name) });
    }
  }
  return found.sort((left, right) => (right.version ?? 0) - (left.version ?? 0));
}
