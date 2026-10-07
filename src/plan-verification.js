import { planCheckReport } from './plan-check-policy.js'

export function planSteps(plan) { return plan.type === 'batch' ? plan.steps || [] : [plan] }

function clippedPixels(el,rect,doc) {
  let horizontal=0,vertical=0
  for (let parent=el.parentElement; parent && parent !== doc.body && parent !== doc.documentElement; parent=parent.parentElement) {
    const style=doc.defaultView.getComputedStyle(parent), box=parent.getBoundingClientRect()
    if (['hidden','clip'].includes(style.overflowX)) horizontal=Math.max(horizontal,Math.max(0,box.left-rect.left)+Math.max(0,rect.right-box.right))
    if (['hidden','clip'].includes(style.overflowY)) vertical=Math.max(vertical,Math.max(0,box.top-rect.top)+Math.max(0,rect.bottom-box.bottom))
  }
  return {horizontal,vertical}
}

export function measurePlanDocument(doc) {
  const nodes = new Map()
  for (const el of [doc.body,...doc.body.querySelectorAll('[data-markset-id]')]) {
    const webId = el.getAttribute('data-markset-id') || '__body'
    const rect = el.getBoundingClientRect()
    const display=doc.defaultView.getComputedStyle(el).display
    const parentDisplay=el.parentElement ? doc.defaultView.getComputedStyle(el.parentElement).display : ''
    nodes.set(webId,{ webId,el,rect:{x:rect.x,y:rect.y,w:rect.width,h:rect.height},style:el.getAttribute('style') || '',
      parentId:el.parentElement?.getAttribute('data-markset-id') || '__body',text:el.children.length ? null : el.textContent,
      attrs:[...el.attributes].filter((attr)=>!['style'].includes(attr.name)).map((attr)=>`${attr.name}=${attr.value}`).join('|'),
      overflow:Math.max(0,el.scrollWidth-el.clientWidth),clipped:clippedPixels(el,rect,doc),display,parentDisplay,
      paintRects: ownContentRects(el, doc) })
  }
  return { nodes,overflow:Math.max(0,doc.documentElement.scrollWidth-doc.documentElement.clientWidth),
    scroll:{x:doc.defaultView.scrollX || doc.documentElement.scrollLeft || 0,y:doc.defaultView.scrollY || doc.documentElement.scrollTop || 0} }
}

function overlap(a,b) { return Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)) }

