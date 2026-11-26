# InDesign Portable Skill Runtime — Design

**Date:** 2026-11-25**Status:** Accepted for specification review**Primary outcome:** Precise, safe edits to existing Adobe InDesign documents**Clients:** InDesign Copilot panel and external MCP clients

## 1. Problem Statement

The existing project already provides a Node.js MCP server, a UXP plugin inside InDesign, an HTTP/WebSocket bridge, an embedded chat panel, and 135 low-level tools. The server currently advertises only the `tools` capability. Its chat agent receives all tool definitions and a short system prompt, then performs model-directed tool calls for up to 12 rounds.

This is sufficient for simple commands but not for reliably precise editing. The current implementation has no portable skill definitions, no enforced edit plan, no risk-based approval gate, no before/after visual review, no structural quality gate, and no rollback workflow. The model must invent the entire editing procedure on every turn.

There is also a concrete defect in the visual-verification path: the `export_images` schema advertises `outputPath` and `pages`, while the handler reads `folderPath` and `pageRange`. The schema documents ranges such as `1-5`, but the handler only accepts comma-separated positive integers. Visual verification cannot be built on that contract until it is corrected.

## 2. Goals

1. Provide a portable skill layer that works in both the InDesign Copilot panel and external MCP clients.
2. Make precise existing-document edits the first-class workflow.
3. Inspect before editing and revalidate targets immediately before mutation.
4. Automate small reversible edits while requiring explicit approval for high-risk work.
5. Verify edits with both deterministic structural checks and rendered-page visual review.
6. Record enough before-state information to roll back failed edits.
7. Preserve the existing 135-tool API except for targeted correctness fixes.
8. Keep API keys and user document content within the configured local/model-provider flow.

## 3. Non-Goals

- Replacing the UXP bridge or changing the stdio MCP transport.
- Building a general document-generation platform in the first release.
- Adding new model providers beyond the existing OpenAI-compatible and Anthropic adapters.
- Guaranteeing subjective design taste or replacing a human designer.
- Auto-saving the user's document.
- Allowing model-generated arbitrary UXP code inside the standard skill workflow.
- Adding cloud storage, accounts, telemetry, or remote bridge access.

## 4. Architecture Overview

```text
InDesign Copilot panel                 External MCP client
          |                                      |
          | POST /chat                           | stdio MCP
          v                                      v
     Bridge chat endpoint                 InDesignMCPServer
          |                                      |
          +------------------+-------------------+
                             |
                             v
                    Portable Skill Runtime
          +------------------+-------------------+
          |                  |                   |
     Skill Registry     Edit Orchestrator    Quality Verifier
          |                  |                   |
          |                  +---- Edit Journal --+
          |                                      |
          +------------ existing tool handlers -+
                             |
                             v
                    ScriptExecutor / UXP bridge
                             |
                             v
                       InDesign DOM
```

The UXP plugin remains the only component allowed to mutate InDesign. The skill runtime composes existing handlers into enforceable workflows. It does not bypass the bridge and does not send arbitrary model-authored code to the plugin.

## 5. Components and Responsibilities

### 5.1 `skills/`

A portable, filesystem-based skill catalog. Each skill is a Markdown document with a small JavaScript or JSON metadata manifest. The manifest declares:

- `id`, `name`, `summary`, and `version`
- triggering intents and example requests
- preconditions
- allowed and forbidden tools
- default risk level
- workflow steps
- structural and visual quality criteria
- output requirements

The Markdown body contains the model-facing instructions and examples. The same files back MCP prompts and resources, so guidance cannot drift between clients.

### 5.2 `src/skills/`

The shared runtime:

- `registry.js` loads and validates skill definitions.
- `selector.js` maps a user request to one skill or asks for clarification when ambiguous.
- `planner.js` validates and normalizes a model-authored structured edit plan against an inspection snapshot. It does not call a model; the MCP client or Copilot supplies the plan.
- `riskPolicy.js` classifies plans and enforces approval requirements.
- `orchestrator.js` executes approved plans, maintains the edit journal, and coordinates rollback.
- `editJournal.js` stores before-states, inverse operations, artifacts, and plan status.

### 5.3 `src/quality/`

The verification layer:

- `structuralChecks.js` performs deterministic document checks.
- `pageRenderer.js` renders affected pages through a corrected image-export contract.
- `visualReview.js` sends before/after renders to the configured vision-capable model and validates its structured response.
- `rubric.js` defines the shared visual and structural acceptance criteria.

### 5.4 MCP Server

`src/core/InDesignMCPServer.js` keeps its existing tool registry and adds:

- `prompts/list` and `prompts/get`
- `resources/list` and `resources/read`
- five high-level workflow tools described in Section 7

