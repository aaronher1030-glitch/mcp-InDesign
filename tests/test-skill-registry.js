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
  'save_document',
];
const EXPECTED_SKILLS = [
  {
    id: 'safe-layout-edit',
    name: 'Safe Layout Edit',
    allowedTools: [
      'inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit',
      'move_page_item', 'resize_page_item', 'set_page_item_properties', 'edit_text_frame',
      'apply_paragraph_style', 'apply_character_style', 'apply_object_style', 'apply_color',
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
        if (!skill || typeof skill !== 'object' || Array.isArray(skill)) continue;
        if (typeof skill.id !== 'string' || !/^[a-z0-9-]+$/.test(skill.id)) continue;
        if (options.omitMarkdown?.includes(skill.id)) continue;
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
  for (const [name, manifest] of [['missing skills', {}], ['non-array skills', { skills: {} }]]) {
    await t.test(name, async (t) => {
      await withFixture(t, { manifest }, async (skillsDir) => {
        await assert.rejects(() => loadSkillCatalog(skillsDir), /skills.*array/i);
      });
    });
  }
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
  ['rejects a five-skill catalog', (manifest) => { manifest.skills.pop(); }, /exactly (?:6|six)/i],
  ['rejects a seven-skill catalog', (manifest) => { manifest.skills.push({ ...manifest.skills[0] }); }, /exactly (?:6|six)/i],
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
  ['rejects an extra allowed tool', (manifest) => { manifest.skills[0].allowedTools.push('save_document'); }, /allowedTools|forbidden tools cannot be allowed/i],
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

test('rejects non-object skill entries through manifest validation', async (t) => {
  for (const [name, entry] of [['null', null], ['string', 'not an object'], ['array', []]]) {
    await t.test(name, async (t) => {
      const manifest = createValidManifest();
      manifest.skills[2] = entry;
      await withFixture(t, { manifest }, async (skillsDir) => {
        await assert.rejects(() => loadSkillCatalog(skillsDir), /skills\[2\] must be an object/i);
      });
    });
  }
});

test('rejects out-of-order skill IDs', async (t) => {
  const manifest = createValidManifest();
  [manifest.skills[0], manifest.skills[1]] = [manifest.skills[1], manifest.skills[0]];
  await withFixture(t, { manifest }, async (skillsDir) => {
    await assert.rejects(() => loadSkillCatalog(skillsDir), /out of order/i);
  });
});

const additionalInvalidMetadataCases = [
  ['rejects a missing summary', (manifest) => { delete manifest.skills[0].summary; }, /summary/i],
  ['rejects an empty summary', (manifest) => { manifest.skills[0].summary = ''; }, /summary/i],
  ['rejects a multi-sentence summary', (manifest) => { manifest.skills[0].summary = 'First sentence. Second sentence.'; }, /summary/i],
  ['rejects an empty trigger', (manifest) => { manifest.skills[0].triggers[0] = ''; }, /triggers/i],
  ['rejects a duplicate trigger', (manifest) => { manifest.skills[0].triggers[1] = manifest.skills[0].triggers[0]; }, /triggers/i],
  ['rejects a non-string trigger', (manifest) => { manifest.skills[0].triggers[0] = 42; }, /triggers/i],
  ['rejects missing preconditions', (manifest) => { delete manifest.skills[0].preconditions; }, /preconditions/i],
  ['rejects a precondition list without the open-document requirement', (manifest) => { manifest.skills[0].preconditions = ['Targets are identifiable.']; }, /open in InDesign/i],
  ['rejects a tool listed as both allowed and forbidden', (manifest) => { manifest.skills[0].forbiddenTools.push('rollback_edit'); }, /forbidden tools cannot be allowed.*rollback_edit/i],
];

for (const [name, mutate, expectedError] of additionalInvalidMetadataCases) {
  test(name, async (t) => {
    const manifest = createValidManifest();
    mutate(manifest);
    await withFixture(t, { manifest }, async (skillsDir) => {
      await assert.rejects(() => loadSkillCatalog(skillsDir), expectedError);
    });
  });
}

test('rejects Markdown that omits the manifest summary', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const manifest = createValidManifest();
    const path = join(skillsDir, 'safe-layout-edit.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(manifest.skills[0].summary, 'A different purpose.'));
    await assert.rejects(() => loadSkillCatalog(skillsDir), /When to use.*summary/i);
  });
});

test('rejects Markdown that omits the first manifest example', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const manifest = createValidManifest();
    const path = join(skillsDir, 'safe-layout-edit.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(manifest.skills[0].examples[0], 'A different request.'));
    await assert.rejects(() => loadSkillCatalog(skillsDir), /example request.*first manifest example/i);
  });
});

