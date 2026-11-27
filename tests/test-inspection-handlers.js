import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { DocumentHandlers } from '../src/handlers/documentHandlers.js';
import { PageItemHandlers } from '../src/handlers/pageItemHandlers.js';
import { ScriptExecutor } from '../src/core/scriptExecutor.js';

function collection(entries) {
  const result = {
    length: entries.length,
    item(index) { return entries[index]; },
  };
  entries.forEach((entry, index) => { result[index] = entry; });
  return result;
}

function measurementPreferences(horizontal = 'points', vertical = 'points') {
  return {
    _horizontal: horizontal,
    _vertical: vertical,
    get horizontalMeasurementUnits() { return this._horizontal; },
    set horizontalMeasurementUnits(value) { this._horizontal = value; },
    get verticalMeasurementUnits() { return this._vertical; },
    set verticalMeasurementUnits(value) { this._vertical = value; },
  };
}

async function withMockUXP(document, run, indesign = {}) {
  const original = ScriptExecutor.executeViaUXP;
  document.viewPreferences ??= measurementPreferences();
  const indesignWithUnits = {
    ...indesign,
    MeasurementUnits: {
      millimeters: 'mm', points: 'pt', inches: 'in', centimeters: 'cm', picas: 'picas',
      ...indesign.MeasurementUnits,
    },
  };
  ScriptExecutor.executeViaUXP = async (code) => {
    try {
      return await runInNewContext(`(async () => {\n${code}\n})()`, {
        app: { documents: [document], activeDocument: document },
        require(name) {
          assert.equal(name, 'indesign');
          return indesignWithUnits;
        },
      });
    } catch (error) {
      return { error: error.message };
    }
  };
  try {
    return await run();
  } finally {
    ScriptExecutor.executeViaUXP = original;
  }
}

test('list_page_items captures overset, text formatting, appearance, and inherited master origin', async () => {
  const master = { name: 'A-Master' };
  const range = {
    appliedFont: { name: 'Arial\tRegular', status: 'INSTALLED' },
    pointSize: 12,
    justification: 'leftAlign',
    fillColor: { name: 'Black' },
    appliedParagraphStyle: { name: 'Body' },
    appliedCharacterStyle: { name: 'None' },
  };
  const frame = {
    constructor: { name: 'TextFrame' },
    id: 10,
    name: 'Body',
    visible: true,
    locked: false,
    geometricBounds: [10, 10, 50, 100],
    fillColor: { name: 'None' },
    strokeColor: null,
    strokeWeight: 0,
    overflows: true,
    contents: 'Overset text',
    parent: master,
    overridden: false,
    textStyleRanges: collection([range]),
  };
  const page = { allPageItems: collection([frame]), appliedMaster: master };
  const document = { pages: collection([page]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    assert.equal(response.success, true);
    const item = response.result.items[0];
    assert.equal(item.overset, true);
    assert.equal(item.inheritedMasterContent, true);
    assert.equal(item.masterName, 'A-Master');
    assert.equal(item.textInspection.status, 'known');
    assert.equal(item.textFormatting.status, 'known');
    assert.deepEqual(Array.from(item.textFormatting.fontNames), ['Arial\tRegular']);
    assert.deepEqual(Array.from(item.textFormatting.pointSizes), [12]);
    assert.deepEqual(Array.from(item.textFormatting.paragraphStyles), ['Body']);
    assert.equal(item.fillColorName, 'None');
    assert.equal(item.strokeWeight, 0);
  });
});

