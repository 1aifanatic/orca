import { describe, expect, it } from 'vitest'
import { isHomeOrFilesystemRoot } from './home-or-filesystem-root'

describe('isHomeOrFilesystemRoot', () => {
  it.each([
    ['/'],
    ['C:\\'],
    ['c:/'],
    ['\\\\server\\share'],
    ['\\\\wsl.localhost\\Ubuntu\\'],
    ['//wsl$/Ubuntu']
  ])('treats %s as a filesystem root', (folderPath) => {
    expect(isHomeOrFilesystemRoot(folderPath, [])).toBe(true)
  })

  it('matches a home however its separators, trailing slash or drive case are spelled', () => {
    expect(isHomeOrFilesystemRoot('/home/u/', ['/home/u'])).toBe(true)
    expect(isHomeOrFilesystemRoot('c:\\users\\alice', [null, 'C:/Users/alice/'])).toBe(true)
    expect(
      isHomeOrFilesystemRoot('\\\\wsl.localhost\\Ubuntu\\home\\u', [
        undefined,
        '\\\\wsl$\\Ubuntu\\home\\u'
      ])
    ).toBe(true)
  })

  it('leaves folders inside a home, and other folders, alone', () => {
    expect(isHomeOrFilesystemRoot('/home/u/repo', ['/home/u'])).toBe(false)
    expect(isHomeOrFilesystemRoot('/home', ['/home/u'])).toBe(false)
    expect(isHomeOrFilesystemRoot('C:\\Users\\alice\\repo', ['C:\\Users\\alice'])).toBe(false)
    expect(isHomeOrFilesystemRoot('\\\\server\\share\\repo', [])).toBe(false)
    expect(isHomeOrFilesystemRoot('/srv/wt', [null, undefined])).toBe(false)
  })
})
