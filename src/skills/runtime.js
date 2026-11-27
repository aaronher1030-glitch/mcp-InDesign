import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { getSkill, listSkills } from './registry.js';
import { inspectLayout } from './inspector.js';
import { bindTargetToInspection, documentFingerprint, normalizePlanInput, rebindTargetArguments, targetFingerprint, validatePlan } from './planSchema.js';
import { toPoints } from './units.js';
import { EditJournal } from './editJournal.js';
import { createBackup, restoreOriginal } from './backup.js';
import { renderPages } from '../quality/pageRenderer.js';
import { runStructuralChecks } from '../quality/structuralChecks.js';
import { verifyPlan } from '../quality/verifier.js';
import { APP_ID } from '../version.js';

function workflowError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function pageRangeFor(plan) {
  const pages = Array.isArray(plan?.affectedPages) && plan.affectedPages.length > 0
    ? plan.affectedPages
    : (plan?.targets ?? []).map((target) => target.pageIndex).filter(Number.isInteger);
  const unique = [...new Set(pages)].sort((left, right) => left - right);
  return unique.length > 0 ? unique.map((page) => page + 1).join(',') : 'all';
}

function planSummary(skillName, plan) {
  const changes = Array.isArray(plan?.expectedChanges) ? plan.expectedChanges.join('; ') : '';
  return changes || `${skillName}: ${plan?.steps?.length ?? 0} step(s) on ${plan?.affectedPages?.length ?? 0} page(s)`;
}

