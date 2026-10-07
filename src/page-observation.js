import { pageEvidenceVersion } from './page-evidence-version.js'

const cache = new WeakMap()
const styleKeys = ['display','color','background-color','font-family','font-size','font-weight','line-height','text-align','gap','padding','margin','border-radius','grid-template-columns','flex-direction','width','max-width']
const text = (el) => String(el.textContent || '').replace(/\s+/gu,' ').trim()
const id = (el) => el?.getAttribute('data-markset-id') || ''
const excluded = (el) => /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|IFRAME)$/u.test(el.tagName) || el.closest('[data-markset-tombstone]')
const kind = (el) => el.tagName === 'IMG' ? 'image' : /^(H[1-6]|P|SPAN|A|BUTTON|STRONG|EM|SMALL|FIGCAPTION)$/u.test(el.tagName) ? 'text' : 'container'

export function readPageObservation(doc, selected = [], strokes = [], getRect) {
  if (!doc?.body) return { version: 'goal-agent-v1', modules: [], nodes: [] }
  const version = pageEvidenceVersion(doc)
  const all = [...doc.body.querySelectorAll('[data-markset-id]')].filter((el) => !excluded(el))
  const byId = new Map(all.map((el) => [id(el),el]))
  const modules = new Set()
  const selectedElements=selected.map(target=>byId.get(String(target.webId))).filter(Boolean)
  const parents=new Set(selectedElements.map(el=>el.parentElement))
  // Sibling cards may each be semantic articles, but their layout lives on
  // the shared grid/flex parent. Include that real parent as readable evidence.
  if (selectedElements.length>1 && parents.size===1) {
    const parent=[...parents][0]
    if (parent && parent!==doc.body && parent!==doc.documentElement && /^(?:inline-)?(?:flex|grid)$/u.test(doc.defaultView.getComputedStyle(parent).display)) modules.add(parent)
  }
  for (const target of selected) {
    const el = byId.get(String(target.webId))
    const module = el?.closest('section,article,[role="region"],.card,li,figure') || el?.parentElement
    if (module && module !== doc.body && module !== doc.documentElement) modules.add(module)
  }
  if (!modules.size && strokes.length) {
    const points = strokes.flatMap((stroke) => stroke.points || [])
    if (points.length) {
      const center = { x: points.reduce((sum,p) => sum + p.x,0) / points.length, y: points.reduce((sum,p) => sum + p.y,0) / points.length }
      const near = all.filter((el) => el.matches('section,article,main,div')).map((el) => ({ el, rect:getRect(el) })).filter(({rect}) => rect?.w > 0 && rect.h > 0 && center.x >= rect.x && center.x <= rect.x+rect.w && center.y >= rect.y && center.y <= rect.y+rect.h).sort((a,b) => a.rect.w*a.rect.h-b.rect.w*b.rect.h)[0]
      if (near) modules.add(near.el)
    }
  }
  const result = [], nodes = [], seen = new Set()
  for (const module of [...modules].slice(0,3)) {
    const rect = getRect(module), signature = `${version}:${JSON.stringify(rect)}`
    let entries = cache.get(module)
    if (entries?.signature !== signature) {
      const local = [module,...module.querySelectorAll('[data-markset-id]')].filter((el) => !excluded(el)).slice(0,96)
      const records = local.map((el) => {
        const computed = doc.defaultView.getComputedStyle(el)
        const fullText = text(el)
        return { webId:id(el), moduleId:id(module), kind:kind(el), text:fullText.slice(0,900), textLength:fullText.length, textTruncated:fullText.length>900,
          context:{ tag:el.tagName.toLowerCase(), parentId:id(el.parentElement), className:String(el.className || '').slice(0,120) },
          children:[...el.children].filter((child) => !excluded(child)).map(id).filter(Boolean).slice(0,24),
          documentRect:getRect(el), styles:Object.fromEntries(styleKeys.map((key) => [key,computed.getPropertyValue(key)])),
          ...(el.tagName === 'IMG' ? { imageDescription:el.getAttribute('alt') || '', naturalSize:{w:el.naturalWidth,h:el.naturalHeight} } : {}) }
      })
      entries = { signature, records }; cache.set(module,entries)
    }
    const children = [...module.children].map((el) => ({ webId:id(el),rect:getRect(el) })).filter(({rect}) => rect?.w > 0 && rect.h > 0).sort((a,b)=>a.rect.y-b.rect.y)
    const blanks = children.slice(1).flatMap((child,i) => {
      const previous = children[i], gap = child.rect.y-previous.rect.y-previous.rect.h
      return gap >= 12 ? [{ x:rect.x,y:previous.rect.y+previous.rect.h,w:rect.w,h:gap,beforeId:child.webId,afterId:previous.webId }] : []
    })
    result.push({ webId:id(module), tag:module.tagName.toLowerCase(), text:text(module).slice(0,1000), rect, children:children.map(({webId})=>webId), nearbyBlank:blanks.slice(0,8) })
    for (const node of entries.records) if (!seen.has(node.webId)) { seen.add(node.webId); nodes.push(node) }
  }
  const nearest = (point) => nodes.filter((node) => node.documentRect?.w > 0).map((node) => ({ webId:node.webId,distance:Math.hypot(point.x-node.documentRect.x-node.documentRect.w/2,point.y-node.documentRect.y-node.documentRect.h/2) })).sort((a,b)=>a.distance-b.distance).slice(0,3)
  return { version:'goal-agent-v1', selectedIds:selected.map((target) => String(target.webId)), modules:result, nodes,
    strokeEndpoints:strokes.filter((stroke) => stroke.points?.length).map((stroke) => ({ id:stroke.id, start:stroke.points[0],end:stroke.points.at(-1),startCandidates:nearest(stroke.points[0]),endCandidates:nearest(stroke.points.at(-1)) })) }
}
