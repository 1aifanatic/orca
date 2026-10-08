import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import {
  createOrcadDecommissionTransaction,
  withOrcadDecommissionStopDispatched
} from '../ssh/orcad-decommission-transaction'
import { emptyOrcadActivationRecord } from '../ssh/orcad-activation-record'
import { ORCAD_ACTIVATION_TRANSACTION_FILENAME } from '../ssh/orcad-activation-transaction'
import { orcadManagedStopIsUserRequested } from './orcad-managed-stop-intent'

const request = {
  schemaVersion: 1 as const,
  transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
  version: '1.0.0',
  runtimeId: 'runtime-1',
  instance: { pid: 42, startedAtMs: 1, nonce: 'nonce', lockPath: '/data/lock' }
}

it('recognizes an older desktop Settings stop from its matching existing transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'orcad-stop-intent-'))
  try {
    const transaction = withOrcadDecommissionStopDispatched(
      createOrcadDecommissionTransaction({
        transactionId: request.transactionId,
        recordBefore: { ...emptyOrcadActivationRecord(), active: request.version },
        now: new Date(1)
      }),
      request,
      new Date(2)
    )
    writeFileSync(join(root, ORCAD_ACTIVATION_TRANSACTION_FILENAME), JSON.stringify(transaction))
    expect(orcadManagedStopIsUserRequested(request, root)).toBe(true)
    expect(orcadManagedStopIsUserRequested({ ...request, runtimeId: 'other' }, root)).toBe(false)
    expect(
      orcadManagedStopIsUserRequested(
        { ...request, instance: { ...request.instance, nonce: 'other' } },
        root
      )
    ).toBe(false)
    expect(
      orcadManagedStopIsUserRequested(
        { ...request, transactionId: 'f11f43dc-e3d9-497c-8c6e-d86ae7e54f7c' },
        root
      )
    ).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('honors explicit user intent even when the activation journal is unreadable', () => {
  const root = mkdtempSync(join(tmpdir(), 'orcad-stop-intent-'))
  try {
    writeFileSync(join(root, ORCAD_ACTIVATION_TRANSACTION_FILENAME), '{')
    expect(orcadManagedStopIsUserRequested(request, root)).toBe(false)
    expect(orcadManagedStopIsUserRequested({ ...request, intent: 'user' }, root)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
