// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { Markdown } from '../Markdown'

describe('Markdown', () => {
  it('渲染普通文本', () => {
    const html = renderToString(createElement(Markdown, { text: 'hello **world**' }))
    expect(html).toContain('hello')
    expect(html).toContain('<strong>world</strong>')
  })

  it('过滤 script 标签', () => {
    const html = renderToString(createElement(Markdown, { text: '<script>alert(1)</script>safe' }))
    expect(html).not.toContain('<script')
    expect(html).toContain('safe')
  })

  it('过滤危险属性（如 onclick）', () => {
    const html = renderToString(createElement(Markdown, { text: '<a href="http://x" onclick="evil()">link</a>' }))
    expect(html).toContain('href=')
    expect(html).not.toContain('onclick')
  })
})
