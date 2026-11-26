/**
 * Export tool definitions for InDesign MCP Server
 * Export, packaging, and production functionality
 */

export const exportToolDefinitions = [
    // =================== EXPORT MANAGEMENT ===================
    {
        name: 'export_pdf',
        description: 'Export document to PDF',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Output PDF file path' },
                quality: { type: 'string', enum: ['PRESS', 'PRINT', 'SCREEN', 'DIGITAL'], default: 'PRINT' },
                includeMarks: { type: 'boolean', description: 'Include printer marks', default: false },
                includeBleed: { type: 'boolean', description: 'Include bleed', default: false },
                pages: { type: 'string', description: 'Page range (e.g., "1-5", "all")', default: 'all' },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'export_images',
        description: 'Export selected pages as PNG, JPEG, or TIFF images',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: { type: 'string', description: 'Existing output directory' },
                format: { type: 'string', enum: ['PNG', 'JPEG', 'TIFF'], default: 'PNG' },
                resolution: { type: 'number', description: 'Resolution in DPI', default: 144 },
                pages: { type: 'string', description: 'all, 3, 1-5, or 1,3,5-7', default: 'all' },
                quality: { type: 'number', description: 'JPEG quality 1-100', default: 90 },
            },
            required: ['outputPath'],
        },
    },
    {
        name: 'export_epub',
        description: 'Export document to EPUB',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Output EPUB file path' },
                includeImages: { type: 'boolean', description: 'Include images', default: true },
                includeStyles: { type: 'boolean', description: 'Include styles', default: true },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'package_document',
        description: 'Package document for printing',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: { type: 'string', description: 'Output directory path' },
                includeFonts: { type: 'boolean', description: 'Include fonts', default: true },
                includeLinks: { type: 'boolean', description: 'Include linked files', default: true },
                includeProfiles: { type: 'boolean', description: 'Include color profiles', default: true },
            },
            required: ['outputPath'],
        },
    },
]; 