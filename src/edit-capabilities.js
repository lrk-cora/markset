// These are execution/security boundaries, not a list of possible user goals.
export const STYLE_PROPERTIES = Object.freeze(['color','background-color','background','font-size','font-weight','font-style','font-family','line-height','letter-spacing','text-align','text-decoration','display','flex-direction','flex-wrap','justify-content','align-items','align-self','grid-template-columns','grid-auto-flow','gap','row-gap','column-gap','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-right','margin-bottom','margin-left','width','height','min-width','max-width','min-height','max-height','border','border-color','border-width','border-radius','box-shadow','opacity','order','object-fit','aspect-ratio','box-sizing'])
export const NODE_TAGS = Object.freeze(['div','section','article','figure','figcaption','p','h2','h3','h4','span','strong','em','ul','ol','li','a','img','button','small','br'])
export const PLACEMENTS = Object.freeze(['inside-start','inside-end','before','after','position'])

export function checkStyleDeclarations(styles) {
  if (!styles || typeof styles !== 'object' || Array.isArray(styles) || !Object.keys(styles).length || Object.keys(styles).length > 32) return 'empty-or-large-style-patch'
  for (const [property, value] of Object.entries(styles)) {
    if (!STYLE_PROPERTIES.includes(property)) return `unsupported-style:${property}`
    if (typeof value !== 'string' || value.length > 240 || /url\s*\(|expression\s*\(|javascript:|@import|[<>;{}]/iu.test(value)) return `unsafe-style:${property}`
    if (['display','opacity','height','max-height'].includes(property) && ['none','0','0px'].includes(value.trim())) return 'use-delete-instead-of-hidden-style'
  }
  return ''
}

export function checkNodeSpecs(nodes, depth = 0, budget = { count: 0 }) {
  if (!Array.isArray(nodes) || !nodes.length || depth > 5) return 'invalid-node-tree'
  for (const node of nodes) {
    if (++budget.count > 64 || !NODE_TAGS.includes(node?.tag)) return 'invalid-node-tag-or-size'
    if (node.text != null && (typeof node.text !== 'string' || node.text.length > 4000)) return 'invalid-node-text'
    if (node.styles) { const reason = checkStyleDeclarations(node.styles); if (reason) return reason }
    for (const [name, value] of Object.entries(node.attributes || {})) {
      if (!['alt','title','href','src','type','aria-label'].includes(name) || typeof value !== 'string' || value.length > 8000) return 'unsafe-node-attribute'
      if (name === 'href' && !/^(?:https?:\/\/|#)/u.test(value)) return 'unsafe-node-link'
      if (name === 'src' && !/^(?:https?:\/\/|data:image\/(?:png|jpeg|webp);base64,)/u.test(value)) return 'unsafe-node-image'
    }
    if (node.children?.length) { const reason = checkNodeSpecs(node.children, depth + 1, budget); if (reason) return reason }
  }
  return ''
}

export function planningTargets(selected, observation) {
  const byId = new Map((selected || []).map((target) => [String(target.webId), { ...target, selected: true }]))
  for (const node of observation?.nodes || []) {
    if (!byId.has(String(node.webId))) byId.set(String(node.webId), { ...node, selected: false, related: true })
  }
  return [...byId.values()]
}
