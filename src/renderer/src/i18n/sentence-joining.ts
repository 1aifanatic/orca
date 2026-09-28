import { getIntlLocale } from './i18n'

// Japanese and Chinese run sentences on after their full stop; the rest put a space between.
// Resolved through getIntlLocale() so a plugin pack's synthetic tag reads as the language it is.
const UNSPACED_LANGUAGES: ReadonlySet<string> = new Set(['ja', 'zh'])

/** Whole sentences as one passage, written the way the UI language writes one. */
export function joinUiSentences(sentences: readonly string[]): string {
  const language = getIntlLocale().split('-')[0].toLowerCase()
  return sentences.join(UNSPACED_LANGUAGES.has(language) ? '' : ' ')
}
