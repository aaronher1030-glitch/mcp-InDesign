/**
 * High-level, skill-aware tools. These wrap the low-level handlers with
 * inspection, planning, risk approval, execution and verification.
 */
export const skillToolDefinitions = [
    {
        name: 'inspect_layout',
        description: 'Capture a read-only snapshot of the open document: pages, page items, styles, colors, layers, and validation issues. Returns the inspectionId and document fingerprint used by plan_edit.',
        inputSchema: {
            type: 'object',
            properties: {
                pageRange: { type: 'string', description: 'all, 3, 1-5, or 1,3,5-7', default: 'all' },
                targetDescription: { type: 'string', description: 'Optional description of what the user wants to change' },
            },
        },
    },
    {
        name: 'plan_edit',
        description: 'Validate and version a structured edit plan authored from an inspection. Low-risk plans are ready to apply; high-risk plans return status "approval_required" with a summary.',
        inputSchema: {
            type: 'object',
            properties: {
                inspectionId: { type: 'string', description: 'inspectionId returned by inspect_layout' },
                skillId: {
                    type: 'string',
                    enum: [
                        'safe-layout-edit',
                        'text-typography-edit',
                        'align-distribute',
                        'image-reframe',
                        'style-consistency',
                        'multi-page-consistency',
                    ],
                },
                plan: {
                    type: 'object',
                    properties: {
                        targets: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    pageIndex: { type: 'integer' },
                                    itemIndex: { type: 'integer' },
                                    name: { type: 'string' },
                                    before: { type: 'object' },
                                },
                                required: ['pageIndex', 'before'],
                            },
                        },
                        steps: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    toolName: { type: 'string' },
                                    arguments: { type: 'object' },
                                    targetFingerprint: { type: 'string' },
                                    expectedResult: { type: 'object' },
                                },
                                required: ['toolName', 'arguments'],
                            },
                        },
                        affectedPages: { type: 'array', items: { type: 'integer' } },
                        expectedChanges: { type: 'array', items: { type: 'string' } },
                        qualityCriteria: { type: 'array', items: { type: 'string' } },
                        constraints: { type: 'object' },
                    },
                    required: ['targets', 'steps'],
                },
            },
            required: ['inspectionId', 'skillId', 'plan'],
        },
    },
    {
        name: 'apply_edit_plan',
        description: 'Revalidate and execute a planned edit. Low-risk plans apply automatically. High-risk plans require server-mediated human elicitation of the exact version, affected pages, and complete before-artifact paths; caller-supplied approval is never accepted. Failed steps are rolled back from the edit journal or guarded backup.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                expectedVersion: {
                    type: 'integer',
                    minimum: 1,
                    description: 'Exact plan version shown to the human. Required for high-risk calls; optional for low-risk calls, but must match when supplied.',
                },
            },
            required: ['planId'],
            additionalProperties: false,
        },
    },
    {
        name: 'verify_layout',
        description: 'Run structural checks on an applied plan and, when a review or vision model is available, a visual review. Returns verified, failed, or structurally_checked_only.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                visualReview: { type: 'object', description: 'Optional client-authored review: pass, scores, findings, unintendedChanges' },
            },
            required: ['planId'],
        },
    },
    {
        name: 'rollback_edit',
        description: 'Undo an applied plan: reverses the edit journal for low-risk work, or restores the guarded backup for high-risk work when the document has not changed since.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                reason: { type: 'string' },
            },
            required: ['planId'],
        },
    },
    {
        name: 'preview_layout',
        description: 'Direct view: render pages of the open document as PNG images and open the first one in the system image viewer. Use this to show the user exactly what the layout looks like.',
        inputSchema: {
            type: 'object',
            properties: {
                pages: { type: 'array', items: { type: 'integer' }, description: 'Zero-based page indexes', default: [0] },
                open: { type: 'boolean', description: 'Open the first render in the system viewer', default: true },
            },
        },
    },
    {
        name: 'list_skills',
        description: 'List the portable InDesign skills with their triggers, allowed tools, and risk level.',
        inputSchema: { type: 'object', properties: {} },
    },
];