function ownContentRects(el, doc) {
  const box = rect => ({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
  if (/^(IMG|SVG|CANVAS|VIDEO|IFRAME|INPUT|TEXTAREA|SELECT)$/u.test(el.tagName)) return [box(el.getBoundingClientRect())]
  const boxes = []
  for (const child of el.childNodes) {
    if (child.nodeType !== 3 || !child.textContent.trim()) continue
    const range = doc.createRange(); range.selectNodeContents(child)
    // Glyph-line boxes, not the full-width h1/main container's empty space.
    const rects = range.getClientRects?.()
    boxes.push(...(rects ? [...rects].map(box) : [box(el.getBoundingClientRect())]))
  }
  // A visible empty leaf (e.g. a colored panel) is real painted content too.
  const background = doc.defaultView.getComputedStyle(el).backgroundColor
  if (!boxes.length && !el.children.length && background && !/^(transparent|rgba\([^)]*,\s*0\))$/u.test(background)) boxes.push(box(el.getBoundingClientRect()))
  return boxes.filter(rect => rect.w > 0 && rect.h > 0)
}

function contentGeometry(snapshot) {
  const cache = new Map()
  const belongs = (child, root) => {
    let id = child.webId
    const visited = new Set()
    while (id && !visited.has(id)) {
      if (id === root.webId) return true
      visited.add(id); id = snapshot.nodes.get(id)?.parentId
    }
    return false
  }
  return node => {
    if (!cache.has(node.webId)) {
      const boxes = node.paintRects == null ? [node.rect] : [...snapshot.nodes.values()]
        .filter(child => belongs(child, node)).flatMap(child => child.paintRects || [])
      cache.set(node.webId, { boxes, area: boxes.reduce((sum, box) => sum + box.w * box.h, 0) })
    }
    return cache.get(node.webId)
  }
}

const occupiedOverlap = (a, b) => a.boxes.reduce((sum, box) => sum + b.boxes.reduce((subtotal, other) => subtotal + overlap(box, other), 0), 0)

export function auditPlanResult(plan, before, after, {insertions=[]} = {}) {
  const issues = [], steps = planSteps(plan), changed = new Set(), removed = new Set(), textChanged = new Set(), moved = new Set()
  const allowSubtree = (set,id) => {
    const root = before.nodes.get(id)?.el
    if (!root) return
    for (const [webId,node] of before.nodes) if (node.el === root || root.contains(node.el)) set.add(webId)
  }
  for (const [stepIndex,step] of steps.entries()) {
    const ids = (step.targets || []).map((target)=>String(target.webId))
    const placement=step.insertion?.placement || (step.parameters?.bounds ? 'position' : 'after')
    if (step.type==='insert' && placement==='position' && step.parameters?.bounds) {
      const expected=step.parameters.bounds
      // IDs come from the real executor, not the model. Do not match against an
      // unrelated new image or an existing target in a compound edit.
      const created=insertions.filter(item=>item.stepIndex===stepIndex).map(item=>after.nodes.get(item.webId)).filter(Boolean)
      if (!created.length) issues.push({code:'insertion-position-unverified',stepIndex})
      for(const node of created) {
        const actual={...node.rect,x:node.rect.x+(after.scroll?.x || 0),y:node.rect.y+(after.scroll?.y || 0)}
        const keys=step.contentKind==='image' ? ['x','y','w','h'] : ['x','y','w']
        if (keys.some(key=>Math.abs(actual[key]-expected[key])>4)) issues.push({code:'insertion-position-mismatch',stepIndex,webId:node.webId,expected,actual})
      }
    }
    if (step.type==='style') for(const id of ids) {
      const node=after.nodes.get(id)
      if (!node) continue
      for(const property of Object.keys(step.styles || {})) {
        const flexOnly=['flex-direction','flex-wrap'].includes(property)
        const gridOnly=['grid-template-columns','grid-auto-flow'].includes(property)
        const alignment=['align-items','justify-content'].includes(property)
        const item=['order','align-self'].includes(property)
        const ineffective=(flexOnly && !/flex/u.test(node.display)) || (gridOnly && !/grid/u.test(node.display))
          || (alignment && !/flex|grid/u.test(node.display)) || (item && !/flex|grid/u.test(node.parentDisplay))
        if (ineffective) issues.push({code:'inactive-layout-style',webId:id,property,display:node.display,parentDisplay:node.parentDisplay,detail:`${property}在当前${node.display}组件上不会实现预期布局；请调整真实布局容器或改用重排工具`})
      }
    }
    if (step.type === 'delete') ids.forEach((id)=>step.targetRanges?.length ? allowSubtree(textChanged,id) : allowSubtree(removed,id))
    if (step.type === 'replace') ids.forEach((id)=>allowSubtree(textChanged,id))
    if (step.type === 'replace-image') ids.forEach((id)=>allowSubtree(changed,id))
    if (step.type === 'style' || step.type === 'color') ids.forEach((id)=>allowSubtree(changed,id))
    if (step.type === 'move') ids.forEach((id)=>moved.add(id))
    if (step.type === 'reorder') {
      ids.forEach((id)=>changed.add(id))
      const parents = new Set(ids.map((id)=>before.nodes.get(id)?.parentId))
      if (parents.size === 1) changed.add([...parents][0])
    }
  }
  for (const [id,node] of before.nodes) {
    const next = after.nodes.get(id)
    if (removed.has(id) || textChanged.has(id)) continue
    if (!next) { issues.push({code:'non-target-removed',webId:id}); continue }
    if (node.text != null && node.text !== next.text) issues.push({code:'non-target-text-changed',webId:id})
    if (!changed.has(id) && (node.style !== next.style || node.attrs !== next.attrs)) issues.push({code:'non-target-attributes-changed',webId:id})
    if (!moved.has(id) && node.parentId !== next.parentId) issues.push({code:'non-target-moved',webId:id})
  }
  if (after.overflow > before.overflow + 4) issues.push({code:'page-horizontal-overflow',pixels:after.overflow,increasePixels:after.overflow-before.overflow})
  for (const [id,node] of after.nodes) {
    const old=before.nodes.get(id)?.clipped || {horizontal:0,vertical:0}
    if (node.clipped.horizontal > old.horizontal+4 || node.clipped.vertical > old.vertical+4) issues.push({code:'new-content-clipped',webId:id,pixels:Math.max(node.clipped.horizontal,node.clipped.vertical)})
  }
  const affected = [...after.nodes.values()].filter((node)=>changed.has(node.webId) || moved.has(node.webId) || !before.nodes.has(node.webId))
  const oldContent = contentGeometry(before), newContent = contentGeometry(after)
  for (const node of affected) {
    if (node.overflow > (before.nodes.get(node.webId)?.overflow || 0) + 4) issues.push({code:'component-overflow',webId:node.webId,pixels:node.overflow,increasePixels:node.overflow-(before.nodes.get(node.webId)?.overflow || 0)})
    for (const other of after.nodes.values()) {
      if (other.webId === node.webId || node.el.contains(other.el) || other.el.contains(node.el) || node.parentId !== other.parentId) continue
      if (!overlap(node.rect,other.rect)) continue
      const a = newContent(node), b = newContent(other)
      const intersect = occupiedOverlap(a, b)
      const previous = before.nodes.get(node.webId), previousOther = before.nodes.get(other.webId)
      const oldIntersect = previous && previousOther ? occupiedOverlap(oldContent(previous),oldContent(previousOther)) : 0
      if (intersect > oldIntersect + 100 && intersect > Math.min(a.area,b.area)*0.15) issues.push({code:'new-content-overlap',webId:node.webId,otherId:other.webId})
    }
  }
  // Classify before bounding display data, so many cosmetic warnings cannot
  // hide a later scope/undo/content-loss error.
  return planCheckReport(issues,{checks:['execution','content-preservation','scope','layout-effect','insertion-position','overflow','clipping','overlap','undo']})
}
