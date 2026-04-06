import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { TDD_VALIDATION_TOOL_NAME, getTDDValidationPrompt } from './prompt.js'
import { readdir } from 'fs/promises'
import { join, dirname, basename } from 'path'

const inputSchema = lazySchema(() =>
  z.strictObject({
    target_files: z
      .array(z.string())
      .min(1)
      .describe('Source files you modified — test files are discovered automatically'),
    test_pattern: z
      .string()
      .optional()
      .describe('Glob or regex to restrict test file discovery (e.g. "*.test.ts")'),
    project_root: z
      .string()
      .optional()
      .describe('Absolute path to the project root. Defaults to cwd.'),
    bail: z
      .boolean()
      .optional()
      .default(true)
      .describe('Stop on first test failure (default: true)'),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(120_000)
      .optional()
      .default(30_000)
      .describe('Maximum time in ms to wait for tests (default: 30000)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type TestCase = {
  name: string
  status: 'pass' | 'fail' | 'skip'
  durationMs: number
  error?: string
}

type TestSuiteResult = {
  file: string
  passed: number
  failed: number
  skipped: number
  tests: TestCase[]
  durationMs: number
}

type TDDResult = {
  allPassed: boolean
  passed: number
  failed: number
  skipped: number
  suites: TestSuiteResult[]
  durationMs: number
  testRunner: string
}

async function detectTestRunner(root: string): Promise<'bun' | 'vitest' | 'jest' | 'unknown'> {
  try {
    const { readFile } = await import('fs/promises')
    const raw = await readFile(join(root, 'package.json'), { encoding: 'utf-8' })
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    const scripts = Object.values(pkg.scripts ?? {}).join(' ')

    if (allDeps['vitest'] || scripts.includes('vitest')) return 'vitest'
    if (allDeps['jest'] || scripts.includes('jest')) return 'jest'
    if (scripts.includes('bun test') || scripts.includes('bun:test')) return 'bun'

    // Check for bun.lock as strong signal for Bun runtime
    try {
      await readFile(join(root, 'bun.lock'))
      return 'bun'
    } catch { /* not found */ }

    return 'unknown'
  } catch {
    return 'bun' // default fallback for this project
  }
}

async function findTestFiles(
  sourceFiles: string[],
  root: string,
  testPattern?: string,
): Promise<string[]> {
  const testFiles: Set<string> = new Set()

  for (const sourceFile of sourceFiles) {
    const dir = dirname(sourceFile)
    const name = basename(sourceFile).replace(/\.(ts|tsx|js|jsx)$/, '')

    // Common test file naming conventions
    const candidates = [
      join(dir, `${name}.test.ts`),
      join(dir, `${name}.test.tsx`),
      join(dir, `${name}.spec.ts`),
      join(dir, `${name}.spec.tsx`),
      join(dir, '__tests__', `${name}.test.ts`),
      join(dir, '__tests__', `${name}.spec.ts`),
    ]

    for (const candidate of candidates) {
      try {
        const { stat } = await import('fs/promises')
        await stat(candidate)
        testFiles.add(candidate)
      } catch { /* file does not exist */ }
    }
  }

  // If no test files found by convention, do a broader scan
  if (testFiles.size === 0) {
    try {
      const entries = await readdir(root, { recursive: true, withFileTypes: true } as Parameters<typeof readdir>[1])
      for (const entry of entries as Awaited<ReturnType<typeof readdir>>) {
        // Type guard: entry has 'name' property
        const entryName = typeof entry === 'string' ? entry : (entry as { name: string }).name
        const pattern = testPattern ?? '.test.'
        if (entryName.includes(pattern) || entryName.includes('.spec.')) {
          testFiles.add(entryName)
        }
      }
    } catch { /* skip */ }
  }

  return [...testFiles]
}

function parseJSONTestOutput(output: string, file: string, durationMs: number): TestSuiteResult {
  const tests: TestCase[] = []
  let passed = 0, failed = 0, skipped = 0

  // Bun test output pattern: "✓ test name (Xms)" or "✗ test name"
  const passRegex = /✓\s+(.+?)(?:\s+\((\d+)ms\))?$/gm
  const failRegex = /✗\s+(.+?)(?:\s+\((\d+)ms\))?$/gm
  const errorRegex = /error:\s+(.+)/i

  let match: RegExpExecArray | null
  while ((match = passRegex.exec(output)) !== null) {
    tests.push({ name: match[1]?.trim() ?? '', status: 'pass', durationMs: parseInt(match[2] ?? '0', 10) })
    passed++
  }

  const errorLines = output.match(errorRegex)?.[1]
  while ((match = failRegex.exec(output)) !== null) {
    tests.push({
      name: match[1]?.trim() ?? '',
      status: 'fail',
      durationMs: parseInt(match[2] ?? '0', 10),
      error: errorLines,
    })
    failed++
  }

  return { file, passed, failed, skipped, tests, durationMs }
}

export const TDDValidationTool = buildTool({
  name: TDD_VALIDATION_TOOL_NAME,
  searchHint: 'run tests validate tdd jest vitest bun test coverage',
  maxResultSizeChars: 40_000,
  shouldDefer: true,

  async description(input) {
    const count = input.target_files?.length ?? 0
    return `Running tests for ${count} source file${count !== 1 ? 's' : ''}`
  },

  userFacingName() {
    return 'TDD Validation'
  },

  getActivityDescription(input) {
    const count = input.target_files?.length ?? 0
    return `Running tests (${count} file${count !== 1 ? 's' : ''})`
  },

  isEnabled() {
    return true
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isConcurrencySafe() {
    return false // Test execution modifies global state (coverage, etc.)
  },

  isReadOnly() {
    return true
  },

  toAutoClassifierInput(input) {
    return `run tests for ${input.target_files?.join(', ')}`
  },

  async checkPermissions() {
    return {
      behavior: 'passthrough',
      message: 'TDDValidationTool needs to execute test runner.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: TDD_VALIDATION_TOOL_NAME }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },

  async prompt() {
    return getTDDValidationPrompt()
  },

  renderToolUseMessage(input) {
    const files = input.target_files ?? []
    return `Testing: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const result = content as TDDResult
    const icon = result.allPassed ? '✅' : '❌'
    const lines = [
      `${icon} **${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped** (${result.durationMs}ms) — ${result.testRunner}`,
    ]
    for (const suite of result.suites.filter(s => s.failed > 0).slice(0, 3)) {
      lines.push(`  **${suite.file}**: ${suite.failed} failure${suite.failed !== 1 ? 's' : ''}`)
      for (const t of suite.tests.filter(tt => tt.status === 'fail').slice(0, 2)) {
        lines.push(`    ✗ ${t.name}${t.error ? `: ${t.error.slice(0, 100)}` : ''}`)
      }
    }
    return lines.join('\n')
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
    const signal = context.abortController.signal
    const start = Date.now()

    const [runner, testFiles] = await Promise.all([
      detectTestRunner(root),
      findTestFiles(input.target_files, root, input.test_pattern),
    ])

    if (testFiles.length === 0) {
      const result: TDDResult = {
        allPassed: true,
        passed: 0,
        failed: 0,
        skipped: 0,
        suites: [],
        durationMs: Date.now() - start,
        testRunner: runner,
      }
      return { data: result }
    }

    const { spawn } = await import('child_process')

    const runnerCmd = runner === 'vitest'
      ? ['bunx', 'vitest', 'run', '--reporter=json']
      : runner === 'jest'
        ? ['bunx', 'jest', '--json']
        : ['bun', 'test']

    const suites: TestSuiteResult[] = await Promise.all(
      testFiles.map(async (testFile): Promise<TestSuiteResult> => {
        const fileStart = Date.now()
        return new Promise<TestSuiteResult>((resolve) => {
          let output = ''
          const proc = spawn(runnerCmd[0]!, [...runnerCmd.slice(1), testFile], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal,
          })

          proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
          proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
          proc.on('close', () => resolve(parseJSONTestOutput(output, testFile, Date.now() - fileStart)))
          proc.on('error', () => resolve({ file: testFile, passed: 0, failed: 1, skipped: 0, tests: [{ name: 'runner error', status: 'fail', durationMs: 0, error: 'Test runner failed to start' }], durationMs: Date.now() - fileStart }))
        })
      }),
    )

    const totalPassed = suites.reduce((s, r) => s + r.passed, 0)
    const totalFailed = suites.reduce((s, r) => s + r.failed, 0)
    const totalSkipped = suites.reduce((s, r) => s + r.skipped, 0)

    const result: TDDResult = {
      allPassed: totalFailed === 0,
      passed: totalPassed,
      failed: totalFailed,
      skipped: totalSkipped,
      suites,
      durationMs: Date.now() - start,
      testRunner: runner,
    }

    return { data: result }
  },
})
