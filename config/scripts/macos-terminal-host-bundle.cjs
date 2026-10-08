// SPIKE: a small signed `com.stablyai.orca` bundle that runs the terminal daemon on the pinned Node.
const { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const MAC_TERMINAL_HOST_NAME = 'Orca Terminal Host'
const MAC_TERMINAL_HOST_EXECUTABLE = 'orca-terminal-host'
// Variant B's non-.app extension keeps LaunchServices from registering it as an app.
const MAC_TERMINAL_HOST_EXTENSIONS = ['app', 'bundle']
const macTerminalHostSignIgnore = [
  `/Contents/Helpers/${MAC_TERMINAL_HOST_NAME}\\.(${MAC_TERMINAL_HOST_EXTENSIONS.join('|')})(/|$)`
]
const NODE_PTY_FILES = [
  'package.json',
  'lib',
  join('build', 'Release', 'pty.node'),
  join('build', 'Release', 'spawn-helper')
]

function readPlist(path) {
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' })
  )
}

function writePlist(path, value) {
  writeFileSync(path, JSON.stringify(value))
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', path])
}

async function pinnedNodeFor(arch) {
  const { ensurePinnedNodeExecutable } = await import(
    pathToFileURL(resolve(__dirname, 'pinned-node-downloads.mjs')).href
  )
  return ensurePinnedNodeExecutable({ target: `darwin-${arch}` })
}

/**
 * Builds both spike variants in `Contents/Helpers` and signs each inside-out.
 * `signCode(path, { entitlements })` signs one path with the build's helper identity.
 */
async function assembleMacTerminalHostBundles({
  appPath,
  arch,
  iconPath,
  entitlementsPath,
  usageDescriptions,
  signCode
}) {
  const resourcesDir = join(appPath, 'Contents', 'Resources')
  const appInfo = readPlist(join(appPath, 'Contents', 'Info.plist'))
  const nodeExecutable = await pinnedNodeFor(arch)
  const daemonOut = join(resourcesDir, 'app.asar.unpacked', 'out')
  const nodePty = join(resourcesDir, 'node_modules', 'node-pty')
  for (const required of [join(daemonOut, 'main', 'daemon-entry.js'), nodePty]) {
    if (!existsSync(required)) {
      throw new Error(`[macos-terminal-host] missing ${required}`)
    }
  }
  const info = {
    ...usageDescriptions,
    CFBundleIdentifier: appInfo.CFBundleIdentifier,
    CFBundleName: 'Orca',
    CFBundleDisplayName: 'Orca',
    CFBundleExecutable: MAC_TERMINAL_HOST_EXECUTABLE,
    CFBundlePackageType: 'APPL',
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleIconFile: 'icon.icns',
    // Lower than the app's so LaunchServices ranks the helper below Orca.app among duplicates.
    CFBundleVersion: '0',
    CFBundleShortVersionString: appInfo.CFBundleShortVersionString,
    LSMinimumSystemVersion: appInfo.LSMinimumSystemVersion,
    LSUIElement: true
  }
  const helpers = join(appPath, 'Contents', 'Helpers')
  mkdirSync(helpers, { recursive: true })
  const bundles = []
  for (const extension of MAC_TERMINAL_HOST_EXTENSIONS) {
    const bundle = join(helpers, `${MAC_TERMINAL_HOST_NAME}.${extension}`)
    rmSync(bundle, { recursive: true, force: true })
    const contents = join(bundle, 'Contents')
    const daemon = join(contents, 'Resources', 'daemon')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    cpSync(nodeExecutable, join(contents, 'MacOS', MAC_TERMINAL_HOST_EXECUTABLE))
    chmodSync(join(contents, 'MacOS', MAC_TERMINAL_HOST_EXECUTABLE), 0o755)
    cpSync(iconPath, join(contents, 'Resources', 'icon.icns'))
    cpSync(join(daemonOut, 'main'), join(daemon, 'out', 'main'), { recursive: true })
    // Pins out/ to CommonJS so a stray parent package.json cannot change the loader.
    cpSync(join(daemonOut, 'package.json'), join(daemon, 'out', 'package.json'))
    for (const file of NODE_PTY_FILES) {
      cpSync(join(nodePty, file), join(daemon, 'node_modules', 'node-pty', file), {
        recursive: true
      })
    }
    const ptyRelease = join(daemon, 'node_modules', 'node-pty', 'build', 'Release')
    chmodSync(join(ptyRelease, 'spawn-helper'), 0o755)
    writePlist(join(contents, 'Info.plist'), info)
    await signCode(join(ptyRelease, 'pty.node'), {})
    await signCode(join(ptyRelease, 'spawn-helper'), {})
    await signCode(bundle, { entitlements: entitlementsPath })
    bundles.push(bundle)
  }
  return bundles
}

module.exports = {
  MAC_TERMINAL_HOST_NAME,
  assembleMacTerminalHostBundles,
  macTerminalHostSignIgnore
}
