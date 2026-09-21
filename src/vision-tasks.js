import { planIntent, planOps } from './api.js'
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
      shape: String(item.shape || item.mark || '').trim(),
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
    const typed = String(handwriting || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const ocr = typed ? '' : await readHandwritingVl(scene)
    const written = typed || ocr || shortHandwriting(handwriting)
    const gesture = classifyDrawnGesture()
    const skip = (exclude || []).filter(Boolean).join('；')
    const instruction = [
      '你是批注理解器。先看图里用户画了什么、写了什么，再看蓝线圈落在网页哪一块，合在一起给出操作。',
      '图1白底笔迹（蓝=圈选或标记，黑=手写或自画图案）。图2笔迹特写。图3圈选区域。图4整页。有键盘输入时以输入为准；否则认字以图1、图2为准。',
      '标注也是批注：五角星、三角形、叉、勾、下划线、箭头、自定义涂鸦都请直接从图里认，不要被任何本地几何猜测带偏。把认出的标记中文名写入 JSON 字段 mark（如五角星、三角形、叉）。几何程序经常把三角形和五角星弄混，以你看见的为准。',
      written
        ? `${typed ? '用户输入的要求' : '手写已读出'}：「${written}」。第一条猜测必须对应该字的含义，不要改认成别的字。`
        : gesture.habit
          ? `用户已有习惯：${gesture.hint} 可作为候选，但若图上的标记明显不是这个形状，以图为准。`
          : gesture.hint
            ? `本地几何仅供参考且可能不准：${gesture.hint} 必须看图判断标记是什么、代表什么操作。`
            : '没有手写时根据画面判断：叉/涂掉→delete；下划线→underline；箭头或一圈物体+一圈空白→move-layout；画出的图案/放射线→stamp。不要因为旁边有空白圈就默认插入文字。',
      '圈落在哪一块就改哪一块：圈字改字，圈图改图。若用户写明只改其中几个词/几句，或圈只罩住段落里一部分，操作应只针对那一部分。',
      '用户在某些单词上画了三角形、五角星、下划线或小圈时，操作是改这些词（加粗/高亮/下划线），不要改整段。guesses[].id 用 bold、highlight 或 underline。',
      '若蓝线圈的是照片、封面、插画等位图，即使用户要求改颜色、改成红色、暖色、换封面，也要用 generate-image 重新生成这张图。color / color-image 只适用于文字颜色或纯色色块，不能给照片滤镜上色。',
      '按文字语义映射，例如：删/叉/×/不要→delete；字改红/蓝/绿→color；封面/配图改色或换成…→generate-image；缩小/变小→scale-down；放大→scale-up；润色/改写/通顺→polish；扩写→longer；写短→shorter；阴影→shadow；倒影→reflect；加框→frame；换图/生成图/换成一张…→generate-image，不要只给 insert-image；加粗→bold；下划线→underline；高亮→highlight；加/插入且圈在空白且没有自画图案→insert-text；往右→nudge-right。文字是别的词就按该词理解，不要默认成删除或插入。',
      sceneText ? `页面几何场景（不是标记形状）：${sceneText}` : '',
      more ? '再给出 3 到 4 条不同操作，不要重复已给过的。' : '给出 3 到 4 条最可能的操作，按可能性从高到低。有输入或手写时第一条必须对应文字；无文字时第一条必须对应你从图里看到的画法。',
      skip ? `不要再给出这些：${skip}` : '',
      'label 用一句短中文确认。command 有具体值就填（红色、缩小一点）。JSON 增加 mark 字段记录你认出的标记名称，没有标记则留空。',
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
    const mark = String(json.mark || json.shape || guesses[0]?.shape || '').trim()
    if (mark) {
      for (const g of guesses) {
        if (!g.shape) g.shape = mark
      }
    }
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
      mark,
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
  if (/润色|改写|通顺|扩写|写短|口语|正式/.test(t)) return /扩写|写长/.test(t) ? 'longer' : /写短|精简/.test(t) ? 'shorter' : /口语/.test(t) ? 'spoken' : /正式/.test(t) ? 'formal' : 'polish'
  if (/插入|加字|加点|加东西/.test(t)) return 'insert-text'
  if (/封面|书封|换图|生成.*(图|图片)|换一张图|换掉.*图|文生图/.test(t)) return 'generate-image'
  if (/(图|配图|插画|照片).{0,8}(色|改成)/.test(t)) return 'generate-image'
  if (/加粗/.test(t)) return 'bold'
  if (/下划线/.test(t)) return 'underline'
  if (/高亮/.test(t)) return 'highlight'
  if (/加图/.test(t)) return 'insert-image'
  if (/红|蓝|绿|色/.test(t)) return 'color'
  if (/加|插|添/.test(t)) return 'add'
  return ''
}

export async function guessInkIntent(notify) {
  return guessAnnotationIntent(null, notify)
}

export async function guessStrokePrompt(editor, notify) {
  if (running) return
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
