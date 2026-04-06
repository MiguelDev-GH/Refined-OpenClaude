import { describe, expect, test } from 'bun:test'
import { renderErDiagram, renderGraphTD, renderSequenceDiagram } from './mermaidAscii.js'

const COLS = 80

describe('renderGraphTD', () => {
  test('contains box-drawing characters for each node', () => {
    const nodes = [
      { id: 'A', label: 'Alpha' },
      { id: 'B', label: 'Beta' },
    ]
    const edges = [{ from: 'A', to: 'B' }]
    const output = renderGraphTD(nodes, edges, COLS)
    expect(output).toContain('Alpha')
    expect(output).toContain('Beta')
    // Box characters
    expect(output).toMatch(/[┌┐└┘│─]/)
  })

  test('renders arrow between connected nodes', () => {
    const nodes = [{ id: 'X', label: 'X' }, { id: 'Y', label: 'Y' }]
    const edges = [{ from: 'X', to: 'Y' }]
    const output = renderGraphTD(nodes, edges, COLS)
    expect(output).toMatch(/──►|──>|→/)
  })

  test('no output line exceeds columns width', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      label: `LongNodeLabelThatIsVerbose${i}`,
    }))
    const edges = nodes.slice(1).map((n, i) => ({ from: String(i), to: n.id }))
    const output = renderGraphTD(nodes, edges, COLS)
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(COLS + 4) // +4 for multi-byte unicode box chars
    }
  })

  test('handles empty graph gracefully', () => {
    const output = renderGraphTD([], [], COLS)
    expect(typeof output).toBe('string')
    expect(output.length).toBeGreaterThan(0)
  })
})

describe('renderSequenceDiagram', () => {
  test('renders all actor headers', () => {
    const actors = ['Client', 'Server', 'Database']
    const calls = [
      { from: 'Client', to: 'Server', label: 'request' },
      { from: 'Server', to: 'Database', label: 'query' },
    ]
    const output = renderSequenceDiagram(actors, calls, COLS)
    expect(output).toContain('Client')
    expect(output).toContain('Server')
    expect(output).toContain('Database')
  })

  test('renders call labels', () => {
    const actors = ['A', 'B']
    const calls = [{ from: 'A', to: 'B', label: 'doSomething' }]
    const output = renderSequenceDiagram(actors, calls, COLS)
    expect(output).toContain('doSomething')
  })

  test('contains arrow indicator', () => {
    const actors = ['A', 'B']
    const calls = [{ from: 'A', to: 'B', label: 'call' }]
    const output = renderSequenceDiagram(actors, calls, COLS)
    expect(output).toMatch(/──►|──>|→|->/)
  })

  test('no line exceeds columns width', () => {
    const actors = ['SomeServiceWithLongName', 'AnotherServiceName']
    const calls = [{ from: actors[0], to: actors[1], label: 'veryDescriptiveMethodCall' }]
    const output = renderSequenceDiagram(actors, calls, COLS)
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(COLS + 4)
    }
  })
})

describe('renderErDiagram', () => {
  test('renders all entity names', () => {
    const entities = [
      { name: 'User', fields: ['id: int', 'name: string'] },
      { name: 'Post', fields: ['id: int', 'userId: int'] },
    ]
    const relations = [{ from: 'User', to: 'Post', label: 'has many' }]
    const output = renderErDiagram(entities, relations, COLS)
    expect(output).toContain('User')
    expect(output).toContain('Post')
  })

  test('renders field names', () => {
    const entities = [{ name: 'Product', fields: ['sku: string', 'price: float'] }]
    const output = renderErDiagram(entities, [], COLS)
    expect(output).toContain('sku')
    expect(output).toContain('price')
  })

  test('handles empty entities', () => {
    const output = renderErDiagram([], [], COLS)
    expect(typeof output).toBe('string')
  })
})
