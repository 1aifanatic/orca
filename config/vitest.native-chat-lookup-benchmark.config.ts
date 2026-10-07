import { defineConfig } from 'vitest/config'
import baseConfig from './vitest.config'

// Why no projects: the base config's projects carry their own includes and would run every suite.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    projects: undefined,
    env: { ...baseConfig.test?.env, ORCA_NATIVE_CHAT_LOOKUP_BENCH: '1' },
    include: ['src/renderer/src/components/native-chat/native-chat-workspace-lookup.benchmark.tsx'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0
  }
})
