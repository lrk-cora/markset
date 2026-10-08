import test from 'node:test'
import assert from 'node:assert/strict'
import { researchPolicy,researchPlanningPayload,flatResearchObservation,rectanglePoints } from '../src/research-conditions.js'
import { buildBrushRegions,planningRegionEvidence } from '../src/brush-regions.js'
import { reflowBrushGroup,anchorBrushStroke } from '../src/brush-layout.js'
import { createResearchLog } from '../src/research-log.js'
import { analyzeResearchLog } from '../scripts/analyze-research-log.mjs'
import { inspectionRegions,inspectBindings } from '../src/binding-corrections.js'
test('input conditions actually remove ink/selection evidence, not merely rename buttons',()=>{
  const body={strokes:[{id:'ink'}],regions:[{id:'region'}],targets:[{webId:'a',selected:true},{webId:'b',selected:false}],preferences:['private habit']}
  const text=researchPlanningPayload(body,'text-only')
  assert.deepEqual(text.strokes,[]);assert.deepEqual(text.regions,[]);assert.deepEqual(text.targets,[body.targets[1]])
  assert.deepEqual(text.preferences,[]);assert.equal(text.behaviorMemory,null)
  assert.deepEqual(researchPlanningPayload(body,'selection-text').strokes,[])
  assert.equal(researchPolicy('ink-flat-evidence').correction,false)
  assert.equal(researchPolicy(null).correction,true)
})
test('text-only has read-only plan inspection without inventing input regions',()=>{
  const group={inputModality:'text',inferredIntent:{type:'replace',targets:[{webId:'a'}],targetRanges:[{targetId:'a',start:1,end:3}]}}
  const regions=inspectionRegions(group,[]),view=inspectBindings(group,regions,[{webId:'a',text:'ABCDE'}])
  assert.equal(regions[0].source,'plan-inspection');assert.equal(view[0].planRanges[0].text,'BC')
  assert.deepEqual(buildBrushRegions({...group,targets:[],strokes:[]}),[])
})
test('flat evidence strips enriched hierarchy/endpoints without mutating the safety observation',()=>{
  const source={nodes:[{webId:'a',moduleId:'m',context:{tag:'p',parentId:'m'},children:['b'],text:'visible text',styles:{color:'red'}}],modules:[{webId:'m'}],strokeEndpoints:[{id:'ink'}]}
  const flat=flatResearchObservation(source)
  assert.equal(flat.nodes[0].context.parentId,undefined);assert.equal(flat.nodes[0].children,undefined)
  assert.deepEqual(flat.modules,[]);assert.equal(flat.nodes[0].text,'visible text');assert.equal(source.nodes[0].context.parentId,'m')
})
test('rectangles keep their own numbered blank/target regions without artificial brush strokes',()=>{
  const points=rectanglePoints({x:300,y:150},{x:400,y:250})
  const group={inputModality:'selection',selections:[{id:'box1',points,targetIds:[]}],strokes:[],targets:[]}
  const regions=buildBrushRegions(group)
  assert.equal(regions[0].kind,'blank');assert.equal(regions[0].source,'selection')
  assert.equal(planningRegionEvidence(regions,[],[],group.selections).length,1)
  assert.equal(planningRegionEvidence(regions,[],[],[]).length,0)
  assert.equal(planningRegionEvidence([{...regions[0],rect:{...regions[0].rect,x:0}}],[],[],group.selections).length,0)
})
test('selection reflow preserves semantic revision and original points',()=>{
  const original={x:0,y:0,w:400,h:200}
  const selection=anchorBrushStroke({id:'box1',points:rectanglePoints({x:100,y:30},{x:150,y:100})},{kind:'module'},original)
  const group={revision:4,inputModality:'selection',coordinateSpace:'web-document',strokes:[],selections:[selection],targets:[],modelPending:true}
  const moved=reflowBrushGroup(group,()=>({...original,w:200}),t=>t)
  assert.equal(moved.revision,4);assert.equal(moved.selections[0].points[0].x,50);assert.equal(selection.points[0].x,100)
})
test('scoring, error onset and text counts are metadata only; apply does not invent correctness',()=>{
  let at=100
  const log=createResearchLog({storage:null,now:()=>at++,sessionId:()=> 's'})
  assert.equal(log.start({consent:true,condition:'text-only'}).ok,true)
  log.record('input');log.record('error-shown');log.record('text-submit',{inputChars:20,supplement:true,text:'private'})
  log.record('apply',{success:true});log.record('outcome-score',{rater:'R01',goalMet:false,preserved:true,placementCorrect:false,noOverflow:true,burden:5,control:3})
  const report=analyzeResearchLog(log.snapshot())
  assert.equal(report.trials[0].goalMet,false);assert.equal(report.trials[0].textSupplements,1);assert.equal(report.trials[0].errorToApplyMs,2)
  assert.equal(report.outcomeAccuracy,null);assert.equal(JSON.stringify(log.snapshot()).includes('private'),false)
  log.record('request-dispatched',{imageCount:2})
  log.record('analysis-end',{evidenceChars:80,imageCount:2,readToolCalls:1,text:'secret'})
  const metrics=analyzeResearchLog(log.snapshot()).trials[0]
  assert.equal(metrics.requestDispatches,1);assert.equal(metrics.medianEvidenceChars,80);assert.equal(metrics.readToolCalls,1)
  assert.equal(JSON.stringify(log.snapshot()).includes('secret'),false)
})
