import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 穿透态的样式约束。
 *
 * 背景：`.app.click-through` 曾经写死 `--bg-alpha: 0.55`，想用"把窗口压透"
 * 来提示用户当前点不到。方向是错的 —— 本窗正文是近白色（#e8ecf4），
 * 背景一变透明，身后网页的白底就透上来，浅色字落到浅色背景上糊成实心块，
 * 后面透上来的文字还会和本窗文字叠在一起；而穿透态恰恰是最需要看清答案的时候。
 * 它同时还会覆盖掉用户在「设置 → 窗口」里调好的不透明度。
 */
const cssPath = path.join(__dirname, '..', 'styles.css')
const raw = fs.readFileSync(cssPath, 'utf8')

/** 去掉注释后再断言：注释里会提到这些属性名，否则会假失败 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

const blockOf = (selector: string): string => {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  const m = css.match(re)
  if (!m) throw new Error(`styles.css 里找不到规则：${selector}`)
  return m[1]
}

describe('穿透态不得牺牲可读性', () => {
  const block = blockOf('.app.click-through')

  it('不覆盖用户设置的背景不透明度', () => {
    expect(block).not.toContain('--bg-alpha')
  })

  it('不改写背景色（改背景色会盖掉 --bg / 用户设置）', () => {
    expect(block).not.toMatch(/(^|[\s;])background\s*:/)
  })

  it('不动 backdrop-filter（毛玻璃模糊是文字可读的基础）', () => {
    expect(block).not.toContain('backdrop-filter')
  })

  it('仍然给出非透明度的状态提示（描边）', () => {
    expect(block).toContain('border-color')
    expect(block).toContain('box-shadow')
  })

  it('基准规则本身仍用变量驱动背景，别把用户设置写死', () => {
    const base = blockOf('.app')
    expect(base).toContain('var(--bg)')
  })
})

describe('背景不透明度只作用在背景上', () => {
  it('--bg-alpha 在两个状态下的来源都是运行时注入的变量', () => {
    // 运行时会往 :root 写 --bg-alpha（App.tsx），所以任何选择器都不该再硬编码它
    const hardcoded = css.match(/--bg-alpha\s*:\s*0?\.\d+/g) ?? []
    // :root 里的初始默认值（0.92）是允许的兜底，其余一律不允许
    expect(hardcoded.filter((v) => !v.includes('0.92'))).toEqual([])
  })
})
