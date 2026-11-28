import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signAndVerify } from '../scripts/sign-release.mjs';
import { buildInstaller, findIscc } from '../scripts/build-installer.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const setupName = 'InDesignAaronV1.1-1.1.0-windows-setup';

function temporaryDirectory(t, prefix = 'indesign-sign-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(path, contents = 'fixture') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function signingFixture(t) {
  const directory = temporaryDirectory(t);
  const target = writeFile(join(directory, 'setup.exe'), 'setup');
  const env = {
    SIGNTOOL_PATH: writeFile(join(directory, 'signtool.exe')),
    CODE_SIGN_CERT_PATH: writeFile(join(directory, 'certificate.pfx')),
    CODE_SIGN_CERT_PASSWORD: 'password-that-must-not-leak',
  };
  return { directory, target, env };
}

test('certificate signing fails closed when SignTool is not configured', async () => {
  await assert.rejects(
    signAndVerify({ files: ['C:\\Temp\\setup.exe'], mode: 'certificate', env: {}, execFile: () => {} }),
    /SIGNTOOL_PATH/,
  );
});

test('each certificate input is required before SignTool runs', async (t) => {
  const { target, env } = signingFixture(t);
  for (const name of ['CODE_SIGN_CERT_PATH', 'CODE_SIGN_CERT_PASSWORD']) {
    const incomplete = { ...env };
    delete incomplete[name];
    let calls = 0;
    await assert.rejects(
      signAndVerify({
        files: [target],
        mode: 'certificate',
        env: incomplete,
        execFile: () => { calls += 1; },
      }),
      new RegExp(name),
    );
    assert.equal(calls, 0);
  }
});

