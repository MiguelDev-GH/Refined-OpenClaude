import { readFile, writeFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import { logForDebugging } from '../utils/debug.js'
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from './memdir.js'

/**
 * Strict Write Discipline:
 * Validates that a memory file was successfully written with valid frontmatter
 * BEFORE appending its pointer to the MEMORY.md index.
 *
 * This prevents the crystallization of broken pointers in the central index —
 * a common cause of context hallucination where the model references entries
 * whose backing files were never created or are malformed.
 *
 * Usage pattern (enforced by behavioral instructions in buildMemoryLines):
 *   1. Write the memory file
 *   2. Call validateMemoryFileBeforeIndex() — proceed only if { valid: true }
 *   3. Append the pointer to MEMORY.md
 */
export async function validateMemoryFileBeforeIndex(
  filePath: string,
  expectedMinBytes: number = 10,
): Promise<{ valid: boolean; reason?: string }> {
  const fs = getFsImplementation()

  // Check existence and minimum size
  let content: string
  try {
    const stats = await stat(filePath)
    if (stats.size < expectedMinBytes) {
      return {
        valid: false,
        reason: `File is too small (${stats.size} bytes, minimum ${expectedMinBytes}) — write may have failed silently`,
      }
    }
    content = await readFile(filePath, { encoding: 'utf-8' })
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined
    return {
      valid: false,
      reason: code === 'ENOENT'
        ? `File does not exist: ${filePath} — write tool must be invoked before indexing`
        : `Cannot read file: ${String(e)}`,
    }
  }

  // Validate frontmatter structure (required fields: name, description, type)
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) {
    return {
      valid: false,
      reason: `Missing YAML frontmatter. Memory files must begin with ---\\nname: ...\\ndescription: ...\\ntype: ...\\n---`,
    }
  }

  const frontmatter = frontmatterMatch[1] ?? ''
  const requiredFields = ['name', 'description', 'type']
  const missingFields = requiredFields.filter(field => !new RegExp(`^${field}:\\s*.+`, 'm').test(frontmatter))

  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: `Frontmatter is missing required fields: ${missingFields.join(', ')}. These are mandatory for memory indexing.`,
    }
  }

  // Validate type is one of the allowed taxonomy values
  const typeMatch = frontmatter.match(/^type:\s*(.+)$/m)
  const typeValue = typeMatch?.[1]?.trim()
  const allowedTypes = ['user', 'feedback', 'project', 'reference']
  if (typeValue && !allowedTypes.includes(typeValue)) {
    return {
      valid: false,
      reason: `Invalid memory type: "${typeValue}". Must be one of: ${allowedTypes.join(', ')}`,
    }
  }

  return { valid: true }
}

/**
 * AutoDream: Asynchronous periodic memory consolidation.
 *
 * When feature('AUTODREAM') is enabled, this function distills append-only daily log
 * files (written by the KAIROS daily-log prompt) into structured topic memory files
 * and updates MEMORY.md index with validated pointers.
 *
 * Design principles:
 * - Fire-and-forget: called without await; any error is logged but does not crash the session
 * - Idempotent: re-running on the same log file produces the same result
 * - Non-destructive: log files are never deleted; only the index and topic files are modified
 * - Strict Write Discipline: every new topic file is validated before its pointer is indexed
 *
 * Activation: set CLAUDE_CODE_AUTODREAM=true in environment variables.
 * Feature flag: feature('AUTODREAM') must be true in the Bun bundle configuration.
 */

/** Memory entry extracted from log analysis */
type DreamEntry = {
  title: string
  description: string
  type: 'user' | 'feedback' | 'project' | 'reference'
  content: string
  sourceLog: string
}

const AUTODREAM_ENABLED = typeof process !== 'undefined' && process.env.CLAUDE_CODE_AUTODREAM === 'true'

/**
 * Parse a daily log file into structured memory entries.
 * Heuristic: groups bullet points by topic proximity and infers type from keywords.
 */
function parseDailyLog(logContent: string, logPath: string): DreamEntry[] {
  const entries: DreamEntry[] = []
  const lines = logContent.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))

  // Group lines into thematic clusters (simple sequential grouping by keyword proximity)
  let currentGroup: string[] = []
  let currentType: DreamEntry['type'] = 'reference'

  const userKeywords = /prefer|like|want|use\s+(bun|npm|yarn)|don'?t\s+(?:use|do|want)/i
  const feedbackKeywords = /feedback|correction|wrong|mistake|should\s+have|next\s+time/i
  const projectKeywords = /project|deadline|architecture|decision|because|rationale|PR|issue|bug/i

  for (const line of lines) {
    const text = line.replace(/^[-*]\s*/, '').trim()
    if (!text || text.length < 10) continue

    if (userKeywords.test(text)) currentType = 'user'
    else if (feedbackKeywords.test(text)) currentType = 'feedback'
    else if (projectKeywords.test(text)) currentType = 'project'
    else currentType = 'reference'

    currentGroup.push(text)

    // Emit entry when group is large enough or type changes significantly
    if (currentGroup.length >= 3) {
      const title = currentGroup[0]!.slice(0, 60).replace(/[^a-zA-Z0-9\s]/g, '').trim()
      entries.push({
        title: title || 'Memory Fragment',
        description: currentGroup[0]!.slice(0, 120),
        type: currentType,
        content: currentGroup.join('\n'),
        sourceLog: logPath,
      })
      currentGroup = []
    }
  }

  // Flush remaining
  if (currentGroup.length > 0) {
    const title = currentGroup[0]!.slice(0, 60).replace(/[^a-zA-Z0-9\s]/g, '').trim()
    entries.push({
      title: title || 'Memory Fragment',
      description: currentGroup[0]!.slice(0, 120),
      type: currentType,
      content: currentGroup.join('\n'),
      sourceLog: logPath,
    })
  }

  return entries
}

