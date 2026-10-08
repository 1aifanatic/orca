export type PosixStdoutFence = {
  /** POSIX script that prints the begin marker, runs the payload, then prints the end marker. */
  command: string
  /** Payload the command wrote, or null when the fence never appeared. */
  readStdout: (stdout: string) => string | null
  // Why exposed: binary reads (`git show` blob content) must slice bytes rather
  // than decode to a string first, and this module is bundled for the renderer,
  // so it cannot reference Buffer itself.
  beginMarker: string
  endMarker: string
}

// Why: the fence has to be absent from both the rc output ahead of it and the
// payload behind it. A per-call nonce is the only spelling that guarantees
// both -- `cat`-ing a file that happens to quote a fixed marker would otherwise
// truncate the file. Not security-sensitive, so Math.random is sufficient.
function nextPosixStdoutFenceNonce(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Fence `command`'s stdout so startup-file output ahead of it is never read as data.
 *
 * Why: a login shell (WSL's, or the one sshd runs before any exec) reads the
 * user's rc files, and anything they write to stdout -- a banner, an `echo`,
 * a bare terminal-title escape -- lands in the same captured stream as the
 * payload. `label` only keeps markers from different transports distinguishable.
 */
export function buildPosixStdoutFence(
  command: string,
  label: string,
  nonce: string = nextPosixStdoutFenceNonce()
): PosixStdoutFence {
  const markers = fenceMarkers(label, nonce)
  return {
    ...markers,
    command: [
      // Markers are [A-Za-z0-9_] only, so plain single quotes are exact.
      `printf %s '${markers.beginMarker}'`,
      command,
      '_orca_capture_status=$?',
      `printf %s '${markers.endMarker}'`,
      'exit $_orca_capture_status'
    ].join('\n')
  }
}

/**
 * Same fence on one line that sh, bash, zsh, fish and csh all parse, for a payload run by the
 * user's own login shell. It cannot carry the payload's exit status (fish and csh have no `$?`),
 * so the command always exits with the closing printf's status.
 */
export function buildAnyShellStdoutFence(
  command: string,
  label: string,
  nonce: string = nextPosixStdoutFenceNonce()
): PosixStdoutFence {
  const markers = fenceMarkers(label, nonce)
  return {
    ...markers,
    // Unquoted: nested quoting differs between these shells, and the markers need none.
    command: `printf %s ${markers.beginMarker}; ${command}; printf %s ${markers.endMarker}`
  }
}

function fenceMarkers(label: string, nonce: string): Omit<PosixStdoutFence, 'command'> {
  const begin = `__ORCA_${label}_CAPTURE_BEGIN_${nonce}__`
  const end = `__ORCA_${label}_CAPTURE_END_${nonce}__`
  return {
    beginMarker: begin,
    endMarker: end,
    readStdout: (stdout) => {
      // Why lastIndexOf: a login shell can echo the command text before running
      // it (`set -x` in an rc file), which repeats the opening fence verbatim.
      // The real payload always follows the last one. The nonce keeps a payload
      // that happens to quote a marker from colliding.
      const beginIndex = stdout.lastIndexOf(begin)
      if (beginIndex === -1) {
        return null
      }
      const payloadStart = beginIndex + begin.length
      const endIndex = stdout.indexOf(end, payloadStart)
      // A payload that exited early never prints the closing fence; the rest of
      // the stream is still its output, and login shells run exit hooks after it.
      return endIndex === -1 ? stdout.slice(payloadStart) : stdout.slice(payloadStart, endIndex)
    }
  }
}
