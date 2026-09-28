// Which bytes the branch graph gets to see. A read pins ONE file and ONE size
// before it starts, and every consumer of that read sees the same lines: a
// caller that walks the proven branch must walk the snapshot the proof was
// computed over, and bytes appended after the pin are never evidence.

import { open, stat } from 'node:fs/promises'
import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import {
  createBranchProof,
  unparsableTranscriptLine,
  type BranchProofInput,
  type ClaudeTranscriptBranchProof
} from './claude-transcript-branch-graph'

export {
  ClaudeTranscriptPreviousCursorMissingError,
  ClaudeTranscriptTailIncompleteError
} from './claude-transcript-branch-graph'
export type { ClaudeTranscriptBranchProof } from './claude-transcript-branch-graph'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export type ClaudeTranscriptBranchAncestry = {
  proof: ClaudeTranscriptBranchProof
  /** Leaf first, anchor excluded. */
  chain: string[]
}

function recordUuid(record: unknown): string | null {
  return record && typeof record === 'object' && 'uuid' in record
    ? nonEmptyString(record.uuid)
    : null
}

/**
 * The branch proof as one consumer of a shared line pass: the caller parses each
 * line once and hands it to every consumer. A line the proof rejects ends the
 * proof, not the read, so the other consumers still see the whole file.
 */
export function createClaudeBranchAncestryPass(
  input: Omit<BranchProofInput, 'tip'> & {
    /** The ancestry walk stops here; the proof is what established it is reachable. */
    ancestryAnchorUuid: string
  }
) {
  // Replay always proves from the file tail, where a resume by session id continues.
  const builder = createBranchProof({ ...input, tip: 'file-tail' })
  let failure: { error: unknown } | null = null
  return { add, reject, finish }

  /** Returns the record's uuid when it is the FIRST line carrying it, which is the
   *  record the chain reports for that uuid; null otherwise or once the proof failed. */
  function add(record: unknown, index: number): string | null {
    if (failure) {
      return null
    }
    const uuid = recordUuid(record)
    const firstSeen = uuid !== null && !builder.has(uuid)
    try {
      builder.addParsed(record, index)
    } catch (error) {
      failure = { error }
      return null
    }
    return firstSeen ? uuid : null
  }

  function reject(terminated: boolean): void {
    failure ??= { error: unparsableTranscriptLine(terminated) }
  }

  /** Throws for every branch the proof cannot vouch for. */
  function finish(): ClaudeTranscriptBranchAncestry {
    if (failure) {
      throw failure.error
    }
    const proof = builder.finish()
    return { proof, chain: builder.ancestryChain(proof.leafUuid, input.ancestryAnchorUuid) }
  }
}

export function proveClaudeTranscriptBranchFromJsonl(
  input: BranchProofInput & { contents: string }
): ClaudeTranscriptBranchProof {
  const proof = createBranchProof(input)
  const lines = input.contents.split('\n')
  for (const [index, line] of lines.entries()) {
    proof.add(line, index, index < lines.length - 1)
  }
  return proof.finish()
}

/** The transcript as it stood when pinned: this file, up to this size. */
export type ClaudeTranscriptSnapshot = {
  transcriptPath: string
  size: number
  dev: bigint
  ino: bigint
}

/** One `stat`: cheap enough to take on every attach, before anything can append. */
export async function pinClaudeTranscript(
  transcriptPath: string
): Promise<ClaudeTranscriptSnapshot> {
  const stats = await stat(transcriptPath, { bigint: true })
  return { transcriptPath, size: Number(stats.size), dev: stats.dev, ino: stats.ino }
}

/**
 * Stream exactly the pinned bytes, once. Nothing appended after the pin is read,
 * because a provider child started since may be what appended it. A file that is
 * no longer the pinned one, or no longer holds the pinned bytes, throws rather
 * than pass a different transcript off as the pinned one.
 */
export async function readPinnedClaudeTranscript(
  snapshot: ClaudeTranscriptSnapshot,
  maxRecordBytes: number,
  onLine: (line: string, terminated: boolean) => void
): Promise<void> {
  const handle = await open(snapshot.transcriptPath, 'r')
  try {
    const current = await handle.stat({ bigint: true })
    if (
      current.dev !== snapshot.dev ||
      current.ino !== snapshot.ino ||
      current.size < BigInt(snapshot.size)
    ) {
      throw new Error('Claude transcript was replaced or truncated after it was pinned')
    }
    if (snapshot.size === 0) {
      return
    }
    const stream = handle.createReadStream({ start: 0, end: snapshot.size - 1, autoClose: false })
    for await (const { line, terminated } of splitTranscriptStreamLines(stream, maxRecordBytes)) {
      onLine(line, terminated)
    }
    if (stream.bytesRead !== snapshot.size) {
      throw new Error('Claude transcript was truncated while it was read')
    }
  } finally {
    await handle.close()
  }
}
