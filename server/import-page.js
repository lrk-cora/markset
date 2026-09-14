import { assertPublicUrl, importFail as fail } from './safe-url.js'
import { buildSnapshotHtml, VIEW_W } from './snapshot-html.js'

const MAX_HTML = 2_500_000
const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 1_200_000
const MAX_BLOCKS = 32
const FETCH_MS = 14000

function decode(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

function collapse(text) {
  return decode(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function metaContent(html, name) {
  const a = html.match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
  )
  const b = html.match(
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i'),
  )
  return decode((a || b)?.[1] || '')
}

function tagAttr(tag, name) {
  const m = String(tag || '').match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return decode(m?.[2] ?? m?.[3] ?? m?.[4] ?? '')
}

function resolveUrl(src, base) {
  if (!src) return ''
  try {
    return new URL(src, base).href
  } catch {
    return ''
  }
}

function skipImageUrl(href) {
  const u = href.toLowerCase()
  if (!href) return true
  if (u.startsWith('data:image/svg')) return true
  if (/1x1|pixel|spacer|tracking|sprite|favicon|emoji|badge|qrcode/.test(u)) return true
  if (/\.(svg|gif|ico)(\?|$)/.test(u) && u.length < 180) return true
  return false
}

function stripNoise(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
}

function looksBoilerplate(text) {
  return /cookie|隐私政策|登录|注册|购物车|加入会员|copyright|©|首页\s*公司/.test(text) && text.length < 40
}

export function extractFromHtml(html, baseUrl) {
  const raw = stripNoise(html).slice(0, MAX_HTML)
  const title =
    metaContent(raw, 'og:title') ||
    collapse((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') ||
    '未命名页'
  const description = metaContent(raw, 'og:description') || metaContent(raw, 'description')
  const siteName = metaContent(raw, 'og:site_name')
  const ogImage = resolveUrl(metaContent(raw, 'og:image'), baseUrl)
  const blocks = []
  const seenImg = new Set()
  const pushText = (type, text) => {
    const t = collapse(text)
    if (!t || t.length < 2) return
    if (looksBoilerplate(t)) return
    if (blocks.some((b) => b.type !== 'image' && b.text === t)) return
    blocks.push({ type, text: t.slice(0, 800) })
  }
  const pushImg = (src, alt) => {
    const href = resolveUrl(src, baseUrl)
    if (!href || skipImageUrl(href) || seenImg.has(href)) return
    seenImg.add(href)
    blocks.push({ type: 'image', src: href, alt: collapse(alt).slice(0, 80) })
  }

  if (ogImage) pushImg(ogImage, title)

  const re = /<(img)\b([^>]*?)\/?>|<(h[1-3]|p|li)\b([^>]*)>([\s\S]*?)<\/\3>/gi
  let m
  while ((m = re.exec(raw)) && blocks.length < MAX_BLOCKS + 12) {
    if (m[1]) {
      const open = m[2] || ''
      pushImg(tagAttr(open, 'src') || tagAttr(open, 'data-src') || tagAttr(open, 'data-original'), tagAttr(open, 'alt'))
      continue
    }
    const tag = String(m[3] || '').toLowerCase()
    const inner = m[5] || ''
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') pushText('heading', inner)
    else pushText('paragraph', inner)
  }

  const cleaned = []
  for (const b of blocks) {
    if (cleaned.length >= MAX_BLOCKS) break
    if (b.type === 'heading' && cleaned.some((x) => x.type === 'heading' && x.text === b.text)) continue
    cleaned.push(b)
  }
  if (!cleaned.some((b) => b.type === 'heading') && title) {
    cleaned.unshift({ type: 'heading', text: title.slice(0, 80) })
  }
  if (!cleaned.length) throw fail('这个页面几乎没有能读出的标题、段落或图片')
  return {
    title: title.slice(0, 120),
    description: description.slice(0, 240),
    siteName,
    blocks: cleaned,
  }
}

async function fetchBuffer(href, { accept }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS)
  try {
    const res = await fetch(href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        Accept: accept,
        'User-Agent': 'Mozilla/5.0 (compatible; MarkSetImporter/0.1; +local)',
      },
    })
    if (!res.ok) throw fail(`抓取失败 HTTP ${res.status}`, 502)
    const buf = Buffer.from(await res.arrayBuffer())
    const type = res.headers.get('content-type') || ''
    return { buf, type, finalUrl: res.url || href }
  } catch (err) {
    if (err.status) throw err
    throw fail(err.name === 'AbortError' ? '抓取超时' : '抓取网页失败，网站可能拒绝访问', 502)
  } finally {
    clearTimeout(timer)
  }
}

async function inlineImages(blocks) {
  const out = []
  let n = 0
  const warnings = []
  for (const b of blocks) {
    if (b.type !== 'image') {
      out.push(b)
      continue
    }
    if (String(b.src || '').startsWith('data:image/')) {
      out.push(b)
      continue
    }
    if (n >= MAX_IMAGES) {
      warnings.push('图太多，后面的图没有带进来')
      continue
    }
    try {
      await assertPublicUrl(b.src)
      const { buf, type } = await fetchBuffer(b.src, { accept: 'image/*,*/*;q=0.8' })
      if (buf.length > MAX_IMAGE_BYTES) {
        warnings.push('有一张图太大，已跳过')
        continue
      }
      const mime = (type.split(';')[0] || 'image/jpeg').replace('image/jpg', 'image/jpeg')
      if (!mime.startsWith('image/')) continue
      n += 1
      out.push({
        ...b,
        src: `data:${mime};base64,${buf.toString('base64')}`,
        width: 360,
        height: 280,
      })
    } catch {
      warnings.push('有的图被网站拦了，没能下载')
    }
  }
  return { blocks: out, warnings }
}

async function fetchRenderedScreenshot(env, pageUrl) {
  const token = env.BROWSERLESS_API_KEY || env.BROWSERLESS_TOKEN
  if (!token) return ''
  const endpoint = (env.BROWSERLESS_URL || 'https://production-sfo.browserless.io').replace(/\/$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 28000)
  try {
    const res = await fetch(`${endpoint}/screenshot?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: pageUrl,
        viewport: { width: VIEW_W, height: 900 },
        options: { fullPage: true, type: 'jpeg', quality: 82 },
        gotoOptions: { waitUntil: 'networkidle2', timeout: 20000 },
      }),
    })
    if (!res.ok) return ''
    const type = res.headers.get('content-type') || ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > 8_000_000) return ''
    const mime = type.startsWith('image/') ? type.split(';')[0] : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRenderedHtml(env, pageUrl) {
  const token = env.BROWSERLESS_API_KEY || env.BROWSERLESS_TOKEN
  if (!token) {
    throw fail(
      '这个站点多半要浏览器渲染。到 https://www.browserless.io 注册并充值，把 BROWSERLESS_API_KEY 写入 markset/.env 后重启；或在浏览器另存为 HTML 再导入文件。',
      501,
      'need_browser',
    )
  }
  const endpoint = (env.BROWSERLESS_URL || 'https://production-sfo.browserless.io').replace(/\/$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 25000)
  try {
    const res = await fetch(`${endpoint}/content?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: pageUrl,
        gotoOptions: { waitUntil: 'networkidle2', timeout: 20000 },
      }),
    })
    const html = await res.text()
    if (!res.ok) throw fail(`无头浏览器失败 HTTP ${res.status}`, 502, 'browserless')
    if (html.length > MAX_HTML) throw fail('渲染后的页面太大')
    return html
  } finally {
    clearTimeout(timer)
  }
}

