# STA-9590: pass known workspace context into native chat

Design only. Source baseline: `6a46769bb66eb6d49243543533ef0a984853de43`, branch `sta-9590-chat-lookup-design`, child of `orca-perf-monitor`. No product changes, tests, app launches, or new timing measurements were made for this document.

## Decision

**Pass the workspace information the parent already has into chat. Let the existing functions use it instead of searching every tab to discover the workspace again.**

For example, a chat runs on a remote machine. Showing its conversation requires knowing which machine serves it. Opening `src/app.ts` from a message also requires the workspace's folder, so Orca can resolve the full path. Displaying an image requires the appropriate route to read that file. If the folder information is still loading, the conversation can continue using its known host while file features wait.

The parent already knows the workspace. Structured chat also receives an explicit session target. Preserve that information through the existing props, and keep ownership, path resolution, and file-operation routing in their existing functions. A path that has not loaded must not erase known ownership.

Keep the current tab arrays. This task is complete when the mounted native-chat views, composers, and their discovery/action paths no longer search unrelated tab buckets to recover their workspace, and the changed flows pass routing regression and scoped membership checks. Storage normalization is not a later stage of this plan. This is a lookup refactor, not a new host-ownership contract or an established typing-latency fix.

## Problem and source evidence

The component tree drops workspace information at two boundaries:

| Boundary | Information already available | Information chat receives today |
| --- | --- | --- |
| [TerminalPaneNativeChatPortal](../../src/renderer/src/components/terminal-pane/TerminalPaneNativeChatPortal.tsx) | Its [controller foundation](../../src/renderer/src/components/terminal-pane/use-terminal-pane-foundation.ts) carries `worktreeId`, terminal ID, and pane context. | Terminal and pane IDs, but no workspace ID. |
| [StructuredAgentSessionPaneOverlayLayer](../../src/renderer/src/components/native-chat/StructuredAgentSessionPaneOverlayLayer.tsx) | The unified tab contains its workspace and recorded host; the overlay resolves an explicit session target. | Tab ID, session ID, and target, but no workspace ID. |

Descendants then rediscover the workspace:

- [selectNativeChatRuntimeEnvironmentId](../../src/renderer/src/components/native-chat/native-chat-runtime-owner.ts) searches `tabsByWorktree` by terminal ID before resolving the runtime owner.
- [useNativeChatFileLinkContext](../../src/renderer/src/components/native-chat/use-native-chat-file-link-context.ts) runs another selector that searches terminal buckets, then structured unified buckets on a miss. A structured chat therefore searches terminal inventory before reaching its own record type.
- [Image context](../../src/renderer/src/components/native-chat/native-chat-image-runtime-context.ts), [attachment ownership](../../src/renderer/src/components/native-chat/native-chat-attachment-upload.ts), and [workspace file drops](../../src/renderer/src/components/native-chat/use-native-chat-workspace-file-drop.ts) also use this discovery. Images derive context after selecting relevant store inputs; attachments and drops perform checks for user actions. Their invocation patterns differ from the two selectors above.
- [Skill discovery](../../src/renderer/src/components/native-chat/native-chat-skill-discovery-context.ts) searches terminal and unified buckets to recover the workspace, then repeats discovery to resolve the working directory. [Its hook](../../src/renderer/src/components/native-chat/use-native-chat-skills.ts) computes this context before checking whether discovery is enabled; a closed picker does not eliminate that work.
- [Model-option discovery](../../src/renderer/src/components/native-chat/native-chat-session-option-discovery.ts) searches terminal buckets and then calls `getSettingsForAgentTabRuntimeOwner`, which searches them again. [The session-options hook](../../src/renderer/src/components/native-chat/use-native-chat-session-options.ts) currently memoizes the context by terminal ID alone.
- [Composer target resolution](../../src/renderer/src/components/native-chat/NativeChatComposer.tsx) and [interactive sends](../../src/renderer/src/components/native-chat/use-native-chat-interactive-send.ts) also call [getSettingsForAgentTabRuntimeOwner](../../src/renderer/src/lib/agent-paste-draft.ts). Its action-time global search is part of this migration even though the helper also has non-chat callers.

