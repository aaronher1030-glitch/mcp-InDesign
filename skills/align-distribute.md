# Align Distribute

## When to use
Aligns and distributes selected InDesign page items against a stated margin, grid, or neighbor. Use this skill for existing objects that need consistent alignment, spacing, or distribution.

## Preconditions
- A document is open in InDesign.
- The requested pages and targets can be identified from inspection output.

## Workflow
1. Inspect the affected pages and item geometry with `inspect_layout`.
2. Author a structured plan using inspection IDs and fingerprints, naming the alignment reference, distribution bounds, and gap tolerance.
3. Call `plan_edit` and obey its risk classification.
4. Call `apply_edit_plan` only with required approval, using `move_page_item`, `resize_page_item`, or `set_page_item_properties` as planned.
5. Verify structural and visual results with `verify_layout`, measuring gaps and checking page bounds.
6. Report changed objects and unresolved findings; call `rollback_edit` if verification fails.

## Quality criteria
- Gaps are equal within the plan tolerance.
- Items align to the chosen margin, grid, or neighbor.
- No item leaves the page unexpectedly.

## Example request
> Distribute the three product cards evenly between the left and right margins with 6 millimeter gaps.
