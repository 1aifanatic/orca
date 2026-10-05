import type { Terminal } from '@xterm/xterm'

const terminalOutputEpochs = new WeakMap<Terminal, number>()

export function recordTerminalOutput(terminal: Terminal): void {
  terminalOutputEpochs.set(terminal, getTerminalOutputEpoch(terminal) + 1)
}

export function getTerminalOutputEpoch(terminal: Terminal): number {
  return terminalOutputEpochs.get(terminal) ?? 0
}
