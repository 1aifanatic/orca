import type { Context } from 'react'
import type { operationModuleLoader } from './operation-module-loader'
import type { RpcClientContextValue } from '../../transport/rpc-client-context-contract'

export function loadHostClientContext(
  modules: ReturnType<typeof operationModuleLoader>
): Context<RpcClientContextValue | null> {
  return modules.load<typeof import('../../transport/rpc-client-react-context')>(
    'mobile/src/transport/rpc-client-react-context.ts'
  ).RpcClientContext
}
