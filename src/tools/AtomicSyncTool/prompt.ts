export const ATOMIC_SYNC_TOOL_NAME = 'AtomicSync'

export function getAtomicSyncPrompt(): string {
  return `
- Applies modifications to multiple files as a single atomic transaction: either ALL succeed or ALL are rolled back
- Prevents the repository from entering a broken intermediate state where some files are updated but others are not
- If any individual file write fails (permissions, disk error, lock), the tool automatically reverts all previously written files in the batch

Usage notes:
  - Provide \`operations\`: an array of { file: string, content: string, mode: "write" | "append" | "patch" }
  - Patch mode expects a unified diff string — the tool applies it with context-aware matching
  - Returns { success: boolean, applied: string[], rolledBack: string[], error?: string }
  - Ideal for: renaming exported symbols across multiple files, updating shared types, applying coordinated refactors
  - Creates backups before writing (stored in memory for the duration of the call); does NOT create permanent backup files
`
}
