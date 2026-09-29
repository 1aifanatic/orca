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
  assert.equal(receipt.producer, '34d1c11c67cbd1a653da1d07796daf7a1b0f2a7d')
  assert.equal(receipt.source, '744846f844374847c902b5e7fd59b4342a51ef99')
  assert.equal(receipt.patch, '276f475c90c6761c58b9f56b3f4bfafa079d0c29c5861b23d2320c9ff39c35fb')
  assert.equal(receipt.product, '2084c58ba5410106ce61153a9fb16cdb4b6e5301')
  assert.equal(String(receipt.producerRun), '36503596770')
  assert.equal(receipt.architecture, 'arm64')
  assert(typeof receipt.binary === 'string' && /^[a-f0-9]{64}$/.test(receipt.sha256))
  assert.equal(
    createHash('sha256').update(readFileSync(receipt.binary)).digest('hex'),
    receipt.sha256
  )
  const cache = join(state, 'orcad-artifacts', 'bun', `v${ORCAD_BUN_VERSION}`, 'win32-arm64')
  mkdirSync(cache, { recursive: true })
  copyFileSync(receipt.binary, join(cache, 'bun-runtime.exe'))
  const original = ORCAD_BUN_RELEASE_ASSETS['win32-arm64'].executableSha256
  ORCAD_BUN_RELEASE_ASSETS['win32-arm64'].executableSha256 = receipt.sha256
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
      ORCAD_BUN_RELEASE_ASSETS['win32-arm64'].executableSha256 = original
    }
  }
}
