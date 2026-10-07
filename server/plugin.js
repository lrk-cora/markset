import dns from 'node:dns'
import { bailianConfig, publicBailianConfig } from './bailian-config.js'
import { routeAnalysis } from './model-routing.js'
import { requestBailianImage } from './bailian-image.js'
import { brushResponseFormat } from './brush-plan.js'
import { planningSystem, runPlanningAgent } from './planning-agent.js'
import { planningTargets } from '../src/edit-capabilities.js'
import { sampleStrokePoints, initialPlanningEvidence, compactPlanningContext } from '../src/planning-evidence.js'
import { partialPlanSuggestion } from './model-stream.js'
import { startAnalysisStream } from './analysis-stream.js'
import { planningRegionEvidence } from '../src/brush-regions.js'
import { randomUUID } from 'node:crypto'
import { requestModelChat } from './model-chat.js'
import { createModelStatusProbe } from './model-status.js'
import { downloadGatewayImage, requestGatewayImage } from './image-gateway.js'
import { createImageJobStore } from './image-jobs.js'
import { requestFailure, withDeadline } from './retry.js'
import { imageRequestPolicy, modelRequestPolicy } from '../src/request-policy.js'
import { analysisIssue } from '../src/analysis-errors.js'
import { modelTimeoutMetadata, sanitizeModelAttempts } from '../src/model-diagnostics.js'
import { MAX_PLAN_REPAIRS } from '../src/plan-check-policy.js'
import { importPageRequest, maybeSmartArrange } from './import-page.js'
import { assertPublicUrl } from './safe-url.js'
import { isAnnotationChoice } from '../src/proposal-choices.js'

dns.setDefaultResultOrder('ipv4first')

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  if (res.analysisStream) return res.analysisStream.finish(status, body)
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(json)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0, oversized = false
    req.on('data', (c) => {
      size += c.length
      if (size > 32 * 1024 * 1024) {
        if (!oversized) reject(requestFailure('请求过大，请缩小图片或网页文件', 'request_too_large', 413))
        oversized = true; chunks.length = 0
      } else if (!oversized) chunks.push(c)
    })
    req.on('end', () => {
      if (oversized) return
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(requestFailure('请求不是有效 JSON', 'invalid_json', 400))
      }
    })
    req.on('error', reject)
  })
}

function dashBase(env) {
  const official = bailianConfig(env)
  if (official) return official.baseUrl
  return (env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(
    /\/$/,
    '',
  )
}

function models(env) {
  const official = bailianConfig(env)
  if (official) return { rewriteModel: official.brushModel, plannerModel: official.maxModel, ocrModel: official.brushModel, inpaintModel: official.imageModel, t2iModel: official.imageModel }
  return {
    rewriteModel: env.DASHSCOPE_REWRITE_MODEL || 'qwen3.6-flash',
    plannerModel: env.DASHSCOPE_PLANNER_MODEL || 'qwen3-vl-plus',
    ocrModel: env.DASHSCOPE_OCR_MODEL || 'qwen-vl-ocr-latest',
    inpaintModel: env.DASHSCOPE_INPAINT_MODEL || 'wanx2.1-imageedit',
    t2iModel: env.DASHSCOPE_T2I_MODEL || 'wanx2.1-t2i-turbo',
  }
}

function modelGateway(env) {
  const official = bailianConfig(env)
  if (official) return official
  return {
    baseUrl: (env.MARKSET_MODEL_BASE_URL || env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
    apiKey: env.MARKSET_MODEL_API_KEY || env.DASHSCOPE_API_KEY || '',
    brushModel: env.MARKSET_BRUSH_MODEL || 'gpt-6-sol',
  }
}

function imageGateway(env) {
  const official = bailianConfig(env)
  if (official) return { ...official, model: official.imageModel, highModel: official.imageProModel }
  return {
    baseUrl: (env.MARKSET_IMAGE_BASE_URL || env.MARKSET_MODEL_BASE_URL || 'https://api.jinkundong.store/v1').replace(/\/$/, ''),
    apiKey: env.MARKSET_IMAGE_API_KEY || env.MARKSET_MODEL_API_KEY || '',
    model: env.MARKSET_IMAGE_MODEL || 'gpt-image-2.5-sunburst',
  }
}

function missing(env) {
  const gateway = modelGateway(env)
  const image = imageGateway(env)
  return {
    dashscope: !(bailianConfig(env)?.apiKey || env.DASHSCOPE_API_KEY),
    modelGateway: !gateway.apiKey,
    imageGateway: !image.apiKey,
  }
}

function allowModelCalls(env, _req) {
  return env.MARKSET_ALLOW_MODEL_CALLS === '1'
}

function redact(text, env) {
  let out = String(text || 'api error')
  const secrets = [env.DASHSCOPE_API_KEY, env.MARKSET_MODEL_API_KEY, env.MARKSET_IMAGE_API_KEY, bailianConfig(env)?.apiKey].filter((value) => value && value.length > 6)
  for (const secret of secrets) out = out.split(secret).join('[redacted]')
  return out
}

function keyHints(env) {
  const dash = env.DASHSCOPE_API_KEY || ''
  return {
    dashscopePrefixOk: dash.startsWith('sk-'),
  }
}

function dashNativeOrigin(env) {
  const raw = dashBase(env)
  if (raw.includes('/compatible-mode')) return raw.replace(/\/compatible-mode\/v1$/, '')
  if (raw.endsWith('/v1')) return raw.slice(0, -3)
  return 'https://dashscope.aliyuncs.com'
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function proxyAsset(req, res, env) {
  const raw = new URL(req.url || '/', 'http://markset.local').searchParams.get('url') || ''
  const target = await assertPublicUrl(raw)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 18000)
  try {
    const upstream = await fetch(target.href, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.5',
        'User-Agent': 'Mozilla/5.0 (compatible; MarkSetAssetProxy/0.1)',
      },
    })
    if (upstream.url && upstream.url !== target.href) await assertPublicUrl(upstream.url)
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`)
    const type = upstream.headers.get('content-type') || 'application/octet-stream'
    if (!/^image\//i.test(type) && !/^font\//i.test(type)) throw new Error('unsupported asset type')
    const buf = Buffer.from(await upstream.arrayBuffer())
    if (buf.length > 4_000_000) throw new Error('asset too large')
    res.statusCode = 200
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(buf)
  } finally {
    clearTimeout(timer)
  }
}

async function dashChat(env, { model, messages, temperature = 0.2, thinking = 'off', signal }) {
  if (bailianConfig(env)) return modelChat(env, { model, messages, temperature, signal })
  const body = {
    model,
    temperature,
    messages,
  }
  if (thinking === 'off') body.enable_thinking = false
  const res = await fetch(`${dashBase(env)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error?.message || data.message || `dashscope ${res.status}`)
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502
    throw err
  }
  const textOut = data.choices?.[0]?.message?.content?.trim()
  if (!textOut) {
    const err = new Error('dashscope empty')
    err.status = 502
    throw err
  }
  return textOut
}

