import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config'

// Set by run-node-server-tests.mjs --artifact to the packaged slot's node-pty.
const packagedNodePty = process.env.ORCA_NODE_SERVER_NODE_PTY

// Why: the server lane installs dependencies without building node-pty (Linux ships no upstream
// prebuild), and orcad loads the slot's addon under the pinned Node, so real-PTY tests should too.
export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: {
      ...baseConfig.resolve?.alias,
      ...(packagedNodePty ? { 'node-pty': resolve(packagedNodePty) } : {})
    }
  }
})
