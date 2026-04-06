export const INTENT_ALIGNMENT_TOOL_NAME = 'IntentAlignment'

export function getIntentAlignmentPrompt(): string {
  return `
- Compares the user's natural-language request against the existing folder and file structure of the project
- Identifies where new code should be placed, what already exists that can be reused, and what conflicts might arise
- Prevents file duplication, wrong placement, and structural violations (e.g., putting auth routes inside a UI components folder)
- Returns a placement recommendation with confidence score and a list of potentially conflicting existing files

Usage notes:
  - Call this before creating new files or modules when the user's intent involves adding features
  - Works best with requests like "add login", "create user service", "implement payment flow"
  - Does NOT modify any files — read-only analysis tool
  - Searches directory names, file names, and top-level exports for semantic alignment
`
}