async function modelChat(env, { model, messages, temperature = 0, maxTokens = 1200, signal, structured = false, onResponse, onAttempt, onRetry, onDelta, onStart, stream = false, tools, retries, returnMessage = false }) {
  const gateway = modelGateway(env)
  return requestModelChat({
    ...gateway, ...modelRequestPolicy(env), model: model || gateway.brushModel, messages, temperature, maxTokens, signal, onResponse, onAttempt, onRetry, onDelta, onStart, stream, returnMessage, ...(retries == null ? {} : { retries }),
    // Native function arguments carry the schema during Agent turns. Avoid
    // simultaneously constraining assistant content to JSON and tool calls.
    requestOptions: { ...(gateway.chatOptions || {}), ...(structured && !tools?.length ? { response_format: brushResponseFormat } : {}), ...(tools ? { tools,tool_choice:'auto' } : {}) },
  })
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('model did not return JSON')
  return JSON.parse(text.slice(start, end + 1))
}

function normalizeBounds(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null
  const w = Math.max(0, Math.min(4000, Number(value.w) || 0))
  const h = Math.max(0, Math.min(4000, Number(value.h) || 0))
  return { x: Number(value.x), y: Number(value.y), w, h }
}

export async function brushIntent(env, payload, { signal, onRawOutput, onProgress } = {}) {
  const gateway = modelGateway(env)
  const targets = planningTargets(Array.isArray(payload.targets) ? payload.targets.slice(0,24) : [], payload.observation)
  const strokes = Array.isArray(payload.strokes) ? payload.strokes.slice(0, 12) : []
  const regions = planningRegionEvidence(Array.isArray(payload.regions) ? payload.regions : [], targets.filter(target => target.selected !== false), strokes)
  const regionNumbers = new Map(regions.flatMap(region => region.targetIds.map(id => [id, region.number])))
  const images = Array.isArray(payload.imageDataUrls) ? payload.imageDataUrls.filter(Boolean).slice(0, 3) : []
  const pageText = String(payload.pageText || '').slice(0, 5000)
  const userInstruction = String(payload.userInstruction || '').trim().slice(0, 1000)
  const preferences = Array.isArray(payload.preferences) ? payload.preferences.map((item) => String(item).trim().slice(0, 180)).filter(Boolean).slice(0, 8) : []
  const behaviorMemory = payload.behaviorMemory && typeof payload.behaviorMemory === 'object'
    ? {
      profile: payload.behaviorMemory.profile || {},
      profileSources: payload.behaviorMemory.profileSources || {},
      memories: Array.isArray(payload.behaviorMemory.memories) ? payload.behaviorMemory.memories.slice(0, 8) : [],
      recentEpisodes: Array.isArray(payload.behaviorMemory.recentEpisodes) ? payload.behaviorMemory.recentEpisodes.slice(0, 6) : [],
      learningEnabled: payload.behaviorMemory.learningEnabled !== false,
    }
    : null
  // Stable system/tool prefix is cache-friendly. Per-operation preferences and
  // page evidence belong in context, not a rewritten system message each turn.
  const instruction = planningSystem
  const context = {
    coordinateSpace: 'web-document',
    imageNotes: '图片依次为带笔迹的整页缩略图、标记区域放大图。蓝底白字角标为与用户界面一致的区域序号，不是网页内容或手写笔迹。数值坐标为原网页 CSS 像素，不是缩放后图片像素。',
    regions,
    strokes: strokes.map((stroke) => ({
      id:stroke.id || '',closed:Boolean(stroke.closed),role:stroke.role || '',
      shape: stroke.shape || '',
      points:sampleStrokePoints(stroke.documentPoints || stroke.points),
      viewportPoints:sampleStrokePoints(stroke.points),
    })),
    targets: targets.filter((target) => target.selected !== false).map((target) => ({
      webId: target.webId,
      regionNumber: regionNumbers.get(String(target.webId)) || null,
      selected: target.selected !== false, related: Boolean(target.related),
      kind: target.kind,
      text: String(target.text || '').slice(0, 600),
      textTruncated: Boolean(target.textTruncated),
      textLength: Number(target.textLength || String(target.text || '').length),
      rect: target.documentRect || target.screenRect || null,
      viewportRect: target.screenRect || null,
      documentRect: target.documentRect || null,
      context: target.context || null,
      charRects: Array.isArray(target.charRects) ? target.charRects.slice(0, 1200).map((item) => ({ index: item.index, char: item.char, rect: item.documentRect || item.screenRect || null })) : [],
      textFragments: Array.isArray(target.textFragments) ? target.textFragments.slice(0, 20) : [],
      markedRanges: Array.isArray(target.markedRanges) ? target.markedRanges.slice(0, 20) : [],
    })),
    pageText,
    userInstruction,
    localEvidence: payload.localInterpretation?.evidence || null,
    moduleCatalog: payload.observation?.modules || [],
    initialEvidence: initialPlanningEvidence(payload.observation),
    strokeEndpoints: payload.observation?.strokeEndpoints || [],
    answeredClarifications: payload.answeredClarifications || [],
    evidence: payload.evidence || null,
    preferences,
    behaviorMemory,
  }
  // The system message already contains these rules. Duplicating them in the
  // user message increases vision-request latency without adding evidence.
  const compactContext = compactPlanningContext(context)
  const content = [{ type: 'text', text: `上下文 JSON：${JSON.stringify(compactContext)}` }]
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })
  const routing = gateway.provider === 'bailian' ? routeAnalysis(payload, gateway) : { model: gateway.brushModel, tier: 'default', reason: '既有配置' }
  const startedAt = Date.now()
  let retriesUsed = 0, progressTrace=[], usage = null
  const timings = { modelRequests: 0, modelAttempts: 0, upstreamMs: 0, readToolCalls: 0, serverMs: 0, attempts: [] }
  timings.evidenceChars = JSON.stringify(compactContext).length
  timings.originalEvidenceChars = JSON.stringify(context).length
  const notify = value => { if (!signal?.aborted) onProgress?.(value) }
  const retryBudget=Number.isInteger(payload.retryBudget) ? Math.max(0,Math.min(2,payload.retryBudget)) : 2
  try {
    const result = await withDeadline((totalSignal) => runPlanningAgent({
      targets, observation:payload.observation, fallback:payload.localInterpretation, instruction:userInstruction,
      answered:payload.answeredClarifications || [], signal:totalSignal, repairFeedback:payload.repairFeedback,repairsUsed:payload.repairsUsed,
      onProgress:(trace)=>{
        progressTrace=trace
        const last = trace.at(-1)
        if (last?.stage === 'observe') notify({ stage:'observe', draftSummary:'' })
        if (last?.stage === 'repair') notify({ stage:'repair', draftSummary:'' })
      },
      messages:[{role:'system',content:instruction},{role:'user',content}],
      chat:async (messages,{tools}) => {
        timings.modelRequests++
        const request = timings.modelRequests
        let lastSummary = '', firstSummary = false, lastPublished = 0
        const message = await modelChat(env, { model:routing.model,structured:gateway.provider === 'bailian',returnMessage:true,tools,
          // Observe useful progress even for JSON clients; UI streaming is an
          // independent choice and never changes the upstream timeout semantics.
          stream:true,
          onStart:()=>{ lastSummary=''; lastPublished=0; notify({stage:payload.repairFeedback || progressTrace.some(item=>item.stage==='repair') ? 'repair' : 'planning',draftSummary:''}) },
          onDelta:({content,toolCalls})=>{
            const proposal = toolCalls.find(call=>call.function.name === 'propose_edit')
            // Mixed read/write turns are rejected; don't present their draft.
            if (toolCalls.length > 1) return notify({stage:'observe',draftSummary:''})
            const summary = partialPlanSuggestion(proposal?.function.arguments || (!toolCalls.length ? content : ''))
            if (summary.length < 6 || summary === lastSummary) return
            if (lastSummary && Date.now()-lastPublished < 100 && summary.length-lastSummary.length < 12) return
            lastSummary=summary; lastPublished=Date.now()
            if (!firstSummary) { firstSummary=true; timings.firstSummaryMs ??= Date.now()-startedAt }
            notify({stage:'draft',draftSummary:summary})
          },
          retries:Math.max(0,retryBudget-retriesUsed),onRetry:()=>{retriesUsed++; notify({stage:'retry',retry:retriesUsed,draftSummary:''})},
          onAttempt:(attempt)=>{
            timings.modelAttempts++; timings.upstreamMs+=attempt.elapsedMs
            timings.attempts = sanitizeModelAttempts([...timings.attempts, { request, ...attempt }])
          },
          onResponse:(value)=>{
            if (value.usage) {
              usage ||= { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
              for (const key of Object.keys(usage)) usage[key]+=Number(value.usage[key]) || 0
            }
          },
          temperature:0,maxTokens:routing.tier === 'max' ? 4000 : 2200,signal:totalSignal,messages })
        if (!message.tool_calls?.some(call=>call.function.name !== 'propose_edit')) {
          const summary=partialPlanSuggestion(message.tool_calls?.[0]?.function.arguments || message.content)
          if (summary) { timings.firstSummaryMs ??= Date.now()-startedAt; notify({stage:'draft',draftSummary:summary}) }
        }
        if (message.content) onRawOutput?.(message.content)
        return message
      },
    }),{signal,timeoutMs:modelRequestPolicy(env).timeoutMs,timeoutError:requestFailure('AI规划达到总时限','model_total_timeout',504,
      {timeoutSource:'local',timeoutStage:'total',timeoutMs:modelRequestPolicy(env).timeoutMs})})
    timings.readToolCalls = result.toolCalls || 0
    timings.serverMs = Date.now()-startedAt
    return { ...result, model:routing.model,routing,elapsedMs:timings.serverMs,retriesUsed,usage,timings }
  } catch (error) {
    error.trace ||= progressTrace
    timings.serverMs = Date.now()-startedAt
    timings.readToolCalls = error.trace.filter(stage=>stage.stage==='observe').length
    Object.assign(error, { model: routing.model, routing, elapsedMs: timings.serverMs, retriesUsed, timings })
    throw error
  }
}

