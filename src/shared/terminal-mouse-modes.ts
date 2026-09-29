/** Mouse fields from the host's existing TerminalModes, at one output boundary. */
export type TerminalMouseModes = {
  seq: number
  mouseTracking: boolean
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  sgrMouseMode: boolean
  sgrMousePixelsMode: boolean
}

/** Missing or future fields cannot establish an encoding. */
export function parseTerminalMouseModes(value: unknown): TerminalMouseModes | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  if (
    !('seq' in value) ||
    !('mouseTracking' in value) ||
    !('mouseTrackingMode' in value) ||
    !('sgrMouseMode' in value) ||
    !('sgrMousePixelsMode' in value)
  ) {
    return undefined
  }
  const { seq, mouseTracking, mouseTrackingMode, sgrMouseMode, sgrMousePixelsMode } = value
  if (
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    typeof mouseTracking !== 'boolean' ||
    typeof sgrMouseMode !== 'boolean' ||
    typeof sgrMousePixelsMode !== 'boolean'
  ) {
    return undefined
  }
  if (
    mouseTrackingMode !== 'none' &&
    mouseTrackingMode !== 'x10' &&
    mouseTrackingMode !== 'vt200' &&
    mouseTrackingMode !== 'drag' &&
    mouseTrackingMode !== 'any'
  ) {
    return undefined
  }
  if (mouseTracking !== (mouseTrackingMode !== 'none') || (sgrMouseMode && sgrMousePixelsMode)) {
    return undefined
  }
  return { seq, mouseTracking, mouseTrackingMode, sgrMouseMode, sgrMousePixelsMode }
}

export function sameTerminalMouseModes(a: TerminalMouseModes, b: TerminalMouseModes): boolean {
  return (
    a.mouseTracking === b.mouseTracking &&
    a.mouseTrackingMode === b.mouseTrackingMode &&
    a.sgrMouseMode === b.sgrMouseMode &&
    a.sgrMousePixelsMode === b.sgrMousePixelsMode
  )
}
