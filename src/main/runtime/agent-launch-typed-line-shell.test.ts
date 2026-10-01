import { describe, expect, it } from 'vitest'
import { nameLocalTypedLineShell } from './agent-launch-typed-line-shell'

describe('naming the shell a local launch line is typed into', () => {
  it('takes the request’s shell first, then the setting, then SHELL, as the spawn does', () => {
    const base = { isRemote: false, platform: 'darwin' as const, envShell: '/bin/bash' }
    expect(
      nameLocalTypedLineShell({
        ...base,
        shellOverride: '/opt/homebrew/bin/fish',
        defaultShellSetting: '/bin/zsh'
      })
    ).toBe('fish')
    expect(nameLocalTypedLineShell({ ...base, defaultShellSetting: ' /bin/zsh ' })).toBe('zsh')
    expect(nameLocalTypedLineShell(base)).toBe('bash')
    expect(nameLocalTypedLineShell({ ...base, envShell: '' })).toBe('zsh')
  })

  it('names none for a remote host, whose relay picks its own login shell', () => {
    expect(
      nameLocalTypedLineShell({ isRemote: true, platform: 'darwin', envShell: '/bin/zsh' })
    ).toBeUndefined()
  })

  it('names none on Windows, where the pane may be cmd, PowerShell, Git Bash or WSL', () => {
    expect(
      nameLocalTypedLineShell({ isRemote: false, platform: 'win32', envShell: '/bin/zsh' })
    ).toBeUndefined()
  })
})
