import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CERTIFICATE_TIMESTAMP_URL = 'http://timestamp.digicert.com';
const AZURE_TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

function environmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function requireEnvironment(env, name) {
  const value = environmentValue(env, name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required for release signing`);
  }
  return value;
}

function requireFile(env, name) {
  const value = requireEnvironment(env, name);
  if (!existsSync(value)) {
    throw new Error(`${name} does not exist`);
  }
  return value;
}

/**
 * Validate every local signing input without invoking a process. The build
 * pipeline calls this before creating any release artifacts.
 */
export function preflightSigning({ mode, env = process.env }) {
  if (mode !== 'certificate' && mode !== 'azure') {
    throw new Error('Signing mode must be certificate or azure');
  }

  const signTool = requireFile(env, 'SIGNTOOL_PATH');
  if (mode === 'certificate') {
    return {
      signTool,
      certificate: requireFile(env, 'CODE_SIGN_CERT_PATH'),
      password: requireEnvironment(env, 'CODE_SIGN_CERT_PASSWORD'),
      timestampUrl: environmentValue(env, 'CODE_SIGN_TIMESTAMP_URL') || CERTIFICATE_TIMESTAMP_URL,
    };
  }

  return {
    signTool,
    dlib: requireFile(env, 'AZURE_SIGN_DLIB_PATH'),
    endpoint: requireEnvironment(env, 'AZURE_ARTIFACT_SIGNING_ENDPOINT'),
    account: requireEnvironment(env, 'AZURE_ARTIFACT_SIGNING_ACCOUNT'),
    profile: requireEnvironment(env, 'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE'),
    timestampUrl: AZURE_TIMESTAMP_URL,
  };
}

function commandFailure(operation, file, error) {
  const status = typeof error?.status === 'number' ? ` (exit ${error.status})` : '';
  const signal = typeof error?.signal === 'string' ? ` (signal ${error.signal})` : '';
  // Deliberately omit the original error, stdout/stderr, arguments, and
  // environment: SignTool diagnostics can contain the certificate password.
  return new Error(`SignTool ${operation} failed for ${file}${status}${signal}`);
}

async function runSignTool({ execFile, signTool, env, operation, file, args }) {
  let result;
  try {
    result = await execFile(signTool, args, {
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw commandFailure(operation, file, error);
  }

  if (result?.error) throw commandFailure(operation, file, result.error);
  if (result?.signal || (result?.status !== undefined && result.status !== 0)) {
    throw commandFailure(operation, file, result);
  }
}

function createAzureMetadata({ endpoint, account, profile }) {
  let directory;
  try {
    directory = mkdtempSync(join(tmpdir(), 'indesign-azure-sign-'));
    chmodSync(directory, 0o700);
    const metadataPath = join(directory, 'metadata.json');
    writeFileSync(metadataPath, `${JSON.stringify({
      Endpoint: endpoint,
      CodeSigningAccountName: account,
      CertificateProfileName: profile,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(metadataPath, 0o600);
    return { directory, metadataPath };
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw new Error('Unable to prepare Azure Artifact Signing metadata');
  }
}

/**
 * Sign and verify each file with the selected backend. No command output is
 * forwarded because it may contain signing secrets.
 */
export async function signAndVerify({
  files,
  mode,
  env = process.env,
  execFile = execFileSync,
}) {
  const config = preflightSigning({ mode, env });
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string' || file === '')) {
    throw new Error('At least one file is required for release signing');
  }

  const signed = [];
  const verified = [];
  let azureMetadata;

  try {
    if (mode === 'azure') {
      azureMetadata = createAzureMetadata(config);
    }

    for (const file of files) {
      const signArgs = mode === 'certificate'
        ? ['sign', '/f', config.certificate, '/p', config.password,
          '/fd', 'sha256', '/tr', config.timestampUrl, '/td', 'sha256', file]
        : ['sign', '/fd', 'sha256', '/tr', config.timestampUrl, '/td', 'sha256',
          '/dlib', config.dlib, '/dmdf', azureMetadata.metadataPath, file];
      await runSignTool({
        execFile, signTool: config.signTool, env, operation: 'sign', file, args: signArgs,
      });
      signed.push(file);

      await runSignTool({
        execFile,
        signTool: config.signTool,
        env,
        operation: 'verify',
        file,
        args: ['verify', '/pa', '/tw', file],
      });
      verified.push(file);
    }
  } finally {
    if (azureMetadata) rmSync(azureMetadata.directory, { recursive: true, force: true });
  }

  return { signed, verified };
}
