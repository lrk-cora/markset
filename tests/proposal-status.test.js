import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { proposalStatus, renderProposalStatus } from '../src/proposal-status.js'

const css=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8')
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8')

test('real progress phases have distinct visual identities without affecting authorization',()=>{
  const paths=[]
  for(const state of ['preparing','planning','observe','draft','verify','repair','retry']) {
    const group={modelPending:true,analysisProgress:{stage:state},inferredIntent:{type:'color'}}
    const before=structuredClone(group),status=proposalStatus(group,{pending:true})
    assert.equal(status.state,state);assert.equal(status.busy,true);paths.push(JSON.stringify(status.paths))
    assert.deepEqual(group,before,'display never mutates a plan or starts a call')
  }
  assert.equal(new Set(paths).size,paths.length)
})

test('pending phase outranks stale errors; applying, failed, input, choice, manual and ready are explicit',()=>{
  assert.equal(proposalStatus({analysisProgress:{stage:'observe'}},{pending:true,issue:{message:'stale'}}).state,'observe')
  assert.equal(proposalStatus({applying:true},{pending:true}).state,'applying')
  assert.equal(proposalStatus({},{issue:{message:'failed'}}).state,'failed')
  assert.equal(proposalStatus({},{manual:true}).state,'idle')
  assert.equal(proposalStatus({},{wantsContent:true}).state,'input')
  assert.equal(proposalStatus({},{ambiguous:true}).state,'choice')
  assert.equal(proposalStatus({},{pending:true}).state,'preparing')
  assert.equal(proposalStatus({}).state,'ready')
  assert.equal(proposalStatus({}).busy,false)
})

test('clock-only updates keep the SVG and animations stable; actual phases replace the icon',()=>{
  const dom=new JSDOM('<section class="inline-proposal"><div id="visual" aria-hidden="true"></div></section>')
  try {
    const doc=dom.window.document,card=doc.querySelector('section'),visual=doc.getElementById('visual')
    const planning=proposalStatus({analysisProgress:{stage:'planning'}},{pending:true})
    renderProposalStatus(card,visual,planning,doc)
    const glyph=visual.firstChild
    renderProposalStatus(card,visual,planning,doc)
    assert.equal(visual.firstChild,glyph);assert.equal(visual.querySelectorAll('svg').length,1)
    assert.equal(visual.querySelectorAll('.inline-status-flow').length,0)
    assert.equal(card.dataset.status,'planning')
    renderProposalStatus(card,visual,proposalStatus({}),doc)
    assert.notEqual(visual.firstChild,glyph);assert.equal(visual.classList.contains('is-busy'),false)
    assert.equal(visual.childElementCount,1)
    assert.equal(card.dataset.status,'ready')
    assert.equal(visual.querySelector('svg').getAttribute('focusable'),'false')
  } finally {dom.window.close()}
})

test('compact status icon replaces the header dot without a central icon row',()=>{
  const dom=new JSDOM(html)
  try {
    const doc=dom.window.document
    const sheet=doc.createElement('style');sheet.textContent=css;doc.head.append(sheet)
    const card=doc.getElementById('inline-proposal'),visual=doc.getElementById('inline-status-visual')
    const header=card.querySelector('.inline-proposal-kicker')
    assert.equal(visual.parentElement,header)
    assert.equal(header.firstElementChild,visual)
    assert.equal(visual.nextElementSibling.id,'inline-proposal-kind')
    assert.equal(card.querySelectorAll('#inline-status-visual').length,1)
    assert.equal(card.querySelectorAll('.inline-proposal-dot').length,0)
    renderProposalStatus(card,visual,proposalStatus({analysisProgress:{stage:'repair'}},{pending:true}),doc)
    assert.equal(dom.window.getComputedStyle(visual).width,'20px')
    assert.equal(dom.window.getComputedStyle(visual).height,'20px')
    assert.equal(dom.window.getComputedStyle(visual.querySelector('svg')).width,'14px')
    assert.equal(visual.getAttribute('aria-hidden'),'true')
    assert.equal(visual.querySelectorAll('.inline-status-flow').length,0)
  } finally {dom.window.close()}
})

test('stage styles outrank action styles; decorative icons stay out of the accessibility tree',()=>{
  const dom=new JSDOM(`<style>${css}</style><section class="inline-proposal has-analysis-issue" data-variant="color"><div class="inline-status-visual" hidden></div></section>`)
  try {
    const card=dom.window.document.querySelector('section'),colors=[]
    for(const state of ['preparing','planning','observe','draft','verify','repair','retry','failed']) {
      card.dataset.status=state
      const color=dom.window.getComputedStyle(card).getPropertyValue('--status-color').trim()
      assert.match(color,/^#[\da-f]{6}$/u,state);colors.push(color)
    }
    assert.equal(new Set(colors).size,colors.length)
    assert.equal(dom.window.getComputedStyle(card.firstChild).display,'none','native hidden must win')
    assert.match(html,/id="inline-status-visual"[^>]*aria-hidden="true"/u)
    assert.match(css,/@media\(prefers-reduced-motion:reduce\)[^}]+inline-status-glyph[\s\S]+animation:none/u)
  } finally {dom.window.close()}
})
