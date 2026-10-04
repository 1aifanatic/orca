import { describe, expect, it } from 'vitest'
import { sshHostServerStatusLine } from './ssh-host-server-status-copy'

const plain = {}

describe('SSH host server status line', () => {
  it('says nothing for a plain host before any decision', () => {
    expect(sshHostServerStatusLine(plain, undefined)).toBeNull()
  })

  it('names the managed server, setup progress and why a host stays on the relay', () => {
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'managed', environmentId: 'e' } })
    ).toMatchObject({ tone: 'muted', text: 'Runs a managed Orca server' })
    expect(
      sshHostServerStatusLine(plain, { managedServer: { kind: 'setting-up', phase: 'converting' } })
        ?.text
    ).toContain('Moving this host')
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'relay_terminals_live', terminals: 3 }
      })?.text
    ).toContain('3 open terminals')
    expect(
      sshHostServerStatusLine(plain, {
        managedServer: { kind: 'relay', reason: 'refused', detail: 'An automation runs here.' }
      })
    ).toMatchObject({
      tone: 'destructive',
      text: expect.stringContaining('An automation runs here.')
    })
  })

  it('keeps durable reasons visible without a live state', () => {
    expect(sshHostServerStatusLine({ orcadFence: { environmentId: 'e' } }, undefined)?.text).toBe(
      'Runs a managed Orca server'
    )
    expect(
      sshHostServerStatusLine(
        { orcadFence: { environmentId: 'e', sourceChangedAt: '2026-10-05T00:00:00Z' } },
        { managedServer: { kind: 'managed', environmentId: 'e' } }
      )
    ).toMatchObject({ tone: 'warning' })
    expect(
      sshHostServerStatusLine(
        { managedServerUnavailable: { reason: 'native_preflight', appVersion: '1.5.0' } },
        undefined
      )?.text
    ).toContain('native_preflight')
  })

  it('says plainly when neither port forwarding nor the SSH session reaches a managed server', () => {
    const live = sshHostServerStatusLine(plain, {
      managedServer: {
        kind: 'relay',
        reason: 'orcad_unavailable',
        detail: 'ssh_tunnel_unavailable'
      }
    })
    const recorded = sshHostServerStatusLine(
      { managedServerUnavailable: { reason: 'ssh_tunnel_unavailable', appVersion: '1.5.0' } },
      undefined
    )
    for (const line of [live, recorded]) {
      expect(line).toMatchObject({
        tone: 'warning',
        text: expect.stringContaining('doesn’t allow port forwarding')
      })
    }
  })

  it('reads an older build’s forwarding refusal as a host that moves on a later connect', () => {
    expect(
      sshHostServerStatusLine(
        { managedServerUnavailable: { reason: 'tcp_forwarding_refused', appVersion: '1.4.0' } },
        undefined
      )
    ).toMatchObject({ tone: 'muted', text: expect.stringContaining('later connect') })
  })
})
