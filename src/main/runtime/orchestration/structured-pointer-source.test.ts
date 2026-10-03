import { describe, expect, it } from 'vitest'
import { structuredPointerSource, type PointerBatchMessage } from './structured-pointer-source'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

function mail(
  id: string,
  from: string,
  overrides: Partial<PointerBatchMessage> = {}
): PointerBatchMessage {
  return {
    id,
    type: 'status',
    sequence: 1,
    from_handle: from,
    sender_pane_key: null,
    run_id: 'r1',
    ...overrides
  }
}

describe('who a mail notice speaks for', () => {
  it('names each sender once, in mail order, with the pane the mail recorded and the records it counts', () => {
    const source = structuredPointerSource({
      // No database: a terminal handle and a session address name their party by themselves.
      db: null,
      mailboxHandle: 'run:r1',
      dispatchId: null,
      batch: [
        mail('m1', 'term_a', { sender_pane_key: 'tab_a:leaf' }),
        mail('m2', `orca_session_id:${SESSION}`, { run_id: 'r2' }),
        mail('m3', 'term_a')
      ]
    })
    expect(source).toEqual({
      kind: 'agent',
      senders: [
        {
          party: {
            address: 'term_a',
            terminalHandle: 'term_a',
            paneKey: 'tab_a:leaf',
            orcaSessionId: null
          }
        },
        {
          party: {
            address: `orca_session_id:${SESSION}`,
            terminalHandle: null,
            paneKey: null,
            orcaSessionId: SESSION
          }
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:r1',
        dispatchId: null,
        runIds: ['r1', 'r2'],
        messageIds: ['m1', 'm2', 'm3']
      }
    })
  })
})
