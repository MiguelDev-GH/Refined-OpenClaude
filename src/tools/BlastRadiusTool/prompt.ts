export const BLAST_RADIUS_TOOL_NAME = 'BlastRadius'

export function getBlastRadiusPrompt(): string {
  return `
- Analyzes the Abstract Syntax Tree (AST) of the project to find all files that import or depend on a given file or exported symbol
- Before renaming a function, changing a type signature, or restructuring a module, call this tool to know the full blast radius
- Returns: the set of affected files, the specific import lines, and whether the dependency is direct or transitive

Usage notes:
  - Provide \`targetFile\` (the file you plan to change) and optionally \`symbol\` (the exported name you plan to rename/modify)
  - Returns { directDependents: string[], transitiveDependents: string[], totalAffectedFiles: number }
  - Use the result to plan a coordinated multi-file update (possibly combining with AtomicSyncTool)
  - Falls back to grep-based analysis if AST parsing fails (TypeScript SyntaxError in the target file)
  - Read-only: does NOT modify any files
`
}
