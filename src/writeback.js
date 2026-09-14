import { fetchHealth, isClientModelGateOn, planOps } from './api.js'
import { captureMarkedPage } from './capture.js'
import { isForbiddenSpan } from './forbidden.js'
import {
  attachSpansToOps,
  buildLocalOps,
  mergePlanOps,
  parsePlanOps,
  shouldCallPlanner,
} from './ops.js'
import { presentChanges } from './changes.js'
import { exitToView } from './view-mode.js'
import { inferAnchorFact, inferCommandText, parseCommand } from './plan-local.js'
import { attachImageOpsFromBboxes, collectCupBody, collectPrintStandIn } from './print-region.js'
import { collectOutsideEdits } from './scope.js'
import { rememberLocal, startReview } from './card-flow.js'
import { isWebDocActive, runWebWriteback } from './web-doc.js'
import { getSnapshot, ping, targets, undoLastWrite } from './store.js'

let running = false

function gateMessage(err) {
  if (err.code === 'client-gate' || err.code === 'no_client_gate') {
    return '未勾选「允许调用云端模型」'
  }
  if (err.code === 'calls_disabled') {
    return '服务器禁止调用：把 markset/.env 里 MARKSET_ALLOW_MODEL_CALLS 改为 1 并重启 npm run dev'
  }
  return err.message || '调用失败'
}

async function resolveOps(ctx) {
  const local = buildLocalOps(ctx)
  const wantPlan =
    isClientModelGateOn() &&
    shouldCallPlanner(ctx.kind, ctx.scope, ctx.inTexts, ctx.inImages)
  if (!wantPlan) return { ops: local.ops, source: 'local' }
  const health = await fetchHealth().catch(() => ({}))
  if (!health.dashscope) return { ops: local.ops, source: 'local' }
  try {
    const shot = await captureMarkedPage(ctx.editor)
    const outside = (ctx.extraTexts || [])
      .map((s, i) => `out${i + 1} ${s.block_id || ''} ${s.text || ''}`)
      .join('\n')
    const data = await planOps({
      task: 'ops',
      instruction: ctx.commandText,
      marks: shot.marks,
      outsideTexts: outside,
      imageDataUrl: shot.imageDataUrl,
      pageText: shot.pageText,
      scope: ctx.scope,
      kind: ctx.kind,
    })
    const parsed = Array.isArray(data.ops) && data.ops.length ? { ops: data.ops } : parsePlanOps(data.text)
    const attached = parsed ? attachSpansToOps(parsed.ops, ctx) : []
    const withBoxes = attachImageOpsFromBboxes(ctx.editor.view, attached).filter(
      (op) => op.span || op.tool === 'none' || op.scope === 'untouched',
    )
    if (!withBoxes.length) return { ops: local.ops, source: 'local-fallback' }
    return { ops: mergePlanOps(withBoxes, local.ops), source: 'plan' }
  } catch (err) {
    if (err.code === 'client-gate' || err.code === 'calls_disabled' || err.code === 'no_client_gate') {
      return { ops: local.ops, source: 'local' }
    }
    return { ops: local.ops, source: 'local-fallback' }
  }
}

