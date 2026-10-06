import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// A database promise nobody awaits rejects into Node's unhandledRejection, which ends the
// process: one lost reply would drop every host on the cell. Production code must await,
// return, store, or hand off every promise from these files; `.catch(...)` counts as handled.
const DATABASE_FILES = new Set([
  'database.ts',
  'observed-relay-database.ts',
  'assignment-store.ts',
  'credential-store.ts'
])

const sourceDirectory = fileURLToPath(new URL('.', import.meta.url))

function productionFiles(): string[] {
  return readdirSync(sourceDirectory)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => join(sourceDirectory, entry))
}

function returnsPromise(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const type = checker.getTypeAtLocation(call)
  return type.getSymbol()?.getName() === 'Promise'
}

function calledInDatabaseFile(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const declaration = checker.getResolvedSignature(call)?.getDeclaration()
  if (!declaration) return false
  // Calls through the RelayDatabase interface resolve to its declaration in database.ts.
  return DATABASE_FILES.has(basename(declaration.getSourceFile().fileName))
}

// Walks a `.then/.catch/.finally` chain up to the expression that consumes it.
function consumer(call: ts.CallExpression): { node: ts.Node; caught: boolean } {
  let node: ts.Node = call
  let caught = false
  while (
    ts.isPropertyAccessExpression(node.parent) &&
    ts.isCallExpression(node.parent.parent) &&
    ['then', 'catch', 'finally'].includes(node.parent.name.text)
  ) {
    if (node.parent.name.text === 'catch') caught = true
    node = node.parent.parent
  }
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  return { node, caught }
}

function floats(call: ts.CallExpression): boolean {
  const { node, caught } = consumer(call)
  if (caught) return false
  return ts.isExpressionStatement(node.parent) || ts.isVoidExpression(node.parent)
}

function databaseCallCensus(): { floating: string[]; seen: number } {
  const files = productionFiles()
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true
  })
  const checker = program.getTypeChecker()
  const floating: string[] = []
  let seen = 0
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`not in program: ${file}`)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        returnsPromise(checker, node) &&
        calledInDatabaseFile(checker, node)
      ) {
        seen += 1
        if (floats(node)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
          floating.push(`${basename(file)}:${line + 1} ${node.expression.getText(source)}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { floating, seen }
}

describe('floating database promises', () => {
  it('finds none in production code', () => {
    const census = databaseCallCensus()
    // Resolution worked: a broken program would see no database calls and pass vacuously.
    expect(census.seen).toBeGreaterThan(500)
    expect(census.floating).toEqual([])
  }, 120_000)

  it('flags a floating call and accepts an awaited or caught one', () => {
    const call = (text: string): ts.CallExpression => {
      const source = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.ES2022, true)
      let found: ts.CallExpression | undefined
      const visit = (node: ts.Node): void => {
        if (!found && ts.isCallExpression(node) && node.expression.getText(source) === 'db.query') {
          found = node
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      if (!found) throw new Error('no db.query call')
      return found
    }
    expect(floats(call('db.query("x")'))).toBe(true)
    expect(floats(call('void db.query("x")'))).toBe(true)
    expect(floats(call('db.query("x").then(() => 1)'))).toBe(true)
    expect(floats(call('async () => { await db.query("x") }'))).toBe(false)
    expect(floats(call('db.query("x").catch(() => undefined)'))).toBe(false)
    expect(floats(call('const rows = db.query("x")'))).toBe(false)
  })
})