The existing low-level tools remain available for external clients that need direct control.

### 5.5 Copilot Chat

`src/chat/agent.js` uses the same registry, planner, risk policy, and verifier as the MCP server. For each turn it receives the selected skill instructions and only the relevant low-level tools. High-risk plans produce an approval event that the plugin renders as an Approve/Cancel panel.

### 5.6 UXP Plugin and Bridge

The plugin continues to execute authorized UXP code and return JSON. The bridge continues to serialize DOM mutations. The bridge chat endpoint gains skill-aware events and, when `BRIDGE_TOKEN` is configured, requires the same bearer token as `/execute`.

## 6. Initial Skill Catalog

### 6.1 `safe-layout-edit`

Master workflow for precise edits to an existing document. It orchestrates inspection, planning, risk classification, approval, application, verification, and rollback. It is the default when a request is broadly about changing a layout.

### 6.2 `text-typography-edit`

Edits text frames and typography while preserving story structure and existing styles where possible. Checks include overset text, frame overflow, hierarchy, leading, alignment, widows/orphans, and accidental style duplication.

### 6.3 `align-distribute`

Moves and resizes existing items to page margins, grids, guides, or neighboring objects. Checks include equal gaps, alignment tolerance, page bounds, and unintended movement.

### 6.4 `image-reframe`

Changes image frame geometry, crop, scale, and placement. Checks include aspect ratio, effective resolution, missing links, crop intent, and page bounds.

### 6.5 `style-consistency`

Applies existing paragraph, character, object, and color definitions consistently. It avoids creating duplicate styles or colors unless the plan explicitly requires them.

### 6.6 `multi-page-consistency`

Applies repeated changes across pages or spreads, including folios, masters, and repeated components. This skill is always classified as high risk because index drift and reflow can affect unrelated pages.

## 7. MCP Surface

### 7.1 Prompts

The server exposes one prompt per skill:

- `indesign.safe_layout_edit`
- `indesign.text_typography_edit`
- `indesign.align_distribute`
- `indesign.image_reframe`
- `indesign.style_consistency`
- `indesign.multi_page_consistency`

Each prompt accepts the user's edit request and optional page range. It returns the selected skill instructions plus the required workflow and quality rubric.

### 7.2 Resources

The server exposes:

- `indesign://skills/<skill-id>` — the portable Markdown skill definition
- `indesign://protocol/edit-lifecycle` — the plan, approval, verification, and rollback contract
- `indesign://quality/rubric` — structural and visual acceptance criteria

Resources are read-only snapshots of the same files used by the runtime.

### 7.3 High-Level Tools

#### `inspect_layout`

Input: optional page range and target description.Output: document fingerprint, units, pages/spreads, masters, layers, styles, fonts, links, page-item summaries, structural issues, and before-render artifact paths.

#### `plan_edit`

Input: `inspectionId`, `skillId`, a structured `plan` containing targets, steps, expected changes, and quality criteria, plus optional constraints. The client model authors the plan after reading the selected skill and inspection results; the server validates and stores it.Output: `planId`, selected skill, risk level, normalized targets and steps, expected changes, affected pages, quality criteria, expiration, and status. High-risk plans return `approval_required`.

#### `apply_edit_plan`

Input: `planId`, `approved` boolean, and optional expected plan version.Behavior: revalidates document and target fingerprints, rejects stale or modified plans, enforces approval policy, applies steps sequentially, and returns execution status plus journal ID.

#### `verify_layout`

Input: `planId` and an optional structured `visualReview` authored by the client. Copilot may generate this review with its configured vision model; external MCP clients inspect the returned local before/after artifact paths and submit their own review.Output: structural result, visual result, before/after artifact paths, changed-object summary, quality findings, and final status of `verified`, `failed`, or `structurally_checked_only`.

#### `rollback_edit`

Input: `planId` and optional reason.Behavior: reverses the journal for low-risk edits or restores the guarded backup for high-risk edits. It refuses to overwrite document changes made after the plan was applied.

## 8. Edit Plan Contract

Every plan is a versioned JSON object with these fields:

- `planId`
- `skillId`
- `documentFingerprint`
- `baseRevision`
- `units`
- `risk`
- `targets`
- `steps`
- `affectedPages`
- `expectedChanges`
- `qualityCriteria`
- `beforeArtifacts`
- `expiresAt`
- `status`

Each step contains:

- `id`
- `toolName`
- `arguments`
- `targetFingerprint`
- `expectedResult`
- `reversible`
- `risk`

