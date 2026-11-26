# Multi Page Consistency

## When to use
Coordinates high-risk repeated InDesign changes across pages and spreads while protecting masters, folios, and unrelated content. Use this skill when a repeated element, master, or folio must stay coherent across multiple pages.

## Preconditions
- A document is open in InDesign.
- The requested pages and targets can be identified from inspection output.

## Workflow
1. Inspect all affected pages with `inspect_layout`, then call `list_spreads` and `get_spread_info` to map page, spread, master, and folio relationships.
2. Author a structured plan using inspection IDs and fingerprints, explicitly listing repeated targets and master-derived changes.
3. Call `plan_edit` and treat the result as high risk; stop until explicit approval is available.
4. Call `apply_edit_plan` only with explicit approval, using `apply_master_spread` only when the approved plan requires it.
5. Verify every affected page and spread with `verify_layout`, comparing repeated elements, masters, folios, and unrelated content.
6. Report changed objects and unresolved findings; call `rollback_edit` if verification fails.

## Quality criteria
- Repeated elements align across pages.
- Masters and folios remain coherent.
- No unrelated page changes occur.
- Approval is always required.

## Example request
> Align the running headers on pages 2 through 12 and update the shared master without changing unrelated page content.
