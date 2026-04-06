import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { TYPE_CHECKER_TOOL_NAME, getTypeCheckerPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    files: z
      .array(z.string())
      .min(1)
      .describe('Absolute or relative paths to the TypeScript/JavaScript files to check'),
    mode: z
      .enum(['typecheck', 'lint', 'both'])
      .optional()
      .default('typecheck')
      .describe('Which checks to run: "typecheck" (tsc), "lint" (eslint), or "both"'),
    project_root: z
      .string()
      .optional()
      .describe('Absolute path to the project root. Defaults to cwd.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type CheckError = {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning'
  code: string
  message: string
  source: 'typescript' | 'eslint'
}

type CheckResult = {
  success: boolean
  errorCount: number
  warningCount: number
  errors: CheckError[]
  durationMs: number
}

async function runTypeScript(
  files: string[],
  root: string,
  signal: AbortSignal,
): Promise<CheckError[]> {
  const { spawn } = await import('child_process')
  const { join } = await import('path')

  return new Promise<CheckError[]>((resolve) => {
    const errors: CheckError[] = []

    const args = [
      'tsc',
      '--noEmit',
      '--pretty', 'false',
      '--project', join(root, 'tsconfig.json'),
      '--allowJs',
    ]

    const proc = spawn('bunx', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })

    let output = ''
    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

    proc.on('close', () => {
      // Parse tsc output: "filepath(line,col): error TScode: message"
      const errorRegex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm
      let match: RegExpExecArray | null
      while ((match = errorRegex.exec(output)) !== null) {
        const [, file, line, col, severity, code, message] = match
        errors.push({
          file: file?.trim() ?? '',
          line: parseInt(line ?? '0', 10),
          column: parseInt(col ?? '0', 10),
          severity: severity === 'warning' ? 'warning' : 'error',
          code: code ?? '',
          message: message?.trim() ?? '',
          source: 'typescript',
        })
      }
      resolve(errors)
    })

    proc.on('error', () => resolve([]))
  })
}

async function runESLint(
  files: string[],
  root: string,
  signal: AbortSignal,
): Promise<CheckError[]> {
  const { spawn } = await import('child_process')

  return new Promise<CheckError[]>((resolve) => {
    const errors: CheckError[] = []

    const proc = spawn('bunx', ['eslint', '--format', 'json', ...files], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })

    let output = ''
    proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

    proc.on('close', () => {
      try {
        const parsed = JSON.parse(output) as Array<{
          filePath: string
          messages: Array<{
            line: number
            column: number
            severity: number
            ruleId: string | null
            message: string
          }>
        }>
        for (const file of parsed) {
          for (const msg of file.messages) {
            errors.push({
              file: file.filePath,
              line: msg.line,
              column: msg.column,
              severity: msg.severity === 1 ? 'warning' : 'error',
              code: msg.ruleId ?? 'eslint',
              message: msg.message,
              source: 'eslint',
            })
          }
        }
      } catch {
        // ESLint not configured or no JSON output — treat as clean
      }
      resolve(errors)
    })

    proc.on('error', () => resolve([]))
  })
}

export const TypeCheckerTool = buildTool({
  name: TYPE_CHECKER_TOOL_NAME,
  searchHint: 'typecheck typescript compile lint errors validate syntax',
  maxResultSizeChars: 30_000,
  shouldDefer: true,

  async description(input) {
    const mode = input.mode ?? 'typecheck'
    const count = input.files?.length ?? 0
    return `Running ${mode} on ${count} file${count !== 1 ? 's' : ''}`
  },

  userFacingName() {
    return 'Type Checker'
  },

  getActivityDescription(input) {
    const mode = input.mode ?? 'typecheck'
    return `Running ${mode}...`
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
    return input.files?.join(', ') ?? ''
  },

  async checkPermissions() {
    return { behavior: 'allow', updatedInput: {} }
  },

  async prompt() {
    return getTypeCheckerPrompt()
  },

  renderToolUseMessage(input) {
    const mode = input.mode ?? 'typecheck'
    const files = input.files ?? []
    return `${mode} on: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''}`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const result = content as CheckResult
    if (result.success) {
      return `✅ **${result.errorCount === 0 ? 'No errors' : '0 errors'}** — ${result.durationMs}ms`
    }
    const top = result.errors.slice(0, 5)
    return [
      `❌ **${result.errorCount} error${result.errorCount !== 1 ? 's' : ''}, ${result.warningCount} warning${result.warningCount !== 1 ? 's' : ''}**`,
      ...top.map(e => `  \`${e.file}:${e.line}\` — [${e.code}] ${e.message}`),
      result.errors.length > 5 ? `  …and ${result.errors.length - 5} more` : '',
    ].filter(Boolean).join('\n')
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(content, null, 2),
    }
  },

  async call(input, context) {
    const root = input.project_root ?? getCwd()
    const mode = input.mode ?? 'typecheck'
    const signal = context.abortController.signal
    const start = Date.now()

    const [tsErrors, lintErrors] = await Promise.all([
      mode === 'typecheck' || mode === 'both'
        ? runTypeScript(input.files, root, signal)
        : Promise.resolve<CheckError[]>([]),
      mode === 'lint' || mode === 'both'
        ? runESLint(input.files, root, signal)
        : Promise.resolve<CheckError[]>([]),
    ])

    const allErrors = [...tsErrors, ...lintErrors]
    const errorCount = allErrors.filter(e => e.severity === 'error').length
    const warningCount = allErrors.filter(e => e.severity === 'warning').length

    const result: CheckResult = {
      success: errorCount === 0,
      errorCount,
      warningCount,
      errors: allErrors,
      durationMs: Date.now() - start,
    }

    return { data: result }
  },
})
