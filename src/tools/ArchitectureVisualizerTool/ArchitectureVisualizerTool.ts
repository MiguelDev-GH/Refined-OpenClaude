import React from 'react'
import { Box, Text } from '../../ink.js'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { scanDependencyGraph } from './astScanner.js'
import {
  renderGraphTD,
  renderSequenceDiagram,
  renderErDiagram,
  type ErEntity,
  type SequenceCall,
} from './mermaidAscii.js'
import { ARCH_VIZ_TOOL_NAME, getArchVizPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    target_path: z
      .string()
      .optional()
      .describe(
        'Absolute path to scan. Defaults to the current working directory.',
      ),
    diagram_type: z
      .enum(['graph', 'sequence', 'er'])
      .default('graph')
      .describe(
        'Type of diagram to render: "graph" (dependency graph TD), "sequence" (sequence diagram), or "er" (entity-relationship diagram).',
      ),
    max_depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(4)
      .describe('Maximum directory depth to scan. Default: 4.'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

type ToolOutput = {
  diagram: string
  nodeCount: number
  edgeCount: number
  diagramType: string
  targetPath: string
}

export const ArchitectureVisualizerTool = buildTool({
  name: ARCH_VIZ_TOOL_NAME,
  searchHint: 'visualize architecture dependency graph mermaid AST diagram',
  maxResultSizeChars: 80_000,
  shouldDefer: true, // loaded on demand — zero startup cost
  alwaysLoad: false,

  async description() {
    return 'Scans source files via import-graph analysis and renders ASCII architecture diagrams (graph, sequence, er) natively in the terminal'
  },

  userFacingName() {
    return 'Architecture Visualizer'
  },

  getActivityDescription(input) {
    return `Visualizing ${input?.diagram_type ?? 'graph'} diagram`
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

  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },

  toAutoClassifierInput() {
    return ''
  },

  async checkPermissions() {
    return { behavior: 'allow', updatedInput: {} }
  },

  async prompt() {
    return getArchVizPrompt()
  },

  renderToolUseMessage(input) {
    const path = input.target_path ?? 'current directory'
    const type = input.diagram_type ?? 'graph'
    return `Scanning ${path} for ${type} diagram`
  },

  renderToolResultMessage(content) {
    if (!content || typeof content !== 'object') return null
    const out = content as ToolOutput

    return React.createElement(
      Box,
      { flexDirection: 'column', paddingY: 1 },
      React.createElement(
        Text,
        { bold: true },
        `● Architecture Diagram — ${out.diagramType} (${out.nodeCount} nodes, ${out.edgeCount} edges)`,
      ),
      React.createElement(Text, { dimColor: true }, out.targetPath),
      React.createElement(Text, null, ''),
      React.createElement(Text, null, out.diagram),
    )
  },

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const out = content as ToolOutput
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: [
        {
          type: 'text' as const,
          text: `Architecture Diagram (${out.diagramType}):\n${out.diagram}\n\nNodes: ${out.nodeCount} | Edges: ${out.edgeCount}`,
        },
      ],
    }
  },

  async call(input) {
    const root = input.target_path ?? getCwd()
    const maxDepth = input.max_depth ?? 4
    const diagramType = input.diagram_type ?? 'graph'
    const columns = process.stdout.columns ?? 80

    const { nodes, edges } = await scanDependencyGraph(root, maxDepth)

    let diagram: string

    switch (diagramType) {
      case 'sequence': {
        // Actors: unique top-level modules (label = first path segment)
        const actorSet = new Set<string>()
        for (const n of nodes) {
          actorSet.add(n.label)
        }
        const actors = [...actorSet].slice(0, 12)
        const calls: SequenceCall[] = edges
          .map(e => {
            const fromNode = nodes.find(n => n.id === e.from)
            const toNode = nodes.find(n => n.id === e.to)
            if (!fromNode || !toNode) return null
            return { from: fromNode.label, to: toNode.label, label: 'imports' }
          })
          .filter((c): c is SequenceCall => c !== null)
          .slice(0, 20)
        diagram = renderSequenceDiagram(actors, calls, columns)
        break
      }

      case 'er': {
        // Treat each node as an entity, edges as foreign-key relations
        const entities: ErEntity[] = nodes.slice(0, 15).map(n => ({
          name: n.label,
          fields: edges
            .filter(e => e.from === n.id)
            .map(e => {
              const dep = nodes.find(x => x.id === e.to)
              return `imports: ${dep?.label ?? e.to}`
            })
            .slice(0, 5),
        }))
        const relations = edges.slice(0, 20).map(e => {
          const fromNode = nodes.find(n => n.id === e.from)
          const toNode = nodes.find(n => n.id === e.to)
          return {
            from: fromNode?.label ?? e.from,
            to: toNode?.label ?? e.to,
            label: 'depends on',
          }
        })
        diagram = renderErDiagram(entities, relations, columns)
        break
      }

      default: {
        diagram = renderGraphTD(nodes, edges, columns)
        break
      }
    }

    const result: ToolOutput = {
      diagram,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      diagramType,
      targetPath: root,
    }
    return { data: result }
  },
})
