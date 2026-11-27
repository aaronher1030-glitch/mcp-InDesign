import { randomUUID } from 'node:crypto';
import { allToolDefinitions } from '../types/index.js';

const RESIZABLE_KEYS = ['fillColor', 'strokeColor', 'strokeWeight', 'visible', 'locked'];
const TEXT_FORMATTING_KEYS = ['fontSize', 'fontName', 'textColor', 'alignment'];
const TOOL_SCHEMAS = new Map(allToolDefinitions.map((entry) => [entry.name, entry.inputSchema]));

function styleName(before, camel, snake) {
  const value = before?.[camel] ?? before?.[snake];
  return typeof value === 'string' && value.trim() ? value : null;
}

function schemaAccepts(toolName, args) {
  const schema = TOOL_SCHEMAS.get(toolName);
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  if ((schema.required ?? []).some((key) => !Object.hasOwn(args, key))) return false;
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties?.[key];
    if (!property) return false;
    if (property.enum && !property.enum.includes(value)) return false;
    if (property.type === 'integer' && !Number.isInteger(value)) return false;
    if (property.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
    if (property.type === 'string' && typeof value !== 'string') return false;
    if (property.type === 'boolean' && typeof value !== 'boolean') return false;
  }
  return true;
}

function inverse(toolName, args) {
  return schemaAccepts(toolName, args) ? { toolName, arguments: args } : null;
}

/**
 * Build the inverse handler call using the target's recorded point-based
 * before-state. Inverses always call point-based handlers and are checked
 * against the published schema before they can make a step reversible.
 */
export function buildInverse(step, target) {
  if (!step || typeof step.toolName !== 'string') return null;
  const args = step.arguments && typeof step.arguments === 'object' ? step.arguments : {};
  const before = target?.before && typeof target.before === 'object' ? target.before : {};
  const bounds = Array.isArray(before.geometricBounds) && before.geometricBounds.length === 4
    && before.geometricBounds.every(Number.isFinite)
    ? before.geometricBounds
    : null;
  const pageIndex = Number.isInteger(args.pageIndex) ? args.pageIndex : 0;

  switch (step.toolName) {
    case 'move_page_item':
      if (!bounds || !Number.isInteger(args.itemIndex)) return null;
      return inverse('move_page_item', { pageIndex, itemIndex: args.itemIndex, x: bounds[1], y: bounds[0] });
    case 'resize_page_item':
      if (!bounds || !Number.isInteger(args.itemIndex)) return null;
      return inverse('resize_page_item', {
        pageIndex, itemIndex: args.itemIndex,
        width: bounds[3] - bounds[1], height: bounds[2] - bounds[0],
        anchorPoint: args.anchorPoint ?? before.anchorPoint ?? 'CENTER_ANCHOR',
      });
    case 'edit_text_frame': {
      const text = before.contents ?? before.text ?? before.content;
      if (typeof text !== 'string' || !Number.isInteger(args.frameIndex)) return null;
      // edit_text_frame treats an empty content argument as "leave unchanged".
      if (args.content !== undefined && text === '') return null;
      const restored = { pageIndex, frameIndex: args.frameIndex };
      if (args.content !== undefined) restored.content = text;
      for (const key of TEXT_FORMATTING_KEYS) {
        if (args[key] === undefined) continue;
        if (before[key] === undefined || before[key] === null) return null;
        restored[key] = before[key];
      }
      return inverse('edit_text_frame', restored);
    }
    case 'set_page_item_properties': {
      if (!Number.isInteger(args.itemIndex)) return null;
      const props = {};
      for (const key of RESIZABLE_KEYS) {
        if (Object.hasOwn(args, key)) {
          if (before[key] === undefined || before[key] === null) return null;
          props[key] = before[key];
        }
      }
      if (Object.keys(props).length === 0) return null;
      return inverse('set_page_item_properties', { pageIndex, itemIndex: args.itemIndex, ...props });
    }
    case 'apply_paragraph_style': {
      const name = styleName(before, 'paragraphStyle', 'paragraphStyleName');
      if (!name || !Number.isInteger(args.frameIndex)) return null;
      return inverse('apply_paragraph_style', { pageIndex, frameIndex: args.frameIndex, styleName: name });
    }
    case 'apply_character_style': {
      const name = styleName(before, 'characterStyle', 'characterStyleName');
      if (!name || !Number.isInteger(args.frameIndex)) return null;
      return inverse('apply_character_style', {
        pageIndex, frameIndex: args.frameIndex, styleName: name,
        startIndex: args.startIndex ?? 0, endIndex: args.endIndex ?? -1,
      });
    }
    case 'apply_object_style': {
      const name = styleName(before, 'objectStyle', 'objectStyleName');
      if (!name || !Number.isInteger(args.itemIndex)) return null;
      return inverse('apply_object_style', {
        pageIndex, itemIndex: args.itemIndex, styleName: name,
        itemType: args.itemType ?? before.itemType ?? 'rectangle',
      });
    }
    case 'apply_color': {
      if (!Number.isInteger(args.objectIndex)) return null;
      const colorType = args.colorType ?? 'FILL';
      const name = styleName(before, colorType === 'STROKE' ? 'strokeColor' : 'fillColor');
      if (!name) return null;
      return inverse('apply_color', { pageIndex, objectIndex: args.objectIndex, colorName: name, colorType });
    }
    default:
      return null;
  }
}

/**
 * Records the before-state and inverse call for every applied step so a failed
 * plan can be undone within the active session.
 */
export class EditJournal {
  constructor({ planId, risk = 'low' } = {}) {
    this.journalId = randomUUID();
    this.planId = planId;
    this.risk = risk;
    this.entries = [];
    this.backupPath = null;
    this.pending = new Map();
  }

  recordBefore(step, target) {
    if (!step || typeof step.id !== 'string') return;
    const snapshot = structuredClone({ step, target: target ?? null });
    const entry = {
      stepId: step.id,
      toolName: step.toolName,
      arguments: snapshot.step.arguments ?? {},
      before: snapshot.target?.before ?? null,
      target: snapshot.target,
      result: null,
      inverse: buildInverse(snapshot.step, snapshot.target),
      reversible: false,
      attempted: true,
      completed: false,
    };
    entry.reversible = entry.inverse !== null;
    this.entries.push(entry);
    this.pending.set(step.id, entry);
    return entry;
  }

  recordSuccess(step, result) {
    const entry = this.pending.get(step.id);
    if (!entry) return null;
    this.pending.delete(step.id);
    entry.completed = true;
    entry.result = structuredClone(result);
    return entry;
  }

  recordFailure(step, result) {
    const entry = this.pending.get(step.id);
    if (!entry) return null;
    this.pending.delete(step.id);
    entry.completed = false;
    entry.result = structuredClone(result);
    return entry;
  }

  inverseSteps() {
    return [...this.entries].reverse().filter((entry) => entry.inverse).map((entry) => ({
      ...entry.inverse,
      forStepId: entry.stepId,
    }));
  }

  summary() {
    return {
      journalId: this.journalId,
      planId: this.planId,
      risk: this.risk,
      backupPath: this.backupPath,
      steps: this.entries.map((entry) => ({
        stepId: entry.stepId,
        toolName: entry.toolName,
        reversible: entry.reversible,
        attempted: entry.attempted,
        completed: entry.completed,
      })),
      fullyReversible: this.entries.every((entry) => entry.reversible),
    };
  }
}
