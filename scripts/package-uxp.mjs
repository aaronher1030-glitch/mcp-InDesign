import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const adobePackageCommand = '@adobe/uxp-devtools-core/src/core/client/plugin/actions/PluginPackageCommand.js';
const adobeLogger = '@adobe/uxp-devtools-core/src/core/common/Logger.js';

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function findWindowsCliOnPath(processImpl, exists) {
  const pathValue = environmentValue(processImpl.env, 'Path');
  if (!pathValue) {
    throw new Error('Cannot find the UXP CLI on Windows PATH');
  }

  const configuredExtensions = environmentValue(processImpl.env, 'PATHEXT');
  const extensions = (configuredExtensions ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`));
  extensions.push('');

  for (const pathDirectory of pathValue.split(';')) {
    const trimmed = pathDirectory.trim();
    if (!trimmed) continue;
    const directory = trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
    for (const extension of extensions) {
      const candidate = win32.join(directory, extension ? `uxp${extension.toLowerCase()}` : 'uxp');
      if (exists(candidate)) return candidate;
    }
  }

  throw new Error('Cannot find the UXP CLI on Windows PATH');
}

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

  return processImpl.platform === 'win32'
    ? findWindowsCliOnPath(processImpl, exists)
    : 'uxp';
}

function unsupportedShim(shimPath, reason) {
  return new Error(`Unsupported Windows UXP CLI shim: ${shimPath}. ${reason}`);
}

function resolveWindowsShimEntry(shimPath, exists) {
  let source;
  try {
    source = readFileSync(shimPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read Windows UXP CLI shim: ${shimPath}`, { cause: error });
  }

  // npm and Yarn generate this final Node invocation. Parse only that narrow
  // shape; never execute or interpolate the shim as a shell command.
  const invocation = source.match(
    /^[ \t]*endLocal\b[^\r\n]*&[ \t]*"%_prog%"[ \t]+"((?:%dp0%|%~dp0%)[\\/][^"\r\n]+\.js)"[ \t]+%\*[ \t]*\r?$/im,
  );
  if (!invocation) {
    throw unsupportedShim(shimPath, 'expected an npm/Yarn Node entry-point invocation');
  }

  const target = invocation[1];
  const relativeTarget = target.match(/^(?:%dp0%|%~dp0%)[\\/](.+)$/i);
  if (!relativeTarget || relativeTarget[1].includes('%')) {
    throw unsupportedShim(shimPath, 'the JavaScript entry must be relative to the shim directory');
  }

  const entry = win32.resolve(win32.dirname(shimPath), relativeTarget[1]);
  if (!exists(entry)) {
    throw new Error(`Windows UXP CLI shim target does not exist: ${entry}`);
  }
  return entry;
}

function resolveCliInvocation(cliPath, processImpl, exists) {
  if (processImpl.platform !== 'win32') {
    return { command: cliPath, args: [], cliPath };
  }

  if (/\.js$/i.test(cliPath)) {
    const entry = resolve(cliPath);
    return { command: processImpl.execPath, args: [entry], cliPath: entry };
  }
  if (/\.cmd$/i.test(cliPath)) {
    const entry = resolveWindowsShimEntry(cliPath, exists);
    return { command: processImpl.execPath, args: [entry], cliPath: entry };
  }

  throw new Error(
    `Unsupported Windows UXP CLI path: ${cliPath}. Use a JavaScript entry point or an npm/Yarn .cmd shim.`,
  );
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

function requireCliSuccess(result) {
  if (typeof result === 'string' || Buffer.isBuffer(result) || result == null) return;
  if (result.error) throw result.error;
  if (result.signal) {
    throw Object.assign(new Error(`Adobe UXP CLI terminated by signal ${result.signal}`), {
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
    });
  }
  if (result.status !== undefined && result.status !== 0) {
    throw Object.assign(new Error(`Adobe UXP CLI exited with status ${result.status}`), {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      signal: result.signal,
    });
  }
  if (result.status === null) {
    throw Object.assign(new Error('Adobe UXP CLI did not report an exit status'), {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      signal: result.signal,
    });
  }
}

function isServiceFailure(text) {
  const connectionFailure = /(?:could\s+not|cound\s+not|can(?:not|\s+not)|can't|failed\s+to|unable\s+to|was\s+not\s+able\s+to)\s+(?:connect\s+to|establish\s+(?:a\s+)?connection\s+(?:to|with))\s+(?:the\s+)?UXP Developer Service/i;
  const serviceUnavailable = /(?:the\s+)?UXP Developer Service\s+(?:is\s+)?(?:unavailable|offline|not\s+(?:available|running))/i;
  return connectionFailure.test(text) || serviceUnavailable.test(text);
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
  execFile = spawnSync,
  exists = existsSync,
  processImpl = process,
  packageOffline = packageWithAdobeOffline,
}) {
  const resolvedRoot = resolve(root);
  const resolvedOutputDir = resolve(resolvedRoot, outputDir);
  const resolvedCliPath = cliPath ?? resolveCliPath(resolvedRoot, processImpl, exists);
  const invocation = resolveCliInvocation(resolvedCliPath, processImpl, exists);
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
  let result;
  let executionError;
  try {
    result = execFile(invocation.command, args, {
      cwd: resolvedRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    executionError = error;
  }

  const resultIsOutput = typeof result === 'string' || Buffer.isBuffer(result);
  const stdout = outputText(executionError?.stdout ?? (resultIsOutput ? result : result?.stdout));
  const stderr = outputText(executionError?.stderr ?? (resultIsOutput ? undefined : result?.stderr));
  if (stdout) processImpl.stdout.write(stdout);
  if (stderr) processImpl.stderr.write(stderr);
  const diagnostic = executionError
    ? errorOutput(executionError)
    : [stdout, stderr, outputText(result?.error?.message)].filter(Boolean).join('\n');
  useOfflinePackager = isServiceFailure(diagnostic);

  if (!useOfflinePackager) {
    if (executionError) throw executionError;
    requireCliSuccess(result);
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
