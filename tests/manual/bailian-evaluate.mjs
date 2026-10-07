// Explicit paid evaluation, excluded from npm test. Uses the production planner
// and validator; never prints credentials, request bodies or provider raw text.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { loadEnv } from 'vite'
import { brushIntent } from '../../server/plugin.js'
import { validateIntentPlan } from '../../src/intent-plan.js'

const args = process.argv.slice(2)
if (!args.includes('--paid')) throw new Error('This calls paid models. Explicitly pass --paid to proceed.')
const option = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
const env = loadEnv('development', process.cwd(), '')
if (env.MARKSET_PROVIDER !== 'bailian' || env.MARKSET_ALLOW_MODEL_CALLS !== '1') throw new Error('Enable the official Bailian backend before evaluating.')
const source = readFileSync(option('cases', 'output/playwright/cases.json'), 'utf8')
// Accept JSON fixtures or the result of playwright-cli run-code.
const cases = JSON.parse(source.match(/### Result\r?\n([\s\S]+?)\r?\n### Ran Playwright code/u)?.[1] || source)
const captures = resolve(option('captures', 'output/playwright'))
const out = resolve(option('out', 'output/playwright/bailian-evaluation'))
mkdirSync(out, { recursive: true })
const rounds = Math.max(1, Math.min(5, Number(option('rounds', '1')) || 1))
const tiers = args.includes('--compare') ? ['flash', 'max'] : ['routed']
const results = []
let blocked = false
for (let round = 1; round <= rounds; round++) for (const item of cases) for (const tier of tiers) {
  if (blocked) break
  const targets = structuredClone(item.targets)
  for (const target of targets) for (const char of target.charRects || []) char.documentRect ||= char.rect
  const image = `data:image/png;base64,${readFileSync(join(captures, `eval-${item.name}.png`)).toString('base64')}`
  const model = tier === 'max' ? env.MARKSET_BAILIAN_MAX_MODEL || 'qwen3.8-max' : env.MARKSET_BAILIAN_FLASH_MODEL || 'qwen3.8-flash'
  const config = tier === 'routed' ? env : { ...env, MARKSET_BAILIAN_FLASH_MODEL: model, MARKSET_BAILIAN_MAX_MODEL: model }
  const start = Date.now()
  let result
  try {
    const value = await brushIntent(config, { ...item, targets, userInstruction: item.instruction, imageDataUrls: [image] })
    const validation = validateIntentPlan(value.intent, targets, item.instruction)
    const plan = value.intent
    const specific = item.name === 'strike' ? plan.targetRanges?.some((range) => range.start === 9 && range.end === 13 && range.expectedText?.trim() === '冗余说明')
      : item.name === 'insert' ? plan.contentKind === 'image' && Boolean(plan.imagePrompt)
        : item.name === 'edit' ? plan.imageMode === 'edit' && Boolean(plan.imagePrompt) : true
    result = { ...value, name: item.name, tier, round, wallMs: Date.now() - start, validation,
      matchesExpected: plan.type === item.expect, specific: Boolean(specific) }
  } catch (error) {
    result = { name: item.name, tier, round, model: error.model || model, wallMs: Date.now() - start,
      error: error.code || 'evaluation_failed', status: error.status || 500, retriesUsed: error.retriesUsed || 0 }
    // Do not keep spending after authentication, configuration or quota errors.
    blocked = [400, 401, 403, 429].includes(result.status)
  }
  results.push(result)
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ name: result.name, model: result.model, round, elapsedMs: result.wallMs,
    type: result.intent?.type, valid: result.validation?.ok, expected: result.matchesExpected,
    specific: result.specific, error: result.error, retriesUsed: result.retriesUsed }))
}
const summary = tiers.map((tier) => {
  const rows = results.filter((item) => item.tier === tier)
  return { tier, count: rows.length, correctValid: rows.filter((row) => row.validation?.ok && row.matchesExpected && row.specific).length,
    errors: rows.filter((row) => row.error).length, meanMs: Math.round(rows.reduce((sum, row) => sum + row.wallMs, 0) / Math.max(1, rows.length)) }
})
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ summary, stoppedOnProviderError: blocked }))
if (results.some((row) => row.error || !row.validation?.ok || !row.matchesExpected || !row.specific)) process.exitCode = 1
