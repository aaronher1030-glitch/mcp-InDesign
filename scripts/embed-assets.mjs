#!/usr/bin/env node
/**
 * Regenerate src/assets/embeddedSkills.js and src/assets/embeddedPlugin.js so
 * the packaged executable carries the skill catalog and the UXP plugin.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(root, 'skills');
const pluginDir = join(root, 'plugin');

function textFiles(directory) {
  return readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort();
}

function emitModule(path, exportName, entries, banner) {
  const body = Object.entries(entries)
    .map(([name, content]) => `  ${JSON.stringify(name)}: ${JSON.stringify(content)},`)
    .join('\n');
  writeFileSync(
    path,
    `${banner}\n\nexport const ${exportName} = {\n${body}\n};\n`,
    'utf8',
  );
}

const skillFiles = {};
for (const name of textFiles(skillsDir)) {
  if (name === 'manifest.json' || name.endsWith('.md')) {
    skillFiles[name] = readFileSync(join(skillsDir, name), 'utf8');
  }
}

const pluginFiles = {};
for (const name of textFiles(pluginDir)) {
  pluginFiles[name] = readFileSync(join(pluginDir, name), 'utf8');
}

emitModule(
  join(root, 'src', 'assets', 'embeddedSkills.js'),
  'embeddedSkillFiles',
  skillFiles,
  '/**\n * GENERATED FILE - run `node scripts/embed-assets.mjs` after editing skills/.\n * Embedded skill catalog used when no skills/ folder is available (packaged exe).\n */',
);

emitModule(
  join(root, 'src', 'assets', 'embeddedPlugin.js'),
  'embeddedPluginFiles',
  pluginFiles,
  '/**\n * GENERATED FILE - run `node scripts/embed-assets.mjs` after editing plugin/.\n * Embedded Adobe UXP plugin used by `--install-plugin` (packaged exe).\n */',
);

console.log(`Embedded ${Object.keys(skillFiles).length} skill files and ${Object.keys(pluginFiles).length} plugin files.`);
