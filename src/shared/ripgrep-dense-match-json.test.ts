import { expect, it } from 'vitest'
import { parseDenseRipgrepMatchJson } from './ripgrep-dense-match-json'

it('retains only exact match fields and the remaining range budget', () => {
  const ranges = [
    { start: 0, end: 1 },
    { start: 2, end: 3 }
  ]
  const source = {
    type: 'match',
    submatches: [{ start: 99, end: 100 }],
    data: {
      nested: { submatches: [{ start: 88, end: 89 }] },
      lines: { text: 'a "submatches" b', bytes: 'YQ==' },
      path: { text: '/root/a.ts' },
      line_number: 12,
      submatches: ranges
    }
  }
  expect(parseDenseRipgrepMatchJson(JSON.stringify(source), 1, 16)).toEqual({
    type: 'match',
    data: {
      lines: source.data.lines,
      path: source.data.path,
      line_number: 12,
      submatches: ranges.slice(0, 1)
    }
  })
})

it('rejects depth overflow and invalid submatch shapes', () => {
  expect(() => parseDenseRipgrepMatchJson('['.repeat(17), 2, 16)).toThrow()
  expect(() => parseDenseRipgrepMatchJson('{"data":{"submatches":[null]}}', 2, 16)).toThrow()
})

it.each(['{}', '{"type":"begin","data":{}}', '{"data":null}', '{"data":[]}'])(
  'does not fabricate a match from %s',
  (source) => {
    const projected = parseDenseRipgrepMatchJson(source, 2, 16)
    expect(projected.data?.path).toBeUndefined()
    expect(projected.data?.submatches).toEqual([])
  }
)
