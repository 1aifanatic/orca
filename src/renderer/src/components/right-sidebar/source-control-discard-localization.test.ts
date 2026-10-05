import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n/i18n'
import { getDiscardEntryConfirmationCopy } from './source-control/commit/discard-confirmation'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

const DISCARD_DESCRIPTIONS = [
  {
    locale: 'en',
    unstaged: 'This will revert the unstaged changes to this file. This cannot be undone.',
    restore:
      'This will restore the last staged version and discard the deletion. This cannot be undone.'
  },
  {
    locale: 'es',
    unstaged: 'Esto revertirá los cambios no preparados de este archivo. No se puede deshacer.',
    restore:
      'Esto restaurará la última versión preparada y descartará la eliminación. No se puede deshacer.'
  },
  {
    locale: 'fr',
    unstaged:
      'Cela annulera les modifications non planifiées apportées à ce fichier. Cela ne peut pas être annulé.',
    restore:
      'Cela restaurera la dernière version intermédiaire et annulera la suppression. Cela ne peut pas être annulé.'
  },
  {
    locale: 'ja',
    unstaged:
      'これにより、このファイルに対するステージングされていない変更が元に戻ります。これを元に戻すことはできません。',
    restore:
      'これにより、最後にステージングされたバージョンが復元され、削除が破棄されます。これを元に戻すことはできません。'
  },
  {
    locale: 'ko',
    unstaged:
      '이렇게 하면 단계가 지정되지 않은 변경 사항이 이 파일로 되돌아갑니다. 이 작업은 취소할 수 없습니다.',
    restore:
      '이렇게 하면 마지막 단계 버전이 복원되고 삭제가 취소됩니다. 이 작업은 취소할 수 없습니다.'
  },
  {
    locale: 'zh',
    unstaged: '这将恢复对此文件的未暂存更改。此操作无法撤消。',
    restore: '这将恢复最后一个暂存版本并放弃删除。此操作无法撤消。'
  }
] as const

describe('discard descriptions with real locale catalogs', () => {
  it.each(DISCARD_DESCRIPTIONS)(
    'uses current index-preserving descriptions in $locale',
    async ({ locale, unstaged, restore }) => {
      await i18n.changeLanguage(locale)
      expect(
        getDiscardEntryConfirmationCopy({
          area: 'unstaged',
          path: 'changed.txt',
          status: 'modified'
        }).description
      ).toBe(unstaged)
      expect(
        getDiscardEntryConfirmationCopy({
          area: 'unstaged',
          path: 'removed.txt',
          status: 'deleted'
        }).description
      ).toBe(restore)
    }
  )
})
