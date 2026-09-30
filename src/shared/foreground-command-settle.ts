// Why: settle after exec, then place the final generic retry beyond sequential
// 3s PowerShell and WMIC enrichment scans. Shared by the renderer's pane tracker
// and main's `opencode run` producer so both read a command's foreground alike.
export const FOREGROUND_COMMAND_SETTLE_MS = 350
export const FOREGROUND_COMMAND_RETRY_DELAYS_MS = [1200, 6000] as const
