import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';
import { allToolDefinitions, skillToolDefinitions } from '../src/types/index.js';

const fakeCallTool = async (name) => {
  if (name === 'get_document_info') {
    return { success: true, result: { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 1, width: 210, height: 297 } };
  }
  if (name === 'list_page_items') {
    return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
  }
  return { success: true, result: {} };
};

async function createApprovalServer(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-approval-'));
  const filePath = join(dir, 'brief.indd');
  writeFileSync(filePath, 'saved baseline');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const server = new InDesignMCPServer({
    artifactDir: join(dir, 'artifacts'),
    elicitInput: options.elicitInput,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') {
        return { success: true, result: { name: 'Brief', filePath, pages: 3, width: 210, height: 297, saved: true, modified: false } };
      }
      if (name === 'list_page_items') {
        return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
      }
      return { success: true, result: {} };
    },
  });
  server.runtime.render = options.render ?? (async ({ pages }) => ({
    paths: pages.map((page) => `C:/renders/page_${page + 1}.png`),
    pageIndexes: pages,
  }));
  const inspected = await server.handleToolCall('inspect_layout', { pageRange: 'all' }, {});
  const planned = await server.handleToolCall('plan_edit', {
    inspectionId: inspected.result.inspectionId,
    skillId: 'multi-page-consistency',
    plan: {
      targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
      steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }],
      affectedPages: [0, 2],
      expectedChanges: ['Apply the shared master'],
      qualityCriteria: ['Masters stay coherent'],
    },
  }, {});
  return { server, calls, plan: planned.result };
}

test('exposes the six skill prompts and the portable resources', async () => {
  const server = new InDesignMCPServer({ callTool: fakeCallTool });
  const prompts = await server.listPrompts();
  assert.equal(prompts.prompts.length, 6);
  assert.deepEqual(
    prompts.prompts.map((prompt) => prompt.name),
    [
      'indesign.safe_layout_edit',
      'indesign.text_typography_edit',
      'indesign.align_distribute',
      'indesign.image_reframe',
      'indesign.style_consistency',
      'indesign.multi_page_consistency',
    ],
  );

  const resources = await server.listResources();
  assert.ok(resources.resources.some((resource) => resource.uri === 'indesign://skills/safe-layout-edit'));
  assert.ok(resources.resources.some((resource) => resource.uri === 'indesign://quality/rubric'));
  const read = await server.readResource('indesign://protocol/edit-lifecycle');
  assert.match(read.contents[0].text, /approval/i);
});

test('builds a skill prompt with the request and page range', async () => {
  const server = new InDesignMCPServer({ callTool: fakeCallTool });
  const prompt = await server.getPrompt('indesign.safe_layout_edit', {
    request: 'Move the title down',
    pageRange: '1',
  });
  const text = prompt.messages[0].content.text;
  assert.match(text, /Move the title down/);
  assert.match(text, /inspect_layout/);
  assert.match(text, /Page range: 1/);
});

test('inspects, plans and applies through the injected caller', async () => {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'move_page_item') return { success: true, result: { ok: true } };
    return fakeCallTool(name, args);
  };
  const server = new InDesignMCPServer({ callTool });

  const inspected = await server.handleToolCall('inspect_layout', { pageRange: 'all' }, {});
  assert.equal(inspected.success, true);
  assert.equal(inspected.result.document.name, 'Brief');

  const planned = await server.handleToolCall('plan_edit', {
    inspectionId: inspected.result.inspectionId,
    skillId: 'align-distribute',
    plan: {
      targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
      steps: [{ toolName: 'move_page_item', arguments: { pageIndex: 0, itemIndex: 0, x: 10, y: 20 } }],
      affectedPages: [0],
      expectedChanges: ['Move title down'],
      qualityCriteria: ['No overflow'],
    },
  }, {});
  assert.equal(planned.success, true);
  assert.equal(planned.result.status, 'draft');

  const applied = await server.handleToolCall('apply_edit_plan', {
    planId: planned.result.planId,
    expectedVersion: 1,
  }, {});
  assert.equal(applied.result.status, 'applied');
  assert.ok(calls.some((call) => call.name === 'move_page_item'));
});

test('lists skills and includes the high-level tools in the tool list', async () => {
  const server = new InDesignMCPServer({ callTool: fakeCallTool });
  const names = allToolDefinitions.map((tool) => tool.name);
  for (const name of ['inspect_layout', 'plan_edit', 'apply_edit_plan', 'verify_layout', 'rollback_edit', 'preview_layout', 'list_skills']) {
    assert.ok(names.includes(name), `${name} should be registered`);
  }
  const listed = await server.handleToolCall('list_skills', {}, {});
  assert.equal(listed.result.skills.length, 6);
});

