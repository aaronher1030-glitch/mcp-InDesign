# InDesign Portable Skill Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portable, risk-aware InDesign skill runtime that produces precise existing-document edits with structural and visual verification in both Copilot and external MCP clients.

**Architecture:** Keep the existing stdio MCP server, HTTP/WebSocket bridge, and UXP plugin. Add a filesystem skill catalog, a shared plan/approval/execution runtime, deterministic structural checks, rendered-page visual review, and five high-level MCP tools. Copilot and external clients author plans with their own model; the server validates and enforces them.

**Tech Stack:** Node.js 20+, JavaScript ES modules, `@modelcontextprotocol/sdk` ^1.32.2, Express 4, `ws` 8, `node:test`, Adobe InDesign 2024 UXP.

**Spec:** `docs/superpowers/specs/2026-11-25-indesign-portable-skill-runtime-design.md`

## Global Constraints

- Target Windows with Adobe InDesign 2024+ and Node.js 20+.
- Preserve stdio MCP transport and the existing 135 low-level tools.
- Keep the bridge bound to `127.0.0.1:3000` and `127.0.0.1:3001`.
- Standard skill plans must not call `execute_indesign_code`.
- Never auto-save the user's original document.
- A full visual pass requires both valid structured visual output and structural success.
- If visual review is unavailable, return `structurally_checked_only`; never report a full pass.
- API keys remain in memory and must not appear in plans, logs, resources, artifacts, or tests.
- High-risk edits require explicit approval of the exact plan version.
- The project is not a Git repository. Do not create commits; use the review checkpoints below.
- All new automated tests use `node --test` and must pass without a live InDesign connection unless explicitly marked live.

## File Structure

### Created

- `skills/manifest.json` — metadata for the six portable skills.
- `skills/safe-layout-edit.md` — master edit workflow.
- `skills/text-typography-edit.md` — text and typography workflow.
- `skills/align-distribute.md` — alignment and distribution workflow.
- `skills/image-reframe.md` — image frame and crop workflow.
- `skills/style-consistency.md` — style reuse workflow.
- `skills/multi-page-consistency.md` — high-risk multi-page workflow.
- `src/utils/pageRange.js` — page-range parsing shared by export and rendering.
- `src/skills/registry.js` — loads and validates the portable catalog.
- `src/skills/units.js` — explicit millimeter/point conversion.
- `src/skills/planSchema.js` — plan normalization, validation, fingerprints, and risk policy.
- `src/skills/inspector.js` — document and page inspection through existing handlers.
- `src/skills/editJournal.js` — before-state and inverse-operation journal.
- `src/skills/runtime.js` — plan state machine and execution coordination.
- `src/skills/backup.js` — filesystem backup and guarded restore for high-risk edits.
- `src/quality/structuralChecks.js` — deterministic before/after checks.
- `src/quality/pageRenderer.js` — before/after PNG rendering.
- `src/quality/visualReview.js` — vision-model request and structured response validation.
- `src/quality/verifier.js` — combines structural and visual verification.
- `src/types/toolDefinitionsSkills.js` — schemas for the five high-level tools.
- `tests/test-export-images.js`
- `tests/test-skill-registry.js`
- `tests/test-units.js`
- `tests/test-plan-schema.js`
- `tests/test-inspector.js`
- `tests/test-structural-checks.js`
- `tests/test-skill-runtime.js`
- `tests/test-mcp-skills.js`
- `tests/test-page-renderer.js`
- `tests/test-visual-review.js`
- `tests/test-verifier.js`
- `tests/test-backup.js`
- `tests/test-bridge-auth.js`

### Modified

- `src/types/toolDefinitionsExport.js` — correct `export_images` schema.
- `src/handlers/exportHandlers.js` — correct arguments, page ranges, and output verification.
- `src/types/index.js` — include high-level skill tools.
- `src/core/InDesignMCPServer.js` — prompts, resources, high-level tools, dependency injection.
- `src/chat/agent.js` — skill-first prompt, filtered tools, approval events, runtime context.
- `src/chat/providers.js` — only if image-content passthrough tests expose a required adapter change.
- `bridge/server.js` — authenticate `/chat` and `/status`; support approval requests.
- `plugin/index.js` — render approval cards and submit approval decisions.
- `plugin/index.html` — approval card styles and container.
- `package.json` — run all skill-runtime tests in the default test script.
- `README.md` — setup and usage for skills, approvals, verification, and rollback.
- `docs/MCP_INSTRUCTIONS.md` — external-client workflow.
- `docs/LLM_PROMPT.md` — replace stale AppleScript/mm-only guidance with the portable skill protocol.

## Task Dependencies

- Tasks 1–4 are independent foundations.
- Task 5 depends on Tasks 3 and 4.
- Task 6 depends on Tasks 2 and 5.
- Task 7 depends on Task 1.
- Task 8 depends on Tasks 4, 5, and 7.
- Task 9 depends on Tasks 6 and 8.
- Task 10 depends on all previous tasks.

---

### Task 1: Correct the Image Export Contract

**Files:**

- Create: `src/utils/pageRange.js`
- Modify: `src/handlers/exportHandlers.js:112-191`
- Modify: `src/types/toolDefinitionsExport.js:24-37`
- Create: `tests/test-export-images.js`

**Interfaces:**

- Produces: `parsePageRange(value, pageCount) -> number[]` returning sorted, unique zero-based page indexes.
- Produces: `exportImages({ outputPath, format, quality, resolution, pages })` matching the advertised schema.

- [ ] **Step 1: Write the failing page-range tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePageRange } from '../src/utils/pageRange.js';

