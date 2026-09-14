import { assertPublicUrl } from './safe-url.js'

const VIEW_W = 1180
const MAX_ASSET = 900_000
const MAX_ASSETS = 40
const MAX_DOC = 7_000_000
const FETCH_MS = 18000

function fail(message, status = 400, code = 'import_error') {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

function decodeAttr(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function tagAttr(tag, name) {
  const m = String(tag || '').match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return decodeAttr(m?.[2] ?? m?.[3] ?? m?.[4] ?? '')
}

function resolveUrl(src, base) {
  if (!src) return ''
  const trimmed = String(src).trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:') || trimmed.startsWith('#')) return trimmed
  try {
    return new URL(trimmed, base).href
  } catch {
    return ''
  }
}

function escapeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function guessMime(type, href) {
  const t = String(type || '').split(';')[0].trim().toLowerCase()
  if (t.startsWith('image/') || t === 'text/css' || t === 'font/woff2' || t === 'font/woff') return t
  if (/\.css(\?|$)/i.test(href)) return 'text/css'
  if (/\.woff2/i.test(href)) return 'font/woff2'
  if (/\.png/i.test(href)) return 'image/png'
  if (/\.jpe?g/i.test(href)) return 'image/jpeg'
  if (/\.gif/i.test(href)) return 'image/gif'
  if (/\.webp/i.test(href)) return 'image/webp'
  if (/\.svg/i.test(href)) return 'image/svg+xml'
  return t || 'application/octet-stream'
}

async function fetchBuffer(href, accept) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS)
  try {
    const res = await fetch(href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        Accept: accept,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    })
    if (!res.ok) throw new Error(String(res.status))
    const buf = Buffer.from(await res.arrayBuffer())
    return { buf, type: res.headers.get('content-type') || '' }
  } finally {
    clearTimeout(timer)
  }
}

async function replaceAsync(text, regex, fn) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
  const matches = [...String(text || '').matchAll(re)]
  if (!matches.length) return text
  let out = ''
  let last = 0
  for (const m of matches) {
    out += text.slice(last, m.index)
    out += await fn(m)
    last = m.index + m[0].length
  }
  return out + text.slice(last)
}

function sanitizeHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/gi, '')
}

function makeInliner(baseUrl) {
  const cache = new Map()
  let used = 0
  const warnings = []
  async function toData(href, accept) {
    const abs = resolveUrl(href, baseUrl)
    if (!abs) return ''
    if (abs.startsWith('data:') || abs.startsWith('#')) return abs
    if (cache.has(abs)) return cache.get(abs)
    if (used >= MAX_ASSETS) return abs
    cache.set(abs, abs)
    try {
      await assertPublicUrl(abs)
      const { buf, type } = await fetchBuffer(abs, accept)
      if (buf.length > MAX_ASSET) {
        warnings.push('有的图片或样式太大，未内嵌')
        return abs
      }
      used += 1
      const mime = guessMime(type, abs)
      const data = `data:${mime};base64,${buf.toString('base64')}`
      cache.set(abs, data)
      return data
    } catch {
      warnings.push('有的外部资源被网站拦住了')
      return abs
    }
  }
  return { toData, warnings }
}

async function inlineCssUrls(css, baseUrl, toData) {
  return replaceAsync(css, /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi, async (m) => {
    const href = m[2]
    if (!href || href.startsWith('data:') || href.startsWith('#')) return m[0]
    const data = await toData(resolveUrl(href, baseUrl), 'image/*,font/*,*/*;q=0.5')
    return `url("${data}")`
  })
}

function injectShell(html, baseUrl) {
  const headBits = [
    '<meta charset="utf-8">',
    `<base href="${escapeAttr(baseUrl)}">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<style>html,body{margin:0;padding:0;width:100%;background:#fff;}img,video{max-width:100%;height:auto;}</style>`,
  ].join('')
  const cleaned = html.replace(/<base\b[^>]*>/gi, '')
  if (/<head\b/i.test(cleaned)) return cleaned.replace(/<head\b[^>]*>/i, (tag) => `${tag}${headBits}`)
  if (/<html\b/i.test(cleaned)) {
    return cleaned.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${headBits}</head>`)
  }
  return `<!doctype html><html><head>${headBits}</head><body>${cleaned}</body></html>`
}

export async function buildSnapshotHtml(html, baseUrl) {
  const inliner = makeInliner(baseUrl)
  let doc = injectShell(sanitizeHtml(html).slice(0, 2_500_000), baseUrl)

  doc = await replaceAsync(doc, /<link\b[^>]*>/gi, async (m) => {
    const tag = m[0]
    const rel = (tagAttr(tag, 'rel') || '').toLowerCase()
    if (!rel.includes('stylesheet')) return /icon|preload|prefetch|canonical/i.test(rel) ? '' : tag
    const href = tagAttr(tag, 'href')
    if (!href) return ''
    const abs = resolveUrl(href, baseUrl)
    try {
      await assertPublicUrl(abs)
      const { buf } = await fetchBuffer(abs, 'text/css,*/*;q=0.4')
      const css = await inlineCssUrls(buf.toString('utf8'), abs, inliner.toData)
      return `<style data-href="${escapeAttr(abs)}">${css}</style>`
    } catch {
      return ''
    }
  })

  doc = await replaceAsync(doc, /<style\b([^>]*)>([\s\S]*?)<\/style>/gi, async (m) => {
    const css = await inlineCssUrls(m[2] || '', baseUrl, inliner.toData)
    return `<style${m[1] || ''}>${css}</style>`
  })

  doc = await replaceAsync(doc, /<img\b([^>]*?)\/?>/gi, async (m) => {
    let attrs = m[1] || ''
    const src = tagAttr(`<img ${attrs}>`, 'src') || tagAttr(`<img ${attrs}>`, 'data-src') || tagAttr(`<img ${attrs}>`, 'data-original')
    const srcset = tagAttr(`<img ${attrs}>`, 'srcset')
    const firstSet = (srcset.split(',')[0] || '').trim().split(/\s+/)[0]
    const picked = src || firstSet
    if (!picked) return m[0]
    const data = await inliner.toData(picked, 'image/*,*/*;q=0.8')
    attrs = attrs
      .replace(/\ssrcset\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i, '')
      .replace(/\ssizes\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i, '')
      .replace(/\s(src|data-src|data-original)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, '')
    return `<img src="${escapeAttr(data)}"${attrs}>`
  })

  if (doc.length > MAX_DOC) doc = doc.slice(0, MAX_DOC)
  return { html: doc, width: VIEW_W, warnings: [...new Set(inliner.warnings)] }
}

export { VIEW_W }
