async (page) => {
 const p=await page.context().newPage(); await p.setViewportSize({width:1000,height:760});
 const cases=[
  {name:'circle',instruction:'',ids:['title'],mark:'circle',expect:'note'},
  {name:'strike',instruction:'',ids:['copy'],mark:'strike',expect:'delete'},
  {name:'reorder',instruction:'将右边的卡片移到左边，横向排列，文字不要改',ids:['card1','card2'],mark:'arrow',expect:'reorder'},
  {name:'color',instruction:'把标题改成红色',ids:['title'],mark:'circle',expect:'color'},
  {name:'insert',instruction:'在选中的模块内部加一张科研主题配图，保留标题和说明文字',ids:['module'],mark:'box',expect:'insert'},
  {name:'edit',instruction:'仅把杯子改成蓝色，保留杯子的形状、黄色圆点和背景',ids:['picture'],mark:'circle',expect:'replace-image'},
  {name:'batch',instruction:'把这两个卡片改为纵向排列，同时将标题改成红色，其他文字不变',ids:['card1','card2','title'],mark:'arrow',expect:'batch'}
 ];
 const original = await p.evaluate(() => { const c=document.createElement('canvas');c.width=240;c.height=240;const x=c.getContext('2d');x.fillStyle='#f4efe5';x.fillRect(0,0,240,240);x.strokeStyle='#b53b35';x.lineWidth=16;x.beginPath();x.arc(166,119,34,-Math.PI/2,Math.PI/2);x.stroke();x.fillStyle='#b53b35';x.fillRect(65,65,100,122);x.fillStyle='#ead0a4';x.beginPath();x.ellipse(115,65,50,10,0,0,Math.PI*2);x.fill();x.fillStyle='#41271f';x.beginPath();x.ellipse(115,65,44,7,0,0,Math.PI*2);x.fill();x.fillStyle='#ffcf64';x.beginPath();x.arc(83,115,6,0,Math.PI*2);x.fill();x.fillStyle='#c7c0b8';x.beginPath();x.ellipse(115,196,62,7,0,0,Math.PI*2);x.fill();return c.toDataURL('image/png') });
 const html='<html><head><style>body{margin:40px;background:#f5f2ec;color:#19243b;font-family:Arial,sans-serif}section{background:white;border-radius:20px;padding:32px}h1{font-size:42px;margin:0 0 20px}p{font-size:26px}#deck{display:flex;gap:28px;margin-top:25px}article{padding:20px;border:1px solid #ced5e5;border-radius:12px;width:180px}img{width:180px;height:180px;object-fit:contain}</style></head><body><section id="module" data-markset-id="module"><h1 id="title" data-markset-id="title">科研入门：从问题到证据</h1><p id="copy" data-markset-id="copy">保留重要内容 删除冗余说明 继续学习</p><div id="deck" data-markset-id="deck"><article id="card1" data-markset-id="card1"><h2>第一步：提出问题</h2><p>界定研究范围</p></article><article id="card2" data-markset-id="card2"><h2>第二步：收集证据</h2><p>验证研究假设</p></article></div><img id="picture" data-markset-id="picture" src="'+original+'"></section></body></html>';
 const result=[];
 for(const c of cases){
  await p.setContent(html); await p.locator('#picture').evaluate(img=>img.decode());
  const targets=await p.evaluate(ids=>ids.map(id=>{
   const el=document.getElementById(id),r=el.getBoundingClientRect();
   const text=el.textContent.trim(),kind=el.tagName==='IMG'?'image':['ARTICLE','SECTION'].includes(el.tagName)?'container':'text';
   const charRects=[];if(kind==='text'&&el.firstChild?.nodeType===3){for(let i=0;i<text.length;i++){const range=document.createRange();range.setStart(el.firstChild,i);range.setEnd(el.firstChild,i+1);const b=range.getBoundingClientRect();charRects.push({index:i,char:text[i],rect:{x:b.x,y:b.y,w:b.width,h:b.height}})}}
   return{webId:id,kind,text,screenRect:{x:r.x,y:r.y,w:r.width,h:r.height},documentRect:{x:r.x,y:r.y,w:r.width,h:r.height},context:{tag:el.tagName.toLowerCase(),parentId:el.parentElement.id},charRects};
  }),c.ids);
  let pts=[];const r=targets[0].screenRect;
  if(c.mark==='strike'){ const start=targets[0].text.indexOf('冗余说明'),a=targets[0].charRects[start].rect,b=targets[0].charRects[start+3].rect;pts=[{x:a.x,y:a.y+a.h/2},{x:b.x+b.w,y:b.y+b.h/2}];targets[0].markedRanges=[{start,end:start+4,text:'冗余说明'}]; }
  else if(c.mark==='arrow'){const s=targets[1].screenRect;pts=[{x:s.x+s.w/2,y:s.y+s.h+12},{x:r.x+r.w/2,y:r.y+r.h+12},{x:r.x+r.w/2+20,y:r.y+r.h+2},{x:r.x+r.w/2,y:r.y+r.h+12},{x:r.x+r.w/2+20,y:r.y+r.h+22}];}
  else if(c.mark==='box') pts=[{x:r.x-8,y:r.y-8},{x:r.x+r.w+8,y:r.y-8},{x:r.x+r.w+8,y:r.y+r.h+8},{x:r.x-8,y:r.y+r.h+8},{x:r.x-8,y:r.y-8}];
  else {for(let i=0;i<=48;i++){const a=i*2*Math.PI/48;pts.push({x:r.x+r.w/2+(r.w/2+8)*Math.cos(a),y:r.y+r.h/2+(r.h/2+8)*Math.sin(a)})}}
  await p.evaluate(points=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('style','position:fixed;inset:0;width:100%;height:100%;pointer-events:none');const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',points.map(p=>p.x+','+p.y).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#4d78d0');line.setAttribute('stroke-width','4');svg.append(line);document.body.append(svg)},pts);
  await p.screenshot({path:`output/playwright/eval-${c.name}.png`});
  result.push({...c,html,targets,strokes:[{shape:c.mark==='strike'?'line':c.mark,points:pts}],localInterpretation:{type:'note',targets,parameters:{hasRegion:c.mark==='circle'||c.mark==='box',hasArrow:c.mark==='arrow',textStrike:c.mark==='strike',markedTextRange:c.mark==='strike'}},pageText:'科研入门，从问题到证据。两步：提出问题，收集证据。'});
 }
 await p.close(); return result;
}
