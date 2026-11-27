import { isDeepStrictEqual } from 'node:util';
import { toPoints } from '../skills/units.js';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

function scalarIdentity(value) {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}

function itemIndex(item) {
  return item.index ?? item.itemIndex ?? item.frameIndex ?? item.objectIndex;
}

function stableId(value) {
  return value?.id ?? value?.uuid ?? value?.itemId ?? value?.objectId;
}

function pageId(page) {
  return page?.id ?? page?.pageId ?? page?.uuid;
}

function identityOf(value) {
  const id = stableId(value);
  if (scalarIdentity(id)) return `id:${String(id)}`;
  for (const key of ['path', 'filePath', 'name', 'fontName', 'message']) {
    if (scalarIdentity(value[key])) return `${key}:${String(value[key]).trim()}`;
  }
  try {
    return JSON.stringify(value) ?? `record:${Object.keys(value).sort().join(',')}`;
  } catch {
    return `record:${Object.keys(value).sort().map((key) => `${key}:${typeof value[key]}`).join(',')}`;
  }
}

function hasItemIdentity(item) {
  return isRecord(item) && (scalarIdentity(stableId(item))
    || isIndex(itemIndex(item))
    || (typeof item.name === 'string' && item.name.trim().length > 0));
}

function collectionEntries(value) {
  if (Array.isArray(value)) return value.map((entry) => ({ type: '', entry }));
  if (!isRecord(value)) return [];
  const entries = [];
  for (const [type, collection] of Object.entries(value)) {
    if (Array.isArray(collection)) {
      for (const entry of collection) entries.push({ type, entry });
    }
  }
  return entries;
}

function entryName(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (isRecord(entry)) {
    for (const key of ['name', 'styleName', 'colorName', 'swatchName']) {
      if (typeof entry[key] === 'string' && entry[key].trim()) return entry[key].trim();
    }
  }
  return null;
}

function validateCollection(value, path, errors) {
  let count = 0;
  if (Array.isArray(value)) {
    count = value.length;
    if (value.some((entry) => entryName(entry) === null)) errors.push(`${path} entries must have names`);
  } else if (!isRecord(value)) {
    errors.push(`${path} must be an array or an object of arrays`);
  } else {
    for (const [type, entries] of Object.entries(value)) {
      if (!Array.isArray(entries)) {
        errors.push(`${path}.${type} must be an array`);
      } else {
        count += entries.length;
        if (entries.some((entry) => entryName(entry) === null)) {
          errors.push(`${path}.${type} entries must have names`);
        }
      }
    }
  }
  if (count === 0) errors.push(`${path} must contain at least one named entry`);
}

function meaningfulMetadata(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!isRecord(value)) return false;
  const identities = ['id', 'uuid', 'path', 'filePath', 'name', 'fontName', 'fullName',
    'postscriptName', 'message', 'code', 'type', 'category'];
  const statuses = ['status', 'state', 'linkStatus'];
  if (!identities.some((key) => scalarIdentity(value[key]))
      && !statuses.some((key) => typeof value[key] === 'boolean' || scalarIdentity(value[key]))) {
    return false;
  }
  return statuses.every((key) => value[key] === undefined
    || typeof value[key] === 'boolean' || scalarIdentity(value[key]));
}

function validateAssetArray(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.some((entry) => !meaningfulMetadata(entry))) {
    errors.push(`${path} entries must have meaningful identities and statuses`);
  }
}

const CAPABILITY_STATUSES = new Set(['known', 'unknown', 'not_applicable']);
const FORMATTING_ARRAY_FIELDS = [
  'fontNames', 'justifications', 'fillColors', 'paragraphStyles', 'characterStyles',
];

