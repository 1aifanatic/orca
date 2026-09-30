# Remote Server Install Model

What Orca installs into `~/.orca-remote/` on a remote host, who may delete it, and what stays fixed while the relay and orcad converge into one server. This page replaces §06 of `shipping-orcad.html`, a design document that was never checked into any repository. Code comments that cited it point here instead.

The decision is D10 of the Node runtime design. The sections at the end restate the other parts of the shipping design that code still cites (§02, §04 and the activation rule). They were reconstructed from those code comments, because the original can't be recovered.

## The model

The relay and orcad converge into **one server package with two install paths**:

- **Client-pushed**, for SSH targets. The desktop client uploads the package and the runtime over the SSH connection and launches the server itself.
- **User-installed**, for paired peers. The user installs the server on the host and pairs a client with it.

Both paths put the same layout on the host:

```
~/.orca-remote/
  server-<version>/                  one directory per server build
    .runtime-ref-node-<sha256>       names the runtime this build runs on
  runtimes/
    node-<sha256>/bin/node           the pinned Node runtime, shared by hash
    node-<sha256>/.verified          written after the executable's hash checks out
```

A runtime is stored once and shared by every server build that pins the same hash. Upgrading Orca without changing the Node pin adds a `server-<version>/` directory and uploads no runtime.

## What is permanent

**One registered execution identity per machine.** A machine may be registered as an SSH target or as a paired peer, never as both. Two registrations split one machine's worktrees across two identities, which is the failure [`ssh-execution-boundary.md`](./ssh-execution-boundary.md) exists to prevent. `src/main/ssh/remote-install-coexistence.ts` refuses the `both` registration loudly and does not pick one.

**The registration decides the model, and the disk never does.** What a client finds in `~/.orca-remote/` is diagnostic only. Inferring the model from disk ("an orcad directory exists, so use orcad") would let a GC pass, a half-finished install or a stale tree silently point a live connection at a different execution identity.

## What this page retires from the shipping design

The shipping design said that `relay-<version>/` and `orcad-<version>/` coexist on disk permanently, that each model garbage-collects only its own namespace forever, and that no plan item makes one of them the winner. Convergence retires all three. The legacy directories are migrated away by one sweep, described next. The permanent rule above is the part of §06 that survives.

## Legacy directories: one migration sweep

`relay-<version>/` and `orcad-<version>/` directories belong to a single migration sweep that the server model runs. The sweep deletes a legacy directory only when the liveness verdict for every process rooted in it is **`exited`**:

- `live` keeps the directory.
- `unverifiable` keeps the directory. Loss of contact or a failed probe is never evidence of `exited`.
- `exited` means positive evidence of absence from the host that owns the process.

The vocabulary is the one fixed by [`ssh-execution-boundary.md`](./ssh-execution-boundary.md). Don't add synonyms.

## GC ownership hand-over: two releases

GC ownership of `relay-*` and `orcad-*` passes to the server model over two releases, never one.

1. **Release N** ships the server model. It lists legacy directories and reports them as diagnostics only. It deletes none of them. The existing per-model rules stay in force: the relay GCs `relay-*`, orcad GCs `orcad-*`, and `remoteInstallGcPermits` in `src/main/ssh/remote-install-model.ts` re-checks every candidate locally.
2. **Release N+1** turns the migration sweep on. The server model may delete `relay-*` and `orcad-*` directories, and only on an `exited` verdict. This release amends the rule that the model which created a directory owns it (`remoteInstallDirOwner`). The local re-check stays.

Two steps keep a mixed-version host safe. A host is often shared by an SSH-target user on one client version and a paired peer on another. With a single step, a client that just learned about the server model could delete a tree that an older client's relay or orcad is still running from.

Until release N ships, the per-model rule is the whole story. Each model deletes only directories it created. orcad also pins three idle-looking directories: the active version, the rollback target, and the version the live terminal daemon was forked from.

## Carried over from the shipping design

These points are still cited from code. They don't change with convergence.

- **Activation is gated on health, not on a port** (`src/main/ssh/orcad-activation-gate.ts`). A deployment that reports success because a port opened is the failure to prevent. The server answers RPC from its own process, so it can listen while the terminal daemon is dead. Activation reads the health payload the candidate published. A refusal leaves the previous version active and loses nothing.
- **The launch handshake is forked, not reused (§02)** (`src/main/ssh/orcad-remote-launch.ts`). The relay proves itself by printing an `ORCA-RELAY` sentinel. orcad publishes one `orca_server_ready` JSON line carrying its health payload, captured from a file in its version directory, so the deploy can disconnect while the server keeps running.
- **Rollback relies on a pre-activation snapshot (§04)** (`src/main/ssh/orcad-state-snapshot.ts`). The state-schema row asked for "backward-readable migrations or a pre-activation snapshot". Persisted state carries no schema version, so only the snapshot can be proven. The snapshot excludes `<root>/daemon`, which belongs to a daemon that outlives every server restart.
