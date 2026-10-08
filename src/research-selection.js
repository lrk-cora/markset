import { rectanglePoints } from './research-conditions.js'

// Conventional rectangles, not synthetic brush strokes. Pointer capture keeps
// drag completion stable. App chrome is outside this surface and remains usable.
export function initResearchSelection({ layer, getFrame, getGroup, enabled, project, onStart, onFinish }) {
  let start = null, pointer = null
  const box = points => {
    const node = document.createElement('div')
    node.className = 'research-selection-box'
    const xs = points.map(p => p.x), ys = points.map(p => p.y)
    const layerRect = layer.getBoundingClientRect()
    Object.assign(node.style, { left: `${Math.min(...xs)-layerRect.left}px`, top: `${Math.min(...ys)-layerRect.top}px`, width: `${Math.max(...xs)-Math.min(...xs)}px`, height: `${Math.max(...ys)-Math.min(...ys)}px` })
    return node
  }
  function render() {
    const frame = getFrame(), group = getGroup()
    layer.hidden = !enabled() || !frame
    if (layer.hidden) { start = null; pointer = null; layer.replaceChildren(); return }
    const rect = frame.getBoundingClientRect()
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${Math.max(72,rect.top)}px`, width: `${rect.width}px`, height: `${Math.max(0,Math.min(innerHeight,rect.bottom)-Math.max(72,rect.top))}px` })
    layer.replaceChildren()
    for (const selection of group?.selections || []) layer.append(box(selection.points.map(project)))
    if (start) layer.append(box(rectanglePoints(start, start)))
    layer.style.pointerEvents = group?.applying ? 'none' : 'auto'
  }
  layer.addEventListener('pointerdown', event => {
    if (!enabled() || getGroup()?.applying || event.button !== 0) return
    event.preventDefault(); start = { x: event.clientX, y: event.clientY }; pointer = event.pointerId
    layer.setPointerCapture(pointer); onStart(); render()
  })
  layer.addEventListener('pointermove', event => {
    if (!start || event.pointerId !== pointer) return
    const rect = getFrame().getBoundingClientRect()
    const end = { x: Math.max(rect.left,Math.min(rect.right,event.clientX)), y: Math.max(72,rect.top,Math.min(rect.bottom,event.clientY)) }
    layer.querySelector('.research-drag')?.remove()
    const node = box(rectanglePoints(start,end)); node.classList.add('research-drag'); layer.append(node)
  })
  layer.addEventListener('pointerup', event => {
    if (!start || event.pointerId !== pointer) return
    const rect = getFrame().getBoundingClientRect()
    const end = { x: Math.max(rect.left,Math.min(rect.right,event.clientX)), y: Math.max(72,rect.top,Math.min(rect.bottom,event.clientY)) }
    const points = rectanglePoints(start,end); start = null; pointer = null
    onFinish(points); render()
  })
  layer.addEventListener('pointercancel', () => { start = null; pointer = null; render() })
  return { render }
}
