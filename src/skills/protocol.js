/**
 * Shared protocol text exposed as MCP resources and embedded in prompts.
 * Keep these in sync with docs/MCP_INSTRUCTIONS.md.
 */

export const EDIT_LIFECYCLE_MARKDOWN = `# InDesign Edit Lifecycle

1. **Inspect.** Call \`inspect_layout\` for the affected pages and keep the returned
   \`inspectionId\`. Every target you plan against must come from that inspection.
2. **Plan.** Author a structured plan with \`targets\` (pageIndex, itemIndex,
   before-state, fingerprint inputs) and \`steps\` (\`toolName\`, \`arguments\`,
   \`targetFingerprint\`, \`expectedResult\`). Submit it with \`plan_edit\`.
3. **Classify.** The server classifies the plan. One page, at most five existing
   targets, and only reversible allowlisted steps is low risk. Everything else
   is high risk. Low-risk plans apply automatically.
4. **Prepare.** For a high-risk plan, call \`apply_edit_plan\` with the exact
   \`expectedVersion\`. The server revalidates the plan and active document and
   renders one valid before artifact for every affected page without mutating.
   Missing, duplicate, invalid, or incomplete renders fail closed. MCP callers
   must not send \`approved\` or \`approvalToken\`; neither is part of the tool
   schema and caller-supplied approval is rejected.
5. **Approve.** The server asks the human through MCP elicitation (or the
   trusted Copilot approval UI) to approve the exact plan version, affected
   page indexes, and before-artifact paths. Decline, cancellation, unavailable
   elicitation, or unavailable renders cause zero mutation. Only an explicit
   human accept lets a trusted adapter issue a cryptographically random,
   expiring, one-time capability. The runtime stores only its SHA-256 hash,
   plan ID, exact version, and expiry. The token is never returned to the model,
   included in public plan views, or emitted in events.
6. **Apply.** \`apply_edit_plan\` verifies the capability in constant time,
   binds it to the plan/version, and consumes it before the first await or
   mutation. It locks the plan before asynchronous work, re-inspects the same
   active document immediately before execution and every step, and aborts if
   identity or contents changed. High-risk before-render failure or incomplete
   page coverage prevents every planned step. Steps run in order and stop at
   the first failure or \`AbortSignal\`; completed reversible steps are undone
   automatically.
7. **Verify.** \`verify_layout\` runs structural checks and, when a vision model
   or client-supplied review is available, a visual review.
8. **Resolve.** Report \`verified\`, \`failed\`, or \`structurally_checked_only\`.
   Roll back with \`rollback_edit\` when the result is not acceptable.

The original document is never saved automatically. High-risk execution
requires a saved document so a hashed, identity-checked backup copy can be made
before mutation. Planned steps never call \`execute_indesign_code\`; trusted
rollback may use a fixed exact-document close script with discard semantics.
`;

export const QUALITY_RUBRIC_MARKDOWN = `# InDesign Quality Rubric

A layout edit passes only when all of the following hold.

## Structure
- Every planned step completed successfully.
- Only planned targets changed; no unintended additions, removals, or renames.
- Page and spread counts changed only when the plan explicitly asked for it.
- No new overset text, out-of-bounds content, missing links, or missing fonts.
- No accidental duplicate styles or colors.
- Alignment and spacing stay inside the plan tolerance.

## Visual review
Score each dimension from 1 (poor) to 5 (excellent):

- \`hierarchy\`: a clear reading order and emphasis.
- \`alignment\`: objects line up with the grid, margins, or each other.
- \`spacing\`: consistent gaps and breathing room.
- \`readability\`: line length, leading, and type size remain comfortable.
- \`cropping\`: image crop and aspect ratio look intentional.
- \`consistency\`: styles, colors, and repeated elements stay coherent.

A visual pass requires valid structured output, \`pass: true\`, and
\`unintendedChanges: false\`. If review is unavailable the result is
\`structurally_checked_only\`, never a full pass.
`;

export const SKILL_PROMPT_NAMES = [
  'indesign.safe_layout_edit',
  'indesign.text_typography_edit',
  'indesign.align_distribute',
  'indesign.image_reframe',
  'indesign.style_consistency',
  'indesign.multi_page_consistency',
];

export const PROMPT_TO_SKILL = {
  'indesign.safe_layout_edit': 'safe-layout-edit',
  'indesign.text_typography_edit': 'text-typography-edit',
  'indesign.align_distribute': 'align-distribute',
  'indesign.image_reframe': 'image-reframe',
  'indesign.style_consistency': 'style-consistency',
  'indesign.multi_page_consistency': 'multi-page-consistency',
};
