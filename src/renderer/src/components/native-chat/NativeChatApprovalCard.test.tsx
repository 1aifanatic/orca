// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'

afterEach(cleanup)

describe('NativeChatApprovalCard', () => {
  it('shows the detail of a subject this build cannot draw, so nothing is approved unseen', () => {
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Review proposed plan',
          detail: '# Release\n- Run tests',
          // A subject kind a newer build wrote; this build draws only plans.
          subject: JSON.parse('{"kind":"diff","text":"x"}'),
          options: [{ label: 'Approve', send: 'approve' }]
        }}
        onChoose={() => {}}
      />
    )
    expect(document.querySelector('[data-native-chat-approval-detail]')?.textContent).toContain(
      '# Release'
    )
  })

  it('a disabled card shows the request with nothing to press, and Escape cancels nothing', () => {
    const onChoose = vi.fn()
    const onCancel = vi.fn()
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Allow command?',
          detail: 'pnpm test',
          options: [{ label: 'Allow', send: 'allow' }]
        }}
        onChoose={onChoose}
        onCancel={onCancel}
        disabled
      />
    )
    expect(screen.getByText('pnpm test')).toBeTruthy()
    for (const name of ['Allow', 'Cancel']) {
      const button = screen.getByRole('button', { name })
      expect(button.hasAttribute('disabled')).toBe(true)
      fireEvent.click(button)
    }
    fireEvent.keyDown(screen.getByRole('group', { name: 'Allow command?' }), { key: 'Escape' })
    expect(onChoose).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('exposes cancellation while it owns the composer region', () => {
    const onCancel = vi.fn()

    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Allow command?',
          detail: 'pnpm test',
          options: [
            { label: 'Allow', send: 'allow' },
            { label: 'Deny', send: 'deny' }
          ]
        }}
        onChoose={() => {}}
        onCancel={onCancel}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('focuses once on appearance and routes Escape through cancellation', () => {
    const onCancel = vi.fn()
    const { rerender } = render(
      <NativeChatApprovalCard
        approval={{ title: 'Allow command?', options: [{ label: 'Allow', send: 'allow' }] }}
        onChoose={() => {}}
        onCancel={onCancel}
        shouldFocus
      />
    )
    const card = screen.getByRole('group', { name: 'Allow command?' })

    expect(document.activeElement).toBe(card)
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()

    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    rerender(
      <NativeChatApprovalCard
        approval={{ title: 'Allow command?', options: [{ label: 'Allow', send: 'allow' }] }}
        onChoose={() => {}}
        onCancel={onCancel}
        shouldFocus
      />
    )
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('keeps all oversized provider context in one bounded scroller above the actions', () => {
    const description = `Read access outside the workspace ${'description '.repeat(400)}`
    const decisionReason = `The path is outside the allowed root. ${'reason '.repeat(400)}`
    const blockedPath = `/repo/${'nested/'.repeat(400)}secrets.txt`
    const ruleContent = `/repo/${'**/'.repeat(400)}`
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Claude wants to read secrets.txt '.repeat(400),
          description,
          decisionReason,
          blockedPath,
          matchedAskRule: { source: 'project', toolName: 'Read', ruleContent },
          detail: 'x'.repeat(4_000),
          options: [{ label: 'Allow', send: 'allow' }]
        }}
        onChoose={() => {}}
      />
    )

    const card = document.querySelector('[data-native-chat-approval-card="true"]')
    const content = document.querySelector('[data-native-chat-approval-content="true"]')
    const detail = document.querySelector('[data-native-chat-approval-detail="true"]')
    const actions = document.querySelector('[data-native-chat-approval-actions="true"]')
    const allow = screen.getByRole('button', { name: 'Allow' })

    expect(card?.classList.contains('min-h-0')).toBe(true)
    expect(card?.classList.contains('overflow-hidden')).toBe(true)
    expect(content?.classList.contains('max-h-72')).toBe(true)
    expect(content?.classList.contains('overflow-auto')).toBe(true)
    expect(content?.getAttribute('tabindex')).toBe('0')
    expect(content?.textContent).toContain(description.trim())
    expect(content?.textContent).toContain(decisionReason.trim())
    expect(content?.textContent).toContain(blockedPath)
    expect(content?.textContent).toContain(ruleContent)
    expect(content?.contains(detail)).toBe(true)
    expect(content?.contains(allow)).toBe(false)
    expect(actions?.contains(allow)).toBe(true)
    expect(actions?.classList.contains('shrink-0')).toBe(true)
  })

  it('renders a plan as markdown inside the same bounded scroller', () => {
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Claude wants to present its plan',
          subject: {
            kind: 'plan',
            text: '# Release plan\n\n- Run the tests',
            filePath: '/repo/PLAN.md'
          },
          detail: '{"plan":"raw json that must not be shown"}',
          options: [
            { label: 'Approve plan', send: 'allow' },
            { label: 'Keep planning', send: 'deny' }
          ]
        }}
        onChoose={() => {}}
      />
    )

    const content = document.querySelector('[data-native-chat-approval-content="true"]')
    const plan = document.querySelector('[data-native-chat-approval-plan="true"]')
    const actions = document.querySelector('[data-native-chat-approval-actions="true"]')
    const approve = screen.getByRole('button', { name: 'Approve plan' })

    // Living in the shared region is what gives a plan the cap and the scroll.
    expect(content?.contains(plan)).toBe(true)
    expect(content?.classList.contains('max-h-72')).toBe(true)
    expect(content?.classList.contains('overflow-auto')).toBe(true)
    // A document, not a payload.
    expect(screen.getByRole('heading', { name: 'Release plan' })).toBeTruthy()
    expect(content?.textContent).toContain('/repo/PLAN.md')
    // A typed plan replaces the generic detail rather than rendering both.
    expect(document.querySelector('[data-native-chat-approval-detail="true"]')).toBeNull()
    expect(content?.textContent).not.toContain('raw json that must not be shown')
    expect(actions?.contains(approve)).toBe(true)
    expect(content?.contains(approve)).toBe(false)
  })
})
