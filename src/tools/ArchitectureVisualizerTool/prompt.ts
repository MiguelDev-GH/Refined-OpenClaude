export const ARCH_VIZ_TOOL_NAME = 'ArchitectureVisualizer'

export function getArchVizPrompt(): string {
  return `ArchitectureVisualizer scans a directory's source files to build an import dependency graph and renders it as an ASCII diagram in one of three Mermaid-compatible formats:

- **graph**: Directed dependency graph (graph TD) showing module relationships
- **sequence**: Sequence diagram of call flows between actors/modules
- **er**: Entity-relationship diagram of data model entities

All diagrams are rendered as Unicode/ASCII text safe for TUI terminals — no browser, no SVG.
Use this tool to map an unfamiliar codebase, audit coupling, or communicate architecture.`
}
