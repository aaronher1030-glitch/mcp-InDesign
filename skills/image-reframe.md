# Image Reframe

## When to use
Reframes and crops placed InDesign images while preserving links, resolution, and planned bounds. Use this skill when an existing image needs a different crop, composition, frame size, or aspect ratio.

## Preconditions
- A document is open in InDesign.
- The requested pages and targets can be identified from inspection output.

## Workflow
1. Inspect the affected pages with `inspect_layout` and call `get_image_info` for each placed image.
2. Author a structured plan using inspection IDs and fingerprints, recording crop intent, effective resolution, link status, and frame bounds.
3. Call `plan_edit` and obey its risk classification.
4. Call `apply_edit_plan` only with required approval, using `resize_page_item` or `set_page_item_properties` as planned.
5. Verify structural and visual results with `verify_layout`, checking crop composition, resolution, links, and bounds.
6. Report changed objects and unresolved findings; call `rollback_edit` if verification fails.

## Quality criteria
- The aspect ratio follows the stated crop intent.
- Effective resolution is acceptable for the intended output.
- Image links remain valid.
- The frame stays within the planned bounds.

## Example request
> Reframe the portrait to a 4:5 crop, keep the subject's face visible, and keep the frame inside the column.
