// The capabilities that gate how a send is answered: when the host answers it, what its refusal
// proves, and whether it may wait as a queued card.

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
// Why: a host advertising this answers a resent send id from its record before anything else may
// refuse it, so a refusal `agentSession.send` RETURNS is proof; a thrown error never is, a thrown
// refusal included (host not installed, journal database won't open, host disabled). Reading a
// returned `ok: false`: `agent_session_operation_unknown` with `outcomeUnknown` or `resultLost` —
// the host cannot tell yet, resend the same id; with `rewindUnconfirmed` — settled, nothing was
// written. `agent_session_operation_expired` — only the transcript can tell. An
// `agent_session_operation_conflict` or `messageIdReused` — the id holds a different payload,
// which proves nothing about this message; nor does `sessionNotAttached` (the chat's record is
// gone or unreadable on this host). Any other — the chat holds no message under that id and none
// is in flight, but a resend of that id may still run as a new send, so a client that hands the
// text back must not resend the old id. An older host may refuse an id it recorded: none of this
// holds there.
export const AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY =
  'agent-session.send-answers-proof.v1' as const
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
// Why: `agentSession.conversationCommand`'s params are strict, so an older host rejects
// `delivery`. A host advertising this holds a /compact sent while the agent works as a queued
// card instead of refusing it. Clients ask only when queued-messages.v1 is advertised too:
// the card is the only place the waiting command shows.
export const AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY =
  'agent-session.queued-commands.v1' as const
// Why: a host with only queued-commands.v1 refuses `delivery` on a /clear. A host advertising this
// holds a /clear sent while the agent works as a card and runs it itself when its turn comes.
// Clients ask only when queued-messages.v1 is advertised too, as for /compact.
export const AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY =
  'agent-session.queued-clear.v1' as const

/** Advertised in this order inside RUNTIME_CAPABILITIES; queued-messages stays dark. */
export const AGENT_SESSION_SEND_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY
] as const