test('parses all, single pages, lists, and inclusive ranges', () => {
  assert.deepEqual(parsePageRange('all', 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(parsePageRange('3', 5), [2]);
  assert.deepEqual(parsePageRange('1-3,5', 5), [0, 1, 2, 4]);
  assert.deepEqual(parsePageRange('5,1-2,2', 5), [0, 1, 4]);
});

test('rejects malformed and out-of-range pages', () => {
  assert.throws(() => parsePageRange('0', 5), /positive/);
  assert.throws(() => parsePageRange('2-4', 3), /range/);
  assert.throws(() => parsePageRange('1,x', 5), /Invalid page/);
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `node --test tests/test-export-images.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/utils/pageRange.js`.

- [ ] **Step 3: Implement the parser**

```js
export function parsePageRange(value = 'all', pageCount = 1) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error('pageCount must be a positive integer');
  }
  if (value === undefined || value === null || String(value).trim() === '') value = 'all';
  if (String(value).trim().toLowerCase() === 'all') {
    return Array.from({ length: pageCount }, (_, index) => index);
  }

  const pages = new Set();
  for (const rawPart of String(value).split(',')) {
    const part = rawPart.trim();
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start || end > pageCount) {
        throw new Error(`Page range is invalid: ${part}`);
      }
      for (let page = start; page <= end; page += 1) pages.add(page - 1);
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`Invalid page entry: ${part}`);
    const page = Number(part);
    if (page < 1 || page > pageCount) throw new Error(`Page is out of range: ${part}`);
    pages.add(page - 1);
  }
  return [...pages].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Update the schema and handler**

Change the `export_images` schema to:

```js
{
  name: 'export_images',
  description: 'Export selected pages as PNG, JPEG, or TIFF images',
  inputSchema: {
    type: 'object',
    properties: {
      outputPath: { type: 'string', description: 'Existing output directory' },
      format: { type: 'string', enum: ['PNG', 'JPEG', 'TIFF'], default: 'PNG' },
      resolution: { type: 'number', description: 'Resolution in DPI', default: 144 },
      pages: { type: 'string', description: 'all, 3, 1-5, or 1,3,5-7', default: 'all' },
      quality: { type: 'number', description: 'JPEG quality 1-100', default: 90 },
    },
    required: ['outputPath'],
  },
}
```

In `exportImages`, destructure `outputPath` and `pages`. First call the bridge with a read-only UXP snippet that returns `app.activeDocument.pages.length`. Parse the requested range in Node with `parsePageRange(pages, pageCount)`. Then call the bridge again with the validated zero-based indexes, use the existing `ExportFormat` mapping, export each requested page, and verify every expected file with `statSync` before returning success. Return the exported file paths in the result.

- [ ] **Step 5: Add a schema-contract test**

```js
import { allToolDefinitions } from '../src/types/index.js';

test('export_images schema matches handler arguments', () => {
  const definition = allToolDefinitions.find((tool) => tool.name === 'export_images');
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), [
    'format', 'outputPath', 'pages', 'quality', 'resolution',
  ]);
  assert.equal(definition.inputSchema.required[0], 'outputPath');
});
```

- [ ] **Step 6: Run the task tests**

Run: `node --test tests/test-export-images.js`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm no caller still uses `folderPath` or `pageRange` for `export_images`. Search with Grep and update only callers introduced by this plan.

---

### Task 2: Create the Portable Skill Catalog and Registry

**Files:**

- Create: `skills/manifest.json`
- Create: `skills/safe-layout-edit.md`
- Create: `skills/text-typography-edit.md`
- Create: `skills/align-distribute.md`
- Create: `skills/image-reframe.md`
- Create: `skills/style-consistency.md`
- Create: `skills/multi-page-consistency.md`
- Create: `src/skills/registry.js`
- Create: `tests/test-skill-registry.js`

**Interfaces:**

- Produces: `loadSkillCatalog(skillsDir?) -> Promise<SkillDefinition[]>`
- Produces: `getSkill(id) -> Promise<SkillDefinition>`
- Produces: `listSkills() -> Promise<SkillSummary[]>`
- `SkillDefinition` contains `id`, `name`, `summary`, `version`, `triggers`, `examples`, `preconditions`, `allowedTools`, `forbiddenTools`, `defaultRisk`, `qualityCriteria`, and `content`.

- [ ] **Step 1: Write the failing registry tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { listSkills, getSkill } from '../src/skills/registry.js';

test('loads all six portable skills', async () => {
  const skills = await listSkills();
  assert.deepEqual(skills.map((skill) => skill.id), [
    'safe-layout-edit',
    'text-typography-edit',
    'align-distribute',
    'image-reframe',
    'style-consistency',
    'multi-page-consistency',
  ]);
});

test('returns instructions and rejects unknown skills', async () => {
  const skill = await getSkill('safe-layout-edit');
  assert.match(skill.content, /Inspect/);
  assert.match(skill.content, /Verify/);
  await assert.rejects(() => getSkill('missing'), /Unknown skill/);
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `node --test tests/test-skill-registry.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/skills/registry.js`.

- [ ] **Step 3: Create the exact catalog metadata**

Create `skills/manifest.json` with six entries. Each entry must contain:

- `id` and `name` matching the file name.
- `version: "1.0.0"`.
- A one-sentence `summary`.
- At least two `triggers`.
- At least one `examples` entry.
- `preconditions` containing `"A document is open in InDesign."`
- Exact `allowedTools` from the table below.
- `forbiddenTools` containing `execute_indesign_code`, `close_document`, `print_book`, and `package_document`.
- `defaultRisk` of `low` except `multi-page-consistency`, which is `high`.
- At least three `qualityCriteria`.

| Skill | Allowed tools |
|---|---|
| `safe-layout-edit` | `inspect_layout`, `plan_edit`, `apply_edit_plan`, `verify_layout`, `rollback_edit` |
| `text-typography-edit` | `inspect_layout`, `plan_edit`, `apply_edit_plan`, `verify_layout`, `rollback_edit`, `edit_text_frame`, `apply_paragraph_style`, `apply_character_style`, `create_paragraph_style`, `create_character_style` |
| `align-distribute` | `inspect_layout`, `plan_edit`, `apply_edit_plan`, `verify_layout`, `rollback_edit`, `move_page_item`, `resize_page_item`, `set_page_item_properties` |
| `image-reframe` | `inspect_layout`, `plan_edit`, `apply_edit_plan`, `verify_layout`, `rollback_edit`, `resize_page_item`, `set_page_item_properties`, `get_image_info` |
| `style-consistency` | `inspect_layout`, `plan_edit`, `apply_edit_plan`, `verify_layout`, `rollback_edit`, `list_styles`, `list_color_swatches`, `apply_paragraph_style`, `apply_character_style`, `apply_object_style`, `apply_color` |
| `multi-page-consistency` | `inspect_layout`, `plan_edit`, `apply_edit_plan`, `verify_layout`, `rollback_edit`, `list_spreads`, `get_spread_info`, `apply_master_spread` |

- [ ] **Step 4: Create the six Markdown skill files**

Every file must use the same section order as this complete `safe-layout-edit.md` example:

```markdown
# Safe Layout Edit

## When to use
Use this skill for precise changes to an existing InDesign layout. Use it when the request names objects, pages, styles, spacing, or visual intent but does not require a new document.

## Preconditions
- A document is open in InDesign.
- The requested pages and targets can be identified from inspection output.

## Workflow
1. Call `inspect_layout` for the affected pages.
2. Author a structured plan using the inspection IDs and fingerprints.
3. Call `plan_edit` and obey its risk classification.
4. Call `apply_edit_plan` only with required approval.
5. Call `verify_layout` and inspect before/after artifacts.
6. Report changed objects and unresolved findings.

## Quality criteria
- Only planned targets change.
- No new text overflow or out-of-bounds content appears.
- No unintended style duplication occurs.
- Structural and visual results are reported separately.

## Example request
> Move the title down 8 millimeters, keep it inside the margin, and make sure the body text still fits.
```

For the other five files, use the same headings and workflow, replace the H1 with the exact skill name, and use the criteria below:

- `safe-layout-edit`: only planned targets change; no new overflow; no unintended style duplication; visual and structural results are reported separately.
- `text-typography-edit`: no overset text; hierarchy remains clear; leading and alignment are consistent; existing styles are reused when suitable.
- `align-distribute`: gaps are equal within the plan tolerance; items align to the chosen margin/grid/neighbor; no item leaves the page unexpectedly.
- `image-reframe`: aspect ratio follows the stated crop intent; effective resolution is acceptable; links remain valid; frame stays within planned bounds.
- `style-consistency`: existing styles/colors are preferred; no duplicate styles are created without approval; typography remains consistent across targets.
- `multi-page-consistency`: repeated elements align across pages; masters and folios remain coherent; no unrelated page changes; approval is always required.

- [ ] **Step 5: Implement the registry**

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_DIR = join(__dirname, '../../skills');
let cache;

export async function loadSkillCatalog(skillsDir = DEFAULT_DIR) {
  if (cache && skillsDir === DEFAULT_DIR) return cache;
  const manifest = JSON.parse(readFileSync(join(skillsDir, 'manifest.json'), 'utf8'));
  const skills = manifest.skills.map((meta) => {
    const content = readFileSync(join(skillsDir, `${meta.id}.md`), 'utf8');
    return { ...meta, content };
  });
  if (skillsDir === DEFAULT_DIR) cache = skills;
  return skills;
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
```

Add manifest validation that rejects duplicate IDs, missing Markdown files, empty `allowedTools`, and missing `qualityCriteria`.

- [ ] **Step 6: Run the task tests**

Run: `node --test tests/test-skill-registry.js`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm the catalog contains exactly six skills and no skill allows `execute_indesign_code`.

---

### Task 3: Define Plan Contracts, Units, Fingerprints, and Risk Policy

**Files:**

- Create: `src/skills/units.js`
- Create: `src/skills/planSchema.js`
- Create: `tests/test-units.js`
- Create: `tests/test-plan-schema.js`

**Interfaces:**

- Produces: `toPoints(value, unit) -> number` and `fromPoints(value, unit) -> number` for `mm`, `cm`, `in`, and `pt`.
- Produces: `normalizePlanInput({ inspection, skillId, plan, now }) -> EditPlan`.
- Produces: `validatePlan(plan) -> { valid, errors }`.
- Produces: `classifyPlanRisk(plan) -> "low" | "high"`.
- Produces: `documentFingerprint(inspection) -> string`.
- Produces: `targetFingerprint(target) -> string`.
- `EditPlan.status` is one of `draft`, `approval_required`, `approved`, `applying`, `applied`, `verified`, `failed`, `rolled_back`.

- [ ] **Step 1: Write failing unit-conversion tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { toPoints, fromPoints } from '../src/skills/units.js';

test('converts millimeters and points exactly', () => {
  assert.equal(toPoints(25.4, 'mm'), 72);
  assert.equal(fromPoints(72, 'mm'), 25.4);
  assert.equal(toPoints(1, 'in'), 72);
  assert.equal(fromPoints(28.346456692913385, 'cm'), 10);
});

test('rejects unknown units', () => {
  assert.throws(() => toPoints(10, 'pixels'), /Unsupported unit/);
});
```

- [ ] **Step 2: Write failing plan-policy tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlanRisk, normalizePlanInput, targetFingerprint } from '../src/skills/planSchema.js';

const inspection = {
  document: { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 2 },
  pages: [{ index: 0, items: [] }],
};

function plan(steps = [{ toolName: 'move_page_item', arguments: { x: 10, y: 20 } }]) {
  return {
    targets: [{ pageIndex: 0, itemIndex: 0, before: { geometricBounds: [0, 0, 20, 20] } }],
    steps,
    affectedPages: [0],
    expectedChanges: ['Move title'],
    qualityCriteria: ['No overflow'],
  };
}

test('classifies a small reversible move as low risk', () => {
  const normalized = normalizePlanInput({ inspection, skillId: 'align-distribute', plan: plan() });
  assert.equal(classifyPlanRisk(normalized), 'low');
  assert.equal(normalized.status, 'draft');
  assert.equal(normalized.version, 1);
});

test('deletion and multi-page plans are high risk', () => {
  const deletion = normalizePlanInput({ inspection, skillId: 'safe-layout-edit', plan: plan([
    { toolName: 'delete_page_item', arguments: { pageIndex: 0, itemIndex: 0 } },
  ]) });
  assert.equal(classifyPlanRisk(deletion), 'high');
  const multi = plan();
  multi.affectedPages = [0, 1];
  assert.equal(classifyPlanRisk(normalizePlanInput({ inspection, skillId: 'safe-layout-edit', plan: multi })), 'high');
});

test('fingerprints change when geometry changes', () => {
  assert.notEqual(
    targetFingerprint({ pageIndex: 0, itemIndex: 0, before: { geometricBounds: [0, 0, 20, 20] } }),
    targetFingerprint({ pageIndex: 0, itemIndex: 0, before: { geometricBounds: [0, 0, 30, 20] } }),
  );
});
```

- [ ] **Step 3: Run tests and verify the expected failure**

Run: `node --test tests/test-units.js tests/test-plan-schema.js`

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement unit conversion**

```js
const POINTS_PER_UNIT = { pt: 1, mm: 72 / 25.4, cm: 72 / 2.54, in: 72 };

export function toPoints(value, unit) {
  if (!Number.isFinite(value)) throw new Error('Measurement must be finite');
  if (!POINTS_PER_UNIT[unit]) throw new Error(`Unsupported unit: ${unit}`);
  return value * POINTS_PER_UNIT[unit];
}

export function fromPoints(value, unit) {
  if (!Number.isFinite(value)) throw new Error('Measurement must be finite');
  if (!POINTS_PER_UNIT[unit]) throw new Error(`Unsupported unit: ${unit}`);
  return value / POINTS_PER_UNIT[unit];
}
```

- [ ] **Step 5: Implement plan normalization and risk policy**

Use `crypto.randomUUID()` for plan IDs. Set `expiresAt` to ten minutes after `now`. Copy the inspection fingerprint and units into the plan. Normalize each step to include `id`, `toolName`, `arguments`, `reversible`, and `risk`.

Define the low-risk allowlist exactly:

```js
const LOW_RISK_TOOLS = new Set([
  'move_page_item',
  'resize_page_item',
  'set_page_item_properties',
  'edit_text_frame',
  'apply_paragraph_style',
  'apply_character_style',
  'apply_object_style',
  'apply_color',
]);
```

A plan is low risk only when every step uses the allowlist, there are at most five targets, at most one affected page, every step is reversible, and the skill is not `multi-page-consistency`. Everything else is high risk. Set high-risk normalized plans to `approval_required`; low-risk plans remain `draft` until applied.

Implement `validatePlan` to reject missing inspection fingerprints, empty steps, unknown tools, missing target fingerprints, malformed arguments, and `execute_indesign_code`.

- [ ] **Step 6: Run the task tests**

Run: `node --test tests/test-units.js tests/test-plan-schema.js`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm later tasks use the exact status names and field names defined here.

---

### Task 4: Implement Layout Inspection and Structural Checks

**Files:**

- Create: `src/skills/inspector.js`
- Create: `src/quality/structuralChecks.js`
- Create: `tests/test-inspector.js`
- Create: `tests/test-structural-checks.js`

**Interfaces:**

- Produces: `inspectLayout({ pageRange }, callTool) -> Promise<Inspection>`.
- Produces: `runStructuralChecks({ before, after, plan }) -> { pass, issues }`.
- `Inspection` contains `inspectionId`, `document`, `pages`, `styles`, `colors`, `layers`, `validation`, and `fingerprint`.
- Each page contains `index`, `items`, and `summary`.

- [ ] **Step 1: Write failing inspector tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLayout } from '../src/skills/inspector.js';

test('inspects document, styles, layers, and requested pages', async () => {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    const results = {
      get_document_info: { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 2, width: 210, height: 297 },
      get_document_styles: { paragraph: ['Body'], character: [], object: [] },
      get_document_colors: ['Black', 'Brand Blue'],
      get_document_layers: ['Layer 1'],
      validate_document: { issues: [] },
      list_page_items: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] },
    };
    return { success: true, result: results[name] };
  };

  const inspection = await inspectLayout({ pageRange: '1' }, callTool);
  assert.equal(inspection.document.name, 'Brief');
  assert.equal(inspection.pages.length, 1);
  assert.equal(inspection.pages[0].items[0].name, 'Title');
  assert.equal(calls.filter((call) => call.name === 'list_page_items').length, 1);
  assert.equal(calls.find((call) => call.name === 'list_page_items').args.pageIndex, 0);
});
```

- [ ] **Step 2: Write failing structural-check tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runStructuralChecks } from '../src/quality/structuralChecks.js';

test('detects new overflow and unintended item deletion', () => {
  const before = {
    pages: [{ index: 0, items: [
      { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100], overset: false },
      { index: 1, name: 'Logo', geometricBounds: [10, 120, 30, 160], overset: false },
    ] }],
  };
  const after = {
    pages: [{ index: 0, items: [
      { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100], overset: true },
    ] }],
  };
  const plan = {
    targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title' }],
    expectedChanges: ['Move title'],
  };
  const result = runStructuralChecks({ before, after, plan });
  assert.equal(result.pass, false);
  assert.ok(result.issues.some((issue) => issue.code === 'TEXT_OVERFLOW'));
  assert.ok(result.issues.some((issue) => issue.code === 'UNINTENDED_ITEM_REMOVAL'));
});
```

