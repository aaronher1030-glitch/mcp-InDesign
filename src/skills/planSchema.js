import { createHash, randomUUID } from 'node:crypto';
import { allToolDefinitions } from '../types/index.js';

export const EDIT_PLAN_STATUSES = [
  'draft',
  'approval_required',
  'approved',
  'applying',
  'applied',
  'verified',
  'failed',
  'rolled_back',
];

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

const FORBIDDEN_TOOLS = new Set([
  'execute_indesign_code',
  'save_document',
  'save_document_to_cloud',
  'close_document',
  'print_book',
  'package_document',
]);

const SUPPORTED_UNITS = new Set(['mm', 'cm', 'in', 'pt']);
const TEN_MINUTES_MS = 10 * 60 * 1000;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// apply_character_style is dispatched by the server but is absent from its
// published tool-definition catalog. Keep the plan contract aligned with the
// handler's actual arguments until that catalog is corrected.
const APPLY_CHARACTER_STYLE_SCHEMA = {
  type: 'object',
  properties: {
    styleName: { type: 'string' },
    frameIndex: { type: 'integer' },
    startIndex: { type: 'integer' },
    endIndex: { type: 'integer' },
  },
  required: ['styleName'],
  additionalProperties: false,
};

const TOOL_SCHEMAS = new Map(
  allToolDefinitions.map((definition) => [definition.name, definition.inputSchema]),
);
TOOL_SCHEMAS.set('apply_character_style', APPLY_CHARACTER_STYLE_SCHEMA);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value, path = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${path} must contain only JSON-compatible values`);
  }
  if (seen.has(value)) throw new TypeError(`${path} must not contain circular references`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => cloneJson(entry, `${path}[${index}]`, seen));
    }
    if (!isRecord(value)) throw new TypeError(`${path} must be a plain object`);
    const result = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) throw new TypeError(`${path} contains an unsafe key: ${key}`);
      if (value[key] !== undefined) result[key] = cloneJson(value[key], `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null) throw new TypeError('Fingerprint input must be JSON-compatible');
  if (seen.has(value)) throw new TypeError('Fingerprint input must not contain circular references');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
    if (!isRecord(value)) throw new TypeError('Fingerprint input must be JSON-compatible');
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (UNSAFE_KEYS.has(key)) throw new TypeError(`Unsafe fingerprint key: ${key}`);
      if (value[key] !== undefined) result[key] = canonicalize(value[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function documentFingerprint(inspection) {
  if (!isRecord(inspection) || !isRecord(inspection.document) || !Array.isArray(inspection.pages)) {
    throw new TypeError('inspection must contain document and pages');
  }
  const snapshot = {};
  for (const key of [
    'document', 'pages', 'spreads', 'masters', 'layers', 'styles', 'fonts',
    'links', 'colors', 'baseRevision', 'revision',
  ]) {
    if (inspection[key] !== undefined) snapshot[key] = inspection[key];
  }
  return hash(snapshot);
}

export function targetFingerprint(target) {
  if (!isRecord(target)) throw new TypeError('target must be an object');
  const snapshot = {};
  for (const key of Object.keys(target).sort()) {
    if (['id', 'fingerprint', 'targetFingerprint', 'expectedResult'].includes(key)) continue;
    if (target[key] !== undefined) snapshot[key] = target[key];
  }
  return hash(snapshot);
}

function validStepRisk(step) {
  return isRecord(step)
    && LOW_RISK_TOOLS.has(step.toolName)
    && isRecord(step.arguments)
    && step.reversible === true;
}

export function classifyPlanRisk(plan) {
  if (!isRecord(plan) || typeof plan.skillId !== 'string' || !plan.skillId.trim()
      || plan.skillId === 'multi-page-consistency') return 'high';
  if (!Array.isArray(plan.targets) || plan.targets.length === 0 || plan.targets.length > 5) return 'high';
  if (!plan.targets.every(isRecord)) return 'high';
  if (!Array.isArray(plan.affectedPages) || plan.affectedPages.length !== 1) return 'high';
  if (!Number.isInteger(plan.affectedPages[0]) || plan.affectedPages[0] < 0) return 'high';
  if (plan.targets.some((target) => target.pageIndex !== undefined && target.pageIndex !== plan.affectedPages[0])) {
    return 'high';
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return 'high';
  if (plan.steps.some((step) => Number.isInteger(step.arguments?.pageIndex)
      && step.arguments.pageIndex !== plan.affectedPages[0])) return 'high';
  if (!plan.steps.every(validStepRisk)) return 'high';
  return 'low';
}

function normalizeId(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback();
}

function targetIdentity(target) {
  return {
    pageIndex: target.pageIndex,
    itemIndex: target.itemIndex ?? target.index,
    frameIndex: target.frameIndex ?? target.itemIndex ?? target.index,
    objectIndex: target.objectIndex ?? target.itemIndex ?? target.index,
  };
}

function findTarget(step, targets) {
  if (Number.isInteger(step.targetIndex) && step.targetIndex >= 0 && step.targetIndex < targets.length) {
    return targets[step.targetIndex];
  }
  if (typeof step.targetId === 'string') {
    const byId = targets.find((target) => target.id === step.targetId);
    if (byId) return byId;
  }
  if (typeof step.targetFingerprint === 'string') {
    const byFingerprint = targets.find((target) => target.fingerprint === step.targetFingerprint);
    if (byFingerprint) return byFingerprint;
  }

  const args = isRecord(step.arguments) ? step.arguments : {};
  const hasIdentity = ['pageIndex', 'itemIndex', 'frameIndex', 'objectIndex']
    .some((key) => Object.hasOwn(args, key));
  if (hasIdentity) {
    const match = targets.find((target) => {
      const identity = targetIdentity(target);
      return Object.entries(identity).every(([key, value]) => (
        !Object.hasOwn(args, key) || value === args[key]
      ));
    });
    if (match) return match;
  }
  return !hasIdentity && targets.length === 1 ? targets[0] : undefined;
}

function inferTargetArguments(toolName, args, target) {
  if (!isRecord(args) || !target) return args;
  const result = cloneJson(args, 'step.arguments');
  const schema = TOOL_SCHEMAS.get(toolName);
  const properties = schema?.properties ?? {};
  const identity = targetIdentity(target);
  for (const key of ['pageIndex', 'itemIndex', 'frameIndex', 'objectIndex']) {
    if (Object.hasOwn(properties, key) && result[key] === undefined && identity[key] !== undefined) {
      result[key] = identity[key];
    }
  }
  return result;
}

function normalizeAffectedPages(value, targets, steps) {
  if (value === undefined) {
    const pages = new Set();
    for (const target of targets) {
      if (Number.isInteger(target.pageIndex) && target.pageIndex >= 0) pages.add(target.pageIndex);
    }
    for (const step of steps) {
      if (Number.isInteger(step.arguments?.pageIndex) && step.arguments.pageIndex >= 0) {
        pages.add(step.arguments.pageIndex);
      }
    }
    return [...pages].sort((left, right) => left - right);
  }
  if (!Array.isArray(value)) return cloneJson(value, 'plan.affectedPages');
  if (!value.every((page) => Number.isInteger(page) && page >= 0)) return cloneJson(value, 'plan.affectedPages');
  return [...new Set(value)].sort((left, right) => left - right);
}

function normalizeNow(now) {
  if (now !== undefined && !(now instanceof Date) && typeof now !== 'string' && typeof now !== 'number') {
    throw new TypeError('now must be a Date, date string, or timestamp');
  }
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  return date;
}

export function normalizePlanInput(input) {
  if (!isRecord(input)) throw new TypeError('normalizePlanInput requires an input object');
  const { inspection, skillId, plan } = input;
  if (!isRecord(inspection) || !isRecord(inspection.document) || !Array.isArray(inspection.pages)) {
    throw new TypeError('inspection must contain document and pages');
  }
  if (typeof skillId !== 'string' || !skillId.trim()) throw new TypeError('skillId must be a non-empty string');
  if (!isRecord(plan)) throw new TypeError('plan must be an object');
  if (!Array.isArray(plan.targets)) throw new TypeError('plan.targets must be an array');
  if (!Array.isArray(plan.steps)) throw new TypeError('plan.steps must be an array');

  const now = normalizeNow(input.now);
  const fingerprint = inspection.fingerprint ?? documentFingerprint(inspection);
  const targets = plan.targets.map((target, index) => {
    if (!isRecord(target)) throw new TypeError(`plan.targets[${index}] must be an object`);
    return {
      ...cloneJson(target, `plan.targets[${index}]`),
      id: normalizeId(target.id, randomUUID),
      fingerprint: targetFingerprint(target),
    };
  });

  const steps = plan.steps.map((step, index) => {
    if (!isRecord(step)) throw new TypeError(`plan.steps[${index}] must be an object`);
    if (step.reversible !== undefined && typeof step.reversible !== 'boolean') {
      throw new TypeError(`plan.steps[${index}].reversible must be a boolean`);
    }
    const toolName = typeof step.toolName === 'string' ? step.toolName.trim() : step.toolName;
    const target = findTarget({ ...step, toolName }, targets);
    const reversible = LOW_RISK_TOOLS.has(toolName) && step.reversible !== false;
    return {
      id: normalizeId(step.id, randomUUID),
      toolName,
      arguments: inferTargetArguments(toolName, step.arguments, target),
      targetFingerprint: target?.fingerprint,
      expectedResult: cloneJson(step.expectedResult ?? {}, `plan.steps[${index}].expectedResult`),
      reversible,
      risk: reversible && isRecord(step.arguments) ? 'low' : 'high',
    };
  });

  const normalized = {
    planId: randomUUID(),
    version: 1,
    ...(inspection.inspectionId !== undefined ? { inspectionId: inspection.inspectionId } : {}),
    skillId,
    documentFingerprint: fingerprint,
    baseRevision: inspection.baseRevision ?? inspection.document.revision ?? inspection.revision ?? fingerprint,
    units: cloneJson(inspection.units ?? 'pt', 'inspection.units'),
    risk: 'high',
    targets,
    steps,
    affectedPages: normalizeAffectedPages(plan.affectedPages, targets, steps),
    expectedChanges: cloneJson(plan.expectedChanges, 'plan.expectedChanges'),
    qualityCriteria: cloneJson(plan.qualityCriteria, 'plan.qualityCriteria'),
    beforeArtifacts: cloneJson(inspection.beforeArtifacts ?? [], 'inspection.beforeArtifacts'),
    expiresAt: new Date(now.getTime() + TEN_MINUTES_MS).toISOString(),
    status: 'draft',
  };
  if (plan.constraints !== undefined) normalized.constraints = cloneJson(plan.constraints, 'plan.constraints');
  normalized.risk = classifyPlanRisk(normalized);
  normalized.status = normalized.risk === 'high' ? 'approval_required' : 'draft';
  return normalized;
}

function validateJsonValue(value, path, errors, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null) {
    errors.push(`${path} must contain only JSON-compatible values`);
    return;
  }
  if (seen.has(value)) {
    errors.push(`${path} must not contain circular references`);
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, errors, seen));
  } else if (!isRecord(value)) {
    errors.push(`${path} must contain only JSON-compatible values`);
  } else {
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) errors.push(`${path} contains an unsafe key: ${key}`);
      else validateJsonValue(value[key], `${path}.${key}`, errors, seen);
    }
  }
  seen.delete(value);
}

