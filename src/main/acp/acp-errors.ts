import type { AuthMethod } from './generated/acp-protocol.generated'

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpRpcError'
  }
}

/** The agent's own error answer to a request: it read the request and refused it. Errors Orca
 *  raises about a request (a timeout, an unreadable answer, a closed connection) are not this. */
export class AcpAgentError extends AcpRpcError {
  constructor(code: number, message: string, data?: unknown) {
    super(code, message, data)
    this.name = 'AcpAgentError'
  }
}

export class AcpAuthRequiredError extends AcpAgentError {
  constructor(
    message: string,
    data?: unknown,
    readonly authMethods: AuthMethod[] = []
  ) {
    super(-32000, message, data)
    this.name = 'AcpAuthRequiredError'
  }
}

export class AcpConnectionClosedError extends Error {
  constructor(message = 'ACP connection closed') {
    super(message)
    this.name = 'AcpConnectionClosedError'
  }
}

export class AcpRequestTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`ACP request timed out: ${method}`)
    this.name = 'AcpRequestTimeoutError'
  }
}
