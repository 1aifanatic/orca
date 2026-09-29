import { describe, expect, it } from 'vitest'
import { parseTerminalMouseModes } from './terminal-mouse-modes'

const modes = {
  seq: 50,
  mouseTracking: true,
  mouseTrackingMode: 'any',
  sgrMouseMode: false,
  sgrMousePixelsMode: false
}

describe('terminal mouse wire state', () => {
  it('accepts explicit legacy encoding and ignores additive fields', () => {
    expect(parseTerminalMouseModes({ ...modes, futureField: true })).toEqual(modes)
  })
  it.each([
    undefined,
    null,
    {},
    { ...modes, seq: -1 },
    { ...modes, mouseTrackingMode: 'future' },
    { ...modes, sgrMouseMode: undefined },
    { ...modes, mouseTracking: false },
    { ...modes, sgrMouseMode: true, sgrMousePixelsMode: true }
  ])('does not invent modes for %j', (value) => {
    expect(parseTerminalMouseModes(value)).toBeUndefined()
  })
})
