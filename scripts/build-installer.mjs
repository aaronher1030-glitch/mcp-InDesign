import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflightSigning, signAndVerify } from './sign-release.mjs';

const APP_NAME = 'InDesignAaronV1.1';
const SEA_NAME = `${APP_NAME}.exe`;
const CCX_NAME = 'com.ads.indesign-bridge_ID.ccx';

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function pathCandidates(env) {
  const pathValue = environmentValue(env, 'Path');
  const configuredExtensions = environmentValue(env, 'PATHEXT');
  const extensions = (configuredExtensions ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`));
  extensions.push('');

  const candidates = [];
  for (const directory of (pathValue ?? '').split(';')) {
    const trimmed = directory.trim().replace(/^"|"$/g, '');
    if (!trimmed) continue;
    for (const extension of extensions) {
      candidates.push(win32.join(trimmed, `ISCC${extension}`));
    }
  }

  const programFiles = [
    environmentValue(env, 'ProgramFiles(x86)'),
    environmentValue(env, 'ProgramFiles'),
  ].filter(Boolean);
  for (const directory of programFiles) {
    candidates.push(win32.join(directory, 'Inno Setup 7', 'ISCC.exe'));
  }
  const localAppData = environmentValue(env, 'LOCALAPPDATA');
  if (localAppData) {
    candidates.push(win32.join(localAppData, 'Programs', 'Inno Setup 7', 'ISCC.exe'));
  }
  return candidates;
}

/** Locate ISCC without invoking a shell or relying on a machine-wide search. */
export function findIscc({ env = process.env, exists = existsSync } = {}) {
  const override = environmentValue(env, 'INNO_SETUP_ISCC');
  if (override) {
    if (!exists(override)) throw new Error('INNO_SETUP_ISCC does not exist');
    return override;
  }
  for (const candidate of pathCandidates(env)) {
    if (exists(candidate)) return candidate;
  }
  throw new Error(
    'Cannot find Inno Setup 7. Set INNO_SETUP_ISCC or install Inno Setup 7 '
    + 'in a standard per-machine or per-user folder.',
  );
}

function safeCommandError(label, error) {
  const status = typeof error?.status === 'number' ? ` (exit ${error.status})` : '';
  const signal = typeof error?.signal === 'string' ? ` (signal ${error.signal})` : '';
  return new Error(`${label} failed${status}${signal}`);
}

function runCommand({ execFile, command, args, cwd, env, label }) {
  try {
    const result = execFile(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    if (result?.error) throw result.error;
    if (result?.signal || (result?.status !== undefined && result.status !== 0)) {
      throw result;
    }
  } catch (error) {
    throw safeCommandError(label, error);
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function artifact(kind, filePath, signed) {
  return {
    kind,
    path: filePath,
    size: statSync(filePath).size,
    sha256: sha256(filePath),
    signed,
  };
}

function portableConfig(env) {
  const localAppData = environmentValue(env, 'LOCALAPPDATA');
  if (!localAppData) throw new Error('LOCALAPPDATA is required to generate the portable MCP configuration');
  return {
    mcpServers: {
      indesign: {
        command: win32.join(localAppData, 'Programs', APP_NAME, SEA_NAME),
        args: [],
      },
    },
  };
}

function resolveMode({ release, mode, env, argv }) {
  if (!release) return mode ?? 'certificate';
  const argument = argv.find((value) => value.startsWith('--provider='));
  const providerIndex = argv.indexOf('--provider');
  const selected = mode
    ?? (argument
      ? argument.slice('--provider='.length)
      : providerIndex === -1
        ? environmentValue(env, 'SIGNING_PROVIDER')
          ?? environmentValue(env, 'CODE_SIGN_PROVIDER')
          ?? 'certificate'
        : argv[providerIndex + 1]);
  if (selected !== 'certificate' && selected !== 'azure') {
    throw new Error('Signing provider must be certificate or azure');
  }
  return selected;
}

/**
 * Build the SEA and UXP payload, compile Inno output in a private staging
 * directory, and publish only after all required signing verification passes.
 */
export async function buildInstaller({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  release = false,
  mode,
  env = process.env,
  argv = [],
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  npmExecPath = environmentValue(env, 'npm_execpath'),
  execFile = execFileSync,
  sign = signAndVerify,
  locateIscc = findIscc,
  tempRoot = tmpdir(),
  log = console.log,
} = {}) {
  if (platform !== 'win32') throw new Error('Installer builds require Windows');
  if (arch !== 'x64') throw new Error('Installer builds require x64 Windows');
  if (Number(nodeVersion.split('.')[0]) < 24) throw new Error('Installer builds require Node 24 or newer');
  if (!npmExecPath) throw new Error('npm_execpath is required; run this pipeline through npm');

  const selectedMode = resolveMode({ release, mode, env, argv });
  // Release credentials, tools, certificate/DLL, and metadata inputs are all
  // checked before npm can rebuild or overwrite a previously built SEA.
  if (release) preflightSigning({ mode: selectedMode, env });

  const resolvedRoot = resolve(root);
  const seaPath = resolve(resolvedRoot, '..', SEA_NAME);
  const ccxPath = join(resolvedRoot, 'dist', 'uxp', CCX_NAME);
  const outputDir = join(resolvedRoot, 'dist', 'installer');
  const packageJson = JSON.parse(readFileSync(join(resolvedRoot, 'package.json'), 'utf8'));
  const suffix = release ? '-signed' : '-unsigned';
  const setupName = `${APP_NAME}-${packageJson.version}-windows-setup${suffix}.exe`;
  const isccPath = locateIscc({ env });
  const config = portableConfig(env);

  const runNpm = (script, extraArgs = []) => runCommand({
    execFile,
    command: process.execPath,
    args: [npmExecPath, 'run', script, '--', ...extraArgs],
    cwd: resolvedRoot,
    env,
    label: `npm run ${script}`,
  });

  const stagingDirectory = mkdtempSync(join(tempRoot, 'indesign-installer-'));
  try {
    chmodSync(stagingDirectory, 0o700);
    const stagingOutputDir = join(stagingDirectory, 'installer');
    mkdirSync(stagingOutputDir, { recursive: true });
    const stagingConfigPath = join(stagingOutputDir, 'mcp-config.json');
    const stagingSetupPath = join(stagingOutputDir, setupName);

    runNpm('build');
    if (!existsSync(seaPath)) throw new Error(`SEA build did not produce ${SEA_NAME}`);
    if (release) await sign({ files: [seaPath], mode: selectedMode, env });

    runNpm('smoke', [seaPath]);
    runNpm('package:uxp');
    if (!existsSync(ccxPath)) throw new Error(`UXP packaging did not produce ${CCX_NAME}`);

    writeFileSync(stagingConfigPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    runCommand({
      execFile,
      command: isccPath,
      args: [
        `/DAppVersion=${packageJson.version}`,
        `/DSeaExe=${seaPath}`,
        `/DCcxPath=${ccxPath}`,
        `/DOutputDir=${stagingOutputDir}`,
        `/DOutputSuffix=${suffix}`,
        join(resolvedRoot, 'installer', 'indesign-aaron.iss'),
      ],
      cwd: resolvedRoot,
      env,
      label: 'Inno Setup compilation',
    });
    if (!existsSync(stagingSetupPath)) throw new Error(`Inno Setup did not produce ${setupName}`);

    if (release) await sign({ files: [stagingSetupPath], mode: selectedMode, env });

    // No release-labeled setup is copied into the public output directory
    // until both the SEA and staged setup have signed and verified cleanly.
    mkdirSync(outputDir, { recursive: true });
    const finalSetupPath = join(outputDir, setupName);
    copyFileSync(stagingSetupPath, finalSetupPath);
    copyFileSync(stagingConfigPath, join(outputDir, 'mcp-config.json'));

    const summary = {
      signed: release,
      artifacts: [
        artifact('sea', seaPath, release),
        artifact('uxp', ccxPath, false),
        artifact('installer', finalSetupPath, release),
      ],
    };
    log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    await buildInstaller({
      argv: process.argv.slice(2),
      release: process.argv.includes('--release'),
    });
  } catch (error) {
    // Build/signing wrappers deliberately omit raw child-process diagnostics.
    console.error(`Installer build failed: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 1;
  }
}