test('rejects a workflow missing any core tool reference', async (t) => {
  for (const tool of ['inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit']) {
    await t.test(tool, async (t) => {
      await withFixture(t, {}, async (skillsDir) => {
        const path = join(skillsDir, 'safe-layout-edit.md');
        writeFileSync(path, readFileSync(path, 'utf8').replace(`\`${tool}\``, tool));
        await assert.rejects(() => loadSkillCatalog(skillsDir), new RegExp(`workflow.*reference.*${tool}`));
      });
    });
  }
});

test('rejects unapproved and forbidden backticked tool references anywhere in Markdown', async (t) => {
  const cases = [
    ['an unapproved but valid tool', 'save_document', /save_document.*allowed|not.*allowed/i],
    ['a forbidden tool', 'execute_indesign_code', /execute_indesign_code.*allowed|not.*allowed/i],
    ['an unknown snake_case tool name', 'not_a_real_tool', /not_a_real_tool.*allowed|not.*allowed/i],
  ];
  for (const [name, tool, expectedError] of cases) {
    await t.test(name, async (t) => {
      await withFixture(t, {}, async (skillsDir) => {
        const path = join(skillsDir, 'safe-layout-edit.md');
        const content = readFileSync(path, 'utf8').replace(
          'Use it when the request identifies existing content that needs a controlled edit.',
          `Use it when the request identifies existing content that needs a controlled edit. Avoid \`${tool}\`.`,
        );
        writeFileSync(path, content);
        await assert.rejects(() => loadSkillCatalog(skillsDir), expectedError);
      });
    });
  }
});

test('rejects padded and call-shaped unapproved and forbidden backticked tool references', async (t) => {
  const cases = [
    ['a padded unapproved tool', '` save_document `', /save_document.*allowed|not.*allowed/i],
    ['a call-shaped unapproved tool', '`save_document()`', /save_document.*allowed|not.*allowed/i],
    ['a padded call-shaped unapproved tool', '` save_document () `', /save_document.*allowed|not.*allowed/i],
    ['a padded forbidden tool', '` execute_indesign_code `', /execute_indesign_code.*allowed|not.*allowed/i],
    ['a call-shaped forbidden tool', '`execute_indesign_code()`', /execute_indesign_code.*allowed|not.*allowed/i],
    ['a padded call-shaped forbidden tool', '` execute_indesign_code () `', /execute_indesign_code.*allowed|not.*allowed/i],
  ];
  for (const [name, reference, expectedError] of cases) {
    await t.test(name, async (t) => {
      await withFixture(t, {}, async (skillsDir) => {
        const path = join(skillsDir, 'safe-layout-edit.md');
        const content = readFileSync(path, 'utf8').replace(
          'Use it when the request identifies existing content that needs a controlled edit.',
          `Use it when the request identifies existing content that needs a controlled edit. Avoid ${reference}.`,
        );
        writeFileSync(path, content);
        await assert.rejects(() => loadSkillCatalog(skillsDir), expectedError);
      });
    });
  }
});

test('rejects unapproved and forbidden backticked tool calls with arguments', async (t) => {
  const cases = [
    ['an unapproved tool call with arguments', '`save_document({})`', /save_document.*allowed|not.*allowed/i],
    ['a forbidden tool call with arguments', '`execute_indesign_code({})`', /execute_indesign_code.*allowed|not.*allowed/i],
  ];
  for (const [name, reference, expectedError] of cases) {
    await t.test(name, async (t) => {
      await withFixture(t, {}, async (skillsDir) => {
        const path = join(skillsDir, 'safe-layout-edit.md');
        const content = readFileSync(path, 'utf8').replace(
          'Use it when the request identifies existing content that needs a controlled edit.',
          `Use it when the request identifies existing content that needs a controlled edit. Avoid ${reference}.`,
        );
        writeFileSync(path, content);
        await assert.rejects(() => loadSkillCatalog(skillsDir), expectedError);
      });
    });
  }
});