test('list_page_items normalizes mixed-axis bounds to points and restores ruler units', async () => {
  const viewPreferences = measurementPreferences('inches', 'centimeters');
  const pointsPerUnit = { pt: 1, in: 72, cm: 72 / 2.54 };
  const frame = {
    constructor: { name: 'Rectangle' }, id: 10, name: 'Logo', visible: true, locked: false,
    fillColor: null, strokeColor: null, strokeWeight: 0, parent: {},
    get geometricBounds() {
      const vertical = pointsPerUnit[viewPreferences.verticalMeasurementUnits];
      const horizontal = pointsPerUnit[viewPreferences.horizontalMeasurementUnits];
      return [10 / vertical, 10 / horizontal, 50 / vertical, 100 / horizontal];
    },
  };
  const document = {
    pages: collection([{ allPageItems: collection([frame]), appliedMaster: null }]),
    viewPreferences,
  };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    assert.equal(response.success, true);
    assert.equal(response.result.geometricBoundsUnit, 'pt');
    assert.deepEqual(Array.from(response.result.items[0].geometricBounds), [10, 10, 50, 100]);
    assert.equal(viewPreferences.horizontalMeasurementUnits, 'inches');
    assert.equal(viewPreferences.verticalMeasurementUnits, 'centimeters');
  });
});

test('list_page_items restores both ruler units when inspection throws', async () => {
  const viewPreferences = measurementPreferences('inches', 'picas');
  const frame = {
    constructor: { name: 'Rectangle' }, id: 10, name: 'Logo', visible: true, locked: false,
    fillColor: null, strokeColor: null, strokeWeight: 0, parent: {},
    get geometricBounds() { throw new Error('bounds unavailable'); },
  };
  const document = {
    pages: collection([{ allPageItems: collection([frame]), appliedMaster: null }]),
    viewPreferences,
  };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    assert.equal(response.success, false);
    assert.match(response.result, /bounds unavailable/);
    assert.equal(viewPreferences.horizontalMeasurementUnits, 'inches');
    assert.equal(viewPreferences.verticalMeasurementUnits, 'picas');
  });
});

test('list_page_items protects both unit writes and restores the first after a setter failure', async () => {
  for (const failingAxis of ['horizontal', 'vertical']) {
    const viewPreferences = measurementPreferences('inches', 'picas');
    const original = viewPreferences[`${failingAxis}MeasurementUnits`];
    const restored = [];
    Object.defineProperty(viewPreferences, `${failingAxis}MeasurementUnits`, {
      configurable: true,
      get() { return original; },
      set(value) {
        if (value === 'pt') throw new Error(`${failingAxis} unit write failed`);
        this[`_${failingAxis}`] = value;
        restored.push(failingAxis);
      },
    });
    const frame = {
      constructor: { name: 'Rectangle' }, id: 10, name: 'Logo', visible: true, locked: false,
      geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0, parent: {},
    };
    const document = {
      pages: collection([{ allPageItems: collection([frame]), appliedMaster: null }]),
      viewPreferences,
    };
    await withMockUXP(document, async () => {
      const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
      assert.equal(response.success, false);
      assert.match(response.result, new RegExp(`${failingAxis} unit write failed`));
      assert.equal(viewPreferences.horizontalMeasurementUnits, 'inches');
      assert.equal(viewPreferences.verticalMeasurementUnits, 'picas');
      assert.ok(restored.includes(failingAxis));
    });
  }
});

test('list_page_items uses masterPageItems membership across object identities', async () => {
  const master = { id: 7, name: 'A-Master' };
  const frame = {
    constructor: { name: 'TextFrame' }, id: 10, name: 'Folio', visible: true, locked: false,
    geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0,
    overflows: false, parent: {}, textStyleRanges: collection([]),
  };
  const page = {
    allPageItems: collection([frame]), appliedMaster: master,
    masterPageItems: [{ id: 10, name: 'Folio' }],
  };
  const document = { pages: collection([page]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    assert.equal(response.result.items[0].inheritedMasterContent, true);
    assert.equal(response.result.items[0].masterContentInspection.status, 'known');
  });
});

