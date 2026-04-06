import { readFile, writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { ATOMIC_SYNC_TOOL_NAME, getAtomicSyncPrompt } from './prompt.js'

const operationSchema = lazySchema(() =>
  z.object({
    file: z.string().describe('Absolute or relative path to the file'),
    content: z
      .string()
      .describe('New content for "write" mode, text to append for "append" mode, or unified diff for "patch" mode'),
    mode: z
      .enum(['write', 'append', 'patch'])
      .optional()
      .default('write')
      .describe('Operation type: "write" replaces entire content, "append" adds to end, "patch" applies unified diff'),
    encoding: z
      .enum(['utf-8', 'binary'])
      .optional()
      .default('utf-8')
      .describe('File encoding (default: utf-8)'),
  }),
)

const inputSchema = lazySchema(() =>
  z.strictObject({
    operations: z
      .array(operationSchema())
      .min(1)
      .max(50)
      .describe('List of file operations to apply atomically'),
    description: z
      .string()
      .optional()
      .describe('Human-readable description of what this atomic operation does (for logging)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type OperationResult = {
  file: string
  status: 'applied' | 'rolled_back' | 'skipped'
  error?: string
}

type AtomicSyncResult = {
  success: boolean
  applied: string[]
  rolledBack: string[]
  operations: OperationResult[]
  description?: string
  durationMs: number
}

type FileBackup = {
  file: string
  originalContent: string | null // null = file did not exist
}

function applyUnifiedDiff(original: string, diff: string): string {
  // Simple line-based unified diff applicator
  const hunkRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gm
  const originalLines = original.split('\n')
  const result: string[] = []
  const diffLines = diff.split('\n')

  let hunkMatch: RegExpExecArray | null
  let lastApplied = 0

  while ((hunkMatch = hunkRegex.exec(diff)) !== null) {
    const origStart = parseInt(hunkMatch[1]!, 10) - 1
    const hunkIndex = diffLines.indexOf(hunkMatch[0])

    // Copy unchanged lines before hunk
    result.push(...originalLines.slice(lastApplied, origStart))

    // Apply hunk lines
    let lineIdx = hunkIndex + 1
    while (lineIdx < diffLines.length && !diffLines[lineIdx]!.startsWith('@@')) {
      const line = diffLines[lineIdx]!
      if (line.startsWith('+')) {
        result.push(line.slice(1))
      } else if (!line.startsWith('-')) {
        result.push(line.slice(1)) // context line
      }
      // '-' lines are removed (not pushed)
      lineIdx++
    }

    const origCount = parseInt(hunkMatch[2] ?? '1', 10)
    lastApplied = origStart + origCount
  }

  // Copy remaining lines
  result.push(...originalLines.slice(lastApplied))
  return result.join('\n')
}

export const AtomicSyncTool = buildTool({
  name: ATOMIC_SYNC_TOOL_NAME,
  searchHint: 'atomic write multiple files transaction rollback batch edit',
  maxResultSizeChars: 10_000,
  shouldDefer: true,

  async description(input) {
    const count = input.operations?.length ?? 0
    return `Atomically ${input.description ?? `modifying ${count} file${count !== 1 ? 's' : ''}`}`
  },

  userFacingName() {
    return 'Atomic Sync'
  },

  getActivityDescription(input) {
    const count = input.operations?.length ?? 0
    return `Syncing ${count} file${count !== 1 ? 's' : ''} atomically`
  },

  isEnabled() {
    return true
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isConcurrencySafe() {
    return false // Writes to disk — must be serialized
  },

  isReadOnly() {
    return false
  },

  isDestructive(input) {
    return input.operations?.some((op: { mode?: string }) => op.mode === 'write') ?? false
  },

  toAutoClassifierInput(input) {
    const files = input.operations?.map((op: { file: string }) => op.file).join(', ') ?? ''
    return `atomic write to ${files}`
  },

  async checkPermissions(input) {
    const files = input.operations?.map((op: { file: string }) => op.file) ?? []
    return {
      behavior: 'passthrough',
      message: `AtomicSyncTool will modify ${files.length} file${files.length !== 1 ? 's' : ''} as a single transaction.`,
      suggestions: [
        {
          type: 'addRules',
          rules: files.map((f: string) => ({ toolName: ATOMIC_SYNC_TOOL_NAME, ruleContent: f })),
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    }
  },

  async prompt() {
    return getAtomicSyncPrompt()
  },

  renderToolUseMessage(input) {
    const ops = input.operations ?? []
    const files = ops.slice(0, 3).map((op: { file: string }) => op.file).join(', ')
    return `Atomic write: ${files}${ops.length > 3 ? ` +${ops.length - 3} more` : ''}`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const result = content as AtomicSyncResult
    if (result.success) {
      return `✅ **Committed** ${result.applied.length} file${result.applied.length !== 1 ? 's' : ''} (${result.durationMs}ms)`
    }
    return [
      `❌ **Rolled back** — ${result.operations.find(o => o.status === 'rolled_back' && o.error)?.error ?? 'write failed'}`,
      `Applied before rollback: ${result.applied.join(', ')}`,
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
    const backups: FileBackup[] = []
    const applied: string[] = []
    const operationResults: OperationResult[] = []

    // Phase 1: Read all existing content for rollback capability
    await Promise.all(
      input.operations.map(async (op: { file: string }) => {
        let originalContent: string | null = null
        try {
          originalContent = await readFile(op.file, { encoding: 'utf-8' })
        } catch {
          originalContent = null // File does not exist yet
        }
        backups.push({ file: op.file, originalContent })
      }),
    )

    // Phase 2: Apply operations sequentially (disk writes cannot be parallelized safely)
    for (const op of input.operations as Array<{ file: string; content: string; mode?: string; encoding?: string }>) {
      try {
        let contentToWrite: string

        if (op.mode === 'append') {
          const existing = backups.find(b => b.file === op.file)?.originalContent ?? ''
          contentToWrite = existing + op.content
        } else if (op.mode === 'patch') {
          const existing = backups.find(b => b.file === op.file)?.originalContent ?? ''
          contentToWrite = applyUnifiedDiff(existing, op.content)
        } else {
          contentToWrite = op.content
        }

        await writeFile(op.file, contentToWrite, { encoding: 'utf-8' })
        applied.push(op.file)
        operationResults.push({ file: op.file, status: 'applied' })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)

        // Phase 3: Rollback all applied files
        const rolledBack: string[] = []
        await Promise.all(
          applied.map(async (appliedFile) => {
            const backup = backups.find(b => b.file === appliedFile)
            if (!backup) return
            try {
              if (backup.originalContent === null) {
                const { unlink } = await import('fs/promises')
                await unlink(appliedFile).catch(() => {})
              } else {
                await writeFile(appliedFile, backup.originalContent, { encoding: 'utf-8' })
              }
              rolledBack.push(appliedFile)
              const idx = operationResults.findIndex(o => o.file === appliedFile)
              if (idx >= 0) operationResults[idx] = { file: appliedFile, status: 'rolled_back' }
            } catch { /* best effort */ }
          }),
        )

        operationResults.push({ file: op.file, status: 'rolled_back', error: errorMsg })

        const result: AtomicSyncResult = {
          success: false,
          applied: [],
          rolledBack,
          operations: operationResults,
          description: input.description,
          durationMs: Date.now() - start,
        }
        return { data: result }
      }
    }

    const result: AtomicSyncResult = {
      success: true,
      applied,
      rolledBack: [],
      operations: operationResults,
      description: input.description,
      durationMs: Date.now() - start,
    }
    return { data: result }
  },
})
