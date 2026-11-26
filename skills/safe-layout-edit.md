# Safe Layout Edit

## When to use
Makes precise, reversible changes to an existing InDesign layout without disturbing unrelated content. Use this skill when the request names objects, pages, spacing, or visual intent but does not require a new document.

## Preconditions
- A document is open in InDesign.
- The requested pages and targets can be identified from inspection output.

## Workflow
1. Inspect the affected pages with `inspect_layout` and record object IDs and fingerprints.
2. Author a structured plan using the inspection IDs and fingerprints.
3. Call `plan_edit` and obey its risk classification.
4. Call `apply_edit_plan` only with required approval, keeping `rollback_edit` available if verification fails.
5. Verify structural and visual results with `verify_layout` and inspect before/after artifacts.
6. Report changed objects and unresolved findings.

## Quality criteria
- Only planned targets change.
- No new text overflow or out-of-bounds content appears.
- No unintended style duplication occurs.
- Structural and visual results are reported separately.

## Example request
> Move the title down 8 millimeters, keep it inside the margin, and make sure the body text still fits.
