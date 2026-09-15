import { isClientModelGateOn, planIntent, planOps } from './api.js'
import { captureAnnotationScene, captureMarkedPage } from './capture.js'
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

function normalizeGuesses(json, data) {
  const raw = Array.isArray(json?.guesses)
    ? json.guesses
    : Array.isArray(data?.guesses)
      ? data.guesses
      : []
  const out = []
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ id: '', label: item.trim(), note: '', command: '' })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const label = String(item.label || item.guess || item.text || '').trim()
    const id = String(item.id || item.intent || '').trim()
    if (!label && !id) continue
    out.push({
      id,
      label: label || id,
      note: String(item.note || '').trim(),
      command: String(item.command || '').trim(),
    })
  }
  if (!out.length) {
    const label = String(json?.guess || data?.guess || json?.text || '').trim()
    const note = String(json?.note || data?.note || '').trim()
    const intent = String(json?.intent || data?.intent || '').trim()
    if (label || note || intent) {
      out.push({
        id: intent || note,
        label: label || note || intent,
        note: note || intent,
        command: String(json?.command || data?.command || '').trim(),
      })
    }
  }
  return out.slice(0, 4)
}

export async function guessAnnotationIntent(editor, notify, { silent = false, more = false, exclude = [], handwriting = '' } = {}) {
  if (!silent && running) return null
  if (!silent) running = true
  if (!silent) notify?.('正在理解批注…')
  try {
    const scene = await captureAnnotationScene(editor)
    if (!scene.imageDataUrls?.length && !scene.imageDataUrl) {
      if (!silent) notify?.('没有可看的批注画面')
      return null
    }
    const skip = (exclude || []).filter(Boolean).join('；')
    const written = String(handwriting || '').trim()
    const instruction = [
      '必须同时看「画的部分」和「写的部分」。',
      '第一张图是网页加上用户全部笔迹。圈落在哪一块，就只针对那一块，不要因为页面上有大Logo就猜成改Logo。',
      '若圈里是字，就改这些字；若圈里是图，就改这张图；若字和图都圈到了，就两类一起改。',
      '若圈在空白处或只是自画图形，不要猜成主Logo操作。',
      written ? `本地已经认出的字：${written}。以它为线索，再结合画落在哪一块来理解。` : '如果有手写，先识别成中文，再和圈/涂的位置合在一起判断。',
      '例如：圈了图标并写「删」=删掉该图标；只圈了「搜狗搜索」四字并写改红色=只改这几个字的颜色；圈了字和图=两类一起改。',
      more
        ? '再给出 3 到 4 条不同的可能操作，不要重复已经给过的。'
        : '给出 3 到 4 条最可能的操作，按可能性从高到低。',
      skip ? `不要再给出这些：${skip}` : '',
      'label 用一句短中文，像在跟用户确认。JSON 里 text 填识别出的手写。command 有具体颜色就填颜色名（如红色）。',
    ]
      .filter(Boolean)
      .join('')
    const data = await planIntent({
      task: 'intent',
      instruction,
      handwriting: written,
      marks: scene.marks,
      pageText: scene.pageText,
      imageDataUrl: scene.combinedDataUrl || scene.imageDataUrls[0] || scene.imageDataUrl,
      imageDataUrls: scene.imageDataUrls,
    })
    const json = parseVisionJson(data?.text) || data
    const guesses = normalizeGuesses(json, data)
    const text = String(json?.text || json?.guess || data?.guess || written || guesses[0]?.label || '').trim()
    const note = String(json?.note || data?.note || guesses[0]?.note || '').trim()
    const command = String(json?.command || data?.command || guesses[0]?.command || '').trim()
    const intent = String(json?.intent || data?.intent || guesses[0]?.id || '').trim()
    if (!guesses.length && !text && !note && !intent) {
      if (!silent) notify?.('没看懂这批注')
      return null
    }
    return {
      guesses,
      text: text || note || intent,
      note: note || intent,
      command,
      intent,
      confident: true,
    }
  } catch (err) {
    if (err.code === 'client-gate' || err.code === 'calls_disabled' || err.code === 'no_client_gate') return null
    if (!silent) notify?.(err.message || '理解批注失败')
    return null
  } finally {
    if (!silent) running = false
  }
}

export async function guessInkIntent(notify) {
  return guessAnnotationIntent(null, notify)
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
      notify('没猜到，请自己写下要改成什么样')
      return
    }
    replaceCommandText(guess)
    notify(`已猜：${guess}。可改后再点改这些`)
  } catch (err) {
    if (err.code === 'client-gate' || err.code === 'calls_disabled' || err.code === 'no_client_gate') {
      return
    }
    notify(err.message || '猜提示失败，请自己写')
  } finally {
    running = false
  }
}
