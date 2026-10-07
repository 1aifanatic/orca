import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentLaunch, AgentLaunchReplay } from './agent-launch-params'
import { computeAgentLaunchFingerprint } from '../agent-launch-operation'
import {
  AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITIES,
  supportsDesktopNewTabAgentLaunch
} from '../agent-launch-runtime-capability'

const BASE = {
  agent: 'claude',
  operationId: '1791399600000-0123456789abcdef0123456789abcdef',
  target: { kind: 'existing', worktree: 'folder:test' },
  prompt: {
    text: 'hello',
    delivery: 'draft',
    transport: { kind: 'desktop-new-tab', promptDelivery: 'draft' }
  }
} as const

describe('negotiated desktop startup prompt contract', () => {
  it('preserves exact desktop intent and boolean options without accepting prepared commands', () => {
    const parsed = AgentLaunch.parse({
      ...BASE,
      sessionOptions: { model: 'opus', fastMode: true },
      command: 'arbitrary payload'
    })
    expect(parsed.prompt).toEqual(BASE.prompt)
    expect(parsed.sessionOptions).toEqual({ model: 'opus', fastMode: true })
    expect(parsed).not.toHaveProperty('command')
    expect(AgentLaunchReplay.parse(BASE).prompt).toEqual(BASE.prompt)
  })
  it('requires a fresh recorded existing-workspace launch and consistent draft intent', () => {
    expect(AgentLaunch.safeParse({ ...BASE, operationId: undefined }).success).toBe(false)
    expect(AgentLaunch.safeParse({ ...BASE, reuseTerminal: { handle: 'running' } }).success).toBe(
      false
    )
    expect(
      AgentLaunch.safeParse({
        ...BASE,
        target: { kind: 'create-worktree', create: { repo: 'test' } }
      }).success
    ).toBe(false)
    expect(
      AgentLaunch.safeParse({ ...BASE, prompt: { ...BASE.prompt, delivery: 'submit' } }).success
    ).toBe(false)
  })
  it('represents stdin auto input as an unsent draft and argv auto input as submitted startup', () => {
    const auto = {
      text: 'hello',
      delivery: 'draft',
      transport: { kind: 'desktop-new-tab', promptDelivery: 'auto-submit' }
    }
    expect(AgentLaunch.safeParse({ ...BASE, agent: 'aider', prompt: auto }).success).toBe(true)
    expect(AgentLaunch.safeParse({ ...BASE, agent: 'claude', prompt: auto }).success).toBe(false)
    expect(
      AgentLaunch.safeParse({ ...BASE, agent: 'claude', prompt: { ...auto, delivery: 'submit' } })
        .success
    ).toBe(true)
  })
  it('keeps old generic payloads and string option validation unchanged', () => {
    const generic = {
      agent: 'aider',
      target: BASE.target,
      prompt: { text: 'hello', delivery: 'draft' }
    }
    expect(AgentLaunch.parse(generic)).toEqual(generic)
    expect(AgentLaunch.safeParse({ ...generic, sessionOptions: { fastMode: true } }).success).toBe(
      false
    )
    expect(
      AgentLaunch.parse({
        ...generic,
        prompt: { text: 'hello', delivery: 'submit', transport: 'paste' }
      }).prompt?.transport
    ).toBe('paste')
  })
  it('gates the guarantee explicitly and does not advertise an incomplete contract', () => {
    expect(supportsDesktopNewTabAgentLaunch(undefined)).toBe(false)
    expect(
      supportsDesktopNewTabAgentLaunch(['agent.launch.v2', 'agent.launch.prompt-carry.v1'])
    ).toBe(false)
    expect(
      supportsDesktopNewTabAgentLaunch([AGENT_LAUNCH_DESKTOP_NEW_TAB_RUNTIME_CAPABILITY])
    ).toBe(true)
    expect(supportsDesktopNewTabAgentLaunch(AGENT_LAUNCH_RUNTIME_CAPABILITIES)).toBe(false)
    const oldHost = z.object({
      prompt: z.object({
        text: z.string(),
        delivery: z.enum(['draft', 'submit']),
        transport: z.enum(['paste']).optional()
      })
    })
    expect(oldHost.safeParse(BASE).success).toBe(false)
  })
  it('includes the selected startup transport in replay identity', () => {
    const parsed = AgentLaunch.parse(BASE)
    const paste = AgentLaunch.parse({
      ...BASE,
      prompt: { text: 'hello', delivery: 'draft', transport: 'paste' }
    })
    expect(computeAgentLaunchFingerprint(parsed)).not.toBe(computeAgentLaunchFingerprint(paste))
  })
})