function validateCapability(value, path, errors, item = null) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an inspection capability object`);
    return;
  }
  if (!CAPABILITY_STATUSES.has(value.status)) {
    errors.push(`${path}.status must be known, unknown, or not_applicable`);
    return;
  }
  if (value.reason !== undefined && (typeof value.reason !== 'string' || !value.reason.trim())) {
    errors.push(`${path}.reason must be a non-empty string when supplied`);
  }
  if (value.status === 'not_applicable' && item
      && (item.type === 'TextFrame' || Object.hasOwn(item, 'contents'))) {
    errors.push(`${path} cannot be not_applicable for a text frame`);
  }
  if (value.status !== 'known' || !item) return;
  if (path.endsWith('.textInspection') && typeof item.overset !== 'boolean') {
    errors.push(`${path} is known but item.overset must be a boolean`);
  }
  if (path.endsWith('.textFormatting')) {
    for (const field of FORMATTING_ARRAY_FIELDS) {
      if (!Array.isArray(value[field]) || value[field].some((entry) => typeof entry !== 'string')) {
        errors.push(`${path}.${field} must be an array of strings`);
      }
    }
    if (!Array.isArray(value.pointSizes) || value.pointSizes.some((size) => !Number.isFinite(size))) {
      errors.push(`${path}.pointSizes must be an array of finite numbers`);
    }
  }
}

function validateCoverage(snapshot, path, errors) {
  const count = documentPageCount(snapshot);
  if (!Number.isInteger(count) || !Array.isArray(snapshot.pages)) return;
  const indexes = snapshot.pages.map((page) => page?.index);
  if (snapshot.coverage === undefined) {
    if (snapshot.pages.length !== count || indexes.some((index) => !isIndex(index))) {
      errors.push(`${path} must inspect every document page before verification`);
    }
    return;
  }
  const coverage = snapshot.coverage;
  const sortedIndexes = [...indexes].sort((a, b) => a - b);
  const inspectedIndexes = Array.isArray(coverage?.inspectedPageIndexes)
    ? [...coverage.inspectedPageIndexes].sort((a, b) => a - b)
    : [];
  if (!isRecord(coverage) || coverage.pageCount !== count
      || !Array.isArray(coverage.inspectedPageIndexes)
      || coverage.inspectedPageIndexes.some((index) => !isIndex(index) || index >= count)
      || new Set(coverage.inspectedPageIndexes).size !== coverage.inspectedPageIndexes.length
      || typeof coverage.complete !== 'boolean'
      || coverage.complete !== (coverage.inspectedPageIndexes.length === count)
      || indexes.some((index) => !isIndex(index) || index >= count)
      || indexes.length !== coverage.inspectedPageIndexes.length
      || sortedIndexes.some((index, i) => index !== inspectedIndexes[i])) {
    errors.push(`${path}.coverage is invalid or does not match inspected pages`);
  } else if (!coverage.complete) {
    errors.push(`${path} has incomplete page coverage and cannot verify uninspected changes`);
  }
}

function validationLists(validation, key) {
  const lists = [];
  for (const source of [validation?.[key], validation?.document?.[key]]) {
    if (source !== undefined) lists.push(source);
  }
  return lists;
}

function validateSnapshot(snapshot, path, errors) {
  if (!isRecord(snapshot)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isRecord(snapshot.document)) {
    errors.push(`${path}.document must be an object`);
  } else {
    const count = snapshot.document.pages ?? snapshot.document.pageCount;
    if (!Number.isInteger(count) || count < 1) errors.push(`${path}.document page count is invalid`);
    for (const dimension of ['width', 'height']) {
      if (!Number.isFinite(snapshot.document[dimension]) || snapshot.document[dimension] <= 0) {
        errors.push(`${path}.document.${dimension} must be a positive finite number`);
      }
    }
  }
  if (!Array.isArray(snapshot.pages) || snapshot.pages.length === 0) {
    errors.push(`${path}.pages must be a non-empty array`);
  } else {
    const count = snapshot.document?.pages ?? snapshot.document?.pageCount;
    const indexes = new Set();
    snapshot.pages.forEach((page, position) => {
      if (!isRecord(page) || !isIndex(page.index) || indexes.has(page.index)) {
        errors.push(`${path}.pages[${position}] must have a unique non-negative index`);
        return;
      }
      indexes.add(page.index);
      if (Number.isInteger(count) && page.index >= count) {
        errors.push(`${path}.pages[${position}].index exceeds the document page count`);
      }
      if (!Array.isArray(page.items)) {
        errors.push(`${path}.pages[${position}].items must be an array`);
        return;
      }
      page.items.forEach((item, itemPosition) => {
        if (!hasItemIdentity(item)) {
          errors.push(`${path}.pages[${position}].items[${itemPosition}] has no stable identity`);
        }
        if (isRecord(item) && (!Array.isArray(item.geometricBounds) || item.geometricBounds.length !== 4
            || !item.geometricBounds.every(Number.isFinite))) {
          errors.push(`${path}.pages[${position}].items[${itemPosition}].geometricBounds is invalid`);
        }
        if (isRecord(item) && item.name !== undefined
            && (typeof item.name !== 'string' || !item.name.trim())) {
          errors.push(`${path}.pages[${position}].items[${itemPosition}].name is invalid`);
        }
        if (isRecord(item) && stableId(item) !== undefined && !scalarIdentity(stableId(item))) {
          errors.push(`${path}.pages[${position}].items[${itemPosition}] has an invalid stable id`);
        }
        if (isRecord(item)) {
          const itemPath = `${path}.pages[${position}].items[${itemPosition}]`;
          validateCapability(item.textInspection, `${itemPath}.textInspection`, errors, item);
          validateCapability(item.textFormatting, `${itemPath}.textFormatting`, errors, item);
        }
      });
    });
  }

  validateCoverage(snapshot, path, errors);
  validateCollection(snapshot.styles, `${path}.styles`, errors);
  validateCollection(snapshot.colors, `${path}.colors`, errors);
  if (!isRecord(snapshot.validation)) {
    errors.push(`${path}.validation must be an object`);
  } else {
    if (!Array.isArray(snapshot.validation.issues)) {
      errors.push(`${path}.validation.issues must be an array`);
    } else if (snapshot.validation.issues.some((issue) => !meaningfulMetadata(issue))) {
      errors.push(`${path}.validation.issues entries must have meaningful identities or statuses`);
    }
    for (const key of ['missingLinks', 'missingFonts']) {
      for (const list of validationLists(snapshot.validation, key)) {
        validateAssetArray(list, `${path}.validation.${key}`, errors);
      }
    }
    validateCapability(snapshot.validation.linkInspection, `${path}.validation.linkInspection`, errors);
    validateCapability(snapshot.validation.fontInspection, `${path}.validation.fontInspection`, errors);
  }
  for (const key of ['links', 'fonts']) {
    if (snapshot[key] !== undefined) validateAssetArray(snapshot[key], `${path}.${key}`, errors);
    if (snapshot.document?.[key] !== undefined) {
      validateAssetArray(snapshot.document[key], `${path}.document.${key}`, errors);
    }
  }
}

function validatePlanShape(plan, errors) {
  if (!isRecord(plan)) {
    errors.push('plan must be an object');
    return;
  }
  if (!Array.isArray(plan.targets)) errors.push('plan.targets must be an array');
  else plan.targets.forEach((target, index) => {
    if (!isRecord(target) || !isIndex(target.pageIndex)) {
      errors.push(`plan.targets[${index}] must have a non-negative pageIndex`);
    }
  });
  if (plan.steps !== undefined && !Array.isArray(plan.steps)) {
    errors.push('plan.steps must be an array');
  } else if (Array.isArray(plan.steps)) {
    plan.steps.forEach((step, index) => {
      if (!isRecord(step) || typeof step.toolName !== 'string' || !step.toolName.trim()) {
        errors.push(`plan.steps[${index}] must have a toolName`);
      } else if (step.arguments !== undefined && !isRecord(step.arguments)) {
        errors.push(`plan.steps[${index}].arguments must be an object`);
      }
      if (isRecord(step) && step.expectedResult !== undefined && !isRecord(step.expectedResult)) {
        errors.push(`plan.steps[${index}].expectedResult must be an object`);
      }
    });
  }
}

function bleedValues(plan, errors) {
  const bleed = plan?.constraints?.bleed ?? plan?.bleed;
  if (bleed === undefined) return { top: 0, left: 0, bottom: 0, right: 0 };
  if (typeof bleed === 'number' && Number.isFinite(bleed) && bleed >= 0) {
    return { top: bleed, left: bleed, bottom: bleed, right: bleed };
  }
  if (!isRecord(bleed)) {
    errors.push('planned bleed must be a non-negative number or object');
    return { top: 0, left: 0, bottom: 0, right: 0 };
  }
  const result = {};
  for (const side of ['top', 'left', 'bottom', 'right']) {
    const value = bleed[side] ?? 0;
    if (!Number.isFinite(value) || value < 0) errors.push(`planned bleed.${side} is invalid`);
    result[side] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return result;
}

function pageOperations(plan) {
  return (Array.isArray(plan?.steps) ? plan.steps : []).filter((step) => (
    isRecord(step) && ['add_page', 'delete_page'].includes(step.toolName)
  ));
}

function documentPageCount(snapshot) {
  return snapshot?.document?.pages ?? snapshot?.document?.pageCount;
}

function simulatePages(before, operations) {
  const tokens = before.pages.map((page) => ({ beforePage: page, id: pageId(page) }));
  for (const operation of operations) {
    const args = operation.arguments ?? {};
    if (operation.toolName === 'delete_page') {
      let position = -1;
      if (isIndex(args.pageIndex)) position = args.pageIndex;
      else if (scalarIdentity(args.pageId)) {
        position = tokens.findIndex((token) => String(token.id) === String(args.pageId));
      }
      if (position < 0 || position >= tokens.length) return null;
      tokens.splice(position, 1);
      continue;
    }
    let position = tokens.length;
    if (isIndex(args.pageIndex)) position = args.pageIndex;
    else if (isIndex(args.newPageIndex)) position = args.newPageIndex;
    else {
      const placement = args.position ?? 'AT_END';
      if (placement === 'AT_BEGINNING') position = 0;
      else if (placement === 'AT_END') position = tokens.length;
      else if (['BEFORE', 'AFTER'].includes(placement)) {
        const reference = args.referencePage ?? args.referencePageIndex;
        if (!isIndex(reference) || reference >= tokens.length) return null;
        position = reference + (placement === 'AFTER' ? 1 : 0);
      } else return null;
    }
    if (position < 0 || position > tokens.length) return null;
    tokens.splice(position, 0, { beforePage: null, id: null });
  }
  return tokens;
}

function mapPages(before, after, plan) {
  const operations = pageOperations(plan);
  const beforeById = new Map();
  const afterById = new Map();
  for (const page of before.pages) {
    if (scalarIdentity(pageId(page))) beforeById.set(String(pageId(page)), page);
  }
  for (const page of after.pages) {
    if (scalarIdentity(pageId(page))) afterById.set(String(pageId(page)), page);
  }

  // Page operations can shift indexes. Simulate their order only when both
  // snapshots cover the whole document; partial inspections fall back to ids.
  if (operations.length > 0 && before.pages.length === documentPageCount(before)
      && after.pages.length === documentPageCount(after)) {
    const sequence = simulatePages(before, operations);
    if (sequence && sequence.length === after.pages.length) {
      const used = new Set();
      const mapped = sequence.map((token) => {
        if (token.beforePage && scalarIdentity(token.id)) {
          const match = afterById.get(String(token.id));
          if (match && !used.has(match.index)) {
            used.add(match.index);
            return { beforePage: token.beforePage, afterPage: match };
          }
          return { beforePage: token.beforePage, afterPage: null };
        }
        return { beforePage: token.beforePage, afterPage: null, plannedAddition: !token.beforePage };
      });
      sequence.forEach((token, position) => {
        if (mapped[position].afterPage) return;
        const candidate = after.pages.find((page) => page.index === position && !used.has(page.index));
        if (candidate && (!scalarIdentity(token.id) || String(pageId(candidate)) === String(token.id))) {
          mapped[position].afterPage = candidate;
          used.add(candidate.index);
        }
      });
      if (used.size === after.pages.length) {
        const surviving = new Set(mapped.filter((pair) => pair.beforePage).map((pair) => pair.beforePage));
        for (const page of before.pages) {
          if (!surviving.has(page)) mapped.push({ beforePage: page, afterPage: null, plannedDeletion: true });
        }
        return { pairs: mapped, valid: true };
      }
    }
    return { pairs: [], valid: false };
  }

  const usedAfter = new Set();
  const pairs = before.pages.map((beforePage) => {
    const id = pageId(beforePage);
    let afterPage = scalarIdentity(id) ? afterById.get(String(id)) : undefined;
    if (!afterPage) afterPage = after.pages.find((page) => page.index === beforePage.index);
    if (afterPage && scalarIdentity(id) && scalarIdentity(pageId(afterPage))
        && String(id) !== String(pageId(afterPage))) afterPage = undefined;
    if (afterPage) usedAfter.add(afterPage.index);
    return { beforePage, afterPage: afterPage ?? null };
  });
  for (const afterPage of after.pages) {
    if (!usedAfter.has(afterPage.index)) pairs.push({ beforePage: null, afterPage });
  }
  return { pairs, valid: true };
}

function itemKey(item, pageKey) {
  const id = stableId(item);
  if (scalarIdentity(id)) return `${pageKey}|id:${String(id)}`;
  const index = itemIndex(item);
  if (isIndex(index) && typeof item.name === 'string') {
    return `${pageKey}|index:${index}|name:${item.name}`;
  }
  if (isIndex(index)) return `${pageKey}|index:${index}`;
  return `${pageKey}|name:${item.name}`;
}

function targetMatches(target, item, page, beforePage = page) {
  if (!isRecord(target) || !isRecord(item) || !isRecord(page) || !isRecord(beforePage)) return false;
  if (scalarIdentity(target.pageId)) {
    if (String(target.pageId) !== String(pageId(page))) return false;
  } else if (isIndex(target.pageIndex) && target.pageIndex !== beforePage.index) {
    return false;
  }
  const id = stableId(target);
  if (scalarIdentity(id)) return scalarIdentity(stableId(item)) && String(id) === String(stableId(item));
  if (typeof target.fingerprint === 'string' && target.fingerprint === item.fingerprint) return true;
  const index = target.itemIndex ?? target.index;
  if (isIndex(index) && index !== itemIndex(item)) return false;
  if (typeof target.name === 'string' && target.name !== item.name) return false;
  return isIndex(index) || typeof target.name === 'string';
}

function stepMatchesTarget(step, target) {
  if (!isRecord(step) || !isRecord(target)) return false;
  if (step.targetFingerprint !== undefined) return step.targetFingerprint === target.fingerprint;
  const args = step.arguments ?? {};
  return args.pageIndex === target.pageIndex
    && (args.itemIndex === (target.itemIndex ?? target.index)
      || args.frameIndex === (target.frameIndex ?? target.itemIndex ?? target.index)
      || args.objectIndex === (target.objectIndex ?? target.itemIndex ?? target.index));
}

function explicitlyDeleted(target, steps) {
  return steps.some((step) => step.toolName === 'delete_page_item' && stepMatchesTarget(step, target));
}

function overflow(item) {
  return isRecord(item) && [item.overset, item.textOverflow, item.overflow, item.overflows]
    .some((value) => value === true);
}

function outsideBounds(item, document, bleed) {
  if (!Array.isArray(item?.geometricBounds)) return false;
  const [top, left, bottom, right] = item.geometricBounds;
  // Document dimensions remain public millimeters; inspected geometry is points.
  const pageHeight = toPoints(document.height, 'mm');
  const pageWidth = toPoints(document.width, 'mm');
  const epsilon = 1e-7;
  return top < -bleed.top - epsilon || left < -bleed.left - epsilon
    || bottom > pageHeight + bleed.bottom + epsilon
    || right > pageWidth + bleed.right + epsilon;
}

function missingAssets(snapshot, kind) {
  const plural = kind === 'link' ? 'Links' : 'Fonts';
  const assetsKey = kind === 'link' ? 'links' : 'fonts';
  const result = [];
  const add = (entry) => result.push(entry);
  for (const list of [
    ...validationLists(snapshot.validation, `missing${plural}`),
    snapshot[`missing${plural}`],
    snapshot[assetsKey],
    snapshot.document?.[assetsKey],
  ]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry === 'string') {
        add(entry);
      } else if (isRecord(entry)) {
        const status = String(entry.status ?? entry.state ?? entry.linkStatus ?? '').toLowerCase();
        const missing = entry.missing === true || entry.isMissing === true || entry.isValid === false
          || ['missing', 'broken', 'invalid', 'absent', 'notfound', 'not found'].includes(status)
          || (kind === 'font' && (entry.substituted === true || status === 'substituted'));
        if (missing) add(entry);
      }
    }
  }
  for (const issue of snapshot.validation?.issues ?? []) {
    if (typeof issue === 'string') {
      if (kind === 'link' && /^(broken|missing)\s+link\s*:/i.test(issue)) add(issue);
      if (kind === 'font' && /^missing\s+font\s*:/i.test(issue)) add(issue);
    } else if (isRecord(issue)) {
      const label = String(issue.code ?? issue.type ?? issue.category ?? issue.message ?? '').toLowerCase();
      const matches = kind === 'link'
        ? /missing[_ ]?link|broken[_ ]?link/.test(label)
        : /missing[_ ]?font|font[_ ]?substitut/.test(label);
      if (matches) add(issue);
    }
  }
  return result;
}

function multisetIncrease(before, after) {
  const counts = new Map();
  for (const entry of before) {
    const key = identityOf(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const increased = [];
  for (const entry of after) {
    const key = identityOf(entry);
    const count = counts.get(key) ?? 0;
    if (count > 0) counts.set(key, count - 1);
    else increased.push(entry);
  }
  return increased;
}

function duplicateNames(snapshot, kind) {
  const value = kind === 'style' ? snapshot.styles : snapshot.colors;
  const counts = new Map();
  for (const { type, entry } of collectionEntries(value)) {
    const name = entryName(entry);
    if (!name) continue;
    const key = `${type}\u0000${name.toLowerCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicates = [];
  for (const [key, count] of counts) {
    if (count > 1) duplicates.push({ key, count });
  }
  return duplicates;
}

