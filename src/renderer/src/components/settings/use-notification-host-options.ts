import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { buildNotificationHostOptions } from '@/attention/notification-execution-host'

export function useNotificationHostOptions() {
  const state = useAppStore(
    useShallow((s) => ({
      repos: s.repos,
      worktreesByRepo: s.worktreesByRepo,
      folderWorkspaces: s.folderWorkspaces,
      projectGroups: s.projectGroups,
      tabsByWorktree: s.tabsByWorktree,
      unifiedTabsByWorktree: s.unifiedTabsByWorktree,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      sshTargetLabels: s.sshTargetLabels,
      sshConnectionStates: s.sshConnectionStates,
      settings: s.settings,
      runtimeEnvironments: s.runtimeEnvironments,
      runtimeStatusByEnvironmentId: s.runtimeStatusByEnvironmentId
    }))
  )
  return useMemo(() => buildNotificationHostOptions(state), [state])
}
