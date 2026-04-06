import { readFile, readdir } from 'fs/promises'
import { join, relative } from 'path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { BLAST_RADIUS_TOOL_NAME, getBlastRadiusPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    target_file: z
      .string()
      .describe('The file you plan to modify — find all files that import it'),
    symbol: z
      .string()
      .optional()
      .describe('A specific exported symbol (function, type, constant) you plan to rename or change'),
    project_root: z
      .string()
      .optional()
      .describe('Absolute path to the project root. Defaults to cwd.'),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .default(3)
      .describe('Transitive dependency depth to trace (default: 3)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type BlastRadiusResult = {
  targetFile: string
  symbol?: string
  directDependents: string[]
  transitiveDependents: string[]
  totalAffectedFiles: number
  importLines: Array<{ file: string; importStatement: string; line: number }>
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  analysisMethod: 'ast-grep' | 'grep-fallback'
}

const IMPORT_PATTERNS = [
  /^\s*import\s+.+\s+from\s+['"](.+)['"]/,
  /^\s*import\s*\(\s*['"](.+)['"]\s*\)/,
  /^\s*(?:const|let|var)\s+.+\s*=\s*require\s*\(\s*['"](.+)['"]\s*\)/,
  /^\s*export\s+.+\s+from\s+['"](.+)['"]/,
]

function resolveImportPath(importPath: string, fromFile: string, root: string): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null // External dep
  const { resolve, dirname } = require('path') as typeof import('path')
  const base = importPath.startsWith('/') ? importPath : resolve(dirname(fromFile), importPath)
  // Normalize: add extensions
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js']) {
    try {
      const candidate = base + ext
      return relative(root, candidate)
    } catch {
      continue
    }
  }
  return null
}

async function collectAllSourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string) {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      await Promise.all(entries.map(async entry => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'dist', 'build', 'coverage', '.next'].includes(entry.name)) return
          await walk(path)
        } else if (/\.(ts|tsx|js|jsx|mts|cts)$/.test(entry.name)) {
          files.push(path)
        }
      }))
    } catch { /* skip */ }
  }
  await walk(root)
  return files
}

async function findImportersOfFile(
  targetRelative: string,
  targetAbsolute: string,
  allFiles: string[],
  root: string,
  symbol?: string,
): Promise<BlastRadiusResult['importLines']> {
  const importLines: BlastRadiusResult['importLines'] = []
  const targetName = targetRelative.replace(/\.(ts|tsx|js|jsx)$/, '')

  await Promise.all(
    allFiles.map(async (file) => {
      try {
        const content = await readFile(file, { encoding: 'utf-8' })
        const lines = content.split('\n')
        lines.forEach((line, idx) => {
          for (const pattern of IMPORT_PATTERNS) {
            const match = pattern.exec(line)
            if (!match) continue
            const importPath = match[1]!
            const resolved = resolveImportPath(importPath, file, root)
            const normalized = resolved?.replace(/\.(ts|tsx|js|jsx)$/, '')
            if (normalized === targetName || resolved === targetRelative || importPath.endsWith(targetName)) {
              // Check symbol if provided
              if (!symbol || line.includes(symbol)) {
                importLines.push({
                  file: relative(root, file),
                  importStatement: line.trim(),
                  line: idx + 1,
                })
              }
            }
          }
        })
      } catch { /* skip */ }
    }),
  )

  return importLines
}

export const BlastRadiusTool = buildTool({
  name: BLAST_RADIUS_TOOL_NAME,
  searchHint: 'find dependents imported by impact analysis refactoring',
  maxResultSizeChars: 25_000,
  shouldDefer: true,

  async description(input) {
    const sym = input.symbol ? ` (symbol: ${input.symbol})` : ''
    return `Analyzing blast radius of ${input.target_file}${sym}`
  },

  userFacingName() {
    return 'Blast Radius'
  },

  getActivityDescription(input) {
    return `Analyzing impact of ${input.target_file}`
  },

  isEnabled() {
    return true
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isConcurrencySafe() {
    return true
  },

  isReadOnly() {
    return true
  },

  toAutoClassifierInput(input) {
    return `blast radius ${input.target_file}`
  },

  async checkPermissions() {
    return { behavior: 'allow', updatedInput: {} }
  },

  async prompt() {
    return getBlastRadiusPrompt()
  },

  renderToolUseMessage(input) {
    return `Blast radius: \`${input.target_file}\`${input.symbol ? ` → \`${input.symbol}\`` : ''}`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const result = content as BlastRadiusResult
    const riskIcons = { low: '🟢', medium: '🟡', high: '🔴', critical: '🚨' }
    return [
      `${riskIcons[result.riskLevel]} **Risk: ${result.riskLevel.toUpperCase()}** — ${result.totalAffectedFiles} file${result.totalAffectedFiles !== 1 ? 's' : ''} affected`,
      `**Direct:** ${result.directDependents.slice(0, 5).join(', ')}${result.directDependents.length > 5 ? ` +${result.directDependents.length - 5}` : ''}`,
      result.transitiveDependents.length > 0
        ? `**Transitive:** ${result.transitiveDependents.slice(0, 3).join(', ')}${result.transitiveDependents.length > 3 ? ` +${result.transitiveDependents.length - 3}` : ''}`
        : '',
    ].filter(Boolean).join('\n')
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(content, null, 2),
    }
  },

  async call(input) {
    const root = input.project_root ?? getCwd()
    const targetAbsolute = input.target_file.startsWith('/')
      ? input.target_file
      : join(root, input.target_file)
    const targetRelative = relative(root, targetAbsolute)

    const allFiles = await collectAllSourceFiles(root)

    const directImportLines = await findImportersOfFile(
      targetRelative,
      targetAbsolute,
      allFiles,
      root,
      input.symbol,
    )

    const directDependents = [...new Set(directImportLines.map(i => i.file))]

    // Find transitive dependents (files that import the direct dependents)
    const transitiveSet = new Set<string>()
    const depth = Math.min(input.max_depth ?? 3, 3)

    if (depth > 1 && directDependents.length > 0) {
      const transitivePaths = await Promise.all(
        directDependents.slice(0, 20).map(async dep => {
          const depAbsolute = join(root, dep)
          const lines = await findImportersOfFile(dep, depAbsolute, allFiles, root)
          return lines.map(l => l.file)
        }),
      )
      for (const transFiles of transitivePaths) {
        for (const f of transFiles) {
          if (!directDependents.includes(f)) transitiveSet.add(f)
        }
      }
    }

    const transitiveDependents = [...transitiveSet].slice(0, 50)
    const totalAffectedFiles = directDependents.length + transitiveDependents.length

    const riskLevel: BlastRadiusResult['riskLevel'] =
      totalAffectedFiles >= 20 ? 'critical'
        : totalAffectedFiles >= 10 ? 'high'
          : totalAffectedFiles >= 3 ? 'medium'
            : 'low'

    const result: BlastRadiusResult = {
      targetFile: targetRelative,
      symbol: input.symbol,
      directDependents,
      transitiveDependents,
      totalAffectedFiles,
      importLines: directImportLines.slice(0, 30),
      riskLevel,
      analysisMethod: 'grep-fallback',
    }

    return { data: result }
  },
})