- [ ] **Step 3: Run tests and verify the expected failure**

Run: `node --test tests/test-inspector.js tests/test-structural-checks.js`

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement inspection**

Call `get_document_info`, `get_document_styles`, `get_document_colors`, `get_document_layers`, and `validate_document`. Parse `pageRange` with `parsePageRange`. For each requested zero-based page index, call `list_page_items` and `get_page_content_summary`. Unwrap successful handler results from `.result`; throw a structured error when `success` is false. Generate `inspectionId` with `crypto.randomUUID()` and compute the document fingerprint using the plan-schema helper.

- [ ] **Step 5: Implement structural checks**

Compare before/after page-item multisets by stable name/index fingerprint. Emit these exact issue codes:

- `PAGE_COUNT_CHANGED`
- `UNINTENDED_ITEM_ADDITION`
- `UNINTENDED_ITEM_REMOVAL`
- `TEXT_OVERFLOW`
- `OUT_OF_BOUNDS`
- `MISSING_LINK`
- `MISSING_FONT`
- `DUPLICATE_STYLE`
- `TARGET_STATE_MISMATCH`

Only planned targets may change. Page-count changes are allowed only when the plan explicitly contains a page-add or page-delete step. Use the document width/height and planned bleed values for bounds checks.

- [ ] **Step 6: Run the task tests**

