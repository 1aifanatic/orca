import { writeFile } from 'node:fs/promises'
import type { Page, TestInfo } from '@stablyai/playwright-test'

export async function beginRevealCpuProfile(page: Page, testInfo: TestInfo) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const before = await cdp.send('Performance.getMetrics')
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
  await cdp.send('Profiler.start')
  return async () => {
    try {
      const { profile } = await cdp.send('Profiler.stop')
      const after = await cdp.send('Performance.getMetrics')
      const path = testInfo.outputPath('reveal.cpuprofile')
      await writeFile(path, JSON.stringify(profile))
      await testInfo.attach('reveal.cpuprofile', { path, contentType: 'application/json' })
      const clocksPath = testInfo.outputPath('reveal-profile-clocks.json')
      await writeFile(clocksPath, JSON.stringify({ before, after }))
      await testInfo.attach('reveal-profile-clocks.json', { path: clocksPath, contentType: 'application/json' })
    } finally {
      await cdp.detach()
    }
  }
}
