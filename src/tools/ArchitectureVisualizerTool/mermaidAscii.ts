/**
 * Pure ASCII/Unicode Mermaid renderers for TUI environments.
 *
 * All functions accept a `columns` parameter and ensure no output line
 * exceeds that width. Output is rendered with Unicode box-drawing characters
 * and arrow glyphs — no DOM, no SVG, no browser dependency.
 */

export type GraphNode = { id: string; label: string }
export type GraphEdge = { from: string; to: string }
export type SequenceCall = { from: string; to: string; label: string }
export type ErEntity = { name: string; fields: string[] }
export type ErRelation = { from: string; to: string; label: string }

// ── Shared helpers ────────────────────────────────────────────────────────────

const ARROW = '──►'
const H = '─'
const V = '│'
const TL = '┌'; const TR = '┐'; const BL = '└'; const BR = '┘'

function hLine(width: number): string {
  return H.repeat(Math.max(0, width))
}

function boxLine(inner: string, width: number): string {
  const padded = inner.slice(0, width).padEnd(width)
  return `${V} ${padded} ${V}`
}

function box(lines: string[], minWidth = 0): string[] {
  const innerW = Math.max(minWidth, ...lines.map(l => l.length))
  const top = `${TL}${hLine(innerW + 2)}${TR}`
  const bot = `${BL}${hLine(innerW + 2)}${BR}`
  const body = lines.map(l => boxLine(l, innerW))
  return [top, ...body, bot]
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// ── graph TD ──────────────────────────────────────────────────────────────────

/**
 * Renders a directed graph (Mermaid `graph TD`) as ASCII.
 * Nodes are laid out top-to-bottom; edges are shown as arrow lines.
 */
export function renderGraphTD(
  nodes: GraphNode[],
  edges: GraphEdge[],
  columns: number,
): string {
  if (nodes.length === 0) {
    return '(empty graph — no nodes found)'
  }

  const usableW = Math.max(20, columns - 2)
  const maxLabelW = Math.floor(usableW / 2) - 4

  // Build adjacency for topo-sort
  const childrenOf = new Map<string, string[]>()
  const parentCount = new Map<string, number>()
  for (const n of nodes) {
    childrenOf.set(n.id, [])
    parentCount.set(n.id, 0)
  }
  for (const e of edges) {
    childrenOf.get(e.from)?.push(e.to)
    parentCount.set(e.to, (parentCount.get(e.to) ?? 0) + 1)
  }

  // Kahn's topo sort
  const queue = nodes.filter(n => (parentCount.get(n.id) ?? 0) === 0)
  const ordered: GraphNode[] = []
  const seen = new Set<string>()
  while (queue.length > 0) {
    const n = queue.shift()!
    if (seen.has(n.id)) continue
    seen.add(n.id)
    ordered.push(n)
    for (const child of childrenOf.get(n.id) ?? []) {
      const cnt = (parentCount.get(child) ?? 1) - 1
      parentCount.set(child, cnt)
      if (cnt === 0) {
        const childNode = nodes.find(x => x.id === child)
        if (childNode) queue.push(childNode)
      }
    }
  }
  // Append any remaining (cycles)
  for (const n of nodes) {
    if (!seen.has(n.id)) ordered.push(n)
  }

  const lines: string[] = ['graph TD', '']
  const edgeIdxByFrom = new Map<string, string[]>()
  for (const e of edges) {
    if (!edgeIdxByFrom.has(e.from)) edgeIdxByFrom.set(e.from, [])
    edgeIdxByFrom.get(e.from)!.push(e.to)
  }

  for (const node of ordered) {
    const lbl = truncate(node.label, maxLabelW)
    const nodeBox = box([lbl])
    for (const l of nodeBox) lines.push(truncate(l, usableW))

    const children = edgeIdxByFrom.get(node.id) ?? []
    for (const childId of children) {
      const childNode = nodes.find(n => n.id === childId)
      const childLbl = childNode ? truncate(childNode.label, maxLabelW) : childId
      const arrow = `${ARROW} ${childLbl}`
      lines.push(truncate(`  ${arrow}`, usableW))
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ── sequenceDiagram ───────────────────────────────────────────────────────────

/** Renders a Mermaid `sequenceDiagram` as ASCII column layout. */
export function renderSequenceDiagram(
  actors: string[],
  calls: SequenceCall[],
  columns: number,
): string {
  if (actors.length === 0) return '(empty sequence — no actors)'

  const usableW = Math.max(30, columns - 2)
  const colW = Math.max(10, Math.floor(usableW / actors.length) - 1)

  // Header row
  const header = actors.map(a => truncate(a, colW).padEnd(colW)).join(' ')
  const separator = actors.map(() => H.repeat(colW)).join(' ')
  const lines: string[] = ['sequenceDiagram', '', header, separator]

  for (const call of calls) {
    const fromIdx = actors.indexOf(call.from)
    const toIdx = actors.indexOf(call.to)
    if (fromIdx === -1 || toIdx === -1) continue

    const direction = toIdx >= fromIdx ? 1 : -1
    const arrowLen = Math.abs(toIdx - fromIdx) * (colW + 1)
    const arrowBody = (toIdx >= fromIdx ? '' : '◄') + H.repeat(Math.max(1, arrowLen - 2)) + (toIdx >= fromIdx ? '►' : '')

    const prefix = ' '.repeat(fromIdx * (colW + 1) + Math.floor(colW / 2))
    const labelLine = truncate(`${prefix}${truncate(call.label, arrowLen - 2)}`, usableW)
    const arrowLine = truncate(`${' '.repeat(fromIdx * (colW + 1) + Math.floor(colW / 2))}${arrowBody}`, usableW)
    lines.push(labelLine)
    lines.push(arrowLine)
    lines.push('')

    void direction // suppress unused warning
  }

  return lines.join('\n')
}

// ── erDiagram ─────────────────────────────────────────────────────────────────

/** Renders a Mermaid `erDiagram` as tabular ASCII entity blocks. */
export function renderErDiagram(
  entities: ErEntity[],
  relations: ErRelation[],
  columns: number,
): string {
  if (entities.length === 0) return '(empty ER diagram — no entities)'

  const usableW = Math.max(20, columns - 2)
  const maxFieldW = usableW - 6

  const lines: string[] = ['erDiagram', '']

  for (const entity of entities) {
    const fieldLines = entity.fields.map(f => truncate(f, maxFieldW))
    const entityBox = box([entity.name, H.repeat(Math.max(entity.name.length, 1)), ...fieldLines])
    for (const l of entityBox) lines.push(truncate(l, usableW))
    lines.push('')
  }

  if (relations.length > 0) {
    lines.push('Relationships:')
    for (const r of relations) {
      lines.push(truncate(`  ${r.from} ${ARROW} ${r.to} : ${r.label}`, usableW))
    }
  }

  return lines.join('\n')
}
