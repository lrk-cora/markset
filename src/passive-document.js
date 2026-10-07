// Imported pages are editable static documents, not runnable applications.
// Clean the parsed tree BEFORE attaching it to the sandboxed iframe, including
// old cached imports that never passed through the current server sanitizer.
// This is defense in depth, not a replacement for the iframe sandbox. In
// particular, it cannot prevent an extension injecting scripts after mounting.
export function stripExecutableMarkup(root) {
  const removed = { elements: 0, attributes: 0 }
  const visit = (tree) => {
    for (const el of tree.querySelectorAll('*')) {
      const tag = String(el.localName || '').toLowerCase()
      if (['script', 'iframe', 'frame', 'object', 'embed'].includes(tag)
        || (tag === 'meta' && /^refresh$/iu.test((el.getAttribute('http-equiv') || '').trim()))
        || (tag === 'link' && /(?:^|\s)(?:modulepreload|import)(?:\s|$)/iu.test(el.getAttribute('rel') || ''))) {
        el.remove()
        removed.elements++
        continue
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase()
        // DOM parsing decodes HTML entities; normalize control whitespace too
        // so java&#x73;cript: and java&#10;script: do not evade the check.
        const url = attr.value.replace(/[\u0000-\u0020\u007f]/gu, '')
        const executableUrl = ['href', 'xlink:href', 'src', 'action', 'formaction'].includes(name)
          && /^(?:javascript:|vbscript:|data:(?:text\/html|application\/xhtml\+xml))/iu.test(url)
        if (name.startsWith('on') || name === 'srcdoc' || executableUrl) {
          el.removeAttribute(attr.name)
          removed.attributes++
        }
      }
      if (tag === 'template' && el.content) visit(el.content)
    }
  }
  visit(root)
  return removed
}
