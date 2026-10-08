# Tab-strip close stability: proposed work

## Status

This is a provisional implementation proposal, not a proven regression fix or a completed council decision. Three independent Orca investigators completed their initial investigations, but report retrieval and structured-worker reuse failed before the required blind cross-review could be completed. No introducing commit has been established for the user's entire reported regression.

The investigation started from clean HEAD `b4e99fcea2f7796a902c07efe7c8385b0cfbd7ec`. No fix has been implemented, committed, reverted, or submitted for review.

## Proposed change

Extend the existing tab-strip scroll anchor to handle tab removal. Preserve the viewport position of a surviving, visible, non-docked tab when closing a tab in a scrolled strip. Keep sticky active-tab docking and existing selection/history behavior.

Current code restores an anchor for certain insertions but does not restore it for closes. Closing an inactive tab before the viewport can shift visible survivors without any JavaScript scroll write. This is the narrow movement this proposal aims to address.

This proposal does not eliminate all movement. Survivors can legitimately widen as free space is redistributed, and closing the active tab can select a distant MRU tab that intentionally docks at another edge. An anchor preserves one tab's position; it cannot preserve every tab's position when widths change.

## Minimal patch outline

1. Extend `src/renderer/src/components/tab-bar/tab-strip-scroll-anchor.ts` to retain a preferred anchor and surviving fallback candidates, with their viewport x-offsets. Reuse existing geometry and docking checks. Exclude docked elements because their painted positions do not measure content movement.
2. In `src/renderer/src/components/tab-bar/tab-strip-overflow-navigation.ts`, retain the pre-removal snapshot and detect removed slot identities using the existing layout-change path.
3. For a removal with no simultaneous insertion, restore the first eligible surviving anchor during the layout effect, before paint, only when the strip was not pinned to the end and no pointer gesture is active. If the preferred anchor was closed or has become docked, try a surviving non-docked fallback.
4. Preserve existing end-pinning and legal browser scroll clamping. Do not fight a scroll boundary to force an impossible offset.
5. Preserve the existing close-commit suppression of active-tab reveal. A distant MRU selection remains visible through sticky docking without triggering a viewport chase.
6. Record the resulting anchor and overflow/dock state after stabilization. Verify that resize observers and queued callbacks cannot overwrite the restored position with stale end-pinning state. Avoid adding extra observer subscriptions, per-frame React state, or a second scrolling subsystem.

Do not simply restore the existing single anchor unconditionally: it may have been removed or become docked, and restoration may conflict with end-pinning or a pointer gesture. Do not change close selection, freeze widths, add animation, or revert a PR as part of this patch.

## Invariants and limits

- Sticky active-tab docking stays enabled and the active tab remains visible.
- Closing an active tab preserves the existing MRU/fallback selection result.
- Closing an inactive tab preserves active selection.
- A surviving eligible anchor retains its viewport x-offset when the legal scroll range permits it.
- End-pinned strips remain end-pinned; pointer gestures retain their existing scroll policy.
- Manual wheel, scrollbar, drag, open-tab reveal, and explicit tab selection continue to work.
- Anchor state is scoped to the strip and workspace; a group collapse or workspace switch cannot reuse another strip's snapshot.
- Mixed tab types and remote updates use rendered slot identities. No execution-host, close-RPC, process-status, or wire behavior changes are needed.

An unscrolled strip at its start may be unable to compensate for width redistribution without a negative scroll offset. Treat this as an explicit boundary limitation, not a passing stability assertion. Also verify that preserving one anchor does not make the close target under a stationary pointer less predictable.

## Evidence and uncertainty

Recoverable investigation evidence reported:

- Ten-tab survivors widened from about 115px to 127.78px with `scrollLeft` unchanged. Width redistribution alone does not establish a scrolling regression.
- Multiple scroll writes were observed, but some were idempotent. Write count does not establish multiple painted movements.
- An inactive close before the viewport shifted visible survivors without a JavaScript scroll write.
- A current-hook experiment reproduced legal end clamping, distant-MRU docking, and missing close anchoring, without establishing a double-painted regression.
- Focused existing tests passed; one investigator reported 84 passing tests. These results do not prove full-app frame stability.

These were isolated mechanism experiments and source comparisons, not a complete historical Electron build comparison or bisect. The proposal must be tested against the actual reported interaction before it is called the final fix.

## Validation before shipping

First reproduce the unwanted movement in the actual current renderer and classify it as content displacement, width redistribution, viewport scrolling, docking transfer, or multiple painted transitions. Measure surviving tab rectangles, widths, `scrollLeft`, scroll range, active selection, and dock side across the close. Log scroll writes separately from painted evidence.

Use the `electron` skill and an isolated background Electron/CDP session with `ORCA_BACKGROUND_LAUNCH=1`. Never show, reveal, activate, or focus test windows. Use CDP screenshots of hidden renderers. Give the session exclusive ownership and clean it up after validation.

Add focused tests for anchor survival, removed preferred anchors, docked fallback exclusion, scroll boundaries, workspace changes, pointer gestures, and stale scheduled callbacks. Keep selection/history tests unchanged and passing.

Run rendered checks for:

- An inactive tab closed before the viewport while scrolled away from both boundaries.
- An active tab closed with a distant MRU successor, including an opposite-edge dock transfer.
- A rightmost active close while pinned to the end and while intentionally scrolled away from it.
- Repeated mouse closes, keyboard closes, and middle-click closes.
- Removal of the preferred anchor and multiple removals that also remove fallback candidates.
- Overflow appearing or disappearing, mixed tab types, split-group collapse, and delayed remote removal updates.
- Insertions, manual scrolling, drag gestures, explicit selection, and label resizing after a close.

Falsifiable acceptance test: in the inactive-close case away from boundaries, where a surviving eligible anchor and sufficient scroll range exist, its viewport left edge stays within 1 CSS pixel of its pre-close position through the rendered transition and after observers/callbacks settle. There must be no later corrective displacement. Active selection must match the unmodified implementation, and the selected tab must remain visible through normal placement or sticky docking.

Use separate expectations for end clamping, overflow disappearance, and width redistribution. Final geometry or requestAnimationFrame sampling alone is insufficient to prove the absence of an intermediate painted jump; retain rendered evidence across the transition.

Run relevant tab-strip and close-selection tests, `pnpm tc:web`, and `pnpm run check:code-quality:changed`. Assess observer activity and render counts to ensure the change adds no polling, duplicate subscriptions, or scroll-frame tab rerenders. Zero regressions is the acceptance target, not a guarantee from passing tests.

## Decision gate

Recommend shipping this narrow anchor extension only if rendered before/after evidence shows that it removes the reproduced unwanted displacement and preserves the invariants above.

If the user's jumpiness is predominantly survivor resizing or intentional MRU dock transfer, this proposal may have little benefit. The single most useful next experiment is a frame-resolved, full-renderer reproduction of the exact reported close sequence on current HEAD, with tab geometry and scroll-write instrumentation. That distinguishes which movement needs a remedy before a product behavior change is considered.

Complete the anonymous cross-review and resolve any competing causal claims with targeted checks before presenting this as a council-endorsed final fix.
