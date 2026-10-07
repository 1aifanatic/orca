import { useEffect } from 'react'
import { useAppStore } from '../store'
import { runRecordedLaunchFollowUps } from '../lib/agent-launch-follow-ups'

/** As soon as the window has its worktrees and their notes, and before its terminals are back, it
 *  holds what launches still on their way act on and runs what they recorded for it while it was
 *  gone (`agent-launch-follow-ups`): a note shown as sendable meanwhile could be sent twice. */
export function useRecordedLaunchFollowUps(): void {
  const ready = useAppStore((state) => state.workspaceSessionReady)
  useEffect(() => {
    if (ready) {
      void runRecordedLaunchFollowUps()
    }
  }, [ready])
}