function modelUnavailable(err) {
  const m = String(err?.message || '')
  return /not found|does not exist|InvalidParameter|model_not_found|AccessDenied|Arrearage|unsupport|未开通|不存在|无权限|不支持/i.test(m)
}

let ocrModelOk = ''

function cleanOcrText(raw) {
  let t = String(raw || '').trim()
  if (!t) return ''
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(t.slice(start, end + 1))
      t = String(json.text || json.handwriting || json.result || t)
    } catch {
      /* keep raw */
    }
  }
  t = t
    .replace(/^手写(汉字|内容|文字)?[：:]\s*/u, '')
    .replace(/^["'`「」『』]+|["'`「」『』]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
  if (t.length > 24) t = t.slice(0, 24)
  return t
}

async function transcribeInk(env, imageUrl, instruction) {
  const { ocrModel, plannerModel } = models(env)
  const prompt =
    instruction ||
    '只识别图中的手写汉字，按书写顺序原样输出。不要解释，不要把圈线认成字。没有手写就输出空。'
  const content = [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: { url: imageUrl },
      min_pixels: 3072,
      max_pixels: 8388608,
    },
  ]
  const list = [...new Set([ocrModelOk, ocrModel, 'qwen-vl-ocr-latest', 'qwen3.5-ocr', 'qwen-vl-ocr', plannerModel].filter(Boolean))]
  let lastErr
  for (const model of list) {
    try {
      const isOcr = /ocr/i.test(model)
      const textOut = await dashChat(env, {
        model,
        temperature: 0,
        thinking: isOcr ? 'omit' : 'off',
        messages: isOcr
          ? [{ role: 'user', content }]
          : [
              { role: 'system', content: planSystem('ink') },
              { role: 'user', content },
            ],
      })
      ocrModelOk = model
      return { textOut, model }
    } catch (err) {
      lastErr = err
      if (ocrModelOk === model) ocrModelOk = ''
      if (!modelUnavailable(err) && err.status !== 400 && err.status !== 404) throw err
    }
  }
  throw lastErr || new Error('ocr failed')
}