test('apply_edit_plan schema excludes caller approval and describes human elicitation', () => {
  const apply = skillToolDefinitions.find((tool) => tool.name === 'apply_edit_plan');
  assert.deepEqual(apply.inputSchema.required, ['planId']);
  assert.equal(Object.hasOwn(apply.inputSchema.properties, 'approved'), false);
  assert.equal(Object.hasOwn(apply.inputSchema.properties, 'approvalToken'), false);
  assert.doesNotMatch(apply.description, /approved: true/i);
  assert.match(apply.description, /human|elicitation/i);
  assert.match(apply.description, /exact.*version|version.*exact/i);
  assert.match(apply.inputSchema.properties.expectedVersion.description, /required.*high.risk|high.risk.*required/i);
  assert.match(apply.inputSchema.properties.expectedVersion.description, /optional.*low.risk|low.risk.*optional/i);
  assert.equal(allToolDefinitions.some((tool) => /issueApprovalCapability|prepareApproval/.test(tool.name)), false);
});

test('MCP server advertises form elicitation support to clients', async (t) => {
  const { server } = await createApprovalServer(t);
  assert.deepEqual(server.server._capabilities.elicitation, {});
});

test('MCP rejects model-supplied approval fields without eliciting or mutating', async (t) => {
  let elicitations = 0;
  const { server, calls, plan } = await createApprovalServer(t, {
    elicitInput: async () => { elicitations += 1; return { action: 'accept', content: { decision: 'approve', confirmedVersion: 1 } }; },
  });
  for (const field of ['approved', 'approvalToken']) {
    const result = await server.handleToolCall('apply_edit_plan', {
      planId: plan.planId,
      expectedVersion: plan.version,
      [field]: field === 'approved' ? true : 'model-guessed-token',
    }, {});
    assert.equal(result.success, false);
    assert.equal(result.result.status, 'approval_required');
    assert.match(result.result.error, /not accepted|human/i);
  }
  assert.equal(elicitations, 0);
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('explicit MCP human acceptance issues and immediately uses a private capability', async (t) => {
  let elicitation;
  const { server, calls, plan } = await createApprovalServer(t, {
    elicitInput: async (params) => {
      elicitation = params;
      return { action: 'accept', content: { decision: 'approve', confirmedVersion: plan.version } };
    },
    render: async () => ({
      paths: ['C:/renders/page_3.png', 'C:/renders/page_1.png'],
      pageIndexes: [2, 0],
    }),
  });
  const originalIssue = server.runtime.issueApprovalCapability.bind(server.runtime);
  const originalApply = server.runtime.applyPlan.bind(server.runtime);
  let issuedToken;
  let appliedToken;
  server.runtime.issueApprovalCapability = (args) => {
    const issued = originalIssue(args);
    issuedToken = issued.approvalToken;
    return issued;
  };
  server.runtime.applyPlan = async (args) => {
    appliedToken = args.approvalToken;
    return originalApply(args);
  };
  const result = await server.handleToolCall('apply_edit_plan', {
    planId: plan.planId,
    expectedVersion: plan.version,
  }, {});
  assert.equal(result.success, true);
  assert.equal(result.result.status, 'applied');
  assert.match(issuedToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(appliedToken, issuedToken);
  assert.match(elicitation.message, new RegExp(`version: ${plan.version}`));
  assert.equal(elicitation.message.includes('Affected page indexes (zero-based): [0,2]'), true);
  assert.equal(elicitation.message.includes('C:/renders/page_1.png'), true);
  assert.equal(elicitation.message.includes('C:/renders/page_3.png'), true);
  assert.equal(elicitation.message.includes('{"pageIndex":0,"path":"C:/renders/page_1.png"}'), true);
  assert.equal(elicitation.message.includes('{"pageIndex":2,"path":"C:/renders/page_3.png"}'), true);
  assert.equal(elicitation.requestedSchema.properties.confirmedVersion.minimum, plan.version);
  assert.equal(elicitation.requestedSchema.properties.confirmedVersion.maximum, plan.version);
  assert.equal(calls.filter((call) => call.name === 'apply_master_spread').length, 1);
  assert.equal(JSON.stringify(result).includes(issuedToken), false);
  assert.equal(JSON.stringify(elicitation).includes(issuedToken), false);
  assert.equal(JSON.stringify(server.runtime.getPlan(plan.planId)).includes(issuedToken), false);
});

test('MCP decline, cancel, and missing elicitation all fail without mutation', async (t) => {
  for (const action of ['decline', 'cancel', 'unavailable']) {
    await t.test(action, async () => {
      const { server, calls, plan } = await createApprovalServer(t, {
        elicitInput: async () => {
          if (action === 'unavailable') throw new Error('elicitation is not supported');
          return { action };
        },
      });
      const result = await server.handleToolCall('apply_edit_plan', {
        planId: plan.planId,
        expectedVersion: plan.version,
      }, {});
      assert.equal(result.success, false);
      assert.equal(result.result.status, action === 'unavailable' ? 'approval_unavailable' : 'approval_declined');
      assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
      assert.equal(server.runtime.plans.get(plan.planId).approval, null);
    });
  }
});

test('MCP missing before renders return approval_unavailable before elicitation or mutation', async (t) => {
  let elicitations = 0;
  const { server, calls, plan } = await createApprovalServer(t, {
    elicitInput: async () => { elicitations += 1; return { action: 'accept' }; },
    render: async () => { throw new Error('PNG export failed'); },
  });
  const result = await server.handleToolCall('apply_edit_plan', {
    planId: plan.planId,
    expectedVersion: plan.version,
  }, {});
  assert.equal(result.success, false);
  assert.equal(result.result.status, 'approval_unavailable');
  assert.match(result.result.error, /PNG export failed/);
  assert.equal(elicitations, 0);
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('MCP exact version mismatch and mismatched human confirmation do not mutate', async (t) => {
  const cases = [
    ['call version mismatch', 2, 1, 'approval_mismatch'],
    ['human version mismatch', 1, 2, 'approval_declined'],
  ];
  for (const [name, expectedVersion, confirmedVersion, status] of cases) {
    await t.test(name, async () => {
      const { server, calls, plan } = await createApprovalServer(t, {
        elicitInput: async () => ({ action: 'accept', content: { decision: 'approve', confirmedVersion } }),
      });
      const result = await server.handleToolCall('apply_edit_plan', {
        planId: plan.planId,
        expectedVersion,
      }, {});
      assert.equal(result.success, false);
      assert.equal(result.result.status, status);
      assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
      assert.equal(server.runtime.plans.get(plan.planId).approval, null);
    });
  }
});

test('MCP high-risk calls without an exact version return approval_required without mutation', async (t) => {
  const { server, calls, plan } = await createApprovalServer(t, {
    elicitInput: async () => { throw new Error('version must be checked before elicitation'); },
  });
  const result = await server.handleToolCall('apply_edit_plan', { planId: plan.planId }, {});
  assert.equal(result.success, false);
  assert.equal(result.result.status, 'approval_required');
  assert.equal(result.result.code, 'APPROVAL_REQUIRED');
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('MCP reports a second-render failure as structured and mutates nothing', async (t) => {
  let renders = 0;
  const { server, calls, plan } = await createApprovalServer(t, {
    elicitInput: async () => ({ action: 'accept', content: { decision: 'approve', confirmedVersion: plan.version } }),
    render: async ({ pages }) => {
      renders += 1;
      if (renders === 2) throw new Error('renderer disappeared after approval');
      return { paths: pages.map((page) => `C:/renders/page_${page + 1}.png`), pageIndexes: pages };
    },
  });
  const result = await server.handleToolCall('apply_edit_plan', {
    planId: plan.planId,
    expectedVersion: plan.version,
  }, {});
  assert.equal(result.success, false);
  assert.equal(result.result.status, 'approval_unavailable');
  assert.equal(result.result.code, 'BEFORE_RENDER_FAILED');
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('trusted chat deferral prepares public approval details without issuing a capability', async (t) => {
  const { server, calls, plan } = await createApprovalServer(t, {
    elicitInput: async () => { throw new Error('chat must use its own approval UI'); },
  });
  const result = await server.handleToolCall('apply_edit_plan', {
    planId: plan.planId,
    expectedVersion: plan.version,
  }, { deferApproval: true });
  assert.equal(result.success, true);
  assert.equal(result.result.status, 'approval_required');
  assert.deepEqual(result.result.beforeArtifacts, ['C:/renders/page_1.png', 'C:/renders/page_3.png']);
  assert.deepEqual(result.result.beforeArtifactsPageIndexes, [0, 2]);
  assert.equal(Object.hasOwn(result.result, 'approvalToken'), false);
  assert.equal(server.runtime.plans.get(plan.planId).approval, null);
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('safe-layout-edit accepts reversible target-bound edits and rejects destructive tools', async () => {
  const server = new InDesignMCPServer({ callTool: fakeCallTool });
  const inspected = await server.handleToolCall('inspect_layout', { pageRange: 'all' }, {});
  const plan = {
    targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
    steps: [
      { toolName: 'move_page_item', arguments: { pageIndex: 0, itemIndex: 0, x: 20, y: 40 } },
      { toolName: 'resize_page_item', arguments: { pageIndex: 0, itemIndex: 0, width: 120, height: 40 } },
    ],
    affectedPages: [0],
    expectedChanges: ['Move and resize the title'],
    qualityCriteria: ['Only the title changes'],
  };
  const planned = await server.handleToolCall('plan_edit', {
    inspectionId: inspected.result.inspectionId, skillId: 'safe-layout-edit', plan,
  }, {});
  assert.equal(planned.success, true);
  assert.equal(planned.result.risk, 'low');

  for (const toolName of ['execute_indesign_code', 'close_document', 'print_book', 'package_document', 'save_document']) {
    await assert.rejects(() => server.handleToolCall('plan_edit', {
      inspectionId: inspected.result.inspectionId,
      skillId: 'safe-layout-edit',
      plan: { ...plan, steps: [{ toolName, arguments: {} }] },
    }, {}), (error) => error.code === 'PLAN_INVALID' && error.message.includes(toolName));
  }
});
