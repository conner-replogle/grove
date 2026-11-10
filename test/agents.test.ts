import { describe, expect, it } from 'vitest'
import { renderTree, webUrl } from '../host/agents.ts'

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

describe('webUrl', () => {
  it('adds a scheme to bare addresses', () => {
    expect(webUrl('example.com')).toBe('https://example.com/')
    expect(webUrl('example.com:8080/a')).toBe('https://example.com:8080/a')
    expect(webUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(webUrl('127.0.0.1/x')).toBe('http://127.0.0.1/x')
    expect(webUrl('http://example.com/a?b')).toBe('http://example.com/a?b')
    expect(webUrl('about:blank')).toBe('about:blank')
  })
  it('refuses anything but web pages', () => {
    for (const url of [
      'file:///etc/passwd',
      'chrome://password-manager/passwords',
      'javascript:alert(1)',
      'data:text/html,hi',
      'view-source:https://example.com',
      'blob:https://example.com/x',
      'chrome-extension://abc/x.html'
    ])
      expect(() => webUrl(url), url).toThrow()
  })
})