test('list_page_items recognizes inherited group children in non-iterable master collections', async () => {
  const master = { id: 7, name: 'A-Master' };
  const group = { id: 20, name: 'Master group', constructor: { name: 'Group' }, parent: master };
  const frame = {
    constructor: { name: 'TextFrame' }, id: 10, name: 'Folio', visible: true, locked: false,
    geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0,
    overflows: false, parent: group, overridden: false, textStyleRanges: collection([]),
  };
  const page = {
    allPageItems: collection([frame]), appliedMaster: master,
    masterPageItems: collection([{ id: 20, name: 'Master group' }]),
  };
  const document = { pages: collection([page]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    assert.equal(response.result.items[0].inheritedMasterContent, true);
    assert.equal(response.result.items[0].masterContentInspection.status, 'known');
  });
});

test('list_page_items treats authoritative empty master membership as non-inherited', async () => {
  const master = { id: 7, name: 'A-Master' };
  const frame = {
    constructor: { name: 'Rectangle' }, id: 10, name: 'Page content', visible: true, locked: false,
    geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0,
    parent: master, overridden: false,
  };
  const page = { allPageItems: collection([frame]), appliedMaster: master, masterPageItems: [] };
  const document = { pages: collection([page]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    assert.equal(response.result.items[0].inheritedMasterContent, false);
    assert.equal(response.result.items[0].masterContentInspection.status, 'known');
  });
});

test('list_page_items reports unavailable authoritative master membership as unknown', async () => {
  const frame = {
    constructor: { name: 'Rectangle' }, id: 10, name: 'Content', visible: true, locked: false,
    geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0,
    parent: {},
  };
  const page = {
    allPageItems: collection([frame]), appliedMaster: null,
    get masterPageItems() { throw new Error('membership unavailable'); },
  };
  const document = { pages: collection([page]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    assert.equal(response.result.items[0].inheritedMasterContent, null);
    assert.equal(response.result.items[0].masterContentInspection.status, 'unknown');
  });
});

test('list_page_items preserves string-valued UXP fonts, colors, and applied styles', async () => {
  const range = {
    appliedFont: 'Arial\tRegular',
    pointSize: 12,
    justification: 'leftAlign',
    fillColor: 'Black',
    appliedParagraphStyle: 'Body',
    appliedCharacterStyle: 'None',
  };
  const frame = {
    constructor: { name: 'TextFrame' }, id: 10, name: 'Body', visible: true, locked: false,
    geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0,
    overflows: false, contents: 'Text', parent: {}, textStyleRanges: collection([range]),
  };
  const document = { pages: collection([{ allPageItems: collection([frame]), appliedMaster: null }]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    const formatting = response.result.items[0].textFormatting;
    assert.equal(formatting.status, 'known');
    assert.deepEqual(Array.from(formatting.fontNames), ['Arial\tRegular']);
    assert.deepEqual(Array.from(formatting.fillColors), ['Black']);
    assert.deepEqual(Array.from(formatting.paragraphStyles), ['Body']);
    assert.deepEqual(Array.from(formatting.characterStyles), ['None']);
  });
});

test('list_page_items reports explicit unknown text capabilities instead of false clean data', async () => {
  const frame = {
    constructor: { name: 'TextFrame' }, id: 10, name: 'Body', visible: true, locked: false,
    geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0,
    parent: {},
    get overflows() { throw new Error('overflows unavailable'); },
    get textStyleRanges() { throw new Error('formatting unavailable'); },
  };
  const document = { pages: collection([{ allPageItems: collection([frame]), appliedMaster: null }]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    const item = response.result.items[0];
    assert.equal(item.overset, null);
    assert.equal(item.textInspection.status, 'unknown');
    assert.equal(item.textFormatting.status, 'unknown');
  });
});

