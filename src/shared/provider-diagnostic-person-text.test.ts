import { describe, expect, it } from 'vitest'
import { isProviderDiagnosticPersonText } from './provider-diagnostic-person-text'

describe('provider explanations a person can read', () => {
  it.each([
    'Claude does not support the image type .bmp',
    'Not enough messages to compact.',
    'Too many requests',
    'Reconnecting... 2/5',
    'Uses {{agent}} $t(key) <b>&</b>'
  ])('keeps readable words: %s', (text) => {
    expect(isProviderDiagnosticPersonText(text)).toBe(true)
  })

  it.each([
    'provider_write_failed: stand-in rejected the turn.',
    'new_transport_marker: a future failure',
    '{"jsonrpc":"2.0","error":{"code":-32603,"message":"failed"}}',
    'The request failed: {"code":-32603}',
    'API Error: Request was aborted.',
    'TypeError: Cannot read properties of undefined',
    'write EPIPE',
    'HTTP 502 Bad Gateway',
    'RPC -32603',
    'Failure\n    at send (/app/dispatch.ts:10:2)',
    'Traceback (most recent call last):',
    'data: {"type":"error"}',
    '\u001b[31mFailed\u001b[0m',
    ''
  ])('withholds technical text: %s', (text) => {
    expect(isProviderDiagnosticPersonText(text)).toBe(false)
  })
})
