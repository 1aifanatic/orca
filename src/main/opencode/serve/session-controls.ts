import {
  agentSessionPromptQuestions,
  isValidAgentSessionQuestionAnswers,
  type AgentSessionPromptResponse
} from '../../../shared/agent-session-question-answer'
import type { OpenCodeModel } from './native-protocol'
import type { OpenCodeSessionClient } from './session-client'
import type { OpenCodePendingRequest } from './timeline-translator'
import type { OpenCodePromptFile } from '../opencode-structured-prompt-content'

export async function compactOpenCodeSession(
  client: OpenCodeSessionClient,
  sessionId: string,
  model?: OpenCodeModel
): Promise<void> {
  const v1 = client.version.major === 1
  if (v1 && !model) {
    throw new Error('OpenCode needs a selected model to compact this chat')
  }
  await client.peer.json(client.sessionPath(sessionId, v1 ? '/summarize' : '/compact'), {
    method: 'POST',
    body: v1 && model ? { providerID: model.providerID, modelID: model.id } : {}
  })
}

export async function runOpenCodeCommand(
  client: OpenCodeSessionClient,
  sessionId: string,
  name: string,
  argumentsText: string,
  model?: OpenCodeModel,
  mode?: string,
  nativeMessageId?: string,
  files?: readonly OpenCodePromptFile[]
): Promise<void> {
  await client.peer.json(client.sessionPath(sessionId, '/command'), {
    method: 'POST',
    body:
      client.version.major === 1
        ? {
            command: name,
            arguments: argumentsText,
            ...(nativeMessageId ? { messageID: nativeMessageId } : {}),
            ...(mode ? { agent: mode } : {}),
            ...(model?.variant ? { variant: model.variant } : {}),
            ...(model ? { model: `${model.providerID}/${model.id}` } : {}),
            ...(files?.length
              ? {
                  parts: files.map((file) => ({
                    type: 'file',
                    mime: file.mime,
                    filename: file.name,
                    url: file.uri
                  }))
                }
              : {})
          }
        : {
            name,
            text: argumentsText,
            ...(files?.length ? { files: files.map(({ uri, name }) => ({ uri, name })) } : {})
          }
  })
}

export async function answerOpenCodePrompt(
  client: OpenCodeSessionClient,
  request: OpenCodePendingRequest,
  response: AgentSessionPromptResponse
): Promise<void> {
  if (request.kind === 'permission') {
    if (response.kind !== 'option' || !['once', 'reject'].includes(response.optionId)) {
      throw new Error('OpenCode permission decision is invalid')
    }
    await client.answerPermission({
      sessionId: request.sessionId,
      requestId: request.nativeId,
      decision: response.optionId === 'once' ? 'once' : 'reject',
      ...(response.optionId === 'reject' ? { message: 'The user declined this request.' } : {})
    })
    return
  }
  const nativeId = encodeURIComponent(request.nativeId)
  if (response.kind === 'option') {
    if (!['reject', 'cancel'].includes(response.optionId)) {
      throw new Error('OpenCode question decision is invalid')
    }
    await client.peer.json(
      request.kind === 'question'
        ? `/question/${nativeId}/reject`
        : client.sessionPath(request.sessionId, `/form/${nativeId}`),
      { method: request.kind === 'question' ? 'POST' : 'DELETE' }
    )
    return
  }
  if (request.body.kind !== 'question') {
    throw new Error('OpenCode question has no answer fields')
  }
  const questions = agentSessionPromptQuestions(request.body)
  if (!isValidAgentSessionQuestionAnswers(questions, response.answers)) {
    throw new Error('OpenCode question answer is invalid')
  }
  const answers = new Map(response.answers.map((answer) => [answer.questionId, answer]))
  const values = questions.map((question) => {
    const answer = answers.get(question.id)
    if (!answer) {
      throw new Error('OpenCode question answer is missing')
    }
    return {
      question,
      values: [...answer.optionIds, ...(answer.other?.trim() ? [answer.other.trim()] : [])]
    }
  })
  await client.peer.json(
    request.kind === 'question'
      ? `/question/${nativeId}/reply`
      : client.sessionPath(request.sessionId, `/form/${nativeId}/reply`),
    {
      method: 'POST',
      body:
        request.kind === 'question'
          ? { answers: values.map(({ values }) => values) }
          : {
              answer: Object.fromEntries(
                values.map(({ question, values }) => [
                  question.id,
                  question.multiSelect ? values : values[0]
                ])
              )
            }
    }
  )
}
