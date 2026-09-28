import { describe, expect, it } from 'vitest'

import {
  compareShellFingerprints,
  explainingFiles,
  renderShellVerdictMarkdown
} from './mobile-shell-fingerprint-compare.mjs'
import {
  exportEnvironment,
  moduleDigestsFromSourceMap,
  repoPathOfBundleSource
} from './mobile-shell-fingerprint-export.mjs'
import { nativeSourceEntry, nativeSourcesDigest } from './mobile-shell-fingerprint-native.mjs'

type Bundle = { hash: string; modules: Record<string, string> }

function bundle(hash: string, modules: Record<string, string> = {}): Bundle {
  return { hash, modules }
}

function record(overrides: { nativeAndroid?: string; otaAndroid?: Bundle } = {}) {
  const nativeSources = [{ type: 'contents', id: 'expoConfig', hash: 'c1' }]
  return {
    format: 1,
    native: {
      android: { hash: overrides.nativeAndroid ?? 'n-a', sources: nativeSources },
      ios: { hash: 'n-i', sources: nativeSources }
    },
    shellJs: {
      native: { android: bundle('j-na', { 'mobile/src/a.ts': '1' }), ios: bundle('j-ni') },
      ota: {
        android: overrides.otaAndroid ?? bundle('j-oa', { 'mobile/src/a.ts': '1' }),
        ios: bundle('j-oi')
      }
    }
  }
}

describe('compareShellFingerprints', () => {
  it('reports an identical shell as unchanged', () => {
    const verdict = compareShellFingerprints(record(), record())
    expect(verdict.changed).toBe(false)
    expect(renderShellVerdictMarkdown(verdict)).toBe(
      '### Mobile shell: unchanged — OTA delivers this\n'
    )
  })

  it('names the changed bundle and the module files that explain it', () => {
    const head = record({
      otaAndroid: bundle('j-oa2', {
        'mobile/src/a.ts': '2',
        'mobile/node_modules/@scope/pkg/x.js': '9',
        'mobile/node_modules/@scope/pkg/y.js': '9'
      })
    })
    const verdict = compareShellFingerprints(record(), head)
    expect(verdict.changed).toBe(true)
    expect(verdict.parts).toEqual([{ kind: 'shellJs', variant: 'ota', platform: 'android' }])
    expect(renderShellVerdictMarkdown(verdict)).toBe(
      [
        '### Mobile shell: changed — OTA-shell JS (android)',
        '',
        'Sources that differ inside the changed bundles:',
        '- `changed: mobile/src/a.ts`',
        '- `added: mobile/node_modules/@scope/pkg/ (2 files)`',
        ''
      ].join('\n')
    )
  })

  it('says so when a bundle moved but no source module did', () => {
    const verdict = compareShellFingerprints(
      record(),
      record({ otaAndroid: bundle('j-oa2', { 'mobile/src/a.ts': '1' }) })
    )
    expect(renderShellVerdictMarkdown(verdict)).toContain('no source module differs')
  })

  it('explains a native change by its fingerprint sources', () => {
    const head = record({ nativeAndroid: 'n-a2' })
    head.native.android.sources = [
      { type: 'contents', id: 'expoConfig', hash: 'c2' },
      { type: 'dir', id: 'modules/orca-mobile-web-shell/android', hash: 'd1' }
    ]
    const verdict = compareShellFingerprints(record(), head)
    expect(verdict.parts[0]).toEqual({
      kind: 'native',
      platform: 'android',
      inputs: {
        added: ['dir modules/orca-mobile-web-shell/android'],
        removed: [],
        changed: ['contents expoConfig']
      }
    })
    expect(renderShellVerdictMarkdown(verdict, 'mobile-android-v0.0.50')).toContain(
      '### Mobile release needed since mobile-android-v0.0.50: yes — native project (android)'
    )
  })

  it('answers unknown instead of a verdict for unreadable or mismatched records', () => {
    expect(compareShellFingerprints(null, record()).changed).toBeNull()
    expect(renderShellVerdictMarkdown(compareShellFingerprints(record(), { format: 0 }))).toBe(
      '### Mobile shell: verdict unknown — fingerprint format differs\n'
    )
  })

  it('caps the explaining list', () => {
    const changed = Array.from({ length: 45 }, (_, index) => `mobile/src/f${index}.ts`)
    const lines = renderShellVerdictMarkdown({
      changed: true,
      reason: null,
      parts: [{ kind: 'shellJs', variant: 'native', platform: 'ios' }],
      files: { added: [], removed: [], changed }
    }).split('\n')
    expect(lines.filter((line) => line.startsWith('- `'))).toHaveLength(40)
    expect(lines).toContain('- … and 5 more')
  })
})

