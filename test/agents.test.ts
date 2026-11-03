import { describe, expect, it } from 'vitest'
import { renderTree } from '../host/agents.ts'

const node = (nodeId: string, role: string, name = '', childIds: string[] = [], extra = {}) => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  backendDOMNodeId: Number(nodeId) + 100,
  ...extra
})

describe('snapshot', () => {
  it('lists named elements with refs, and drops wrappers and repeated text', () => {
    const tree = renderTree([
      node('1', 'RootWebArea', 'Page', ['2', '6']),
      node('2', 'generic', '', ['3', '5']),
      node('3', 'link', 'Home', ['4']),
      node('4', 'StaticText', 'Home'),
      node('5', 'textbox', 'Search', [], { value: { value: 'cats' }, properties: [{ name: 'focused', value: { value: true } }] }),
      node('6', 'heading', 'Title', ['7'], { properties: [{ name: 'level', value: { value: 2 } }] }),
      node('7', 'StaticText', 'Title'),
      { nodeId: '8', ignored: true, childIds: [] }
    ])
    expect(tree).toBe(
      ['- link "Home" [ref=e103]', '- textbox "Search" [focused] value="cats" [ref=e105]', '- heading "Title" [level=2] [ref=e106]'].join('\n')
    )
  })
})