test('list_page_items treats an absent texts property as non-text content', async () => {
  const graphic = {
    constructor: { name: 'Rectangle' }, id: 11, name: 'Logo', visible: true, locked: false,
    geometricBounds: [10, 10, 50, 100], fillColor: null, strokeColor: null, strokeWeight: 0,
    texts: undefined, parent: {},
  };
  const document = { pages: collection([{ allPageItems: collection([graphic]), appliedMaster: null }]) };
  await withMockUXP(document, async () => {
    const response = await PageItemHandlers.listPageItems({ pageIndex: 0 });
    const item = response.result.items[0];
    assert.equal(item.textInspection.status, 'not_applicable');
    assert.equal(item.textFormatting.status, 'not_applicable');
    assert.equal(Object.hasOwn(item, 'contents'), false);
  });
});

test('validate_document exposes actual font status, substitutions, and missing-font identities', async () => {
  const fonts = [
    { name: 'Arial\tRegular', status: 'INSTALLED', isValid: true },
    { name: 'Missing Font', status: 'MISSING', isValid: true },
    { name: 'Substituted Font', status: 'SUBSTITUTED', isValid: true },
  ];
  const document = { fonts: collection(fonts), links: collection([]) };
  await withMockUXP(document, async () => {
    const response = await DocumentHandlers.validateDocument({});
    assert.equal(response.success, true);
    assert.equal(response.result.fontInspection.status, 'known');
    assert.deepEqual(Array.from(response.result.fonts, (font) => font.status), ['INSTALLED', 'MISSING', 'SUBSTITUTED']);
    assert.deepEqual(Array.from(response.result.missingFonts), ['Missing Font', 'Substituted Font']);
    assert.equal(response.result.isValid, false);
  });
});

test('validate_document normalizes actual UXP font and link status enums', async () => {
  const enumValue = (name, value) => ({
    equals(other) { return other === value; },
    toString() { return name; },
    valueOf() { return value; },
  });
  const FontStatus = {
    INSTALLED: enumValue('INSTALLED', 1718831470),
    NOT_AVAILABLE: enumValue('NOT_AVAILABLE', 1718832705),
    SUBSTITUTED: enumValue('SUBSTITUTED', 1718834037),
    UNKNOWN: enumValue('UNKNOWN', 1433299822),
  };
  const LinkStatus = {
    NORMAL: enumValue('NORMAL', 1852797549),
    LINK_MISSING: enumValue('LINK_MISSING', 1819109747),
  };
  const document = {
    fonts: collection([
      { name: 'Arial\tRegular', status: FontStatus.INSTALLED, isValid: true },
      { name: 'Missing Font', status: FontStatus.NOT_AVAILABLE, isValid: true },
      { name: 'Substituted Font', status: FontStatus.SUBSTITUTED, isValid: true },
    ]),
    links: collection([
      { id: 1, name: 'Present', status: LinkStatus.NORMAL, isValid: true },
      { id: 2, name: 'Absent', status: LinkStatus.LINK_MISSING, isValid: true },
    ]),
  };
  await withMockUXP(document, async () => {
    const response = await DocumentHandlers.validateDocument({});
    assert.equal(response.success, true);
    assert.equal(response.result.fontInspection.status, 'known');
    assert.equal(response.result.linkInspection.status, 'known');
    assert.deepEqual(Array.from(response.result.fonts, (font) => font.status), [
      'INSTALLED', 'NOT_AVAILABLE', 'SUBSTITUTED',
    ]);
    assert.deepEqual(Array.from(response.result.missingFonts), ['Missing Font', 'Substituted Font']);
    assert.deepEqual(Array.from(response.result.links, (link) => link.status), ['NORMAL', 'MISSING']);
    assert.deepEqual(Array.from(response.result.missingLinks), ['Absent']);
    assert.equal(response.result.isValid, false);
  }, { FontStatus, LinkStatus });
});

test('validate_document marks unavailable font status as unknown', async () => {
  const font = {
    name: 'Unknown Font', isValid: true,
    get status() { throw new Error('status unavailable'); },
  };
  const document = { fonts: collection([font]), links: collection([]) };
  await withMockUXP(document, async () => {
    const response = await DocumentHandlers.validateDocument({});
    assert.equal(response.success, true);
    assert.equal(response.result.fontInspection.status, 'unknown');
    assert.equal(response.result.fonts[0].status, 'UNKNOWN');
    assert.equal(response.result.isValid, false);
  });
});

