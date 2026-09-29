import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORCAD_BUN_RELEASE_ASSETS, ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'

export function installCandidateOverride(config: Record<string, unknown>, state: string) {
  const receiptPath = config.candidateReceiptPath
  const receiptHash = config.candidateReceiptSha256
  assert(
    typeof receiptPath === 'string' &&
      typeof receiptHash === 'string' &&
      /^[a-f0-9]{64}$/.test(receiptHash)
  )
  const bytes = readFileSync(receiptPath)
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    receiptHash,
    'preverified admission receipt changed'
  )
  const receipt = JSON.parse(bytes.toString('utf8'))
  assert.equal(receipt.producer, 'dfb15cae6ba7a5dceabb6d3d66f93be1a6c13328')
  assert.equal(receipt.source, '744846f844374847c902b5e7fd59b4342a51ef99')
  assert.equal(receipt.patch, '920a6f0398bf9ae3528538255a1cceb23e11ded30097099e597c5ab5fff3ed05')
  assert.equal(receipt.product, '25b0b1f3cccad41918f13181a627c26c01ea39e1')
  assert.equal(String(receipt.producerRun), '36620077577')
  assert(process.arch === 'arm64' || process.arch === 'x64')
  assert.equal(receipt.architecture, process.arch)
  const platform = `win32-${process.arch}` as const
  assert(typeof receipt.binary === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256))
  assert.equal(
    createHash('sha256').update(readFileSync(receipt.binary)).digest('hex'),
    receipt.sha256
  )
  const cache = join(state, 'orcad-artifacts', 'bun', `v${ORCAD_BUN_VERSION}`, platform)
  mkdirSync(cache, { recursive: true })
  copyFileSync(receipt.binary, join(cache, 'bun-runtime.exe'))
  const original = ORCAD_BUN_RELEASE_ASSETS[platform].executableSha256
  ORCAD_BUN_RELEASE_ASSETS[platform].executableSha256 = receipt.sha256
  return {
    receipt: {
      ...receipt,
      receiptSha256: receiptHash,
      candidateOverride: true,
      originalExecutablePin: original,
      expectedSourcePin: false,
      scope: 'diagnostic process only; private cache; production deployment validation retained'
    },
    restore: () => {
      ORCAD_BUN_RELEASE_ASSETS[platform].executableSha256 = original
    }
  }
}