The global searches use `Object.entries` and row scans. Their worst-case work depends on workspace and tab counts, multiplied by selector evaluations and mounted chats. Primitive results and `useShallow` can prevent React commits while still executing the search. Passing the workspace removes the need for that search. This does not establish the current wall-time cost or its contribution to typing latency.

Historical evidence was recorded from [STA-9590](https://linear.app/stably/issue/STA-9590), including the Oct 5 handoff comment `6d1fa2a0-1b7b-4272-9d46-dba21d6d4088`, parent [STA-7551](https://linear.app/stably/issue/STA-7551), and related [STA-7552](https://linear.app/stably/issue/STA-7552). Reports describe different captures: roughly 1,000–1,200 workspaces and 2,400–2,600 tabs in later reports; roughly 870 workspaces, 1,408–1,410 terminal tabs, and 5,462–7,478 listeners in an older capture. A Sept 29 report attributes 92 ms self time to AI Vault matching. Raw traces are unavailable. These are historical observations, not measurements of this checkout or causal evidence for this change.

## Scope

Change the native-chat prop chain and its workspace-dependent readers: bridge and structured views, runtime-owner selection, file links, images, skills, model options, composer and interactive sends, attachments, and drop validation. Reuse existing host/runtime types, workspace keys, catalog lookups, and route policy. Use Git, folder, and floating workspace behavior already supported by those functions. Shared helpers may gain a scoped entry point; their non-chat callers do not need to migrate in this task.

The task does not change tab storage, persistence, hydration producers, remote payloads, terminal recovery, or application-wide identity rules. It does not migrate general `getTab` callers, delete the owner index, or consolidate sidebar, title-sync, and agent-status indexes. It adds no global context service, owner cache, store, polling loop, or subscription framework. STA-7552 retains broader status-summary work; STA-9589 retains PTY binding/reattachment work.

Broader attachment-race fixes are separate work: new composer-lifetime cancellation, session/PTY/generation fencing, file-picker result cancellation, and extending revalidation to additional asynchronous stages. This refactor preserves existing attachment protections and validates the supplied workspace at the existing acceptance and revalidation points.

AI Vault session matching is separate from native chat knowing its own workspace. Its historical cost does not justify a tab-storage change. Leave its current selection-independent memoization and matching behavior in place; pursue a separately measured change if it remains expensive.

### Boundary with runtime-management

The companion `runtime-management/runtime-management-requirement.md`, under “Host-qualified identity and single workspace ownership,” explicitly permits STA-9590 to optimize lookup independently. That work owns structural host scope, ownership independent of selection, canonical membership, and consistent migration of file/input/recovery actions. Its requirements are not acceptance criteria for this patch.

In particular, this task does not replace bridge ownership precedence or establish end-to-end host qualification through file stat/read, editor/preview opening, workspace activation, or HTTP-link actions. Existing helpers can consult active selection or collapse ambiguous/missing ownership to a nullable transport. File-opening and HTTP-link handlers can independently re-resolve ownership. Passing a workspace prop does not repair those limitations. Preserve existing explicit structured-session targets; do not add a competing chat-specific owner service or extend downstream routing interfaces here.

For inputs with unambiguous existing workspace membership, compare the old and new routes using the same store snapshot. A stale scoped membership reference is handled locally as described below. Record existing host-collision/ambiguity failures for runtime-management; neither reproducing them nor preserving legacy lookup order proves canonical ownership correct. If a caller cannot be migrated without deciding a new ownership policy, leave that caller explicitly deferred and narrow the completion claim before declaring this task finished.

## Pass workspace information through chat

Extend the existing [native-chat props](../../src/renderer/src/components/native-chat/native-chat-view-types.ts) with the owning workspace. Bridge and structured modes already distinguish the kind of tab; preserve that distinction instead of trying terminal lookup first for both modes.

- Bridge: carry `controller.worktreeId` through the portal, `NativeChatView`, and `NativeChatResolvedView` into the composer and its hooks. Replace tab-to-workspace discovery with the supplied workspace, retaining the existing runtime-owner resolver and its precedence.
- Structured: carry the tab's workspace through the overlay and `NativeChatStructuredSession` into the composer and discovery hooks, alongside the existing explicit target. Continue using that target for session transport. This refactor does not promise that every downstream file/browser action is already bound to the same host.

Props follow the parent's current store-derived values. Do not copy the initial workspace into effect-managed state. When a parent already supplies the information needed for presentation, no tab lookup is necessary. If a reader needs to verify current membership or inspect a row, read only `tabsByWorktree[worktreeId]` for a bridge terminal or `unifiedTabsByWorktree[worktreeId]` for a structured tab. This remains a workspace-local array lookup.

Keep UI tab ID, backing terminal ID, provider session ID, and host target distinct. Use existing accessors where they fit; add an explicit workspace argument to an existing pure accessor only if a touched caller needs it. This task does not require a general tab-access redesign.

## Use the known workspace for each feature

| Feature | What it needs | Behavior when information is unavailable |
| --- | --- | --- |
| Conversation read/subscribe | The session identity, supplied workspace, and existing transcript transport resolution | A scoped membership miss suspends transcript IO. Missing folder information alone does not block the existing resolved transport. |
| File links | The supplied workspace and existing path/runtime context | Wait for the path; preserve existing relative-path and line/column handling and downstream routing. |
| Images | The owning workspace/path and existing file-operation route | Wait until the route is usable; preserve direct-SSH expectations and runtime routing. |
| Skills | Workspace, scoped row for `startupCwd`, and existing discovery route | Preserve subdirectory precedence and unsupported-host behavior; do not search another tab kind or workspace on a miss. |
| Model options | Workspace and existing discovery scope/path | Preserve existing unavailable behavior; context must update when its workspace or relevant route inputs change. |
| Composer and interactive sends | Current scoped terminal membership, pane/PTY target, and existing runtime settings | Refuse an invalid destination; do not fall through to globally selected settings on a scoped miss. |
| Attachments and workspace drops | Supplied workspace, current scoped membership, and existing owner/SSH expectations | Refuse a scoped membership miss; preserve existing owner checks and delayed-result handling. |

Adapt [native-chat-file-link.ts](../../src/renderer/src/components/native-chat/native-chat-file-link.ts) to start from the supplied workspace rather than a global tab search. Keep runtime-owner resolution independent of this path-dependent result. Pass the same workspace into image and attachment functions, reusing [worktree-runtime-owner.ts](../../src/renderer/src/lib/worktree-runtime-owner.ts), [worktree-operation-route.ts](../../src/renderer/src/lib/worktree-operation-route.ts), and existing catalog functions as appropriate.

Carry workspace identity directly to consumers that need only that identity. For example, structured provisional-launch handling currently receives `fileLinkContext?.worktreeId`; it should not depend on the workspace path having loaded merely to know its workspace.

Resolve skill context once from the supplied workspace and correctly typed scoped row, keeping `startupCwd` ahead of the workspace root. Pass the workspace through picker and session-option hooks. Replace the model-context memo keyed only by terminal ID with dependencies that include the workspace and the store inputs actually used by discovery; do not keep a mount-time route after those inputs change. Preserve existing discovery caching and unsupported-action policy.

For composer and interactive actions, use the existing worktree-scoped runtime-settings helper after validating the destination in the supplied bucket. Do not call the globally scanning tab-settings adapter from the migrated chat path. Keep that adapter for unrelated callers that still possess only a tab ID.

### Handle scoped membership misses without changing owner policy

Today the bridge runtime selector returns `string | null`, and the transport factory treats `null` as the local adapter. Replacing global discovery must not turn a missing scoped row into a new local read. Represent membership availability separately from the existing nullable runtime value and suspend transcript IO on a membership miss. Reuse the live-session hook's existing enable/disable behavior, including stream teardown and stale-completion fencing; retain transcript presentation according to its existing identity rules.

This is a membership guard, not proof of host ownership. A successful bucket lookup does not distinguish local ownership from every ambiguous/missing-owner case inside the existing resolver. Correcting that resolver and separating those cases throughout the application belongs to runtime-management. Preserve resolved local/direct-SSH behavior, existing structured targets, and the path-independent runtime lookup. Do not search another bucket or substitute active settings when scoped membership is missing.

### Read one snapshot consistently

Selectors use the store snapshot passed to them for membership, path, and route inputs. Avoid invoking a store method that closes over a newer global state. In particular, the current file-link resolver calls `state.getKnownWorktreeById`, whose implementation calls `get()`. Reuse its underlying pure catalog lookup with the supplied snapshot and applicable host qualification instead.

This rule covers the complete result: a tab from snapshot A must not acquire a path or route from snapshot B. Imperative event handlers intentionally obtain the current snapshot at action time.

## Preserve attachment checks with scoped lookups

Passing a workspace prop must not replace a current membership check with trust in stale props. At attachment/drop acceptance and existing revalidation points, read the current store and verify the tab in the supplied workspace bucket. Use the bridge or structured bucket appropriate to the chat mode. Capture the supplied workspace with the operation and refuse a missing membership or changed workspace; do not search for the tab's new location or fall back to active settings. Read current membership from the store even before parent props rerender.

Preserve existing owner comparisons, SSH connection-generation checks, workspace-drop source validation, delayed-insertion callbacks, and clipboard lifetimes. Change their workspace lookup to use the supplied bucket without broadening their cancellation policy. Membership checks compare workspace and tab identity, not row-object identity, so an unrelated title update remains valid.

An unavailable chat membership result affects that chat operation only. It is not evidence that a process exited and must not retire a terminal or reset recovery. [locateTerminalTab](../../src/renderer/src/store/terminals/terminal-tab-location.ts) remains the lifecycle authority for canonical terminal presence, including when no unified row exists. Preserve [SSH execution ownership](../reference/ssh-execution-boundary.md) and the `live` / `unverifiable` / `exited` verdicts.

## Implementation sequence

1. Complete the caller inventory through both mounted views and composers, including skills, model options, sends, and delayed attachments. Record existing routing outputs and attachment guards. Add a reusable workload and capture the unmodified baseline before changing product code.
2. Pass workspace information through bridge and structured props and all inventoried consumers. Preserve explicit targets, existing owner precedence, and path-independent transport resolution. Use pure snapshot catalog reads and scoped membership guards.
3. Migrate attachment/drop checks to the expected bucket, validate scoped membership at existing acceptance/revalidation points, and preserve existing attachment protections. Remove chat's global discovery calls, retaining adapters for unrelated callers.
4. Run focused correctness and complete-flow lookup-count coverage, then replay the baseline workload on the changed build. Report timing, allocation, render, subscription, and residual route/catalog costs alongside removed bucket visits.

Completion of these steps finishes this design. A storage/index change would require separate evidence of a remaining workload that this approach cannot handle and a new design for its read/write tradeoffs.

## Correctness and performance checks

These are proposed checks, not results. Capture a before/after workload with bridge and structured chat at 100 and 1,200 workspaces, 240 and 2,600 terminal rows, multiple hosts, and 20 mounted chats. Hold the owning bucket fixed while increasing unrelated tab buckets by 10×. Include an old-scan control so the count test demonstrably catches the original behavior. Exercise the mounted view/composer path with skill pickers closed and open, model-option discovery, send/interactive actions, and attachments; resolver-only tests cannot establish completion.

| Scenario | Acceptance |
| --- | --- |
| Unrelated real status/output/title publications | No unrelated tab-bucket enumeration to recover the mounted chat/composer's workspace, including transitive discovery and action helpers. Count selector evaluations and React commits separately. Structured chat never searches terminal inventory for its workspace. |
| Known owner, missing workspace path | Conversation reads remain on the correct transport. File features wait and recover when the path arrives. Workspace-only consumers remain independent of path readiness. |
| Missing scoped membership | No new local read/subscription fallback, global discovery, or action against the missing destination. Pending transcript results are fenced by the existing disabled-stream behavior. |
| Routing regression | For the same unambiguous workspace membership and snapshot, bridge/file/image/discovery/action routing matches the existing policy. Structured session transport retains its explicit target. Existing cross-host ambiguity defects are documented separately, not declared fixed. |
| Skills and model options | Preserve `startupCwd`, discovery caching, and unsupported-host behavior. Workspace/route changes invalidate affected discovery context even when tab ID stays the same. |
| Move, close, hydration/reset | Props update; existing attachment acceptance/revalidation points refuse missing membership or a changed workspace, including store changes before parent rerender. Unrelated title updates remain valid. Existing owner/SSH checks and delayed-insertion protections continue to pass. |
| Snapshot A → B → A | Complete workspace/path/route results belong to the supplied snapshot; current-state revalidation deliberately reads B when B is current. |
| Workspace and transport variants | Cover Git/folder/floating behavior, local, direct SSH, paired runtime, and Windows/WSL paths using the existing route contracts. Unsupported file actions retain their current refusal behavior. |
| Regression budget | Existing pane-title/store-subscription budgets still pass. No new listeners, timers, IPC, or persistent ownership state. Recovery behavior remains unchanged. |

Extend the existing native-chat runtime-owner, file-link, image, upload/drop, and relevant component suites. Reuse existing recovery coverage as a regression check rather than rewriting lifecycle logic. Register new executable lookup-count coverage in `config/reliability-gates.jsonc` during implementation. Count route/catalog work separately: removing tab scans is not a claim that all ownership resolution is constant-time.

Include skills, session options, composer/interactive sends, and scoped attachment lookup coverage in that gate. Select a workspace bucket instead of a whole tab map where a hook needs only that bucket, retaining all route/catalog dependencies its resolver reads. Verify that unrelated bucket changes do not invalidate bucket-only derivations. This does not eliminate legitimate catalog work: SSH route resolution can still scan catalog rows. Measure total selector/derivation time, allocations, React commits, and subscription churn on repeated identical before/after workloads; report run variability and any regression. No timing result is available yet, and no numerical latency improvement is promised. A measurable remaining bottleneck informs separate work rather than expanding this patch automatically.

For implementation, run focused `ORCA_BACKGROUND_LAUNCH=1 pnpm test <affected suites>`, `ORCA_BACKGROUND_LAUNCH=1 pnpm tc:web`, and `ORCA_BACKGROUND_LAUNCH=1 pnpm run check:code-quality:changed`, plus affected reliability commands. Product tests are not needed for this documentation-only edit.

## Rendered validation and evidence

Capture the baseline and validate the changed chat flows in equivalent disposable profiles with identical sanitized fixtures. Record commit/build identity, platform, dataset size, mounted chat count, and scripted workload for both. Replay unrelated status/title publications, chat opens and switches, discovery/actions, path hydration, tab movement, and delayed attachment completions. Compare work counts and capture bounded renderer traces; attribute remaining cost rather than expanding this patch to unrelated readers.

All test, diagnostic, and app commands use `ORCA_BACKGROUND_LAUNCH=1`. Read the Electron skill before rendered checks, verify the built launch policy, and use Playwright CDP against hidden renderers on a dedicated endpoint. No `show()`, `showInactive()`, `bringToFront()`, `app.focus()`, or OS activation. Never overwrite the installed app or user data. Cross-architecture packaging follows the [install policy](../reference/pnpm-install-policy.md).

Use CDP screenshots to verify the changed conversation/file flows. Hidden CDP input does not establish native keyboard latency. Any typing-latency claim requires the existing benchmark on an isolated display or CI after reading `tests/AGENTS.md` and `tests/e2e/AGENTS.md`; leave that claim pending if those measurements are unavailable. Report unavailable live-platform coverage explicitly. Store sanitized evidence durably and dispose only test-owned resources.

Current selector frequency, mounted-chat counts, packaged attribution, and end-to-end latency remain unmeasured. Success here establishes that chat uses the workspace context already available to it and that unrelated tab inventory no longer contributes to those lookups.
