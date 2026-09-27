import { expect } from './helpers/orca-app'

type ScrollSample = { time: number; scrollTop: number }

export function measureSidebarScroll(samples: ScrollSample[], initialOffset = 0) {
  const finalOffset = samples.at(-1)!.scrollTop
  const intermediate = samples.filter(
    (sample) => sample.scrollTop > initialOffset && sample.scrollTop < finalOffset - 2
  )
  const lastInFlight = samples.findLastIndex(
    (sample) => Math.abs(sample.scrollTop - finalOffset) > 2
  )
  const moving = samples.slice(0, lastInFlight + 2)
  let lastOffset = initialOffset
  let stationarySince = 0
  let longestPause = 0
  for (const sample of samples) {
    // Include the initial wait and the interval ending with the next movement.
    if (Math.abs(lastOffset - finalOffset) > 2) {
      longestPause = Math.max(longestPause, sample.time - stationarySince)
    }
    if (sample.scrollTop !== lastOffset) {
      lastOffset = sample.scrollTop
      stationarySince = sample.time
    }
  }
  return {
    finalOffset,
    longestPause,
    maxFrameGap: Math.max(
      ...moving.map((sample, index) => sample.time - (moving[index - 1]?.time ?? 0))
    ),
    intermediateSamples: intermediate.length,
    intermediateOffsets: new Set(intermediate.map((sample) => sample.scrollTop)).size,
    arrivalMs: moving.at(-1)?.time ?? null
  }
}

export function expectSidebarScrollProgress(metrics: ReturnType<typeof measureSidebarScroll>) {
  // Several distinct in-flight positions reject jump-only and sparsely observed animations.
  expect(
    metrics.intermediateOffsets,
    'distinct intermediate scroll positions'
  ).toBeGreaterThanOrEqual(4)
  expect(metrics.maxFrameGap, 'in-animation native frame gap').toBeLessThan(200)
}