function collectPayloadImages(payload) {
  const out = []
  const seen = new Set()
  const extra = Array.isArray(payload?.imageDataUrls) ? payload.imageDataUrls : []
  const context = Array.isArray(payload?.contextImageDataUrls) ? payload.contextImageDataUrls : []
  for (const url of [payload?.imageDataUrl, payload?.image_url, payload?.contextImageDataUrl, ...extra, ...context]) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= 3) break
  }
  return out
}

async function rewrite(env, payload) {
  const { rewriteModel, plannerModel } = models(env)
  const instruction = String(payload.instruction || '').trim()
  const text = String(payload.text || '')
  const pageContext = String(payload.pageContext || '').trim()
  const mode = String(payload.mode || '').trim() || (payload.insert ? 'insert' : 'rewrite')
  if (!instruction) {
    const err = new Error('missing instruction')
    err.status = 400
    throw err
  }
  const images = collectPayloadImages(payload)
  if (mode === 'annotate') {
    const userText = [
      `指令：${instruction}`,
      text ? `原文：${text}` : '',
      pageContext ? `圈出位置周围的页面文字：\n${pageContext.slice(0, 2000)}` : '',
      '只输出 JSON：{"marks":["..."]}，不要解释。',
      'marks 里每一项必须是原文中已经存在的连续片段。',
      '若用户点名了几个词，或附图蓝圈/线/星/三角形只罩住几个词，只返回那些词。',
      '附图中画在单词上的三角形、五角星、下划线标出的就是要标的词。',
      '不要把整段原文放进 marks，除非指令明确要求标整段。',
    ]
      .filter(Boolean)
      .join('\n')
    const content = [{ type: 'text', text: `${userText}${images.length ? '\n附图：蓝线圈出用户关心的段落；圈内若另有标记或只罩住几个词，以那些为准。' : ''}` }]
    for (const url of images) content.push({ type: 'image_url', image_url: { url } })
    const textOut = await dashChat(env, {
      model: images.length ? plannerModel : rewriteModel,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You pick phrases to highlight, bold, or underline in webpage text. Return JSON only: {"marks":["exact substring",...]}. Each mark must already appear in the original passage. If the user named words, or the screenshot shows a triangle/star/underline on some words, return only those words. Never return the whole paragraph unless the user asked to mark the entire passage. Return {"marks":[]} if nothing specific should be marked.',
        },
        images.length ? { role: 'user', content } : { role: 'user', content: userText },
      ],
    })
    return { text: textOut, model: images.length ? plannerModel : rewriteModel }
  }
  const userText = [
    `指令：${instruction}`,
    text ? `${mode === 'insert' ? '用户要求' : '原文'}：${text}` : '',
    pageContext ? `圈出位置周围的页面文字：\n${pageContext.slice(0, 2000)}` : '',
    images.length || pageContext
      ? mode === 'insert'
        ? '只输出文案本身，不要解释，不要加引号。语气、语言、主题必须贴合周围网页。'
        : '只输出改完后的整段可见文字，不要解释，不要加引号。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  if (images.length) {
    const content = [
      {
        type: 'text',
        text:
          mode === 'insert'
            ? `${userText}\n附图：蓝线圈出要插入的空白，周围是真实网页。`
            : `${userText}\n附图：蓝线圈出用户关心的文字。若圈只罩住整段里的几个词或几句，或指令写明只改其中几个词/几句，则只改那些，其余原文一字不动。必须返回改完后的完整段落，不要只返回被改的那几个词。`,
      },
    ]
    for (const url of images) content.push({ type: 'image_url', image_url: { url } })
    try {
      const textOut = await dashChat(env, {
        model: plannerModel,
        temperature: mode === 'insert' ? 0.45 : 0.2,
        messages: [
          {
            role: 'system',
            content:
              mode === 'insert'
                ? 'You write short webpage copy to insert into the circled blank. Match the surrounding page language, tone, topic, and length. Return only the copy.'
                : 'You rewrite webpage text. Keep the original language unless asked to change it. If the circle or instruction only covers some words or sentences, change only those and return the COMPLETE original passage with those edits. Never return just the edited fragment. Never replace the passage with the instruction. Return only the passage.',
          },
          { role: 'user', content },
        ],
      })
      return { text: textOut, model: plannerModel }
    } catch {
      /* fall back to text-only rewrite */
    }
  }
  const textOut = await dashChat(env, {
    model: rewriteModel,
    messages: [
      {
        role: 'system',
        content:
          'You rewrite the selected webpage text. Keep the original language unless the instruction asks to change it. Return only the rewritten text, with no quotes, labels, or explanation. Never replace the passage with the instruction itself. If the instruction or a circled excerpt names only some words or sentences, change only those and return the complete original passage with those edits. If surrounding page context is given, match its topic and tone.',
      },
      {
        role: 'user',
        content: userText,
      },
    ],
  })
  return { text: textOut, model: rewriteModel }
}

