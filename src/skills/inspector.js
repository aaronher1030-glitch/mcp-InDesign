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

  const styles = await read('get_document_styles', undefined, (result) => {
    if (!isRecord(result) && !Array.isArray(result)) throw new TypeError('styles must be an object or array');
  });
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
    });
    const summary = await read('get_page_content_summary', args, (value) => {
      if (!isRecord(value)) throw new TypeError('page content summary must be an object');
    });
    pages.push({ index, items: result.items, summary });
  }

  const inspection = {
    inspectionId: randomUUID(),
    createdAt: new Date().toISOString(),
    document,
    pages,
    styles,
    colors,
    layers,
    validation,
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