function snapshot(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function pathIdentity(value) {
  const normalized = resolve(String(value).trim());
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function activeDocumentIdentity(inspection) {
  const document = inspection?.document;
  for (const key of ['documentId', 'documentID', 'instanceId', 'id']) {
    if (document?.[key] !== undefined && document?.[key] !== null && String(document[key]).trim()) {
      return { kind: 'id', value: String(document[key]) };
    }
  }
  if (typeof document?.filePath === 'string' && document.filePath.trim()
      && !/^unsaved/i.test(document.filePath) && !/^untitled$/i.test(document.filePath.trim())) {
    return { kind: 'path', value: pathIdentity(document.filePath) };
  }
  // Older bridges expose neither an object ID nor a saved path. The name is the
  // best session-local identity available; high-risk backup still fails closed.
  if (typeof document?.name === 'string' && document.name.trim()) {
    return { kind: 'name', value: document.name };
  }
  throw workflowError('DOCUMENT_CHANGED', 'The active document has no stable identity.');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw workflowError('ABORTED', 'Plan application was aborted.', { reason: signal.reason?.message ?? null });
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validArtifactPath(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('\0')
    && (isAbsolute(value.trim()) || win32.isAbsolute(value.trim()))
    && /\.png$/i.test(value.trim());
}

/**
 * High-risk approval needs one identifiable, valid render for every affected
 * page. Prefer renderer metadata; older renderers can use page_N.png names.
 */
function completeBeforeArtifacts(artifacts, affectedPages) {
  const paths = Array.isArray(artifacts?.paths) ? [...artifacts.paths] : [];
  const pageIndexes = artifacts?.pageIndexes;
  const fail = (message, details = {}) => {
    throw workflowError('BEFORE_RENDER_FAILED', message, {
      affectedPages: snapshot(affectedPages),
      artifactPaths: snapshot(paths),
      ...details,
    });
  };
  if (!Array.isArray(affectedPages) || affectedPages.length === 0) {
    fail('Before-render coverage cannot be established without affected pages.');
  }
  if (artifacts?.error) fail(`Before-render failed: ${artifacts.error}`);
  if (artifacts?.success === false) {
    fail(`Before-render failed: ${typeof artifacts.result === 'string' ? artifacts.result : artifacts.error || 'renderer reported failure'}`);
  }
  if (paths.length === 0 || paths.length !== affectedPages.length
      || paths.some((path) => !validArtifactPath(path))) {
    fail('Before-render returned an invalid artifact count or invalid artifact paths.');
  }
  if (new Set(paths.map(pathIdentity)).size !== paths.length) {
    fail('Before-render returned duplicate artifact paths.');
  }

  if (pageIndexes !== undefined) {
    if (!Array.isArray(pageIndexes) || pageIndexes.length !== paths.length
        || pageIndexes.some((page) => !Number.isInteger(page) || page < 0)
        || new Set(pageIndexes).size !== pageIndexes.length) {
      fail('Before-render page metadata is invalid.', { pageIndexes: snapshot(pageIndexes) });
    }
    const expected = new Set(affectedPages);
    if (pageIndexes.some((page) => !expected.has(page))) {
      fail('Before-render includes pages outside the plan.', { pageIndexes: snapshot(pageIndexes) });
    }
    const covered = new Set(pageIndexes);
    const missingPages = affectedPages.filter((page) => !covered.has(page));
    if (missingPages.length > 0) {
      fail('Before-render coverage is incomplete.', { pageIndexes: snapshot(pageIndexes), missingPages });
    }
    return { paths: paths.map((path) => path.trim()), pageIndexes: [...pageIndexes] };
  }

  const normalizedPaths = paths.map((path) => path.trim());
  const pageIndexesByName = affectedPages.map((page) => {
    const canonical = `page_${page + 1}.png`.toLowerCase();
    const matches = normalizedPaths.filter((path) => path.split(/[\\/]/).at(-1).toLowerCase() === canonical);
    if (matches.length !== 1) fail(`Before-render coverage is incomplete for page ${page}.`);
    return page;
  });
  return { paths: normalizedPaths, pageIndexes: pageIndexesByName };
}

const PLAN_LENGTH_KEYS = {
  move_page_item: ['x', 'y'],
  resize_page_item: ['width', 'height'],
  set_page_item_properties: ['strokeWeight'],
  edit_text_frame: ['fontSize'],
};

function handlerArguments(step, units) {
  const args = snapshot(step.arguments ?? {});
  for (const key of PLAN_LENGTH_KEYS[step.toolName] ?? []) {
    if (Object.hasOwn(args, key)) args[key] = toPoints(args[key], units);
  }
  return args;
}

function currentTarget(target, inspection) {
  return bindTargetToInspection({
    ...target,
    before: { ...(target.before ?? {}), geometricBounds: undefined },
  }, inspection);
}

/**
 * Coordinates inspection, planning, risk-gated execution, verification and
 * rollback for the portable skill workflow.
 */
export class SkillRuntime {
  constructor({
    callTool,
    now = () => new Date(),
    inspect = inspectLayout,
    render = renderPages,
    structural = runStructuralChecks,
    artifactDir,
    approvalTtlMs = 5 * 60 * 1000,
  } = {}) {
    if (typeof callTool !== 'function') throw new TypeError('SkillRuntime requires a callTool function');
    this.callTool = callTool;
    this.now = now;
    this.inspect = inspect;
    this.render = render;
    this.structural = structural;
    if (!Number.isFinite(approvalTtlMs) || approvalTtlMs <= 0) {
      throw new TypeError('approvalTtlMs must be a positive finite number');
    }
    this.approvalTtlMs = approvalTtlMs;
    this.sessionId = randomUUID();
    this.artifactDir = artifactDir ?? join(tmpdir(), APP_ID, this.sessionId);
    this.inspections = new Map();
    this.plans = new Map();
  }

  async createInspection({ pageRange = 'all', targetDescription } = {}) {
    const inspection = await this.inspect({ pageRange, targetDescription }, this.callTool);
    if (!inspection || typeof inspection !== 'object' || !inspection.inspectionId) {
      throw workflowError('INSPECTION_FAILED', 'inspect_layout did not return an inspection');
    }
    this.inspections.set(inspection.inspectionId, { inspection: snapshot(inspection), pageRange });
    this.prune();
    return snapshot(inspection);
  }

  prune() {
    const cutoff = this.now().getTime() - 60 * 60 * 1000;
    for (const [id, record] of this.inspections) {
      const created = Date.parse(record.inspection.createdAt ?? '') || cutoff;
      if (created < cutoff) this.inspections.delete(id);
    }
  }

  async createPlan({ inspectionId, skillId, plan } = {}) {
    const record = this.inspections.get(inspectionId);
    if (!record) {
      throw workflowError('INSPECTION_FAILED', `Unknown inspectionId: ${inspectionId}. Call inspect_layout first.`);
    }
    if (!plan || typeof plan !== 'object') {
      throw workflowError('PLAN_INVALID', 'plan must be an object');
    }

    let skill;
    try {
      skill = await getSkill(skillId);
    } catch {
      throw workflowError('SKILL_NOT_FOUND', `Unknown skill: ${skillId}`);
    }

    let normalized;
    try {
      normalized = normalizePlanInput({
        inspection: record.inspection,
        skillId: skill.id,
        plan,
        now: this.now(),
      });
    } catch (error) {
      throw workflowError('PLAN_INVALID', error.message);
    }

    const disallowed = normalized.steps
      .map((step) => step.toolName)
      .filter((toolName) => !skill.allowedTools.includes(toolName));
    if (disallowed.length > 0) {
      throw workflowError(
        'PLAN_INVALID',
        `Skill ${skill.id} cannot use: ${[...new Set(disallowed)].join(', ')}`,
      );
    }

    const { valid, errors } = validatePlan(normalized);
    if (!valid) {
      throw workflowError('PLAN_INVALID', errors.join('; '), { errors });
    }

    normalized.status = normalized.risk === 'high' ? 'approval_required' : 'draft';
    normalized.summary = planSummary(skill.name, normalized);

    this.plans.set(normalized.planId, {
      plan: snapshot(normalized),
      inspection: snapshot(record.inspection),
      pageRange: record.pageRange,
      journal: null,
      before: record.inspection,
      after: null,
      beforeArtifacts: null,
      afterArtifacts: null,
      backup: null,
      appliedFingerprint: null,
      documentIdentity: activeDocumentIdentity(record.inspection),
      applyingLock: false,
      approval: null,
      skill: { id: skill.id, name: skill.name },
    });
    this.prunePlans();
    return { ...snapshot(normalized), skillName: skill.name };
  }

  prunePlans() {
    const cutoff = this.now().getTime() - 4 * 60 * 60 * 1000;
    for (const [id, record] of this.plans) {
      const created = Date.parse(record.plan.createdAt ?? '') || cutoff;
      if (created < cutoff && !['applying'].includes(record.plan.status)) this.plans.delete(id);
    }
  }

  getPlan(planId) {
    const record = this.plans.get(planId);
    if (!record) throw workflowError('PLAN_INVALID', `Unknown planId: ${planId}`);
    return snapshot({
      plan: record.plan,
      status: record.plan.status,
      before: record.before,
      after: record.after,
      beforeArtifacts: record.beforeArtifacts,
      afterArtifacts: record.afterArtifacts,
      backup: record.backup,
      rollback: record.rollback ?? null,
      journal: record.journal ? record.journal.summary() : null,
      skill: record.skill,
    });
  }

  listPlans() {
    return snapshot([...this.plans.values()].map((record) => ({
      planId: record.plan.planId,
      skillId: record.plan.skillId,
      status: record.plan.status,
      risk: record.plan.risk,
      affectedPages: record.plan.affectedPages,
      summary: record.plan.summary,
      expiresAt: record.plan.expiresAt,
    })));
  }

  async listSkills() {
    return listSkills();
  }

  async readDocumentFingerprint(pageRange) {
    const inspection = await this.inspect({ pageRange }, this.callTool);
    return inspection;
  }

  async readPlanFingerprint(record) {
    const inspection = await this.readDocumentFingerprint(record.pageRange);
    const identity = activeDocumentIdentity(inspection);
    if (identity.kind !== record.documentIdentity.kind || identity.value !== record.documentIdentity.value) {
      throw workflowError('DOCUMENT_CHANGED', 'The active document changed since inspection.');
    }
    return inspection;
  }

  validateStoredPlan(record) {
    const { valid, errors } = validatePlan(record.plan);
    if (!valid) throw workflowError('PLAN_INVALID', errors.join('; '), { errors });
  }

  async inspectRestoredBackup(record) {
    const inspection = await this.inspect({ pageRange: record.pageRange }, this.callTool);
    if (record.backup && pathIdentity(inspection?.document?.filePath) === pathIdentity(record.backup.backupPath)
        && inspection.fingerprint === documentFingerprint(inspection)) {
      // The canonical inspector includes filePath in its fingerprint. Compare
      // the reopened copy at the original path identity so only layout changes
      // count; verifyReopenedBackup still checks the actual backup path.
      const atOriginalPath = {
        ...inspection,
        document: { ...inspection.document, filePath: record.backup.originalPath },
      };
      inspection.comparableFingerprint = documentFingerprint(atOriginalPath);
    }
    return inspection;
  }

  approvalRequired(record) {
    const plan = record.plan;
    plan.status = 'approval_required';
    return workflowError('APPROVAL_REQUIRED', 'This plan needs a trusted one-time approval capability for the exact plan version.', {
      planId: plan.planId,
      version: plan.version,
      summary: plan.summary,
      affectedPages: plan.affectedPages,
      risk: plan.risk,
    });
  }

  assertPlanAvailable(record) {
    const plan = record.plan;
    this.validateStoredPlan(record);
    if (record.applyingLock || plan.status === 'applying') {
      throw workflowError('PLAN_INVALID', 'This plan is already applying.');
    }
    if (['applied', 'verified'].includes(plan.status)) {
      throw workflowError('PLAN_INVALID', 'This plan has already been applied.');
    }
    if (Date.parse(plan.expiresAt) < this.now().getTime()) {
      throw workflowError('STALE_PLAN', 'The plan expired. Inspect and plan again.');
    }
  }

  assertExpectedVersion(record, expectedVersion) {
    const plan = record.plan;
    if (plan.risk === 'high' && expectedVersion === undefined) throw this.approvalRequired(record);
    if (expectedVersion !== undefined && expectedVersion !== plan.version) {
      throw workflowError(
        'APPROVAL_MISMATCH',
        `Approval is for plan version ${expectedVersion}, current version is ${plan.version}.`,
        { planId: plan.planId, expectedVersion, version: plan.version },
      );
    }
  }

  /**
   * Trusted server/UI adapter API. Never expose this method or its returned
   * token as an MCP tool or model argument. Only a SHA-256 digest is retained.
   */
  issueApprovalCapability({ planId, expectedVersion } = {}) {
    const record = this.plans.get(planId);
    if (!record) throw workflowError('PLAN_INVALID', `Unknown planId: ${planId}`);
    this.assertPlanAvailable(record);
    this.assertExpectedVersion(record, expectedVersion);
    if (record.plan.risk !== 'high') {
      throw workflowError('PLAN_INVALID', 'Low-risk plans do not need an approval capability.');
    }
    const approvalToken = randomBytes(32).toString('base64url');
    record.approval = {
      planId,
      version: record.plan.version,
      tokenHash: tokenHash(approvalToken),
      expiresAt: new Date(this.now().getTime() + this.approvalTtlMs).toISOString(),
    };
    return { approvalToken };
  }

  consumeApprovalCapability(record, approvalToken) {
    const approval = record.approval;
    if (!approval || typeof approvalToken !== 'string' || !approvalToken
        || approval.planId !== record.plan.planId
        || approval.version !== record.plan.version
        || Date.parse(approval.expiresAt) <= this.now().getTime()) {
      throw this.approvalRequired(record);
    }
    const presentedHash = tokenHash(approvalToken);
    const matches = timingSafeEqual(Buffer.from(presentedHash, 'hex'), Buffer.from(approval.tokenHash, 'hex'));
    if (!matches) throw this.approvalRequired(record);
    // Consume synchronously, before the first await or any document mutation.
    record.approval = null;
  }

  async renderBeforeArtifacts(record) {
    const plan = record.plan;
    try {
      const artifacts = await this.render({
        pages: plan.affectedPages,
        outputDir: join(this.artifactDir, `before-${plan.planId}`),
        callTool: this.callTool,
      });
      const complete = completeBeforeArtifacts(artifacts, plan.affectedPages);
      record.beforeArtifacts = { ...snapshot(artifacts), ...complete };
      plan.beforeArtifacts = [...complete.paths];
      return record.beforeArtifacts;
    } catch (error) {
      const message = error?.message || String(error);
      record.beforeArtifacts = { paths: [], pageIndexes: [], error: message };
      plan.beforeArtifacts = [];
      if (error?.code === 'BEFORE_RENDER_FAILED') {
        error.planId = plan.planId;
        throw error;
      }
      throw workflowError('BEFORE_RENDER_FAILED', `Before-render failed: ${message}`, {
        planId: plan.planId,
        affectedPages: plan.affectedPages,
        artifactPaths: [],
        renderError: message,
      });
    }
  }

  publicApprovalDetails(record) {
    const plan = record.plan;
    return snapshot({
      planId: plan.planId,
      version: plan.version,
      status: plan.status,
      risk: plan.risk,
      summary: plan.summary,
      affectedPages: plan.affectedPages,
      targets: plan.targets,
      steps: plan.steps,
      expectedChanges: plan.expectedChanges,
      qualityCriteria: plan.qualityCriteria,
      expiresAt: plan.expiresAt,
      documentFingerprint: plan.documentFingerprint,
      beforeArtifacts: record.beforeArtifacts?.paths ?? [],
      beforeArtifactsPageIndexes: record.beforeArtifacts?.pageIndexes ?? [],
      beforeArtifactsError: record.beforeArtifacts?.error ?? null,
    });
  }

  /** Trusted preparation for an external approval UI; never issues a token. */
  async prepareApproval({ planId, expectedVersion } = {}) {
    const record = this.plans.get(planId);
    if (!record) throw workflowError('PLAN_INVALID', `Unknown planId: ${planId}`);
    this.assertPlanAvailable(record);
    this.assertExpectedVersion(record, expectedVersion);
    if (record.plan.risk !== 'high') {
      throw workflowError('PLAN_INVALID', 'Only high-risk plans require approval preparation.');
    }
    const fresh = await this.readPlanFingerprint(record);
    if (fresh.fingerprint !== record.plan.documentFingerprint) {
      throw workflowError('STALE_PLAN', 'The document changed since inspection. Inspect the layout again before applying.');
    }
    await this.renderBeforeArtifacts(record);
    const afterRender = await this.readPlanFingerprint(record);
    if (afterRender.fingerprint !== record.plan.documentFingerprint) {
      throw workflowError('STALE_PLAN', 'The document changed during before-render.');
    }
    return this.publicApprovalDetails(record);
  }

  async applyPlan({ planId, approvalToken, expectedVersion, signal } = {}) {
    const record = this.plans.get(planId);
    if (!record) throw workflowError('PLAN_INVALID', `Unknown planId: ${planId}`);
    const plan = record.plan;
    this.assertPlanAvailable(record);
    this.assertExpectedVersion(record, expectedVersion);
    if (plan.risk === 'high') this.consumeApprovalCapability(record, approvalToken);
    throwIfAborted(signal);

    // Acquire before the first await. The status alone was previously set only
    // after rendering, allowing concurrent callers through the same gate.
    record.applyingLock = true;
    plan.status = 'applying';
    try {
      return await this.executePlan(record, { planId, signal });
    } catch (error) {
      if (plan.status === 'applying') plan.status = 'failed';
      throw error;
    } finally {
      record.applyingLock = false;
    }
  }

  async executePlan(record, { planId, signal }) {
    const plan = record.plan;
    const fresh = await this.readPlanFingerprint(record);
    if (fresh.fingerprint !== plan.documentFingerprint) {
      plan.status = 'failed';
      throw workflowError(
        'STALE_PLAN',
        'The document changed since inspection. Inspect the layout again before applying.',
      );
    }

    if (plan.risk === 'high') {
      record.backup = {
        ...createBackup({ document: fresh.document, artifactDir: this.artifactDir }),
        documentFingerprint: plan.documentFingerprint,
      };
    }

    if (plan.risk === 'high') {
      // A high-risk approval is only actionable when the human can identify a
      // complete before render. Failure here must happen before the step loop.
      await this.renderBeforeArtifacts(record);
    } else {
      try {
        record.beforeArtifacts = await this.render({
          pages: plan.affectedPages,
          outputDir: join(this.artifactDir, `before-${plan.planId}`),
          callTool: this.callTool,
        });
        plan.beforeArtifacts = record.beforeArtifacts.paths;
      } catch {
        record.beforeArtifacts = { paths: [], error: 'before-render unavailable' };
        plan.beforeArtifacts = [];
      }
    }

    const afterRender = await this.readPlanFingerprint(record);
    if (afterRender.fingerprint !== plan.documentFingerprint) {
      plan.status = 'failed';
      throw workflowError('STALE_PLAN', 'The document changed during before-render.');
    }
    throwIfAborted(signal);

    const journal = new EditJournal({ planId, risk: plan.risk });
    journal.backupPath = record.backup?.backupPath ?? null;
    record.journal = journal;

    for (let step of plan.steps) {
      let immediatelyBefore;
      try {
        throwIfAborted(signal);
        if (Date.parse(plan.expiresAt) < this.now().getTime()) {
          throw workflowError('STALE_PLAN', 'The plan expired while applying.');
        }
        const target = plan.targets.find((entry) => entry.fingerprint === step.targetFingerprint);
        immediatelyBefore = await this.readPlanFingerprint(record);
        throwIfAborted(signal);
        const inspectedTarget = currentTarget(target, immediatelyBefore);
        if (!inspectedTarget || targetFingerprint(inspectedTarget) !== step.targetFingerprint) {
          throw workflowError('STALE_PLAN', `Target changed before step ${step.id}.`, { stepId: step.id });
        }
        const boundStep = {
          ...step,
          arguments: rebindTargetArguments(step.toolName, step.arguments, inspectedTarget),
        };
        journal.recordBefore(boundStep, inspectedTarget);
        throwIfAborted(signal);
        step = boundStep;
      } catch (error) {
        throw await this.preStepFailure(record, error, immediatelyBefore?.fingerprint);
      }

      let result;
      try {
        result = await this.callTool(step.toolName, handlerArguments(step, plan.units));
      } catch (error) {
        result = { success: false, result: error.message };
      }
      if (result?.success !== true) {
        journal.recordFailure(step, result);
        plan.status = 'failed';
        const reason = typeof result?.result === 'string' ? result.result : result?.error ?? 'unknown error';
        let rollback;
        try {
          const afterFailure = await this.readPlanFingerprint(record);
          rollback = await this.rollbackFailedPlan(record, { expectedFingerprint: afterFailure.fingerprint });
        } catch (rollbackError) {
          rollback = { status: 'ROLLBACK_FAILED', failures: [{ error: rollbackError.message }] };
          plan.status = 'failed';
        }
        throw workflowError('STEP_FAILED', `${step.toolName} failed: ${reason}`, {
          planId,
          stepId: step.id,
          rollback,
        });
      }
      journal.recordSuccess(step, result);
    }

    try {
      throwIfAborted(signal);
    } catch (error) {
      const current = await this.readPlanFingerprint(record);
      throw await this.preStepFailure(record, error, current.fingerprint);
    }

    let after;
    try {
      after = await this.readPlanFingerprint(record);
      throwIfAborted(signal);
      record.after = after;
      record.appliedFingerprint = after.fingerprint;
      plan.status = 'applied';
    } catch (error) {
      if (signal?.aborted || error.code === 'ABORTED') {
        const abortError = error.code === 'ABORTED' ? error : workflowError(
          'ABORTED',
          'Plan application was aborted.',
          { reason: signal.reason?.message ?? null, cause: error },
        );
        let current = after;
        if (!current) {
          try {
            current = await this.readPlanFingerprint(record);
          } catch {
            // Rollback must fail closed if the original document cannot be
            // identified; preStepFailure reports that conflict explicitly.
          }
        }
        throw await this.preStepFailure(record, abortError, current?.fingerprint);
      }
      record.after = null;
      record.appliedFingerprint = null;
      record.afterInspectionError = error.message;
      plan.status = 'applied';
    }

    return snapshot({
      planId,
      status: 'applied',
      risk: plan.risk,
      version: plan.version,
      journalId: journal.journalId,
      backupPath: record.backup?.backupPath ?? null,
      affectedPages: plan.affectedPages,
      beforeArtifacts: plan.beforeArtifacts,
      journal: journal.summary(),
    });
  }

  async preStepFailure(record, error, expectedFingerprint) {
    let rollback;
    try {
      rollback = await this.rollbackFailedPlan(record, { expectedFingerprint });
    } catch (rollbackError) {
      rollback = {
        status: ['ROLLBACK_CONFLICT', 'DOCUMENT_CHANGED'].includes(rollbackError.code) ? 'ROLLBACK_CONFLICT' : 'ROLLBACK_FAILED',
        failures: [{ error: rollbackError.message }],
      };
      record.plan.status = 'failed';
    }
    if (['STALE_PLAN', 'DOCUMENT_CHANGED', 'ABORTED'].includes(error.code)) {
      error.rollback = rollback;
      if (error.stepId === undefined && record.journal?.entries.length > 0) {
        error.stepId = record.journal.entries.at(-1).stepId;
      }
      return error;
    }
    return workflowError('PRE_STEP_FAILED', error.message, {
      cause: error,
      stepId: record.journal?.entries.at(-1)?.stepId ?? null,
      rollback,
    });
  }

  async rollbackJournal(record) {
    const journal = record?.journal;
    if (!journal) return { status: 'nothing_to_roll_back', reversed: [], failures: [], unreversed: [] };
    // Inverse tools also target the active document. Never replay them after an
    // inspection failed to establish that the original document is still active.
    if (record.documentIdentity) await this.readPlanFingerprint(record);
    const failures = [];
    const reversed = [];
    for (const inverse of journal.inverseSteps()) {
      let result;
      try {
        result = await this.callTool(inverse.toolName, inverse.arguments);
      } catch (error) {
        result = { success: false, error: error.message };
      }
      if (result?.success !== true) {
        failures.push({ toolName: inverse.toolName, forStepId: inverse.forStepId, error: result?.result || result?.error || 'malformed response' });
      } else {
        reversed.push(inverse.forStepId);
      }
    }
    // Applied steps with no inverse stay changed; the rollback is not clean.
    const unreversed = journal.entries
      .filter((entry) => !entry.inverse)
      .map((entry) => ({
        stepId: entry.stepId,
        toolName: entry.toolName,
        error: 'no inverse can be built from the recorded before-state',
      }));
    const clean = failures.length === 0 && unreversed.length === 0;
    return { status: clean ? 'rolled_back' : 'ROLLBACK_FAILED', reversed, failures, unreversed };
  }

  async rollbackFailedPlan(record, { expectedFingerprint } = {}) {
    if (record.plan.risk === 'high' && record.backup?.backupPath) {
      const current = await this.readPlanFingerprint(record);
      const result = await restoreOriginal({
        backupPath: record.backup.backupPath,
        originalPath: record.backup.originalPath,
        metadata: record.backup,
        currentFingerprint: current.fingerprint,
        expectedFingerprint: expectedFingerprint ?? record.appliedFingerprint,
        expectedDocumentFingerprint: record.backup.documentFingerprint ?? record.plan.documentFingerprint,
        callTool: this.callTool,
        inspect: () => this.inspectRestoredBackup(record),
      });
      record.plan.status = 'rolled_back';
      record.rollback = { status: 'rolled_back', method: 'backup', ...result };
      return record.rollback;
    }
    if (expectedFingerprint) {
      const current = await this.readPlanFingerprint(record);
      if (current.fingerprint !== expectedFingerprint) {
        throw workflowError('ROLLBACK_CONFLICT', 'The document changed after this plan was applied. Refusing to overwrite newer edits.');
      }
    }
    const rollback = await this.rollbackJournal(record);
    record.plan.status = rollback.status === 'rolled_back' ? 'rolled_back' : 'failed';
    record.rollback = rollback;
    return rollback;
  }

  async verify({ planId, visualReview, settings, complete } = {}) {
    const record = this.plans.get(planId);
    if (!record) throw workflowError('PLAN_INVALID', `Unknown planId: ${planId}`);
    let afterRenderError = null;
    const render = async (options) => {
      let artifacts;
      try {
        artifacts = await this.render(options);
      } catch (error) {
        artifacts = { paths: [], error: error.message };
      }
      // Freshness is mandatory even when rendering throws. A stale snapshot must
      // never be structurally checked as though it represented the applied edit.
      try {
        const fresh = await this.readPlanFingerprint(record);
        record.after = fresh;
        if (fresh.fingerprint !== record.appliedFingerprint) {
          throw workflowError('STALE_PLAN', 'The document changed during after-render.');
        }
      } catch (error) {
        afterRenderError = error;
      }
      return artifacts;
    };
    const result = await verifyPlan({
      planId,
      visualReview,
      settings,
      intent: (record.plan.expectedChanges ?? []).join('; '),
      complete,
      runtime: this,
      inspect: (options) => this.inspect(options, this.callTool),
      render,
      structural: this.structural,
      callTool: this.callTool,
    });

    record.afterArtifacts = { paths: result.artifacts.after ?? [] };
    if (afterRenderError) {
      result.status = 'failed';
      result.structural = { ...result.structural, pass: false, issues: [...(result.structural?.issues ?? []), afterRenderError.message] };
      result.verificationError = afterRenderError.message;
    }
    if (result.status === 'verified') record.plan.status = 'verified';
    if (result.status === 'failed') {
      let rollback;
      try {
        rollback = await this.rollbackFailedPlan(record, { expectedFingerprint: record.appliedFingerprint });
      } catch (error) {
        rollback = { status: error.code === 'ROLLBACK_CONFLICT' ? 'ROLLBACK_CONFLICT' : 'ROLLBACK_FAILED', failures: [{ error: error.message }] };
      }
      record.rollback = rollback;
      if (rollback.status !== 'rolled_back') {
        record.plan.status = 'failed';
        throw workflowError('ROLLBACK_FAILED', 'Verification failed and automatic rollback failed.', { rollback });
      }
    }
    return snapshot({ ...result, planStatus: record.plan.status, ...(result.status === 'failed' ? { rollback: record.rollback } : {}) });
  }

  async rollbackPlan({ planId, reason } = {}) {
    const record = this.plans.get(planId);
    if (!record) throw workflowError('PLAN_INVALID', `Unknown planId: ${planId}`);
    const plan = record.plan;
    if (!['applied', 'failed', 'verified'].includes(plan.status)) {
      throw workflowError('PLAN_INVALID', `Plan cannot be rolled back from status ${plan.status}.`);
    }

    if (plan.risk === 'high') {
      if (!record.backup?.backupPath) {
        throw workflowError('ROLLBACK_FAILED', 'No high-risk backup is available.');
      }
      const current = await this.readPlanFingerprint(record);
      let restored;
      try {
        restored = await restoreOriginal({
          backupPath: record.backup.backupPath,
          originalPath: record.backup.originalPath,
          metadata: record.backup,
          currentFingerprint: current.fingerprint,
          expectedFingerprint: record.appliedFingerprint,
          expectedDocumentFingerprint: record.backup.documentFingerprint ?? plan.documentFingerprint,
          callTool: this.callTool,
          inspect: () => this.inspectRestoredBackup(record),
        });
      } catch (error) {
        plan.status = 'failed';
        record.rollback = { status: error.code === 'ROLLBACK_CONFLICT' ? 'ROLLBACK_CONFLICT' : 'ROLLBACK_FAILED', error: error.message };
        throw error;
      }
      plan.status = 'rolled_back';
      return snapshot({
        planId, status: 'rolled_back', method: 'backup',
        backupPath: record.backup.backupPath, reason: reason ?? null, ...restored,
      });
    }

    const current = await this.readPlanFingerprint(record);
    if (!record.appliedFingerprint || current.fingerprint !== record.appliedFingerprint) {
      throw workflowError('ROLLBACK_CONFLICT', 'The document changed after this plan was applied.');
    }
    const rollback = await this.rollbackJournal(record);
    if (rollback.status !== 'rolled_back') {
      plan.status = 'failed';
      record.rollback = rollback;
      const details = [
        ...rollback.failures.map((failure) => `${failure.toolName} (step ${failure.forStepId}): ${failure.error}`),
        ...rollback.unreversed.map((entry) => `${entry.toolName} (step ${entry.stepId}): ${entry.error}`),
      ];
      throw workflowError(
        'ROLLBACK_FAILED',
        `The edit journal could not fully restore the document: ${details.join('; ') || 'unknown reason'}`,
        rollback,
      );
    }
    plan.status = 'rolled_back';
    return snapshot({ planId, status: 'rolled_back', method: 'journal', reason: reason ?? null, ...rollback });
  }
}
