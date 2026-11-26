# Style Consistency

## When to use
Applies existing InDesign styles and colors consistently without creating unnecessary duplicates. Use this skill for paragraph, character, object, or color formatting that should match established document definitions.

## Preconditions
- A document is open in InDesign.
- The requested pages and targets can be identified from inspection output.

## Workflow
1. Inspect the affected pages with `inspect_layout`, then call `list_styles` and `list_color_swatches` to identify reusable definitions.
2. Author a structured plan using inspection IDs and fingerprints, mapping each target to an existing style or color whenever suitable.
3. Call `plan_edit` and obey its risk classification, requesting approval before proposing any duplicate style or color.
4. Call `apply_edit_plan` only with required approval, using `apply_paragraph_style`, `apply_character_style`, `apply_object_style`, or `apply_color` as planned.
5. Verify structural and visual results with `verify_layout`, comparing typography and formatting across all targets.
6. Report changed objects and unresolved findings; call `rollback_edit` if verification fails.

## Quality criteria
- Existing styles and colors are preferred.
- No duplicate styles are created without approval.
- Typography remains consistent across all targets.

## Example request
> Apply the existing Body and Caption styles to the selected text and use the approved brand colors throughout.
