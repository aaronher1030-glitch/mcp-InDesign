/**
 * PageItem management handlers
 */
import { ScriptExecutor } from '../core/scriptExecutor.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';
import { colorResolverSnippet } from '../utils/colorUtils.js';

export class PageItemHandlers {
    /**
     * Get information about a page item
     */
    static async getPageItemInfo(args) {
        const { pageIndex, itemIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${itemIndex} < 0 || ${itemIndex} >= (page.allPageItems ? page.allPageItems.length : 0)) return { success: false, error: 'Page item index out of range' };
            const item = page.allPageItems[${itemIndex}];
            let type = 'Unknown';
            try { type = item.constructor?.name || 'Unknown'; } catch(e) {}
            let fillColorName = 'None';
            let strokeColorName = 'None';
            try { fillColorName = item.fillColor ? item.fillColor.name : 'None'; } catch(e) {}
            try { strokeColorName = item.strokeColor ? item.strokeColor.name : 'None'; } catch(e) {}
            let strokeWeight = 0;
            try { strokeWeight = item.strokeWeight; } catch(e) {}
            return {
                success: true,
                type,
                name: item.name || 'Unnamed',
                id: item.id,
                visible: item.visible,
                locked: item.locked,
                geometricBounds: item.geometricBounds,
                fillColorName,
                strokeColorName,
                strokeWeight
            };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Get Page Item Info")
            : formatErrorResponse(result?.error || 'Failed to get page item info', "Get Page Item Info");
    }

