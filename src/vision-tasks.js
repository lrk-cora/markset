import { isClientModelGateOn, planIntent, planOps } from './api.js'
import { captureAnnotationScene, captureMarkedPage, classifyDrawnGesture } from './capture.js'
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

function shortHandwriting(value) {
  let t = String(value || '').trim()
  if (!t) return ''
  if (t.startsWith('{') || t.startsWith('[')) {
    const json = parseVisionJson(t)
    t = String(json?.text || json?.handwriting || '').trim()
  }
  t = t.replace(/\s+/g, '').replace(/^["'`「」『』]+|["'`「」『』]+$/g, '')
  if (!t || t.length > 24) return ''
  return t
}

async function readHandwritingVl(scene) {
  const images = scene.ocrImageDataUrls?.length
    ? scene.ocrImageDataUrls.slice(0, 1)
    : [scene.inkDataUrl].filter(Boolean).slice(0, 1)
  if (!images.length) return ''
  try {
    const data = await planIntent({
      task: 'ink',
      instruction: '只识别图中的手写汉字，按书写顺序原样输出。不要解释，不要把圈线认成字。没有手写就输出空。',
      imageDataUrl: images[0],
      imageDataUrls: images,
    })
    return shortHandwriting(data?.handwriting || data?.text)
  } catch {
    return ''
  }
}

export async function guessAnnotationIntent(editor, notify, { silent = false, more = false, exclude = [], handwriting = '', sceneText = '' } = {}) {
  if (!silent && running) return null
  if (!silent) running = true
  if (!silent) notify?.('正在认出批注…')
  try {
    const scene = await captureAnnotationScene(editor)
    if (!scene.imageDataUrls?.length && !scene.imageDataUrl) {
      if (!silent) notify?.('没有可看的批注画面')
      return null
    }
    const ocr = await readHandwritingVl(scene)
    const written = ocr || shortHandwriting(handwriting)
    const gesture = classifyDrawnGesture()
    const skip = (exclude || []).filter(Boolean).join('；')
    const instruction = [
      '你是批注理解器。先确认手写字，再看蓝色圈/黑色画落在网页哪一块，两者合在一起才给出操作。',
      '图1白底笔迹（蓝=圈，黑=手写或自画图案）。图2笔迹特写。图3圈选区域。图4整页。认字以图1、图2为准。',
      written
        ? `手写已读出：「${written}」。第一条猜测必须对应该字的含义，不要改认成别的字。`
        : gesture.kind
          ? `没有手写汉字。画法已判定为 ${gesture.kind}：${gesture.hint} 第一条猜测必须是 id=${gesture.kind}，label 用「${gesture.label}」。不要猜成插入文字，不要猜成清除涂鸦/删除笔画。`
          : '没有手写时根据画法判断：叉/涂掉→delete；下划线→underline；箭头或一圈物体+一圈空白→move-layout；画出的图案/放射线/星星/涂鸦图形→stamp，把图案贴到所画位置。不要因为旁边有空白圈就默认插入文字。',
      '圈落在哪一块就改哪一块：圈字改字，圈图改图。若黑色线围着 Logo 散开，目标是该 Logo 周围的装饰，不是空白插入。',
      '按手写语义映射，例如：删/叉/×/不要→delete；红/蓝/绿/改色→color；缩小/变小→scale-down；放大→scale-up；阴影→shadow；倒影→reflect；加框→frame；加/插入且圈在空白且没有自画图案→insert-text；往右→nudge-right。手写是别的词就按该词理解，不要默认成删除或插入。',
      sceneText ? `几何场景：${sceneText}` : '',
      more ? '再给出 3 到 4 条不同操作，不要重复已给过的。' : '给出 3 到 4 条最可能的操作，按可能性从高到低。有手写时第一条必须对应手写；无手写时第一条必须对应画法。',
      skip ? `不要再给出这些：${skip}` : '',
      'label 用一句短中文确认。command 有具体值就填（红色、缩小一点）。',
    ]
      .filter(Boolean)
      .join('\n')
    const data = await planIntent({
      task: 'intent',
      instruction,
      handwriting: written,
      marks: scene.marks,
      pageText: scene.pageText,
      imageDataUrl: scene.imageDataUrls[0] || scene.imageDataUrl,
      imageDataUrls: scene.imageDataUrls,
    })
    const json = parseVisionJson(data?.text) || {}
    const guesses = normalizeGuesses(json, data)
    const text = written || shortHandwriting(json.text || json.handwriting || data.handwriting)
    const note = String(json.note || data.note || guesses[0]?.note || parseNoteSafe(text) || '').trim()
    const command = String(json.command || data.command || guesses[0]?.command || '').trim()
    const intent = String(json.intent || data.intent || guesses[0]?.id || '').trim()
    if (!guesses.length && !text && !note && !intent) {
      if (!silent) notify?.('没看懂这批注')
      return null
    }
    return {
      guesses,
      text: text || note || intent,
      note: note || parseNoteSafe(text) || intent,
      command,
      intent,
      confident: true,
      fromModel: true,
    }
  } catch (err) {
    if (err.code === 'client-gate' || err.code === 'calls_disabled' || err.code === 'no_client_gate') return null
    if (!silent) notify?.(err.message || '理解批注失败')
    return null
  } finally {
    if (!silent) running = false
  }
}

function parseNoteSafe(text) {
  const t = String(text || '').replace(/\s+/g, '')
  if (!t) return ''
  if (/删|叉|×|不要|去掉这块/.test(t)) return 'delete'
  if (/缩小|变小/.test(t)) return 'scale-down'
  if (/放大|变大/.test(t)) return 'scale-up'
  if (/倒影/.test(t)) return 'reflect'
  if (/阴影|投影/.test(t)) return 'shadow'
  if (/加框|边框/.test(t)) return 'frame'
  if (/插入|加字|加点|加东西/.test(t)) return 'insert-text'
  if (/加图/.test(t)) return 'insert-image'
  if (/红|蓝|绿|色/.test(t)) return 'color'
  if (/加|插|添/.test(t)) return 'add'
  return ''
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
