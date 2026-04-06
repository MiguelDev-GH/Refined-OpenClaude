import { readdir, readFile } from 'fs/promises'
import { extname, join, relative, resolve } from 'path'

export type GraphNode = {
  id: string    // relative path from root
  label: string // basename without extension
}

export type GraphEdge = {
  from: string  // node id
  to: string    // node id
}

export type DependencyGraph = {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])

// Matches: import ... from '...' | require('...')
const IMPORT_RE = /(?:import\s+(?:[^'"]+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g

/**
 * Recursively collect all scannable source files up to `maxDepth` directory levels.
 */
async function collectFiles(dir: string, maxDepth: number, currentDepth = 0): Promise<string[]> {
  if (currentDepth >= maxDepth) return []
  let entries: import('fs').Dirent<string>[]
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await collectFiles(fullPath, maxDepth, currentDepth + 1)
      files.push(...nested)
    } else if (SCANNABLE_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath)
    }
  }
  return files
}

/**
 * Extract all static import / require target strings from a source file.
 */
async function extractImports(filePath: string): Promise<string[]> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return []
  }
  const imports: string[] = []
  let match: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((match = IMPORT_RE.exec(content)) !== null) {
    imports.push(match[1])
  }
  return imports
}

/**
 * Resolve a relative import specifier to a known file path in the fileset.
 * Handles `.js` → `.ts` aliasing common in ESM TypeScript projects.
 */
function resolveImport(
  fromFile: string,
  specifier: string,
  fileSetByAbsPath: Set<string>,
  rootDir: string,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null

  const fromDir = join(fromFile, '..')
  let resolved = resolve(fromDir, specifier)

  // Candidates: exact, .ts swap, /index.ts
  const candidates = [
    resolved,
    resolved.replace(/\.js$/, '.ts'),
    resolved.replace(/\.js$/, '.tsx'),
    resolved + '.ts',
    resolved + '.tsx',
    resolved + '.js',
    join(resolved, 'index.ts'),
    join(resolved, 'index.tsx'),
    join(resolved, 'index.js'),
  ]

  for (const candidate of candidates) {
    if (fileSetByAbsPath.has(candidate)) {
      return relative(rootDir, candidate)
    }
  }
  return null
}

/**
 * Scan a directory tree (up to maxDepth levels) and build an import dependency graph.
 */
export async function scanDependencyGraph(
  rootDir: string,
  maxDepth: number,
): Promise<DependencyGraph> {
  const absRoot = resolve(rootDir)
  const files = await collectFiles(absRoot, maxDepth)

  if (files.length === 0) return { nodes: [], edges: [] }

  const fileSetByAbsPath = new Set(files)

  const nodes: GraphNode[] = files.map(abs => {
    const id = relative(absRoot, abs)
    const label = id.replace(/\.[^.]+$/, '').split('/').pop() ?? id
    return { id, label }
  })

  const idSet = new Set(nodes.map(n => n.id))
  const edges: GraphEdge[] = []
  const seen = new Set<string>()

  await Promise.all(
    files.map(async abs => {
      const fromId = relative(absRoot, abs)
      const imports = await extractImports(abs)
      for (const specifier of imports) {
        const toId = resolveImport(abs, specifier, fileSetByAbsPath, absRoot)
        if (!toId || !idSet.has(toId)) continue
        const key = `${fromId}→${toId}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ from: fromId, to: toId })
      }
    }),
  )

  return { nodes, edges }
}
