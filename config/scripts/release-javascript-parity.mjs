import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const ASSET_PATH = /^(?:renderer|web)\/assets\/(.+)-[\w-]{8}\.(js|css)$/
const P3_COLOR = /color\(display-p3 ([^)]+)\)/g

export function annotateJavascriptParityFiles(root, files) {
  const names = new Map()
  for (const file of files) {
    const match = file.path.match(ASSET_PATH)
    if (match) {
      const stem = `${match[1]}.${match[2]}`
      const entries = names.get(stem) ?? new Set()
      entries.add(basename(file.path))
      names.set(stem, entries)
    }
  }
  const replacements = new Map(
    [...names]
      .filter(([, entries]) => entries.size === 1)
      .map(([stem, entries]) => [[...entries][0], stem])
  )
  return files.map((file) => {
    const name = basename(file.path)
    const comparablePath = replacements.has(name)
      ? file.path.slice(0, -name.length) + replacements.get(name)
      : file.path
    if (!/\.(?:js|css|html|json)$/.test(file.path)) {
      return { ...file, comparablePath, comparableSha256: file.sha256 }
    }
    const content = readFileSync(join(root, file.path), 'utf8').replace(
      /[\w.-]+-[\w-]{8}\.(?:js|css)/g,
      (name) => replacements.get(name) ?? name
    )
    return {
      ...file,
      comparablePath,
      comparableSha256: createHash('sha256').update(content).digest('hex'),
      ...(file.path.endsWith('.css') ? { css: content } : {})
    }
  })
}

export function equivalentStylesheets(before, after) {
  const beforeColors = [...before.matchAll(P3_COLOR)]
  const afterColors = [...after.matchAll(P3_COLOR)]
  if (before.replace(P3_COLOR, 'P3_COLOR') !== after.replace(P3_COLOR, 'P3_COLOR')) {
    return false
  }
  if (beforeColors.length !== afterColors.length) {
    return false
  }
  return beforeColors.every((color, index) => {
    const left = color[1].split(/\s+/)
    const right = afterColors[index][1].split(/\s+/)
    return (
      left.length === right.length &&
      left.every((value, channel) => {
        if (value === right[channel]) {
          return true
        }
        // Native CSS color conversion differs by one printed decimal unit across hosts.
        return (
          /^-?(?:\d*\.)?\d+$/.test(value) &&
          /^-?(?:\d*\.)?\d+$/.test(right[channel]) &&
          Math.abs(Number(value) - Number(right[channel])) <= 0.00000101
        )
      })
    )
  })
}

export function compareJavascriptParityFiles(before, after) {
  const reference = new Map(before.map((file) => [file.comparablePath, file]))
  const candidate = new Map(after.map((file) => [file.comparablePath, file]))
  assert.equal(reference.size, before.length, 'Ambiguous baseline output paths')
  assert.equal(candidate.size, after.length, 'Ambiguous shared output paths')
  const changed = [...new Set([...reference.keys(), ...candidate.keys()])].filter((path) => {
    const left = reference.get(path)
    const right = candidate.get(path)
    if (!left || !right) {
      return true
    }
    if (left.comparableSha256 === right.comparableSha256) {
      return false
    }
    return !left.css || !right.css || !equivalentStylesheets(left.css, right.css)
  })
  return changed
}