function matchesType(value, type) {
  if (type === 'object') return isRecord(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function validateSchema(value, schema, path, errors) {
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        errors.push(`${path}.${key} is not an accepted argument`);
      } else {
        validateSchema(value[key], properties[key], `${path}.${key}`, errors);
      }
    }
  }
  if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.items) {
      value.forEach((entry, index) => validateSchema(entry, schema.items, `${path}[${index}]`, errors));
    }
  }
}

function validateArguments(args, toolName, path, errors) {
  validateJsonValue(args, path, errors);
  const schema = TOOL_SCHEMAS.get(toolName);
  if (schema) validateSchema(args, schema, path, errors);
  if (!isRecord(args)) return;

  for (const [key, value] of Object.entries(args)) {
    if (key === 'endIndex') {
      if (!Number.isInteger(value) || value < -1) errors.push(`${path}.${key} must be an integer >= -1`);
    } else if (/Index$/.test(key)) {
      if (!Number.isInteger(value) || value < 0) errors.push(`${path}.${key} must be a non-negative integer`);
    } else if (/Indices$/.test(key) && Array.isArray(value)) {
      if (value.some((index) => !Number.isInteger(index) || index < 0)) {
        errors.push(`${path}.${key} must contain non-negative integers`);
      }
    }
  }
}

