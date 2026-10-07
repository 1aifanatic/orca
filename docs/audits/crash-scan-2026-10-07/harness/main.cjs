// Hidden-window Blink style-churn harness on stock Electron 43.7.5 (same .text as release Orca.exe).
const { app, BrowserWindow, crashReporter } = require('electron')
const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}
const out = process.env.HARNESS_OUT
const minutes = Number(process.env.HARNESS_MINUTES || '10')
mkdirSync(out, { recursive: true })
app.setPath('userData', join(out, 'userData'))
app.setPath('crashDumps', join(out, 'crashDumps'))
crashReporter.start({ uploadToServer: false, compress: false })
const log = (o) =>
  appendFileSync(
    join(out, 'harness.ndjson'),
    `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`
  )
app.on('child-process-gone', (_e, d) => log({ ev: 'child-process-gone', ...d }))
app.whenReady().then(() => {
  const count = Number(process.env.HARNESS_WINDOWS || '2')
  const wins = []
  for (let i = 0; i < count; i++) {
    const w = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: { backgroundThrottling: false }
    })
    w.webContents.on('render-process-gone', (_e, d) =>
      log({ ev: 'render-process-gone', win: i, ...d })
    )
    w.loadFile(join(__dirname, 'page.html'))
    wins.push(w)
  }
  log({
    ev: 'start',
    minutes,
    windows: count,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  })
  const timer = setInterval(async () => {
    for (const [i, w] of wins.entries()) {
      if (w.isDestroyed() || w.webContents.isCrashed()) {
        continue
      }
      const s = await w.webContents
        .executeJavaScript(
          'JSON.stringify({tick: window.__stats.tick, heap: Math.round(performance.memory.usedJSHeapSize/1048576)})'
        )
        .catch((e) => String(e))
      log({ ev: 'stat', win: i, s })
    }
  }, 30000)
  setTimeout(() => {
    clearInterval(timer)
    log({ ev: 'end' })
    app.quit()
  }, minutes * 60000)
})
