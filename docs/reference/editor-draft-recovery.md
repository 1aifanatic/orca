# Editor draft recovery

Unsaved text has its own journal, independent of workspace layout and open tabs.
Closing a tab, removing a workspace, or losing the editor process leaves its last
checkpoint available through **Recover unsaved changes** in the command palette.
Startup offers a review when recovery copies have no open buffer.

The recovery dialog lists paths and owning hosts without loading draft bodies.
Selecting a draft loads a preview capped at 100,000 characters. **Recover copy…**
exports the complete text to a separate file and keeps the journal entry. Explicit
discard requires confirmation and checks the revision again. Currently open dirty
buffers cannot be discarded from this dialog.

## Capture and durability

- Plain-text and editable unstaged-diff buffers are checkpointed after 250 ms of
  inactivity, with a 500 ms deadline during continuous input. Rich-text and notebook
  serialization also has a 500 ms deadline. Storage latency can extend these times;
  only a completed transaction is acknowledged as durable.
- Each buffer has an independent ID and revision. Writes compare the expected
  revision, so delayed checkpoints cannot resurrect a saved or discarded draft.
  Saving retires only the exact text written successfully; newer edits remain dirty
  and recoverable. Closing retains a copy instead of retiring it.
- Editable sections in the combined changes view use the same journal. After the
  view closes, each unsaved section can be recovered as an independent file copy.
- Desktop writes run in one persistent worker, in transactions using SQLite WAL
  and `synchronous=FULL`. The file is `editor-recovery.sqlite` in the active profile's
  storage directory. Existing SQLite permission hardening covers its sidecars.
- Browser clients use the `orca-editor-recovery` IndexedDB database, with separate
  metadata and content stores and strict transaction durability. Quota or disk
  failures leave previous checkpoints intact and present a retry action.

The subscriber schedules work from draft-map identity changes without scanning all
tabs on every keystroke. Checkpoints inspect buffers, reuse captured metadata,
write only changed records, coalesce edits behind an in-flight write, and batch at
most 64 records and 4 MiB of estimated UTF-16 draft text per transaction. A draft
larger than that text budget travels alone without truncation. Legacy imports use
the same limits. This avoids large cross-thread messages retaining excess resident
memory. The journal holds the latest text per buffer.
Active copies retire after a matching successful save; closed copies remain
available for explicit recovery or discard.

## Ownership and restore

Resource identity includes the execution host, workspace, runtime environment,
external SSH target, absolute path, and buffer kind. Equal paths on different hosts
cannot replace each other's drafts. Backups live on the client; the owning host
continues to perform file reads and writes. Recovery does not require a new remote
RPC method or a connected host to export a copy.

Restore overlays journal text onto existing session tabs without rebuilding their
layout. The original disk signature is preserved. A changed or unknown disk baseline
requires conflict verification before autosave, including after a crash. Recovery
does not write the original file automatically.

## Migration and rollback

On first use, dirty writable buffers from legacy session snapshots are imported
across all host partitions. Stable IDs make retries idempotent, and retired IDs
remain as tombstones. The source snapshots stay intact if import fails.

Session snapshots continue to include dirty text for older builds, alongside optional
recovery IDs, revisions, and buffer-kind fields. No paired-host upgrade is required.
Newer snapshot text takes priority over an older journal checkpoint and receives a
fresh checkpoint. Unknown future buffer-kind tokens remain readable in the session
schema. A future journal version is left untouched and the legacy session remains
available.

Legacy snapshots without recovery IDs cannot prove whether identical text was
already retired or edited again in an older build. Recovery favors preserving that
text. Copies created by combined-view sections are available through the new recovery
dialog; older builds do not have that interface. Desktop profiles and browser origins
have separate storage; switching either does not transfer the journal automatically.

## Validation and performance

Regression coverage exercises real transaction rollback, revision races, exact empty
and large Unicode text, worker termination after a commit, legacy import, future
versions, continuous typing, and edits during saves. Hidden-renderer integration
tests exercise the recovery dialog, complete exports, combined-view editing,
browser storage, and a hard-killed app followed by an external disk change.

A local macOS arm64 / Node 24.20.0 comparison used 2,000 open-file records and
10,000 synthetic draft updates grouped behind 20 forced checkpoints. Five fresh
processes per version ran the production session subscriber, adding the production
recovery subscriber and SQLite worker in the feature version. With one 2 MiB draft,
store updates plus persistence scheduling took 2.05 microseconds median without
recovery and 2.36 with it. Independent committed checkpoints took 2.97 ms median
and 3.68 ms p95; the baseline has no independent journal to compare.

For ten 2 MiB drafts, settled process RSS after updates was 170.4 MiB without
recovery and 224.1 MiB with it. The initial implementation's 64-record-only batches
measured 656.4 MiB: a clone-only control reproduced the high RSS without database
writes, while splitting the messages removed most of that cost. The text budget
reduces large-message allocation and retention; it is not a cap on total RAM.
Committing all ten drafts took 25.03 ms median and 31.98 ms p95, compared with
24.86 / 28.75 ms before splitting. Every final journal body matched exactly.

RSS includes the worker thread and retained allocator pages; parent-thread JS heap
alone misses that cost. Parent GC preceded settled samples; worker GC was normal.
These isolated persistence measurements exclude the renderer and editor painting,
and do not establish keyboard latency or cross-platform memory guarantees. A single
oversized draft, restore responses, and compatibility-session snapshots can still
carry larger payloads.
