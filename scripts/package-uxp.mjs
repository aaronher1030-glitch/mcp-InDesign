import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adobeCliEntry = '@adobe/uxp-devtools-cli/src/uxp.js';
const adobePackageCommand = '@adobe/uxp-devtools-core/src/core/client/plugin/actions/PluginPackageCommand.js';
const adobeLogger = '@adobe/uxp-devtools-core/src/core/common/Logger.js';

function resolveCliPath(root, processImpl, exists) {
  const override = processImpl.env.UXP_CLI_PATH;
  if (override) {
    const resolvedOverride = resolve(override);
    if (!exists(resolvedOverride)) {
      throw new Error(`UXP_CLI_PATH does not exist: ${override}`);
    }
    return resolvedOverride;
  }

  const localCli = join(
    root,
    'node_modules',
    '.bin',
    processImpl.platform === 'win32' ? 'uxp.cmd' : 'uxp',
  );
  if (exists(localCli)) {
    return localCli;
  }

  return 'uxp';
}

function resolveAdobeCliEntry(root) {
  const require = createRequire(join(root, 'package.json'));
  try {
    return require.resolve(adobeCliEntry);
  } catch (error) {
    throw new Error(
      `Cannot resolve Adobe's pinned UXP CLI entry point (${adobeCliEntry}): ${error.message}`,
      { cause: error },
    );
  }
}

function resolveCliInvocation(root, cliPath, processImpl) {
  if (processImpl.platform !== 'win32') {
    return { command: cliPath, args: [], cliPath };
  }

  const isWindowsShim = /\.(?:cmd|bat)$/i.test(cliPath);
  const isPathLookup = basename(cliPath).toLowerCase() === 'uxp';
  const isJavaScriptEntry = /\.js$/i.test(cliPath);
  if (!isWindowsShim && !isPathLookup && !isJavaScriptEntry) {
    throw new Error(
      `Unsupported Windows UXP CLI path: ${cliPath}. Use Adobe's src/uxp.js or the pinned npm CLI.`,
    );
  }

  const entry = isJavaScriptEntry ? resolve(cliPath) : resolveAdobeCliEntry(root);
  return {
    command: processImpl.execPath,
    args: [entry],
    cliPath: entry,
  };
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

function findProducedPackages(outputDir, before) {
  const produced = [];
  for (const name of readdirSync(outputDir)) {
    if (!name.toLowerCase().endsWith('.ccx')) continue;
    const ccxPath = join(outputDir, name);
    const stats = statSync(ccxPath, { bigint: true });
    const signature = `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}`;
    if (before.get(name) !== signature) {
      produced.push(ccxPath);
    }
  }
  return produced;
}

function outputText(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function errorOutput(error) {
  return [error?.stdout, error?.stderr, error?.message].map(outputText).filter(Boolean).join('\n');
}

function isServiceFailure(text) {
  return /connect(?:ion)?\s+(?:to\s+)?the\s+UXP Developer Service/i.test(text);
}

function isWindowsShimFailure(error, processImpl) {
  return processImpl.platform === 'win32' && error?.code === 'EINVAL';
}

function requireOfflineResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('Adobe offline UXP packaging did not return any package results');
  }
  const failures = results.filter((result) => !result || result.success !== true);
  if (failures.length > 0) {
    const details = failures.map((result) => {
      const host = result?.host ?? 'unknown host';
      const message = result?.error?.message ?? result?.error ?? 'unknown package error';
      return `${host}: ${message}`;
    }).join('; ');
    throw new Error(
      `Adobe offline UXP packaging failed; every returned package result must succeed: ${details}`,
    );
  }
}

export async function packageWithAdobeOffline({ manifest, packageDir, apps }) {
  const require = createRequire(import.meta.url);
  const Logger = require(adobeLogger);
  if (!globalThis.UxpLogger) {
    globalThis.UxpLogger = Logger;
  }
  const PluginPackageCommand = require(adobePackageCommand);
  const command = new PluginPackageCommand({
    // Strict validation needs a connected host. Adobe's package() still performs
    // validateForPackaging(), file selection, and archiver-based packaging below.
    validatePluginManifest: async () => {},
  }, { manifest, packageDir, apps });

  let results = [];
  const adobePackage = command.package.bind(command);
  command.package = async () => {
    results = await adobePackage();
    return results;
  };
  await command.execute();
  return results;
}

export async function packageUxp({
  root,
  outputDir,
  cliPath,
  execFile = execFileSync,
  exists = existsSync,
  processImpl = process,
  packageOffline = packageWithAdobeOffline,
}) {
  const resolvedRoot = resolve(root);
  const resolvedOutputDir = resolve(resolvedRoot, outputDir);
  const resolvedCliPath = cliPath ?? resolveCliPath(resolvedRoot, processImpl, exists);
  const invocation = resolveCliInvocation(resolvedRoot, resolvedCliPath, processImpl);
  const args = [
    ...invocation.args,
    'plugin',
    'package',
    '--manifest', join(resolvedRoot, 'plugin', 'manifest.json'),
    '--apps', 'ID',
    '--outputPath', resolvedOutputDir,
  ];
  mkdirSync(resolvedOutputDir, { recursive: true });
  const before = ccxSnapshot(resolvedOutputDir);

  const runOfflinePackager = async () => {
    let results;
    try {
      results = await packageOffline({
        manifest: join(resolvedRoot, 'plugin', 'manifest.json'),
        packageDir: resolvedOutputDir,
        apps: ['ID'],
      });
    } catch (error) {
      throw new Error(`Adobe offline UXP packaging failed: ${error?.message ?? error}`, { cause: error });
    }
    requireOfflineResults(results);
  };

  let useOfflinePackager = false;
  try {
    const result = execFile(invocation.command, args, {
      cwd: resolvedRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = outputText(result);
    if (stdout) processImpl.stdout.write(stdout);
    useOfflinePackager = isServiceFailure(stdout);
  } catch (error) {
    const stdout = outputText(error?.stdout);
    const stderr = outputText(error?.stderr);
    if (stdout) processImpl.stdout.write(stdout);
    if (stderr) processImpl.stderr.write(stderr);
    const diagnostic = errorOutput(error);
    if (!isServiceFailure(diagnostic) && !isWindowsShimFailure(error, processImpl)) {
      throw error;
    }
    useOfflinePackager = true;
  }

  if (useOfflinePackager) {
    processImpl.stderr.write('UXP Developer Service unavailable; using Adobe\'s pinned offline package command.\n');
    await runOfflinePackager();
  }

  const produced = findProducedPackages(resolvedOutputDir, before);
  if (produced.length === 0) {
    throw new Error(`Adobe UXP packaging did not produce a .ccx file in ${resolvedOutputDir}`);
  }
  if (produced.length > 1) {
    throw new Error(
      `Adobe UXP packaging produced multiple .ccx files in ${resolvedOutputDir}; `
      + `remove ambiguous output and package one host at a time: ${produced.join(', ')}`,
    );
  }

  return { ccxPath: produced[0], cliPath: invocation.cliPath };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(dirname(scriptPath), '..');
  try {
    const { ccxPath } = await packageUxp({
      root,
      outputDir: join(root, 'dist', 'uxp'),
    });
    console.log(`Adobe UXP package created: ${ccxPath}`);
  } catch (error) {
    console.error('UXP packaging failed:', error);
    process.exitCode = 1;
  }
}