export async function runWriteback(kind, editor, notify) {
  if (running) return
  if (isWebDocActive()) {
    running = true
    try {
      const ok = await runWebWriteback(kind, notify, {
        onBefore: (label) => rememberLocal(editor, label),
      })
      if (ok) startReview()
    } catch (err) {
      notify(err.message || '改网页失败')
    } finally {
      running = false
    }
    return
  }
  const picked = targets().filter((s) => s.kind !== 'slot')
  const scoped = picked.filter((s) => !s.frozen && !isForbiddenSpan(s))
  if (!picked.length) {
    if (getSnapshot().spans.some((s) => s.kind === 'slot')) {
      notify('涂到的是空白，改不了颜色。请涂在杯子或包装盒上；空白处可加阴影、空两格或插入')
      return
    }
    notify('先勾选「将改」。取消勾选即可这次不动某一项')
    return
  }
  if (!scoped.length) {
    notify('价格、专利、物流是禁改区，三种范围都不改它们')
    return
  }
  if (targets().length && targets().every((s) => s.kind === 'slot')) {
    notify('页上空白请用「插入文字」或「插入图片」')
    return
  }

  const snap = getSnapshot()
  const scope = snap.scope || 'inside'
  const texts = scoped.filter((s) => s.kind === 'text')
  let commandText = inferCommandText(snap.commandText, texts)
  let images = scoped.filter((s) => s.kind === 'image')
  if (scope === 'anchor') images = []

  const parsed = parseCommand(commandText)
  const colorIntent = Boolean(parsed.color)

  if (scope === 'inside' && kind !== 'delete') {
    const next = []
    if (colorIntent && !images.length) {
      const cup = collectCupBody(editor.view)
      if (cup) next.push(cup)
    }
    if (next.length) images = next
  }

  const fact = scope === 'anchor' ? inferAnchorFact(picked, commandText) : inferAnchorFact([], commandText)
  const anchorNoType = scope === 'anchor' && (kind === 'unify' || kind === 'rewrite')
  if ((kind === 'rewrite' || kind === 'unify' || kind === 'replace') && !commandText && !anchorNoType) {
    notify('先写下新名字或选出颜色。圈了「红色」等色词也可直接改。')
    return
  }

  const extraTexts =
    kind !== 'delete' && (scope === 'follow' || scope === 'anchor')
      ? collectOutsideEdits(editor.view, commandText, scope)
      : []

  if (scope === 'follow' && !texts.length && !extraTexts.length) {
    notify('请先圈一个要改的词（例如标题里的品名），再写新名字、点改这些')
    return
  }

  if (scope === 'anchor' && !fact.color && !commandText) {
    notify('请圈已经正确的杯身（或一句已对的色词）。不用填新值。')
    return
  }

  if (kind === 'delete' && scoped.some((s) => s.kind === 'image')) {
    const ok = window.confirm('删除会抹掉勾选范围内的字，并抹掉图上那一块。确定？')
    if (!ok) return
  }

  const printSpan =
    kind !== 'delete' && scope === 'follow' && parsed.product ? collectPrintStandIn(editor.view) : null
  const cupSpan = kind !== 'delete' && colorIntent ? collectCupBody(editor.view) : null
  const ctx = {
    editor,
    kind,
    commandText,
    scope,
    inTexts: texts,
    inImages: scope === 'anchor' ? scoped.filter((s) => s.kind === 'image') : images,
    extraTexts,
    printSpan,
    cupSpan,
    fact,
  }

  running = true
  try {
    const planned = await resolveOps(ctx)
    const ops = planned.ops

    if (scope === 'anchor' && !extraTexts.length) {
      notify('说明里没有找到和圈中不一致的色词或品名。')
      return
    }

    await commitInside(editor, ops, kind, commandText, notify, fact, scope)
  } catch (err) {
    notify(gateMessage(err))
  } finally {
    running = false
  }
}

async function commitInside(editor, ops, kind, commandText, notify, fact = null, scope = 'inside') {
  const textOps = ops.filter((op) => op.tool === 'llm_rewrite' && op.span?.kind === 'text')
  const imageOps = ops.filter((op) => op.tool === 'image_inpaint' && op.span?.kind === 'image')
  const planned = textOps.map((op) => ({ ...op.span, op }))
  const images = imageOps.map((op) => ({ ...op.span, op }))

  const wantTextModel = (kind === 'rewrite' || kind === 'unify') && planned.length > 0
  const wantImage =
    images.length > 0 && (kind === 'rewrite' || kind === 'unify' || kind === 'delete' || kind === 'replace')
  const gateOn = isClientModelGateOn()
  const health = gateOn && (wantTextModel || wantImage) ? await fetchHealth().catch(() => ({})) : {}
  const useTextModel = wantTextModel && gateOn && Boolean(health.dashscope)
  const useImageModel = wantImage && gateOn && Boolean(health.fal)
  const localText = planned.length > 0 && (kind === 'replace' || kind === 'delete' || !useTextModel)
  const localImage = wantImage && !useImageModel
  const canDoSomething =
    localText || useTextModel || useImageModel || localImage || (kind === 'delete' && planned.length)

  if (!planned.length && !images.length) {
    notify('没有要改的字或图')
    return
  }

  if (!canDoSomething) {
    notify('没有可执行的改动')
    return
  }

  if (useTextModel || useImageModel) {
    const parts = []
    if (useTextModel) parts.push(`改字 ${planned.length} 次`)
    if (useImageModel) parts.push(`重画 ${images.length} 次`)
    const ok = window.confirm(`将调用云端（${parts.join('，')}），会消耗额度。确定？`)
    if (!ok) return
  }

  try {
    const result = await presentChanges({
      editor,
      kind,
      commandText,
      ops,
      useTextModel,
      useImageModel,
      fact,
    })
    if (!result.ok) {
      notify('没有要改的字或图')
      return
    }

    ping()
    exitToView()
    startReview()
    const skippedModel = wantTextModel && !useTextModel && planned.length
    const usedLocalImage = localImage && images.length
    const head =
      scope === 'follow' ? '已写入圈内外相同的名字' : scope === 'anchor' ? '已按圈中改正文（圈里没动）' : '已写入圈里的'
    const bits = [head, `已标出 ${result.count} 处`]
    if (skippedModel) bits.push('字按你填的新值改')
    if (usedLocalImage) bits.push('图为选区内调色（未调用 fal）')
    bits.push('每处可点「还原这一处」。点页面空白看成品，「撤回全部」撤销整次')
    notify(bits.join('。'))
  } catch (err) {
    undoLastWrite(editor)
    throw err
  }
}
