import { writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForTerminalOutput } from './helpers/terminal'
import { assertLayerImagePixels, prepareLayerImage } from './helpers/terminal-inline-image-layers'
import {
  assertInlineImagePixels,
  assertKittyPlaceholderPixels,
  inlineImageProducer
} from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

for (const acceleration of ['off', 'on'] as const) {
  test(`${acceleration}: canvas sources preserve protocols and layering without the bitmap API`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      Object.defineProperty(window, 'createImageBitmap', { value: undefined, configurable: true })
    })
    const pty = await prepareLayerImage(orcaPage, testInfo, acceleration, -1, 128)
    await assertLayerImagePixels(orcaPage, testInfo.outputPath('canvas-layers.png'), -1, 128)
    const producer = testInfo.outputPath('canvas-protocols.cjs')
    writeFileSync(producer, inlineImageProducer(true))
    await execInTerminal(orcaPage, pty, nodeTerminalCommand([producer, 'CANVAS']))
    await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_CANVAS', 30_000)
    await assertInlineImagePixels(orcaPage, testInfo.outputPath('canvas-protocols.png'))
    await assertKittyPlaceholderPixels(orcaPage, testInfo.outputPath('canvas-placeholders.png'))
    expect(await orcaPage.evaluate(() => typeof window.createImageBitmap)).toBe('undefined')
  })
}
