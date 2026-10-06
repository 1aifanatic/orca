const VERTICAL_GEOMETRY =
  /^(-?(m[tyb]?|p[tyb]?|gap(-y)?|h|min-h|max-h|size|space-y|leading)-|border$)/

export function describeWorktreeVerticalGeometry(element: Element): string[] {
  return [
    ...[...element.classList].filter((name) => VERTICAL_GEOMETRY.test(name)).toSorted(),
    ...(element.getAttribute('style') ?? '')
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) =>
        /^(margin(-(top|bottom|block))?|padding(-(top|bottom|block))?|height|gap|row-gap):/.test(
          declaration
        )
      )
  ]
}

function rowHeightBoxes(element: Element): string[][] {
  if (['sr-only', 'absolute', 'hidden'].some((name) => element.classList.contains(name))) {
    return []
  }
  const geometry = describeWorktreeVerticalGeometry(element)
  if ([...element.classList].some((name) => /^(h|size)-/.test(name))) {
    return [geometry]
  }
  return [geometry, ...[...element.children].flatMap(rowHeightBoxes)].filter(
    (box) => box.length > 0
  )
}

function pathTo(element: Element, stopAt: Element): string[][] {
  const path: string[][] = []
  for (let node: Element | null = element; node && node !== stopAt; node = node.parentElement) {
    const geometry = describeWorktreeVerticalGeometry(node)
    if (geometry.length > 0) {
      path.push(geometry)
    }
    const parent = node.parentElement
    if (
      parent &&
      (parent.classList.contains('flex') || parent.classList.contains('inline-flex')) &&
      !parent.classList.contains('flex-col')
    ) {
      for (const sibling of parent.children) {
        if (sibling !== node) {
          path.push(
            ...rowHeightBoxes(sibling).map((box) => box.map((entry) => `row-neighbour: ${entry}`))
          )
        }
      }
    }
  }
  return path
}

function spacing(element: Element, prefix: string): number {
  const value = [...element.classList]
    .find((name) => name.startsWith(`${prefix}-`))
    ?.slice(prefix.length + 1)
  if (!value) {
    return 0
  }
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value) * 4
  }
  if (/^\[\d+(\.\d+)?px\]$/.test(value)) {
    return Number(value.slice(1, -3))
  }
  throw new Error(`Unhandled vertical length: ${value}`)
}

function topPadding(element: Element): number {
  return spacing(element, 'pt') || spacing(element, 'py') || spacing(element, 'p')
}

function bottomPadding(element: Element): number {
  return spacing(element, 'pb') || spacing(element, 'py') || spacing(element, 'p')
}

export function worktreeCardRootGap(list: HTMLElement): number {
  return list.style.rowGap
    ? Number.parseFloat(list.style.rowGap)
    : spacing(list, 'gap-y') || spacing(list, 'gap')
}

export function worktreeCardVerticalOffsets(
  surface: Element,
  nextRoot: Element,
  rootGap: number
): {
  chipToChildTitle: number
  childToSiblingTitle: number
  lastChildToNextRootTitle: number
} {
  const children = [...surface.querySelectorAll('[data-worktree-card-surface]')].filter(
    (child) => child.parentElement?.closest('[data-worktree-card-surface]') === surface
  )
  const [firstChild, sibling] = children
  if (!firstChild || !sibling) {
    throw new Error('Missing sibling cards')
  }
  let lineage: Element | null = firstChild.parentElement
  while (
    lineage &&
    lineage !== surface &&
    ![...lineage.classList].some((name) => name.startsWith('space-y-'))
  ) {
    lineage = lineage.parentElement
  }
  if (!lineage) {
    throw new Error('Missing lineage container')
  }
  const legacyStack = lineage.parentElement?.classList.contains('flex-col')
    ? spacing(lineage.parentElement, 'gap')
    : 0
  const border = (card: Element): number => (card.classList.contains('border') ? 1 : 0)
  return {
    chipToChildTitle:
      legacyStack + spacing(lineage, 'mt') + border(firstChild) + topPadding(firstChild),
    childToSiblingTitle: spacing(lineage, 'space-y') + border(sibling) + topPadding(sibling),
    lastChildToNextRootTitle:
      bottomPadding(surface) + border(surface) + rootGap + border(nextRoot) + topPadding(nextRoot)
  }
}

export function worktreeCardVerticalSignature(surface: Element): {
  surface: string[]
  title: string[][]
  chip: string[][] | undefined
  children: string[][][]
} {
  const title = surface.querySelector('[data-worktree-title-inline-rename]')
  if (!title) {
    throw new Error('Missing card title')
  }
  const chip = [...surface.querySelectorAll('button, span')].find((element) =>
    /^\d+ child(ren)?$/.test(element.textContent ?? '')
  )
  const children = [...surface.querySelectorAll('[data-worktree-card-surface]')].filter(
    (child) => child.parentElement?.closest('[data-worktree-card-surface]') === surface
  )
  return {
    surface: describeWorktreeVerticalGeometry(surface),
    title: pathTo(title, surface),
    chip: chip ? pathTo(chip, surface) : undefined,
    children: children.map((child) => pathTo(child, surface))
  }
}
