import { useEffect, useState } from 'react'
import { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'
import type { MarkdownPreviewDocument } from './markdown-preview-document-types'

type DocumentState =
  | { content: string; status: 'loading' }
  | { content: string; status: 'error'; message: string }
  | {
      content: string
      status: 'ready'
      document: MarkdownPreviewDocument
      client: MarkdownPreviewDocumentClient
    }

export function useMarkdownPreviewDocument(content: string, enabled: boolean) {
  const [state, setState] = useState<DocumentState>({ content, status: 'loading' })
  useEffect(() => {
    if (!enabled) {
      return
    }
    let active = true
    const fail = (error: Error): void => {
      if (active) {
        setState({ content, status: 'error', message: error.message })
      }
    }
    let client: MarkdownPreviewDocumentClient
    try {
      client = new MarkdownPreviewDocumentClient(
        new Worker(new URL('./markdown-preview-document.worker.ts', import.meta.url), {
          type: 'module'
        }),
        fail
      )
    } catch {
      fail(new Error('Unable to start preview worker.'))
      return
    }
    void client
      .request({ type: 'load', content })
      .then((result) => {
        if (active && result.type === 'loaded') {
          setState({ content, status: 'ready', document: result.document, client })
        }
      })
      .catch((error) => {
        if (error instanceof Error) {
          fail(error)
        }
      })
    return () => {
      active = false
      client.close()
    }
  }, [content, enabled])
  return state.content === content ? state : { content, status: 'loading' as const }
}
