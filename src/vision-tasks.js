import { isClientModelGateOn, planOps } from './api.js'
import { captureMarkedPage } from './capture.js'
import { intersectBoxes } from './geometry.js'
import { imageSpanFromNaturalBox, normalizeVisionBox } from './hit-test.js'
import { appendSpans, getSnapshot, replaceCommandText } from './store.js'

let running = false

function parseVisionJson(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function iou(a, b) {
  if (!a || !b) return 0
  const hit = intersectBoxes(a, b)
  if (!hit) return 0
  return (hit.w * hit.h) / (a.w * a.h + b.w * b.h - hit.w * hit.h)
}

function productImage(editor, blockId) {
  const root = editor?.view?.dom
  if (!root) return null
  if (blockId) {
    const hit = root.querySelector(`img[data-block-id="${blockId}"]`)
    if (hit) return hit
  }
  return root.querySelector('img[data-block-id]')
}

function boxesFromPlan(data, naturalSize) {
  const json = data?.boxes ? data : parseVisionJson(data?.text)
  const raw = []
  if (Array.isArray(json?.boxes)) raw.push(...json.boxes)
  if (Array.isArray(data?.boxes)) raw.push(...data.boxes)
  if (Array.isArray(data?.ops)) {
    for (const op of data.ops) {
      if (op?.args?.bbox) raw.push(op.args.bbox)
    }
  }
  const boxes = []
  for (const item of raw) {
    const box = normalizeVisionBox(item, naturalSize)
    if (box) boxes.push(box)
  }
  return boxes
}

export async function findSame(editor, notify) {
  if (running) return
  if (!isClientModelGateOn()) {
    notify('查找相同需要一次规划 A。未开云端时请按住 Shift 再圈另一件货。')
    return
  }
  const images = getSnapshot().spans.filter((s) => s.kind === 'image')
  if (!images.length) {
    notify('先圈一件货，再点查找相同')
    return
  }
  const ok = window.confirm('将调用一次规划 A 在图里找同类物体，会消耗额度。确定？')
  if (!ok) return

  const img = productImage(editor, images[0].block_id)
  if (!img) {
    notify('找不到商品图')
    return
  }
  const nw = img.naturalWidth || Number(img.getAttribute('width')) || 1
  const nh = img.naturalHeight || Number(img.getAttribute('height')) || 1

  running = true
  notify('正在查找相同…')
  try {
    const shot = await captureMarkedPage(editor)
    const data = await planOps({
      task: 'find-same',
      instruction: '找出图中与当前蓝框选中物体同类的其他物体，不要重复已圈的框。',
      marks: shot.marks,
      imageDataUrl: shot.imageDataUrl,
      pageText: shot.pageText,
    })
    const boxes = boxesFromPlan(data, { w: nw, h: nh })
    const extra = []
    for (const box of boxes) {
      if (images.some((span) => iou(span.bbox, box) > 0.4)) continue
      const span = imageSpanFromNaturalBox(img, box)
      if (span) extra.push(span)
    }
    if (!extra.length) {
      notify('没找到另一件，请用 Shift 再圈')
      return
    }
    appendSpans(extra, editor.view.state.doc)
    notify(`已加上 ${extra.length} 处同类。可取消勾选「将改」`)
  } catch (err) {
    if (err.code === 'client-gate' || err.code === 'calls_disabled' || err.code === 'no_client_gate') {
      notify('未开云端，查找相同未发出请求。请用 Shift 再圈。')
      return
    }
    notify(err.message || '查找相同失败')
  } finally {
    running = false
  }
}

export async function guessStrokePrompt(editor, notify) {
  if (running || !isClientModelGateOn()) return
  const ok = window.confirm('将调用一次规划 A 猜这一笔想改成什么，可再改。确定？')
  if (!ok) return

  running = true
  notify('正在猜这一笔…')
  try {
    const shot = await captureMarkedPage(editor)
    const data = await planOps({
      task: 'guess',
      instruction: '根据选中笔迹猜测用户想把这块改成什么，输出一句简短中文。',
      marks: shot.marks,
      imageDataUrl: shot.imageDataUrl,
      pageText: shot.pageText,
    })
    const json = parseVisionJson(data?.text) || data
    const guess = String(data?.guess || json?.guess || '').trim()
    if (!guess) {
      notify('没猜到，请在输入框自己写，再点统一风格')
      return
    }
    replaceCommandText(guess)
    notify(`已猜：${guess}。可改后再点统一风格`)
  } catch (err) {
    if (err.code === 'client-gate' || err.code === 'calls_disabled' || err.code === 'no_client_gate') {
      return
    }
    notify(err.message || '猜提示失败，请自己写再点统一风格')
  } finally {
    running = false
  }
}
