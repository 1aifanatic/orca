import { afterEach, describe, expect, it } from 'vitest'
import { pluginLanguageResourceId } from '../../../../shared/plugins/plugin-language-pack-artifact'
import { i18n, setRendererPluginLanguagePacks, setRendererUiLanguage } from '../../i18n/i18n'
import { getDiscardEntryConfirmationCopy } from './source-control/commit/discard-confirmation'

// Keys whose wording predates index-preserving discard ("revert all changes", "restore from HEAD").
const STALE_CONFIRMATION_KEYS = {
  modified: 'auto.components.right.sidebar.source.control.discard.confirmation.1426c2efff',
  deleted: 'auto.components.right.sidebar.source.control.discard.confirmation.40e9357b2a'
} as const

function describeDiscard(status: 'modified' | 'deleted'): string {
  return getDiscardEntryConfirmationCopy({ area: 'unstaged', path: `${status}.txt`, status })
    .description
}

afterEach(async () => {
  setRendererPluginLanguagePacks([])
  await i18n.changeLanguage('en')
})

describe('discard descriptions with real locale catalogs', () => {
  it.each(['en', 'es', 'fr', 'ja', 'ko', 'zh'] as const)(
    'never shows the pre-index-preserving wording in %s',
    async (locale) => {
      await i18n.changeLanguage(locale)
      for (const status of ['modified', 'deleted'] as const) {
        const stale = i18n.getResource(locale, 'translation', STALE_CONFIRMATION_KEYS[status])
        expect(describeDiscard(status)).not.toBe(stale)
      }
    }
  )

  it('falls back to the current English wording when a catalog holds only the old wording', async () => {
    // Why: an injected catalog stays untranslated; a shipped locale gains the current keys.
    const id = 'plugin:test.stale-discard/pt-BR' as const
    setRendererPluginLanguagePacks([
      {
        id,
        resourceLanguage: pluginLanguageResourceId(id),
        pluginKey: 'test.stale-discard',
        locale: 'pt-BR',
        catalog: {
          auto: {
            components: {
              right: {
                sidebar: {
                  source: {
                    control: {
                      discard: {
                        confirmation: {
                          '1426c2efff': 'Reverte todas as alterações.',
                          '40e9357b2a': 'Restaura o arquivo a partir do HEAD.'
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    ])
    await setRendererUiLanguage(id)
    expect(i18n.t(STALE_CONFIRMATION_KEYS.modified)).toBe('Reverte todas as alterações.')

    expect(describeDiscard('modified')).toBe(
      'This will revert the unstaged changes to this file. This cannot be undone.'
    )
    expect(describeDiscard('deleted')).toBe(
      'This will restore the last staged version and discard the deletion. This cannot be undone.'
    )
  })
})
