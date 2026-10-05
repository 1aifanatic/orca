import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import { createUIStore } from '../ui-slice-test-harness'
import {
  AUTOMATIC_PROMPT_MODAL_KEY,
  LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS,
  LAUNCH_PROMPT_DISCOVERY_BOUND_MS,
  selectAutomaticPromptSlotSuspended,
  selectPromptSurfaceVisible,
  selectTourBlockedByPrompts,
  selectVisibleAutomaticPrompt,
  selectVisibleAutomaticPromptId
} from './automatic-prompt-turns'

function visible(store: StoreApi<AppState>): string | null {
  return selectVisibleAutomaticPromptId(store.getState())
}

/** What an owner does once its prompt is on screen. */
function show(store: StoreApi<AppState>): string | null {
  const request = selectVisibleAutomaticPrompt(store.getState())
  if (request) {
    store.getState().markAutomaticPromptShown(request.id, request.key)
  }
  return request?.id ?? null
}

/** What the shared dialog primitive reports while any dialog other than a prompt's is rendered. */
function setOtherDialogOnScreen(store: StoreApi<AppState>, open: boolean): void {
  store.setState({ otherDialogOnScreen: open })
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
    expect(store.getState().automaticPromptRequests).toEqual([])
  })

  it('a prompt not yet shown waits for any dialog on screen', () => {
    const store = createUIStore()
    setOtherDialogOnScreen(store, true)
    store.getState().requestAutomaticPrompt('native-chat-resume')
    expect(visible(store)).toBeNull()
    setOtherDialogOnScreen(store, false)
    expect(visible(store)).toBe('native-chat-resume')
  })

  it('a prompt on screen keeps its turn and stays rendered under a dialog opened over it', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('native-chat-resume')
    expect(show(store)).toBe('native-chat-resume')

    // Hidden by its dialog scope, not unmounted, so nothing typed or in flight is lost.
    setOtherDialogOnScreen(store, true)
    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', true)
    store.getState().requestAutomaticPrompt('crash-report')
    expect(visible(store)).toBe('native-chat-resume')
    setOtherDialogOnScreen(store, false)
    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', false)
    expect(visible(store)).toBe('native-chat-resume')
  })

  it('a modal slot whose dialog never rendered holds nothing back', () => {
    const store = createUIStore()
    // A modal-slot dialog that failed to render: the slot is set, nothing is on screen.
    store.getState().openModal('new-workspace-composer')
    store.getState().requestAutomaticPrompt('crash-report')
    expect(visible(store)).toBe('crash-report')
  })

  it('does not count its own modal-slot entry as a user modal', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('feature-tip')
    store.getState().openModal('feature-tips', { [AUTOMATIC_PROMPT_MODAL_KEY]: 'feature-tip' })

    expect(visible(store)).toBe('feature-tip')
    expect(selectAutomaticPromptSlotSuspended(store.getState())).toBe(false)

    // Not on screen yet, so an SSH prompt suspends it; once shown it stays.
    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', true)
    expect(selectAutomaticPromptSlotSuspended(store.getState())).toBe(true)
    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', false)
    expect(show(store)).toBe('feature-tip')
    store.getState().setPromptBlockingDialogVisible('ssh-credential:1', true)
    expect(selectAutomaticPromptSlotSuspended(store.getState())).toBe(false)
  })

  it("being shown belongs to the item, so an owner's next item takes a fresh turn", () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('crash-report', 'a')
    expect(show(store)).toBe('crash-report')
    store.getState().requestAutomaticPrompt('native-chat-resume')

    // The owner moves to its next item: the waiting resume offer goes before it.
    store.getState().releaseAutomaticPrompt('crash-report', 'a')
    store.getState().requestAutomaticPrompt('crash-report', 'b')
    expect(selectVisibleAutomaticPrompt(store.getState())?.id).toBe('native-chat-resume')
    // A stale mark for the next item cannot take the turn from the one whose turn it is.
    store.getState().markAutomaticPromptShown('crash-report', 'b')
    expect(store.getState().automaticPromptRequests.find((r) => r.key === 'b')?.shown).toBe(false)
    expect(show(store)).toBe('native-chat-resume')
  })

  it('a mark for another item of the same owner does not mark the one whose turn it is', () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('crash-report', 'a')
    store.getState().markAutomaticPromptShown('crash-report', 'b')
    expect(store.getState().automaticPromptRequests).toEqual([
      expect.objectContaining({ key: 'a', shown: false })
    ])
  })

  it("a new key replaces the owner's last item in place, not yet shown", () => {
    const store = createUIStore()
    store.getState().requestAutomaticPrompt('crash-report', 'a')
    expect(show(store)).toBe('crash-report')
    store.getState().requestAutomaticPrompt('crash-report', 'b')
    expect(store.getState().automaticPromptRequests).toEqual([
      expect.objectContaining({ id: 'crash-report', key: 'b', shown: false })
    ])
    // Releasing an item that is no longer queued leaves the current one alone.
    store.getState().releaseAutomaticPrompt('crash-report', 'a')
    expect(visible(store)).toBe('crash-report')
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

    it('stops waiting a fixed time after the resume read starts', () => {
      vi.useFakeTimers()
      const store = createUIStore({ launchPromptDiscoveryPending: true })
      store.getState().requestAutomaticPrompt('crash-report')
      // A loaded machine can start the read well after boot; the bound runs from the read.
      vi.advanceTimersByTime(5_000)
      store.getState().beginLaunchPromptDiscovery()

      vi.advanceTimersByTime(LAUNCH_PROMPT_DISCOVERY_BOUND_MS - 1)
      expect(visible(store)).toBeNull()
      vi.advanceTimersByTime(1)
      expect(visible(store)).toBe('crash-report')
    })

    it('ends by itself when no prompt ever asks, so tours can start', () => {
      vi.useFakeTimers()
      const store = createUIStore({ launchPromptDiscoveryPending: true })
      expect(selectTourBlockedByPrompts(store.getState(), false)).toBe(true)

      vi.advanceTimersByTime(LAUNCH_PROMPT_DISCOVERY_BACKSTOP_MS)
      expect(store.getState().launchPromptDiscoveryPending).toBe(false)
      expect(selectTourBlockedByPrompts(store.getState(), false)).toBe(false)
    })

    it('a resume offer read after the bound still takes its turn, after what went first', () => {
      vi.useFakeTimers()
      const store = createUIStore({ launchPromptDiscoveryPending: true })
      store.getState().beginLaunchPromptDiscovery()
      store.getState().requestAutomaticPrompt('crash-report')
      vi.advanceTimersByTime(LAUNCH_PROMPT_DISCOVERY_BOUND_MS)
      expect(show(store)).toBe('crash-report')

      store.getState().requestAutomaticPrompt('native-chat-resume')
      expect(visible(store)).toBe('crash-report')
      store.getState().releaseAutomaticPrompt('crash-report')
      expect(visible(store)).toBe('native-chat-resume')
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
    it('an automatic tour waits for a prompt that can show and for launch discovery', () => {
      const pending = createUIStore({ launchPromptDiscoveryPending: true })
      expect(selectTourBlockedByPrompts(pending.getState(), false)).toBe(true)
      // A tour the user asked for yields only to what is on screen.
      expect(selectTourBlockedByPrompts(pending.getState(), true)).toBe(false)

      const store = createUIStore()
      expect(selectTourBlockedByPrompts(store.getState(), false)).toBe(false)
      store.getState().requestAutomaticPrompt('native-chat-resume')
      expect(selectTourBlockedByPrompts(store.getState(), false)).toBe(true)
    })

    it('a prompt waiting behind a user dialog does not hold back a tour inside that dialog', () => {
      const store = createUIStore()
      store.getState().requestAutomaticPrompt('native-chat-resume')
      setOtherDialogOnScreen(store, true)
      expect(selectTourBlockedByPrompts(store.getState(), false)).toBe(false)
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
