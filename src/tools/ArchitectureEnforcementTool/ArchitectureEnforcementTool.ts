import { readFile } from 'fs/promises'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { ARCHITECTURE_ENFORCEMENT_TOOL_NAME, getArchitectureEnforcementPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    files: z
      .array(z.string())
      .min(1)
      .describe('Files to audit for architecture violations'),
    rules: z
      .array(z.enum(['srp', 'dry', 'god_object', 'nesting', 'magic_values']))
      .optional()
      .describe('Specific rules to check. Omit to run all rules.'),
    god_object_threshold: z
      .number()
      .int()
      .min(3)
      .max(50)
      .optional()
      .default(10)
      .describe('Max exported symbols before flagging as God Object (default: 10)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Violation = {
  rule: string
  file: string
  line: number
  message: string
  suggestion: string
  severity: 'info' | 'warning' | 'error'
}

type ArchitectureResult = {
  violations: Violation[]
  score: number // 0-100
  files: Array<{ path: string; violationCount: number }>
  durationMs: number
}

function countNestingDepth(line: string): number {
  let depth = 0
  for (const ch of line) {
    if (ch === '{' || ch === '(' || ch === '[') depth++
  }
  return depth
}

function analyzeFile(
  content: string,
  filePath: string,
  rules: string[],
  godObjectThreshold: number,
): Violation[] {
  const violations: Violation[] = []
  const lines = content.split('\n')

  if (rules.includes('nesting')) {
    let currentDepth = 0
    lines.forEach((line, idx) => {
      const opens = (line.match(/[{([]/g) ?? []).length
      const closes = (line.match(/[})\]]/g) ?? []).length
      currentDepth += opens - closes

      // Flag deeply nested control structures (if/for/while inside 3+ levels)
      if (
        currentDepth >= 4 &&
        /\b(?:if|for|while|switch)\b/.test(line) &&
        !line.trim().startsWith('//')
      ) {
        violations.push({
          rule: 'nesting',
          file: filePath,
          line: idx + 1,
          message: `Control structure at nesting depth ${currentDepth} — consider early return or extraction`,
          suggestion: 'Extract inner logic into a named function to flatten the nesting',
          severity: currentDepth >= 5 ? 'error' : 'warning',
        })
      }
    })
  }

  if (rules.includes('srp')) {
    // Find functions/methods with too many responsibilities (heuristic: async operations + logging + db calls in same fn)
    let inFunction = false
    let functionStart = 0
    let functionName = ''
    let functionLines = 0
    let hasFetch = false, hasDb = false, hasLog = false, hasValidation = false

    lines.forEach((line, idx) => {
      const fnMatch = /(?:function\s+(\w+)|(\w+)\s*[=:]\s*(?:async\s+)?function|(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+\s*)?\{)/.exec(line)
      if (fnMatch && !inFunction) {
        inFunction = true
        functionStart = idx + 1
        functionName = fnMatch[1] ?? fnMatch[2] ?? fnMatch[3] ?? 'anonymous'
        functionLines = 0
        hasFetch = false; hasDb = false; hasLog = false; hasValidation = false
      }

      if (inFunction) {
        functionLines++
        if (/\b(?:fetch|axios|http\.get|request)\b/.test(line)) hasFetch = true
        if (/\b(?:db\.|prisma\.|mongoose\.|query\(|\.save\(|\.find\()\b/.test(line)) hasDb = true
        if (/\b(?:console\.|logger\.|logEvent\(|logError\()\b/.test(line)) hasLog = true
        if (/\b(?:validate|check|assert|guard|throw\s+new)\b/.test(line)) hasValidation = true
      }

      if (inFunction && line.includes('}') && functionLines > 5) {
        const responsibilityCount = [hasFetch, hasDb, hasLog, hasValidation].filter(Boolean).length
        if (responsibilityCount >= 3) {
          violations.push({
            rule: 'srp',
            file: filePath,
            line: functionStart,
            message: `Function "${functionName}" appears to handle ${responsibilityCount} distinct concerns (network, DB, logging, validation)`,
            suggestion: 'Split into specialized functions: one per responsibility (e.g., fetchData, validateInput, persistRecord)',
            severity: 'warning',
          })
        }
        inFunction = false
      }
    })
  }

  if (rules.includes('god_object')) {
    const exports = (content.match(/^export\s+(?:const|function|class|type|interface|enum)\s+\w+/gm) ?? [])
    if (exports.length > godObjectThreshold) {
      violations.push({
        rule: 'god_object',
        file: filePath,
        line: 1,
        message: `File has ${exports.length} exports (threshold: ${godObjectThreshold}) — potential God Object/Module`,
        suggestion: 'Split into focused sub-modules, each with a single cohesive responsibility',
        severity: exports.length > godObjectThreshold * 2 ? 'error' : 'warning',
      })
    }
  }

  if (rules.includes('magic_values')) {
    // Find magic numbers and strings (not in comments or string templates)
    lines.forEach((line, idx) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
      // Magic numbers: standalone numbers not in const declarations or array indices
      const magicNum = /(?<!=\s*)\b([2-9]\d{2,})\b(?!\s*:)/.exec(line)
      if (magicNum && !/^\s*(?:const|let|var)\s/.test(line) && !/timeout|port|limit|max|min|size/i.test(line)) {
        violations.push({
          rule: 'magic_values',
          file: filePath,
          line: idx + 1,
          message: `Magic number ${magicNum[1]} — extract to a named constant`,
          suggestion: `const MAX_RETRY_COUNT = ${magicNum[1]}`,
          severity: 'info',
        })
      }
    })
  }

  if (rules.includes('dry')) {
    // Detect duplicate lines (5+ identical non-trivial consecutive code segments)
    const significant = lines.filter(l => l.trim().length > 15 && !l.trim().startsWith('//'))
    const seen = new Map<string, number>()
    significant.forEach((line, idx) => {
      const trimmed = line.trim()
      if (seen.has(trimmed)) {
        const firstIdx = seen.get(trimmed)!
        violations.push({
          rule: 'dry',
          file: filePath,
          line: idx + 1,
          message: `Duplicate code: exact match of line ${firstIdx + 1} — violates DRY principle`,
          suggestion: 'Extract duplicated logic into a shared utility function',
          severity: 'info',
        })
      } else {
        seen.set(trimmed, idx)
      }
    })
  }

  return violations
}

export const ArchitectureEnforcementTool = buildTool({
  name: ARCHITECTURE_ENFORCEMENT_TOOL_NAME,
  searchHint: 'code quality SOLID clean architecture DRY SRP audit review',
  maxResultSizeChars: 30_000,
  shouldDefer: true,

  async description(input) {
    return `Auditing ${input.files?.length ?? 0} file${(input.files?.length ?? 0) !== 1 ? 's' : ''} for architecture violations`
  },

  userFacingName() {
    return 'Architecture Enforcement'
  },

  getActivityDescription() {
    return 'Auditing architecture...'
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
    return `architecture audit ${input.files?.join(', ')}`
  },

  async checkPermissions() {
    return { behavior: 'allow', updatedInput: {} }
  },

  async prompt() {
    return getArchitectureEnforcementPrompt()
  },

  renderToolUseMessage(input) {
    const files = input.files ?? []
    return `Architecture audit: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const result = content as ArchitectureResult
    const scoreIcon = result.score >= 80 ? '✅' : result.score >= 60 ? '🟡' : '❌'
    const errorViolations = result.violations.filter(v => v.severity === 'error').length
    const warnViolations = result.violations.filter(v => v.severity === 'warning').length
    return [
      `${scoreIcon} **Score: ${result.score}/100** — ${errorViolations} errors, ${warnViolations} warnings`,
      ...result.violations.filter(v => v.severity !== 'info').slice(0, 5).map(
        v => `  [${v.rule.toUpperCase()}] \`${v.file}:${v.line}\` — ${v.message}`,
      ),
    ].join('\n')
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
    const activeRules = input.rules ?? ['srp', 'dry', 'god_object', 'nesting', 'magic_values']
    const threshold = input.god_object_threshold ?? 10

    const fileResults = await Promise.all(
      input.files.map(async (filePath) => {
        try {
          const content = await readFile(filePath, { encoding: 'utf-8' })
          const violations = analyzeFile(content, filePath, activeRules, threshold)
          return { path: filePath, violations, violationCount: violations.length }
        } catch {
          return { path: filePath, violations: [], violationCount: 0 }
        }
      }),
    )

    const allViolations = fileResults.flatMap(f => f.violations)
    const errorCount = allViolations.filter(v => v.severity === 'error').length
    const warningCount = allViolations.filter(v => v.severity === 'warning').length
    const infoCount = allViolations.filter(v => v.severity === 'info').length

    // Score: start at 100, deduct per violation
    const score = Math.max(0, 100 - errorCount * 15 - warningCount * 5 - infoCount * 1)

    const result: ArchitectureResult = {
      violations: allViolations,
      score,
      files: fileResults.map(f => ({ path: f.path, violationCount: f.violationCount })),
      durationMs: Date.now() - start,
    }

    return { data: result }
  },
})
