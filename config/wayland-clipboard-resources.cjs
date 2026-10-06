const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

function ensureBundledWaylandClipboard(archEnum, root = join(__dirname, '..'), run = spawnSync) {
  const arch = { 1: 'x64', 3: 'arm64' }[archEnum]
  if (!arch) {
    throw new Error(`Unsupported Wayland clipboard packaging architecture: ${archEnum}`)
  }
  const result = run(
    process.execPath,
    [join(root, 'config', 'scripts', 'build-wayland-clipboard.mjs'), '--arch', arch],
    { cwd: root, stdio: 'inherit' }
  )
  if (
    result.error ||
    result.status !== 0 ||
    !existsSync(join(root, 'native', 'wayland-clipboard', '.build', arch, 'orca-wayland-clipboard'))
  ) {
    throw new Error('The Linux package requires a built Wayland clipboard helper.')
  }
}

module.exports = { ensureBundledWaylandClipboard }
