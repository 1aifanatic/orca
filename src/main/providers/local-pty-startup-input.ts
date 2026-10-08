import { ptyInputTransactions, ptyInputTransactionKey } from '../runtime/pty-input-transactions'
import { ptyIncarnations, ptyProcesses } from './local-pty-provider-state'

export function writeLocalPtyStartupInput(id: string, incarnation: string, data: string): void {
  const proc = ptyProcesses.get(id)
  try {
    const input = ptyInputTransactions.run(
      {
        key: ptyInputTransactionKey(id, incarnation),
        isCurrent: () =>
          !!proc && ptyProcesses.get(id) === proc && ptyIncarnations.get(id) === incarnation
      },
      (transaction) => {
        transaction.handoff()
        proc?.write(data)
      }
    )
    if (input instanceof Promise) {
      void input.catch((error) => console.warn('[pty] startup input failed:', error))
    }
  } catch (error) {
    console.warn('[pty] startup input failed:', error)
  }
}
