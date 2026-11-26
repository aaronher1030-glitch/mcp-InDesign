import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_DIR = resolve(__dirname, '../../skills');
const OPEN_DOCUMENT = 'A document is open in InDesign.';
const REQUIRED_FORBIDDEN_TOOLS = [
  'execute_indesign_code',
  'close_document',
  'print_book',
  'package_document',
];
const MARKDOWN_SECTIONS = [
  'When to use',
  'Preconditions',
  'Workflow',
  'Quality criteria',
  'Example request',
];
const CORE_WORKFLOW_TOOLS = [
  'inspect_layout',
  'plan_edit',
  'apply_edit_plan',
  'verify_layout',
  'rollback_edit',
];
const EXPECTED_SKILLS = [
  {
    id: 'safe-layout-edit',
    name: 'Safe Layout Edit',
    defaultRisk: 'low',
    allowedTools: ['inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit'],
  },
  {
    id: 'text-typography-edit',
    name: 'Text Typography Edit',
    defaultRisk: 'low',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'edit_text_frame', 'apply_paragraph_style', 'apply_character_style',
      'create_paragraph_style', 'create_character_style',
    ],
  },
  {
    id: 'align-distribute',
    name: 'Align Distribute',
    defaultRisk: 'low',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'move_page_item', 'resize_page_item', 'set_page_item_properties',
    ],
  },
  {
    id: 'image-reframe',
    name: 'Image Reframe',
    defaultRisk: 'low',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'resize_page_item', 'set_page_item_properties', 'get_image_info',
    ],
  },
  {
    id: 'style-consistency',
    name: 'Style Consistency',
    defaultRisk: 'low',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'list_styles', 'list_color_swatches', 'apply_paragraph_style',
      'apply_character_style', 'apply_object_style', 'apply_color',
    ],
  },
  {
    id: 'multi-page-consistency',
    name: 'Multi Page Consistency',
    defaultRisk: 'high',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'list_spreads', 'get_spread_info', 'apply_master_spread',
    ],
  },
];
const EXPECTED_BY_ID = new Map(EXPECTED_SKILLS.map((skill) => [skill.id, skill]));

let cache;

function manifestError(message) {
  return new Error(`Invalid skill manifest: ${message}`);
}

function skillError(id, message) {
  return new Error(`Invalid skill manifest for "${id}": ${message}`);
}

function readManifest(skillsDir) {
  const manifestPath = join(skillsDir, 'manifest.json');
  let source;
  try {
    source = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read skill manifest at ${manifestPath}: ${error.message}`, { cause: error });
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid skill manifest JSON at ${manifestPath}: ${error.message}`, { cause: error });
  }

  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.skills)) {
    throw manifestError('"skills" must be an array.');
  }
  if (manifest.skills.length !== EXPECTED_SKILLS.length) {
    throw manifestError(`expected exactly ${EXPECTED_SKILLS.length} skills.`);
  }
  return manifest;
}

function validateStringArray(value, id, field, minimum) {
  if (!Array.isArray(value) || value.length < minimum) {
    throw skillError(id, `${field} must be an array with at least ${minimum} entries.`);
  }
  if (value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw skillError(id, `${field} must contain non-empty strings.`);
  }
  if (new Set(value).size !== value.length) {
    throw skillError(id, `${field} must not contain duplicate entries.`);
  }
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function validateMetadata(meta, index) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw manifestError(`skills[${index}] must be an object.`);
  }
  if (typeof meta.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.id)) {
    throw skillError(String(meta.id ?? index), 'id must be a lowercase hyphenated string.');
  }

  const expected = EXPECTED_BY_ID.get(meta.id);
  if (!expected) throw skillError(meta.id, 'unknown skill id.');
  if (meta.id !== EXPECTED_SKILLS[index].id) {
    throw skillError(meta.id, `id is out of order; expected "${EXPECTED_SKILLS[index].id}".`);
  }
  if (meta.name !== expected.name) {
    throw skillError(meta.id, `name must be "${expected.name}".`);
  }
  if (typeof meta.summary !== 'string' || !/^[^.!?\r\n]+[.!?]$/.test(meta.summary.trim())) {
    throw skillError(meta.id, 'summary must be one non-empty sentence.');
  }
  if (meta.version !== '1.0.0') {
    throw skillError(meta.id, 'version must be "1.0.0".');
  }

  validateStringArray(meta.triggers, meta.id, 'triggers', 2);
  validateStringArray(meta.examples, meta.id, 'examples', 1);
  validateStringArray(meta.preconditions, meta.id, 'preconditions', 1);
  if (!meta.preconditions.includes(OPEN_DOCUMENT)) {
    throw skillError(meta.id, `preconditions must include "${OPEN_DOCUMENT}"`);
  }
  validateStringArray(meta.allowedTools, meta.id, 'allowedTools', 1);
  validateStringArray(meta.forbiddenTools, meta.id, 'forbiddenTools', REQUIRED_FORBIDDEN_TOOLS.length);
  for (const tool of REQUIRED_FORBIDDEN_TOOLS) {
    if (!meta.forbiddenTools.includes(tool)) {
      throw skillError(meta.id, `forbiddenTools must include "${tool}".`);
    }
  }

  const conflictingTools = meta.allowedTools.filter((tool) => meta.forbiddenTools.includes(tool));
  if (conflictingTools.length > 0) {
    throw skillError(meta.id, `forbidden tools cannot be allowed: ${conflictingTools.join(', ')}.`);
  }
  if (!sameStrings(meta.allowedTools, expected.allowedTools)) {
    throw skillError(meta.id, 'allowedTools must exactly match the approved skill tool list.');
  }
  if (meta.defaultRisk !== expected.defaultRisk) {
    throw skillError(meta.id, `defaultRisk must be "${expected.defaultRisk}".`);
  }
  validateStringArray(meta.qualityCriteria, meta.id, 'qualityCriteria', 3);
}

