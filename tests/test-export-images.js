import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parsePageRange } from '../src/utils/pageRange.js';
import { allToolDefinitions } from '../src/types/index.js';
import { ExportHandlers } from '../src/handlers/exportHandlers.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';

const JPEG_QUALITY = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  MAXIMUM: 'MAXIMUM',
};

function mockInDesignBridge(t, options = {}) {
  const pageCount = options.pageCount ?? 5;
  const calls = [];
  const exports = [];
  const app = {
    documents: pageCount === 0 ? [] : [{}],
    activeDocument: {
      pages: {
        length: pageCount,
        item(pageIndex) {
          assert.ok(Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pageCount);
          return {
            async exportFile(format, fileName, showingOptions) {
              exports.push({
                pageIndex,
                format,
                fileName,
                showingOptions,
                jpegResolution: app.jpegExportPreferences.exportResolution,
                jpegQuality: app.jpegExportPreferences.jpegQuality,
                pngResolution: app.pngExportPreferences.exportResolution,
              });
              if (options.exportPage) {
                await options.exportPage({ pageIndex, fileName });
                return;
              }
              writeFileSync(fileName, `image-${pageIndex + 1}`);
            },
          };
        },
      },
    },
    jpegExportPreferences: {
      exportResolution: 72,
      jpegQuality: JPEG_QUALITY.LOW,
    },
    pngExportPreferences: { exportResolution: 96 },
  };

  t.mock.method(ScriptExecutor, 'executeViaUXP', async (code) => {
    calls.push(code);
    if (options.bridgeFailureAt === calls.length) throw new Error('Bridge unavailable');
    return runInNewContext(`(async () => {\n${code}\n})()`, {
      app,
      require(moduleName) {
        assert.equal(moduleName, 'indesign');
        return {
          ExportFormat: { jpegType: 'JPEG', pngType: 'PNG', tiffType: 'TIFF' },
          JPEGOptionsQuality: JPEG_QUALITY,
        };
      },
    });
  });

  return { app, calls, exports };
}

function temporaryOutputDirectory(t) {
  const outputPath = mkdtempSync(join(tmpdir(), 'indesign-export-images-'));
  t.after(() => rmSync(outputPath, { recursive: true, force: true }));
  return outputPath;
}

test('parses all, single pages, lists, and inclusive ranges', () => {
  assert.deepEqual(parsePageRange('all', 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(parsePageRange('3', 5), [2]);
  assert.deepEqual(parsePageRange('1-3,5', 5), [0, 1, 2, 4]);
  assert.deepEqual(parsePageRange('5,1-2,2', 5), [0, 1, 4]);
});

test('rejects malformed and out-of-range pages', () => {
  assert.throws(() => parsePageRange('0', 5), /positive/);
  assert.throws(() => parsePageRange('2-4', 3), /range/);
  assert.throws(() => parsePageRange('1,x', 5), /Invalid page/);
});

test('export_images schema matches handler arguments', () => {
  const definition = allToolDefinitions.find((tool) => tool.name === 'export_images');
  assert.deepEqual(Object.keys(definition.inputSchema.properties).sort(), [
    'format', 'outputPath', 'pages', 'quality', 'resolution',
  ]);
  assert.equal(definition.inputSchema.required[0], 'outputPath');
});

test('export_images applies JPEG preferences and restores them after export', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  const { app, calls, exports } = mockInDesignBridge(t);

  const response = await ExportHandlers.exportImages({
    outputPath,
    format: 'JPEG',
    quality: 40,
    resolution: 300,
    pages: '5,1-2,2',
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(exports.map(({ pageIndex }) => pageIndex), [0, 1, 4]);
  assert.deepEqual(exports.map(({ fileName }) => basename(fileName)), [
    'page_1.jpeg', 'page_2.jpeg', 'page_5.jpeg',
  ]);
  for (const entry of exports) {
    assert.equal(entry.format, 'JPEG');
    assert.equal(entry.showingOptions, false);
    assert.equal(entry.jpegResolution, 300);
    assert.equal(entry.jpegQuality, JPEG_QUALITY.MEDIUM);
  }
  assert.equal(app.jpegExportPreferences.exportResolution, 72);
  assert.equal(app.jpegExportPreferences.jpegQuality, JPEG_QUALITY.LOW);
  assert.equal(response.success, true);
  assert.deepEqual(response.result, {
    count: 3,
    files: [1, 2, 5].map((page) => join(outputPath, `page_${page}.jpeg`)),
  });
  for (const filePath of response.result.files) {
    assert.ok(basename(filePath).startsWith('page_'));
  }
});

test('export_images maps the JPEG quality range to InDesign quality levels', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  const { app, exports } = mockInDesignBridge(t);
  const cases = [
    [1, JPEG_QUALITY.LOW],
    [25, JPEG_QUALITY.LOW],
    [26, JPEG_QUALITY.MEDIUM],
    [50, JPEG_QUALITY.MEDIUM],
    [51, JPEG_QUALITY.HIGH],
    [75, JPEG_QUALITY.HIGH],
    [76, JPEG_QUALITY.MAXIMUM],
    [100, JPEG_QUALITY.MAXIMUM],
  ];

  for (const [quality] of cases) {
    const response = await ExportHandlers.exportImages({
      outputPath, format: 'JPEG', quality, resolution: 144, pages: '1',
    });
    assert.equal(response.success, true);
    assert.equal(app.jpegExportPreferences.exportResolution, 72);
    assert.equal(app.jpegExportPreferences.jpegQuality, JPEG_QUALITY.LOW);
  }

  assert.deepEqual(exports.map(({ jpegQuality }) => jpegQuality), cases.map(([, level]) => level));
});

test('export_images applies default PNG resolution without changing JPEG quality', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  const { app, calls, exports } = mockInDesignBridge(t);

  const response = await ExportHandlers.exportImages({ outputPath, pages: '1' });

  assert.equal(calls.length, 2);
  assert.equal(exports.length, 1);
  assert.equal(exports[0].format, 'PNG');
  assert.equal(exports[0].pngResolution, 144);
  assert.equal(app.pngExportPreferences.exportResolution, 96);
  assert.equal(app.jpegExportPreferences.jpegQuality, JPEG_QUALITY.LOW);
  assert.deepEqual(response.result, {
    count: 1,
    files: [join(outputPath, 'page_1.png')],
  });
});

test('export_images restores preferences when a page export fails', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  const { app, exports } = mockInDesignBridge(t, {
    exportPage({ pageIndex, fileName }) {
      if (pageIndex === 1) throw new Error('Disk full');
      writeFileSync(fileName, 'first-image');
    },
  });

  const response = await ExportHandlers.exportImages({
    outputPath, format: 'JPEG', quality: 90, resolution: 240, pages: '1-2',
  });

  assert.equal(response.success, false);
  assert.match(response.result, /Disk full/);
  assert.equal(exports[1].jpegResolution, 240);
  assert.equal(exports[1].jpegQuality, JPEG_QUALITY.MAXIMUM);
  assert.equal(app.jpegExportPreferences.exportResolution, 72);
  assert.equal(app.jpegExportPreferences.jpegQuality, JPEG_QUALITY.LOW);
});