function planSystem(task) {
  if (task === 'ink') {
    return [
      'Output JSON only: {"text":"..."}.',
      'Transcribe handwritten Chinese from the stroke images. Blue strokes are the lasso or paint. Black strokes are handwriting.',
      'Return the exact characters you see, even if messy. Use an empty string if there is no handwriting.',
      'Do not guess an editing operation. Do not describe the webpage. Do not treat the blue circle as a character.',
    ].join(' ')
  }
  if (task === 'intent') {
    return [
      'Output JSON only: {"text":"缩小","note":"scale-down","mark":"五角星","guesses":[{"id":"scale-down","label":"把圈中内容缩小","note":"scale-down","command":"","shape":"五角星"}]}.',
      'The JSON above is only a schema. Choose ids that match THIS user writing and drawing, not the example.',
      'You MUST look at the images. Image 1 is a white stroke board (blue = lasso or symbol, black = handwriting or doodle). Image 2 is a close-up. Image 3 is the circled region on the page. Image 4 is the full page.',
      'Symbols are annotations too. Identify stars, triangles, X marks, checks, underlines, arrows, and custom doodles FROM THE IMAGE. Local geometry often confuses triangle vs star; trust the picture. Put the Chinese name in mark and guesses[].shape.',
      'Field text = exact handwritten characters. If the user message already gives a transcription, copy it into text and trust it unless the image clearly disagrees.',
      'Combine writing WITH where the blue stroke sits. Circle text → edit that text. Circle an image → edit that image. If the user asks to change only some words or sentences, or draws a triangle/star/underline on specific words, the op is bold/highlight/underline on THOSE words, not the whole paragraph.',
      'If the circle is on a photo, book cover, or illustration, even a color request (red, warmer, recolor) MUST use generate-image to regenerate the picture. color/color-image is only for text color or flat UI fills, never for photographs.',
      'Map the written words to ops. 删/叉/× → delete. 字改红/蓝/绿 → color. 封面/配图改色或换成… → generate-image. 缩小 → scale-down. 放大 → scale-up. 阴影 → shadow. 倒影 → reflect. 加框 → frame. 加粗 → bold. 下划线 → underline. 高亮 → highlight. 加/插入 on blank with no drawing → insert-text. Drawn pattern / sunburst around an object → stamp. Arrow or source-circle plus dest-circle → move-layout. Other words: interpret them, do not default to delete or insert.',
      'If there is NO handwriting, judge the drawing itself from the image. Do not treat a leftover empty blue box as the main intent when black strokes decorate an object.',
      'Give 3 or 4 guesses, most likely first. The first guess MUST match the handwritten meaning, or the drawing you see if there is no writing. label is a short spoken Chinese sentence.',
      'id is one of: insert-text, insert-image, generate-image, generate-text, stamp, deco, delete, delete-image, delete-text, delete-deco, clear-deco, color, color-bg, color-text, color-image, name, polish, custom, frame, circle, shadow, reflect, scale-down, scale-up, indent, move-layout, nudge-left, nudge-right, nudge-up, nudge-down, strike, longer, shorter, highlight, underline, bold, wavy, soften.',
      'command is a concrete value if any (雾蓝, 海盐杯). If asked for more, do not repeat already offered labels.',
    ].join(' ')
  }
  if (task === 'guess') {
    return 'Output JSON only: {"guess":"..."}. One short Chinese phrase for what the user wants the stroked/blue-boxed region to become (color, print, or object). No quotes or explanation.'
  }
  if (task === 'find-same') {
    return 'Output JSON only: {"boxes":[{"x":0,"y":0,"w":0,"h":0}]}. Natural image pixels. List OTHER instances of the same object class as the currently marked blue boxes. Do not repeat already-marked boxes. Empty array if none.'
  }
  return [
    'Output JSON only: {"ops":[{"id":"C1","scope":"in"|"out"|"untouched","target":"T1","tool":"llm_rewrite"|"image_inpaint"|"none","args":{}}]}.',
    'inside: only in. follow (辐射式): MUST rewrite every circled text AND every 圈外相同品名 listed below, even if those outside hits have no #T number. Do not stop at the lasso. anchor (锚定式): untouched for selected images, out for contradicting color words. Never edit price or shipping.',
    'llm_rewrite args {before,after,block_id,start,end}. image_inpaint args {prompt,print?,bbox?}.',
    'Packaging print (box-side letters such as OAK CUP): image_inpaint with args.print true and args.bbox {x,y,w,h} in natural pixels of the printed letters, not the cup body.',
  ].join(' ')
}

async function plan(env, payload) {
  const { plannerModel } = models(env)
  const task = String(payload.task || 'ops')
  const defaults = {
    guess: '根据选中笔迹猜测用户想把这块改成什么，输出一句简短中文。',
    ink: '只识别图中的手写汉字，按书写顺序原样输出。不要解释，不要把圈线认成字。没有手写就输出空。',
    intent: '先看图里的批注：手写、五角星/三角形/叉等标记、以及圈落在网页哪一块。几何猜测可能把三角形和五角星弄混，以图为准。不要默认删除或插入。',
    'find-same': '找出图中与当前选中物体同类的其他物体，不要重复已圈的框。',
  }
  const instruction = String(payload.instruction || '').trim() || defaults[task] || ''
  const marks = String(payload.marks || '')
  const outsideTexts = String(payload.outsideTexts || '')
  const pageText = String(payload.pageText || '')
  const scope = String(payload.scope || 'inside')
  const kind = String(payload.kind || 'unify')
  const imageUrl = payload.imageDataUrl || payload.image_url
  const extraImages = Array.isArray(payload.imageDataUrls) ? payload.imageDataUrls : []
  if (!instruction) {
    const err = new Error('missing instruction')
    err.status = 400
    throw err
  }

  if (task === 'ink') {
    const url = imageUrl || extraImages[0]
    if (!url) {
      const err = new Error('missing image')
      err.status = 400
      throw err
    }
    const { textOut, model } = await transcribeInk(env, url, instruction)
    const handwritingOut = cleanOcrText(textOut)
    console.log(`[markset ink] model=${model} text=${handwritingOut.slice(0, 24)}`)
    return {
      text: textOut,
      handwriting: handwritingOut,
      ops: [],
      boxes: [],
      guess: '',
      note: '',
      command: '',
      intent: '',
      guesses: [],
      model,
    }
  }

  const handwriting = String(payload.handwriting || '').trim()
  const userContent = [
    {
      type: 'text',
      text: [
        `任务：${task}`,
        `指令：${instruction}`,
        `范围：${scope}`,
        `按钮：${kind}`,
        handwriting
          ? `已读出的手写（以它为准，除非图中明显不是这几个字）：${handwriting}`
          : '请从笔迹图读出汉字。没有手写就根据画法理解。',
        `当前圈到的内容：\n${marks || '无'}`,
        outsideTexts ? `圈外相同品名（辐射式必须改，不要只改圈内）：\n${outsideTexts}` : '',
        pageText ? `全文（禁改：价格/物流/专利）：\n${pageText}` : '',
        '把「手写字」和「画在哪一块」合在一起理解。只输出 JSON。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ]
  const seen = new Set()
  for (const url of [imageUrl, ...extraImages]) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    userContent.push({ type: 'image_url', image_url: { url } })
  }
  const textOut = await dashChat(env, {
    model: plannerModel,
    temperature: 0,
    messages: [
      { role: 'system', content: planSystem(task) },
      { role: 'user', content: userContent },
    ],
  })
  let ops = []
  let boxes = []
  let guess = ''
  let note = ''
  let command = ''
  let intent = ''
  let guesses = []
  let handwritingOut = ''
  try {
    const start = textOut.indexOf('{')
    const end = textOut.lastIndexOf('}')
    if (start >= 0 && end > start) {
      const json = JSON.parse(textOut.slice(start, end + 1))
      if (Array.isArray(json.ops)) ops = json.ops
      if (Array.isArray(json.boxes)) boxes = json.boxes
      if (Array.isArray(json.guesses)) guesses = json.guesses
      if (json.guess) guess = String(json.guess)
      if (json.note) note = String(json.note)
      if (json.command) command = String(json.command)
      if (json.intent) intent = String(json.intent)
      if (json.handwriting) handwritingOut = String(json.handwriting)
      else if (json.text) handwritingOut = String(json.text)
      if (!guess && task !== 'intent' && task !== 'ink' && json.text) guess = String(json.text)
    }
  } catch {
    ops = []
  }
  if (task === 'intent') {
    const first = guesses[0]?.id || note || ''
    console.log(`[markset intent] model=${plannerModel} text=${(handwritingOut || handwriting).slice(0, 24)} id=${first}`)
  }
  return { text: textOut, handwriting: handwritingOut, ops, boxes, guess, note, command, intent, guesses, model: plannerModel }
}

async function inlineImage(url) {
  if (!url || String(url).startsWith('data:')) return url
  return downloadGatewayImage(url)
}

function wanxError(body, fallback) {
  return (
    body?.output?.message ||
    body?.message ||
    body?.output?.code ||
    body?.code ||
    fallback
  )
}

async function waitWanxTask(env, taskId) {
  const origin = dashNativeOrigin(env)
  for (let i = 0; i < 45; i += 1) {
    await sleep(2000)
    const st = await fetch(`${origin}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}` },
    })
    const body = await st.json().catch(() => ({}))
    const status = body.output?.task_status
    if (status === 'SUCCEEDED') return body
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const err = new Error(wanxError(body, '万相任务失败'))
      err.status = 502
      throw err
    }
    if (!st.ok) {
      const err = new Error(wanxError(body, `万相查询 ${st.status}`))
      err.status = 502
      throw err
    }
  }
  const err = new Error('万相超时')
  err.status = 504
  throw err
}

