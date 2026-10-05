import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import { createUIStore } from '../ui-slice-test-harness'
import {
  AUTOMATIC_PROMPT_MODAL_KEY,
  LAUNCH_PROMPT_DISCOVERY_BOUND_MS,
  selectAutomaticPromptSlotSuspended,
  selectPromptSurfaceVisible,
  selectTourBlockedByPrompts,
  selectVisibleAutomaticPromptId
} from './automatic-prompt-turns'

function visible(store: StoreApi<AppState>): string | null {
  return selectVisibleAutomaticPromptId(store.getState())
}

/** What an owner does once its prompt is on screen. */
function show(store: StoreApi<AppState>): string | null {
  const id = selectVisibleAutomaticPromptId(store.getState())
  if (id) {
    store.getState().markAutomaticPromptShown(id)
  }
  return id
}

afterEach(() => {
  vi.useRealTimers()
})

describe('automatic prompt turns', () => {
  it('shows the resume offer before a feature tip, and the tip once it closes', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('feature-tip')
    store.getState().requestAutomaticPrompt('native-chat-resume')

    expect(show(store)).toBe('native-chat-resume')
    store.getState().releaseAutomaticPrompt('native-chat-resume')
    expect(show(store)).toBe('feature-tip')
  })

  it('shows a crash report before a feature tip when both are waiting', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('feature-tip')
    store.getState().requestAutomaticPrompt('crash-report')

    expect(visible(store)).toBe('crash-report')
  })

  it('keeps the turn with the prompt on screen when one that goes first arrives later', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('feature-tip')
    expect(show(store)).toBe('feature-tip')

    store.getState().requestAutomaticPrompt('crash-report')
    store.getState().requestAutomaticPrompt('native-chat-resume')
    expect(visible(store)).toBe('feature-tip')

    store.getState().releaseAutomaticPrompt('feature-tip')
    expect(show(store)).toBe('native-chat-resume')
    store.getState().releaseAutomaticPrompt('native-chat-resume')
    expect(show(store)).toBe('crash-report')
  })

  it('a cancelled request gives its place to the next one', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('crash-report')
    store.getState().requestAutomaticPrompt('feature-tip')

    store.getState().releaseAutomaticPrompt('crash-report')
    expect(visible(store)).toBe('feature-tip')
    store.getState().releaseAutomaticPrompt('feature-tip')
    expect(visible(store)).toBeNull()
    expect(store.getState().automaticPromptShownId).toBeNull()
  })

  it('never delays a user modal; a prompt on screen steps aside and comes back after it', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('native-chat-resume')
    expect(show(store)).toBe('native-chat-resume')

    store.getState().openModal('settings')
    expect(visible(store)).toBeNull()
    // The prompt keeps its turn while hidden, so another waiting prompt cannot take it.
    store.getState().requestAutomaticPrompt('crash-report')
    store.getState().closeModal()
    expect(visible(store)).toBe('native-chat-resume')
  })

  it('does not count its own modal-slot entry as a user modal', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('feature-tip')
    expect(show(store)).toBe('feature-tip')
    store.getState().openModal('feature-tips', { [AUTOMATIC_PROMPT_MODAL_KEY]: 'feature-tip' })

    expect(visible(store)).toBe('feature-tip')
    expect(selectAutomaticPromptSlotSuspended(store.getState())).toBe(false)

    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', true)
    expect(selectAutomaticPromptSlotSuspended(store.getState())).toBe(true)
    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', false)
    expect(selectAutomaticPromptSlotSuspended(store.getState())).toBe(false)
  })

  it('an SSH credential prompt shows over a visible resume offer, which comes back after', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('native-chat-resume')
    expect(show(store)).toBe('native-chat-resume')

    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', true)
    expect(visible(store)).toBeNull()
    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', false)
    expect(visible(store)).toBe('native-chat-resume')
  })

  it('one dialog closing does not clear another that is still open', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('feature-tip')
    store.getState().setPromptBlockingDialogVisible('confirmation:1', true)
    store.getState().setPromptBlockingDialogVisible('ssh-credential:2', true)

    store.getState().setPromptBlockingDialogVisible('confirmation:1', false)
    expect(visible(store)).toBeNull()
    expect(selectPromptSurfaceVisible(store.getState())).toBe(true)
    store.getState().setPromptBlockingDialogVisible('ssh-credential:2', false)
    expect(visible(store)).toBe('feature-tip')
  })

  describe('launch discovery', () => {
    it('holds every automatic prompt until the resume read decides', () => {
      const store = createUIStore({ launchPromptDiscoveryPending: true })
      store.getState().requestAutomaticPrompt('crash-report')
      expect(visible(store)).toBeNull()

      // A slow local read lands after the fast crash report and still goes first.
      store.getState().requestAutomaticPrompt('native-chat-resume')
      store.getState().settleLaunchPromptDiscovery()
      expect(show(store)).toBe('native-chat-resume')
    })

    it('stops waiting at the bound when the resume read never decides', () => {
      vi.useFakeTimers()
      const store = createUIStore({ launchPromptDiscoveryPending: true })
      store.getState().requestAutomaticPrompt('crash-report')

      vi.advanceTimersByTime(LAUNCH_PROMPT_DISCOVERY_BOUND_MS - 1)
      expect(visible(store)).toBeNull()
      vi.advanceTimersByTime(1)
      expect(visible(store)).toBe('crash-report')
    })

    it('measures the bound from boot, not from the request', () => {
      vi.useFakeTimers()
      const store = createUIStore({ launchPromptDiscoveryPending: true })
      vi.advanceTimersByTime(LAUNCH_PROMPT_DISCOVERY_BOUND_MS + 500)
      store.getState().requestAutomaticPrompt('feature-tip')
      vi.advanceTimersByTime(0)
      expect(visible(store)).toBe('feature-tip')
    })

    it('never waits for discovery while a user dialog is what is up', () => {
      const store = createUIStore({ launchPromptDiscoveryPending: true })
      store.getState().setPromptBlockingDialogVisible('ssh-credential:1', true)
      // Nothing about the SSH prompt is gated; only automatic prompts read discovery.
      expect(store.getState().promptBlockingDialogIds).toEqual(['ssh-credential:1'])
      expect(selectPromptSurfaceVisible(store.getState())).toBe(true)
    })
  })

  describe('contextual tours', () => {
    it('an automatic tour waits for a queued prompt and for launch discovery', () => {
      const pending = createUIStore({ launchPromptDiscoveryPending: true })
      expect(selectTourBlockedByPrompts(pending.getState(), false)).toBe(true)

      const store = createUIStore()
      expect(selectTourBlockedByPrompts(store.getState(), false)).toBe(false)
      store.getState().requestAutomaticPrompt('native-chat-resume')
      store.getState().openModal('settings')
      // Hidden behind the user's modal, the resume offer still goes before an automatic tour.
      expect(selectTourBlockedByPrompts(store.getState(), false)).toBe(true)
      // A tour the user asked for yields only to what is on screen.
      expect(selectTourBlockedByPrompts(store.getState(), true)).toBe(false)
    })

    it('a running tour holds the turn; a prompt asked for meanwhile opens after it', () => {
      const store = createUIStore()
      store.setState({ activeContextualTourId: 'tasks' })
      store.getState().requestAutomaticPrompt('feature-tip')
      expect(visible(store)).toBeNull()
      // A queued prompt does not cancel the running tour.
      expect(selectPromptSurfaceVisible(store.getState())).toBe(false)

      store.setState({ activeContextualTourId: null })
      expect(visible(store)).toBe('feature-tip')
    })
  })
})