/**
 * Write a single dream entry as a topic memory file with proper frontmatter.
 * Validates the file before returning the index pointer.
 */
async function writeDreamEntry(
  entry: DreamEntry,
  memoryDir: string,
  index: number,
): Promise<string | null> {
  const safeName = entry.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 40)
  const fileName = `dream_${safeName}_${Date.now()}_${index}.md`
  const filePath = join(memoryDir, fileName)

  const fileContent = [
    '---',
    `name: ${entry.title}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    `source: autodream`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    entry.content,
  ].join('\n')

  try {
    await writeFile(filePath, fileContent, { encoding: 'utf-8' })

    // Strict Write Discipline: validate before indexing
    const validation = await validateMemoryFileBeforeIndex(filePath)
    if (!validation.valid) {
      logForDebugging(`autoDream: validation failed for ${filePath}: ${validation.reason}`, { level: 'debug' })
      return null
    }

    // Return the index pointer line
    return `- [${entry.title}](${fileName}) — ${entry.description.slice(0, 100)}`
  } catch (e) {
    logForDebugging(`autoDream: failed to write ${filePath}: ${String(e)}`, { level: 'debug' })
    return null
  }
}

/**
 * Update MEMORY.md index with new pointer lines.
 * Respects the MAX_ENTRYPOINT_LINES limit — does not add more entries than capacity allows.
 */
async function updateMemoryIndex(
  memoryDir: string,
  newPointers: string[],
): Promise<void> {
  const entrypointPath = join(memoryDir, ENTRYPOINT_NAME)
  const fs = getFsImplementation()

  let existingContent = ''
  try {
    existingContent = fs.readFileSync(entrypointPath, { encoding: 'utf-8' })
  } catch { /* file does not exist yet */ }

  const existingLines = existingContent.trim().split('\n').filter(Boolean)
  const slotsAvailable = MAX_ENTRYPOINT_LINES - existingLines.length
  const pointersToAdd = newPointers.slice(0, Math.max(0, slotsAvailable))

  if (pointersToAdd.length === 0) {
    logForDebugging('autoDream: MEMORY.md is full — skipping index update', { level: 'debug' })
    return
  }

  const newContent = [...existingLines, ...pointersToAdd].join('\n') + '\n'
  await writeFile(entrypointPath, newContent, { encoding: 'utf-8' })
}

/**
 * Main autoDream consolidation function.
 * Call this fire-and-forget: void autoDream(memoryDir)
 *
 * Scans logs/ subdirectory for .md files not yet processed (using a .dream_processed sentinel),
 * distills each into topic memory files, and updates MEMORY.md index.
 */
export async function autoDream(memoryDir: string): Promise<void> {
  if (!AUTODREAM_ENABLED) return

  const logsDir = join(memoryDir, 'logs')

  try {
    // Walk logs directory for unprocessed .md files
    async function* walkLogs(dir: string): AsyncGenerator<string> {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = join(dir, entry.name)
          if (entry.isDirectory()) {
            yield* walkLogs(fullPath)
          } else if (entry.name.endsWith('.md') && !entry.name.endsWith('.dream_processed.md')) {
            yield fullPath
          }
        }
      } catch { /* directory missing or unreadable */ }
    }

    const allPointers: string[] = []

    for await (const logFile of walkLogs(logsDir)) {
      // Check for sentinel file indicating this log was already processed
      const sentinelPath = logFile + '.dream_processed'
      try {
        await stat(sentinelPath)
        continue // Already processed
      } catch { /* not yet processed */ }

      try {
        const logContent = await readFile(logFile, { encoding: 'utf-8' })
        if (!logContent.trim()) continue

        const entries = parseDailyLog(logContent, logFile)
        const pointerResults = await Promise.all(
          entries.map((entry, idx) => writeDreamEntry(entry, memoryDir, idx)),
        )

        const validPointers = pointerResults.filter((p): p is string => p !== null)
        allPointers.push(...validPointers)

        // Write sentinel to mark this log as processed
        await writeFile(sentinelPath, `Processed at ${new Date().toISOString()}\n`, { encoding: 'utf-8' })

        logForDebugging(
          `autoDream: processed ${logFile} → ${validPointers.length} memories`,
          { level: 'debug' },
        )
      } catch (e) {
        logForDebugging(`autoDream: error processing ${logFile}: ${String(e)}`, { level: 'debug' })
      }
    }

    if (allPointers.length > 0) {
      await updateMemoryIndex(memoryDir, allPointers)
      logForDebugging(`autoDream: indexed ${allPointers.length} new memory pointers`, { level: 'debug' })
    }
  } catch (e) {
    // Never throw — autoDream is fire-and-forget
    logForDebugging(`autoDream: top-level error: ${String(e)}`, { level: 'debug' })
  }
}
