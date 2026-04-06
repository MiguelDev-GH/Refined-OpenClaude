import { readFile } from 'fs/promises'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CODE_SMELL_DETECTOR_TOOL_NAME, getCodeSmellDetectorPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    files: z
      .array(z.string())
      .min(1)
      .describe('Files to analyze for code smells'),
    thresholds: z
      .object({
        cyclomatic_warn: z.number().optional().default(10),
        cyclomatic_error: z.number().optional().default(20),
        file_lines_warn: z.number().optional().default(300),
        file_lines_error: z.number().optional().default(500),
        function_lines_warn: z.number().optional().default(40),
        function_lines_error: z.number().optional().default(80),
        param_count_warn: z.number().optional().default(4),
        param_count_error: z.number().optional().default(7),
      })
      .optional()
      .describe('Override default warning/error thresholds'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Smell = {
  type: string
  severity: 'info' | 'warning' | 'error'
  line: number
  message: string
}

type FileMetrics = {
  path: string
  totalLines: number
  functionsAnalyzed: number
  avgFunctionLength: number
  maxCyclomaticComplexity: number
  todoCount: number
  smells: Smell[]
}

type SmellDetectorResult = {
  files: FileMetrics[]
  summary: {
    totalSmells: number
    errors: number
    warnings: number
    infos: number
    mostComplexFile: string
    longestFile: string
  }
  durationMs: number
}

type Thresholds = {
  cyclomatic_warn: number
  cyclomatic_error: number
  file_lines_warn: number
  file_lines_error: number
  function_lines_warn: number
  function_lines_error: number
  param_count_warn: number
  param_count_error: number
}

function computeCyclomaticComplexity(content: string): number {
  // Count decision points: if, else if, for, while, case, catch, &&, ||, ternary
  const decisionPatterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bcase\s+.+:/g,
    /\bcatch\s*\(/g,
    /&&/g,
    /\|\|/g,
    /\?[^:]/g,
  ]

  let count = 1 // Base complexity
  for (const pattern of decisionPatterns) {
    const matches = content.match(pattern)
    if (matches) count += matches.length
  }
  return count
}

function findFunctions(content: string): Array<{ name: string; startLine: number; lineCount: number; paramCount: number }> {
  const lines = content.split('\n')
  const functions: Array<{ name: string; startLine: number; lineCount: number; paramCount: number }> = []

  const FN_PATTERN = /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*\S+\s*)?=>|(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*\S+\s*)?\s*\{)/

  let depth = 0
  let inFunction = false
  let functionStart = 0
  let currentFuncName = ''
  let currentParamCount = 0

  lines.forEach((line, idx) => {
    const match = FN_PATTERN.exec(line)
    if (match && depth === 0) {
      const name = match[1] ?? match[3] ?? match[5] ?? 'anonymous'
      const params = match[2] ?? match[4] ?? match[6] ?? ''
      const paramCount = params.trim() === '' ? 0 : params.split(',').length
      inFunction = true
      functionStart = idx
      currentFuncName = name
      currentParamCount = paramCount
    }

    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    depth += opens - closes

    if (inFunction && depth === 0 && idx > functionStart) {
      functions.push({
        name: currentFuncName,
        startLine: functionStart + 1,
        lineCount: idx - functionStart + 1,
        paramCount: currentParamCount,
      })
      inFunction = false
    }
  })

  return functions
}

function analyzeFileSmells(
  content: string,
  filePath: string,
  thresholds: Thresholds,
): FileMetrics {
  const lines = content.split('\n')
  const smells: Smell[] = []
  const totalLines = lines.length

  // File length
  if (totalLines >= thresholds.file_lines_error) {
    smells.push({
      type: 'file_length',
      severity: 'error',
      line: 1,
      message: `File has ${totalLines} lines (error threshold: ${thresholds.file_lines_error}) — split into focused modules`,
    })
  } else if (totalLines >= thresholds.file_lines_warn) {
    smells.push({
      type: 'file_length',
      severity: 'warning',
      line: 1,
      message: `File has ${totalLines} lines (warn threshold: ${thresholds.file_lines_warn}) — consider splitting`,
    })
  }

  // TODO/FIXME density
  const todoLines = lines.filter(l => /\b(?:TODO|FIXME|HACK|XXX)\b/.test(l))
  const todoDensity = todoLines.length / totalLines
  const todoCount = todoLines.length
  if (todoDensity > 0.05) {
    smells.push({
      type: 'todo_density',
      severity: 'info',
      line: 1,
      message: `${todoCount} TODO/FIXME markers (${(todoDensity * 100).toFixed(1)}% of file) — high technical debt indicator`,
    })
  }

  // Function analysis
  const functions = findFunctions(content)
  let totalFunctionLines = 0
  let maxCyclomatic = 1

  for (const fn of functions) {
    const fnContent = lines.slice(fn.startLine - 1, fn.startLine - 1 + fn.lineCount).join('\n')
    const complexity = computeCyclomaticComplexity(fnContent)
    maxCyclomatic = Math.max(maxCyclomatic, complexity)
    totalFunctionLines += fn.lineCount

    // Function length
    if (fn.lineCount >= thresholds.function_lines_error) {
      smells.push({
        type: 'function_length',
        severity: 'error',
        line: fn.startLine,
        message: `Function "${fn.name}" has ${fn.lineCount} lines (error: ${thresholds.function_lines_error}) — extract sub-functions`,
      })
    } else if (fn.lineCount >= thresholds.function_lines_warn) {
      smells.push({
        type: 'function_length',
        severity: 'warning',
        line: fn.startLine,
        message: `Function "${fn.name}" has ${fn.lineCount} lines (warn: ${thresholds.function_lines_warn})`,
      })
    }

    // Parameter count
    if (fn.paramCount >= thresholds.param_count_error) {
      smells.push({
        type: 'parameter_count',
        severity: 'error',
        line: fn.startLine,
        message: `Function "${fn.name}" has ${fn.paramCount} parameters (error: ${thresholds.param_count_error}) — use an options object`,
      })
    } else if (fn.paramCount >= thresholds.param_count_warn) {
      smells.push({
        type: 'parameter_count',
        severity: 'warning',
        line: fn.startLine,
        message: `Function "${fn.name}" has ${fn.paramCount} parameters (warn: ${thresholds.param_count_warn})`,
      })
    }

    // Cyclomatic complexity
    if (complexity >= thresholds.cyclomatic_error) {
      smells.push({
        type: 'cyclomatic_complexity',
        severity: 'error',
        line: fn.startLine,
        message: `Function "${fn.name}" cyclomatic complexity: ${complexity} (error: ${thresholds.cyclomatic_error}) — reduce branching`,
      })
    } else if (complexity >= thresholds.cyclomatic_warn) {
      smells.push({
        type: 'cyclomatic_complexity',
        severity: 'warning',
        line: fn.startLine,
        message: `Function "${fn.name}" cyclomatic complexity: ${complexity} (warn: ${thresholds.cyclomatic_warn})`,
      })
    }
  }

  const avgFunctionLength = functions.length > 0 ? totalFunctionLines / functions.length : 0

  return {
    path: filePath,
    totalLines,
    functionsAnalyzed: functions.length,
    avgFunctionLength: Math.round(avgFunctionLength),
    maxCyclomaticComplexity: maxCyclomatic,
    todoCount,
    smells,
  }
}