    /**
     * Select a page item
     */
    static async selectPageItem(args) {
        const { pageIndex, itemIndex, existingSelection = 'REPLACE_WITH' } = args;

        const selectionMap = {
            REPLACE_WITH: 'replaceWith',
            ADD_TO: 'addTo'
        };
        const uxpSelection = selectionMap[existingSelection] || 'replaceWith';

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${itemIndex} < 0 || ${itemIndex} >= (page.allPageItems ? page.allPageItems.length : 0)) return { success: false, error: 'Page item index out of range' };
            const { SelectionOptions } = require('indesign');
            const item = page.allPageItems[${itemIndex}];
            item.select(SelectionOptions[${JSON.stringify(uxpSelection)}]);
            return { success: true, id: item.id };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Select Page Item")
            : formatErrorResponse(result?.error || 'Failed to select page item', "Select Page Item");
    }

    /**
     * Move a page item
     */
    static async movePageItem(args) {
        const { pageIndex, itemIndex, x, y } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${itemIndex} < 0 || ${itemIndex} >= (page.allPageItems ? page.allPageItems.length : 0)) return { success: false, error: 'Page item index out of range' };
            const item = page.allPageItems[${itemIndex}];
            item.move([${x}, ${y}]);
            return { success: true, id: item.id, geometricBounds: item.geometricBounds };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Move Page Item")
            : formatErrorResponse(result?.error || 'Failed to move page item', "Move Page Item");
    }

    /**
     * Resize a page item
     */
    static async resizePageItem(args) {
        const { pageIndex, itemIndex, width, height, anchorPoint = 'CENTER_ANCHOR' } = args;

        const anchorMap = {
            CENTER_ANCHOR: 'centerAnchor',
            TOP_LEFT_ANCHOR: 'topLeftAnchor',
            TOP_CENTER_ANCHOR: 'topCenterAnchor',
            TOP_RIGHT_ANCHOR: 'topRightAnchor',
            LEFT_CENTER_ANCHOR: 'leftCenterAnchor',
            RIGHT_CENTER_ANCHOR: 'rightCenterAnchor',
            BOTTOM_LEFT_ANCHOR: 'bottomLeftAnchor',
            BOTTOM_CENTER_ANCHOR: 'bottomCenterAnchor',
            BOTTOM_RIGHT_ANCHOR: 'bottomRightAnchor'
        };
        const uxpAnchor = anchorMap[anchorPoint] || 'centerAnchor';

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${itemIndex} < 0 || ${itemIndex} >= (page.allPageItems ? page.allPageItems.length : 0)) return { success: false, error: 'Page item index out of range' };
            const { CoordinateSpaces, AnchorPoint, ResizeMethods } = require('indesign');
            const item = page.allPageItems[${itemIndex}];
            item.resize(CoordinateSpaces.pasteboardCoordinates, AnchorPoint.${uxpAnchor}, ResizeMethods.replacingCurrentDimensionsWith, [${width}, ${height}]);
            return { success: true, id: item.id, geometricBounds: item.geometricBounds };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Resize Page Item")
            : formatErrorResponse(result?.error || 'Failed to resize page item', "Resize Page Item");
    }

    /**
     * Set page item properties
     */
    static async setPageItemProperties(args) {
        const { pageIndex, itemIndex, fillColor, strokeColor, strokeWeight, visible, locked } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${itemIndex} < 0 || ${itemIndex} >= (page.allPageItems ? page.allPageItems.length : 0)) return { success: false, error: 'Page item index out of range' };
            const item = page.allPageItems[${itemIndex}];
            ${fillColor != null ? colorResolverSnippet('_fillColor', fillColor) : ''}
            ${fillColor != null ? 'if (_fillColor) item.fillColor = _fillColor;' : ''}
            ${strokeColor != null ? colorResolverSnippet('_strokeColor', strokeColor) : ''}
            ${strokeColor != null ? 'if (_strokeColor) item.strokeColor = _strokeColor;' : ''}
            if (${strokeWeight} !== null && ${strokeWeight} !== undefined) {
                item.strokeWeight = ${strokeWeight};
            }
            if (${visible} !== null && ${visible} !== undefined) {
                item.visible = ${visible};
            }
            if (${locked} !== null && ${locked} !== undefined) {
                item.locked = ${locked};
            }
            return { success: true, id: item.id };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Set Page Item Properties")
            : formatErrorResponse(result?.error || 'Failed to set page item properties', "Set Page Item Properties");
    }

    /**
     * Duplicate a page item
     */
    static async duplicatePageItem(args) {
        const { pageIndex, itemIndex, x, y } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${itemIndex} < 0 || ${itemIndex} >= (page.allPageItems ? page.allPageItems.length : 0)) return { success: false, error: 'Page item index out of range' };
            const item = page.allPageItems[${itemIndex}];
            const newItem = item.duplicate();
            newItem.move([${x}, ${y}]);
            return { success: true, id: newItem.id, geometricBounds: newItem.geometricBounds };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Duplicate Page Item")
            : formatErrorResponse(result?.error || 'Failed to duplicate page item', "Duplicate Page Item");
    }

    /**
     * Delete a page item
     */
    static async deletePageItem(args) {
        const { pageIndex, itemIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            if (${itemIndex} < 0 || ${itemIndex} >= (page.allPageItems ? page.allPageItems.length : 0)) return { success: false, error: 'Page item index out of range' };
            const item = page.allPageItems[${itemIndex}];
            const id = item.id;
            item.remove();
            return { success: true, deletedId: id };
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "Delete Page Item")
            : formatErrorResponse(result?.error || 'Failed to delete page item', "Delete Page Item");
    }

    /**
     * List all page items on a page
     */
    static async listPageItems(args) {
        const { pageIndex } = args;

        const code = `
            if (app.documents.length === 0) return { success: false, error: 'No document open' };
            const doc = app.activeDocument;
            if (${pageIndex} < 0 || ${pageIndex} >= doc.pages.length) return { success: false, error: 'Page index out of range' };
            const page = doc.pages.item(${pageIndex});
            const { MeasurementUnits } = require('indesign');
            const savedH = doc.viewPreferences.horizontalMeasurementUnits;
            const savedV = doc.viewPreferences.verticalMeasurementUnits;
            try {
                doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.points;
                doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.points;
                const items = [];
                const safeGet = (fn, fallback = null) => { try { return fn(); } catch (e) { return fallback; } };
            const uniquePush = (values, value) => {
                if (value !== null && value !== undefined && !values.includes(value)) values.push(value);
            };
            const propertyName = (value) => {
                if (typeof value === 'string') return value;
                if (value && typeof value === 'object') return value.name ?? null;
                return null;
            };
            const collectionLength = (value) => {
                if (!value || !Number.isInteger(value.length) || value.length < 0) {
                    throw new Error('Page item collection is unavailable');
                }
                return value.length;
            };
            const collectionItem = (value, index) => Array.isArray(value) ? value[index] : value.item(index);
            const sameObject = (left, right) => left === right || (
                left && right && left.id !== undefined && right.id !== undefined && left.id === right.id
            );
            for (let i = 0; i < (page.allPageItems ? page.allPageItems.length : 0); i++) {
                const item = page.allPageItems[i];
                let type = 'Unknown';
                try { type = item.constructor?.name || 'Unknown'; } catch(e) {}
                const isText = type === 'TextFrame' || safeGet(() => item.texts) != null;
                let overset = null;
                let textInspection = { status: 'not_applicable' };
                let textFormatting = { status: 'not_applicable' };
                if (isText) {
                    try {
                        const value = item.overflows;
                        if (typeof value !== 'boolean') throw new Error('TextFrame.overflows is unavailable');
                        overset = value;
                        textInspection = { status: 'known' };
                    } catch (e) {
                        textInspection = { status: 'unknown', reason: e.message };
                    }
                    try {
                        const fontNames = [];
                        const pointSizes = [];
                        const justifications = [];
                        const fillColors = [];
                        const paragraphStyles = [];
                        const characterStyles = [];
                        const ranges = item.textStyleRanges;
                        for (let r = 0; r < ranges.length; r++) {
                            const range = ranges.item(r);
                            uniquePush(fontNames, propertyName(range.appliedFont));
                            uniquePush(pointSizes, range.pointSize);
                            uniquePush(justifications, String(range.justification));
                            uniquePush(fillColors, propertyName(range.fillColor));
                            uniquePush(paragraphStyles, propertyName(range.appliedParagraphStyle));
                            uniquePush(characterStyles, propertyName(range.appliedCharacterStyle));
                        }
                        textFormatting = {
                            status: 'known', fontNames, pointSizes, justifications,
                            fillColors, paragraphStyles, characterStyles
                        };
                    } catch (e) {
                        textFormatting = { status: 'unknown', reason: e.message };
                    }
                }
                let inheritedMasterContent = null;
                let masterContentInspection = { status: 'unknown', reason: 'Master origin is unavailable' };
                let masterName = null;
                try {
                    const master = page.appliedMaster;
                    masterName = master ? master.name : null;
                    const masterItems = page.masterPageItems;
                    if (masterItems !== undefined && masterItems !== null) {
                        const containsMasterItem = (candidate) => {
                            const length = collectionLength(masterItems);
                            for (let m = 0; m < length; m++) {
                                if (sameObject(collectionItem(masterItems, m), candidate)) return true;
                            }
                            return false;
                        };
                        inheritedMasterContent = containsMasterItem(item);
                        if (!inheritedMasterContent) {
                            // Some UXP responses list an inherited Group rather than
                            // each child. Only an unoverridden child of that listed
                            // group inherits the master origin.
                            let ancestor = item.parent;
                            const seen = new Set();
                            while (ancestor && ancestor.constructor?.name === 'Group' && !seen.has(ancestor)) {
                                seen.add(ancestor);
                                if (containsMasterItem(ancestor)) {
                                    inheritedMasterContent = item.overridden === false;
                                    break;
                                }
                                ancestor = ancestor.parent;
                            }
                        }
                    } else {
                        // Compatibility for older bridges that do not expose
                        // Page.masterPageItems at all.
                        const parent = item.parent;
                        const sameMaster = !!master && sameObject(parent, master);
                        inheritedMasterContent = sameMaster && item.overridden === false;
                    }
                    masterContentInspection = { status: 'known' };
                } catch (e) {
                    masterContentInspection = { status: 'unknown', reason: e.message };
                }
                items.push({
                    index: i,
                    type,
                    name: item.name || 'Unnamed',
                    id: item.id,
                    visible: item.visible,
                    locked: item.locked,
                    geometricBounds: item.geometricBounds,
                    fillColorName: safeGet(() => item.fillColor ? item.fillColor.name : 'None'),
                    strokeColorName: safeGet(() => item.strokeColor ? item.strokeColor.name : 'None'),
                    strokeWeight: safeGet(() => item.strokeWeight),
                    inheritedMasterContent,
                    masterName,
                    masterContentInspection,
                    overset,
                    textInspection,
                    textFormatting,
                    ...(isText ? { contents: safeGet(() => item.contents) } : {})
                });
            }
                return { success: true, items, count: items.length, pageIndex: ${pageIndex}, geometricBoundsUnit: 'pt' };
            } finally {
                try {
                    doc.viewPreferences.horizontalMeasurementUnits = savedH;
                } finally {
                    doc.viewPreferences.verticalMeasurementUnits = savedV;
                }
            }
        `;

        const result = await ScriptExecutor.executeViaUXP(code);
        return result?.success
            ? formatResponse(result, "List Page Items")
            : formatErrorResponse(result?.error || 'Failed to list page items', "List Page Items");
    }
}
