import { readdir, stat } from 'fs/promises'
import { basename, join, sep } from 'path'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { INTENT_ALIGNMENT_TOOL_NAME, getIntentAlignmentPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    request: z
      .string()
      .min(3)
      .describe('The user natural-language request describing what they want to create or add'),
    project_root: z
      .string()
      .optional()
      .describe('Absolute path to the project root. Defaults to the current working directory.'),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .default(4)
      .describe('Maximum directory depth to scan (default: 4)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type AlignmentResult = {
  recommendedPath: string
  confidence: 'high' | 'medium' | 'low'
  reasoning: string
  existingConflicts: Array<{ path: string; reason: string }>
  reuseOpportunities: Array<{ path: string; reason: string }>
  suggestedFileName: string
}

// Semantic domain keywords for alignment scoring
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  auth: ['login', 'logout', 'auth', 'authentication', 'jwt', 'session', 'password', 'register', 'signup', 'signin', 'token'],
  user: ['user', 'profile', 'account', 'member'],
  payment: ['payment', 'checkout', 'billing', 'stripe', 'subscription', 'invoice', 'cart', 'order'],
  api: ['api', 'route', 'endpoint', 'controller', 'handler', 'middleware'],
  ui: ['component', 'page', 'view', 'screen', 'layout', 'widget', 'modal', 'button', 'form'],
  db: ['database', 'db', 'model', 'schema', 'migration', 'repository', 'entity', 'table'],
  util: ['util', 'helper', 'lib', 'shared', 'common', 'service'],
  test: ['test', 'spec', 'mock', 'fixture', '__tests__'],
}

function extractDomains(text: string): string[] {
  const lower = text.toLowerCase()
  return Object.entries(DOMAIN_KEYWORDS)
    .filter(([, keywords]) => keywords.some(kw => lower.includes(kw)))
    .map(([domain]) => domain)
}

function scoreDirectory(dirPath: string, requestDomains: string[]): number {
  const parts = dirPath.toLowerCase().split(sep)
  let score = 0
  for (const domain of requestDomains) {
    const keywords = DOMAIN_KEYWORDS[domain] ?? []
    for (const part of parts) {
      if (keywords.some(kw => part.includes(kw))) score += 2
    }
  }
  return score
}

async function walkDirectories(
  root: string,
  maxDepth: number,
  currentDepth = 0,
): Promise<string[]> {
  if (currentDepth >= maxDepth) return []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const dirs: string[] = []
    const subDirs: Promise<string[]>[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      // Skip hidden, node_modules, .git, dist, build
      if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build' || name === 'coverage') continue
      const fullPath = join(root, name)
      dirs.push(fullPath)
      subDirs.push(walkDirectories(fullPath, maxDepth, currentDepth + 1))
    }

    const nested = await Promise.all(subDirs)
    return [...dirs, ...nested.flat()]
  } catch {
    return []
  }
}

async function checkForConflicts(
  dirs: string[],
  requestDomains: string[],
  request: string,
): Promise<AlignmentResult['existingConflicts']> {
  const conflicts: AlignmentResult['existingConflicts'] = []
  const requestLower = request.toLowerCase()

  for (const dir of dirs) {
    const name = basename(dir).toLowerCase()
    // Check if this directory already handles the requested domain
    const matched = requestDomains.some(domain =>
      (DOMAIN_KEYWORDS[domain] ?? []).some(kw => name.includes(kw)),
    )
    if (matched) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const relevantFiles = entries
          .filter(e => e.isFile())
          .map(e => e.name.toLowerCase())
          .filter(fn => requestDomains.some(d => (DOMAIN_KEYWORDS[d] ?? []).some(kw => fn.includes(kw))))

        if (relevantFiles.length > 0) {
          conflicts.push({
            path: dir,
            reason: `Already contains ${relevantFiles.slice(0, 3).join(', ')} — check before creating new files`,
          })
        }
      } catch {
        // skip unreadable dirs
      }
    }
  }

  return conflicts.slice(0, 5)
}

function suggestFileName(request: string, domains: string[]): string {
  const lower = request.toLowerCase()
  const words = lower.match(/\b[a-z]+\b/g) ?? []
  // Remove stop words
  const stopWords = new Set(['a', 'an', 'the', 'create', 'add', 'make', 'build', 'implement', 'write', 'for', 'to', 'with', 'that', 'is', 'are'])
  const meaningful = words.filter(w => !stopWords.has(w) && w.length > 2).slice(0, 3)
  const base = meaningful.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  return base ? `${base}.ts` : 'NewModule.ts'
}

export const IntentAlignmentTool = buildTool({
  name: INTENT_ALIGNMENT_TOOL_NAME,
  searchHint: 'align user intent with project structure folder placement',
  maxResultSizeChars: 15_000,
  shouldDefer: true,

  async description(input) {
    return `Analyzing where "${input.request}" fits in the project structure`
  },

  userFacingName() {
    return 'Intent Alignment'
  },

  getActivityDescription(input) {
    return input.request ? `Aligning: ${input.request.slice(0, 60)}` : 'Aligning intent with project'
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
    return input.request
  },

  async checkPermissions() {
    return { behavior: 'allow', updatedInput: {} }
  },

  async prompt() {
    return getIntentAlignmentPrompt()
  },

  renderToolUseMessage(input) {
    return `Aligning intent: "${(input.request ?? '').slice(0, 80)}"`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const result = content as AlignmentResult
    return [
      `**Recommended path:** \`${result.recommendedPath}\``,
      `**Confidence:** ${result.confidence}`,
      `**Suggested file:** \`${result.suggestedFileName}\``,
      result.existingConflicts.length > 0
        ? `**⚠ Conflicts:** ${result.existingConflicts.map(c => c.path).join(', ')}`
        : '**✓ No conflicts detected**',
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
    const root = input.project_root ?? getCwd()
    const maxDepth = input.max_depth ?? 4
    const requestDomains = extractDomains(input.request)

    const allDirs = await walkDirectories(root, maxDepth)

    // Score directories by domain match
    const scored = allDirs
      .map(dir => ({ dir, score: scoreDirectory(dir, requestDomains) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)

    const topDir = scored[0]?.dir ?? join(root, 'src')
    const [conflicts] = await Promise.all([
      checkForConflicts(allDirs.slice(0, 50), requestDomains, input.request),
    ])

    const reuseOpportunities: AlignmentResult['reuseOpportunities'] = scored
      .slice(1, 4)
      .map(({ dir }) => ({
        path: dir,
        reason: 'Similar domain — consider reusing or extending before creating new files',
      }))

    const relativePath = topDir.replace(root, '').replace(/^[/\\]/, '') || 'src'
    const confidence: AlignmentResult['confidence'] =
      scored[0]?.score >= 4 ? 'high' : scored[0]?.score >= 2 ? 'medium' : 'low'

    const result: AlignmentResult = {
      recommendedPath: relativePath,
      confidence,
      reasoning: `Matched domains: [${requestDomains.join(', ')}]. Best directory score: ${scored[0]?.score ?? 0}`,
      existingConflicts: conflicts,
      reuseOpportunities,
      suggestedFileName: suggestFileName(input.request, requestDomains),
    }

    return { data: result }
  },
})
