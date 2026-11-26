import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSkill, listSkills, loadSkillCatalog } from '../src/skills/registry.js';

const OPEN_DOCUMENT = 'A document is open in InDesign.';
const FORBIDDEN_TOOLS = [
  'execute_indesign_code',
  'close_document',
  'print_book',
  'package_document',
];
const EXPECTED_SKILLS = [
  {
    id: 'safe-layout-edit',
    name: 'Safe Layout Edit',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
    ],
    defaultRisk: 'low',
    qualityCriteria: [
      'Only planned targets change.',
      'No new text overflow or out-of-bounds content appears.',
      'No unintended style duplication occurs.',
      'Structural and visual results are reported separately.',
    ],
  },
  {
    id: 'text-typography-edit',
    name: 'Text Typography Edit',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'edit_text_frame', 'apply_paragraph_style', 'apply_character_style',
      'create_paragraph_style', 'create_character_style',
    ],
    defaultRisk: 'low',
    qualityCriteria: [
      'No overset text remains.',
      'The typography hierarchy remains clear.',
      'Leading and alignment are consistent across edited text.',
      'Existing styles are reused when suitable.',
    ],
  },
  {
    id: 'align-distribute',
    name: 'Align Distribute',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'move_page_item', 'resize_page_item', 'set_page_item_properties',
    ],
    defaultRisk: 'low',
    qualityCriteria: [
      'Gaps are equal within the plan tolerance.',
      'Items align to the chosen margin, grid, or neighbor.',
      'No item leaves the page unexpectedly.',
    ],
  },
  {
    id: 'image-reframe',
    name: 'Image Reframe',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'resize_page_item', 'set_page_item_properties', 'get_image_info',
    ],
    defaultRisk: 'low',
    qualityCriteria: [
      'The aspect ratio follows the stated crop intent.',
      'Effective resolution is acceptable for the intended output.',
      'Image links remain valid.',
      'The frame stays within the planned bounds.',
    ],
  },
  {
    id: 'style-consistency',
    name: 'Style Consistency',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'list_styles', 'list_color_swatches', 'apply_paragraph_style',
      'apply_character_style', 'apply_object_style', 'apply_color',
    ],
    defaultRisk: 'low',
    qualityCriteria: [
      'Existing styles and colors are preferred.',
      'No duplicate styles are created without approval.',
      'Typography remains consistent across all targets.',
    ],
  },
  {
    id: 'multi-page-consistency',
    name: 'Multi Page Consistency',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'list_spreads', 'get_spread_info', 'apply_master_spread',
    ],
    defaultRisk: 'high',
    qualityCriteria: [
      'Repeated elements align across pages.',
      'Masters and folios remain coherent.',
      'No unrelated page changes occur.',
      'Approval is always required.',
    ],
  },
];
const SUMMARY_FIELDS = [
  'id', 'name', 'summary', 'version', 'triggers', 'examples', 'preconditions',
  'allowedTools', 'forbiddenTools', 'defaultRisk', 'qualityCriteria',
];

function createValidManifest() {
  return {
    skills: EXPECTED_SKILLS.map((skill) => ({
      ...skill,
      allowedTools: [...skill.allowedTools],
      qualityCriteria: [...skill.qualityCriteria],
      summary: `Handles ${skill.name.toLowerCase()} requests safely.`,
      version: '1.0.0',
      triggers: [`Request ${skill.id}`, 'Edit an existing InDesign document'],
      examples: [`Please perform ${skill.id} on the selected objects.`],
      preconditions: [OPEN_DOCUMENT, 'The requested targets can be identified from inspection output.'],
      forbiddenTools: [...FORBIDDEN_TOOLS],
    })),
  };
}

function createMarkdown(skill) {
  return `# ${skill.name}

## When to use
${skill.summary ?? ''} Use it when the request identifies existing content that needs a controlled edit.

## Preconditions
${(skill.preconditions ?? []).map((item) => `- ${item}`).join('\n')}

## Workflow
1. Inspect the affected pages with \`inspect_layout\`.
2. Author a structured plan using inspection IDs and fingerprints.
3. Call \`plan_edit\` and obey its risk classification.
4. Call \`apply_edit_plan\` only with required approval.
5. Verify structural and visual results with \`verify_layout\`.
6. Report changed objects and unresolved findings; call \`rollback_edit\` if verification fails.

## Quality criteria
${(skill.qualityCriteria ?? []).map((item) => `- ${item}`).join('\n')}

## Example request
> ${skill.examples?.[0] ?? ''}
`;
}

