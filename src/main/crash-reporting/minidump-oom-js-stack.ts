// Reduces the JS stack Electron records at a renderer's V8 heap limit to
// frames that name code but not the machine it ran on.
//
// Why: a renderer wedged in a synchronous allocation loop cannot run its own
// samplers, so this safe-point stack is the only evidence naming the loop.

export const ELECTRON_OOM_STACK_ANNOTATION = 'electron.v8-oom.stack'
export const ELECTRON_OOM_LOCATION_ANNOTATION = 'electron.v8-oom.location'
// V8's own key carries only the top frame; used when Electron's is absent.
export const V8_OOM_STACK_ANNOTATION = 'v8-oom-stack'

const MAX_FRAMES = 24
const MAX_FRAME_LENGTH = 160

// Script URLs embed the install dir (and so the OS user name); keep only the
// bundle basename and line:col, which release source maps resolve.
const SCRIPT_LOCATION_PATTERN =
  /(?:[A-Za-z][A-Za-z0-9+.-]*:)?[^\s()]*[/\\]([^/\\\s()?#]+)(?:[?#][^\s():]*)?(:\d+:\d+)/g

function sanitizeFrame(frame: string): string {
  const sanitized = frame.trim().replace(SCRIPT_LOCATION_PATTERN, '$1$2')
  return sanitized.length > MAX_FRAME_LENGTH
    ? `${sanitized.slice(0, MAX_FRAME_LENGTH)}...`
    : sanitized
}

/** `"<fn> in <url>:L:C"` (V8's top-frame form) -> `"<fn> (<basename>:L:C)"`. */
function sanitizeV8TopFrame(value: string): string | undefined {
  const match = /^(.*?) in (\S+:\d+:\d+)\s*$/.exec(value.trim())
  return match ? sanitizeFrame(`${match[1]} (${match[2]})`) : undefined
}

export function sanitizeOomJsStack(
  annotations: Readonly<Record<string, string>>
): string | undefined {
  const electronStack = annotations[ELECTRON_OOM_STACK_ANNOTATION]
  if (electronStack) {
    const frames = electronStack
      .split(/\r?\n/)
      .filter((frame) => frame.trim().length > 0)
      .slice(0, MAX_FRAMES)
      .map(sanitizeFrame)
    if (frames.length > 0) {
      return frames.join('\n')
    }
  }
  const v8TopFrame = annotations[V8_OOM_STACK_ANNOTATION]
  return v8TopFrame ? sanitizeV8TopFrame(v8TopFrame) : undefined
}
