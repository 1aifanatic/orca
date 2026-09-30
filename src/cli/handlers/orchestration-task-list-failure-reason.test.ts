import { describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'

describe('orchestration task-list plain output', () => {
  it('shows why a failed Task failed, so a cancellation reads as one', async () => {
    const result = {
      tasks: [
        { id: 'task_cancelled', spec: 'Port the parser', status: 'failed', result: 'cancelled' },
        { id: 'task_broken', spec: 'Fix the build', status: 'failed', result: null },
        {
          id: 'task_crashed',
          spec: 'Run the suite',
          status: 'failed',
          result: `worker exited\n  code 1 ${'x'.repeat(80)}`
        },
        { id: 'task_done', spec: 'Write docs', status: 'completed', result: 'shipped' }
      ],
      count: 4
    }
    callMock.mockReset().mockResolvedValue({ result })

    const flags = new Map([['run', 'run_1']])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only flags, client.call and json.
    const context = { flags, client: { call: callMock }, json: false } as never
    await ORCHESTRATION_HANDLERS['orchestration task-list'](context)

    const format = vi.mocked(printResult).mock.calls[0]?.[2]
    expect(format?.(result)).toBe(
      [
        'task_cancelled [failed] Port the parser: cancelled',
        'task_broken [failed] Fix the build',
        `task_crashed [failed] Run the suite: ${`worker exited code 1 ${'x'.repeat(80)}`.slice(0, 60)}`,
        'task_done [completed] Write docs'
      ].join('\n')
    )
  })
})