Run: `node --test tests/test-inspector.js tests/test-structural-checks.js`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm inspection never mutates the document and structural checks never call InDesign.

---

### Task 5: Implement the Edit Journal and Low-Risk Runtime

**Files:**

- Create: `src/skills/editJournal.js`
- Create: `src/skills/runtime.js`
- Create: `tests/test-skill-runtime.js`

**Interfaces:**

- Produces: `class EditJournal` with `recordBefore(step, target)`, `recordSuccess(step, result)`, `inverseSteps()`, and `summary()`.
- Produces: `class SkillRuntime` with:
  - `createInspection(input) -> Promise<Inspection>`
  - `createPlan({ inspectionId, skillId, plan }) -> EditPlan`
  - `applyPlan({ planId, approved, expectedVersion }) -> Promise<ApplyResult>`
  - `getPlan(planId) -> EditPlan`
  - `rollbackPlan(planId) -> Promise<RollbackResult>`
- Constructor: `new SkillRuntime({ callTool, now = () => new Date() })`.

- [ ] **Step 1: Write failing runtime tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillRuntime } from '../src/skills/runtime.js';

const documentResult = { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 1, width: 210, height: 297 };

function createRuntime() {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_document_info') return { success: true, result: documentResult };
    if (name === 'list_page_items') return { success: true, result: { items: [
      { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
    ] } };
    if (name === 'validate_document') return { success: true, result: { issues: [] } };
    return { success: true, result: { ok: true } };
  };
  return { runtime: new SkillRuntime({ callTool }), calls };
}

