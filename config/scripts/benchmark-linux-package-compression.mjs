import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { packageLinuxFormats } from './package-linux-formats.mjs'
import { spawnProcess } from './script-child-process.mjs'

const require = createRequire(import.meta.url)
const root = resolve(process.env.RUNNER_TEMP, 'linux-compression-benchmark')
mkdirSync(root, { recursive: true })
const measurements = []
for (const sample of [1, 2, 3]) {
  // Reverse alternate pairs to reduce filesystem and temperature ordering bias.
  const order = sample % 2 ? ['baseline', 'level1'] : ['level1', 'baseline']
  for (const variant of order) {
    const outputDirectory = join(root, `${sample}-${variant}`)
    const started = performance.now()
    await packageLinuxFormats({
      outputDirectory,
      runBuilder: (args) =>
        new Promise((resolveBuild, reject) => {
          const argv =
            variant === 'baseline'
              ? args.map((arg) =>
                  arg === 'config/electron-builder-pr-linux.config.cjs'
                    ? 'config/electron-builder.config.cjs'
                    : arg
                )
              : args
          const child = spawnProcess({
            program: process.execPath,
            args: [require.resolve('electron-builder/cli.js'), ...argv],
            env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
            stdio: 'inherit'
          })
          child.once('error', reject)
          child.once('close', (code) =>
            code === 0 ? resolveBuild() : reject(new Error(`builder exit ${code}`))
          )
        })
    })
    const seconds = (performance.now() - started) / 1000
    const bytes = Object.fromEntries(
      readdirSync(outputDirectory)
        .filter((file) => /\.(AppImage|deb|rpm)$/.test(file))
        .map((file) => [file, statSync(join(outputDirectory, file)).size])
    )
    measurements.push({ sample, variant, seconds, bytes })
    console.log(`COMPRESSION_MEASUREMENT ${JSON.stringify(measurements.at(-1))}`)
    // Keep the first pair for payload comparison; later pairs only measure time and size.
    if (sample !== 1) {
      rmSync(outputDirectory, { recursive: true, force: true })
    }
  }
}
writeFileSync(join(root, 'measurements.json'), JSON.stringify(measurements, null, 2))