test('allows approved tool references and ordinary backticked prose', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const path = join(skillsDir, 'safe-layout-edit.md');
    const content = readFileSync(path, 'utf8').replace(
      'Use it when the request identifies existing content that needs a controlled edit.',
      'Use it when the request identifies `existing content`, `page 1`, `safe-layout-edit`, ` inspect_layout `, `verify_layout()`, or `inspect_layout({})` that needs a controlled edit.',
    );
    writeFileSync(path, content);
    const skills = await loadSkillCatalog(skillsDir);
    assert.equal(skills.length, 6);
  });
});

test('isolates cached catalog definitions from caller mutation', async () => {
  const first = await loadSkillCatalog();
  const second = await loadSkillCatalog();
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  for (const field of ['triggers', 'examples', 'preconditions', 'allowedTools', 'forbiddenTools', 'qualityCriteria']) {
    assert.notEqual(first[0][field], second[0][field]);
  }

  first.push({ id: 'injected-skill' });
  first[0].id = 'mutated-skill';
  first[0].summary = 'Mutated summary.';
  first[0].allowedTools.push('execute_indesign_code');
  first[0].triggers.push('Mutated trigger');
  first[0].qualityCriteria[0] = 'Mutated criterion';

  const fresh = await loadSkillCatalog();
  assert.deepEqual(fresh.map((skill) => skill.id), EXPECTED_SKILLS.map((skill) => skill.id));
  assert.equal(fresh[0].summary, 'Makes precise, reversible changes to an existing InDesign layout without disturbing unrelated content.');
  assert.deepEqual(fresh[0].allowedTools, EXPECTED_SKILLS[0].allowedTools);
  assert.equal(fresh[0].triggers.length, 2);
  assert.deepEqual(fresh[0].qualityCriteria, EXPECTED_SKILLS[0].qualityCriteria);
});

test('isolates getSkill results from caller mutation', async () => {
  const first = await getSkill('safe-layout-edit');
  const second = await getSkill('safe-layout-edit');
  assert.notEqual(first, second);
  first.allowedTools.push('execute_indesign_code');
  first.preconditions[0] = 'A document is closed.';
  first.content = 'Replaced instructions';

  const fresh = await getSkill('safe-layout-edit');
  assert.deepEqual(fresh.allowedTools, EXPECTED_SKILLS[0].allowedTools);
  assert.equal(fresh.preconditions[0], OPEN_DOCUMENT);
  assert.match(fresh.content, /^# Safe Layout Edit/);
});

test('isolates listSkills summaries from caller mutation', async () => {
  const first = await listSkills();
  const second = await listSkills();
  assert.notEqual(first, second);
  assert.notEqual(first[0], second[0]);
  first[0].allowedTools.push('execute_indesign_code');
  first[0].examples[0] = 'Mutated example';
  first.pop();

  const fresh = await listSkills();
  assert.deepEqual(fresh.map((skill) => skill.id), EXPECTED_SKILLS.map((skill) => skill.id));
  assert.deepEqual(fresh[0].allowedTools, EXPECTED_SKILLS[0].allowedTools);
  assert.equal(fresh[0].examples[0], 'Move the title down 8 millimeters, keep it inside the margin, and make sure the body text still fits.');
});

test('isolates custom catalog results from caller mutation', async (t) => {
  await withFixture(t, {}, async (skillsDir) => {
    const first = await loadSkillCatalog(skillsDir);
    first[0].allowedTools.push('execute_indesign_code');
    first[0].qualityCriteria[0] = 'Mutated criterion';
    const fresh = await loadSkillCatalog(skillsDir);
    assert.deepEqual(fresh[0].allowedTools, EXPECTED_SKILLS[0].allowedTools);
    assert.deepEqual(fresh[0].qualityCriteria, EXPECTED_SKILLS[0].qualityCriteria);
  });
});