const movePlan = {
  targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
  steps: [{ toolName: 'move_page_item', arguments: { pageIndex: 0, itemIndex: 0, x: 10, y: 20 } }],
  affectedPages: [0],
  expectedChanges: ['Move title down'],
  qualityCriteria: ['No overflow'],
};

test('creates and applies a low-risk plan', async () => {
  const { runtime, calls } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  assert.equal(plan.status, 'draft');
  const result = await runtime.applyPlan({ planId: plan.planId, approved: false, expectedVersion: 1 });
  assert.equal(result.status, 'applied');
  assert.ok(calls.some((call) => call.name === 'move_page_item'));
});

test('blocks high-risk plans without approval', async () => {
  const { runtime, calls } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const risky = { ...movePlan, steps: [{ toolName: 'delete_page_item', arguments: { pageIndex: 0, itemIndex: 0 } }] };
  const plan = runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'safe-layout-edit', plan: risky });
  assert.equal(plan.status, 'approval_required');
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId, approved: false, expectedVersion: 1 }),
    /APPROVAL_REQUIRED/,
  );
  assert.equal(calls.some((call) => call.name === 'delete_page_item'), false);
});

test('rolls back completed low-risk steps after a later failure', async () => {
  const calls = [];
  let failProperties = false;
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_document_info') return { success: true, result: documentResult };
    if (name === 'list_page_items') return { success: true, result: { items: [
      { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
    ] } };
    if (name === 'move_page_item') return { success: true, result: { ok: true } };
    if (name === 'set_page_item_properties' && failProperties) return { success: false, result: 'failed' };
    return { success: true, result: { ok: true } };
  };
  const runtime = new SkillRuntime({ callTool });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: {
    ...movePlan,
    steps: [
      movePlan.steps[0],
      { toolName: 'set_page_item_properties', arguments: { pageIndex: 0, itemIndex: 0, fillColor: 'Red' } },
    ],
  } });
  failProperties = true;
  await assert.rejects(() => runtime.applyPlan({ planId: plan.planId, approved: false, expectedVersion: 1 }), /STEP_FAILED/);
  assert.equal(calls.at(-1).name, 'move_page_item');
  assert.equal(calls.at(-1).args.y, 10);
});
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run: `node --test tests/test-skill-runtime.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/skills/runtime.js`.

- [ ] **Step 3: Implement the journal**

For each successful step, store the tool name, arguments, result, target before-state, and inverse call. Generate inverse calls only for the low-risk allowlist:

- `move_page_item`: restore prior `x`/`y` from `geometricBounds[1]`/`[0]`, converting units explicitly.
- `resize_page_item`: restore prior width/height from bounds.
- `set_page_item_properties`: restore only properties present in the target before-state.
- Style/color tools: reapply the prior style/color recorded in the target before-state.
- `edit_text_frame`: restore prior text content when it was captured.

If an inverse cannot be constructed, mark the plan high risk during normalization.

- [ ] **Step 4: Implement the runtime state machine**

Store inspections and plans in memory maps. `createPlan` loads the inspection, normalizes the plan, and stores it. `applyPlan` checks expiration, version, approval, and document fingerprint by calling `get_document_info` immediately before execution. It then calls each low-level handler sequentially. Any `success: false` result becomes `STEP_FAILED`, triggers inverse calls in reverse order, and marks the plan `rolled_back` when restoration succeeds.

High-risk approved execution initially returns `BACKUP_REQUIRED`; Task 8 replaces that branch with backup and restore support.

- [ ] **Step 5: Run the task tests**

Run: `node --test tests/test-skill-runtime.js`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Confirm no high-risk mutation executes in this task and no original document save occurs.

---

### Task 6: Expose High-Level MCP Tools, Prompts, and Resources

**Files:**

- Create: `src/types/toolDefinitionsSkills.js`
- Modify: `src/types/index.js`
- Modify: `src/core/InDesignMCPServer.js`
- Create: `tests/test-mcp-skills.js`

**Interfaces:**

- Produces: `skillToolDefinitions` containing exactly `inspect_layout`, `plan_edit`, `apply_edit_plan`, `verify_layout`, and `rollback_edit`.
- `InDesignMCPServer` constructor accepts `{ callTool }` for tests.
- Produces methods `listPrompts()`, `getPrompt(name, args)`, `listResources()`, and `readResource(uri)`.

- [ ] **Step 1: Write failing MCP surface tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';

const fakeCallTool = async (name) => {
  if (name === 'get_document_info') return { success: true, result: { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 1, width: 210, height: 297 } };
  if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
  return { success: true, result: {} };
};

test('lists six prompts and portable resources', async () => {
  const server = new InDesignMCPServer({ callTool: fakeCallTool });
  assert.equal((await server.listPrompts()).prompts.length, 6);
  const resources = await server.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === 'indesign://skills/safe-layout-edit'));
  assert.ok(resources.resources.some((resource) => resource.uri === 'indesign://quality/rubric'));
});

