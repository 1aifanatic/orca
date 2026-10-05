// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatToolLine } from './NativeChatToolLine'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'

afterEach(cleanup)

describe('tool sentence rows', () => {
  it.each([
    ['Bash', { command: 'pnpm test' }, 'Ran', 'pnpm test'],
    ['Read', { file_path: '/repo/src/main.ts' }, 'Read', 'main.ts'],
    ['Edit', { file_path: 'C:\\repo\\main.ts' }, 'Edited', 'main.ts'],
    ['Write', { file_path: '/repo/new.ts' }, 'Edited', 'new.ts'],
    ['MultiEdit', { file_path: '/repo/main.ts' }, 'Edited', 'main.ts'],
    ['Grep', { pattern: 'TODO', path: '/repo' }, 'Searched', 'TODO'],
    ['Glob', { pattern: '**/*.ts' }, 'Searched', '**/*.ts'],
    ['search', { query: 'settings', command: 'rg settings' }, 'Searched', 'settings'],
    ['web_search', { query: 'react docs' }, 'Searched the web', 'react docs'],
    ['WebFetch', { url: 'https://example.com/docs' }, 'Fetched', 'example.com/docs'],
    ['CreateWidget', { description: 'a widget' }, 'CreateWidget', 'a widget'],
    ['list', { directory: '/repo' }, 'list', '/repo']
  ])('describes %s with a verb and target', (name, input, verb, target) => {
    const { container } = render(
      <NativeChatToolLine block={{ type: 'tool-call', name, input }} initiallyExpanded={false} />
    )
    expect(screen.getByText(verb, { selector: 'span:not(.sr-only)' })).toBeInTheDocument()
    expect(screen.getByText(target, { selector: 'span' })).toHaveClass('text-chat-foreground')
    expect(screen.getByRole('button')).toHaveAccessibleName(new RegExp(name))
    expect(container.querySelector('.font-semibold')).toBeNull()
    expect(container.querySelector('.font-mono') !== null).toBe(name === 'Bash')
  })

  it('retains full paths in titles and accessible targets', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Read', input: { file_path: '/repo/src/main.ts' } }}
        initiallyExpanded={false}
      />
    )
    expect(screen.getByTitle('/repo/src/main.ts')).toHaveTextContent('main.ts')
    expect(screen.getByRole('button')).toHaveAccessibleName(/Read.*\/repo\/src\/main.ts/)
  })

  it('keeps integration identity in plain text even for a command-shaped tool name', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'shell',
          input: { command: 'inspect' },
          mcpIdentity: { server: 'my_server', tool: 'shell' }
        }}
        initiallyExpanded={false}
      />
    )
    expect(screen.getByText('My server')).toBeInTheDocument()
    expect(screen.getByText('shell')).toBeInTheDocument()
    expect(screen.queryByText('Ran')).toBeNull()
    expect(screen.getByText('inspect')).not.toHaveClass('font-mono')
  })

  it('counts changed lines rather than unchanged lines in an edit', () => {
    const block: NativeChatToolCallBlock = {
      type: 'tool-call',
      name: 'Edit',
      input: { file_path: 'main.ts', old_string: 'same\nold\n', new_string: 'same\nnew\nextra\n' },
      state: 'completed'
    }
    render(<NativeChatToolLine block={block} initiallyExpanded={false} />)
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
  })

  it('omits counts when an edit supplies no diff', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Edit',
          input: { file_path: 'main.ts' },
          state: 'completed'
        }}
        initiallyExpanded={false}
      />
    )
    expect(screen.queryByText(/^[+-]\d+$/)).toBeNull()
  })

  it('keeps metadata and errors while toggling output behind the sentence', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Bash',
          input: { command: 'false' },
          exitCode: 1,
          durationMs: 1200
        }}
        result={{ type: 'tool-result', output: 'command failed', isError: true }}
        initiallyExpanded={false}
      />
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAccessibleName(/Bash.*false.*exit 1.*1s/)
    expect(screen.getByText('1s').parentElement).toHaveClass('ml-auto', 'tabular-nums', 'font-sans')
    expect(screen.queryByText('command failed')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByText('command failed')).toHaveClass(
      'text-destructive',
      'bg-chat-code-surface',
      'border-chat-code-border',
      'rounded-lg',
      'text-xs'
    )
    fireEvent.click(button)
    expect(screen.queryByText('command failed')).toBeNull()
  })

  it('still renders result-only rows', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-result', output: 'first\nsecond' }}
        initiallyExpanded={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Result/ }))
    expect(screen.getByText('first second', { selector: 'pre' })).toHaveClass(
      'text-chat-foreground'
    )
  })
})
