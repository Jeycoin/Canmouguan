import { desktopCapturer, screen, nativeImage, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getMainWindow } from './window'

export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureResult {
  dataUrl: string
  width: number
  height: number
  /** 原始（未缩放）尺寸，用于把裁剪坐标换算回屏幕坐标 */
  sourceWidth: number
  sourceHeight: number
  scaleFactor: number
  /** 分段耗时（毫秒），用于性能诊断，正常使用可忽略 */
  timings?: Record<string, number>
}

/** 最长边限制：控制视觉模型 token 与 IPC 体积。
 * 面试题目以文字为主，1024 足够清晰，且比 1568 大幅减少 token/耗时。
 */
const MAX_EDGE = 1024

export async function listSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 240, height: 240 },
    fetchWindowIcons: false
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.display_id ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL()
  }))
}

/**
 * 截取屏幕。region 为物理像素坐标（相对该显示器的 workArea 原点之外，即完整显示器坐标）。
 * 不传 region 时截取鼠标所在显示器的整屏。
 *
 * 架构优化：截图属于"采集外部信息"，本窗口必须在采集期间完全退出画面，
 * 否则会把面试助手自身截进去、盖住真正的题目。因此这里**无条件临时隐藏**
 * 主窗口，拍完后恢复；不再依赖 stealthOnShare（该设置仅控制内容保护）。
 */
export async function captureScreen(region?: CaptureRegion, sourceId?: string): Promise<CaptureResult> {
  const win = getMainWindow()

  // 1. 先隐藏自身窗口；记录原始可见/置顶/状态，拍完原样恢复
  const wasVisible = win?.isVisible() ?? false
  const wasAlwaysOnTop = win?.isAlwaysOnTop() ?? false
  if (win && wasVisible) {
    // 取消置顶可避免隐藏/显示时闪烁在其他窗口之上；显示时再恢复
    if (wasAlwaysOnTop) win.setAlwaysOnTop(false)
    win.hide()
  }
  // 给窗口管理器/合成器留足时间，确保本窗口完全从画面中消失
  await sleep(180)

  try {
    const timings: Record<string, number> = {}
    // 基准必须是函数起始时刻，否则第一段会记成绝对时间戳
    let cursor = Date.now()
    const mark = (name: string) => {
      const now = Date.now()
      timings[name] = now - cursor
      cursor = now
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const scaleFactor = display.scaleFactor || 1

    /**
     * 只做**一次** getSources，且按"屏幕实际像素"索取，而不是写死 4096。
     *
     * 实测（本机）：getSources@4096 ≈ 1.9s，@屏幕尺寸 ≈ 0.86s，@64x64 ≈ 0.73s。
     * 也就是说 thumbnail 尺寸超过屏幕分辨率之后，多出来的开销全是白付的，
     * 而这里最终只需要 MAX_EDGE=1024。原先还额外多调了一次 getSources 做定位，
     * 两次加起来让用户按下截图后要干等 2 秒才看到任何反馈。
     */
    const reqW = Math.max(64, Math.min(4096, Math.round(display.size.width * scaleFactor)))
    const reqH = Math.max(64, Math.min(4096, Math.round(display.size.height * scaleFactor)))
    // 指定了具体的源（可能是窗口）才需要枚举 window；默认取当前鼠标所在屏，只枚举 screen
    const types = sourceId && sourceId !== 'auto' ? (['screen', 'window'] as const) : (['screen'] as const)

    const sources = await desktopCapturer.getSources({ types: [...types], thumbnailSize: { width: reqW, height: reqH } })
    mark('getSources')

    const preferred =
      (sourceId && sourceId !== 'auto' ? sources.find((x) => x.id === sourceId) : undefined) ??
      sources.find((x) => x.id === `screen:${display.id}:0`) ??
      sources[0]
    if (!preferred) throw new Error('未能获取屏幕源，请检查系统录屏/截图权限')

    let img = preferred.thumbnail
    const srcSize = img.getSize()

    if (region && region.width > 8 && region.height > 8) {
      const r = {
        x: Math.max(0, Math.round(region.x)),
        y: Math.max(0, Math.round(region.y)),
        width: Math.min(Math.round(region.width), srcSize.width),
        height: Math.min(Math.round(region.height), srcSize.height)
      }
      img = img.crop(r)
    }

    // 等比缩放到最长边 <= MAX_EDGE
    const size = img.getSize()
    const scale = Math.min(1, MAX_EDGE / Math.max(size.width, size.height))
    let out = img
    if (scale < 1) {
      out = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'best'
      })
    }
    const finalSize = out.getSize()
    mark('crop+resize')

    // Electron 新版 toDataURL 只接受选项对象，PNG 为默认格式
    const dataUrl = out.toDataURL()
    mark('toDataURL(base64)')

    return {
      dataUrl,
      width: finalSize.width,
      height: finalSize.height,
      sourceWidth: srcSize.width,
      sourceHeight: srcSize.height,
      scaleFactor,
      timings
    }
  } finally {
    // 恢复窗口：先恢复置顶状态再 show，避免闪现在不合适的层级
    if (win && wasVisible) {
      if (wasAlwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
      win.show()
    }
  }
}

/**
 * 从一张大图压出给 UI 用的小缩略图。
 *
 * 给模型看的那份 MAX_EDGE 图没必要再让 IPC 扛两趟；UI 面板实际只有约 500px 宽，
 * 压到 640 并转 JPEG 后，同样一张图从 ~240KB 降到几十 KB。
 */
export function thumbnailFromDataUrl(dataUrl: string, maxEdge = 640, quality = 75): string {
  try {
    const img = nativeImage.createFromDataURL(dataUrl)
    const size = img.getSize()
    if (!size.width || !size.height) return dataUrl
    const scale = Math.min(1, maxEdge / Math.max(size.width, size.height))
    let out = img
    if (scale < 1) {
      out = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good'
      })
    }
    // Electron 新版 toJPEG/toPNG 返回 Buffer 而非 dataURL，这里自己拼
    const jpeg = out.toJPEG(quality)
    return `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`
  } catch (err) {
    console.error('[capture] 生成缩略图失败', err)
    return dataUrl
  }
}

/** 保存截图到本地（仅在隐私设置允许时调用） */
export function saveImage(dataUrl: string, prefix = 'shot'): string {
  const dir = path.join(app.getPath('userData'), 'captures')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${prefix}-${Date.now()}.png`)
  const buf = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64')
  fs.writeFileSync(file, buf)
  return file
}

export function imageFromDataUrl(dataUrl: string) {
  return nativeImage.createFromDataURL(dataUrl)
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
