// What a host that VANISHES without a clean quit has to release, for the tests that model one.
//
// The quit path is the wrong model for those tests: it evicts children and releases leases, which
// is the state a restart test is checking gets re-derived from disk. Everything a quit releases
// that is not ownership still has to be released here, though — a lease renewal already in flight
// commits a store transaction, and that transaction re-creates the store directory under the
// temp-directory removal the test does next.

import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export async function abandonStructuredAgentSessionHost(
  host: StructuredAgentSessionHost
): Promise<void> {
  host['lifetime'].dispose()
  host['conversationDelivery'].loop.dispose()
  await host['runtimeState'].stopLeaseRenewal()
  await Promise.all([...host['sessions'].values()].map((session) => session.journal.close()))
  host['sessions'].clear()
}
