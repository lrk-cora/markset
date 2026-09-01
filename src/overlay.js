import { normalizeLasso, pathLength } from './geometry.js'
import { ping } from './store.js'

const MIN_PATH = 28
const START_MOVE = 8

let lassoMode = false
let subtractMode = false
let addMode = false
let colorMode = false

export function isLassoMode() {
  return lassoMode
}

export function isSubtractMode() {
  return subtractMode
}

export function isAddMode() {
  return addMode
}

export function isColorMode() {
  return colorMode
}

function syncButtons() {
  document.body.classList.toggle('is-armed', lassoMode)
  document.body.classList.toggle('is-subtract', subtractMode)
  document.body.classList.toggle('is-add', addMode)
  document.body.classList.toggle('is-color', colorMode)
  const lasso = document.getElementById('btn-lasso')
  if (lasso) {
    lasso.setAttribute('aria-pressed', String(lassoMode && !subtractMode && !addMode && !colorMode))
    lasso.classList.toggle('is-on', lassoMode && !subtractMode && !addMode && !colorMode)
  }
  const sub = document.getElementById('btn-subtract')
  if (sub) {
    sub.setAttribute('aria-pressed', String(subtractMode))
    sub.classList.toggle('is-on', subtractMode)
  }
}

export function setLassoMode(on) {
  lassoMode = Boolean(on)
  if (lassoMode) {
    subtractMode = false
    addMode = false
    colorMode = false
  } else {
    subtractMode = false
    addMode = false
    colorMode = false
  }
  syncButtons()
  ping()
}

export function disarmDrawing() {
  lassoMode = false
  subtractMode = false
  addMode = false
  colorMode = false
  syncButtons()
  ping()
}

export function setSubtractMode(on) {
  subtractMode = Boolean(on)
  if (subtractMode) {
    lassoMode = true
    addMode = false
    colorMode = false
  }
  syncButtons()
  ping()
}

export function setAddMode(on) {
  addMode = Boolean(on)
  if (addMode) {
    lassoMode = true
    subtractMode = false
    colorMode = false
  }
  syncButtons()
  ping()
}

export function setColorMode(on) {
  colorMode = Boolean(on)
  if (colorMode) {
    lassoMode = true
    subtractMode = false
    addMode = false
  }
  syncButtons()
  ping()
}

function uiTarget(e) {
  const el = e.target instanceof Element ? e.target : e.target.parentElement
  return el?.closest?.('.hl-handle, .img-handle, .badge, .toolbar, .topbar, .inspector, .suggest, .confirm')
}

export function bindLasso({ onBegin, onMove, onFinish, onCancel }) {
  const svg = document.getElementById('lasso-layer')
  let drawing = false
  let armed = false
  let points = []
  let poly = null
  let line = null
  let shiftHeld = false
  let subtractHeld = false

  function clearSvg() {
    svg.replaceChildren()
    poly = null
    line = null
  }

  function noteMods(e) {
    if (!e) return
    if (e.shiftKey) shiftHeld = true
    if (e.ctrlKey || e.metaKey || subtractMode || e.altKey) subtractHeld = true
  }

  function draw(pts, closed) {
    if (!pts.length) return
    const erase = subtractHeld || subtractMode
    const color = erase ? '#b44532' : colorMode ? '#7b4cc4' : addMode || shiftHeld ? '#2f8f5b' : '#3c6fd4'
    const fill = erase
      ? 'rgba(180, 70, 50, 0.12)'
      : colorMode
        ? 'rgba(123, 76, 196, 0.12)'
        : addMode || shiftHeld
          ? 'rgba(47, 143, 91, 0.10)'
          : 'rgba(60, 111, 212, 0.08)'
    if (!poly) {
      poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
      poly.setAttribute('stroke-width', '1.5')
      poly.setAttribute('stroke-dasharray', '5 4')
      poly.setAttribute('vector-effect', 'non-scaling-stroke')
      svg.append(poly)
      line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
      line.setAttribute('fill', 'none')
      line.setAttribute('stroke-width', '1.5')
      line.setAttribute('stroke-dasharray', '5 4')
      line.setAttribute('vector-effect', 'non-scaling-stroke')
      svg.append(line)
    }
    poly.setAttribute('fill', fill)
    poly.setAttribute('stroke', color)
    line.setAttribute('stroke', color)
    const d = pts.map((p) => `${p.x},${p.y}`).join(' ')
    poly.setAttribute('points', d)
    line.setAttribute('points', d)
    poly.style.display = closed ? 'block' : 'none'
  }

  function beginDraw() {
    drawing = true
    document.body.classList.add('is-lassoing')
    clearSvg()
    draw(points, false)
    onBegin?.()
  }

  function finish(e) {
    const wasDrawing = drawing
    drawing = false
    armed = false
    document.body.classList.remove('is-lassoing')
    noteMods(e)
    if (!wasDrawing) {
      onCancel?.({ drew: false })
      return
    }
    if (e) points.push({ x: e.clientX, y: e.clientY })
    const polygon = normalizeLasso(points)
    const tooSmall = polygon.length < 3 || pathLength(points) < MIN_PATH
    if (tooSmall) {
      clearSvg()
      onCancel?.({ drew: true })
      return
    }
    draw(polygon, true)
    window.setTimeout(clearSvg, 280)
    onFinish?.(polygon, {
      shift: shiftHeld && !subtractHeld,
      subtract: subtractHeld,
      add: addMode && !subtractHeld,
      color: colorMode && !subtractHeld,
    })
  }

  function onPointerDown(e) {
    if (e.button !== 0 || uiTarget(e)) return
    if (!e.altKey && !lassoMode && !subtractMode && !addMode && !colorMode) return
    e.preventDefault()
    e.stopPropagation()
    armed = true
    drawing = false
    shiftHeld = Boolean(e.shiftKey)
    subtractHeld = Boolean(e.ctrlKey || e.metaKey || subtractMode || e.altKey)
    points = [{ x: e.clientX, y: e.clientY }]
  }

  function onPointerMove(e) {
    if (!armed && !drawing) return
    e.preventDefault()
    noteMods(e)
    const last = points[points.length - 1] ?? { x: e.clientX, y: e.clientY }
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 1.5) return
    points.push({ x: e.clientX, y: e.clientY })
    if (!drawing && pathLength(points) >= START_MOVE) beginDraw()
    if (drawing) {
      draw(points, false)
      onMove?.(points)
    }
  }

  function onPointerUp(e) {
    if (!armed && !drawing) return
    e.preventDefault()
    finish(e)
  }

  function onWheel(e) {
    if (drawing) e.preventDefault()
  }

  function onKey(e) {
    if ((armed || drawing) && e.type === 'keydown' && e.key === 'Shift') shiftHeld = true
    if (
      (armed || drawing) &&
      e.type === 'keydown' &&
      (e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt')
    ) {
      subtractHeld = true
    }
    if (e.key === 'Alt') {
      e.preventDefault()
      document.body.classList.toggle('is-subtract', subtractMode || e.type === 'keydown')
    }
    if (e.type === 'keydown' && e.key === 'Escape' && (drawing || armed)) {
      drawing = false
      armed = false
      document.body.classList.remove('is-lassoing')
      clearSvg()
      onCancel?.({ drew: true })
    }
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)
  window.addEventListener('wheel', onWheel, { passive: false, capture: true })
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)

  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerUp, true)
    window.removeEventListener('wheel', onWheel, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('keyup', onKey, true)
  }
}