export const CodeSmellDetectorTool = buildTool({
  name: CODE_SMELL_DETECTOR_TOOL_NAME,
  searchHint: 'code quality metrics complexity maintainability static analysis',
  maxResultSizeChars: 40_000,
  shouldDefer: true,

  async description(input) {
    return `Detecting code smells in ${input.files?.length ?? 0} file${(input.files?.length ?? 0) !== 1 ? 's' : ''}`
  },

  userFacingName() {
    return 'Code Smell Detector'
  },

  getActivityDescription() {
    return 'Detecting code smells...'
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
    return `code smell analysis ${input.files?.join(', ')}`
  },

  async checkPermissions() {
    return { behavior: 'allow', updatedInput: {} }
  },

  async prompt() {
    return getCodeSmellDetectorPrompt()
  },

  renderToolUseMessage(input) {
    const files = input.files ?? []
    return `Smell detection: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const result = content as SmellDetectorResult
    const s = result.summary
    const icon = s.errors === 0 ? (s.warnings === 0 ? '✅' : '🟡') : '❌'
    return [
      `${icon} **${s.errors} errors, ${s.warnings} warnings, ${s.infos} info** across ${result.files.length} file${result.files.length !== 1 ? 's' : ''}`,
      s.longestFile ? `**Longest file:** ${s.longestFile}` : '',
      s.mostComplexFile ? `**Most complex:** ${s.mostComplexFile}` : '',
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
    const start = Date.now()
    const thresholds: Thresholds = {
      cyclomatic_warn: input.thresholds?.cyclomatic_warn ?? 10,
      cyclomatic_error: input.thresholds?.cyclomatic_error ?? 20,
      file_lines_warn: input.thresholds?.file_lines_warn ?? 300,
      file_lines_error: input.thresholds?.file_lines_error ?? 500,
      function_lines_warn: input.thresholds?.function_lines_warn ?? 40,
      function_lines_error: input.thresholds?.function_lines_error ?? 80,
      param_count_warn: input.thresholds?.param_count_warn ?? 4,
      param_count_error: input.thresholds?.param_count_error ?? 7,
    }

    const fileMetrics = await Promise.all(
      input.files.map(async (filePath) => {
        try {
          const content = await readFile(filePath, { encoding: 'utf-8' })
          return analyzeFileSmells(content, filePath, thresholds)
        } catch {
          return {
            path: filePath,
            totalLines: 0,
            functionsAnalyzed: 0,
            avgFunctionLength: 0,
            maxCyclomaticComplexity: 0,
            todoCount: 0,
            smells: [] as Smell[],
          }
        }
      }),
    )

    const allSmells = fileMetrics.flatMap(f => f.smells)
    const errors = allSmells.filter(s => s.severity === 'error').length
    const warnings = allSmells.filter(s => s.severity === 'warning').length
    const infos = allSmells.filter(s => s.severity === 'info').length

    const longestFile = fileMetrics.reduce((max, f) => f.totalLines > (max?.totalLines ?? 0) ? f : max, fileMetrics[0])
    const mostComplexFile = fileMetrics.reduce((max, f) => f.maxCyclomaticComplexity > (max?.maxCyclomaticComplexity ?? 0) ? f : max, fileMetrics[0])

    const result: SmellDetectorResult = {
      files: fileMetrics,
      summary: {
        totalSmells: allSmells.length,
        errors,
        warnings,
        infos,
        mostComplexFile: mostComplexFile?.path ?? '',
        longestFile: longestFile?.path ?? '',
      },
      durationMs: Date.now() - start,
    }

    return { data: result }
  },
})
