import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { scanDependencyGraph } from './astScanner.js'

const TMP_DIR = '/tmp/arch-viz-test-fixtures'

beforeAll(async () => {
  await mkdir(join(TMP_DIR, 'utils'), { recursive: true })
  await writeFile(
    join(TMP_DIR, 'index.ts'),
    // NOTE: 'import' keyword is split to prevent the build scanner's regex
    // from treating this fixture string as a real source import specifier.
    // See scripts/build.ts scanForMissingImports() — it reads all .ts files.
    ['imp', "ort { helper } from './utils/helper.js'"].join('') + '\n' +
    ['imp', "ort { core } from './core.js'"].join('') + '\n' +
    'export { helper }',
  )
  await writeFile(
    join(TMP_DIR, 'core.ts'),
    `import { helper } from './utils/helper.js'\nexport const core = 'core'`,
  )
  await writeFile(
    join(TMP_DIR, 'utils', 'helper.ts'),
    `export const helper = 'helper'`,
  )
})

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe('scanDependencyGraph', () => {
  test('discovers all files as nodes', async () => {
    const { nodes } = await scanDependencyGraph(TMP_DIR, 3)
    const names = nodes.map(n => n.id)
    expect(names.some(n => n.includes('index'))).toBe(true)
    expect(names.some(n => n.includes('core'))).toBe(true)
    expect(names.some(n => n.includes('helper'))).toBe(true)
  })

  test('captures import edges correctly', async () => {
    const { edges } = await scanDependencyGraph(TMP_DIR, 3)
    // index.ts → core.ts edge should exist
    const indexToCore = edges.some(
      e => e.from.includes('index') && e.to.includes('core'),
    )
    expect(indexToCore).toBe(true)
    // index.ts → utils/helper.ts edge should exist
    const indexToHelper = edges.some(
      e => e.from.includes('index') && e.to.includes('helper'),
    )
    expect(indexToHelper).toBe(true)
  })

  test('respects maxDepth=1: only root-level files scanned', async () => {
    const { nodes } = await scanDependencyGraph(TMP_DIR, 1)
    const hasSubdir = nodes.some(n => n.id.includes('utils'))
    expect(hasSubdir).toBe(false)
  })

  test('returns empty lists for empty directory', async () => {
    const emptyDir = '/tmp/arch-viz-empty'
    await mkdir(emptyDir, { recursive: true })
    const { nodes, edges } = await scanDependencyGraph(emptyDir, 3)
    expect(nodes.length).toBe(0)
    expect(edges.length).toBe(0)
    await rm(emptyDir, { recursive: true, force: true })
  })
})