test('certificate signing uses exact SHA-256 timestamp arguments and verifies every file', async (t) => {
  const { directory, target, env } = signingFixture(t);
  const second = writeFile(join(directory, 'second.exe'), 'second');
  const calls = [];
  const result = await signAndVerify({
    files: [target, second],
    mode: 'certificate',
    env,
    execFile: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls.map(({ args }) => args), [
    ['sign', '/f', env.CODE_SIGN_CERT_PATH, '/p', env.CODE_SIGN_CERT_PASSWORD,
      '/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', target],
    ['verify', '/pa', '/tw', target],
    ['sign', '/f', env.CODE_SIGN_CERT_PATH, '/p', env.CODE_SIGN_CERT_PASSWORD,
      '/fd', 'sha256', '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', second],
    ['verify', '/pa', '/tw', second],
  ]);
  assert.ok(calls.every(({ file }) => file === env.SIGNTOOL_PATH));
  assert.ok(calls.every(({ options }) => options.env === env && options.windowsHide === true));
  assert.deepEqual(result, { signed: [target, second], verified: [target, second] });
});

test('certificate timestamp override is passed without logging secrets', async (t) => {
  const { target, env } = signingFixture(t);
  env.CODE_SIGN_TIMESTAMP_URL = 'https://timestamp.example.test';
  const messages = [];
  const originalLog = console.log;
  console.log = (...args) => messages.push(args.join(' '));
  try {
    await signAndVerify({
      files: [target],
      mode: 'certificate',
      env,
      execFile: (_file, args) => {
        if (args[0] === 'sign') assert.ok(args.includes(env.CODE_SIGN_TIMESTAMP_URL));
        return { status: 0 };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.doesNotMatch(messages.join('\n'), /password-that-must-not-leak/);
});

test('Azure signing writes restrictive temporary DMDF metadata and uses documented arguments', async (t) => {
  const { directory, target, env } = signingFixture(t);
  const dlib = writeFile(join(directory, 'Azure.CodeSigning.Dlib.dll'));
  const azureEnv = {
    SIGNTOOL_PATH: env.SIGNTOOL_PATH,
    AZURE_SIGN_DLIB_PATH: dlib,
    AZURE_ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
    AZURE_ARTIFACT_SIGNING_ACCOUNT: 'example-account',
    AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE: 'example-profile',
  };
  let metadataPath;
  const calls = [];
  const result = await signAndVerify({
    files: [target],
    mode: 'azure',
    env: azureEnv,
    execFile: (file, args, options) => {
      calls.push({ file, args, options });
      if (args[0] === 'sign') {
        metadataPath = args[args.indexOf('/dmdf') + 1];
        assert.deepEqual(JSON.parse(readFileSync(metadataPath, 'utf8')), {
          Endpoint: azureEnv.AZURE_ARTIFACT_SIGNING_ENDPOINT,
          CodeSigningAccountName: azureEnv.AZURE_ARTIFACT_SIGNING_ACCOUNT,
          CertificateProfileName: azureEnv.AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE,
        });
        if (process.platform !== 'win32') {
          assert.equal(statSync(metadataPath).mode & 0o777, 0o600);
        }
      }
      return { status: 0 };
    },
  });

  assert.deepEqual(calls.map(({ args }) => args), [
    ['sign', '/fd', 'sha256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'sha256',
      '/dlib', dlib, '/dmdf', metadataPath, target],
    ['verify', '/pa', '/tw', target],
  ]);
  assert.ok(calls.every(({ file }) => file === azureEnv.SIGNTOOL_PATH));
  assert.ok(calls.every(({ options }) => options.env === azureEnv));
  assert.deepEqual(result, { signed: [target], verified: [target] });
  assert.equal(existsSync(metadataPath), false, 'Azure metadata must be removed after signing');
});

test('each Azure input is required before SignTool runs', async (t) => {
  const { directory, target, env } = signingFixture(t);
  const complete = {
    SIGNTOOL_PATH: env.SIGNTOOL_PATH,
    AZURE_SIGN_DLIB_PATH: writeFile(join(directory, 'Azure.CodeSigning.Dlib.dll')),
    AZURE_ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
    AZURE_ARTIFACT_SIGNING_ACCOUNT: 'account',
    AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE: 'profile',
  };
  for (const name of [
    'AZURE_SIGN_DLIB_PATH',
    'AZURE_ARTIFACT_SIGNING_ENDPOINT',
    'AZURE_ARTIFACT_SIGNING_ACCOUNT',
    'AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE',
  ]) {
    const incomplete = { ...complete };
    delete incomplete[name];
    let calls = 0;
    await assert.rejects(
      signAndVerify({
        files: [target], mode: 'azure', env: incomplete,
        execFile: () => { calls += 1; },
      }),
      new RegExp(name),
    );
    assert.equal(calls, 0);
  }
});

test('a signing failure rejects the release without exposing command errors or secrets', async (t) => {
  const { target, env } = signingFixture(t);
  const secret = env.CODE_SIGN_CERT_PASSWORD;
  await assert.rejects(
    signAndVerify({
      files: [target],
      mode: 'certificate',
      env,
      execFile: () => {
        throw Object.assign(new Error(`raw command contains /p ${secret}`), {
          status: 1,
          stdout: secret,
          stderr: secret,
        });
      },
    }),
    (error) => {
      assert.match(error.message, /SignTool sign failed/);
      assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(secret));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test('a verification failure rejects instead of returning success', async (t) => {
  const { target, env } = signingFixture(t);
  await assert.rejects(
    signAndVerify({
      files: [target],
      mode: 'certificate',
      env,
      execFile: (_file, args) => {
        if (args[0] === 'verify') throw Object.assign(new Error('unsafe raw details'), { status: 1 });
        return { status: 0 };
      },
    }),
    /SignTool verify failed/,
  );
});

test('Azure metadata is removed when verification fails', async (t) => {
  const { directory, target, env } = signingFixture(t);
  let metadataPath;
  await assert.rejects(
    signAndVerify({
      files: [target],
      mode: 'azure',
      env: {
        ...env,
        AZURE_SIGN_DLIB_PATH: writeFile(join(directory, 'Azure.CodeSigning.Dlib.dll')),
        AZURE_ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
        AZURE_ARTIFACT_SIGNING_ACCOUNT: 'account',
        AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE: 'profile',
      },
      execFile: (_file, args) => {
        if (args[0] === 'sign') metadataPath = args[args.indexOf('/dmdf') + 1];
        if (args[0] === 'verify') throw Object.assign(new Error('unsafe raw details'), { status: 1 });
        return { status: 0 };
      },
    }),
    /SignTool verify failed/,
  );
  assert.ok(metadataPath);
  assert.equal(existsSync(metadataPath), false);
});

test('Azure signing failure is secret-safe and removes temporary metadata', async (t) => {
  const { directory, target, env } = signingFixture(t);
  const azureSecret = 'azure-secret-that-must-not-leak';
  let metadataPath;
  await assert.rejects(
    signAndVerify({
      files: [target],
      mode: 'azure',
      env: {
        ...env,
        AZURE_CLIENT_SECRET: azureSecret,
        AZURE_SIGN_DLIB_PATH: writeFile(join(directory, 'Azure.CodeSigning.Dlib.dll')),
        AZURE_ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
        AZURE_ARTIFACT_SIGNING_ACCOUNT: 'account',
        AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE: 'profile',
      },
      execFile: (_file, args) => {
        metadataPath = args[args.indexOf('/dmdf') + 1];
        throw Object.assign(new Error(`raw failure includes ${azureSecret}`), {
          status: 1,
          stderr: azureSecret,
        });
      },
    }),
    (error) => {
      assert.match(error.message, /SignTool sign failed/);
      assert.doesNotMatch(`${error.message}\n${error.stack}`, new RegExp(azureSecret));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.ok(metadataPath);
  assert.equal(existsSync(metadataPath), false);
});

test('unknown signing backends are rejected', async () => {
  await assert.rejects(
    signAndVerify({ files: ['C:\\Temp\\setup.exe'], mode: 'release', env: {}, execFile: () => {} }),
    /certificate or azure/,
  );
});

function definition(args, name) {
  const argument = args.find((value) => value.startsWith(`/D${name}=`));
  assert.ok(argument, `missing Inno definition ${name}`);
  const value = argument.slice(`/D${name}=`.length);
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function buildFixture(t, options = {}) {
  const directory = temporaryDirectory(t, 'indesign-build-');
  const root = join(directory, 'repository');
  mkdirSync(join(root, 'installer'), { recursive: true });
  writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
  const seaPath = join(directory, 'InDesignAaronV1.1.exe');
  const ccxPath = join(root, 'dist', 'uxp', 'com.ads.indesign-bridge_ID.ccx');
  const isccPath = 'C:\\Inno Setup 7\\ISCC.exe';
  const env = {
    npm_execpath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    LOCALAPPDATA: join(directory, 'local-app-data'),
    SIGNTOOL_PATH: writeFile(join(directory, 'signtool.exe')),
    CODE_SIGN_CERT_PATH: writeFile(join(directory, 'certificate.pfx')),
    CODE_SIGN_CERT_PASSWORD: 'build-password-that-must-not-leak',
    AZURE_SIGN_DLIB_PATH: writeFile(join(directory, 'Azure.CodeSigning.Dlib.dll')),
    ...options.env,
  };
  const events = [];
  const summaries = [];
  let stagingDirectory;
  const execFile = (file, args) => {
    events.push({ type: 'exec', file, args });
    if (args[1] === 'run') {
      const script = args[2];
      if (script === 'build') writeFile(seaPath, 'sea executable');
      return { status: 0 };
    }
    assert.equal(file, isccPath);
    const outputDirectory = definition(args, 'OutputDir');
    const suffix = definition(args, 'OutputSuffix');
    stagingDirectory = outputDirectory;
    writeFile(join(outputDirectory, `${setupName}${suffix}.exe`), 'compiled setup');
    return { status: 0 };
  };
  const sign = async ({ files, mode }) => {
    events.push({ type: 'sign', files: [...files], mode });
    return { signed: [...files], verified: [...files] };
  };
  const inputOverrides = { ...options };
  delete inputOverrides.env;
  const inputs = {
    root,
    release: false,
    mode: 'certificate',
    env,
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '24.0.0',
    npmExecPath: env.npm_execpath,
    execFile,
    sign,
    locateIscc: () => isccPath,
    packageUxp: async ({ root, outputDir }) => {
      events.push({ type: 'package', root, outputDir });
      writeFile(ccxPath, 'ccx package');
      return { ccxPath, cliPath: 'C:\\UXP\\uxp.js' };
    },
    tempRoot: directory,
    log: (value) => summaries.push(value),
    ...inputOverrides,
  };
  return {
    inputs, events, summaries, env, seaPath, ccxPath, root,
    outputDir: join(root, 'dist', 'installer'),
    stagingDirectory: () => stagingDirectory,
  };
}

test('release preflight rejects missing credentials before any build or publication', async (t) => {
  const fixture = buildFixture(t, { release: true, env: { SIGNTOOL_PATH: undefined } });
  await assert.rejects(buildInstaller(fixture.inputs), /SIGNTOOL_PATH/);
  assert.deepEqual(fixture.events, []);
  assert.equal(existsSync(fixture.seaPath), false);
  assert.equal(existsSync(fixture.ccxPath), false);
  assert.equal(existsSync(fixture.outputDir), false);
});

test('release preflight rejects a missing certificate file before building', async (t) => {
  const fixture = buildFixture(t, {
    release: true,
    env: { CODE_SIGN_CERT_PATH: join(tmpdir(), 'missing-certificate.pfx') },
  });
  await assert.rejects(buildInstaller(fixture.inputs), /CODE_SIGN_CERT_PATH/);
  assert.deepEqual(fixture.events, []);
});

test('installer builds require Windows x64 and Node 24 or newer', async (t) => {
  for (const override of [{ platform: 'linux' }, { arch: 'arm64' }, { nodeVersion: '22.0.0' }]) {
    const fixture = buildFixture(t, override);
    await assert.rejects(buildInstaller(fixture.inputs), /Windows|Node/);
    assert.deepEqual(fixture.events, []);
  }
});

test('unsigned pipeline runs UXP helper setup after smoke and before direct packaging', async (t) => {
  const fixture = buildFixture(t);
  const summary = await buildInstaller(fixture.inputs);
  const setupPath = join(fixture.outputDir, `${setupName}-unsigned.exe`);

  assert.equal(existsSync(setupPath), true);
  assert.equal(existsSync(join(fixture.outputDir, 'mcp-config.json')), true);
  assert.equal(existsSync(fixture.stagingDirectory()), false);
  assert.equal(fixture.events.some((event) => event.type === 'sign'), false);
  assert.deepEqual(fixture.events.filter((event) => event.type === 'exec' && event.args[1] === 'run').map((event) => event.args[2]), [
    'build', 'smoke', 'prepackage:uxp',
  ]);
  const smokeIndex = fixture.events.findIndex((event) => event.type === 'exec' && event.args[2] === 'smoke');
  const helperIndex = fixture.events.findIndex((event) => event.type === 'exec' && event.args[2] === 'prepackage:uxp');
  const packageIndex = fixture.events.findIndex((event) => event.type === 'package');
  assert.ok(smokeIndex !== -1 && smokeIndex < helperIndex, 'UXP helper setup must run after smoke');
  assert.ok(helperIndex !== -1 && helperIndex < packageIndex, 'direct packaging must run after UXP helper setup');
  assert.deepEqual(fixture.events[helperIndex].args, [fixture.env.npm_execpath, 'run', 'prepackage:uxp', '--']);
  assert.deepEqual(fixture.events.filter((event) => event.type === 'package'), [{
    type: 'package',
    root: fixture.root,
    outputDir: join(fixture.root, 'dist', 'uxp'),
  }]);
  assert.equal(fixture.events.at(-1).file, 'C:\\Inno Setup 7\\ISCC.exe');
  for (const name of ['AppVersion', 'SeaExe', 'CcxPath', 'OutputDir']) {
    const value = fixture.events.at(-1).args.find((argument) => argument.startsWith(`/D${name}=`));
    assert.ok(value, `missing ${name} definition`);
    assert.doesNotMatch(value.slice(`/D${name}=`.length), /^"|"$/, `${name} must not contain embedded quote delimiters`);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.outputDir, 'mcp-config.json'), 'utf8')), {
    mcpServers: {
      indesign: {
        command: win32.join(fixture.env.LOCALAPPDATA, 'Programs', 'InDesignAaronV1.1', 'InDesignAaronV1.1.exe'),
        args: [],
      },
    },
  });
  assert.equal(summary.signed, false);
  assert.deepEqual(summary.artifacts.map(({ kind }) => kind), ['sea', 'uxp', 'installer']);
  for (const artifact of summary.artifacts) {
    assert.equal(artifact.size, statSync(artifact.path).size);
    assert.equal(artifact.sha256, createHash('sha256').update(readFileSync(artifact.path)).digest('hex'));
  }
  assert.equal(summary.artifacts.find(({ kind }) => kind === 'installer').path, setupPath);
  assert.equal(JSON.parse(fixture.summaries.at(-1)).signed, false);
  assert.doesNotMatch(fixture.summaries.join('\n'), /build-password-that-must-not-leak/);
});

test('failed UXP helper setup stops before packaging, compilation, and publication', async (t) => {
  const fixture = buildFixture(t);
  const execFile = fixture.inputs.execFile;
  fixture.inputs.execFile = (file, args, options) => {
    if (args[1] === 'run' && args[2] === 'prepackage:uxp') {
      fixture.events.push({ type: 'exec', file, args });
      throw Object.assign(new Error('raw helper diagnostics must not escape'), { status: 1 });
    }
    return execFile(file, args, options);
  };

  await assert.rejects(buildInstaller(fixture.inputs), /npm run prepackage:uxp failed \(exit 1\)/);
  assert.deepEqual(fixture.events.filter((event) => event.type === 'exec' && event.args[1] === 'run').map((event) => event.args[2]), [
    'build', 'smoke', 'prepackage:uxp',
  ]);
  assert.equal(fixture.events.some((event) => event.type === 'package'), false);
  assert.equal(fixture.events.some((event) => event.type === 'exec' && event.file.includes('ISCC')), false);
  assert.equal(existsSync(fixture.outputDir), false);
});

test('installer uses the exact UXP artifact returned by packaging instead of a stale expected path', async (t) => {
  const packagedName = 'differently-named_ID.ccx';
  const packageCalls = [];
  const fixture = buildFixture(t, {
    packageUxp: async (options) => {
      packageCalls.push(options);
      const actualCcxPath = join(options.root, 'dist', 'uxp', packagedName);
      writeFile(actualCcxPath, 'fresh package');
      return { ccxPath: actualCcxPath, cliPath: 'C:\\UXP\\uxp.js' };
    },
  });
  const packagedCcxPath = join(fixture.root, 'dist', 'uxp', packagedName);
  writeFile(fixture.ccxPath, 'stale expected package');

  const summary = await buildInstaller(fixture.inputs);
  const compileEvent = fixture.events.at(-1);

  assert.deepEqual(packageCalls, [{
    root: fixture.root,
    outputDir: join(fixture.root, 'dist', 'uxp'),
  }]);
  assert.equal(compileEvent.file, 'C:\\Inno Setup 7\\ISCC.exe');
  assert.equal(definition(compileEvent.args, 'CcxPath'), packagedCcxPath);
  assert.notEqual(definition(compileEvent.args, 'CcxPath'), fixture.ccxPath);
  const packagedArtifact = summary.artifacts.find(({ kind }) => kind === 'uxp');
  assert.equal(packagedArtifact.path, packagedCcxPath);
  assert.equal(packagedArtifact.sha256, createHash('sha256').update('fresh package').digest('hex'));
});

test('installer rejects a missing returned UXP artifact even when the expected path is stale', async (t) => {
  const fixture = buildFixture(t, {
    packageUxp: async (options) => ({
      ccxPath: join(options.root, 'dist', 'uxp', 'missing_ID.ccx'),
      cliPath: 'C:\\UXP\\uxp.js',
    }),
  });
  writeFile(fixture.ccxPath, 'stale expected package');

  await assert.rejects(buildInstaller(fixture.inputs), /UXP packaging did not produce .*missing_ID\.ccx/);
  assert.equal(fixture.events.some((event) => event.type === 'exec' && event.file.includes('ISCC')), false);
  assert.equal(existsSync(fixture.outputDir), false);
});

test('release pipeline signs the SEA first, compiles with a signed basename, then signs setup', async (t) => {
  const fixture = buildFixture(t, { release: true });
  const summary = await buildInstaller(fixture.inputs);
  const setupPath = join(fixture.outputDir, `${setupName}-signed.exe`);

  assert.equal(existsSync(setupPath), true);
  assert.equal(existsSync(join(fixture.outputDir, `${setupName}-unsigned.exe`)), false);
  assert.equal(existsSync(fixture.stagingDirectory()), false);
  assert.deepEqual(fixture.events.filter((event) => event.type === 'sign'), [
    { type: 'sign', files: [fixture.seaPath], mode: 'certificate' },
    { type: 'sign', files: [setupPath.replace(fixture.outputDir, fixture.stagingDirectory())], mode: 'certificate' },
  ]);
  const signSetupIndex = fixture.events.findLastIndex((event) => event.type === 'sign');
  const compileIndex = fixture.events.findLastIndex((event) => event.type === 'exec' && event.file.includes('ISCC'));
  assert.ok(compileIndex < signSetupIndex, 'setup must be signed after compilation');
  assert.equal(summary.signed, true);
  assert.deepEqual(summary.artifacts.map(({ signed }) => signed), [true, false, true]);
  assert.equal(definition(fixture.events[compileIndex].args, 'OutputSuffix'), '-signed');
});

test('release CLI flag does not get mistaken for a provider argument', async (t) => {
  const fixture = buildFixture(t, { release: true, argv: ['--release'] });
  const summary = await buildInstaller(fixture.inputs);
  assert.equal(summary.signed, true);
  assert.deepEqual(fixture.events.filter((event) => event.type === 'sign').map(({ mode }) => mode), ['certificate', 'certificate']);
});

test('failed setup signing cleans staging and never publishes a release-labeled setup', async (t) => {
  const fixture = buildFixture(t, {
    release: true,
    sign: async ({ files }) => {
      if (files[0].endsWith('.exe') && files[0].includes('windows-setup')) {
        throw new Error('SignTool verify failed');
      }
      return { signed: [...files], verified: [...files] };
    },
  });
  await assert.rejects(buildInstaller(fixture.inputs), /SignTool verify failed/);
  assert.equal(existsSync(fixture.stagingDirectory()), false);
  assert.equal(existsSync(fixture.outputDir), false);
  assert.equal(existsSync(join(fixture.outputDir, `${setupName}-signed.exe`)), false);
});

test('Azure release preflight accepts DefaultAzureCredential configuration without invented credentials', async (t) => {
  const fixture = buildFixture(t, {
    release: true,
    mode: 'azure',
    env: {
      CODE_SIGN_CERT_PATH: undefined,
      CODE_SIGN_CERT_PASSWORD: undefined,
      AZURE_ARTIFACT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net',
      AZURE_ARTIFACT_SIGNING_ACCOUNT: 'account',
      AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE: 'profile',
    },
  });
  const summary = await buildInstaller(fixture.inputs);
  assert.equal(summary.signed, true);
  assert.deepEqual(fixture.events.filter((event) => event.type === 'sign').map(({ mode }) => mode), ['azure', 'azure']);
});

test('Inno compiler discovery checks override, PATH, and standard per-user/per-machine folders', (t) => {
  const directory = temporaryDirectory(t, 'indesign-iscc-');
  const perUser = writeFile(join(directory, 'Users', 'Ada', 'AppData', 'Local', 'Programs', 'Inno Setup 7', 'ISCC.exe'));
  const pathDirectory = join(directory, 'path-tools');
  const onPath = writeFile(join(pathDirectory, 'ISCC.exe'));
  const env = { LOCALAPPDATA: join(directory, 'Users', 'Ada', 'AppData', 'Local') };
  const exists = (path) => existsSync(path);

  assert.equal(findIscc({ env: { ...env, INNO_SETUP_ISCC: onPath }, exists }), onPath);
  assert.equal(findIscc({ env: { ...env, Path: pathDirectory }, exists }), onPath);
  assert.equal(findIscc({ env, exists }), perUser);
  assert.throws(() => findIscc({ env: {}, exists: () => false }), /INNO_SETUP_ISCC|Inno Setup 7/);
});

test('installer basename uses an overridable suffix that defaults to unsigned', () => {
  const source = readFileSync(join(repositoryRoot, 'installer', 'indesign-aaron.iss'), 'utf8');
  assert.match(source, /#ifndef OutputSuffix\s+#define OutputSuffix "-unsigned"\s+#endif/);
  assert.match(source, /OutputBaseFilename=InDesignAaronV1\.1-\{#AppVersion\}-windows-setup\{#OutputSuffix\}/);
  assert.doesNotMatch(source, /OutputBaseFilename=[^\r\n]*-unsigned\r?$/m);
});

test('npm test includes signing coverage and exposes both installer commands', () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['build:installer'], 'node scripts/build-installer.mjs');
  assert.equal(packageJson.scripts['build:release'], 'node scripts/build-installer.mjs --release');
  assert.match(packageJson.scripts.test, /(?:^|\s)tests\/test-sign-release\.mjs(?:\s|$)/);
});
