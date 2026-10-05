import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'

import en from './locales/en.json'
import enRuntimeRequired from './en-runtime-required.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const catalogs = {
  es: { catalog: es, compactBalanceLabel: 'saldo' },
  fr: { catalog: fr, compactBalanceLabel: 'solde' },
  ja: { catalog: ja, compactBalanceLabel: '残高' },
  ko: { catalog: ko, compactBalanceLabel: '잔액' },
  zh: { catalog: zh, compactBalanceLabel: '余额' }
}
const balanceMessages = [
  ['StatusBar.4025a6f62f', 'Unlimited'],
  ['StatusBar.a95969101f', 'credits'],
  ['tooltip.fbc80d8be2', 'Zen balance'],
  ['tooltip.c03c61f53f', 'Balance'],
  ['tooltip.f6a27a3c0a', '{{value0}} available'],
  ['tooltip.7404abbece', 'Usage credits'],
  ['tooltip.473d45cd0f', 'Balance {{value0}}'],
  ['tooltip.f21b2ba897', 'Credits'],
  ['tooltip.56c0d70577', 'Unlimited'],
  ['tooltip.87b5bda4d3', '{{value0}} credits available'],
  [
    'provider.extra.usage.section.apiKeyBalanceUnavailable',
    'Balance is not included in this usage response.'
  ]
] as const

function balanceKey(suffix: string): string {
  return `auto.components.status.bar.${suffix}`
}

describe('provider credit balance sparse target catalogs', () => {
  it.each(Object.entries(catalogs))(
    '%s omits copied English balance entries',
    async (locale, { catalog }) => {
      const instance = createInstance()
      await instance.init({ lng: locale, resources: { [locale]: { translation: catalog } } })

      for (const [suffix] of balanceMessages) {
        expect(instance.getResource(locale, 'translation', balanceKey(suffix))).toBeUndefined()
      }
    }
  )

  it.each(Object.entries(catalogs))(
    '%s falls back and interpolates balance copy at runtime',
    async (locale, { catalog, compactBalanceLabel }) => {
      const instance = createInstance()
      await instance.init({
        lng: locale,
        fallbackLng: 'en',
        resources: { en: { translation: enRuntimeRequired }, [locale]: { translation: catalog } },
        interpolation: { escapeValue: false }
      })

      for (const [suffix, defaultValue] of balanceMessages) {
        expect(instance.t(balanceKey(suffix), { defaultValue, value0: '12.50' })).toBe(
          defaultValue.replace('{{value0}}', '12.50')
        )
      }
      expect(
        instance.t(balanceKey('tooltip.87b5bda4d3'), {
          defaultValue: '{{value0}} credits available',
          value0: 500
        })
      ).toBe('500 credits available')
      expect(instance.t(balanceKey('StatusBar.4fba7dc1e7'), { defaultValue: 'bal' })).toBe(
        compactBalanceLabel
      )
    }
  )

  it('retains every English source balance message', async () => {
    const instance = createInstance()
    await instance.init({ lng: 'en', resources: { en: { translation: en } } })

    for (const [suffix, value] of balanceMessages) {
      expect(instance.getResource('en', 'translation', balanceKey(suffix))).toBe(value)
    }
    expect(instance.getResource('en', 'translation', balanceKey('StatusBar.4fba7dc1e7'))).toBe(
      'bal'
    )
  })
})