export async function importPageRequest(body, env) {
  const htmlIn = String(body?.html || '')
  const rendered = Boolean(body?.rendered)
  let baseUrl = String(body?.baseUrl || body?.url || 'https://imported.local/')
  let html = htmlIn
  const warnings = []

  if (htmlIn) {
    const fromBase = String(htmlIn).match(/<base\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const href = fromBase?.[2] || fromBase?.[3] || fromBase?.[4] || ''
    if (href && !body?.baseUrl && !body?.url) {
      try {
        baseUrl = new URL(href).href
      } catch {
        /* keep default */
      }
    }
  }

  if (!html) {
    const parsed = await assertPublicUrl(body?.url)
    baseUrl = parsed.href
    if (rendered) {
      try {
        html = await fetchRenderedHtml(env, parsed.href)
      } catch (err) {
        const shot = await fetchRenderedScreenshot(env, parsed.href)
        if (shot) {
          let title = parsed.hostname
          try {
            const extracted = extractFromHtml((await fetchBuffer(parsed.href, { accept: 'text/html,*/*;q=0.8' })).buf.toString('utf8').slice(0, 200000), parsed.href)
            title = extracted.title || title
          } catch {
            /* keep host */
          }
          return {
            ok: true,
            sourceUrl: parsed.href,
            title,
            description: '',
            siteName: '',
            blocks: [],
            snapshotHtml: '',
            snapshotWidth: VIEW_W,
            screenshotDataUrl: shot,
            warnings: ['未能拿到渲染后的 HTML，已用整页图放入网页里'],
            usedModel: false,
            rendered: true,
          }
        }
        throw err
      }
    } else {
      const { buf, type, finalUrl } = await fetchBuffer(parsed.href, {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      })
      if (buf.length > MAX_HTML) throw fail('页面太大')
      if (type && !/html|xml|text\//i.test(type)) warnings.push(`内容类型是 ${type}，仍按网页试读`)
      html = buf.toString('utf8')
      baseUrl = finalUrl || parsed.href
    }
  }
  if (!html.trim()) throw fail('没有读到网页内容')

  let snapshotHtml = ''
  try {
    const snap = await buildSnapshotHtml(html, baseUrl)
    snapshotHtml = snap.html
    warnings.push(...(snap.warnings || []))
  } catch {
    warnings.push('未能按原版式打包样式，将尽量用抓到的结构显示')
  }

  let extracted
  try {
    extracted = extractFromHtml(html, baseUrl)
  } catch {
    extracted = { title: '导入的网页', description: '', siteName: '', blocks: [] }
  }
  const inlined = extracted.blocks?.length ? await inlineImages(extracted.blocks) : { blocks: [], warnings: [] }
  warnings.push(...inlined.warnings)
  return {
    ok: true,
    sourceUrl: baseUrl,
    title: extracted.title,
    description: extracted.description,
    siteName: extracted.siteName,
    blocks: inlined.blocks,
    snapshotHtml,
    snapshotWidth: VIEW_W,
    screenshotDataUrl: '',
    warnings: [...new Set(warnings)],
    usedModel: false,
    rendered,
  }
}

export async function maybeSmartArrange(page, { chatFn, model }) {
  if (!chatFn || !page?.blocks?.length) return page
  const lines = page.blocks
    .map((b, i) => `${i}\t${b.type}\t${String(b.text || b.alt || '').slice(0, 100)}`)
    .join('\n')
  const raw = await chatFn({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You clean a crawled page into a short product/article layout. Reply JSON only: {"keep":[0,2,5]} using the given indices in reading order. Keep one heading, a few body paragraphs, specs/price if present, and up to 4 images. Drop nav, ads, cookie banners.',
      },
      { role: 'user', content: `标题：${page.title}\n${lines}` },
    ],
  })
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('smart json')
  const parsed = JSON.parse(raw.slice(start, end + 1))
  const keep = Array.isArray(parsed.keep) ? parsed.keep.map(Number).filter((n) => n >= 0 && n < page.blocks.length) : []
  if (!keep.length) throw new Error('smart empty')
  return {
    ...page,
    blocks: keep.map((i) => page.blocks[i]),
    usedModel: true,
  }
}