async function wanxPost(env, path, payload) {
  const origin = dashNativeOrigin(env)
  const started = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(payload),
  })
  const first = await started.json().catch(() => ({}))
  if (!started.ok) {
    const err = new Error(wanxError(first, `万相 ${started.status}`))
    err.status = 502
    throw err
  }
  const taskId = first.output?.task_id
  if (!taskId) {
    const err = new Error(wanxError(first, '万相未返回任务号'))
    err.status = 502
    throw err
  }
  return waitWanxTask(env, taskId)
}

function firstWanxUrl(data) {
  const results = data?.output?.results || []
  return results[0]?.url || results[0]?.image_url || ''
}

function pickWanxSize(w, h) {
  const rw = Number(w) || 0
  const rh = Number(h) || 0
  if (!rw || !rh) return '1024*1024'
  const ratio = rw / rh
  if (ratio >= 1.45) return '1280*720'
  if (ratio <= 0.7) return '720*1280'
  return '1024*1024'
}

async function wanxInpaint(env, { model, prompt, imageUrl, maskUrl }) {
  return wanxPost(env, '/api/v1/services/aigc/image2image/image-synthesis', {
    model,
    input: {
      function: 'description_edit_with_mask',
      prompt,
      base_image_url: imageUrl,
      mask_image_url: maskUrl,
    },
    parameters: { n: 1 },
  })
}

