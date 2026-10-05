import { afterEach, describe, expect, it, vi } from 'vitest'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { RuntimeClientError } from '../runtime-client'
import { MANAGED_SERVER_HANDLERS } from './managed-server'

function envelope(result: unknown) {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function client(result: unknown, capabilities = [MANAGED_SERVER_RUNTIME_CAPABILITY]) {
  return vi.fn(async (method: string) =>
    method === 'status.get' ? envelope({ capabilities }) : envelope(result)
  )
}

async function run(
  command: string,
  call: ReturnType<typeof client>,
  flags: [string, string | boolean][]
) {
  const handler = MANAGED_SERVER_HANDLERS[command]
  if (!handler) {
    throw new Error(`no handler for ${command}`)
  }
  await handler({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only call client.call.
    client: { call } as never,
    cwd: '/tmp',
    flags: new Map([['environment', 'build-box'], ...flags]),
    json: false
  })
}

afterEach(() => vi.restoreAllMocks())

describe('managed server CLI verbs', () => {
  it('refuses on a runtime that does not advertise managed servers, before calling the action', async () => {
    const call = client({ outcome: 'none' }, [])
    await expect(run('environment recover', call, [])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('reads an older runtime’s method_not_found as the same refusal', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return envelope({ capabilities: [MANAGED_SERVER_RUNTIME_CAPABILITY] })
      }
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    await expect(run('environment status', call, [])).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
  })

  it('needs --yes before stopping, and then calls the same stop the settings use', async () => {
    const stopped = {
      outcome: 'unlinked',
      verdict: 'exited',
      environmentId: 'env-1',
      sshTargetId: 'ssh-1',
      stoppedVersion: '1.0.0',
      retirement: null
    }
    const unconfirmed = client(stopped)
    await expect(run('environment stop', unconfirmed, [])).rejects.toMatchObject({
      code: 'confirmation_required'
    })
    expect(unconfirmed).not.toHaveBeenCalled()

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const confirmed = client(stopped)
    await run('environment stop', confirmed, [['yes', true]])
    expect(confirmed).toHaveBeenCalledWith('managedServer.stop', { selector: 'build-box' })
    expect(log).toHaveBeenCalledWith('Stopped build-box and unlinked it from this machine.')
  })

  it('fails the command with the refusal, so scripts see a non-zero exit', async () => {
    const refusal = {
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_stop_active_environment',
      reason: 'Choose another Active Server in Advanced before stopping this server.'
    }
    await expect(run('environment stop', client(refusal), [['yes', true]])).rejects.toMatchObject({
      code: 'managed_server_refused',
      message: refusal.reason,
      data: refusal
    })
  })

  it('passes --force to an update, and reports a deferred one as unsettled', async () => {
    const call = client({
      outcome: 'deferred',
      candidateVersion: '2.0.0',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are running.'
    })
    await expect(run('environment update', call, [])).rejects.toMatchObject({
      code: 'managed_server_deferred'
    })
    expect(call).toHaveBeenCalledWith('managedServer.update', {
      selector: 'build-box',
      force: false
    })

    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const forced = client({
      outcome: 'updated',
      environment: { name: 'build-box' },
      activeVersion: '2.0.0'
    })
    await run('environment update', forced, [['force', true]])
    expect(forced).toHaveBeenCalledWith('managedServer.update', {
      selector: 'build-box',
      force: true
    })
  })

  it('fails on an outcome a newer desktop added instead of printing undefined', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await expect(
      run('environment cancel-stop', client({ outcome: 'future-outcome' }), [])
    ).rejects.toMatchObject({ code: 'managed_server_future-outcome' })
    expect(log).not.toHaveBeenCalled()
  })

  it('prints a readable status', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await run(
      'environment status',
      client({
        activeVersion: '1.0.0',
        previousVersion: '0.9.0',
        rollbackAvailable: true,
        recovery: null,
        terminals: { liveSessions: null },
        migration: null,
        deferredUpdate: null
      }),
      []
    )
    expect(log.mock.calls[0]?.[0]).toBe(
      'Active version: 1.0.0\nPrevious version: 0.9.0 (rollback available)\nLive terminals: unverifiable'
    )
  })
})