function validateStringArray(value, path, errors, minimum = 0) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
  } else if (value.length < minimum) {
    errors.push(`${path} must contain at least ${minimum} entries`);
  } else if (value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    errors.push(`${path} must contain non-empty strings`);
  }
}

function validateTarget(target, index, errors) {
  const path = `targets[${index}]`;
  if (!isRecord(target)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof target.id !== 'string' || !target.id.trim()) errors.push(`${path}.id must be a non-empty string`);
  if (target.pageIndex !== undefined && (!Number.isInteger(target.pageIndex) || target.pageIndex < 0)) {
    errors.push(`${path}.pageIndex must be a non-negative integer`);
  }
  if (target.itemIndex !== undefined && (!Number.isInteger(target.itemIndex) || target.itemIndex < 0)) {
    errors.push(`${path}.itemIndex must be a non-negative integer`);
  }
  if (target.pageIndex === undefined && typeof target.pageId !== 'string' && typeof target.documentId !== 'string') {
    errors.push(`${path} must identify a page or document`);
  }
  if (!isRecord(target.before)) errors.push(`${path}.before must be an object`);
  if (target.before?.geometricBounds !== undefined) {
    const bounds = target.before.geometricBounds;
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) {
      errors.push(`${path}.before.geometricBounds must contain four finite numbers`);
    }
  }
  if (typeof target.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(target.fingerprint)) {
    errors.push(`${path}.fingerprint must be a SHA-256 fingerprint`);
  } else {
    try {
      if (target.fingerprint !== targetFingerprint(target)) errors.push(`${path}.fingerprint mismatch`);
    } catch {
      errors.push(`${path} must be JSON-compatible`);
    }
  }
}

