import type { ProviderCloseRequest } from './codex-app-server-posix-supervisor'

/** Codex finishes its writes (auth.json, the state database) and exits on its stdin end. */
export const CODEX_APP_SERVER_CLOSE_REQUEST: ProviderCloseRequest = 'stdin-end'
