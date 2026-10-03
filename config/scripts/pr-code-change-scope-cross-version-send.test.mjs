import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

// #24901 changed the shared agent-send path and the send envelope builders, and this job skipped.
describe('cross-version wire routing for agent sends', () => {
  it.each([
    'src/shared/agent-session-wire-refusals.ts',
    'src/shared/structured-agent-session-mutation.ts',
    'src/shared/structured-agent-session-send-mutation.ts',
    'src/shared/structured-agent-session-outbox.ts',
    'src/shared/structured-agent-session-outbox-admission.ts',
    'src/shared/structured-agent-session-outbox-delivery.ts',
    'src/main/runtime/orchestration/send-agent-turn.ts',
    'src/main/runtime/orchestration/orchestration-caller-identity.ts',
    'src/main/runtime/orchestration/db/schema/migrate.ts',
    'src/main/runtime/rpc/methods/orchestration.ts',
    'src/main/runtime/rpc/methods/orchestration-structured-worker-session.ts',
    'src/main/runtime/rpc/methods/orchestration/runs/dispatch-methods.ts',
    'src/main/runtime/rpc/methods/orchestration/worker/deliver-worker-dispatch-preamble.ts'
  ])('runs the cross-version suites when %s changes', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': true })
  })

  it.each([
    'src/shared/structured-agent-session-composer.ts',
    'src/shared/structured-agent-session-reducer.ts',
    'src/shared/structured-agent-session-turn-timing.ts',
    'src/main/runtime/rpc/methods/repo.ts'
  ])('leaves them off for %s, which no build exchanges with another', (file) => {
    expect(classifyPrJobs([file])).toMatchObject({ should_run: true, 'cross-version-wire': false })
  })
})
