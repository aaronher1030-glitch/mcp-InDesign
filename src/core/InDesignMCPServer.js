/**
 * Main InDesign MCP Server class
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { allToolDefinitions } from '../types/index.js';
import { SkillRuntime } from '../skills/runtime.js';
import { getSkill } from '../skills/registry.js';
import {
    EDIT_LIFECYCLE_MARKDOWN,
    QUALITY_RUBRIC_MARKDOWN,
    PROMPT_TO_SKILL,
    SKILL_PROMPT_NAMES,
} from '../skills/protocol.js';
import { previewLayout } from '../quality/pageRenderer.js';
import { MCP_SERVER_NAME, APP_VERSION } from '../version.js';
import {
    BookHandlers,
    DocumentHandlers,
    ExportHandlers,
    GraphicsHandlers,
    GroupHandlers,
    HelpHandlers,
    MasterSpreadHandlers,
    PageHandlers,
    PageItemHandlers,
    StyleHandlers,
    TextHandlers,
    UtilityHandlers
} from '../handlers/index.js';
import { formatResponse, formatErrorResponse } from '../utils/stringUtils.js';

export class InDesignMCPServer {
    constructor(options = {}) {
        this.callToolOverride = typeof options.callTool === 'function' ? options.callTool : null;
        this.server = new Server(
            {
                name: MCP_SERVER_NAME,
                version: APP_VERSION,
            },
            {
                capabilities: {
                    tools: {},
                    prompts: {},
                    resources: {},
                    elicitation: {},
                },
            }
        );

        this.runtime = new SkillRuntime({
            callTool: this.callToolOverride
                ?? ((name, args) => this.handleLowLevelTool(name, args)),
            artifactDir: options.artifactDir,
        });
        this.runtime.callTool = this.callToolOverride
            ?? ((name, args) => this.handleLowLevelTool(name, args));
        this.elicitInput = typeof options.elicitInput === 'function'
            ? options.elicitInput
            : (params) => this.server.elicitInput(params);

        this.setupToolHandlers();
    }

    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: allToolDefinitions,
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                const result = await this.handleToolCall(name, args, {});
                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                    ...(result && result.success === false ? { isError: true } : {}),
                };
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            code: error.code || 'TOOL_ERROR',
                            error: error.message || String(error),
                            result: error.result ?? undefined,
                        }, null, 2),
                    }],
                    isError: true,
                };
            }
        });

        this.server.setRequestHandler(ListPromptsRequestSchema, async () => this.listPrompts());
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => (
            this.getPrompt(request.params.name, request.params.arguments || {})
        ));
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => this.listResources());
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => (
            this.readResource(request.params.uri)
        ));
    }

    async listPrompts() {
        return {
            prompts: SKILL_PROMPT_NAMES.map((name) => ({
                name,
                description: `Run the ${PROMPT_TO_SKILL[name]} skill with the portable inspect-plan-apply-verify workflow.`,
                arguments: [
                    { name: 'request', description: 'What the user wants changed', required: true },
                    { name: 'pageRange', description: 'all, 3, 1-5, or 1,3,5-7', required: false },
                ],
            })),
        };
    }

    async getPrompt(name, args = {}) {
        const skillId = PROMPT_TO_SKILL[name];
        if (!skillId) throw new Error(`Unknown prompt: ${name}`);
        const skill = await getSkill(skillId);
        const request = String(args.request || '').trim() || skill.examples[0];
        const pageRange = String(args.pageRange || 'all');
        const text = [
            skill.content,
            '## Shared edit protocol',
            EDIT_LIFECYCLE_MARKDOWN,
            '## Quality rubric',
            QUALITY_RUBRIC_MARKDOWN,
            '## This request',
            `Request: ${request}`,
            `Page range: ${pageRange}`,
            'Start by calling `inspect_layout` for that page range.',
        ].join('\n\n');
        return {
            description: skill.summary,
            messages: [{ role: 'user', content: { type: 'text', text } }],
        };
    }

    async listResources() {
        const resources = SKILL_PROMPT_NAMES.map((promptName) => {
            const id = PROMPT_TO_SKILL[promptName];
            return {
                uri: `indesign://skills/${id}`,
                name: `Skill: ${id}`,
                description: `Portable instructions for the ${id} skill`,
                mimeType: 'text/markdown',
            };
        });
        resources.push(
            {
                uri: 'indesign://protocol/edit-lifecycle',
                name: 'Edit lifecycle',
                description: 'Plan, approval, verification and rollback contract',
                mimeType: 'text/markdown',
            },
            {
                uri: 'indesign://quality/rubric',
                name: 'Quality rubric',
                description: 'Structural and visual acceptance criteria',
                mimeType: 'text/markdown',
            },
        );
        return { resources };
    }

    async readResource(uri) {
        if (uri === 'indesign://protocol/edit-lifecycle') {
            return { contents: [{ uri, mimeType: 'text/markdown', text: EDIT_LIFECYCLE_MARKDOWN }] };
        }
        if (uri === 'indesign://quality/rubric') {
            return { contents: [{ uri, mimeType: 'text/markdown', text: QUALITY_RUBRIC_MARKDOWN }] };
        }
        const match = /^indesign:\/\/skills\/([a-z0-9-]+)$/.exec(uri);
        if (!match) throw new Error(`Unknown resource: ${uri}`);
        const skill = await getSkill(match[1]);
        return { contents: [{ uri, mimeType: 'text/markdown', text: skill.content }] };
    }

    async handleToolCall(name, args, context = {}) {
        switch (name) {
            case 'inspect_layout': {
                const inspection = await this.runtime.createInspection(args || {});
                return { success: true, operation: 'Inspect Layout', result: inspection };
            }
            case 'plan_edit': {
                const plan = await this.runtime.createPlan(args || {});
                return { success: true, operation: 'Plan Edit', result: plan };
            }
            case 'apply_edit_plan': {
                return this.applyEditPlan(args, context);
            }
            case 'verify_layout': {
                const { planId, visualReview } = args || {};
                const result = await this.runtime.verify({
                    planId,
                    visualReview,
                    settings: context.settings,
                });
                return { success: true, operation: 'Verify Layout', result };
            }
            case 'rollback_edit': {
                const result = await this.runtime.rollbackPlan(args || {});
                return { success: true, operation: 'Rollback Edit', result };
            }
            case 'preview_layout': {
                const { pages = [0], open = true } = args || {};
                const result = await previewLayout({
                    pages,
                    open,
                    callTool: this.runtime.callTool,
                    outputDir: undefined,
                });
                return { success: true, operation: 'Preview Layout', result };
            }
            case 'list_skills': {
                const skills = await this.runtime.listSkills();
                return { success: true, operation: 'List Skills', result: { skills } };
            }
            default:
                return await this.handleLowLevelTool(name, args);
        }
    }

    approvalFailure(status, code, error, details = {}) {
        return {
            success: false,
            operation: 'Apply Edit Plan',
            result: { ...details, status, code, error },
        };
    }

    /**
     * External MCP callers never provide approval. Only this trusted adapter
     * can turn an explicit human elicitation response into a one-time token.
     */
    async applyEditPlan(args = {}, context = {}) {
        const planId = args?.planId;
        const expectedVersion = args?.expectedVersion;
        if (args && typeof args === 'object'
            && (Object.hasOwn(args, 'approved') || Object.hasOwn(args, 'approvalToken'))) {
            return this.approvalFailure(
                'approval_required',
                'APPROVAL_REQUIRED',
                'Caller-supplied approval fields are not accepted. A human must approve the exact plan version through the server approval UI.',
                { planId, version: expectedVersion },
            );
        }

        let view;
        try {
            view = this.runtime.getPlan(planId);
        } catch (error) {
            throw error;
        }

        if (view.plan.risk !== 'high') {
            const applied = await this.runtime.applyPlan({ planId, expectedVersion, signal: context.signal });
            return { success: true, operation: 'Apply Edit Plan', result: applied };
        }

        // Copilot's trusted UI resolves approval outside the MCP transport. The
        // model path uses deferApproval and can never set trustedApproval.
        if (context.trustedApproval === true) {
            const applied = await this.runtime.applyPlan({
                planId,
                expectedVersion,
                approvalToken: args?.approvalToken,
                signal: context.signal,
            });
            return { success: true, operation: 'Apply Edit Plan', result: applied };
        }

        let prepared;
        try {
            prepared = await this.runtime.prepareApproval({ planId, expectedVersion });
        } catch (error) {
            if (error.code === 'APPROVAL_MISMATCH') {
                return this.approvalFailure('approval_mismatch', error.code, error.message, {
                    planId, expectedVersion, version: error.version,
                });
            }
            if (error.code === 'APPROVAL_REQUIRED') {
                return this.approvalFailure('approval_required', error.code, error.message, {
                    planId, expectedVersion, version: view.plan.version,
                    affectedPages: view.plan.affectedPages,
                });
            }
            if (['BEFORE_RENDER_FAILED', 'STALE_PLAN'].includes(error.code)) {
                return this.approvalFailure('approval_unavailable', error.code, error.message, {
                    planId, expectedVersion, version: view.plan.version,
                    affectedPages: view.plan.affectedPages,
                    beforeArtifacts: view.beforeArtifacts?.paths ?? [],
                    beforeArtifactsError: view.beforeArtifacts?.error ?? error.message,
                });
            }
            throw error;
        }

        if (context.deferApproval === true) {
            return {
                success: true,
                operation: 'Apply Edit Plan',
                result: { ...prepared, status: 'approval_required' },
            };
        }

        if (typeof this.elicitInput !== 'function') {
            return this.approvalFailure(
                'approval_unavailable',
                'ELICITATION_UNAVAILABLE',
                'The MCP client does not support human approval elicitation.',
                prepared,
            );
        }

        const artifactsByPage = prepared.beforeArtifactsPageIndexes
            .map((pageIndex, index) => ({ pageIndex, path: prepared.beforeArtifacts[index] }))
            .sort((left, right) => left.pageIndex - right.pageIndex);
        const message = [
            'Approve this high-risk InDesign edit?',
            `Plan ID: ${prepared.planId}`,
            `Exact plan version: ${prepared.version}`,
            `Affected page indexes (zero-based): ${JSON.stringify(prepared.affectedPages)}`,
            `Before-artifact paths by page: ${JSON.stringify(artifactsByPage)}`,
            `Summary: ${prepared.summary}`,
            `Expected changes: ${(prepared.expectedChanges ?? []).join('; ')}`,
            'Nothing will be changed unless you explicitly approve this exact version.',
        ].join('\n');
        let response;
        try {
            response = await this.elicitInput({
                mode: 'form',
                message,
                requestedSchema: {
                    type: 'object',
                    properties: {
                        decision: {
                            type: 'string',
                            title: 'Decision',
                            enum: ['approve', 'decline'],
                            enumNames: ['Approve exact plan version', 'Decline'],
                            default: 'decline',
                        },
                        confirmedVersion: {
                            type: 'integer',
                            title: 'Exact plan version',
                            description: `Enter ${prepared.version} to approve the version displayed above.`,
                            minimum: prepared.version,
                            maximum: prepared.version,
                            default: prepared.version,
                        },
                    },
                    required: ['decision', 'confirmedVersion'],
                },
            });
        } catch (error) {
            return this.approvalFailure(
                'approval_unavailable',
                'ELICITATION_UNAVAILABLE',
                `Human approval elicitation is unavailable: ${error.message || String(error)}`,
                prepared,
            );
        }

        if (response?.action !== 'accept'
            || response?.content?.decision !== 'approve'
            || response?.content?.confirmedVersion !== prepared.version) {
            return this.approvalFailure(
                'approval_declined',
                'APPROVAL_DECLINED',
                'The human did not explicitly approve the exact displayed plan version. Nothing was changed.',
                prepared,
            );
        }

        let approvalToken;
        try {
            approvalToken = this.runtime.issueApprovalCapability({
                planId: prepared.planId,
                expectedVersion: prepared.version,
            }).approvalToken;
            const applied = await this.runtime.applyPlan({
                planId: prepared.planId,
                expectedVersion: prepared.version,
                approvalToken,
                signal: context.signal,
            });
            return { success: true, operation: 'Apply Edit Plan', result: applied };
        } catch (error) {
            if (error.code === 'APPROVAL_MISMATCH') {
                return this.approvalFailure('approval_mismatch', error.code, error.message, {
                    planId: prepared.planId, expectedVersion: prepared.version, version: error.version,
                });
            }
            if (error.code === 'BEFORE_RENDER_FAILED') {
                return this.approvalFailure('approval_unavailable', error.code, error.message, {
                    planId: prepared.planId,
                    expectedVersion: prepared.version,
                    version: prepared.version,
                    affectedPages: prepared.affectedPages,
                    beforeArtifacts: error.artifactPaths ?? [],
                    beforeArtifactsError: error.renderError ?? error.message,
                });
            }
            throw error;
        }
    }

    async handleLowLevelTool(name, args) {
        // Document Management
        switch (name) {
            case 'get_document_info': return await DocumentHandlers.getDocumentInfo();
            case 'create_document': return await DocumentHandlers.createDocument(args);
            case 'open_document': return await DocumentHandlers.openDocument(args);
            case 'save_document': return await DocumentHandlers.saveDocument(args);
            case 'close_document': return await DocumentHandlers.closeDocument(args);

            // Document Advanced Tools
            case 'preflight_document': return await DocumentHandlers.preflightDocument(args);
            case 'zoom_to_page': return await DocumentHandlers.zoomToPage(args);
            case 'data_merge': return await DocumentHandlers.dataMerge(args);

            // Document Elements & Styles
            case 'get_document_elements': return await DocumentHandlers.getDocumentElements(args);
            case 'get_document_styles': return await DocumentHandlers.getDocumentStyles(args);
            case 'get_document_colors': return await DocumentHandlers.getDocumentColors(args);

            // Document Preferences
            case 'get_document_preferences': return await DocumentHandlers.getDocumentPreferences(args);
            case 'set_document_preferences': return await DocumentHandlers.setDocumentPreferences(args);

            // Document Stories & Text
            case 'get_document_stories': return await DocumentHandlers.getDocumentStories(args);
            case 'find_text_in_document': return await DocumentHandlers.findTextInDocument(args);

            // Document Layers & Organization
            case 'get_document_layers': return await DocumentHandlers.getDocumentLayers(args);
            case 'organize_document_layers': return await DocumentHandlers.organizeDocumentLayers(args);

            // Document Hyperlinks & Interactivity
            case 'get_document_hyperlinks': return await DocumentHandlers.getDocumentHyperlinks(args);
            case 'create_document_hyperlink': return await DocumentHandlers.createDocumentHyperlink(args);

            // Document Sections & Numbering
            case 'get_document_sections': return await DocumentHandlers.getDocumentSections();
            case 'create_document_section': return await DocumentHandlers.createDocumentSection(args);

            // Document XML & Structure
            case 'get_document_xml_structure': return await DocumentHandlers.getDocumentXmlStructure(args);
            case 'export_document_xml': return await DocumentHandlers.exportDocumentXml(args);

            // Document Cloud & Collaboration
            case 'save_document_to_cloud': return await DocumentHandlers.saveDocumentToCloud(args);
            case 'open_cloud_document': return await DocumentHandlers.openCloudDocument(args);

            // Document Grid & Layout
            case 'get_document_grid_settings': return await DocumentHandlers.getDocumentGridSettings();
            case 'set_document_grid_settings': return await DocumentHandlers.setDocumentGridSettings(args);
            case 'get_document_layout_preferences': return await DocumentHandlers.getDocumentLayoutPreferences();
            case 'set_document_layout_preferences': return await DocumentHandlers.setDocumentLayoutPreferences(args);

            // Document Validation & Cleanup
            case 'validate_document': return await DocumentHandlers.validateDocument(args);
            case 'cleanup_document': return await DocumentHandlers.cleanupDocument(args);

            // Page Management
            case 'add_page': return await PageHandlers.addPage(args);
            case 'get_page_info': return await PageHandlers.getPageInfo(args);
            case 'navigate_to_page': return await PageHandlers.navigateToPage(args);

            // Advanced Page Management
            case 'duplicate_page': return await PageHandlers.duplicatePage(args);
            case 'move_page': return await PageHandlers.movePage(args);
            case 'delete_page': return await PageHandlers.deletePage(args);
            case 'set_page_properties': return await PageHandlers.setPageProperties(args);
            case 'set_page_background': return await PageHandlers.setPageBackground(args);
            case 'adjust_page_layout': return await PageHandlers.adjustPageLayout(args);
            case 'resize_page': return await PageHandlers.resizePage(args);
            case 'create_page_guides': return await PageHandlers.createPageGuides(args);
            case 'place_file_on_page': return await PageHandlers.placeFileOnPage(args);
            case 'place_xml_on_page': return await PageHandlers.placeXmlOnPage(args);
            case 'snapshot_page_layout': return await PageHandlers.snapshotPageLayout(args);
            case 'delete_page_layout_snapshot': return await PageHandlers.deletePageLayoutSnapshot(args);
            case 'delete_all_page_layout_snapshots': return await PageHandlers.deleteAllPageLayoutSnapshots(args);
            case 'reframe_page': return await PageHandlers.reframePage(args);
            case 'select_page': return await PageHandlers.selectPage(args);
            case 'get_page_content_summary': return await PageHandlers.getPageContentSummary(args);

            // Text Management
            case 'create_text_frame': return await TextHandlers.createTextFrame(args);
            case 'edit_text_frame': return await TextHandlers.editTextFrame(args);
            case 'create_table': return await TextHandlers.createTable(args);
            case 'populate_table': return await TextHandlers.populateTable(args);
            case 'find_replace_text': return await TextHandlers.findReplaceText(args);

            // Graphics Management
            case 'create_rectangle': return await GraphicsHandlers.createRectangle(args);
            case 'create_ellipse': return await GraphicsHandlers.createEllipse(args);
            case 'create_polygon': return await GraphicsHandlers.createPolygon(args);
            case 'place_image': return await GraphicsHandlers.placeImage(args);
            case 'create_object_style': return await GraphicsHandlers.createObjectStyle(args);
            case 'list_object_styles': return await GraphicsHandlers.listObjectStyles();
            case 'apply_object_style': return await GraphicsHandlers.applyObjectStyle(args);
            case 'get_image_info': return await GraphicsHandlers.getImageInfo(args);

            // Style Management
            case 'create_paragraph_style': return await StyleHandlers.createParagraphStyle(args);
            case 'create_character_style': return await StyleHandlers.createCharacterStyle(args);
            case 'apply_paragraph_style': return await StyleHandlers.applyParagraphStyle(args);
            case 'apply_character_style': return await StyleHandlers.applyCharacterStyle(args);
            case 'apply_color': return await StyleHandlers.applyColor(args);
            case 'create_color_swatch': return await StyleHandlers.createColorSwatch(args);
            case 'list_styles': return await StyleHandlers.listStyles(args);
            case 'list_color_swatches': return await StyleHandlers.listColorSwatches();

            // Export Functions
            case 'export_pdf': return await ExportHandlers.exportPDF(args);
            case 'export_images': return await ExportHandlers.exportImages(args);
            case 'package_document': return await ExportHandlers.packageDocument(args);

            // Master Spread Management
            case 'create_master_spread': return await MasterSpreadHandlers.createMasterSpread(args);
            case 'list_master_spreads': return await MasterSpreadHandlers.listMasterSpreads(args);
            case 'delete_master_spread': return await MasterSpreadHandlers.deleteMasterSpread(args);
            case 'duplicate_master_spread': return await MasterSpreadHandlers.duplicateMasterSpread(args);
            case 'apply_master_spread': return await MasterSpreadHandlers.applyMasterSpread(args);
            case 'create_master_text_frame': return await MasterSpreadHandlers.createMasterTextFrame(args);
            case 'create_master_rectangle': return await MasterSpreadHandlers.createMasterRectangle(args);
            case 'create_master_guides': return await MasterSpreadHandlers.createMasterGuides(args);
            case 'get_master_spread_info': return await MasterSpreadHandlers.getMasterSpreadInfo(args);

            // Book Management
            case 'create_book': return await BookHandlers.createBook(args);
            case 'open_book': return await BookHandlers.openBook(args);
            case 'list_books': return await BookHandlers.listBooks(args);
            case 'add_document_to_book': return await BookHandlers.addDocumentToBook(args);
            case 'synchronize_book': return await BookHandlers.synchronizeBook(args);
            case 'repaginate_book': return await BookHandlers.repaginateBook(args);
            case 'update_all_cross_references': return await BookHandlers.updateAllCrossReferences(args);
            case 'update_all_numbers': return await BookHandlers.updateAllNumbers(args);
            case 'update_chapter_and_paragraph_numbers': return await BookHandlers.updateChapterAndParagraphNumbers(args);
            case 'export_book': return await BookHandlers.exportBook(args);
            case 'package_book': return await BookHandlers.packageBook(args);
            case 'preflight_book': return await BookHandlers.preflightBook(args);
            case 'print_book': return await BookHandlers.printBook(args);
            case 'get_book_info': return await BookHandlers.getBookInfo(args);
            case 'set_book_properties': return await BookHandlers.setBookProperties(args);

            // PageItem Management
            case 'get_page_item_info': return await PageItemHandlers.getPageItemInfo(args);
            case 'select_page_item': return await PageItemHandlers.selectPageItem(args);
            case 'move_page_item': return await PageItemHandlers.movePageItem(args);
            case 'resize_page_item': return await PageItemHandlers.resizePageItem(args);
            case 'set_page_item_properties': return await PageItemHandlers.setPageItemProperties(args);
            case 'duplicate_page_item': return await PageItemHandlers.duplicatePageItem(args);
            case 'delete_page_item': return await PageItemHandlers.deletePageItem(args);
            case 'list_page_items': return await PageItemHandlers.listPageItems(args);

            // Group Management
            case 'create_group': return await GroupHandlers.createGroup(args);
            case 'create_group_from_items': return await GroupHandlers.createGroupFromItems(args);
            case 'ungroup': return await GroupHandlers.ungroup(args);
            case 'get_group_info': return await GroupHandlers.getGroupInfo(args);
            case 'add_item_to_group': return await GroupHandlers.addItemToGroup(args);
            case 'remove_item_from_group': return await GroupHandlers.removeItemFromGroup(args);
            case 'list_groups': return await GroupHandlers.listGroups(args);
            case 'set_group_properties': return await GroupHandlers.setGroupProperties(args);

            // Utility Functions
            case 'execute_indesign_code': return await UtilityHandlers.executeInDesignCode(args);
            case 'view_document': return await UtilityHandlers.viewDocument();
            case 'get_session_info': return await UtilityHandlers.getSessionInfo();
            case 'clear_session': return await UtilityHandlers.clearSession();

            // Help System
            case 'help': return await HelpHandlers.getHelp(args);

            // Add more handlers as we create them
            default:
                return formatErrorResponse(`Tool '${name}' not found or not implemented. Use 'help' to see available tools.`, "Tool Call");
        }
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`[MCP] ${MCP_SERVER_NAME} v${APP_VERSION} ready (stdio)`);
        // Don't log to stdout as it interferes with MCP protocol
        // console.log('InDesign MCP Server started');
    }
} 