A target fingerprint combines the available stable document/page/item identity with a content and geometry summary. Immediately before applying each step, the runtime recomputes the fingerprint. A mismatch aborts the plan with `STALE_PLAN`; it never silently applies the step to a different object.

All coordinates in plans carry an explicit unit. Conversion happens at the handler boundary. The runtime does not assume that documented millimeters and InDesign DOM points are interchangeable.

The standard skill workflow forbids `execute_indesign_code`. That existing escape hatch remains available only when the user explicitly requests arbitrary code outside the skill workflow.

## 9. Edit Lifecycle

1. **Inspect.** Capture the current document state and render affected pages before editing.
2. **Plan.** The client model selects a skill and authors a structured plan from the inspection results; the server validates, normalizes, and versions it.
3. **Classify.** Apply the risk policy in Section 10.
4. **Approve.** If required, return the plan and before-renders without mutating InDesign.
5. **Revalidate.** Check document fingerprint, plan version, target fingerprints, and expiration.
6. **Apply.** Execute steps sequentially. Stop on the first failure.
7. **Verify.** Run structural and visual checks.
8. **Resolve.** Report success, roll back failure, or return `structurally_checked_only` when visual review is unavailable.
9. **Report.** Summarize changed objects, quality findings, artifacts, and whether the document remains unsaved.

The original document is never auto-saved. High-risk work requires a saved document so a backup copy can be created before mutation.

## 10. Risk Policy

A plan is **low risk** only when all of the following are true:

- It affects no more than five existing targets.
- It affects one page or spread.
- Every step is reversible through the edit journal.
- It does not create or delete pages.
- It does not modify masters, grids, layers, sections, or book structure.
- It does not delete styles, colors, stories, or objects.
- It does not export, package, print, or close the document.
- It does not require arbitrary code execution.

Everything else is **high risk**. Unknown operations default to high risk.

Low-risk plans run automatically after revalidation. High-risk plans require explicit approval for the exact plan version. Any change to the plan invalidates the approval.

## 11. Verification

### 11.1 Structural Checks

Structural verification always runs and checks:

- every planned step completed successfully
- page/spread counts changed only when explicitly planned
- target objects match their expected post-state
- no unintended object additions, removals, or renames
- no new out-of-bounds content except intentional bleed
- no new overset text or text-frame overflow
- no missing image links or newly missing assets
- no newly missing fonts or substitutions
- no accidental duplicate styles or colors
- alignment and spacing remain within the plan's tolerances

### 11.2 Visual Verification

The renderer exports affected pages as PNG artifacts at 144 DPI using a corrected and validated image-export path. It supports single pages and real ranges such as `1-5`.

The visual reviewer receives before/after images, the user's intent, the plan summary, and the quality rubric. It must return structured JSON containing:

- `pass`
- scores for hierarchy, alignment, spacing, readability, cropping, and consistency
- findings with severity, page, region, and explanation
- `unintendedChanges`

A visual pass requires valid structured output, `pass: true`, and `unintendedChanges: false`.

If the configured model cannot accept images, returns invalid output, or the renderer fails, the visual result is `unavailable`. The final status is `structurally_checked_only`; it is never represented as a full visual pass.

### 11.3 Quality Rubric

The shared rubric evaluates:

- clear visual hierarchy
- consistent alignment and spacing
- readable typography and line lengths
- intentional image crop and aspect ratio
- consistent use of styles and colors
- preservation of the document's existing design language
- absence of unintended changes outside the requested targets

## 12. Rollback and Persistence

### 12.1 Low-Risk Edits

Each reversible mutation records its before-state and inverse handler call. On execution or verification failure, completed steps are reversed in reverse order. If rollback cannot fully restore state, the result is `ROLLBACK_FAILED` and the journal is preserved for inspection.

### 12.2 High-Risk Edits

Before approval is executed, the runtime creates a backup `.indd` copy in a restricted temporary artifact directory. Rollback is allowed only if the current document fingerprint matches the expected post-edit state. If the user has made subsequent changes, rollback refuses to overwrite them and reports `ROLLBACK_CONFLICT`.

Artifacts and backups are retained for the active server session and cleaned according to a documented retention policy. The user's original file is not modified by backup creation or cleanup.

## 13. Copilot Experience

1. The user enters a natural-language edit request.
2. Copilot selects a skill and shows a short inspection summary.
3. Low-risk edits proceed with progress events.
4. High-risk edits show the exact plan, affected pages, and before-renders with Approve and Cancel actions.
5. After execution, Copilot shows structural and visual findings plus before/after previews.
6. Failed edits show the rollback result and any remaining issues.

The existing single-active-chat-turn behavior remains. Stopping a turn aborts model calls and prevents further mutation steps.

## 14. Provider Support