describe('bundle module explainer', () => {
  it('maps Metro source paths to repo paths without the pnpm store directory', () => {
    expect(repoPathOfBundleSource('/src/app.ts')).toBe('mobile/src/app.ts')
    expect(repoPathOfBundleSource('/../src/shared/protocol-version.ts')).toBe(
      'src/shared/protocol-version.ts'
    )
    expect(
      repoPathOfBundleSource(
        '/node_modules/.pnpm/react-native@0.83.10_patch_hash=abc/node_modules/react-native/index.js'
      )
    ).toBe('mobile/node_modules/react-native/index.js')
    expect(repoPathOfBundleSource('\0polyfill:environment-variables')).toBe(
      'virtual:polyfill:environment-variables'
    )
  })

  it('digests module contents and folds two installed versions into one key', () => {
    const modules = moduleDigestsFromSourceMap({
      sources: [
        '/src/a.ts',
        '/node_modules/.pnpm/pkg@1/node_modules/pkg/i.js',
        '/node_modules/.pnpm/pkg@2/node_modules/pkg/i.js'
      ],
      sourcesContent: ['a', 'one', 'two']
    })
    const swapped = moduleDigestsFromSourceMap({
      sources: [
        '/node_modules/.pnpm/pkg@2/node_modules/pkg/i.js',
        '/node_modules/.pnpm/pkg@1/node_modules/pkg/i.js',
        '/src/a.ts'
      ],
      sourcesContent: ['two', 'one', 'a']
    })
    expect(Object.keys(modules)).toEqual(['mobile/node_modules/pkg/i.js', 'mobile/src/a.ts'])
    expect(swapped).toEqual(modules)
  })

  it('collapses dependency files per package', () => {
    expect(
      explainingFiles({
        added: [],
        removed: ['mobile/node_modules/zod/a.js'],
        changed: ['src/shared/x.ts', 'mobile/node_modules/zod/b.js', 'mobile/node_modules/zod/c.js']
      })
    ).toEqual([
      'changed: src/shared/x.ts',
      'changed: mobile/node_modules/zod/ (2 files)',
      'removed: mobile/node_modules/zod/ (1 file)'
    ])
  })

  it('passes only the shell switch through to the bundle', () => {
    const env = { PATH: '/bin', EXPO_PUBLIC_MOBILE_SHELL: 'ota', EXPO_PUBLIC_OTHER: 'x' }
    expect(exportEnvironment(env, 'native')).toEqual({ PATH: '/bin' })
    expect(exportEnvironment(env, 'ota')).toEqual({ PATH: '/bin', EXPO_PUBLIC_MOBILE_SHELL: 'ota' })
  })
})

describe('native digest', () => {
  it('ignores git-ignored sources so a local prebuild dir cannot differ from CI', () => {
    const tracked = [nativeSourceEntry({ type: 'contents', id: 'expoConfig', hash: 'c1' })]
    const withPrebuild = [
      nativeSourceEntry({
        type: 'dir',
        filePath: 'android',
        reasons: ['bareNativeDir'],
        hash: null
      }),
      ...tracked
    ]
    expect(nativeSourcesDigest(withPrebuild)).toBe(nativeSourcesDigest(tracked))
    expect(nativeSourcesDigest(tracked)).not.toBe(
      nativeSourcesDigest([{ type: 'contents', id: 'expoConfig', hash: 'c2' }])
    )
  })
})