async function withFixture(_t, options, run) {
  const skillsDir = mkdtempSync(join(tmpdir(), 'indesign-skill-registry-'));
  try {
    const manifest = options.manifest ?? createValidManifest();
    if (options.manifestText !== undefined) {
      writeFileSync(join(skillsDir, 'manifest.json'), options.manifestText);
    } else if (!options.omitManifest) {
      writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify(manifest));
    }
    if (Array.isArray(manifest.skills)) {
      for (const skill of manifest.skills) {
        if (!/^[a-z0-9-]+$/.test(skill.id ?? '') || options.omitMarkdown?.includes(skill.id)) continue;
        writeFileSync(join(skillsDir, `${skill.id}.md`), createMarkdown(skill));
      }
    }
    return await run(skillsDir);
  } finally {
    rmSync(skillsDir, { recursive: true, force: true });
  }
}

test('loads all six portable skills', async () => {
  const skills = await listSkills();
  assert.deepEqual(skills.map((skill) => skill.id), EXPECTED_SKILLS.map((skill) => skill.id));
});

test('returns instructions and rejects unknown skills', async () => {
  const skill = await getSkill('safe-layout-edit');
  assert.match(skill.content, /Inspect/);
  assert.match(skill.content, /Verify/);
  await assert.rejects(() => getSkill('missing'), /Unknown skill/);
});

test('summaries expose the complete metadata contract without Markdown content', async () => {
  const skills = await listSkills();
  for (const [index, skill] of skills.entries()) {
    const expected = EXPECTED_SKILLS[index];
    assert.deepEqual(Object.keys(skill).sort(), [...SUMMARY_FIELDS].sort());
    assert.equal(skill.name, expected.name);
    assert.equal(skill.version, '1.0.0');
    assert.equal(skill.defaultRisk, expected.defaultRisk);
    assert.deepEqual(skill.allowedTools, expected.allowedTools);
    assert.deepEqual(skill.qualityCriteria, expected.qualityCriteria);
    assert.ok(skill.forbiddenTools.includes('execute_indesign_code'));
    assert.ok(!skill.allowedTools.includes('execute_indesign_code'));
  }
});

test('catalog metadata satisfies the portable skill requirements', async () => {
  const skills = await loadSkillCatalog();
  assert.equal(skills.length, 6);
  for (const [index, skill] of skills.entries()) {
    const expected = EXPECTED_SKILLS[index];
    assert.deepEqual(Object.keys(skill).sort(), [...SUMMARY_FIELDS, 'content'].sort());
    assert.match(skill.summary, /^[^.!?]+[.!?]$/);
    assert.ok(skill.triggers.length >= 2);
    assert.ok(skill.triggers.every((trigger) => typeof trigger === 'string' && trigger.trim()));
    assert.ok(skill.examples.length >= 1);
    assert.ok(skill.preconditions.includes(OPEN_DOCUMENT));
    for (const tool of FORBIDDEN_TOOLS) {
      assert.ok(skill.forbiddenTools.includes(tool));
      assert.ok(!skill.allowedTools.includes(tool));
    }
    assert.equal(skill.content.split('\n')[0], `# ${expected.name}`);
    assert.deepEqual(
      [...skill.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      ['When to use', 'Preconditions', 'Workflow', 'Quality criteria', 'Example request'],
    );
    assert.ok(skill.content.includes(skill.summary));
  }
});

test('loads a validated custom catalog without replacing the default catalog', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const skills = await loadSkillCatalog(skillsDir);
    assert.deepEqual(skills.map((skill) => skill.id), EXPECTED_SKILLS.map((skill) => skill.id));
    assert.match(skills[0].content, /^# Safe Layout Edit/);
  });
  assert.equal((await listSkills())[0].id, 'safe-layout-edit');
});

test('rejects malformed JSON and a missing manifest', async (t) => {
  await t.test('malformed JSON', async (t) => {
    await withFixture(t, { manifestText: '{' }, async (skillsDir) => {
      await assert.rejects(() => loadSkillCatalog(skillsDir), /JSON|manifest/i);
    });
  });
  await t.test('missing manifest', async (t) => {
    await withFixture(t, { omitManifest: true }, async (skillsDir) => {
      await assert.rejects(() => loadSkillCatalog(skillsDir), /manifest|ENOENT/i);
    });
  });
});

test('rejects a manifest without a skills array', async (t) => {
  await withFixture(t, { manifest: { skills: {} } }, async (skillsDir) => {
    await assert.rejects(() => loadSkillCatalog(skillsDir), /skills.*array/i);
  });
});

test('rejects duplicate skill IDs', async (t) => {
  const manifest = createValidManifest();
  manifest.skills[5] = { ...manifest.skills[0] };
  await withFixture(t, { manifest }, async (skillsDir) => {
    await assert.rejects(() => loadSkillCatalog(skillsDir), /duplicate.*safe-layout-edit/i);
  });
});

test('rejects a missing Markdown file', async (t) => {
  await withFixture(t, { omitMarkdown: ['multi-page-consistency'] }, async (skillsDir) => {
    await assert.rejects(() => loadSkillCatalog(skillsDir), /missing Markdown file.*multi-page-consistency/i);
  });
});

