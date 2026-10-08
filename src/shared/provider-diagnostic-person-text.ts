// An audience label cannot make protocol records, error codes or stack traces readable copy.
const TECHNICAL_TEXT = [
  /^\s*[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+(?:\s*:|\s*$)/,
  /\b(?:[A-Za-z]*Error|Exception)\s*:/,
  /\bE[A-Z][A-Z0-9]{2,}\b/,
  /\b(?:HTTP\/\d|(?:HTTP|RPC|JSON-RPC)\s+(?:[-+]?\d+|error|response))/i,
  /(?:^|\n)\s*(?:at\s+\S+|Caused by:|Traceback\s*\()/,
  /[[{]\s*"[^"\n]+"\s*:/,
  /^\s*[[{]/,
  /(?:^|\n)\s*(?:data|event):/,
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/i,
  /(?:^|\n)\s*(?:stream|connection|request|transport)\s+(?:disconnected|reset|failed|aborted|timed out)\b/i,
  /\b\w+\.(?:[cm]?[jt]s|py|rs|go):\d+(?::\d+)?\b/
]

function hasControlCharacters(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0)
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127) {
      return true
    }
  }
  return false
}

export function isProviderDiagnosticPersonText(text: string): boolean {
  return (
    text.trim().length > 0 &&
    !hasControlCharacters(text) &&
    !TECHNICAL_TEXT.some((pattern) => pattern.test(text))
  )
}
