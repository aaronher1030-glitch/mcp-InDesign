/**
 * `--selftest`: wait for the InDesign UXP plugin, then exercise the live
 * document once through inspect_layout and once through preview_layout.
 *
 * The bridge call and the wait are injectable so the flow can be tested
 * without a running InDesign.
 */
import { BRIDGE_HTTP_PORT } from '../version.js';

export const DEFAULT_SELFTEST_TIMEOUT_MS = 60000;
const CHECK_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selftestError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * Poll the bridge until the plugin is connected, or fail after timeoutMs.
 */
export async function waitForPlugin({
  port = BRIDGE_HTTP_PORT,
  token = process.env.BRIDGE_TOKEN || null,
  timeoutMs = DEFAULT_SELFTEST_TIMEOUT_MS,
  intervalMs = CHECK_INTERVAL_MS,
  fetchImpl = fetch,
  sleepImpl = sleep,
  log = () => {},
} = {}) {
  const attempts = Math.floor(timeoutMs / intervalMs) + 1;
  let lastReason = 'the bridge did not answer';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleepImpl(intervalMs);
    if (attempt === 0) {
      log(`Waiting up to ${Math.round(timeoutMs / 1000)}s for the InDesign plugin...`);
      log('In InDesign open Window -> Plugins -> InDesign Copilot; the panel connects on its own.');
    }

    let status;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(intervalMs * 2),
      });
      if (response.status === 401) {
        throw selftestError(
          'BRIDGE_UNAUTHORIZED',
          'the bridge rejected the request; BRIDGE_TOKEN here differs from the running bridge.',
        );
      }
      if (!response.ok) {
        lastReason = `the bridge answered HTTP ${response.status}`;
        continue;
      }
      status = await response.json();
    } catch (error) {
      if (error.code === 'BRIDGE_UNAUTHORIZED') throw error;
      lastReason = error.message;
      continue;
    }
    if (status?.connected === true) return;
    lastReason = 'the bridge is running but no plugin is connected yet';
  }

  throw selftestError(
    'SELFTEST_TIMEOUT',
    `no InDesign plugin connected after ${Math.round(timeoutMs / 1000)}s (${lastReason}).`,
  );
}

function failureReason(response) {
  if (!response || typeof response !== 'object') return 'no response';
  if (typeof response.result === 'string') return response.result;
  return response.error ?? response.code ?? 'unknown error';
}

function pageIndexesOf(inspection) {
  const pages = Array.isArray(inspection?.pages) ? inspection.pages : [];
  const indexes = pages
    .map((page) => page?.index)
    .filter((index) => Number.isInteger(index) && index >= 0);
  if (indexes.length === 0) return [0];
  return [...new Set(indexes)].sort((left, right) => left - right).slice(0, 1);
}

function runTool(toolCall, name, args) {
  return toolCall(name, args).catch((error) => {
    throw selftestError('SELFTEST_FAILED', `${name} failed: ${error.message}`);
  });
}

/**
 * Run the live smoke check: one inspection, one direct-view preview.
 */
export async function runSelftest({ toolCall, wait = waitForPlugin, log = () => {} } = {}) {
  if (typeof toolCall !== 'function') throw new TypeError('runSelftest requires a toolCall function');

  await wait();
  log('Plugin connected. Inspecting the live document...');

  const inspected = await runTool(toolCall, 'inspect_layout', { pageRange: 'all' });
  if (!inspected || inspected.success === false) {
    throw selftestError('SELFTEST_FAILED', `inspect_layout failed: ${failureReason(inspected)}`);
  }
  const inspection = inspected.result ?? inspected;
  if (!inspection || typeof inspection !== 'object' || !inspection.inspectionId) {
    throw selftestError('SELFTEST_FAILED', 'inspect_layout returned no inspectionId.');
  }

  const pages = pageIndexesOf(inspection);
  log(`Rendering page ${pages[0] + 1} for the direct view...`);

  const previewed = await runTool(toolCall, 'preview_layout', { pages, open: true });
  if (!previewed || previewed.success === false) {
    throw selftestError('SELFTEST_FAILED', `preview_layout failed: ${failureReason(previewed)}`);
  }
  const preview = previewed.result ?? previewed;
  const previewPaths = Array.isArray(preview?.paths) ? preview.paths : [];
  if (previewPaths.length === 0) {
    throw selftestError('SELFTEST_FAILED', 'preview_layout returned no rendered pages.');
  }

  return {
    status: 'passed',
    inspectionId: inspection.inspectionId,
    document: inspection.document?.name ?? null,
    pageIndexes: pages,
    previewPaths,
  };
}
