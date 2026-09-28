import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      experimental: {
        fsModuleCache: process.env.ORCA_PILOT_FS_CACHE === 'true',
        fsModuleCachePath: '.tmp/ci-vitest-pilot-cache'
      }
    }
  })
)
