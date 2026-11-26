import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { allToolDefinitions } from '../src/types/index.js';
import { TextHandlers } from '../src/handlers/textHandlers.js';
import { StyleHandlers } from '../src/handlers/styleHandlers.js';
import { GraphicsHandlers } from '../src/handlers/graphicsHandlers.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';

function collection(entries) {
  return {
    length: entries.length,
    item(index) {
      if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
        throw new Error(`Index ${index} out of range`);
      }
      return entries[index];
    },
    itemByName(name) {
      const entry = entries.find((candidate) => candidate.name === name);
      return entry ?? { isValid: false, name };
    },
  };
}

function textFrame(id, contents = id) {
  const ranges = new Map();
  const text = {
    pointSize: 12,
    appliedFont: null,
    fillColor: null,
    justification: null,
    appliedCharacterStyle: null,
    characters: {
      itemByRange(startIndex, endIndex) {
        const key = `${startIndex}:${endIndex}`;
        if (!ranges.has(key)) ranges.set(key, { startIndex, endIndex, appliedCharacterStyle: null });
        return ranges.get(key);
      },
    },
  };
  return {
    id,
    contents,
    texts: collection([text]),
    paragraphs: collection([{ appliedParagraphStyle: null }]),
  };
}

function pageItem(id) {
  return {
    id,
    fillColor: null,
    strokeColor: null,
    appliedObjectStyle: null,
  };
}

function mockDocument() {
  const pages = Array.from({ length: 3 }, (_, pageIndex) => {
    const frames = [textFrame(`p${pageIndex}-frame-0`), textFrame(`p${pageIndex}-frame-1`)];
    const rectangles = [pageItem(`p${pageIndex}-rectangle-0`), pageItem(`p${pageIndex}-rectangle-1`)];
    const ovals = [pageItem(`p${pageIndex}-oval-0`)];
    const polygons = [pageItem(`p${pageIndex}-polygon-0`)];
    return {
      textFrames: collection(frames),
      rectangles: collection(rectangles),
      ovals,
      polygons,
      allPageItems: [
        pageItem(`p${pageIndex}-other-0`),
        ...rectangles,
        ...frames,
        pageItem(`p${pageIndex}-other-1`),
      ],
    };
  });
  const red = { name: 'Red', isValid: true };
  const blue = { name: 'Blue', isValid: true };
  const paragraphStyle = { name: 'Body', isValid: true };
  const characterStyle = { name: 'Emphasis', isValid: true };
  const objectStyle = { name: 'Card', isValid: true };
  return {
    pages: collection(pages),
    colors: collection([red, blue]),
    paragraphStyles: collection([paragraphStyle]),
    characterStyles: collection([characterStyle]),
    objectStyles: collection([objectStyle]),
    fonts: collection([{ name: 'Arial\tRegular' }]),
    red,
    blue,
    paragraphStyle,
    characterStyle,
    objectStyle,
  };
}

async function withMockUXP(run) {
  const doc = mockDocument();
  const originalExecuteViaUXP = ScriptExecutor.executeViaUXP;
  ScriptExecutor.executeViaUXP = async (code) => runInNewContext(`(async () => {\n${code}\n})()`, {
    app: { documents: [doc], activeDocument: doc },
    require(moduleName) {
      assert.equal(moduleName, 'indesign');
      return {};
    },
  });
  try {
    return await run(doc);
  } finally {
    ScriptExecutor.executeViaUXP = originalExecuteViaUXP;
  }
}

function schemaFor(toolName) {
  return allToolDefinitions.find((definition) => definition.name === toolName)?.inputSchema;
}

test('all target-bound mutation schemas expose optional pageIndex with their existing selector', () => {
  const cases = [
    ['edit_text_frame', 'frameIndex'],
    ['apply_paragraph_style', 'frameIndex'],
    ['apply_character_style', 'frameIndex'],
    ['apply_object_style', 'itemIndex'],
    ['apply_color', 'objectIndex'],
  ];
  for (const [toolName, selector] of cases) {
    const schema = schemaFor(toolName);
    assert.ok(schema, `${toolName} must be published`);
    assert.equal(schema.properties.pageIndex.type, 'integer', toolName);
    assert.equal(schema.properties.pageIndex.default, 0, toolName);
    assert.equal(schema.required.includes('pageIndex'), false, toolName);
    assert.ok(Object.hasOwn(schema.properties, selector), toolName);
  }
});

test('apply_color publishes only its page/object/color contract', () => {
  const schema = schemaFor('apply_color');
  assert.deepEqual(Object.keys(schema.properties).sort(), ['colorName', 'colorType', 'objectIndex', 'pageIndex']);
  assert.deepEqual(schema.required, ['objectIndex', 'colorName']);
  assert.deepEqual(schema.properties.colorType.enum, ['FILL', 'STROKE']);
});

test('edit_text_frame mutates the requested page and text frame', async () => {
  await withMockUXP(async (doc) => {
    const response = await TextHandlers.editTextFrame({ pageIndex: 2, frameIndex: 1, content: 'Changed' });
    assert.equal(response.success, true);
    assert.equal(doc.pages.item(0).textFrames.item(1).contents, 'p0-frame-1');
    assert.equal(doc.pages.item(2).textFrames.item(0).contents, 'p2-frame-0');
    assert.equal(doc.pages.item(2).textFrames.item(1).contents, 'Changed');
  });
});