export function validatePlan(plan) {
  const errors = [];
  if (!isRecord(plan)) return { valid: false, errors: ['plan must be an object'] };

  if (typeof plan.planId !== 'string' || !plan.planId.trim()) errors.push('planId must be a non-empty string');
  if (plan.inspectionId !== undefined && (typeof plan.inspectionId !== 'string' || !plan.inspectionId.trim())) {
    errors.push('inspectionId must be a non-empty string when provided');
  }
  if (typeof plan.skillId !== 'string' || !plan.skillId.trim()) errors.push('skillId must be a non-empty string');
  if (typeof plan.documentFingerprint !== 'string' || !plan.documentFingerprint.trim()) {
    errors.push('documentFingerprint is required');
  }
  if (!(Number.isInteger(plan.baseRevision) && plan.baseRevision >= 0)
      && !(typeof plan.baseRevision === 'string' && plan.baseRevision.trim())) {
    errors.push('baseRevision must be a non-negative integer or non-empty string');
  }
  if (typeof plan.units !== 'string' || !SUPPORTED_UNITS.has(plan.units)) {
    errors.push('units must be one of: mm, cm, in, pt');
  }
  if (!Number.isInteger(plan.version) || plan.version < 1) errors.push('version must be a positive integer');
  if (typeof plan.expiresAt !== 'string' || !Number.isFinite(Date.parse(plan.expiresAt))) {
    errors.push('expiresAt must be a valid date');
  }
  if (!EDIT_PLAN_STATUSES.includes(plan.status)) errors.push(`status must be one of: ${EDIT_PLAN_STATUSES.join(', ')}`);
  if (!['low', 'high'].includes(plan.risk)) errors.push('risk must be low or high');

  if (!Array.isArray(plan.targets) || plan.targets.length === 0) errors.push('targets must be a non-empty array');
  if (Array.isArray(plan.targets)) plan.targets.forEach((target, index) => validateTarget(target, index, errors));

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) errors.push('steps must be a non-empty array');
  const targetFingerprints = new Set(
    Array.isArray(plan.targets)
      ? plan.targets.filter(isRecord).map((target) => target.fingerprint).filter(Boolean)
      : [],
  );
  if (Array.isArray(plan.steps)) {
    plan.steps.forEach((step, index) => {
      const path = `steps[${index}]`;
      if (!isRecord(step)) {
        errors.push(`${path} must be an object`);
        return;
      }
      if (typeof step.id !== 'string' || !step.id.trim()) errors.push(`${path}.id must be a non-empty string`);
      if (typeof step.toolName !== 'string' || !step.toolName.trim()) {
        errors.push(`${path}.toolName must be a non-empty string`);
      } else if (FORBIDDEN_TOOLS.has(step.toolName)) {
        errors.push(`${path}.toolName ${step.toolName} is forbidden in standard skill plans`);
      } else if (!TOOL_SCHEMAS.has(step.toolName)) {
        errors.push(`${path}.toolName is an unknown tool: ${step.toolName}`);
      }
      if (typeof step.targetFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(step.targetFingerprint)) {
        errors.push(`${path}.targetFingerprint is required`);
      } else if (!targetFingerprints.has(step.targetFingerprint)) {
        errors.push(`${path}.targetFingerprint does not match a plan target`);
      }
      if (!isRecord(step.expectedResult)) errors.push(`${path}.expectedResult must be an object`);
      if (typeof step.reversible !== 'boolean') errors.push(`${path}.reversible must be a boolean`);
      if (!['low', 'high'].includes(step.risk)) errors.push(`${path}.risk must be low or high`);
      if (validStepRisk(step) && step.risk !== 'low') errors.push(`${path}.risk must be low for a reversible allowlisted step`);
      if (!validStepRisk(step) && step.risk !== 'high') errors.push(`${path}.risk must be high for this step`);
      validateArguments(step.arguments, step.toolName, `${path}.arguments`, errors);
    });
  }

  if (!Array.isArray(plan.affectedPages)
      || plan.affectedPages.some((page) => !Number.isInteger(page) || page < 0)
      || new Set(plan.affectedPages).size !== plan.affectedPages.length) {
    errors.push('affectedPages must contain unique non-negative integers');
  } else {
    const affectedPages = new Set(plan.affectedPages);
    if (Array.isArray(plan.targets)) {
      plan.targets.forEach((target, index) => {
        if (isRecord(target) && Number.isInteger(target.pageIndex) && !affectedPages.has(target.pageIndex)) {
          errors.push(`targets[${index}].pageIndex must be included in affectedPages`);
        }
      });
    }
    if (Array.isArray(plan.steps)) {
      plan.steps.forEach((step, index) => {
        if (isRecord(step) && Number.isInteger(step.arguments?.pageIndex)
            && !affectedPages.has(step.arguments.pageIndex)) {
          errors.push(`steps[${index}].arguments.pageIndex must be included in affectedPages`);
        }
      });
    }
  }
  validateStringArray(plan.expectedChanges, 'expectedChanges', errors, 1);
  validateStringArray(plan.qualityCriteria, 'qualityCriteria', errors, 1);
  validateStringArray(plan.beforeArtifacts, 'beforeArtifacts', errors);
  if (plan.constraints !== undefined) validateJsonValue(plan.constraints, 'constraints', errors);

  const ids = new Set();
  for (const [collection, entries] of [['targets', plan.targets], ['steps', plan.steps]]) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) return;
      if (ids.has(entry.id)) errors.push(`duplicate id: ${entry.id}`);
      ids.add(entry.id);
      if (!entry.id.trim()) errors.push(`${collection}[${index}].id must not be blank`);
    });
  }

  const classifiedRisk = classifyPlanRisk(plan);
  if (plan.risk !== classifiedRisk) errors.push(`risk must match classified risk: ${classifiedRisk}`);
  return { valid: errors.length === 0, errors };
}
