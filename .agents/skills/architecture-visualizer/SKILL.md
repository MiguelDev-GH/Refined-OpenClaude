---
name: architecture-visualizer
description: >
  Generates ASCII architecture diagrams from source code.
  Triggers: "visualize architecture", "dependency graph", "show imports",
  "mermaid diagram", "module diagram", "codebase map".
  Diagram types: graph (default), sequence, er.
---

# ArchitectureVisualizer

Scans a directory's source files, builds an import dependency graph via static analysis, and renders the result as an ASCII diagram natively in the terminal.

## Usage

```
ArchitectureVisualizer(
  target_path = "/path/to/project",   // optional, defaults to cwd
  diagram_type = "graph",             // "graph" | "sequence" | "er"
  max_depth = 4                       // 1–10
)
```

## Diagram Types

| Type | Output |
|------|--------|
| `graph` | Directed dependency graph (graph TD) with box-drawing chars |
| `sequence` | Sequence diagram of import call flows between modules |
| `er` | Entity-relationship view of module dependencies |

## Constraints

- Pure ASCII/Unicode output — no SVG, no browser, no Puppeteer
- Column-safe: all lines respect terminal width (`process.stdout.columns`)
- Read-only, concurrency-safe
- `shouldDefer: true` — loaded on-demand, no startup cost