test('gets a prompt and inspects through the injected tool caller', async () => {
  const server = new InDesignMCPServer({ callTool: fakeCallTool });
  const prompt = await server.getPrompt('indesign.safe_layout_edit', { request: 'Move the title down' });
  assert.match(prompt.messages[0].content.text, /Move the title down/);
  const result = await server.handleToolCall('inspect_layout', { pageRange: 'all' }, {});
  assert.equal(result.success, true);
  assert.equal(result.result.document.name, 'Brief');
});
```

- [ ] **Step 2: Run tests and verify the expected failure**

Run: `node --test tests/test-mcp-skills.js`

Expected: FAIL because prompt/resource methods and high-level tools do not exist.

- [ ] **Step 3: Add high-level tool schemas**

Create `src/types/toolDefinitionsSkills.js` with these exact required fields:

- `inspect_layout`: optional `pageRange`.
- `plan_edit`: required `inspectionId`, `skillId`, `plan`.
- `apply_edit_plan`: required `planId`, `expectedVersion`; high-risk authorization is issued server-side only after trusted MCP elicitation accepts the exact version.
- `verify_layout`: required `planId`; optional `visualReview`.
- `rollback_edit`: required `planId`; optional `reason`.

The `plan` schema must allow `targets`, `steps`, `affectedPages`, `expectedChanges`, and `qualityCriteria`, with each step requiring `toolName` and `arguments`.

- [ ] **Step 4: Wire prompts and resources**

Import the MCP schemas:

```js
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
```

Advertise `prompts: {}` and `resources: {}` in server capabilities. Register handlers that delegate to the new public methods. Prompt names use the six IDs from the spec. Resource URIs are:

- `indesign://skills/<skill-id>`
- `indesign://protocol/edit-lifecycle`
- `indesign://quality/rubric`

Return resource text from the same Markdown files and shared rubric used by the runtime.

- [ ] **Step 5: Refactor tool dispatch without breaking existing tools**

Rename the current large switch implementation to `handleLowLevelTool(name, args)`. Add a new `handleToolCall(name, args, context = {})` that dispatches the five high-level names to `this.runtime` and otherwise delegates to `handleLowLevelTool`.

Construct the runtime with the injected caller or the bound low-level dispatcher:

```js
this.runtime = new SkillRuntime({
  callTool: options.callTool || ((name, args) => this.handleLowLevelTool(name, args)),
});
```

Return successful high-level results as `{ success: true, result }` inside the existing text content shape. Return high-level operational failures with `isError: true` in the MCP response while preserving the existing text content shape.

- [ ] **Step 6: Run the task tests**

Run: `node --test tests/test-mcp-skills.js`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm `tools/list` now includes 140 tools and all six prompt names exactly match the skill catalog.

---

### Task 7: Implement Page Rendering and Visual Review

**Files:**

- Create: `src/quality/pageRenderer.js`
- Create: `src/quality/visualReview.js`
- Create: `tests/test-page-renderer.js`
- Create: `tests/test-visual-review.js`

**Interfaces:**

- Produces: `renderPages({ pages, outputDir, callTool }) -> Promise<{ paths, pageIndexes }>`.
- Produces: `reviewLayout({ beforePaths, afterPaths, intent, plan, settings, complete }) -> Promise<VisualReview>`.
- `VisualReview` is `{ status: "passed" | "failed" | "unavailable", pass, scores, findings, unintendedChanges, raw? }`.

- [ ] **Step 1: Write failing renderer tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPages } from '../src/quality/pageRenderer.js';

test('renders requested pages through the corrected export tool', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'indesign-render-test-'));
  try {
    const callTool = async (name, args) => {
      assert.equal(name, 'export_images');
      assert.equal(args.format, 'PNG');
      assert.equal(args.resolution, 144);
      assert.equal(args.pages, '1,3');
      writeFileSync(join(args.outputPath, 'page_1.png'), 'png');
      writeFileSync(join(args.outputPath, 'page_3.png'), 'png');
      return { success: true, result: { files: [join(args.outputPath, 'page_1.png'), join(args.outputPath, 'page_3.png')] } };
    };
    const result = await renderPages({ pages: [0, 2], outputDir, callTool });
    assert.deepEqual(result.pageIndexes, [0, 2]);
    assert.equal(result.paths.length, 2);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write failing visual-review tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewLayout } from '../src/quality/visualReview.js';

const review = {
  pass: true,
  scores: { hierarchy: 4, alignment: 5, spacing: 4, readability: 5, cropping: 5, consistency: 4 },
  findings: [],
  unintendedChanges: false,
};

test('builds provider-specific image messages and parses structured output', async () => {
  let request;
  const complete = async (input) => {
    request = input;
    return { content: JSON.stringify(review), toolCalls: [] };
  };
  const result = await reviewLayout({
    beforePaths: ['C:/tmp/before.png'],
    afterPaths: ['C:/tmp/after.png'],
    intent: 'Move title down',
    plan: { expectedChanges: ['Move title'] },
    settings: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'vision', apiKey: '' },
    complete,
  });
  assert.equal(result.status, 'passed');
  assert.equal(request.messages[0].content[1].type, 'image_url');
});

test('invalid model output becomes unavailable, never a pass', async () => {
  const result = await reviewLayout({
    beforePaths: [], afterPaths: [], intent: 'x', plan: {},
    settings: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'vision', apiKey: '' },
    complete: async () => ({ content: 'looks good', toolCalls: [] }),
  });
  assert.equal(result.status, 'unavailable');
});