async function enrichImagePrompt(env, payload, { signal } = {}) {
  const prompt = String(payload.prompt || '').trim()
  const pageContext = String(payload.pageContext || '').trim()
  const images = collectPayloadImages({
    imageDataUrls: payload.contextImageDataUrls,
    contextImageDataUrl: payload.contextImageDataUrl,
  })
  if (!images.length && !pageContext) return prompt
  const { plannerModel } = models(env)
  const content = [
    {
      type: 'text',
      text: [
        '根据用户要求和网页截图，写一段用于文生图的提示词。',
        '截图里蓝线圈出的是要放图的空白；周围是真实页面。生成的图要能放进这个位置，风格、配色、主题跟周围网页一致。',
        '提示词写清楚：主体、风格（图标/插画/照片）、色调、构图。不要大段文字、水印、UI边框。',
        '只输出提示词，不要解释。',
        `用户要求：${prompt}`,
        pageContext ? `周围页面文字：${pageContext.slice(0, 1600)}` : '',
        payload.width || payload.height
          ? `目标尺寸约 ${Math.round(payload.width || 0)}×${Math.round(payload.height || 0)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ]
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })
  try {
    const out = env.DASHSCOPE_API_KEY
      ? await dashChat(env, {
          model: plannerModel,
          temperature: 0.4,
          signal,
          messages: [{ role: 'user', content }],
        })
      : await modelChat(env, {
          model: modelGateway(env).brushModel,
          temperature: 0.2,
          maxTokens: 1000,
          signal,
          messages: [
            {
              role: 'system',
              content: '你是网页配图提示词整理器。只输出适合图片生成模型的简洁提示词，不要解释。保留用户明确要求，结合网页上下文补足主体、构图、风格和配色。',
            },
            { role: 'user', content },
          ],
        })
    return String(out || prompt)
      .trim()
      .slice(0, 1200) || prompt
  } catch {
    signal?.throwIfAborted()
    return [prompt, pageContext].filter(Boolean).join('\n').slice(0, 1200)
  }
}

async function generateWanxImage(env, payload) {
  const { t2iModel, inpaintModel } = models(env)
  const rawPrompt = String(payload.prompt || '').trim()
  if (!rawPrompt) {
    const err = new Error('missing prompt')
    err.status = 400
    throw err
  }
  const prompt = await enrichImagePrompt(env, payload)
  const replaceUrl = payload.replaceExisting ? payload.imageDataUrl || payload.image_url || '' : ''
  const size = pickWanxSize(payload.width, payload.height)
  let data = null
  let model = t2iModel
  if (replaceUrl) {
    try {
      data = await wanxPost(env, '/api/v1/services/aigc/image2image/image-synthesis', {
        model: inpaintModel,
        input: {
          function: 'description_edit',
          prompt,
          base_image_url: replaceUrl,
        },
        parameters: { n: 1 },
      })
      model = inpaintModel
    } catch {
      data = null
    }
  }
  if (!data) {
    data = await wanxPost(env, '/api/v1/services/aigc/text2image/image-synthesis', {
      model: t2iModel,
      input: { prompt },
      parameters: { size, n: 1 },
    })
  }
  const url = firstWanxUrl(data)
  if (!url) {
    const err = new Error(wanxError(data, '万相未返回图片'))
    err.status = 502
    throw err
  }
  return { imageUrl: await inlineImage(url), model }
}

async function generateImage(env, payload, { requestId, taskId, onTask, model, region } = {}) {
  const official = bailianConfig(env)
  if (official && region && region !== official.region) throw requestFailure('原图片任务属于另一地域，禁止跨地域查询或重新提交', 'image_region_conflict', 409)
  if (official) return requestBailianImage({ config: model ? { ...official, imageModel: model, imageProModel: model } : official, payload, taskId, onTask, ...imageRequestPolicy(env) })
  const rawPrompt = String(payload.prompt || '').trim()
  if (!rawPrompt) {
    const err = new Error('请先描述要生成的图片')
    err.status = 400
    err.code = 'missing_prompt'
    throw err
  }
  const policy = imageRequestPolicy(env)
  const deadlineError = requestFailure('图片准备超时，尚未提交生成任务', 'image_timeout', 504)
  return withDeadline(async (signal) => {
    const prompt = await enrichImagePrompt(env, payload, { signal })
    signal.throwIfAborted()
    return requestGatewayImage({
      ...imageGateway(env), ...policy, prompt, size: pickOpenAiImageSize(payload.width, payload.height),
      quality: env.MARKSET_IMAGE_QUALITY || 'medium', requestId, signal, deadlineError,
    })
  }, { timeoutMs: policy.timeoutMs, timeoutError: deadlineError })
}

function pickOpenAiImageSize(w, h) {
  const width = Number(w) || 0
  const height = Number(h) || 0
  if (!width || !height) return '1024x1024'
  const ratio = width / height
  if (ratio >= 1.45) return '1536x1024'
  if (ratio <= 0.7) return '1024x1536'
  return '1024x1024'
}

async function inpaint(env, payload, options = {}) {
  if (bailianConfig(env)) {
    // Qwen Image 3.0 uses original-image + instruction editing, not a hard mask
    // API. Never silently ignore a supplied mask or switch to another provider.
    if (payload.maskDataUrl || payload.mask_url) throw requestFailure('千问图像 3.0 不支持硬蒙版接口；请使用原图和具体编辑描述', 'image_mask_unsupported', 400)
    return generateImage(env, { ...payload, imageDataUrl: payload.imageDataUrl || payload.image_url, mode: 'edit', replaceExisting: true }, options)
  }
  const { inpaintModel } = models(env)
  const prompt = String(payload.prompt || '').trim() || '按标注修改选中区域，其余画面保持不变'
  const imageUrl = payload.imageDataUrl || payload.image_url
  const maskUrl = payload.maskDataUrl || payload.mask_url
  if (!imageUrl || !maskUrl) {
    const err = new Error('missing image or mask')
    err.status = 400
    throw err
  }
  const data = await wanxInpaint(env, {
    model: inpaintModel,
    prompt,
    imageUrl,
    maskUrl,
  })
  const url = firstWanxUrl(data)
  if (!url) {
    const err = new Error(wanxError(data, '万相未返回图片'))
    err.status = 502
    throw err
  }
  const resultUrl = await inlineImage(url)
  return { imageUrl: resultUrl, model: inpaintModel }
}

export function marksetApi(env, { imageJobs: suppliedJobs } = {}) {
  const official = bailianConfig(env)
  const imageJobs = suppliedJobs || createImageJobStore(official ? { ttlMs: 24 * 3600_000, ledgerFile: '.markset-private/image-tasks.json' } : {})
  const lastCalls = { analysis: null, image: null }
  const gateway = modelGateway(env)
  const checkModels = createModelStatusProbe({
    analysis: { ...gateway, model: gateway.brushModel, highModel: gateway.maxModel }, image: imageGateway(env),
    allowCalls: env.MARKSET_ALLOW_MODEL_CALLS === '1', listOnly: Boolean(official), lastCalls, fetchImpl: (...args) => fetch(...args),
  })
  return {
    name: 'markset-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] || ''
        if (!url.startsWith('/api/')) return next()
        const isImageRequest = ['/api/generate-image', '/api/inpaint'].includes(url)
        const imageId = isImageRequest ? req.headers['idempotency-key'] : ''
        const validImageId = typeof imageId === 'string' && /^[\w.-]{1,128}$/u.test(imageId)
        const requestId = url === '/api/brush-intent' || isImageRequest ? validImageId ? imageId : randomUUID() : ''
        const startedAt = Date.now()
        if (requestId) res.setHeader('X-Request-Id', requestId)
        const analysisController = new AbortController()
        if (url === '/api/brush-intent') res.once('close', () => {
          if (!res.writableEnded) analysisController.abort(new DOMException('Client disconnected', 'AbortError'))
        })

        try {
          if (imageId && !validImageId) throw requestFailure('图片请求标识无效', 'image_invalid_request_id', 400)
          if (req.method === 'GET' && url === '/api/health') {
            const miss = missing(env)
            const image = imageGateway(env)
            send(res, 200, {
              ok: !miss.dashscope || !miss.modelGateway || !miss.imageGateway,
              dashscope: !miss.dashscope,
              modelGateway: !miss.modelGateway,
              imageGateway: !miss.imageGateway,
              wanx: !miss.dashscope,
              imageGeneration: Boolean(image.apiKey),
              imageModel: image.model,
              fal: false,
              sam: false,
              allowCalls: env.MARKSET_ALLOW_MODEL_CALLS === '1',
              importPage: true,
              renderedImport: Boolean(env.BROWSERLESS_API_KEY || env.BROWSERLESS_TOKEN),
              ...models(env),
              brushModel: modelGateway(env).brushModel,
              retryPolicy: { analysis: {...modelRequestPolicy(env),planRepairs:MAX_PLAN_REPAIRS}, image: imageRequestPolicy(env) },
              hints: keyHints(env), ...publicBailianConfig(official), lastCalls,
            })
            return
          }

          if (req.method === 'GET' && url === '/api/asset') {
            try {
              await proxyAsset(req, res, env)
            } catch (err) {
              send(res, err.status || 502, { error: err.message || 'asset proxy failed', code: err.code || 'asset_proxy' })
            }
            return
          }

          if (req.method !== 'POST') {
            send(res, 405, { error: 'method' })
            return
          }

          const body = await readBody(req)
          const miss = missing(env)

          if (url === '/api/model-status') {
            send(res, 200, await checkModels(body.target || 'all'))
            return
          }

          if (url === '/api/model-test') {
            if (!allowModelCalls(env, req)) throw requestFailure('模型调用已关闭', 'calls_disabled', 403)
            const start = Date.now()
            await modelChat(env, { messages: [{ role: 'user', content: '只回答OK' }], maxTokens: 16 })
            lastCalls.analysis = { model: gateway.brushModel, succeededAt: Date.now(), elapsedMs: Date.now() - start }
            send(res, 200, lastCalls.analysis); return
          }

          if (url === '/api/import-page') {
            const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
            const host = String(req.headers.host || 'localhost:5173')
            let page = await importPageRequest({ ...body, assetProxy: `${proto}://${host}/api/asset` }, env)
            if (body?.smart) {
              if (!allowModelCalls(env, req)) {
                page.warnings = [
                  ...(page.warnings || []),
                  '智能整理未执行：请把 .env 中 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启 npm run dev',
                ]
              } else if (miss.dashscope) {
                page.warnings = [...(page.warnings || []), '智能整理未执行：未填 DASHSCOPE_API_KEY']
              } else {
                try {
                  page = await maybeSmartArrange(page, {
                    chatFn: (opts) => dashChat(env, opts),
                    model: models(env).rewriteModel,
                  })
                } catch {
                  page.warnings = [...(page.warnings || []), '智能整理失败，已用抓取结果']
                }
              }
            }
            send(res, 200, page)
            return
          }

          if (url === '/api/brush-intent') {
            if (!allowModelCalls(env, req)) {
              send(res, 403, { error: 'model calls disabled', code: 'calls_disabled' })
              return
            }
            if (miss.modelGateway) {
              send(res, 503, { error: 'missing model gateway key', code: 'missing_model_key' })
              return
            }
            const emit = req.headers.accept?.includes('text/event-stream') ? startAnalysisStream(res) : null
            const result = await brushIntent(env, body, { signal: analysisController.signal, onProgress:emit ? progress=>emit('progress',progress) : undefined })
            lastCalls.analysis = { model: result.model, succeededAt: Date.now(), elapsedMs: result.elapsedMs, retriesUsed: result.retriesUsed }
            send(res, 200, result)
            return
          }

          if (url === '/api/plan' && (body.task === 'intent' || body.task === 'ink')) {
            if (env.MARKSET_ALLOW_MODEL_CALLS !== '1') {
              send(res, 403, { error: 'model calls disabled', code: 'calls_disabled' })
              return
            }
            if (miss.dashscope) {
              send(res, 503, { error: 'missing DASHSCOPE_API_KEY' })
              return
            }
            send(res, 200, await plan(env, body))
            return
          }

          if (!allowModelCalls(env, req)) {
            send(res, 403, {
              error: 'model calls disabled',
              code: env.MARKSET_ALLOW_MODEL_CALLS === '1' ? 'no_client_gate' : 'calls_disabled',
            })
            return
          }

          if (url === '/api/rewrite' || url === '/api/plan') {
            if (miss.dashscope) {
              send(res, 503, { error: 'missing DASHSCOPE_API_KEY' })
              return
            }
            send(res, 200, url === '/api/plan' ? await plan(env, body) : await rewrite(env, body))
            return
          }

          if (url === '/api/inpaint') {
            if (miss.dashscope) {
              send(res, 503, { error: 'missing DASHSCOPE_API_KEY' })
              return
            }
            const result = await imageJobs.run(requestId, { ...body, endpoint: 'inpaint' }, (recovery = {}) => inpaint(env, body, { requestId, ...recovery }))
            lastCalls.image = { model: result.model, succeededAt: Date.now(), elapsedMs: result.elapsedMs, taskId: result.taskId }
            send(res, 200, { ...result, requestId })
            return
          }

          if (url === '/api/generate-image') {
            if (!miss.imageGateway) {
              const result = await imageJobs.run(requestId, body, (recovery = {}) => generateImage(env, body, { requestId, ...recovery }))
              lastCalls.image = { model: result.model, succeededAt: Date.now(), elapsedMs: result.elapsedMs, taskId: result.taskId }
              send(res, 200, { ...result, requestId })
              return
            }
            if (!miss.dashscope) {
              send(res, 200, await imageJobs.run(requestId, body, () => generateWanxImage(env, body)))
              return
            }
            send(res, 503, { error: 'missing image generation key', code: 'missing_image_key' })
            return
          }

          if (url === '/api/sam') {
            send(res, 501, { error: '云端贴轮廓已关闭，请用鼠标圈选范围', code: 'sam_disabled' })
            return
          }

          send(res, 404, { error: 'not found' })
        } catch (err) {
          if (isImageRequest) {
            console.warn('[markset image]', JSON.stringify({ requestId, code: err.code || 'image_failed', status: err.status || 500, elapsedMs: Date.now() - startedAt }))
            send(res, err.status || 500, { error: redact(err.message, env), code: err.code || 'image_failed', requestId, ambiguous: Boolean(err.ambiguous), taskId: err.taskId || '', providerCode: err.providerCode || '' })
            return
          }
          if (requestId) {
            const status = err.status || 500
            const timeout = modelTimeoutMetadata(err)
            const issue = analysisIssue({ code: err.code, status, reason:err.reason,repairsUsed:err.repairsUsed, ...timeout })
            console.warn('[markset brush-intent]', JSON.stringify({
              requestId, code: issue.code, status, upstreamStatus: err.upstreamStatus || null,
              causeCode: err.causeCode || '', elapsedMs: Date.now() - startedAt,
              model: err.model || '', retriesUsed: err.retriesUsed || 0,
              ...timeout, attempts: sanitizeModelAttempts(err.timings?.attempts),
            }))
            send(res, status, { error: issue.message, code: issue.code, requestId, model: err.model || '',
              routing: err.routing || null, retriesUsed: err.retriesUsed || 0, elapsedMs: err.elapsedMs || Date.now() - startedAt,
              reason:err.reason || '',repairsUsed:err.repairsUsed || 0,trace:err.trace?.slice(-12) || [],timings:err.timings || null, ...timeout })
            return
          }
          send(res, err.status || 500, { error: redact(err.message, env), code: err.code })
        }
      })
    },
  }
}
