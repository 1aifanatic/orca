import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import { NotificationHostToggles, toggleMutedExecutionHost } from './NotificationHostToggles'

const { hostOptions } = vi.hoisted(() => {
  const current: SidebarHostOption[] = []
  return { hostOptions: { current } }
})

vi.mock('../sidebar/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: hostOptions.current, hostScopeOptions: [] })
}))

function host(id: SidebarHostOption['id'], label: string): SidebarHostOption {
  return {
    id,
    label,
    detail: id === 'local' ? 'This computer' : 'Orca server',
    kind: id === 'local' ? 'local' : 'runtime',
    health: 'local',
    presence: 'local'
  }
}

describe('NotificationHostToggles', () => {
  it('stays hidden when this computer is the only machine', () => {
    hostOptions.current = [host('local', 'Local Mac')]
    const html = renderToStaticMarkup(
      <NotificationHostToggles mutedExecutionHostIds={[]} disabled={false} onChange={vi.fn()} />
    )
    expect(html).toBe('')
  })

  it('shows one switch per machine, off for muted ones', () => {
    hostOptions.current = [host('local', 'Local Mac'), host('runtime:m4air', 'M4Air mac')]
    const html = renderToStaticMarkup(
      <NotificationHostToggles
        mutedExecutionHostIds={['runtime:m4air']}
        disabled={false}
        onChange={vi.fn()}
      />
    )
    expect(html).toContain('Machines')
    expect(html).toMatch(
      /aria-label="Local Mac"[^>]*data-state="checked"|data-state="checked"[^>]*aria-label="Local Mac"/
    )
    expect(html).toMatch(
      /aria-label="M4Air mac"[^>]*data-state="unchecked"|data-state="unchecked"[^>]*aria-label="M4Air mac"/
    )
  })

  it('toggles a machine in and out of the muted list', () => {
    expect(toggleMutedExecutionHost([], 'runtime:m4air')).toEqual(['runtime:m4air'])
    expect(toggleMutedExecutionHost(['runtime:m4air', 'local'], 'runtime:m4air')).toEqual(['local'])
  })
})
