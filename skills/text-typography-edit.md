# Text Typography Edit

## When to use
Edits InDesign text and typography while preserving readability, hierarchy, and reusable styles. Use this skill for existing text frames, typography, leading, alignment, or style changes that do not require a new document.

## Preconditions
- A document is open in InDesign.
- The requested pages and targets can be identified from inspection output.

## Workflow
1. Inspect the affected pages and text frames with `inspect_layout`, including current styles, overset state, and geometry.
2. Author a structured plan from the inspection IDs and fingerprints, reusing suitable paragraph and character styles.
3. Call `plan_edit` and obey its risk classification, including approval for any required style creation.
4. Call `apply_edit_plan` only with required approval, using `edit_text_frame`, `apply_paragraph_style`, or `apply_character_style` as planned.
5. Verify structural and visual results with `verify_layout`, checking overset text, hierarchy, leading, and alignment.
6. Report changed objects and unresolved findings; call `rollback_edit` if verification fails.

## Quality criteria
- No overset text remains.
- The typography hierarchy remains clear.
- Leading and alignment are consistent across edited text.
- Existing styles are reused when suitable.

## Example request
> Set the subheads to the existing Heading 2 style and adjust leading so no line becomes overset.