test('export_images restores resolution when applying JPEG quality fails', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  const { app } = mockInDesignBridge(t);
  Object.defineProperty(app.jpegExportPreferences, 'jpegQuality', {
    get: () => JPEG_QUALITY.LOW,
    set: () => { throw new Error('Quality is read-only'); },
    configurable: true,
  });

  const response = await ExportHandlers.exportImages({
    outputPath, format: 'JPEG', quality: 90, resolution: 240, pages: '1',
  });

  assert.equal(response.success, false);
  assert.match(response.result, /Quality is read-only/);
  assert.equal(app.jpegExportPreferences.exportResolution, 72);
});

test('export_images rejects invalid pages before the export bridge call', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  const { calls, exports } = mockInDesignBridge(t, { pageCount: 3 });

  const response = await ExportHandlers.exportImages({ outputPath, pages: '2-4' });

  assert.equal(response.success, false);
  assert.match(response.result, /range/);
  assert.equal(calls.length, 1);
  assert.equal(exports.length, 0);
});

test('export_images reports no open document without a second bridge call', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  const { calls, exports } = mockInDesignBridge(t, { pageCount: 0 });

  const response = await ExportHandlers.exportImages({ outputPath });

  assert.equal(response.success, false);
  assert.equal(response.result, 'No document open');
  assert.equal(calls.length, 1);
  assert.equal(exports.length, 0);
});

test('export_images requires every verified output to be a non-empty file', async (t) => {
  for (const failure of ['missing', 'empty', 'directory']) {
    await t.test(failure, async (child) => {
      const outputPath = temporaryOutputDirectory(child);
      const { app } = mockInDesignBridge(child, {
        exportPage({ pageIndex, fileName }) {
          if (pageIndex === 0) {
            writeFileSync(fileName, 'first-image');
          } else if (failure === 'empty') {
            writeFileSync(fileName, '');
          } else if (failure === 'directory') {
            mkdirSync(fileName);
          }
        },
      });

      const response = await ExportHandlers.exportImages({ outputPath, pages: '1-2' });

      assert.equal(response.success, false);
      assert.match(response.result, /page_2\.png/);
      assert.equal(app.pngExportPreferences.exportResolution, 96);
    });
  }
});

test('export_images surfaces bridge rejections', async (t) => {
  const outputPath = temporaryOutputDirectory(t);
  mockInDesignBridge(t, { bridgeFailureAt: 1 });

  await assert.rejects(
    ExportHandlers.exportImages({ outputPath }),
    /Bridge unavailable/,
  );
});
