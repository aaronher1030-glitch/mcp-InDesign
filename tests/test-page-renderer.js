import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPages } from '../src/quality/pageRenderer.js';

test('renders requested pages through export_images', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'indesign-render-test-'));
  try {
    const callTool = async (name, args) => {
      assert.equal(name, 'export_images');
      assert.equal(args.format, 'PNG');
      assert.equal(args.resolution, 144);
      assert.equal(args.pages, '1,3');
      writeFileSync(join(args.outputPath, 'page_1.png'), 'png');
      writeFileSync(join(args.outputPath, 'page_3.png'), 'png');
      return {
        success: true,
        result: {
          files: [join(args.outputPath, 'page_1.png'), join(args.outputPath, 'page_3.png')],
        },
      };
    };
    const result = await renderPages({ pages: [0, 2], outputDir, callTool });
    assert.deepEqual(result.pageIndexes, [0, 2]);
    assert.equal(result.paths.length, 2);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('maps fallback files by requested-page order for noncontiguous pages', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'indesign-render-test-'));
  try {
    const exportDir = join(outputDir, 'exports');
    mkdirSync(exportDir);
    const files = [join(exportDir, 'page_2.png'), join(exportDir, 'page_4.png')];
    const result = await renderPages({
      pages: [1, 3],
      outputDir,
      callTool: async (name, args) => {
        assert.equal(name, 'export_images');
        assert.equal(args.pages, '2,4');
        for (const path of files) writeFileSync(path, 'png');
        return { success: true, result: { files } };
      },
    });
    assert.deepEqual(result.pageIndexes, [1, 3]);
    assert.deepEqual(result.paths, files);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('fails clearly when export_images reports an error', async () => {
  await assert.rejects(
    () => renderPages({
      pages: [0],
      callTool: async () => ({ success: false, result: 'No document open' }),
    }),
    /VISUAL_CHECK_UNAVAILABLE/,
  );
});
