import {
  appendSpans,
  clearAll,
  focusMark,
  getSnapshot,
  hasImage,
  removeMark,
  setAnchors,
  setSuggest,
  toSpec,
} from './store.js'

let toastTimer = 0

export function toast(message) {
  const el = document.getElementById('toast')
  el.hidden = false
  el.textContent = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el.hidden = true
  }, 1800)
}

function textAnchor(view, span) {
  try {
    const coords = view.coordsAtPos(span.from)
    return { x: coords.left, y: coords.top }
  } catch {
    return { x: 24, y: 72 }
  }
}

function unionRect(rects) {
  let x = Infinity
  let y = Infinity
  let r = -Infinity
  let b = -Infinity
  for (const box of rects) {
    x = Math.min(x, box.x)
    y = Math.min(y, box.y)
    r = Math.max(r, box.x + box.w)
    b = Math.max(b, box.y + box.h)
  }
  if (!Number.isFinite(x)) return null
  return { x, y, w: r - x, h: b - y }
}

export function renderChrome(editor) {
  const layer = document.getElementById('chrome-layer')
  const inspector = document.getElementById('inspector-json')
  const snap = getSnapshot()
  const anchors = {}
  const boxes = []

  layer.replaceChildren()

  for (const span of snap.spans) {
    if (span.kind === 'image' && span.screenRect) {
      const mask = document.createElement('div')
      mask.className = 'image-mask'
      mask.style.left = `${span.screenRect.x}px`
      mask.style.top = `${span.screenRect.y}px`
      mask.style.width = `${span.screenRect.w}px`
      mask.style.height = `${span.screenRect.h}px`
      layer.append(mask)
      boxes.push(span.screenRect)
      anchors[span.markId] = { x: span.screenRect.x, y: span.screenRect.y }
    } else if (span.kind === 'text') {
      anchors[span.markId] = textAnchor(editor.view, span)
      try {
        const a = editor.view.coordsAtPos(span.from)
        const b = editor.view.coordsAtPos(span.to)
        boxes.push({
          x: Math.min(a.left, b.left),
          y: Math.min(a.top, b.top),
          w: Math.abs(b.right - a.left) || 40,
          h: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
        })
      } catch {
        /* ignore */
      }
    }
  }

  setAnchors(anchors)

  for (const span of snap.spans) {
    const anchor = anchors[span.markId]
    if (!anchor) continue
    const badge = document.createElement('div')
    badge.className = `badge${snap.focusedMarkId === span.markId ? ' is-focused' : ''}`
    badge.style.left = `${anchor.x}px`
    badge.style.top = `${anchor.y}px`

    const tag = document.createElement('button')
    tag.type = 'button'
    tag.className = 'tag'
    tag.textContent = `#${span.markId}`
    tag.addEventListener('click', (e) => {
      e.stopPropagation()
      focusMark(span.markId)
    })

    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'x'
    x.setAttribute('aria-label', '踢出篮子')
    x.textContent = '×'
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      removeMark(span.markId)
    })

    badge.append(tag, x)
    layer.append(badge)
  }

  if (snap.suggest?.screenRect) {
    const s = document.createElement('div')
    s.className = 'suggest'
    s.style.left = `${snap.suggest.screenRect.x}px`
    s.style.top = `${snap.suggest.screenRect.y}px`
    s.style.width = `${snap.suggest.screenRect.w}px`
    s.style.height = `${snap.suggest.screenRect.h}px`
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = '建议加入'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const next = snap.suggest
      setSuggest(null)
      appendSpans([next])
    })
    s.append(btn)
    layer.append(s)
  }

  if (snap.spans.length) {
    const box = unionRect(boxes) ?? { x: 120, y: 160, w: 200, h: 40 }
    const bar = document.createElement('div')
    bar.className = 'toolbar'
    const left = Math.min(Math.max(16, box.x), window.innerWidth - 420)
    const top = Math.min(box.y + box.h + 12, window.innerHeight - 64)
    bar.style.left = `${left}px`
    bar.style.top = `${top}px`

    const actions = [
      ['改写', '第 2 周接入改字 API'],
      ['统一风格', '第 3 周接入规划拆单'],
      ['替换', '第 2 周接入改字 / 重绘'],
      ['删除', '纯文字可本地删；含图要等第 2 周'],
    ]
    for (const [label, msg] of actions) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        toast(msg)
      })
      bar.append(btn)
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = snap.focusedMarkId ? `只改 #${snap.focusedMarkId}` : '命令打在整个篮子'
    bar.append(input)

    if (hasImage()) {
      for (const [label, msg] of [
        ['＋', '第 3 周接入画笔'],
        ['－', '第 3 周接入画笔'],
        ['色', '第 3 周接入画笔'],
      ]) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'pen'
        btn.textContent = label
        btn.addEventListener('click', (e) => {
          e.stopPropagation()
          toast(msg)
        })
        bar.append(btn)
      }
    }

    layer.append(bar)
  }

  inspector.textContent = JSON.stringify(toSpec(), null, 2)
}

export function bindChromeKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearAll()
    }
  })
}
