import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { vi } from 'vitest'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ActionableTaskItem, TaskItem } from './mobile-tasks-project-workspace-types'
import type { DetailPayload, GitLabWorkItem } from './mobile-tasks-provider-detail-types'
import { useMobileTasksItemDetailLoading } from './use-mobile-tasks-item-detail-loading'

export const GITLAB_DETAILS = {
  body: 'Merge request body',
  comments: [],
  item: { labels: ['performance'], mergeable: 'MERGEABLE' },
  assignees: ['reviewer'],
  pipelineJobs: [{ id: 1, name: 'test', stage: 'test', status: 'success' }],
  reviewers: [{ username: 'reviewer' }],
  approvalState: { approvalsRequired: 1, approvalsLeft: 0 }
}

export const SUCCESS_CHECKS = {
  state: 'success',
  total: 1,
  passed: 1,
  failed: 0,
  pending: 0,
  neutral: 0
} as const

export function gitlabItem(
  source: Partial<GitLabWorkItem> = {}
): Extract<TaskItem, { provider: 'gitlab' }> {
  return {
    key: 'gitlab:repo:mr:12',
    provider: 'gitlab',
    title: 'A merge request',
    subtitle: 'Repository !12',
    status: 'Open',
    updatedAt: '2026-10-07T00:00:00Z',
    source: {
      id: 'mr:12',
      type: 'mr',
      number: 12,
      title: 'A merge request',
      state: 'opened',
      url: 'https://gitlab.example/group/repo/-/merge_requests/12',
      labels: [],
      author: null,
      updatedAt: '2026-10-07T00:00:00Z',
      repoId: 'repo',
      repoName: 'Repository',
      projectRef: { host: 'gitlab.example', path: 'group/repo' },
      ...source
    }
  }
}

export function hydratedItem(source: Partial<GitLabWorkItem> = {}) {
  return gitlabItem({
    checksSummary: SUCCESS_CHECKS,
    mergeable: 'MERGEABLE',
    reviewDecision: 'approved',
    reviewerCount: 1,
    ...source
  })
}

export function success(result: unknown): RpcResponse {
  return { id: 'detail', ok: true, result }
}

type PendingRequest = {
  method: string
  params: unknown
  options?: SendRequestOptions
  settled: boolean
  resolve: (reply: RpcResponse) => void
  reject: (error: Error) => void
}

export function detailClient() {
  const requests: PendingRequest[] = []
  const client: RpcClient = {
    sendRequest: vi.fn<RpcClient['sendRequest']>((method, params, options) => {
      return new Promise<RpcResponse>((resolve, reject) => {
        requests.push({ method, params, options, settled: false, resolve, reject })
      })
    }),
    subscribe: vi.fn(() => () => {}),
    updateTerminalSubscriptionViewport: vi.fn(),
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 1,
    onStateChange: vi.fn(() => () => {}),
    notifyForeground: vi.fn(),
    close: vi.fn()
  }
  return {
    client,
    requests,
    pending: () => requests.filter((request) => !request.settled),
    async answer(
      reply: RpcResponse | ((request: PendingRequest) => RpcResponse) = success(
        structuredClone(GITLAB_DETAILS)
      ),
      pending = requests.filter((request) => !request.settled)
    ) {
      await act(async () => {
        for (const request of pending) {
          request.settled = true
          request.resolve(typeof reply === 'function' ? reply(request) : reply)
        }
      })
    },
    async reject(error: Error) {
      const pending = requests.filter((request) => !request.settled)
      await act(async () => {
        for (const request of pending) {
          request.settled = true
          request.reject(error)
        }
      })
    }
  }
}

type DetailState = {
  actionItem: ActionableTaskItem | null
  items: TaskItem[]
  payload: DetailPayload | null
  loading: boolean
  error: string
}

export async function mountDetail(
  initial: ActionableTaskItem = gitlabItem(),
  initialItems: TaskItem[] = [initial]
) {
  const transport = detailClient()
  const observation: { state?: DetailState } = {}
  let renderer: ReactTestRenderer | undefined
  const commands = {
    select: (_item: ActionableTaskItem | null): void => {},
    refresh: (): void => {},
    client: (_client: RpcClient): void => {},
    rerender: (): void => {}
  }
  function Probe(): null {
    const [actionItem, setActionItem] = useState<ActionableTaskItem | null>(initial)
    const [items, setItems] = useState(initialItems)
    const [payload, setDetailPayload] = useState<DetailPayload | null>(null)
    const [loading, setDetailLoading] = useState(false)
    const [error, setDetailError] = useState('')
    const [detailRefreshSeq, setRefreshSeq] = useState(0)
    const [client, setClient] = useState(transport.client)
    const [, setUnrelated] = useState(0)
    commands.select = setActionItem
    commands.refresh = () => setRefreshSeq((value) => value + 1)
    commands.client = setClient
    commands.rerender = () => setUnrelated((value) => value + 1)
    observation.state = { actionItem, items, payload, loading, error }
    useMobileTasksItemDetailLoading({
      actionItem,
      client,
      detailRefreshSeq,
      setActionItem,
      setItems,
      setDetailPayload,
      setDetailLoading,
      setDetailError,
      tasksSupported: true
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  return {
    transport,
    state() {
      if (!observation.state) {
        throw new Error('Detail hook did not mount')
      }
      return observation.state
    },
    async select(item: ActionableTaskItem | null) {
      await act(async () => commands.select(item))
    },
    async refresh() {
      await act(async () => commands.refresh())
    },
    async replaceClient(client: RpcClient) {
      await act(async () => commands.client(client))
    },
    async rerender() {
      await act(async () => commands.rerender())
    },
    async dispose() {
      await act(async () => {
        renderer?.unmount()
        renderer = undefined
      })
    }
  }
}