For Copilot, the existing OpenAI-compatible and Anthropic adapters gain image-input support:

- OpenAI-compatible requests use image content blocks supported by the configured endpoint.
- Anthropic requests use base64 image content blocks.

Text-only behavior remains unchanged for ordinary chat. Copilot visual verification requires a model that accepts images; unsupported models produce an explicit unavailable result rather than a false pass. External MCP clients remain model-agnostic and provide the structured visual review themselves.

## 15. Security and Privacy

- The bridge remains bound to `127.0.0.1`.
- When `BRIDGE_TOKEN` is set, `/execute`, `/chat`, and `/status` require the same bearer token.
- The auto-started bridge inherits the MCP process environment so the token remains consistent.
- API keys remain in memory for the active chat request and are never written to skill files, plans, logs, or artifacts.
- Plans and journals exclude API keys and unrelated document content.
- Temporary renders and backups use restrictive permissions and are not exposed through MCP resources.
- Standard skill plans cannot call `execute_indesign_code`.
- Tool output and visual-model output are treated as untrusted data, not as permission to bypass approval or rollback rules.

## 16. Error Model

New workflow tools return structured errors with stable codes:

- `BRIDGE_UNAVAILABLE`
- `PLUGIN_DISCONNECTED`
- `INSPECTION_FAILED`
- `SKILL_NOT_FOUND`
- `PLAN_INVALID`
- `STALE_PLAN`
- `APPROVAL_REQUIRED`
- `APPROVAL_MISMATCH`
- `STEP_FAILED`
- `PARTIAL_APPLY`
- `STRUCTURAL_CHECK_FAILED`
- `VISUAL_CHECK_UNAVAILABLE`
- `VISUAL_CHECK_FAILED`
- `ROLLBACK_FAILED`
- `ROLLBACK_CONFLICT`

Operational failures use MCP's error result semantics. `APPROVAL_REQUIRED` is a normal workflow status, not an error. Diagnostics go to stderr; stdout remains reserved for MCP protocol messages.

## 17. Compatibility and Targeted Fixes

- Preserve all existing 135 low-level tools and their names.
- Add prompts, resources, and high-level tools without changing stdio transport.
- Correct `export_images` so the schema and handler use one contract: `outputPath`, `pages`, `format`, `resolution`, and `quality`.
- Implement single pages, comma-separated pages, and inclusive ranges such as `1-5`.
- Verify exported files exist and are non-empty before reporting success.
- Update outdated setup documentation that still claims macOS/AppleScript requirements.
- Keep existing direct-tool usage working for clients that do not use skills.

## 18. Testing Strategy

### 18.1 Unit Tests

- Skill manifest validation and registry loading
- Skill selection and ambiguity handling
- Risk classification, including unknown-operation fallback
- Plan schema validation and versioning
- Document and target fingerprint validation
- Unit conversion
- Structural checks
- Visual-response schema validation
- Edit journal inverse generation
- Rollback conflict detection
- `export_images` argument and page-range parsing

### 18.2 Protocol Tests

- MCP initialization with tools, prompts, and resources capabilities
- `tools/list`, `prompts/list`, `prompts/get`, `resources/list`, and `resources/read`
- High-level tool calls through a fake bridge
- Approval-required and approval-mismatch responses
- Error results and stdout cleanliness

### 18.3 Integration Tests

Using a fake bridge and fixture document snapshots:

- move/align workflow
- typography edit with overflow detection
- image reframe workflow
- stale-plan rejection
- partial execution followed by rollback
- high-risk backup and guarded restore
- visual-unavailable status for text-only model stubs

### 18.4 Live Windows Verification

With InDesign 2024 and the UXP panel connected:

- precise move and alignment on an existing document
- typography edit with before/after renders
- image crop and reframe
- high-risk approval in Copilot
- the same workflow from an external MCP client
- rollback after an intentionally failed quality check
- confirmation that the original file is not auto-saved

## 19. Acceptance Criteria

The implementation is accepted when:

1. Both Copilot and an external MCP client can discover and use the same skills.
2. A precise edit changes only the planned targets.
3. Low-risk reversible edits run without unnecessary prompts.
4. High-risk edits cannot execute without approval of the exact plan version.
5. Structural and visual results are reported separately and accurately.
6. Visual review cannot silently degrade into a pass.
7. Rollback succeeds for the tested low- and high-risk scenarios.
8. `export_images` works with its advertised arguments and page ranges.
9. API keys do not appear in logs, plans, resources, or artifacts.
10. Existing direct MCP tools remain functional.
11. The original document is not auto-saved.

## 20. External References

- [Model Context Protocol — Prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts)
- [Model Context Protocol — Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