function impliedTargetFields(step) {
  const args = step.arguments ?? {};
  const fields = new Set();
  switch (step.toolName) {
    case 'move_page_item':
    case 'resize_page_item':
      fields.add('geometricBounds');
      break;
    case 'set_page_item_properties':
      if (args.fillColor !== undefined) fields.add('fillColorName');
      if (args.strokeColor !== undefined) fields.add('strokeColorName');
      if (args.strokeWeight !== undefined) fields.add('strokeWeight');
      if (args.visible !== undefined) fields.add('visible');
      if (args.locked !== undefined) fields.add('locked');
      break;
    case 'edit_text_frame': {
      const changesContent = typeof args.content === 'string' && args.content.length > 0;
      const changesFormatting = !!args.fontSize || !!args.fontName || !!args.textColor || !!args.alignment;
      if (changesContent) fields.add('contents');
      if (changesFormatting) fields.add('textFormatting');
      if (changesContent || changesFormatting) {
        for (const field of ['overset', 'textOverflow', 'overflow', 'overflows']) fields.add(field);
      }
      break;
    }
    case 'apply_paragraph_style':
    case 'apply_character_style':
      for (const field of ['textFormatting', 'overset', 'textOverflow', 'overflow', 'overflows']) fields.add(field);
      break;
    case 'apply_object_style':
      for (const field of ['appliedObjectStyle', 'fillColorName', 'strokeColorName', 'fillTint',
        'strokeTint', 'strokeWeight', 'rotationAngle', 'shearAngle', 'textFormatting',
        'overset', 'textOverflow', 'overflow', 'overflows']) fields.add(field);
      break;
    case 'apply_color':
      if ((args.colorType ?? 'FILL') === 'FILL') fields.add('fillColorName');
      else fields.add('strokeColorName');
      break;
    default:
      break;
  }
  return fields;
}

