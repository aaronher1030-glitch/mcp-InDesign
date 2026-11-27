import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

function renderError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function unwrap(response) {
  if (response && typeof response === 'object' && 'success' in response) {
    if (response.success === false) {
      const detail = typeof response.result === 'string' ? response.result : response.error;
      throw renderError('VISUAL_CHECK_UNAVAILABLE', detail || 'export_images failed');
    }
    return response.result;
  }
  return response;
}

/**
 * Render zero-based page indexes to PNG files at 144 DPI using export_images.
 */
export async function renderPages({ pages, outputDir, callTool, resolution = 144 } = {}) {
  if (typeof callTool !== 'function') throw renderError('VISUAL_CHECK_UNAVAILABLE', 'renderPages requires callTool');
  if (!Array.isArray(pages) || pages.length === 0) {
    throw renderError('VISUAL_CHECK_UNAVAILABLE', 'renderPages requires at least one page index');
  }
  if (pages.some((page) => !Number.isInteger(page) || page < 0)) {
    throw renderError('VISUAL_CHECK_UNAVAILABLE', 'Page indexes must be non-negative integers');
  }

  const directory = outputDir ? resolve(outputDir) : mkdtempSync(join(tmpdir(), 'indesign-skill-'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const requested = [...new Set(pages)].sort((left, right) => left - right);
  const pageList = requested.map((page) => page + 1).join(',');

  const response = await callTool('export_images', {
    outputPath: directory,
    pages: pageList,
    format: 'PNG',
    resolution,
  });
  const result = unwrap(response);

  const paths = [];
  for (const [index, page] of requested.entries()) {
    const expected = join(directory, `page_${page + 1}.png`);
    if (!existsSync(expected)) {
      const reported = Array.isArray(result?.files) ? result.files[index] : undefined;
      if (reported && existsSync(reported) && statSync(reported).size > 0) {
        paths.push(resolve(reported));
        continue;
      }
      throw renderError('VISUAL_CHECK_UNAVAILABLE', `Expected render was not written: ${expected}`);
    }
    if (statSync(expected).size === 0) {
      throw renderError('VISUAL_CHECK_UNAVAILABLE', `Render is empty: ${expected}`);
    }
    paths.push(expected);
  }

  return { paths, pageIndexes: requested, outputDir: directory };
}

/**
 * Direct view: render the requested pages and open the first image in the
 * operating system image viewer so the user sees the layout immediately.
 */
export async function previewLayout({ pages = [0], outputDir, callTool, open = true } = {}) {
  const rendered = await renderPages({ pages, outputDir, callTool });
  const target = rendered.paths[0];
  let opened = false;
  if (!open) {
    return { ...rendered, opened, viewerHint: 'Rendering only; open a returned path to view the page.' };
  }
  try {
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    opened = true;
  } catch {
    opened = false;
  }
  return { ...rendered, opened, viewerHint: opened ? null : 'Open one of the returned image paths to view the page.' };
}
