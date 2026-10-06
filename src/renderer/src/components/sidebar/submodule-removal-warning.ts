import { translate } from '@/i18n/i18n'

export function getSubmoduleRemovalWarning(): string {
  return translate(
    'auto.components.sidebar.delete.worktree.toast.submodules',
    'Git requires Force Delete for a workspace with initialized submodules. Back up submodule files and publish any local submodule commits before continuing. Force Delete can permanently discard them.'
  )
}
