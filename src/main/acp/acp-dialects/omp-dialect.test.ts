import { describe, expect, it } from 'vitest'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { OMP_ACP_DIALECT } from './omp-dialect'

const text = (value: string) => ({
  type: 'content' as const,
  content: { type: 'text' as const, text: value }
})
const normalize = (update: ToolCallUpdate) => OMP_ACP_DIALECT.normalizeToolUpdate!(update)

describe('OMP tool updates', () => {
  it('leaves a tool without a command echo as it came', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'file body' }], details: {} },
      content: [text('file body')]
    }
    expect(normalize(update)).toBe(update)
  })

  it('keeps a result that itself starts with "$ "', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: '$ 5.00' }], details: {} },
      content: [text('$ 5.00')]
    }
    expect(normalize(update)).toBe(update)
  })

  it('keeps output that only looks like a notice when OMP sent no matching detail', () => {
    const update = normalize({
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: {
        content: [{ type: 'text', text: 'done\n\nCommand exited with code 3' }],
        details: {}
      },
      content: [text('$ ./run'), text('done\n\nCommand exited with code 3')]
    })
    expect(update).toMatchObject({
      content: [],
      rawOutput: { stdout: 'done\n\nCommand exited with code 3', exitCode: 0 }
    })
  })

  const command = (
    status: ToolCallUpdate['status'],
    details: Record<string, unknown>,
    rawInput?: unknown
  ): ToolCallUpdate => ({
    toolCallId: 'call-1',
    status,
    ...(rawInput === undefined ? {} : { rawInput }),
    rawOutput: { content: [{ type: 'text', text: 'ok' }], details },
    content: [text('$ ./run'), text('ok')]
  })

  it('shows exit 0 for a foreground command that completed, since OMP omits a zero exit', () => {
    expect(normalize(command('completed', { wallTimeMs: 12 })).rawOutput).toMatchObject({
      stdout: 'ok',
      exitCode: 0
    })
    expect(normalize(command('completed', { signal: null })).rawOutput).toMatchObject({
      exitCode: 0
    })
  })

  it('infers no exit code for a command that is running, timed out, signalled or in the background', () => {
    for (const update of [
      command('in_progress', {}),
      command('completed', { timedOut: true }),
      command('completed', { signal: 'SIGTERM' }),
      command('completed', { async: { jobId: 'job-1' } }),
      command('completed', {}, { command: './run', async: true })
    ]) {
      expect(normalize(update).rawOutput).not.toHaveProperty('exitCode')
    }
  })

  it("keeps a failed command's reported exit code", () => {
    const update = normalize({
      toolCallId: 'call-1',
      status: 'failed',
      rawOutput: {
        content: [{ type: 'text', text: 'hi\n\nCommand exited with code 3' }],
        details: { exitCode: 3 }
      },
      content: [text('$ ./run'), text('hi\n\nCommand exited with code 3')]
    })
    expect(update.rawOutput).toMatchObject({ stdout: 'hi', exitCode: 3 })
  })
})
