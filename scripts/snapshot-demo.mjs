import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const MAX_IMAGE = 1_200_000
const MAX_IMAGES = 16
const MAX_CSS = 500_000

const PAGES = [
  {
    name: '名言卡片.html',
    url: 'https://quotes.toscrape.com/',
    why: '多条名言卡片，适合改色、删除、套风格',
  },
  {
    name: '书店橱窗.html',
    url: 'https://books.toscrape.com/',
    why: '封面图网格，适合缩小、改图色、挪模块',
  },
  {
    name: 'SQLite官网.html',
    url: 'https://www.sqlite.org/index.html',
    why: 'Logo+文档导航+正文，适合风格和删块',
  },
  {
    name: 'Python官网.html',
    url: 'https://www.python.org/',
    why: 'Logo+横幅+新闻栏，适合布局和配色',
  },
  {
    name: '万维网首页.html',
    url: 'https://info.cern.ch/',
    why: '最早的网页，极简，适合加框、插字、贴图案',
  },
  {
    name: '菜鸟教程-HTML.html',
    url: 'https://www.runoob.com/html/html-tutorial.html',
    why: '中文教程页，侧栏+正文，适合改字色和删除',
  },
  {
    name: 'NASA每日天文图.html',
    url: 'https://apod.nasa.gov/apod/astropix.html',
    why: '大图+说明文字，适合缩放、改图色、加装饰',
  },
  {
    name: 'DuckDuckGo搜索.html',
    url: 'https://html.duckduckgo.com/html/',
    why: '无脚本搜索页：Logo+搜索框',
  },
  {
    name: 'HackerNews.html',
    url: 'https://news.ycombinator.com/',
    why: '条目列表',
  },
  {
    name: '维基百科-茶.html',
    url: 'https://zh.wikipedia.org/wiki/%E8%8C%B6',
    why: '中文词条',
  },
]

function abs(url, base) {
  try {
    return new URL(url, base).href
  } catch {
    return ''
  }
}

async function fetchBuf(url, { as = 'text' } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 22000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: as === 'text' ? 'text/html,text/css,*/*;q=0.8' : 'image/*,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`${res.status} ${url}`)
    if (as === 'bytes') {
      const buf = Buffer.from(await res.arrayBuffer())
      const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0]
      return { buf, type, finalUrl: res.url }
    }
    const text = await res.text()
    return { text, type: res.headers.get('content-type') || '', finalUrl: res.url }
  } finally {
    clearTimeout(timer)
  }
}

function guessMime(url, type) {
  if (type && type.startsWith('image/')) return type
  const u = url.toLowerCase()
  if (u.includes('.png')) return 'image/png'
  if (u.includes('.webp')) return 'image/webp'
  if (u.includes('.gif')) return 'image/gif'
  if (u.includes('.svg')) return 'image/svg+xml'
  return 'image/jpeg'
}

async function inlineCss(css, base) {
  let out = css
  const imports = [...css.matchAll(/@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?[^;]*;/gi)]
  for (const m of imports) {
    const href = abs(m[1], base)
    if (!href.startsWith('http')) continue
    try {
      const got = await fetchBuf(href)
      const nested = await inlineCss(got.text.slice(0, MAX_CSS), got.finalUrl)
      out = out.replace(m[0], nested)
    } catch {
      /* keep original */
    }
  }
  const urls = [...out.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)]
  let n = 0
  for (const m of urls) {
    if (n >= 8) break
    const href = abs(m[2], base)
    if (!href.startsWith('http') || href.startsWith('data:')) continue
    if (!/\.(png|jpe?g|gif|webp|svg|woff2?)(\?|$)/i.test(href) && !/image/i.test(href)) continue
    try {
      const img = await fetchBuf(href, { as: 'bytes' })
      if (img.buf.length > MAX_IMAGE) continue
      const mime = guessMime(href, img.type)
      const data = `url("data:${mime};base64,${img.buf.toString('base64')}")`
      out = out.split(m[0]).join(data)
      n += 1
    } catch {
      /* keep */
    }
  }
  return out
}

