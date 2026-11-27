#!/usr/bin/env node
/**
 * Bundle the server into one CommonJS file with esbuild, then build a
 * standalone executable with Node's Single Executable Application support.
 *
 * Output: ../InDesignAaronV1.1.exe
 * Usage:  node scripts/build-exe.mjs [--no-exe]
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, 'build');
const bundlePath = join(buildDir, 'indesign-aaron.cjs');
const seaConfigPath = join(buildDir, 'sea-config.json');
const outputPath = resolve(root, '..', 'InDesignAaronV1.1.exe');
const skipExe = process.argv.includes('--no-exe');

mkdirSync(buildDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'index.js')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'info',
  // ws optional native accelerators are not needed.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: '/* InDesignAaronV1.1 - bundled build */',
  },
});

console.log(`Bundled ${bundlePath} (${(statSync(bundlePath).size / 1024 / 1024).toFixed(2)} MiB)`);

if (skipExe) process.exit(0);

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`Node ${process.version} cannot build a SEA executable. Use Node 24 or newer.`);
  process.exit(1);
}

writeFileSync(seaConfigPath, `${JSON.stringify({
  main: bundlePath,
  output: outputPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2)}\n`);

if (process.platform === 'win32') {
  // Windows keeps an open handle briefly after a rebuild.
  try {
    rmSync(outputPath, { force: true });
  } catch {
    // The build below reports a useful error if the file really is locked.
  }
}

console.log('Building InDesignAaronV1.1.exe with Node SEA ...');
execFileSync(process.execPath, [`--build-sea=${seaConfigPath}`], {
  stdio: 'inherit',
  cwd: root,
});

console.log(`\nBuilt ${outputPath} (${(statSync(outputPath).size / 1024 / 1024).toFixed(1)} MiB)`);