test('Anthropic conversion preserves base64 image blocks', async () => {
  const { toAnthropic } = await import('../src/chat/providers.js');
  const converted = toAnthropic([{
    role: 'user',
    content: [
      { type: 'text', text: 'Review this page' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ],
  }]);
  assert.equal(converted.messages[0].content[1].source.data, 'abc');
});
```

- [ ] **Step 3: Run tests and verify the expected failure**

Run: `node --test tests/test-page-renderer.js tests/test-visual-review.js`

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement rendering**

Create a temporary directory with `mkdtempSync(join(tmpdir(), 'indesign-skill-'))` when `outputDir` is not supplied. Convert zero-based page indexes to the one-based `pages` string accepted by `export_images`. Call the tool with `format: "PNG"` and `resolution: 144`. Verify each expected `page_<n>.png` exists and is non-empty. Return absolute paths and original zero-based indexes.

- [ ] **Step 5: Implement visual review**

Read each PNG as base64. Build a user message containing the intent, plan summary, rubric, and image blocks. For OpenAI-compatible providers use:

```js
{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }
```

For Anthropic use:

```js
{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }
```

Call `completeChat` with no tools. Strip Markdown fences from the response, parse JSON, and validate all required fields. Any fetch error, non-JSON response, missing field, or invalid score becomes `status: "unavailable"` with the reason recorded.

- [ ] **Step 6: Run the task tests**

Run: `node --test tests/test-page-renderer.js tests/test-visual-review.js`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm no API key is included in prompts, artifacts, or returned raw errors.

---

### Task 8: Implement Verification, High-Risk Backups, and Guarded Rollback

**Files:**

- Create: `src/quality/verifier.js`
- Create: `src/skills/backup.js`
- Modify: `src/skills/runtime.js`
- Create: `tests/test-verifier.js`
- Create: `tests/test-backup.js`

**Interfaces:**

- Produces: `verifyPlan({ planId, visualReview, settings, complete, runtime, inspect = inspectLayout, render = renderPages, structural = runStructuralChecks }) -> Promise<VerificationResult>`.
- Produces: `createBackup({ document, artifactDir }) -> { backupPath, originalPath }`.
- Produces: `restoreOriginal({ originalPath, currentFingerprint, expectedFingerprint, callTool }) -> Promise<void>`.
- `VerificationResult.status` is `verified`, `failed`, or `structurally_checked_only`.

- [ ] **Step 1: Write failing backup tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreOriginal } from '../src/skills/backup.js';

test('copies a saved document and refuses stale restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'indesign-backup-test-'));
  try {
    const originalPath = join(dir, 'brief.indd');
    writeFileSync(originalPath, 'original');
    const backup = createBackup({ document: { filePath: originalPath }, artifactDir: join(dir, 'artifacts') });
    assert.equal(readFileSync(backup.backupPath, 'utf8'), 'original');
    await assert.rejects(
      () => restoreOriginal({ originalPath, currentFingerprint: 'changed', expectedFingerprint: 'expected', callTool: async () => {} }),
      /ROLLBACK_CONFLICT/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write failing verifier tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan } from '../src/quality/verifier.js';

const visualReview = {
  status: 'passed', pass: true,
  scores: { hierarchy: 4, alignment: 5, spacing: 4, readability: 5, cropping: 5, consistency: 4 },
  findings: [], unintendedChanges: false,
};

test('combines structural and client-provided visual review', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview,
    runtime: {
      getPlan: () => ({ planId: 'plan-1', status: 'applied', before: {}, after: {}, plan: { targets: [], expectedChanges: [] } }),
    },
    inspect: async () => ({}),
    render: async () => ({ paths: [] }),
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'verified');
});

test('missing visual review is structural-only', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    runtime: {
      getPlan: () => ({ planId: 'plan-1', status: 'applied', before: {}, after: {}, plan: { targets: [], expectedChanges: [] } }),
    },
    inspect: async () => ({}),
    render: async () => ({ paths: [] }),
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'structurally_checked_only');
});
```

- [ ] **Step 3: Run tests and verify the expected failure**

Run: `node --test tests/test-verifier.js tests/test-backup.js`

Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Implement backup and guarded restore**

`createBackup` rejects `Unsaved` or missing file paths. It creates the artifact directory, copies the saved `.indd` file with `copyFileSync`, and returns both paths. It must not call `save_document`.

`restoreOriginal` first compares current and expected fingerprints. On mismatch it throws `ROLLBACK_CONFLICT`. Otherwise it calls `close_document` with `saveOptions: "DISCARD"` and `open_document` with the original path. It verifies the reopened document fingerprint matches the original.

- [ ] **Step 5: Implement verification**

`verifyPlan` loads the plan, requires `status === "applied"`, calls `inspectLayout` for affected pages, runs structural checks, renders after-images, and pairs them with the plan's before-artifacts.

If a client-provided `visualReview` is present, validate it with the same schema used by `reviewLayout`. If Copilot settings are present, call `reviewLayout`. If neither is available, return `structurally_checked_only` with the artifact paths.

Return `verified` only when structural checks pass and visual review is `passed`. Return `failed` when either check fails. Never convert unavailable visual output into a pass.

- [ ] **Step 6: Extend the runtime for high-risk execution**

Before applying an approved high-risk plan, call `createBackup` and store the backup path in the journal. After low-risk or high-risk application, mark the plan `applied`; do not auto-verify unless Copilot requests it.

Extend `rollbackPlan`:

- Low risk: execute inverse journal steps in reverse order.
- High risk: call `restoreOriginal` with the guarded post-edit fingerprint.
- Any incomplete restoration returns `ROLLBACK_FAILED` and preserves the journal.

- [ ] **Step 7: Run the task tests**

Run: `node --test tests/test-verifier.js tests/test-backup.js tests/test-skill-runtime.js`

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Confirm high-risk plans without a saved document cannot execute and no rollback can overwrite newer user changes.

---

### Task 9: Integrate the Skill Workflow into Copilot

**Files:**

- Modify: `src/chat/agent.js`
- Modify: `bridge/server.js`
- Modify: `plugin/index.js`
- Modify: `plugin/index.html`

**Interfaces:**

- `runChat` uses `skillToolDefinitions` by default instead of all low-level tools.
- Tool calls receive context: `callTool(name, args, { settings })`.
- Approval results emit `{ type: "approval", planId, summary, affectedPages, beforeArtifacts }`.
- `POST /chat` accepts either `{ messages, settings }` or `{ approval: { planId, approved }, settings }`.

- [ ] **Step 1: Write failing agent tests**

Add to `tests/test-chat-agent.js`:

```js
test('emits an approval event and stops when a plan needs approval', async () => {
  const events = [];
  await runChat({
    messages: [{ role: 'user', content: 'Restyle every page' }],
    settings: { provider: 'openai', model: 'test', apiKey: 'secret' },
    emit: (event) => events.push(event),
    toolDefinitions: [{ name: 'plan_edit', description: 'Plan', inputSchema: { type: 'object', properties: {} } }],
    complete: async () => ({
      content: '',
      toolCalls: [{ id: 'call_1', function: { name: 'plan_edit', arguments: '{}' } }],
    }),
    callTool: async () => ({
      success: true,
      result: { status: 'approval_required', planId: 'plan-1', summary: 'Restyle all pages', affectedPages: [0, 1], beforeArtifacts: [] },
    }),
  });
  assert.ok(events.some((event) => event.type === 'approval' && event.planId === 'plan-1'));
  assert.ok(events.some((event) => event.type === 'done'));
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `node --test tests/test-chat-agent.js`

Expected: FAIL because no approval event is emitted.

- [ ] **Step 3: Update the agent prompt and tool set**

Replace the default `allToolDefinitions` import with `skillToolDefinitions`. Replace `SYSTEM_PROMPT` with a skill-first prompt that requires:

1. Call `inspect_layout` before planning.
2. Author a structured plan with stable target fingerprints.
3. Call `plan_edit` and obey `approval_required`.
4. Call `apply_edit_plan` only after approval.
5. Call `verify_layout`; for Copilot, pass settings so visual review can run automatically.
6. Report structural and visual results separately.

Pass `{ settings: config }` as the third argument to `callTool`.

After a tool result with `result.status === "approval_required"`, emit the approval event and end the turn with a done event. Do not ask the model to continue mutating.

- [ ] **Step 4: Add approval handling to the bridge**

Export trusted approval resolution from `src/chat/agent.js`. It uses the same server singleton, requires the current plan version and exact preflight render details, issues a private one-time capability only after panel acceptance, emits tool/progress/done events, and never accepts a plan ID from a different active server session.

Update `/chat` so bearer-token middleware protects it when configured. If `req.body.approval` exists, require `chatActive`, call `resolveApproval`, and finish the SSE response using the existing event helper.

- [ ] **Step 5: Add the Copilot approval card**

In `plugin/index.html`, add a hidden `approval` container with:

- plan summary text
- affected page list
- Approve button
- Cancel button

In `plugin/index.js`, handle `event.type === "approval"` by storing the exact pending plan/version, targets, steps, affected pages, and before-render details, then showing the container. Approve posts trusted panel context to `/chat`; the server issues the capability only after validating those details. Cancel clears the pending request. Clear the pending card on `done` or `error`.

- [ ] **Step 6: Run chat tests**

Run: `node --test tests/test-chat-agent.js tests/test-mcp-skills.js`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm the panel cannot approve a stale plan and stopping a turn prevents further tool execution.

---

### Task 10: Secure the Bridge, Update Documentation, and Run Full Verification

**Files:**

- Modify: `bridge/server.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/MCP_INSTRUCTIONS.md`
- Modify: `docs/LLM_PROMPT.md`

**Interfaces:**

- `BRIDGE_TOKEN`, when set, protects `/execute`, `/chat`, and `/status`.
- `npm test` runs every automated test created by this plan.

- [ ] **Step 1: Add bridge authentication tests**

Create a small Express-level test by exporting `createBridgeApp()` from `bridge/server.js` and injecting a token. Test that `/status`, `/execute`, and `/chat` return 401 without the bearer token and accept the token when present. Refactor `app.listen` behind `if (import.meta.url === pathToFileURL(process.argv[1]).href)` so tests do not open ports.

- [ ] **Step 2: Implement the authentication boundary**

Replace the `/execute`-only middleware with:

```js
if (BRIDGE_TOKEN) {
  app.use(['/execute', '/chat', '/status'], (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${BRIDGE_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized: missing or invalid BRIDGE_TOKEN' });
    }
    next();
  });
}
```

Update the UXP panel's `/chat` request to send the bearer token only when the user configured one in panel settings. Do not persist the token in skill files or logs.

- [ ] **Step 3: Update package scripts**

Set:

```json
{
  "test": "node --test tests/test-chat-agent.js tests/test-export-images.js tests/test-skill-registry.js tests/test-units.js tests/test-plan-schema.js tests/test-inspector.js tests/test-structural-checks.js tests/test-skill-runtime.js tests/test-mcp-skills.js tests/test-page-renderer.js tests/test-visual-review.js tests/test-verifier.js tests/test-backup.js tests/test-bridge-auth.js",
  "test:handlers": "node tests/test-all-handlers.js",
  "test:live": "node tests/unified-test-runner.js"
}
```

Exclude live/manual scripts that are not compatible with `node --test` or move them to explicitly named files that do not match `test-*.js`.

- [ ] **Step 4: Rewrite user-facing instructions**

Update `README.md` with:

- Node 20+ and InDesign 2024+ on Windows or macOS.
- Bridge and plugin setup.
- MCP configuration using `src/index.js`.
- The six skill prompts and five high-level tools.
- Risk-based approval behavior.
- Structural and visual verification.
- `structurally_checked_only` meaning.
- Rollback behavior and backup retention.
- `BRIDGE_TOKEN` setup.

Replace `docs/MCP_INSTRUCTIONS.md` with the external-client sequence:

1. Select a skill prompt.
2. Call `inspect_layout`.
3. Author and submit `plan_edit`.
4. Approve high-risk plans.
5. Call `apply_edit_plan`.
6. Read before/after artifact paths.
7. Submit `visualReview` to `verify_layout` or accept structural-only status.

Replace `docs/LLM_PROMPT.md` with the same model-facing rules, explicitly stating that coordinates require units, page/item indexes are zero-based in tool arguments, and arbitrary code is outside the standard workflow.

- [ ] **Step 5: Run the full automated suite**

Run: `npm test`

Expected: every automated test passes.

- [ ] **Step 6: Run static checks**

Run: `node --check src/core/InDesignMCPServer.js`

Run: `node --check src/skills/runtime.js`

Run: `node --check src/quality/verifier.js`

Run: `node --check bridge/server.js`

Expected: exit code 0 for each command.

- [ ] **Step 7: Perform live Windows verification**

With InDesign 2024 open and the UXP panel connected:

1. Start `npm run bridge`.
2. Load the plugin and confirm Connected.
3. Open a saved fixture document.
4. In Copilot, request a precise move and confirm only the target moves.
5. Request a high-risk multi-page restyle and confirm nothing changes before approval.
6. Approve it and confirm before/after renders and structural findings appear.
7. Trigger an intentional failed quality check and confirm rollback restores the original state.
8. Connect an external MCP client and repeat inspect → plan → approve → apply → verify.
9. Confirm the original file is unchanged until explicitly saved.

- [ ] **Step 8: Final review checkpoint**

Verify all spec acceptance criteria, record any live checks that could not be performed, and do not claim visual or InDesign success without direct evidence.

## Plan Self-Review

- Spec Sections 1–3 map to Tasks 2–6.
- Spec Sections 4–6 map to Tasks 2, 3, 5, and 6.
- Spec Sections 7–10 map to Tasks 3, 5, 6, and 8.
- Spec Sections 11–12 map to Tasks 7 and 8.
- Spec Sections 13–14 map to Task 9.
- Spec Sections 15–17 map to Tasks 1, 6, 9, and 10.
- Spec Sections 18–19 map to every task's test cycle and Task 10 live verification.
- No task requires a Git commit because the project is not a Git repository.
- Model boundaries are explicit: clients author plans and external visual reviews; the server validates and enforces them.

## References

- [Model Context Protocol — Prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)
- [Model Context Protocol — Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