function expectedTargetState(target, steps) {
  const expected = {};
  let supplied = false;
  const sources = [target.expectedState, target.expectedPostState, target.expectedResult];
  for (const source of sources) {
    if (!isRecord(source)) continue;
    Object.assign(expected, source);
    supplied = true;
  }
  for (const step of steps) {
    if (!stepMatchesTarget(step, target) || !isRecord(step.expectedResult)) continue;
    Object.assign(expected, step.expectedResult);
    supplied = true;
  }
  return supplied ? expected : null;
}

function addUnknownCapabilityIssues(snapshot, phase, addIssue) {
  for (const page of snapshot.pages) {
    for (const entry of page.items) {
      const details = { phase, pageIndex: page.index, itemIndex: itemIndex(entry) };
      if (entry.textInspection.status === 'unknown') {
        addIssue('TEXT_OVERFLOW', `Text overflow status is unknown: ${entry.name ?? entry.id}`, {
          ...details, status: 'unknown', reason: entry.textInspection.reason,
        });
      }
      if (entry.textFormatting.status === 'unknown') {
        addIssue('TARGET_STATE_MISMATCH', `Text formatting status is unknown: ${entry.name ?? entry.id}`, {
          ...details, status: 'unknown', reason: entry.textFormatting.reason,
        });
      }
    }
  }
  for (const [kind, code] of [['link', 'MISSING_LINK'], ['font', 'MISSING_FONT']]) {
    const inspection = snapshot.validation?.[`${kind}Inspection`];
    if (inspection?.status === 'unknown') {
      addIssue(code, `${kind} inspection status is unknown`, {
        phase, status: 'unknown', reason: inspection.reason,
      });
    }
  }
}