async function snapshot({ name, url }) {
  const page = await fetchBuf(url)
  const base = page.finalUrl || url
  let html = page.text
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<noscript\b[^>]*>/gi, '').replace(/<\/noscript>/gi, '')

  const cssHrefs = []
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*['"]?stylesheet/i.test(tag)) return tag
    const m = tag.match(/href\s*=\s*['"]([^'"]+)['"]/i)
    if (!m) return ''
    const href = abs(m[1], base)
    if (href) cssHrefs.push(href)
    return ''
  })

  const styles = []
  for (const href of cssHrefs.slice(0, 8)) {
    try {
      const got = await fetchBuf(href)
      styles.push(await inlineCss(got.text.slice(0, MAX_CSS), got.finalUrl))
    } catch {
      /* skip */
    }
  }

  const imgCache = new Map()
  let imgCount = 0
  async function asData(href) {
    if (!href || href.startsWith('data:')) return href
    const full = abs(href, base)
    if (!full.startsWith('http')) return href
    if (imgCache.has(full)) return imgCache.get(full)
    if (imgCount >= MAX_IMAGES) return full
    try {
      const img = await fetchBuf(full, { as: 'bytes' })
      if (img.buf.length < 80 || img.buf.length > MAX_IMAGE) {
        imgCache.set(full, full)
        return full
      }
      const mime = guessMime(full, img.type)
      const data = `data:${mime};base64,${img.buf.toString('base64')}`
      imgCache.set(full, data)
      imgCount += 1
      return data
    } catch {
      imgCache.set(full, full)
      return full
    }
  }

  const imgTags2 = [...html.matchAll(/<img\b[\s\S]*?>/gi)].map((m) => m[0])
  for (const tag of imgTags2.slice(0, MAX_IMAGES + 6)) {
    let next = tag
    const src = tag.match(/\ssrc\s*=\s*['"]([^'"]+)['"]/i)?.[1]
    if (src) {
      const data = await asData(src)
      next = next.replace(/\ssrc\s*=\s*['"][^'"]+['"]/i, ` src="${data}"`)
    }
    next = next.replace(/\ssrcset\s*=\s*['"][^'"]+['"]/i, '')
    html = html.replace(tag, next)
  }

  html = html.replace(/(href|src)\s*=\s*['"](?!data:|https?:|mailto:|#|javascript:)([^'"]+)['"]/gi, (_, attr, rel) => {
    const full = abs(rel, base)
    return full ? `${attr}="${full}"` : `${attr}="${rel}"`
  })

  const baseTag = `<base href="${base.replace(/"/g, '')}">`
  const bundled = styles.length ? `<style>\n${styles.join('\n')}\n</style>` : ''
  const note = `<!-- MarkSet demo snapshot of ${base} -->`
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n${note}\n<meta charset="utf-8">\n${baseTag}\n${bundled}`)
  } else {
    html = `<!DOCTYPE html><html><head>${note}<meta charset="utf-8">${baseTag}${bundled}</head><body>${html}</body></html>`
  }
  if (!/^<!doctype/i.test(html)) html = `<!DOCTYPE html>\n${html}`

  const out = join(ROOT, name)
  await writeFile(out, html, 'utf8')
  return { name, bytes: Buffer.byteLength(html), images: imgCount, css: styles.length, base }
}

await mkdir(ROOT, { recursive: true })
const results = []
for (const page of PAGES) {
  try {
    const r = await snapshot(page)
    results.push({ ok: true, why: page.why, ...r })
    console.log(`OK ${page.name}  ${(r.bytes / 1024).toFixed(0)}KB  css=${r.css} img=${r.images}`)
  } catch (err) {
    results.push({ ok: false, name: page.name, why: page.why, error: String(err.message || err) })
    console.error(`FAIL ${page.name}  ${err.message || err}`)
  }
}
await writeFile(join(ROOT, '_demo-index.json'), JSON.stringify(results, null, 2), 'utf8')
console.log('done')
