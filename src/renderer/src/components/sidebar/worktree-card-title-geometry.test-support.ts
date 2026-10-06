const X_GEOMETRY = /^-?(m[lrx]?|p[lrx]?|gap|w|size|space-x)-/

function describeX(element: Element): string {
  const classes = [...element.classList].filter((name) => X_GEOMETRY.test(name)).toSorted()
  // The DOM shim drops max() values, so inspect the card's raw padding declaration.
  const styles = (element.getAttribute('style') ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => /^(padding-left|margin-left|width):/.test(declaration))
  const width = element.getAttribute('width')
  return [...classes, ...styles, ...(width ? [`width=${width}`] : [])].join(' ')
}

function isRow(element: Element | null): boolean {
  const classes = element?.classList
  return (
    Boolean(classes && (classes.contains('flex') || classes.contains('inline-flex'))) &&
    !classes?.contains('flex-col')
  )
}

function precedingBoxSignature(element: Element): string[] {
  if (element.classList.contains('sr-only')) {
    return []
  }
  // Contents cannot widen a fixed-width status lane or icon-only pill.
  if (
    [...element.classList].some((name) => /^(w|size)-/.test(name)) ||
    element.hasAttribute('width') ||
    /\bwidth:/.test(element.getAttribute('style') ?? '')
  ) {
    return [describeX(element)]
  }
  return [describeX(element), ...[...element.children].flatMap(precedingBoxSignature)].filter(
    Boolean
  )
}

export function worktreeCardTitleXSignature(title: Element | null, stopAt: Element): string[] {
  const signature: string[] = []
  for (let node = title; node && node !== stopAt; node = node.parentElement) {
    signature.push(describeX(node))
    if (!isRow(node.parentElement)) {
      continue
    }
    let gaps = 0
    for (let before = node.previousElementSibling; before; before = before.previousElementSibling) {
      if (before.classList.contains('sr-only')) {
        continue
      }
      gaps++
      signature.push(...precedingBoxSignature(before).map((box) => `before: ${box}`))
    }
    // Each preceding flex item adds a gap even when its wrapper has no width class.
    if (gaps > 0) {
      signature.push(`gaps-before: ${gaps}`)
    }
  }
  return signature.filter(Boolean)
}