/**
 * Deterministically compare two inspection snapshots. This function performs
 * no I/O and never mutates its inputs. Missing critical inspection data fails
 * closed rather than being treated as an empty, successful document.
 */
export function runStructuralChecks(input = {}) {
  const { before, after, plan } = isRecord(input) ? input : {};
  const issues = [];
  const errors = [];
  const addIssue = (code, message, details = {}) => issues.push({ code, message, ...details });

  validateSnapshot(before, 'before', errors);
  validateSnapshot(after, 'after', errors);
  validatePlanShape(plan, errors);
  const bleed = bleedValues(plan, errors);
  const steps = Array.isArray(plan?.steps) ? plan.steps.filter(isRecord) : [];
  const targets = Array.isArray(plan?.targets) ? plan.targets.filter(isRecord) : [];

  const beforeCount = documentPageCount(before);
  const afterCount = documentPageCount(after);
  if (Number.isInteger(beforeCount) && Number.isInteger(afterCount) && beforeCount !== afterCount) {
    const operations = pageOperations(plan);
    const additions = operations.filter((step) => step.toolName === 'add_page').length;
    const deletions = operations.filter((step) => step.toolName === 'delete_page').length;
    if (afterCount - beforeCount !== additions - deletions) {
      addIssue('PAGE_COUNT_CHANGED', 'Document page count changed without a matching explicit page plan', {
        beforeCount,
        afterCount,
        plannedAdditions: additions,
        plannedDeletions: deletions,
      });
    }
  }
  if (errors.length > 0) {
    addIssue('TARGET_STATE_MISMATCH', 'Structural inspection or plan data is incomplete or malformed', {
      errors,
    });
    return { pass: false, issues };
  }

  addUnknownCapabilityIssues(before, 'before', addIssue);
  addUnknownCapabilityIssues(after, 'after', addIssue);

  const mapping = mapPages(before, after, plan);
  if (!mapping.valid) {
    addIssue('TARGET_STATE_MISMATCH', 'Page additions/deletions do not align with the explicit page plan');
  }
  const pairs = mapping.valid ? mapping.pairs : before.pages.map((page) => ({
    beforePage: page,
    afterPage: after.pages.find((candidate) => candidate.index === page.index) ?? null,
  }));

  const changedPairs = [];
  const beforeForAfter = new Map();
  for (const pair of pairs) {
    const beforePage = pair.beforePage;
    const afterPage = pair.afterPage;
    const pageKey = beforePage
      ? (scalarIdentity(pageId(beforePage)) ? `page-id:${String(pageId(beforePage))}` : `page-index:${beforePage.index}`)
      : `new-page:${afterPage.index}`;
    const beforeGroups = new Map();
    const afterGroups = new Map();
    for (const entry of beforePage?.items ?? []) {
      const key = itemKey(entry, pageKey);
      if (!beforeGroups.has(key)) beforeGroups.set(key, []);
      beforeGroups.get(key).push({ item: entry, matched: false });
    }
    for (const entry of afterPage?.items ?? []) {
      const key = itemKey(entry, pageKey);
      if (!afterGroups.has(key)) afterGroups.set(key, []);
      afterGroups.get(key).push({ item: entry, matched: false });
    }

    for (const [key, afterEntries] of afterGroups) {
      const beforeEntries = beforeGroups.get(key) ?? [];
      for (const afterEntry of afterEntries) {
        // Prefer equal states within a duplicate identity group so reordering
        // indistinguishable-index items does not look like an edit.
        let beforeEntry = beforeEntries.find((candidate) => (
          !candidate.matched && isDeepStrictEqual(candidate.item, afterEntry.item)
        ));
        if (!beforeEntry) beforeEntry = beforeEntries.find((candidate) => !candidate.matched);
        if (beforeEntry) {
          beforeEntry.matched = true;
          afterEntry.matched = true;
          beforeForAfter.set(afterEntry.item, beforeEntry.item);
          if (!isDeepStrictEqual(beforeEntry.item, afterEntry.item)) {
            changedPairs.push({ beforeItem: beforeEntry.item, afterItem: afterEntry.item, beforePage, afterPage });
          }
        } else {
          const targeted = targets.some((target) => (
            targetMatches(target, afterEntry.item, afterPage, beforePage ?? afterPage)
          ));
          const planned = pair.plannedAddition
            ? targeted || afterEntry.item.inheritedMasterContent === true
            : targeted;
          if (!planned) {
            addIssue('UNINTENDED_ITEM_ADDITION', `Unintended item addition: ${afterEntry.item.name ?? afterEntry.item.id}`, {
              pageIndex: afterPage.index,
              item: afterEntry.item,
            });
          }
        }
      }
    }
    for (const beforeEntries of beforeGroups.values()) {
      for (const beforeEntry of beforeEntries) {
        if (beforeEntry.matched || pair.plannedDeletion) continue;
        const plannedTarget = targets.find((target) => targetMatches(target, beforeEntry.item, beforePage));
        const allowed = plannedTarget && explicitlyDeleted(plannedTarget, steps);
        if (!allowed) {
          addIssue('UNINTENDED_ITEM_REMOVAL', `Unintended item removal: ${beforeEntry.item.name ?? beforeEntry.item.id}`, {
            pageIndex: beforePage.index,
            item: beforeEntry.item,
          });
        }
      }
    }
  }

  for (const change of changedPairs) {
    const planned = targets.some((target) => (
      targetMatches(target, change.beforeItem, change.beforePage)
      || targetMatches(target, change.afterItem, change.afterPage, change.beforePage)
    ));
    if (!planned) {
      addIssue('TARGET_STATE_MISMATCH', `Unplanned item state change: ${change.afterItem.name ?? change.afterItem.id}`, {
        pageIndex: change.afterPage.index,
        before: change.beforeItem,
        after: change.afterItem,
      });
    }
  }

  for (const pair of pairs) {
    for (const entry of pair.afterPage?.items ?? []) {
      const beforeItem = beforeForAfter.get(entry) ?? null;
      if (overflow(entry) && !overflow(beforeItem)) {
        addIssue('TEXT_OVERFLOW', `New text overflow: ${entry.name ?? entry.id}`, {
          pageIndex: pair.afterPage.index,
          itemIndex: itemIndex(entry),
        });
      }
      if (outsideBounds(entry, after.document, bleed) && !outsideBounds(beforeItem, after.document, bleed)) {
        addIssue('OUT_OF_BOUNDS', `New out-of-bounds content: ${entry.name ?? entry.id}`, {
          pageIndex: pair.afterPage.index,
          itemIndex: itemIndex(entry),
          geometricBounds: entry.geometricBounds,
        });
      }
    }
  }

  for (const [kind, code] of [['link', 'MISSING_LINK'], ['font', 'MISSING_FONT']]) {
    const increased = multisetIncrease(missingAssets(before, kind), missingAssets(after, kind));
    for (const entry of increased) {
      addIssue(code, `Newly missing ${kind}: ${identityOf(entry)}`, { [kind]: entry });
    }
  }

  for (const [kind, label] of [['style', 'style'], ['color', 'color']]) {
    const beforeDuplicates = new Map(duplicateNames(before, kind).map((entry) => [entry.key, entry.count]));
    for (const duplicate of duplicateNames(after, kind)) {
      if (duplicate.count > (beforeDuplicates.get(duplicate.key) ?? 0)) {
        addIssue('DUPLICATE_STYLE', `New duplicate ${label}: ${duplicate.key.split('\u0000')[1]}`, {
          kind,
          count: duplicate.count,
        });
      }
    }
  }

  for (const step of steps) {
    if (step.status !== undefined && !['completed', 'succeeded', 'success'].includes(step.status)) {
      addIssue('TARGET_STATE_MISMATCH', `Planned step did not complete: ${step.id ?? step.toolName}`, {
        stepId: step.id,
        status: step.status,
      });
    }
  }

  for (const target of targets) {
    const matches = [];
    for (const pair of pairs) {
      for (const entry of pair.afterPage?.items ?? []) {
        if (targetMatches(target, entry, pair.afterPage, pair.beforePage ?? pair.afterPage)) matches.push(entry);
      }
    }
    const deleted = explicitlyDeleted(target, steps);
    if (matches.length === 0) {
      if (!deleted) {
        addIssue('TARGET_STATE_MISMATCH', `Planned target is missing: ${target.name ?? target.id ?? target.itemIndex}`, {
          pageIndex: target.pageIndex,
          itemIndex: target.itemIndex ?? target.index,
        });
      }
      continue;
    }
    if (matches.length > 1 || deleted) {
      addIssue('TARGET_STATE_MISMATCH', `Planned target does not have one unambiguous post-state: ${target.name ?? target.id}`, {
        pageIndex: target.pageIndex,
        matchCount: matches.length,
      });
      continue;
    }
    const expected = expectedTargetState(target, steps);
    const actual = matches[0];
    const beforeItem = beforeForAfter.get(actual) ?? null;
    const matchingSteps = steps.filter((step) => stepMatchesTarget(step, target));
    const allowedFields = new Set(Object.keys(expected ?? {}));
    for (const step of matchingSteps) {
      for (const field of impliedTargetFields(step)) allowedFields.add(field);
    }
    const fields = new Set(beforeItem ? [...Object.keys(beforeItem), ...Object.keys(actual)] : []);
    const mismatches = [...fields].filter((field) => (
      !isDeepStrictEqual(beforeItem?.[field], actual[field]) && !allowedFields.has(field)
    ));
    for (const field of Object.keys(expected ?? {})) {
      if (!isDeepStrictEqual(actual[field], expected[field]) && !mismatches.includes(field)) {
        mismatches.push(field);
      }
    }
    if (mismatches.length > 0) {
      addIssue('TARGET_STATE_MISMATCH', `Planned target post-state mismatch: ${target.name ?? target.id}`, {
        pageIndex: target.pageIndex,
        itemIndex: target.itemIndex ?? target.index,
        fields: mismatches,
        expected,
        actual,
      });
    }
  }

  return { pass: issues.length === 0, issues };
}
