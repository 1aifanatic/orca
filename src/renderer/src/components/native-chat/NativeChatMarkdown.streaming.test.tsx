// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { NativeChatMarkdown } from './NativeChatMarkdown'

afterEach(cleanup)

describe('native chat streaming markdown', () => {
  it.each(['*', '**', '**\n', '_', '__', '`', '``', '```'])(
    'does not flash a bare %s opener before its text arrives',
    (opener) => {
      const { container } = render(<NativeChatMarkdown content={`Reply ${opener}`} streaming />)
      expect(container).toHaveTextContent('Reply')
      expect(container).not.toHaveTextContent(opener)
    }
  )

  it.each([
    ['Reply \\**', 'Reply **'],
    ['value_', 'value_'],
    ['value__', 'value__'],
    ['Use `**`', 'Use **'],
    ['Use ```a`b```', 'Use a`b'],
    ['Use `a\\`', 'Use a\\']
  ])('preserves literal characters in %s', (content, text) => {
    const { container } = render(<NativeChatMarkdown content={content} streaming />)
    expect(container.textContent).toBe(text)
  })

  it('shows each arriving fragment immediately and keeps the paragraph mounted', () => {
    const { container, rerender } = render(
      <NativeChatMarkdown content="An unfin" variant="document" streaming />
    )
    const paragraph = container.querySelector('p')
    expect(paragraph).toHaveTextContent('An unfin')
    expect(container.firstElementChild).toHaveAttribute('data-streaming', '')
    rerender(<NativeChatMarkdown content="An unfinished word" variant="document" streaming />)
    expect(container.querySelector('p')).toBe(paragraph)
    expect(paragraph).toHaveTextContent('An unfinished word')
  })

  it('repairs unfinished emphasis and code without changing ordinary comments', () => {
    const { container, rerender } = render(
      <NativeChatMarkdown content="A **bold reply" streaming />
    )
    expect(container.querySelector('strong')).toHaveTextContent('bold reply')
    expect(container).not.toHaveTextContent('**')
    rerender(<NativeChatMarkdown content="Use ``a`b" streaming />)
    expect(container.querySelector('code')).toHaveTextContent('a`b')
    rerender(<CommentMarkdown content="A **bold reply" />)
    expect(container.querySelector('strong')).toBeNull()
    expect(container).toHaveTextContent('**bold reply')
    expect(container.firstElementChild).not.toHaveAttribute('data-streaming')
  })

  it('renders an incomplete link as text until its destination arrives', () => {
    const { container, rerender } = render(
      <NativeChatMarkdown content="See [the guide](https://exa" streaming />
    )
    expect(container).toHaveTextContent('See the guide')
    expect(container.querySelector('a')).toBeNull()
    rerender(<NativeChatMarkdown content="See [the guide](https://example.com)" streaming />)
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com')
  })

  it('keeps a settled block and code controls mounted when more text arrives and streaming ends', () => {
    const codeRenderer = vi.fn(({ children }: { children?: ReactNode }) => <pre>{children}</pre>)
    const prefix = 'First block.\n\n```ts\nconst n = 1\n```\n\n'
    const markdown = (content: string, streaming: boolean) => (
      <NativeChatMarkdown
        content={content}
        streaming={streaming}
        variant="document"
        renderCodeBlock={codeRenderer}
      />
    )
    const { container, rerender } = render(markdown(`${prefix}Next`, true))
    const paragraph = container.querySelector('p')
    const code = container.querySelector('pre')
    const renders = codeRenderer.mock.calls.length
    rerender(markdown(`${prefix}Next block.\n\nAnother block`, true))
    expect(container.querySelector('p')).toBe(paragraph)
    expect(container.querySelector('pre')).toBe(code)
    expect(codeRenderer).toHaveBeenCalledTimes(renders)
    rerender(markdown(`${prefix}Next block.\n\nAnother block`, false))
    expect(container.querySelector('pre')).toBe(code)
    expect(codeRenderer).toHaveBeenCalledTimes(renders)
    expect(container.firstElementChild).not.toHaveAttribute('data-streaming')
  })

  it('joins loose list items that arrive across blank lines', () => {
    const { container, rerender } = render(<NativeChatMarkdown content={'- First\n\n'} streaming />)
    rerender(<NativeChatMarkdown content={'- First\n\n- Second'} streaming />)
    expect(container.querySelectorAll('ul')).toHaveLength(1)
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('resolves late link and footnote definitions across earlier blocks', () => {
    const first = 'See [guide][docs] and a note.[^1]\n\nMore prose.\n\n'
    const { container, rerender } = render(<NativeChatMarkdown content={first} streaming />)
    rerender(
      <NativeChatMarkdown
        content={`${first}[docs]: https://example.com\n\n[^1]: Note text.\n`}
        streaming
      />
    )
    expect(container.querySelector('a')).toHaveAttribute('href', 'https://example.com')
    expect(container).toHaveTextContent('Note text.')
  })

  it('keeps fenced code and literal comparison, tilde, math and HTML syntax intact', () => {
    const { container, rerender } = render(
      <NativeChatMarkdown content={'```ts\nconst ticks = "`"\n\n**literal**'} streaming />
    )
    expect(container.querySelector('pre code')).toHaveTextContent('**literal**')
    rerender(
      <NativeChatMarkdown
        content={'- > 25\n\n20~25 $5\n\nBefore <sub>low\n\nAfter</sub>'}
        streaming
      />
    )
    expect(container.querySelector('blockquote')).not.toBeNull()
    expect(container).toHaveTextContent('20~25 $5')
    expect(container.querySelector('sub')).toHaveTextContent('low')
  })

  it('renders finished chats without repairs and starts fresh when content is replaced', () => {
    const { container, rerender } = render(
      <NativeChatMarkdown content="First\n\n**unfinished" streaming />
    )
    rerender(<NativeChatMarkdown content="Replacement\n\n**unfinished" />)
    expect(container).not.toHaveTextContent('First')
    expect(container).toHaveTextContent('**unfinished')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.firstElementChild).not.toHaveAttribute('data-streaming')
  })
})
