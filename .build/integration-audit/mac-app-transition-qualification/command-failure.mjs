// Preserve machine-readable causes without publishing messages, arguments, tokens or stack traces.
export function summarizeCommandFailure(stdout, stderr, exitCode, signal, failure) {
  const result = { exitCode, signal: signal ?? null, failure: failure ?? null }
  const safeCode = value => typeof value === 'string' && /^(?:[a-z][a-z0-9_]{0,63}|[A-Z][A-Z0-9_]{0,39})$/.test(value) ? value : undefined
  for (const output of [stdout, stderr]) {
    for (const line of output.split('\n')) {
      try {
        const data = JSON.parse(line)
        if (data?.ok === false && safeCode(data.error?.code)) result.errorCode = safeCode(data.error.code)
      } catch {}
    }
  }
  const systemCodes = ['ENAMETOOLONG', 'ECONNREFUSED', 'ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'EINVAL', 'ETIMEDOUT', 'ENOSPC']
  result.systemCodes = systemCodes.filter(code => new RegExp(`\\b${code}\\b`).test(stderr))
  const categories = [
    ['socket-path-too-long', /(?:socket|AF_UNIX|path).{0,60}(?:too long|longer than)/i],
    ['daemon-connection-timeout', /(?:connect|connection).{0,30}timed?\s*out/i],
    ['daemon-authentication-failed', /(?:auth|token).{0,30}(?:invalid|mismatch|failed)/i],
    ['daemon-protocol-mismatch', /protocol.{0,30}(?:mismatch|incompatible)/i]
  ]
  result.categories = categories.filter(([, pattern]) => pattern.test(stderr)).map(([name]) => name)
  return result
}
