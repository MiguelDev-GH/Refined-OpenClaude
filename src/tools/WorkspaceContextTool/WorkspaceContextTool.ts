import { readFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { WORKSPACE_CONTEXT_TOOL_NAME, getWorkspaceContextPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    project_root: z
      .string()
      .optional()
      .describe(
        'Absolute path to the project root. Defaults to the current working directory.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type StackSummary = {
  runtime: string
  packageManager: string
  frameworks: string[]
  testRunner: string | null
  buildTool: string | null
  language: 'TypeScript' | 'JavaScript' | 'Mixed'
  entryPoints: string[]
  keyDependencies: string[]
  devDependencies: string[]
  scripts: Record<string, string>
  tsConfig: {
    target?: string
    moduleResolution?: string
    strict?: boolean
    paths?: Record<string, string[]>
  } | null
}

const FOUNDATION_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.env.example',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
]

const FRAMEWORK_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\breact\b/i, name: 'React' },
  { pattern: /\bnext\b/i, name: 'Next.js' },
  { pattern: /\bvite\b/i, name: 'Vite' },
  { pattern: /\bexpress\b/i, name: 'Express' },
  { pattern: /\bfastify\b/i, name: 'Fastify' },
  { pattern: /\bnestjs\b|@nestjs/i, name: 'NestJS' },
  { pattern: /\belectron\b/i, name: 'Electron' },
  { pattern: /\btauri\b/i, name: 'Tauri' },
  { pattern: /\bink\b/i, name: 'Ink (CLI/React)' },
  { pattern: /\bprisma\b/i, name: 'Prisma' },
  { pattern: /\bdrizzle\b/i, name: 'Drizzle ORM' },
  { pattern: /\btrpc\b/i, name: 'tRPC' },
  { pattern: /\bzod\b/i, name: 'Zod' },
]

const TEST_RUNNER_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bvitest\b/i, name: 'Vitest' },
  { pattern: /\bjest\b/i, name: 'Jest' },
  { pattern: /\bmocha\b/i, name: 'Mocha' },
  { pattern: /\bbun test\b/i, name: 'Bun Test' },
]

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, { encoding: 'utf-8' })
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

async function buildStackSummary(root: string): Promise<StackSummary> {
  const [pkg, tsconfig] = await Promise.all([
    readJsonSafe(join(root, 'package.json')),
    readJsonSafe(join(root, 'tsconfig.json')).then(
      tc => tc ?? readJsonSafe(join(root, 'tsconfig.base.json')),
    ),
  ])

  // Detect package manager from lockfile presence
  const lockfileChecks = await Promise.all(
    ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].map(
      async f => {
        try {
          await readFile(join(root, f))
          return f
        } catch {
          return null
        }
      },
    ),
  )
  const lockfile = lockfileChecks.find(Boolean)
  const packageManager = lockfile?.startsWith('bun')
    ? 'Bun'
    : lockfile?.startsWith('pnpm')
      ? 'pnpm'
      : lockfile?.startsWith('yarn')
        ? 'Yarn'
        : 'npm'

  const allDeps: Record<string, string> = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
    ...((pkg?.peerDependencies as Record<string, string>) ?? {}),
  }
  const depNames = Object.keys(allDeps).join(' ')

  const frameworks = FRAMEWORK_PATTERNS.filter(({ pattern }) => pattern.test(depNames)).map(
    ({ name }) => name,
  )

  const scripts = (pkg?.scripts as Record<string, string>) ?? {}
  const scriptValues = Object.values(scripts).join(' ')

  const testRunner =
    TEST_RUNNER_PATTERNS.find(({ pattern }) => pattern.test(depNames) || pattern.test(scriptValues))
      ?.name ?? null

  const buildTool = /\bvite\b/i.test(depNames)
    ? 'Vite'
    : /\bturbo\b/i.test(depNames)
      ? 'Turborepo'
      : /\bwebpack\b/i.test(depNames)
        ? 'Webpack'
        : lockfile?.startsWith('bun')
          ? 'Bun'
          : null

  const typescript = allDeps['typescript'] 
    || allDeps['@types/node'] 
    || Object.keys(allDeps).some(d => d.startsWith('@types/'))
  const hasJs = Object.keys(allDeps).some(d => d === 'babel-jest' || d === '@babel/core')
  const language: StackSummary['language'] = typescript && hasJs ? 'Mixed' : typescript ? 'TypeScript' : 'JavaScript'

  const main = (pkg?.main as string) ?? (pkg?.module as string) ?? null
  const bin = pkg?.bin
    ? typeof pkg.bin === 'string'
      ? [pkg.bin]
      : Object.values(pkg.bin as Record<string, string>)
    : []
  const entryPoints = [...(main ? [main] : []), ...bin].slice(0, 5)

  const keyDeps = Object.keys((pkg?.dependencies as Record<string, string>) ?? {}).slice(0, 15)
  const devDeps = Object.keys((pkg?.devDependencies as Record<string, string>) ?? {}).slice(0, 10)

  const compilerOptions = (tsconfig?.compilerOptions as Record<string, unknown>) ?? {}
  const tsconfigSummary = tsconfig
    ? {
        target: compilerOptions.target as string | undefined,
        moduleResolution: compilerOptions.moduleResolution as string | undefined,
        strict: compilerOptions.strict as boolean | undefined,
        paths: compilerOptions.paths as Record<string, string[]> | undefined,
      }
    : null

  return {
    runtime: lockfile?.startsWith('bun') ? 'Bun' : 'Node.js',
    packageManager,
    frameworks,
    testRunner,
    buildTool,
    language,
    entryPoints,
    keyDependencies: keyDeps,
    devDependencies: devDeps,
    scripts,
    tsConfig: tsconfigSummary,
  }
}

export const WorkspaceContextTool = buildTool({
  name: WORKSPACE_CONTEXT_TOOL_NAME,
  searchHint: 'analyze project tech stack dependencies frameworks runtime',
  maxResultSizeChars: 20_000,
  shouldDefer: false, // Always load — this is a session-start tool
  alwaysLoad: true,

  async description() {
    return 'Reads project foundation files to understand the tech stack, runtime, and dependencies'
  },

  userFacingName() {
    return 'Workspace Context'
  },

  getActivityDescription() {
    return 'Analyzing project stack'
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

  toAutoClassifierInput() {
    return ''
  },

  async checkPermissions() {
    return { behavior: 'allow', updatedInput: {} }
  },

  async prompt() {
    return getWorkspaceContextPrompt()
  },

  renderToolUseMessage(input) {
    const root = input.project_root ?? 'current directory'
    return `Analyzing workspace at: ${root}`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const summary = content as StackSummary
    const lines = [
      `**Runtime:** ${summary.runtime} (${summary.packageManager})`,
      `**Language:** ${summary.language}`,
      `**Frameworks:** ${summary.frameworks.join(', ') || 'none detected'}`,
      `**Test Runner:** ${summary.testRunner ?? 'not configured'}`,
      `**Build Tool:** ${summary.buildTool ?? 'not detected'}`,
      `**Key Deps:** ${summary.keyDependencies.slice(0, 8).join(', ')}`,
    ]
    return lines.join('\n')
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
    const summary = await buildStackSummary(root)
    return { data: summary }
  },
})
