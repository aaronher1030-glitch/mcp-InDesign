import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveCliPath(root, exists) {
  const override = process.env.UXP_CLI_PATH;
  if (override) {
    if (!exists(override)) {
      throw new Error(`UXP_CLI_PATH does not exist: ${override}`);
    }
    return override;
  }

  const localCli = join(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'uxp.cmd' : 'uxp',
  );
  if (exists(localCli)) {
    return localCli;
  }

  return 'uxp';
}

function ccxSnapshot(outputDir) {
  const snapshot = new Map();
  for (const name of readdirSync(outputDir)) {
    if (!name.toLowerCase().endsWith('.ccx')) continue;
    const stats = statSync(join(outputDir, name), { bigint: true });
    snapshot.set(name, `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}`);
  }
  return snapshot;
}

export function packageUxp({
  root,
  outputDir,
  cliPath,
  execFile = execFileSync,
  exists = existsSync,
}) {
  const resolvedRoot = resolve(root);
  const resolvedOutputDir = resolve(resolvedRoot, outputDir);
  const resolvedCliPath = cliPath ?? resolveCliPath(resolvedRoot, exists);
  mkdirSync(resolvedOutputDir, { recursive: true });
  const before = ccxSnapshot(resolvedOutputDir);

  execFile(resolvedCliPath, [
    'plugin',
    'package',
    '--manifest', join(resolvedRoot, 'plugin', 'manifest.json'),
    '--apps', 'ID',
    '--outputPath', resolvedOutputDir,
  ], {
    cwd: resolvedRoot,
    stdio: 'inherit',
    windowsHide: true,
  });

  const produced = [];
  for (const name of readdirSync(resolvedOutputDir)) {
    if (!name.toLowerCase().endsWith('.ccx')) continue;
    const ccxPath = join(resolvedOutputDir, name);
    const stats = statSync(ccxPath, { bigint: true });
    const signature = `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}`;
    if (before.get(name) !== signature) {
      produced.push(ccxPath);
    }
  }

  if (produced.length === 0) {
    throw new Error(`Adobe UXP CLI did not produce a .ccx file in ${resolvedOutputDir}`);
  }
  if (produced.length > 1) {
    throw new Error(
      `Adobe UXP CLI produced multiple .ccx files in ${resolvedOutputDir}; `
      + `remove ambiguous output and package one host at a time: ${produced.join(', ')}`,
    );
  }

  return { ccxPath: produced[0], cliPath: resolvedCliPath };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(dirname(scriptPath), '..');
  try {
    const { ccxPath } = packageUxp({
      root,
      outputDir: join(root, 'dist', 'uxp'),
    });
    console.log(`Adobe UXP package created: ${ccxPath}`);
  } catch (error) {
    console.error('UXP packaging failed:', error);
    process.exitCode = 1;
  }
}
