import { normalizeLasso, pathLength } from './geometry.js'

const MIN_PATH = 28

export function bindLasso({ onBegin, onMove, onFinish, onCancel }) {
  const svg = document.getElementById('lasso-layer')
  let drawing = false
  let points = []
  let poly = null
  let line = null

  function clearSvg() {
    svg.replaceChildren()
    poly = null
    line = null
  }

  function draw(pts, closed) {
    if (!pts.length) return
    if (!poly) {
      poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
      poly.setAttribute('fill', 'rgba(60, 111, 212, 0.08)')
      poly.setAttribute('stroke', '#3c6fd4')
      poly.setAttribute('stroke-width', '1.5')
      poly.setAttribute('stroke-dasharray', '5 4')
      poly.setAttribute('vector-effect', 'non-scaling-stroke')
      svg.append(poly)
      line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
      line.setAttribute('fill', 'none')
      line.setAttribute('stroke', '#3c6fd4')
      line.setAttribute('stroke-width', '1.5')
      line.setAttribute('stroke-dasharray', '5 4')
      line.setAttribute('vector-effect', 'non-scaling-stroke')
      svg.append(line)
    }
    const d = pts.map((p) => `${p.x},${p.y}`).join(' ')
    poly.setAttribute('points', d)
    line.setAttribute('points', d)
    poly.style.display = closed ? 'block' : 'none'
  }

  function start(e) {
    drawing = true
    points = [{ x: e.clientX, y: e.clientY }]
    document.body.classList.add('is-lassoing')
    clearSvg()
    draw(points, false)
    onBegin?.()
  }

  function move(e) {
    if (!drawing) return
    const last = points[points.length - 1]
    if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 1.5) return
    points.push({ x: e.clientX, y: e.clientY })
    draw(points, false)
    onMove?.(points)
  }

  function finish(e) {
    if (!drawing) return
    drawing = false
    document.body.classList.remove('is-lassoing')
    if (e) points.push({ x: e.clientX, y: e.clientY })
    const polygon = normalizeLasso(points)
    const tooSmall = polygon.length < 3 || pathLength(points) < MIN_PATH
    if (tooSmall) {
      clearSvg()
      onCancel?.()
      return
    }
    draw(polygon, true)
    window.setTimeout(clearSvg, 280)
    onFinish?.(polygon, { shift: Boolean(e?.shiftKey) })
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !e.altKey) return
    e.preventDefault()
    e.stopPropagation()
    start(e)
  }

  function onPointerMove(e) {
    if (!drawing) return
    e.preventDefault()
    move(e)
  }

  function onPointerUp(e) {
    if (!drawing) return
    e.preventDefault()
    finish(e)
  }

  function onWheel(e) {
    if (drawing) e.preventDefault()
  }

  function onKey(e) {
    if (e.key === 'Alt') {
      e.preventDefault()
      document.body.classList.toggle('is-armed', e.type === 'keydown')
    }
    if (e.type === 'keydown' && e.key === 'Escape' && drawing) {
      drawing = false
      document.body.classList.remove('is-lassoing')
      clearSvg()
      onCancel?.()
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
