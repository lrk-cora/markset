import { analysisProgressView } from './analysis-progress.js'

// Display only: these states never select a model, call a tool, or authorize an
// edit. The icon and color reinforce the existing truthful status text.
const busy = new Set(['preparing','planning','observe','draft','verify','repair','retry','applying'])
const icons = {
  idle: ['M4 20h4L20 8l-4-4L4 16v4Z','m14 6 4 4'],
  preparing: ['M4 7h4l2-3h4l2 3h4v13H4V7Z','M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  planning: ['m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z','M20 3v4m-2-2h4'],
  observe: ['M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z','m15 15 6 6','M7 10h6m-3-3v6'],
  draft: ['M4 20h4L20 8l-4-4L4 16v4Z','m14 6 4 4','M12 20h8'],
  verify: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z','m8 12 3 3 5-6'],
  repair: ['M14 5a6 6 0 0 0-7 8l-4 4a2.8 2.8 0 0 0 4 4l4-4a6 6 0 0 0 8-7l-4 4-5-5 4-4Z'],
  retry: ['M20 7v5h-5','M4 17v-5h5','M6 6a8 8 0 0 1 13 2l1 4','M18 18a8 8 0 0 1-13-2l-1-4'],
  applying: ['M4 12h16','m14 6 6 6-6 6','M4 5v14'],
  ready: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z','m7 12 3 3 7-7'],
  choice: ['M8 4h8v6H8V4Z','M12 10v4m-7 3 7-3 7 3','M2 17h6v4H2v-4Zm14 0h6v4h-6v-4Z'],
  input: ['M4 4h16v16H4V4Z','M8 9h8m-8 4h5','M15 15v6m-2-3h4'],
  failed: ['m12 3 10 18H2L12 3Z','M12 9v5','M12 17h.01'],
}

export function proposalStatus(group = {}, { manual = false, pending = false, issue = null, wantsContent = false, ambiguous = false } = {}) {
  const state = group.applying ? 'applying' : pending ? analysisProgressView(group.analysisProgress).stage
    : issue || group.modelError ? 'failed' : manual ? 'idle' : wantsContent ? 'input' : ambiguous ? 'choice' : 'ready'
  return { state, busy:busy.has(state), paths:icons[state] || icons.idle }
}

export function renderProposalStatus(card, visual, status, doc = document) {
  if (!card || !visual) return
  card.dataset.status = status.state
  visual.hidden = false
  visual.classList.toggle('is-busy', status.busy)
  // The elapsed clock runs every second. Do not restart an animation or replace
  // the SVG unless the actual phase changed.
  if (visual.dataset.status === status.state) return
  visual.dataset.status = status.state
  const svgNode = tag => doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg',tag) : doc.createElement(tag)
  const holder = doc.createElement('span'); holder.className='inline-status-glyph'
  const svg = svgNode('svg')
  svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor')
  svg.setAttribute('stroke-width','1.8'); svg.setAttribute('stroke-linecap','round'); svg.setAttribute('stroke-linejoin','round')
  svg.setAttribute('focusable','false')
  for (const d of status.paths) { const path=svgNode('path'); path.setAttribute('d',d); svg.append(path) }
  holder.append(svg)
  visual.replaceChildren(holder)
}