function readMarkdown(skillsDir, id) {
  const markdownPath = join(skillsDir, `${id}.md`);
  try {
    return readFileSync(markdownPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing Markdown file for skill "${id}": ${markdownPath}`, { cause: error });
    }
    throw new Error(`Unable to read Markdown file for skill "${id}": ${error.message}`, { cause: error });
  }
}

function parseSections(content, id) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== `# ${EXPECTED_BY_ID.get(id).name}`) {
    throw skillError(id, 'Markdown title must match the skill name.');
  }

  const sections = [];
  let current;
  for (const line of lines.slice(1)) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { name: line.slice(3).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  const names = sections.map((section) => section.name);
  if (!sameStrings(names, MARKDOWN_SECTIONS)) {
    throw skillError(id, `Markdown sections must appear in this order: ${MARKDOWN_SECTIONS.join(', ')}.`);
  }
  return new Map(sections.map((section) => [section.name, section.lines.join('\n').trim()]));
}

function parseBulletList(body, id, field) {
  const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.some((line) => !line.startsWith('- '))) {
    throw skillError(id, `Markdown ${field} must be a bullet list.`);
  }
  return lines.map((line) => line.slice(2).trim());
}

function validateMarkdown(content, meta) {
  if (!content.trim()) throw skillError(meta.id, 'Markdown content must not be empty.');
  const sections = parseSections(content, meta.id);
  if (!sections.get('When to use').includes(meta.summary)) {
    throw skillError(meta.id, 'Markdown "When to use" section must include the manifest summary.');
  }
  if (!sameStrings(parseBulletList(sections.get('Preconditions'), meta.id, 'preconditions'), meta.preconditions)) {
    throw skillError(meta.id, 'Markdown preconditions must match the manifest preconditions.');
  }
  if (!sameStrings(parseBulletList(sections.get('Quality criteria'), meta.id, 'quality criteria'), meta.qualityCriteria)) {
    throw skillError(meta.id, 'Markdown quality criteria must match the manifest qualityCriteria.');
  }
  if (!sections.get('Example request').includes(meta.examples[0])) {
    throw skillError(meta.id, 'Markdown example request must include the first manifest example.');
  }

  const workflow = sections.get('Workflow');
  for (const tool of CORE_WORKFLOW_TOOLS) {
    if (!workflow.includes(`\`${tool}\``)) {
      throw skillError(meta.id, `Markdown workflow must reference \`${tool}\`.`);
    }
  }

  // MCP tool names use snake_case; other inline code remains ordinary prose.
  for (const match of content.matchAll(/`([^`\r\n]+)`/g)) {
    const reference = match[1].trim().replace(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(.*\)$/, '$1');
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(reference) && !meta.allowedTools.includes(reference)) {
      throw skillError(meta.id, `Markdown tool reference \`${reference}\` is not in allowedTools.`);
    }
  }
}

function toDefinition(meta, content) {
  return {
    id: meta.id,
    name: meta.name,
    summary: meta.summary,
    version: meta.version,
    triggers: meta.triggers,
    examples: meta.examples,
    preconditions: meta.preconditions,
    allowedTools: meta.allowedTools,
    forbiddenTools: meta.forbiddenTools,
    defaultRisk: meta.defaultRisk,
    qualityCriteria: meta.qualityCriteria,
    content,
  };
}

function cloneDefinition(skill) {
  return {
    ...skill,
    triggers: [...skill.triggers],
    examples: [...skill.examples],
    preconditions: [...skill.preconditions],
    allowedTools: [...skill.allowedTools],
    forbiddenTools: [...skill.forbiddenTools],
    qualityCriteria: [...skill.qualityCriteria],
  };
}

export async function loadSkillCatalog(skillsDir = DEFAULT_DIR) {
  const resolvedDir = resolve(skillsDir);
  if (cache && resolvedDir === DEFAULT_DIR) return cache.map(cloneDefinition);

  const manifest = readManifest(resolvedDir);
  const ids = new Set();
  for (const meta of manifest.skills) {
    if (meta && typeof meta.id === 'string') {
      if (ids.has(meta.id)) throw manifestError(`duplicate skill id "${meta.id}".`);
      ids.add(meta.id);
    }
  }

  const skills = manifest.skills.map((meta, index) => {
    validateMetadata(meta, index);
    const content = readMarkdown(resolvedDir, meta.id);
    validateMarkdown(content, meta);
    return toDefinition(meta, content);
  });
  if (resolvedDir === DEFAULT_DIR) cache = skills;
  return skills.map(cloneDefinition);
}

export async function getSkill(id) {
  const skills = await loadSkillCatalog();
  const skill = skills.find((entry) => entry.id === id);
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  return skill;
}

export async function listSkills() {
  const skills = await loadSkillCatalog();
  return skills.map(({ content, ...summary }) => summary);
}
