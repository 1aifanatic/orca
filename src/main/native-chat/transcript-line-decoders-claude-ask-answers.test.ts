import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// Shaped like Claude Code's AskUserQuestion result records: the model reads the
// prose `content`, and the answers sit beside it as data in `toolUseResult`.
// Question and answer text is synthetic.
const QUESTIONS = [
  {
    question: 'Which storage should the cache use?',
    header: 'Storage',
    options: [
      { label: 'Memory', description: 'Fast, lost on restart' },
      { label: 'Disk', description: 'Survives a restart' }
    ],
    multiSelect: false
  },
  {
    question: 'Which checks should run?',
    header: 'Checks',
    options: [
      { label: 'Lint', description: 'Style' },
      { label: 'Tests', description: 'Behaviour' }
    ],
    multiSelect: true
  }
]

function resultLine(toolUseResult: unknown, isError = false): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'result-uuid',
    timestamp: '2026-09-20T10:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_synthetic',
          content: isError
            ? "The user doesn't want to proceed with this tool use."
            : 'User has answered your questions: "Which storage should the cache use?"="Disk".',
          ...(isError ? { is_error: true } : {})
        }
      ]
    },
    toolUseResult
  })
}

function resultBlock(line: string): NativeChatBlock | undefined {
  return decodeClaudeTranscriptLine(line, 'fallback')?.blocks[0]
}

describe('Claude AskUserQuestion answers', () => {
  it('keeps each chosen label under the exact text of its question', () => {
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS,
        answers: {
          'Which storage should the cache use?': 'Disk',
          'Which checks should run?': 'Lint, Tests'
        }
      })
    )
    expect(block).toMatchObject({
      type: 'tool-result',
      askAnswers: [
        { question: 'Which storage should the cache use?', answer: ['Disk'] },
        // A string is kept whole: it may be typed text that contains commas.
        { question: 'Which checks should run?', answer: ['Lint, Tests'] }
      ]
    })
  })

  it('keeps text the reader typed in place of an option verbatim', () => {
    const typed = 'Neither — keep it in Redis, "as before".'
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS.slice(0, 1),
        answers: { 'Which storage should the cache use?': typed },
        // A preview is the option's own content, not part of the reply.
        annotations: { 'Which storage should the cache use?': { preview: 'Survives a restart' } }
      })
    )
    expect(block).toMatchObject({
      askAnswers: [{ question: 'Which storage should the cache use?', answer: [typed] }]
    })
  })

  it('keeps each label of a multi-select answer recorded as a list', () => {
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS.slice(1),
        answers: { 'Which checks should run?': ['Lint', 'Tests'] }
      })
    )
    expect(block).toMatchObject({
      askAnswers: [{ question: 'Which checks should run?', answer: ['Lint', 'Tests'] }]
    })
  })

  it('adds a note the reader typed after the option it annotates', () => {
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS,
        answers: { 'Which storage should the cache use?': 'Disk' },
        annotations: {
          'Which storage should the cache use?': { notes: 'but compress it' },
          'Which checks should run?': { notes: 'whatever is fastest' }
        }
      })
    )
    expect(block).toMatchObject({
      askAnswers: [
        { question: 'Which storage should the cache use?', answer: ['Disk', 'but compress it'] },
        { question: 'Which checks should run?', answer: ['whatever is fastest'] }
      ]
    })
  })

  it("shows the note, not Claude's stand-in, when no option was chosen", () => {
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS.slice(0, 1),
        answers: { 'Which storage should the cache use?': '(notes only)' },
        annotations: { 'Which storage should the cache use?': { notes: 'ask the team first' } }
      })
    )
    expect(block).toMatchObject({
      askAnswers: [
        { question: 'Which storage should the cache use?', answer: ['ask the team first'] }
      ]
    })
  })

  it('records no answers for picks the reader never submitted', () => {
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS.slice(0, 1),
        answers: { 'Which storage should the cache use?': 'Disk' },
        afkTimeoutMs: 60_000
      })
    )
    expect(block).toMatchObject({ type: 'tool-result' })
    expect(block).not.toHaveProperty('askAnswers')
  })

  it('records no answers when the reader typed a response in their place', () => {
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS.slice(0, 1),
        answers: { 'Which storage should the cache use?': 'Disk' },
        response: 'Neither, let me explain first.'
      })
    )
    expect(block).toMatchObject({ type: 'tool-result' })
    expect(block).not.toHaveProperty('askAnswers')
  })

  it('keeps the answers given before the reader asked for follow-up questions', () => {
    const block = resultBlock(
      resultLine({
        questions: QUESTIONS.slice(0, 1),
        answers: { 'Which storage should the cache use?': 'Disk' },
        response: 'Also ask about eviction.',
        followUp: true
      })
    )
    expect(block).toMatchObject({
      askAnswers: [{ question: 'Which storage should the cache use?', answer: ['Disk'] }]
    })
  })

  it('records no answers for a declined ask', () => {
    const block = resultBlock(
      resultLine("Error: The user doesn't want to proceed with this tool use.", true)
    )
    expect(block).toMatchObject({ type: 'tool-result', isError: true })
    expect(block).not.toHaveProperty('askAnswers')
  })

  it('records no answers for a result that is not a question tool', () => {
    const block = resultBlock(resultLine({ answers: { 'a?': 'b' }, stdout: 'ok' }))
    expect(block).toMatchObject({ type: 'tool-result' })
    expect(block).not.toHaveProperty('askAnswers')
  })

  it('still attaches resolved hunks to an edit result', () => {
    const block = resultBlock(
      resultLine({
        filePath: '/tmp/a.ts',
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
        ]
      })
    )
    expect(block).toMatchObject({
      editPatch: {
        filePath: '/tmp/a.ts',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
      }
    })
    expect(block).not.toHaveProperty('askAnswers')
  })
})
