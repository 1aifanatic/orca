import { test, expect } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test('collapses a selection beside a document link without rewriting the link', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-markdown-links',
    'selection',
    testInfo.workerIndex,
    '[[Guide]]after\n\nSelecting text beside a document link should keep the link intact.'
  )
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await expect(editor.locator('[data-doc-link-target="Guide"]')).toHaveCount(1)
  await editor.evaluate((element) => {
    const instance: unknown = Reflect.get(element, 'editor')
    if (!instance || typeof instance !== 'object') {
      throw new Error('Editor unavailable')
    }
    const commands: unknown = Reflect.get(instance, 'commands')
    const select: unknown =
      commands && typeof commands === 'object' ? Reflect.get(commands, 'setTextSelection') : null
    if (typeof select !== 'function') {
      throw new Error('Selection unavailable')
    }
    element.focus()
    Reflect.apply(select, commands, [{ from: 2, to: 7 }])
  })
  expect(await orcaPage.evaluate(() => window.getSelection()?.toString())).toBe('after')
  await orcaPage.keyboard.press('ArrowLeft')
  await orcaPage.screenshot({ path: testInfo.outputPath('link-after-collapse.png') })
  await expect(editor.locator('[data-doc-link-target="Guide"]')).toHaveCount(1)
  await expect(editor.locator('p').first()).toHaveText('Guideafter')
  await expect.poll(() => orcaPage.evaluate(() => window.getSelection()?.toString())).toBe('')
})
