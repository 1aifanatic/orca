import base from './playwright.config'
export default {
  ...base, testDir: './e2e', workers: 1,
  use: { ...base.use, trace: 'off' },
  projects: [{ name: 'electron-headless', testMatch: 'sidebar-matched-motion.spec.ts', metadata: { orcaHeadful: false } }]
}