test('text and style handlers default omitted pageIndex to page zero', async () => {
  await withMockUXP(async (doc) => {
    assert.equal((await TextHandlers.editTextFrame({ frameIndex: 1, content: 'Default page' })).success, true);
    assert.equal(doc.pages.item(0).textFrames.item(1).contents, 'Default page');

    assert.equal((await StyleHandlers.applyParagraphStyle({ frameIndex: 1, styleName: 'Body' })).success, true);
    assert.equal(doc.pages.item(0).textFrames.item(1).paragraphs.item(0).appliedParagraphStyle, doc.paragraphStyle);

    assert.equal((await StyleHandlers.applyCharacterStyle({ frameIndex: 1, styleName: 'Emphasis' })).success, true);
    assert.equal(doc.pages.item(0).textFrames.item(1).texts.item(0).appliedCharacterStyle, doc.characterStyle);

    assert.equal((await GraphicsHandlers.applyObjectStyle({ itemIndex: 1, styleName: 'Card' })).success, true);
    assert.equal(doc.pages.item(0).rectangles.item(1).appliedObjectStyle, doc.objectStyle);

    assert.equal((await StyleHandlers.applyColor({ objectIndex: 0, colorName: 'Red' })).success, true);
    assert.equal(doc.pages.item(0).allPageItems[0].fillColor, doc.red);
  });
});

test('paragraph and character styles mutate only the requested page frame', async () => {
  await withMockUXP(async (doc) => {
    assert.equal((await StyleHandlers.applyParagraphStyle({ pageIndex: 2, frameIndex: 1, styleName: 'Body' })).success, true);
    assert.equal(doc.pages.item(0).textFrames.item(1).paragraphs.item(0).appliedParagraphStyle, null);
    assert.equal(doc.pages.item(2).textFrames.item(0).paragraphs.item(0).appliedParagraphStyle, null);
    assert.equal(doc.pages.item(2).textFrames.item(1).paragraphs.item(0).appliedParagraphStyle, doc.paragraphStyle);

    assert.equal((await StyleHandlers.applyCharacterStyle({
      pageIndex: 2, frameIndex: 1, styleName: 'Emphasis', startIndex: 1, endIndex: 3,
    })).success, true);
    const range = doc.pages.item(2).textFrames.item(1).texts.item(0).characters.itemByRange(1, 3);
    assert.equal(range.appliedCharacterStyle, doc.characterStyle);
    assert.equal(doc.pages.item(0).textFrames.item(1).texts.item(0).appliedCharacterStyle, null);
  });
});

test('apply_object_style uses pageIndex with its existing typed item selector', async () => {
  await withMockUXP(async (doc) => {
    const response = await GraphicsHandlers.applyObjectStyle({
      pageIndex: 2, itemType: 'rectangle', itemIndex: 1, styleName: 'Card',
    });
    assert.equal(response.success, true);
    assert.equal(doc.pages.item(0).rectangles.item(1).appliedObjectStyle, null);
    assert.equal(doc.pages.item(2).rectangles.item(0).appliedObjectStyle, null);
    assert.equal(doc.pages.item(2).rectangles.item(1).appliedObjectStyle, doc.objectStyle);
  });
});

test('apply_color mutates page.allPageItems[objectIndex] for FILL and STROKE', async () => {
  await withMockUXP(async (doc) => {
    const fill = await StyleHandlers.applyColor({
      pageIndex: 2, objectIndex: 1, colorName: 'Red', colorType: 'FILL',
    });
    assert.equal(fill.success, true);
    assert.equal(doc.pages.item(2).allPageItems[1].fillColor, doc.red);
    assert.equal(doc.pages.item(2).allPageItems[1].strokeColor, null);
    assert.equal(doc.pages.item(0).allPageItems[1].fillColor, null);
    assert.equal(doc.pages.item(2).textFrames.item(0).texts.item(0).fillColor, null);

    const stroke = await StyleHandlers.applyColor({
      pageIndex: 2, objectIndex: 1, colorName: 'Blue', colorType: 'STROKE',
    });
    assert.equal(stroke.success, true);
    assert.equal(doc.pages.item(2).allPageItems[1].strokeColor, doc.blue);
    assert.equal(doc.pages.item(2).allPageItems[1].fillColor, doc.red);
  });
});

test('page-aware handlers fail closed for missing pages and invalid color selectors', async () => {
  await withMockUXP(async (doc) => {
    const responses = [
      await TextHandlers.editTextFrame({ pageIndex: 9, frameIndex: 0, content: 'Nope' }),
      await StyleHandlers.applyParagraphStyle({ pageIndex: -1, frameIndex: 0, styleName: 'Body' }),
      await StyleHandlers.applyCharacterStyle({ pageIndex: 9, frameIndex: 0, styleName: 'Emphasis' }),
      await GraphicsHandlers.applyObjectStyle({ pageIndex: 9, itemIndex: 0, styleName: 'Card' }),
      await StyleHandlers.applyColor({ pageIndex: 9, objectIndex: 0, colorName: 'Red' }),
      await StyleHandlers.applyColor({ pageIndex: 0, colorName: 'Red' }),
      await StyleHandlers.applyColor({ pageIndex: 0, objectIndex: 99, colorName: 'Red' }),
      await StyleHandlers.applyColor({ pageIndex: 0, objectIndex: 0, colorName: 'Red', colorType: 'BACKGROUND' }),
    ];
    for (const response of responses) assert.equal(response.success, false);
    assert.equal(doc.pages.item(0).allPageItems[0].fillColor, null);
    assert.equal(doc.pages.item(0).allPageItems[0].strokeColor, null);
  });
});
