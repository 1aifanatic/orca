// Runs before main sends a pane's output or exit to the renderer, so anything an agent committed
// before it printed or exited (a hook event) reaches the renderer's status ahead of that output —
// the order the blocking hook POST used to give. Wired to the hook server at startup.
let rendererPublishBarrier: (() => void) | null = null

export function setRendererPublishBarrier(barrier: (() => void) | null): void {
  rendererPublishBarrier = barrier
}

export function runRendererPublishBarrier(): void {
  try {
    rendererPublishBarrier?.()
  } catch (error) {
    console.error('[pty] renderer publish barrier failed:', error)
  }
}