test('validate_document accepts omitted options for read-only inspection', async () => {
  const document = { fonts: collection([]), links: collection([]) };
  await withMockUXP(document, async () => {
    const response = await DocumentHandlers.validateDocument();
    assert.equal(response.success, true);
    assert.equal(response.result.linkInspection.status, 'known');
    assert.equal(response.result.fontInspection.status, 'known');
  });
});

test('get_document_info exposes saved and modified state for guarded backups', async () => {
  const document = {
    name: 'Brief', filePath: null, saved: true, modified: false,
    pages: collection([{}]), spreads: collection([]), layers: collection([]), masterSpreads: collection([]),
    viewPreferences: { horizontalMeasurementUnits: 'points', verticalMeasurementUnits: 'points' },
    documentPreferences: {
      pageWidth: 612, pageHeight: 792, facingPages: false,
      documentBleedTopOffset: 0, documentBleedBottomOffset: 0,
      documentBleedInsideOrLeftOffset: 0, documentBleedOutsideOrRightOffset: 0,
    },
    marginPreferences: { top: 72, bottom: 72, left: 72, right: 72 },
  };
  await withMockUXP(document, async () => {
    const response = await DocumentHandlers.getDocumentInfo();
    assert.equal(response.success, true);
    assert.equal(response.result.saved, true);
    assert.equal(response.result.modified, false);
  }, { MeasurementUnits: { millimeters: 'mm', points: 'pt' } });
});

test('get_document_info restores the first unit when the second unit setter throws', async () => {
  const viewPreferences = {
    _horizontal: 'inches',
    _vertical: 'picas',
    get horizontalMeasurementUnits() { return this._horizontal; },
    set horizontalMeasurementUnits(value) { this._horizontal = value; },
    get verticalMeasurementUnits() { return this._vertical; },
    set verticalMeasurementUnits(value) {
      if (value === 'mm') throw new Error('vertical unit write failed');
      this._vertical = value;
    },
  };
  const document = {
    name: 'Brief', filePath: null, pages: collection([{}]), spreads: collection([]),
    layers: collection([]), masterSpreads: collection([]), viewPreferences,
    documentPreferences: { pageWidth: 210, pageHeight: 297 },
    marginPreferences: {},
  };
  await withMockUXP(document, async () => {
    const response = await DocumentHandlers.getDocumentInfo();
    assert.equal(response.success, false);
    assert.match(response.result, /vertical unit write failed/);
    assert.equal(viewPreferences.horizontalMeasurementUnits, 'inches');
    assert.equal(viewPreferences.verticalMeasurementUnits, 'picas');
  }, { MeasurementUnits: { millimeters: 'mm' } });
});

test('get_document_info restores measurement units when reading dimensions throws', async () => {
  const viewPreferences = {
    horizontalMeasurementUnits: 'inches', verticalMeasurementUnits: 'picas',
  };
  const document = {
    name: 'Brief', filePath: null, pages: collection([{}]), spreads: collection([]),
    layers: collection([]), masterSpreads: collection([]), viewPreferences,
    documentPreferences: {
      get pageWidth() { throw new Error('dimension read failed'); },
      pageHeight: 297,
    },
    marginPreferences: {},
  };
  await withMockUXP(document, async () => {
    const response = await DocumentHandlers.getDocumentInfo();
    assert.equal(response.success, false);
    assert.match(response.result, /dimension read failed/);
    assert.equal(viewPreferences.horizontalMeasurementUnits, 'inches');
    assert.equal(viewPreferences.verticalMeasurementUnits, 'picas');
  }, { MeasurementUnits: { millimeters: 'mm' } });
});
