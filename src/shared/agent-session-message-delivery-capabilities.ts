// The capabilities that gate how a structured message is delivered: answered on acceptance, held
// as a draft, or queued again after it failed before any agent took it.

// Why: older structured clients render durable pending replies as uncertain delivery. Capable
// clients skip the host's bounded best-effort settlement observation.
export const AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY =
  'agent-session.pending-send-result.v1' as const
// Why: a send is now answered once the host accepts it, before any agent has it. A client without
// this cannot show a message rejected after that answer, so the host holds its reply until the
// message is handed over or rejected. Transitional: drop the hold once no supported desktop or
// mobile client lacks the capability; mobile must first show a rejected message in place.
export const AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY =
  'agent-session.accepted-send.v1' as const
// Why: `agentSession.send`'s params are strict, so an older host rejects `delivery`; and only a
// capable client can render the `queued` result arm, the draft list, and returned cards. DARK ON
// PURPOSE — not in RUNTIME_CAPABILITIES: advertising still requires the integrated Codex steer
// matrix (#21062) in the shipped host, and the desktop and phone clients that render the queue.
// v1 includes `submission.queuedMessageId` on every draft hand-off: a client reads that link and
// never compares a draft id with a submission id. It also publishes the queue's pause once, as
// `queuePause` beside the list, lifted by `agentSession.queuedMessagesResume` or the user's next
// turn; cards carry a hold of their own only when their conversion failed. The host mechanism lands first; the constant
// gates the rollout.
export const AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY =
  'agent-session.queued-messages.v1' as const
// Why: `agentSession.retryMessage` queues a message no agent took again under its own id; an older
// host has no such method, so a client must learn it during negotiation and otherwise keep Retry
// as a new message.
export const AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY =
  'agent-session.retry-message.v1' as const

// QUEUED_MESSAGES stays out: it is dark until its rollout.
export const AGENT_SESSION_MESSAGE_DELIVERY_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  // The host side: it accepts a send before any agent has it, and a Stop with no writer before a
  // turn starts, so a client may gate on either.
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY
] as const
