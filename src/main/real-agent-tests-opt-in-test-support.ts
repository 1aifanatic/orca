// The one switch every test that starts a real agent CLI checks first. Those tests run the
// CLI against the developer's own config and account, so a broad local run must never start one.

export const REAL_AGENT_TESTS_ENV = 'ORCA_RUN_REAL_AGENT_TESTS'

export function realAgentTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[REAL_AGENT_TESTS_ENV] === '1'
}
