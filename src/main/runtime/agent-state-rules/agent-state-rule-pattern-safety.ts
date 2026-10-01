// Why a subset: rule patterns run on every poll over a whole screen, and Node has no linear-time
// regex engine, so anything that can backtrack super-linearly is refused when the file loads.
export function findUnsafePatternReason(pattern: string): string | null {
  try {
    new RegExp(pattern)
  } catch {
    return 'does not compile'
  }
  if (/\\[1-9]|\\k</.test(pattern)) {
    return 'uses a backreference'
  }
  if (/\(\?<[=!]/.test(pattern)) {
    return 'uses a lookbehind'
  }
  return hasNestedQuantifier(pattern) ? 'nests quantifiers' : null
}

function isRepeatingQuantifier(char: string | undefined): boolean {
  return char === '*' || char === '+' || char === '{'
}

// A repeated group whose body also repeats, e.g. `(a+)*` or `(?:x|y{2,})+`.
function hasNestedQuantifier(pattern: string): boolean {
  const groupRepeats: boolean[] = []
  let inClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\') {
      index += 1
    } else if (inClass) {
      inClass = char !== ']'
    } else if (char === '[') {
      inClass = true
    } else if (char === '(') {
      groupRepeats.push(false)
    } else if (char === ')') {
      const bodyRepeats = groupRepeats.pop() ?? false
      if (bodyRepeats && isRepeatingQuantifier(pattern[index + 1])) {
        return true
      }
      if (bodyRepeats && groupRepeats.length > 0) {
        groupRepeats[groupRepeats.length - 1] = true
      }
    } else if (isRepeatingQuantifier(char) && groupRepeats.length > 0) {
      groupRepeats[groupRepeats.length - 1] = true
    }
  }
  return false
}
