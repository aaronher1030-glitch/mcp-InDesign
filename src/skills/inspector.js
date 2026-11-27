import { randomUUID } from 'node:crypto';
import { parsePageRange } from '../utils/pageRange.js';
import { documentFingerprint } from './planSchema.js';

function inspectionError(message, details = {}) {
  const error = new Error(`INSPECTION_FAILED: ${message}`);
  error.code = 'INSPECTION_FAILED';
  Object.assign(error, details);
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Capture a read-only layout snapshot through the existing low-level tools.
 * Tool results are cloned so neither inspection nor its caller can mutate the
 * bridge's fixture/document data through shared references.
 */
export async function inspectLayout(options = {}, callTool) {
  if (!isRecord(options)) {
    throw inspectionError('inspectLayout options must be an object');
  }
  const { pageRange = 'all' } = options;
  if (typeof callTool !== 'function') {
    throw inspectionError('inspectLayout requires a callTool function');
  }

  async function read(toolName, args, validate = () => {}) {
    let response;
    try {
      response = await callTool(toolName, args);
    } catch (cause) {
      throw inspectionError(`${toolName} threw: ${cause?.message ?? String(cause)}`, {
        toolName,
        toolArgs: args,
        cause,
      });
    }
    if (!isRecord(response) || response.success !== true || !Object.hasOwn(response, 'result')) {
      const reason = response?.error ?? response?.result ?? 'malformed tool response';
      let detail;
      try {
        detail = typeof reason === 'string' ? reason : JSON.stringify(reason);
      } catch {
        detail = String(reason);
      }
      const cause = new Error(detail ?? 'malformed tool response');
      throw inspectionError(`${toolName} failed: ${cause.message}`, {
        toolName,
        toolArgs: args,
        cause,
      });
    }
    try {
      validate(response.result);
      return structuredClone(response.result);
    } catch (cause) {
      throw inspectionError(`${toolName} returned invalid data: ${cause.message}`, {
        toolName,
        toolArgs: args,
        cause,
      });
    }
  }

  const document = await read('get_document_info', undefined, (result) => {
    if (!isRecord(result)) throw new TypeError('document info must be an object');
  });
  const pageCount = document.pages ?? document.pageCount;
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw inspectionError('get_document_info returned an invalid page count', {
      toolName: 'get_document_info',
      phase: 'document',
    });
  }

  let pageIndexes;
  try {
    pageIndexes = parsePageRange(pageRange, pageCount);
  } catch (cause) {
    throw inspectionError(cause.message, { phase: 'pageRange', cause });
  }

  const styleTypes = [
    ['PARAGRAPH', 'paragraph'],
    ['CHARACTER', 'character'],
    ['OBJECT', 'object'],
  ];
  const styles = {};
  let legacyStyles;
  for (const [styleType, key] of styleTypes) {
    const result = await read('get_document_styles', { styleType }, (value) => {
      if (!isRecord(value) && !Array.isArray(value)) {
        throw new TypeError('styles must be an object or array');
      }
      if (isRecord(value) && (value.styleType !== undefined || Array.isArray(value.styles))) {
        if ((value.styleType !== undefined && value.styleType !== styleType)
            || !Array.isArray(value.styles) || value.count !== value.styles.length
            || value.styles.some((name) => typeof name !== 'string' || !name.trim())) {
          throw new TypeError(`styles must contain the requested ${styleType} style list and count`);
        }
      }
    });
    if (isRecord(result) && result.styleType !== undefined) {
      styles[key] = result.styles;
    } else if (legacyStyles === undefined) {
      // Older bridges/fixtures returned the whole map (or the default paragraph
      // list) regardless of arguments. Keep that input working while preferring
      // actual per-type responses whenever the bridge supplies them.
      legacyStyles = Array.isArray(result) || (isRecord(result) && Array.isArray(result.styles))
        ? (Array.isArray(result) ? result : result.styles)
        : result;
    }
  }
  if (legacyStyles !== undefined) {
    if (Array.isArray(legacyStyles)) {
      styles.paragraph ??= legacyStyles;
    } else {
      for (const [, key] of styleTypes) {
        styles[key] ??= legacyStyles[key];
      }
    }
  }
  for (const [, key] of styleTypes) styles[key] ??= [];
  const colors = await read('get_document_colors', undefined, (result) => {
    if (!isRecord(result) && !Array.isArray(result)) throw new TypeError('colors must be an object or array');
  });
  const layers = await read('get_document_layers', undefined, (result) => {
    if (!isRecord(result) && !Array.isArray(result)) throw new TypeError('layers must be an object or array');
  });
  const validation = await read('validate_document', undefined, (result) => {
    if (!isRecord(result)) throw new TypeError('validation must be an object');
  });

  const pages = [];
  for (const index of pageIndexes) {
    const args = { pageIndex: index };
    const result = await read('list_page_items', args, (value) => {
      if (!isRecord(value) || !Array.isArray(value.items)
          || value.items.some((entry) => !isRecord(entry))) {
        throw new TypeError('list_page_items must return an items array of objects');
      }
      if (value.pageIndex !== undefined && value.pageIndex !== index) {
        throw new TypeError(`list_page_items returned page ${value.pageIndex} instead of ${index}`);
      }
      if (value.count !== undefined && (!Number.isInteger(value.count) || value.count !== value.items.length)) {
        throw new TypeError('list_page_items count must match its returned items array');
      }
    });
    const summary = await read('get_page_content_summary', args, (value) => {
      if (!isRecord(value)) throw new TypeError('page content summary must be an object');
      if (value.pageIndex !== undefined && value.pageIndex !== index) {
        throw new TypeError(`page content summary returned page ${value.pageIndex} instead of ${index}`);
      }
    });
    pages.push({ index, items: result.items, summary });
  }

  const inspection = {
    inspectionId: randomUUID(),
    createdAt: new Date().toISOString(),
    document,
    pages,
    coverage: {
      pageCount,
      inspectedPageIndexes: [...pageIndexes],
      complete: pageIndexes.length === pageCount,
    },
    styles,
    colors,
    layers,
    validation,
    ...(Array.isArray(validation.fonts) ? { fonts: validation.fonts } : {}),
    ...(Array.isArray(validation.links) ? { links: validation.links } : {}),
  };
  try {
    inspection.fingerprint = documentFingerprint(inspection);
  } catch (cause) {
    throw inspectionError(`Could not fingerprint inspection: ${cause.message}`, {
      phase: 'fingerprint',
      cause,
    });
  }
  return inspection;
}
