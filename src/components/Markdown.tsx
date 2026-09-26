import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

/** 允许渲染的标签与属性白名单。链接只保留 href，图片只保留 src/alt。 */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'del',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
  'span',
  'div'
])

const ALLOWED_ATTR = new Set(['href', 'src', 'alt', 'title', 'class'])

/** 用 DOMPurify 做结构化净化，而不是正则替换 */
function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    KEEP_CONTENT: true,
    // 强制所有链接 target 为空，避免 window.opener 问题
    FORCE_BODY: true
  })
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    if (!text) return ''
    try {
      const parsed = marked.parse(text, { async: false }) as string
      return sanitize(parsed)
    } catch (err) {
      console.error('[Markdown] 解析失败', err)
      return text.replace(/</g, '&lt;')
    }
  }, [text])

  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
}