const invalidMetadataCases = [
  ['rejects an empty catalog', (manifest) => { manifest.skills = []; }, /exactly (?:6|six)/i],
  ['rejects an unknown skill ID', (manifest) => { manifest.skills[0].id = 'unknown-skill'; }, /id/i],
  ['rejects an unsafe skill ID', (manifest) => { manifest.skills[0].id = '../escape'; }, /id/i],
  ['rejects a missing skill name', (manifest) => { delete manifest.skills[0].name; }, /name/i],
  ['rejects a skill name that does not match the catalog', (manifest) => { manifest.skills[0].name = 'Other Name'; }, /name/i],
  ['rejects an unsupported version', (manifest) => { manifest.skills[0].version = '2.0.0'; }, /version/i],
  ['rejects a summary that is not one sentence', (manifest) => { manifest.skills[0].summary = 'Edits layout'; }, /summary/i],
  ['rejects too few triggers', (manifest) => { manifest.skills[0].triggers = ['one']; }, /triggers/i],
  ['rejects a non-array triggers field', (manifest) => { manifest.skills[0].triggers = 'edit'; }, /triggers/i],
  ['rejects empty examples', (manifest) => { manifest.skills[0].examples = []; }, /examples/i],
  ['rejects a missing open-document precondition', (manifest) => { manifest.skills[0].preconditions = []; }, /preconditions/i],
  ['rejects empty allowed tools', (manifest) => { manifest.skills[0].allowedTools = []; }, /allowedTools/i],
  ['rejects duplicate allowed tools', (manifest) => { manifest.skills[0].allowedTools.push('inspect_layout'); }, /allowedTools/i],
  ['rejects an extra allowed tool', (manifest) => { manifest.skills[0].allowedTools.push('save_document'); }, /allowedTools/i],
  ['rejects execute_indesign_code in allowed tools', (manifest) => { manifest.skills[0].allowedTools.push('execute_indesign_code'); }, /execute_indesign_code|forbidden/i],
  ['rejects a missing required forbidden tool', (manifest) => { manifest.skills[0].forbiddenTools.pop(); }, /forbiddenTools/i],
  ['rejects a high default risk for a low-risk skill', (manifest) => { manifest.skills[0].defaultRisk = 'high'; }, /defaultRisk/i],
  ['rejects a low default risk for multi-page-consistency', (manifest) => { manifest.skills[5].defaultRisk = 'low'; }, /defaultRisk/i],
  ['rejects missing quality criteria', (manifest) => { delete manifest.skills[0].qualityCriteria; }, /qualityCriteria/i],
  ['rejects too few quality criteria', (manifest) => { manifest.skills[0].qualityCriteria = ['Only one.', 'Only two.']; }, /qualityCriteria/i],
];

for (const [name, mutate, expectedError] of invalidMetadataCases) {
  test(name, async (t) => {
    const manifest = createValidManifest();
    mutate(manifest);
    await withFixture(t, { manifest }, async (skillsDir) => {
      await assert.rejects(() => loadSkillCatalog(skillsDir), expectedError);
    });
  });
}

test('rejects empty Markdown content', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    writeFileSync(join(skillsDir, 'safe-layout-edit.md'), '');
    await assert.rejects(() => loadSkillCatalog(skillsDir), /Markdown|content/i);
  });
});

test('rejects a Markdown title that does not match its metadata name', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const path = join(skillsDir, 'safe-layout-edit.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('# Safe Layout Edit', '# Different Name'));
    await assert.rejects(() => loadSkillCatalog(skillsDir), /name|title/i);
  });
});

test('rejects missing or reordered Markdown sections', async (t) => {
  await t.test('missing section', async (t) => {
    await withFixture(t, {}, async (skillsDir) => {
      const path = join(skillsDir, 'safe-layout-edit.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace('## Example request', '## Request'));
      await assert.rejects(() => loadSkillCatalog(skillsDir), /section|heading/i);
    });
  });
  await t.test('reordered sections', async (t) => {
    await withFixture(t, {}, async (skillsDir) => {
      const path = join(skillsDir, 'safe-layout-edit.md');
      const content = readFileSync(path, 'utf8')
        .replace('## Preconditions', '## Quality criteria')
        .replace(/(## Quality criteria\n[\s\S]*?)\n## Workflow/, '$1\n## Preconditions');
      writeFileSync(path, content);
      await assert.rejects(() => loadSkillCatalog(skillsDir), /section|heading|order/i);
    });
  });
});

test('rejects Markdown preconditions that disagree with metadata', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const path = join(skillsDir, 'safe-layout-edit.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(`- ${OPEN_DOCUMENT}`, '- A document is closed.'));
    await assert.rejects(() => loadSkillCatalog(skillsDir), /preconditions/i);
  });
});

test('rejects Markdown quality criteria that disagree with metadata', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const path = join(skillsDir, 'safe-layout-edit.md');
    const content = readFileSync(path, 'utf8').replace('- Only planned targets change.', '- Anything may change.');
    writeFileSync(path, content);
    await assert.rejects(() => loadSkillCatalog(skillsDir), /qualityCriteria/i);
  });
});
