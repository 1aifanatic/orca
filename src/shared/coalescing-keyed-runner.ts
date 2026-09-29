export type CoalescingKeyedRunner<T> = (key: string, work: () => Promise<T>) => Promise<T>

type Slot<T> = {
  running: Promise<T>
  trailing?: Promise<T>
  trailingWork?: () => Promise<T>
}

/**
 * At most one run per key at a time. Callers that arrive while a run is in flight share one
 * trailing run, started when it settles with the latest caller's `work`, so a burst of any size
 * costs at most two runs and the last one reflects the newest request.
 */
export function createCoalescingKeyedRunner<T>(): CoalescingKeyedRunner<T> {
  const slots = new Map<string, Slot<T>>()

  const launch = (key: string, work: () => Promise<T>): Promise<T> => {
    const slot: Slot<T> = { running: Promise.resolve().then(work) }
    slots.set(key, slot)
    void settled(slot.running).then(() => {
      if (slots.get(key) === slot && !slot.trailing) {
        slots.delete(key)
      }
    })
    return slot.running
  }

  return (key, work) => {
    const slot = slots.get(key)
    if (!slot) {
      return launch(key, work)
    }
    slot.trailingWork = work
    slot.trailing ??= settled(slot.running).then(() => launch(key, slot.trailingWork ?? work))
    return slot.trailing
  }
}

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined
  )
}
