import {
  ptyInputTransactionKey,
  type PtyInputBinding
} from '../../../runtime/pty-input-transactions'
import { ptyIncarnationById, ptyOwnership } from './ownership-state'
import { tryGetProviderForPty } from './registry'

export function bindProviderPtyInput(id: string): PtyInputBinding {
  const incarnation = ptyIncarnationById.get(id)
  const owner = ptyOwnership.get(id)
  const provider = tryGetProviderForPty(id)
  return {
    key: ptyInputTransactionKey(id, incarnation),
    isCurrent: () =>
      ptyOwnership.get(id) === owner &&
      ptyIncarnationById.get(id) === incarnation &&
      tryGetProviderForPty(id) === provider &&
      provider?.hasPty?.(id) !== false
  }
}
