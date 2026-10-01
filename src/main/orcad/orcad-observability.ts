// orcad's local trace file: the desktop's sink, consent gates and file name, under orcad's own data
// root (`<data-root>/logs/main.trace.ndjson`), so a headless host's reported failures reach a file
// and not only the supervisor's stderr.

import { initObservability, shutdownObservability } from '../observability'

/** Installed before the runtime, so its first span lands; closed on quit, after runtime teardown. */
export function installOrcadObservability(onWillQuit: (handler: () => void) => void): void {
  initObservability()
  onWillQuit(() => void shutdownObservability())
}
