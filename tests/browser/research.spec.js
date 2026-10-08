import { test, expect } from '@playwright/test'

// All paid endpoints are intercepted. Access the same-origin sandbox through
// the parent DOM: do not inject test scripts into the script-disabled iframe.
async function prepare(page, task, condition, response) {
  const requests=[], imageRequests=[], nativeErrors=[]
  const cdp=await page.context().newCDPSession(page);await cdp.send('Log.enable')
  cdp.on('Log.entryAdded',({entry})=>{if(/Blocked script execution.*sandboxed/u.test(entry.text)) nativeErrors.push(entry.text)})
  await page.route('**/*', async route => {
    const url=new URL(route.request().url())
    if (url.hostname!=='localhost') return route.abort()
    if (url.pathname==='/api/brush-intent') {
      const payload=route.request().postDataJSON();requests.push(payload)
      return route.fulfill({json:{model:'mock-study-flash',intent:response(payload)}})
    }
    if (url.pathname.startsWith('/api/')) {if(url.pathname!=='/api/health') imageRequests.push(url.pathname);return route.abort()}
    return route.continue()
  })
  await page.goto('/');await page.locator('[data-panel-target=agent]').first().click()
  await page.locator('.research-controls > summary').click()
  await page.locator('#research-trial').fill(task);await page.locator('#btn-study-load').click()
  await expect(page.locator('#btn-brush')).toBeEnabled()
  await page.locator('#research-condition').selectOption(condition);await page.locator('#research-consent').check();await page.locator('#btn-research-start').click()
  return {requests,imageRequests,nativeErrors}
}
const node=(payload,id)=>payload.observation.nodes.find(n=>n.text===id || n.context?.tag===id)
const base={source:'model',requiresConfirmation:true,confidence:.8,rationale:'固定测试目标',strategy:'只修改指定对象',impact:{scope:'固定任务局部',riskLevel:'low'},suggestion:{text:'只将左侧标题改为蓝色。',alternatives:[]},goal:'测试目标'}
const colorPlan=payload=>{const title=node(payload,'h1');return {...base,type:'color',targets:[{...title,selected:false}],scopeExpansion:[title.webId],parameters:{color:'#2266ff'}}}
const dom=async(page,expression)=>page.evaluate(expression)
const titleColor=page=>dom(page,()=>document.querySelector('#web-doc-frame').contentDocument.querySelector('#title').style.color)
async function drawTitle(page, selector='#title', toggle=true) {
  const box=await page.frameLocator('#web-doc-frame').locator(selector).boundingBox()
  if(toggle) await page.locator('#btn-brush').click()
  for(let i=0;i<=24;i++){const t=i/24*Math.PI*2,x=box.x+box.width/2+box.width*.48*Math.cos(t),y=box.y+box.height/2+box.height*.55*Math.sin(t);await page.mouse.move(x,y);if(!i) await page.mouse.down()}
  await page.mouse.up();await expect(page.locator('#inline-proposal')).toBeVisible()
}
test('text-only is unselected, explicit Apply and undo; sidebar never replans',async({page})=>{
  const check=await prepare(page,'T6A','text-only',colorPlan)
  await page.locator('#research-text-input').fill('只将左侧标题改为蓝色 #2266ff。');await page.locator('#btn-research-text').click()
  await expect(page.locator('#btn-inline-primary')).toHaveText('修改')
  expect(check.requests).toHaveLength(1);expect(check.requests[0].strokes).toEqual([]);expect(check.requests[0].regions).toEqual([]);expect(check.requests[0].targets).toEqual([])
  expect(await titleColor(page)).toBe('')
  await page.locator('#binding-inspector > summary').click();await expect(page.locator('.binding-row').first()).toContainText('非用户选区')
  await expect(page.getByRole('button',{name:'保存纠正',exact:true}).first()).toBeDisabled();await page.locator('#binding-inspector > summary').click()
  const revision=await dom(page,async()=>{const {getBrushState}=await import('/src/brush-store.js');return getBrushState().group.revision})
  await page.locator('#btn-toggle-panel').click();await page.waitForTimeout(350)
  expect(await dom(page,async()=>{const {getBrushState}=await import('/src/brush-store.js');return getBrushState().group.revision})).toBe(revision);expect(check.requests).toHaveLength(1)
  await page.locator('#btn-inline-primary').click();await expect(page.locator('#inline-proposal')).toBeHidden()
  expect(await titleColor(page)).toBe('rgb(34, 102, 255)');await page.locator('#btn-undo').click();expect(await titleColor(page)).toBe('')
  expect(check.imageRequests).toEqual([]);expect(check.nativeErrors).toEqual([])
})
test('conventional selection sends rectangles, not artificial ink, and disables correction',async({page})=>{
  const check=await prepare(page,'T6A','selection-text',colorPlan)
  const box=await page.frameLocator('#web-doc-frame').locator('#title').boundingBox()
  await page.mouse.move(box.x-2,box.y-2);await page.mouse.down();await page.mouse.move(box.x+box.width+2,box.y+box.height+2,{steps:8});await page.mouse.up()
  await page.locator('#inline-custom-intent-input').fill('把这个标题改为蓝色 #2266ff');await page.locator('#btn-analyze-strokes').click()
  await expect(page.locator('#btn-inline-primary')).toHaveText('修改')
  expect(check.requests).toHaveLength(1);expect(check.requests[0].strokes).toEqual([]);expect(check.requests[0].regions[0].source).toBe('selection')
  expect(check.requests[0].selections[0].targetIds.length).toBeGreaterThan(0)
  await page.locator('#binding-inspector > summary').click();await expect(page.getByRole('button',{name:'保存纠正',exact:true}).first()).toBeDisabled()
  expect(await titleColor(page)).toBe('');expect(check.nativeErrors).toEqual([])
})
test('injected errors are labeled, zero-call; saving correction invalidates without reanalysis',async({page})=>{
  const check=await prepare(page,'T6A','ink-correction',colorPlan)
  await drawTitle(page);await drawTitle(page,'#other-title',false);await page.locator('#btn-study-inject').click()
  await expect(page.locator('#inline-proposal-kind'),await page.locator('#toast').textContent()).toContainText('非模型调用');expect(check.requests).toHaveLength(0)
  await page.locator('#binding-inspector > summary').click()
  const row=page.locator('.binding-row').first()
  await row.locator('select[aria-label$="的角色"]').selectOption('change');await row.getByRole('button',{name:'保存纠正',exact:true}).click()
  await expect(page.locator('#inline-proposal-kind')).toContainText('待分析')
  await page.waitForTimeout(1400);expect(check.requests).toHaveLength(0);expect(await titleColor(page)).toBe('')
  const value=await dom(page,async()=>{const {getBrushState}=await import('/src/brush-store.js');return {bindingRevision:getBrushState().group.bindingRevision,intent:getBrushState().group.inferredIntent}})
  expect(value.bindingRevision).toBe(1);expect(value.intent).toBeNull()
  expect(await dom(page,()=>JSON.parse(localStorage.getItem('markset.research-events.v1')).events.filter(e=>e.event==='error-shown'&&e.fixture).length)).toBe(1)
  await page.locator('#btn-analyze-strokes').click();await expect(page.locator('#btn-inline-primary')).toHaveText('修改')
  expect(check.requests).toHaveLength(1);expect(check.requests[0].userInstruction).toContain('右侧相似标题不变');expect(check.requests[0].bindingCorrections.revision).toBe(1)
  expect(await titleColor(page)).toBe('')
  expect(check.nativeErrors).toEqual([])
})
test('T1 uses fixed image without paid generation; placement and grouped undo remain real',async({page})=>{
  const check=await prepare(page,'T1A','text-only',payload=>{const description=node(payload,'p');return {...base,type:'insert',contentKind:'image',imagePrompt:'不要调用生图',targets:[{...description,selected:false}],scopeExpansion:[description.webId],allowedAnchorIds:[description.webId],insertion:{anchorId:description.webId,placement:'after'},suggestion:{text:'在说明后、按钮前插入固定测试图片。',alternatives:[]}}})
  await page.locator('#research-text-input').fill('保留内容，在说明后按钮前插入固定图片');await page.locator('#btn-research-text').click()
  await expect(page.locator('#btn-inline-primary')).toHaveText('修改');await page.locator('#btn-inline-primary').click();await expect(page.locator('#inline-proposal')).toBeHidden()
  expect(await dom(page,()=>{const doc=document.querySelector('#web-doc-frame').contentDocument,img=doc.querySelector('#description').nextElementSibling;return {tag:img.tagName,next:img.nextElementSibling.id,fixed:img.src.startsWith('data:image/svg+xml,')}})).toEqual({tag:'IMG',next:'action',fixed:true})
  expect(check.requests).toHaveLength(1);expect(check.requests[0].studyTaskId).toBe('T1A');expect(check.imageRequests).toEqual([])
  await page.locator('#btn-undo').click();expect(await dom(page,()=>document.querySelector('#web-doc-frame').contentDocument.querySelectorAll('img').length)).toBe(0)
  expect(check.nativeErrors).toEqual([])
})
