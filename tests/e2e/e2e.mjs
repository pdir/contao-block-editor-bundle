import { chromium, firefox, webkit } from 'playwright';
import { execFileSync } from 'node:child_process';
const B='http://127.0.0.1:8765';
const results=[]; const ok=(n,c,x='')=>{results.push([c,n,x]);console.log((c?'PASS':'FAIL'),n,x)};
const browser=await ({chromium,firefox,webkit}[process.env.BROWSER||'chromium']).launch();
async function login(u,p){const c=await browser.newContext();const pg=await c.newPage();await pg.goto(B+'/contao/login');await pg.fill('input[name=username]',u);await pg.fill('input[name=password]',p);await pg.click('button[type=submit]');await pg.waitForLoadState('networkidle');return {c,pg};}
const a=await login('admin','adminadmin123');
console.log('admin url',a.pg.url());
const pageErrors=[];const p=a.pg;p.on('pageerror',e=>pageErrors.push(e.message));p.on('console',m=>{if(['error','warning'].includes(m.type()))pageErrors.push(m.text())});
let r=await p.goto(B+'/contao/block-editor?id=2');ok('shell 200',r.status()==200,r.status());
ok('shell CSP',(r.headers()['content-security-policy']||'').includes("default-src 'none'"));
const fr=p.frameLocator('#cbe-frame');
await fr.locator('[data-be-id="10"]').waitFor({timeout:15000});
await p.waitForFunction(()=>document.getElementById('cbe-frame').contentDocument.documentElement.classList.contains('cbe-ready'),null,{timeout:10000});
ok('markers rendered',await fr.locator('[data-be-id]').count()>=3,await fr.locator('[data-be-id]').count());
const frame=p.frames().find(f=>f.url().includes('_block_editor'));console.log('frame',frame.url());
// perf: click to edit
const box=await fr.locator('[data-be-id="10"] .rte').boundingBox();
await p.mouse.click(box.x+20,box.y+8);
await fr.locator('.ProseMirror').waitFor({timeout:3000});
const dur=await frame.evaluate(()=>performance.getEntriesByName('cbe:click-to-edit').at(-1)?.duration);
ok('click-to-edit < 50ms',dur<50,dur?.toFixed(1)+' ms');
ok('focus in editor',await frame.evaluate(()=>!!getSelection().anchorNode?.parentElement?.closest('.ProseMirror')));
await p.keyboard.type('XYZ');
const [resp]=await Promise.all([p.waitForResponse(x=>x.url().includes('/api/elements/10')&&x.request().method()=='PATCH',{timeout:5000}),]);
ok('inline save 200',resp.status()==200,resp.status()+' '+(await resp.text()).slice(0,160));
await p.waitForTimeout(300);
const sql=process.env.SQL;
// inspector
ok('inspector has fields',await p.locator('#cbe-inspector .cbe-field').count()>0,await p.locator('#cbe-inspector .cbe-field').count());
// table: not inline
const before=await fr.locator('[data-be-id="12"] table').count();
await fr.locator('[data-be-id="12"]').click();await p.waitForTimeout(200);
ok('table element stays intact (no inline editor)',await fr.locator('[data-be-id="12"] table').count()==before&&before==1);
// plain headline
const hb=await fr.locator('[data-be-id="11"]').boundingBox();await p.mouse.click(hb.x+30,hb.y+hb.height/2);await p.keyboard.type('Q & <b>');
const hr=await p.waitForResponse(x=>x.url().includes('/api/elements/11')&&x.request().method()=='PATCH',{timeout:5000});
const hj=await hr.json();ok('headline: caret at click position',hr.status()==200&&!hj.values.headline.value.startsWith('Q')&&hj.values.headline.value.includes('Q'),hj.values.headline.value);await p.waitForTimeout(100);ok('headline: typed markup stays text',await fr.locator('[data-be-id="11"] b').count()==0&&(await fr.locator('[data-be-id="11"]').textContent()).includes('<b>'),await fr.locator('[data-be-id="11"]').textContent());
await p.keyboard.press('Escape');
await p.waitForTimeout(500);
// insert tags
{
  const rte=fr.locator('[data-be-id="14"] .rte');
  const patches=[];const onReq=q=>{if(q.method()=='PATCH'&&q.url().includes('/elements/14'))patches.push(q.postData())};p.on('request',onReq);
  const leave=async()=>{await p.keyboard.press('Escape')};
  ok('tag: rendered initially',(await rte.textContent()).includes('support@pdir.dev')&&!(await rte.textContent()).includes('{{'),(await rte.textContent()).trim());
  await rte.click();await fr.locator('[data-be-id="14"] .ProseMirror').waitFor();
  ok('tag: raw while editing',(await rte.textContent()).includes('{{email::support@pdir.dev}}'));
  await leave();await p.waitForTimeout(200);
  ok('tag: rendered after leaving unchanged',(await rte.textContent()).includes('support@pdir.dev')&&!(await rte.textContent()).includes('{{'),(await rte.textContent()).trim());
  ok('tag: unchanged causes no save',patches.length==0,patches.length);
  await rte.click();await fr.locator('[data-be-id="14"] .ProseMirror').waitFor();await p.keyboard.press('ControlOrMeta+a');await p.keyboard.type('Neu: {{email::neu@pdir.dev}}');
  await p.waitForTimeout(900); // the debounced save finishes while still editing
  ok('tag: stays raw while typing after autosave',(await rte.textContent()).includes('{{email::neu@pdir.dev}}'));
  await leave();await fr.locator('[data-be-id="14"] a[href^="mailto"], [data-be-id="14"] a').first().waitFor({timeout:4000}).catch(()=>{});await p.waitForTimeout(800);
  let t=await fr.locator('[data-be-id="14"] .rte').textContent();
  ok('tag: changed value rendered after leaving',t.includes('neu@pdir.dev')&&!t.includes('{{'),t.trim());
  await fr.locator('[data-be-id="14"] .rte').click();await fr.locator('[data-be-id="14"] .ProseMirror').waitFor();await p.keyboard.press('ControlOrMeta+End');await p.keyboard.type('X');await leave();await p.waitForTimeout(1200);
  t=await fr.locator('[data-be-id="14"] .rte').textContent();
  ok('tag: immediate leave saves, then renders',t.includes('neu@pdir.dev')&&t.includes('X')&&!t.includes('{{'),t.trim());
  await fr.locator('[data-be-id="14"] .rte').click();await fr.locator('[data-be-id="14"] .ProseMirror').waitFor();await p.locator('#cbe-inspector').click({position:{x:5,y:5}});await p.waitForTimeout(200);
  t=await fr.locator('[data-be-id="14"] .rte').textContent();ok('tag: rendered after clicking into the inspector',!t.includes('{{')&&t.includes('neu@pdir.dev'),t.trim());
  await fr.locator('[data-be-id="14"] .rte').click();await fr.locator('[data-be-id="14"] .ProseMirror').waitFor();await fr.locator('[data-be-id="11"]').click();await p.waitForTimeout(200);
  t=await fr.locator('[data-be-id="14"] .rte').textContent();ok('tag: rendered after clicking another element',!t.includes('{{')&&t.includes('neu@pdir.dev'),t.trim());await p.keyboard.press('Escape');
  p.off('request',onReq);
  const h=fr.locator('[data-be-id="15"]');
  ok('tag headline: rendered initially',(await h.textContent()).trim()=='Seite Start',(await h.textContent()).trim());
  await h.click();await p.waitForTimeout(100);
  ok('tag headline: raw while editing',(await h.textContent()).includes('{{page::title}}'));
  await leave();await p.waitForTimeout(200);
  ok('tag headline: rendered after leaving unchanged',(await h.textContent()).trim()=='Seite Start',(await h.textContent()).trim());
  await h.click();await p.waitForTimeout(100);await p.keyboard.press('ControlOrMeta+End');await p.keyboard.type('!');await leave();await p.waitForTimeout(1200);
  const ht=(await fr.locator('[data-be-id="15"]').textContent()).trim();
  ok('tag headline: changed rendered after leaving',ht.startsWith('Seite Start')&&!ht.includes('{{'),ht);
}
// multi-value field
{
  await fr.locator('[data-be-id="12"]').click();await p.waitForTimeout(150);
  const css=p.locator('#cbe-field-cssID');
  ok('cssID: two inputs',await p.locator('#cbe-inspector .cbe-unit:has(#cbe-field-cssID) input').count()==2);
  await css.fill('meine-id');
  await p.locator('#cbe-inspector .cbe-unit:has(#cbe-field-cssID) input').nth(1).fill('meine-klasse');
  const sr=await p.waitForResponse(x=>x.url().includes('/api/elements/12')&&x.request().method()=='PATCH',{timeout:5000});
  const sj=await sr.json();ok('cssID: both parts saved',JSON.stringify(sj.values.cssID)=='["meine-id","meine-klasse"]',JSON.stringify(sj.values.cssID));
  await p.waitForTimeout(800);
  ok('cssID: rendered',await fr.locator('[data-be-id="12"].meine-klasse#meine-id').count()==1);
  await p.locator('#cbe-field-title').fill('Titel');
  const tr=await p.waitForResponse(x=>x.url().includes('/api/elements/12')&&x.request().method()=='PATCH',{timeout:5000});
  ok('cssID: kept when another field is saved',JSON.stringify((await tr.json()).values.cssID)=='["meine-id","meine-klasse"]');
  await p.waitForTimeout(400);
  await p.locator('.cbe-title').click();await fr.locator('[data-be-id="11"]').click();await p.waitForTimeout(100);await fr.locator('[data-be-id="12"]').click();await p.waitForTimeout(150);
  ok('cssID: shown again in inspector',await css.inputValue()=='meine-id',await css.inputValue());
  await p.keyboard.press('Escape');
}
// headlines of all kinds of elements
{
  const active=()=>frame.evaluate(()=>document.activeElement?.tagName);
  const save=(id)=>p.waitForResponse(x=>x.url().includes('/api/elements/'+id)&&x.request().method()=='PATCH',{timeout:5000});
  for(const [id,label] of [[11,'headline element'],[16,'text element'],[17,'list element'],[18,'text with table']]){
    const h=id==11?fr.locator('[data-be-id="11"]'):fr.locator(`[data-be-id="${id}"] > :is(h1,h2,h3,h4,h5,h6)`);
    await h.click({position:{x:3,y:5}});await p.waitForTimeout(60);
    const focus=await active();
    const editable=await h.getAttribute('contenteditable');
    ok(`headline ${label}: caret`,/^H[1-6]$/.test(focus)&&!!editable,focus+' '+editable);
    const w=save(id);await p.keyboard.type('Z');const j=await (await w).json();
    ok(`headline ${label}: saved`,j.values.headline.value.includes('Z'),j.values.headline.value);
    if(id==16){await p.locator('#cbe-field-headline').waitFor();ok('headline: inspector follows typing',(await p.locator('#cbe-field-headline').inputValue()).includes('Z'));}
    await p.keyboard.press('Escape');await p.waitForTimeout(100);
  }
  await fr.locator('[data-be-id="16"] .rte').click();await fr.locator('[data-be-id="16"] .ProseMirror').waitFor();
  ok('text body still rich',await frame.evaluate(()=>!!getSelection().anchorNode?.parentElement?.closest('.ProseMirror')));
  await fr.locator('[data-be-id="16"] > h3').click();await p.waitForTimeout(60);
  ok('switch body → headline in one element',await active()=='H3'&&await fr.locator('[data-be-id="16"] .ProseMirror').count()==0);
  await p.keyboard.press('Escape');
  await fr.locator('[data-be-id="16"]').click({position:{x:3,y:3}}).catch(()=>{});await p.keyboard.press('Escape');
  await fr.locator('[data-be-id="16"] > h3').click();await p.waitForTimeout(60);
  await p.locator('.cbe-title').click(); // leaves the field, as any real click into the shell does
  const w=save(16);await p.locator('#cbe-inspector .cbe-unit:has(#cbe-field-headline) select').selectOption('h4');await w;await p.waitForTimeout(900);
  ok('inspector: changing the level re-renders',await fr.locator('[data-be-id="16"] > h4').count()==1&&(await fr.locator('[data-be-id="16"] > h4').textContent()).includes('Z'));
}
// API attack helper
const token=await p.locator('#cbe-app').getAttribute('data-token');
const call=(pg,id,body,h={})=>pg.evaluate(async([id,body,h])=>{const x=await fetch('/contao/block-editor/api/elements/'+id,{method:'PATCH',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(body)});return{s:x.status,b:await x.text()}},[id,body,h]);
const rev=async(pg,id)=>pg.evaluate(async id=>{const x=await fetch('/contao/block-editor/api/elements?ids='+id);const j=await x.json();return j.elements[id]},id);
let el=await rev(p,10);console.log('el10',JSON.stringify(el).slice(0,300));
const H={'X-Block-Editor-Token':token};
let x=await call(p,10,{revision:el.revision,values:{text:'<p>a</p>'}});ok('no token → 403',x.s==403,x.s);
x=await call(p,10,{revision:'stale',values:{text:'<p>a</p>'}},H);ok('stale revision → 409',x.s==409,x.s);
x=await call(p,10,{revision:el.revision,values:{type:'html'}},H);ok('change type → 403',x.s==403,x.s);
x=await call(p,10,{revision:el.revision,values:{ptable:'tl_x',pid:99}},H);ok('change pid/ptable → 403',x.s==403,x.s);
x=await call(p,10,{revision:el.revision,values:{unfilteredHtml:'<script>1</script>'}},H);ok('foreign-palette field → 403',x.s==403,x.s);
x=await call(p,10,{revision:el.revision,values:{'text` = 1 #':'x'}},H);ok('SQL-ish field name → 403',x.s==403,x.s);
const evil='<p onclick="alert(1)">a<script>alert(2)</script><img src=x onerror=alert(3)><a href="javascript:alert(4)">l</a><a href="java&#115;cript:alert(5)">m</a><iframe src=//e></iframe></p>';
x=await call(p,10,{revision:el.revision,values:{text:evil}},H);let saved="";try{saved=JSON.parse(x.b).values?.text||""}catch{};
const safe=await p.evaluate(h=>{const d=new DOMParser().parseFromString(h,'text/html');if(d.querySelector('script,iframe,object,embed,style'))return false;for(const n of d.querySelectorAll('*'))for(const a of n.attributes){if(a.name.startsWith('on'))return false;if(['href','src'].includes(a.name)&&/^\s*(javascript|data|vbscript):/i.test(a.value))return false}return true},saved);ok('XSS payload sanitized',x.s==200&&safe,x.s+' '+saved);
el=await rev(p,10);x=await call(p,10,{revision:el.revision,values:{text:''}},H);ok('mandatory enforced → 422',x.s==422,x.s+' '+x.b.slice(0,120));
el=await rev(p,10);x=await call(p,10,{revision:el.revision,values:{text:['a']}},H);ok('array for scalar → 400',x.s==400,x.s);
x=await call(p,10,{revision:el.revision,values:{cssID:'nur-string'}},H);ok('string for multi-value → 400',x.s==400,x.s);
// cross-origin simple form-post
x=await p.evaluate(async()=>{const r=await fetch('/contao/block-editor/api/elements/10',{method:'PATCH',headers:{'Content-Type':'text/plain'},body:'{}'});return{s:r.status}});ok('text/plain → 415/403',[403,415].includes(x.s),x.s);
// versions
// assets are versioned, so that shell and frame can never be mixed from the browser cache
{
  const urls=await frame.evaluate(()=>[...document.querySelectorAll('script[src*="contaoblockeditor"],link[href*="contaoblockeditor"]')].map(n=>n.src||n.href));
  ok('frame assets versioned by content',urls.length==2&&urls.every(u=>/\?v=[0-9a-f]{32}$/.test(u)),urls.join(' '));
  const shellUrls=await p.evaluate(()=>[...document.querySelectorAll('script[src*="contaoblockeditor"],link[href*="contaoblockeditor"]')].map(n=>n.src||n.href));
  ok('shell assets versioned by content',shellUrls.length>=3&&shellUrls.every(u=>/\?v=[0-9a-f]{32}$/.test(u)),shellUrls.length);
  // missing data (e.g. a mismatch of shell and frame) must not empty the content
  const rte=fr.locator('[data-be-id="16"] .rte');const before=await rte.textContent();
  await p.evaluate(()=>{const w=document.getElementById('cbe-frame').contentWindow;w.postMessage({type:'cbe:elements',elements:[{id:16,inline:[{field:'text',selector:'.rte',mode:'rich'}],values:{}}]},location.origin)});
  await p.waitForTimeout(100);await rte.click();await p.waitForTimeout(100);
  ok('missing data keeps the content',(await rte.textContent())==before&&before.trim()!=''&&await fr.locator('[data-be-id="16"] .ProseMirror').count()==0,before.trim());
  await p.keyboard.press('Escape');
}
// visitor
const v=await browser.newContext();const vp=await v.newPage();
let vr=await vp.goto(B+'/index.html?_block_editor=1');let html=await vr.text();ok('visitor: no marker',vr.status()==200&&!html.includes('data-be-id')&&!html.includes('frame.js'),vr.status());
vr=await vp.goto(B+'/preview.php/index.html?_block_editor=1');html=await vr.text();ok('visitor on preview: no marker',!html.includes('data-be-id'),vr.status()+' '+vp.url());
x=await vp.request.get(B+'/contao/block-editor/api/elements?ids=10',{maxRedirects:0});ok('anon API read blocked',![200].includes(x.status()),x.status());
x=await vp.request.patch(B+'/contao/block-editor/api/elements/10',{data:{},maxRedirects:0});ok('anon API write blocked',x.status()!=200,x.status());
vr=await p.goto(B+'/index.html');html=await vr.text();ok('admin on live site: no marker',!html.includes('data-be-id'));ok('live page renders typed markup escaped',/content-headline[^>]*>[^<]*<\/h2>/.test(html),(html.match(/content-headline[^\n]*/)||[''])[0].slice(0,90));
// restricted
const e=await login('editor','editoreditor123');console.log('editor url',e.pg.url());
r=await e.pg.goto(B+'/contao/block-editor?id=3');ok('editor: foreign page denied',[403,401].includes(r.status())||!(await r.text()).includes('cbe-frame'),r.status());
r=await e.pg.goto(B+'/contao/block-editor?id=2');ok('editor: own page ok',r.status()==200,r.status());
const et=await e.pg.locator('#cbe-app').getAttribute('data-token');const EH={'X-Block-Editor-Token':et};
let d=await e.pg.evaluate(async()=>(await fetch('/contao/block-editor/api/elements?ids=10,11,13,20')).json());
const ks=Object.keys(d.elements);console.log('editor sees',ks,'fields of 10:',Object.keys(d.elements[10]?.values||{}));
ok('editor: foreign element hidden',!ks.includes('20'));
ok('editor: forbidden type html not editable',!d.elements[13]?.editable,JSON.stringify(d.elements[13]?.editable));
ok('editor: only allowed fields',Object.keys(d.elements[10]?.values||{}).every(f=>['text','headline','type'].includes(f)),Object.keys(d.elements[10]?.values||{}).join());
x=await call(e.pg,10,{revision:d.elements[10].revision,values:{cssID:['x','y']}},EH);ok('editor: excluded field → 403',x.s==403,x.s);
x=await call(e.pg,20,{revision:'x',values:{text:'<p>h</p>'}},EH);ok('editor: foreign element → 404',x.s==404,x.s+x.b.slice(0,80));
x=await call(e.pg,10,{revision:d.elements[10].revision,values:{text:'<p>Editor</p>'}},EH);ok('editor: allowed edit → 200',x.s==200,x.s+' '+x.b.slice(0,200));
const sch=await e.pg.evaluate(async()=>{const a=await fetch('/contao/block-editor/api/schema?types=text');return{s:a.status,cc:a.headers.get('cache-control'),e:a.headers.get('etag')}});ok('schema private+etag',sch.cc?.includes('private')&&!!sch.e,JSON.stringify(sch));
// A save must only change the sent field, also with extensions installed (optional: needs database access)
if(process.env.E2E_DB_CONTAINER){
const row=()=>{const o=execFileSync('docker',['exec',process.env.E2E_DB_CONTAINER,'mariadb','-uroot','-pe2e','contao','-e','SELECT * FROM tl_content WHERE id=10']).toString().split('\n');const k=o[0].split('\t'),v=o[1].split('\t');return Object.fromEntries(k.map((c,i)=>[c,v[i]]))};
await p.goto(B+'/contao/block-editor?id=2');
const at=await p.locator('#cbe-app').getAttribute('data-token');
const de=await p.evaluate(async()=>(await fetch('/contao/block-editor/api/elements?ids=10')).json());
const r0=row();const sr=await call(p,10,{revision:de.elements[10].revision,values:{text:'<p>Nur Text</p>'}},{'X-Block-Editor-Token':at});const r1=row();
const diff=Object.keys(r1).filter(c=>r0[c]!==r1[c]&&!['tstamp','text'].includes(c));
ok('save changes only the sent field',sr.s==200&&diff.length==0,sr.s+' '+diff.join());
}
// Help for editors
await p.goto(B+'/contao/block-editor?id=2');
await p.locator('.cbe-help').waitFor();ok('help shown without selection',await p.locator('#cbe-inspector .cbe-help dt').count()>=5);
await p.frameLocator('#cbe-frame').locator('[data-be-id="10"]').waitFor();await p.waitForFunction(()=>document.getElementById('cbe-frame').contentDocument.documentElement.classList.contains('cbe-ready'));
const hb0=await p.frameLocator('#cbe-frame').locator('[data-be-id="10"] .rte').boundingBox();await p.mouse.click(hb0.x+20,hb0.y+8);await p.waitForTimeout(200);
ok('help hidden with selection',await p.locator('.cbe-help').count()==0);
await p.keyboard.press('Escape');await p.waitForTimeout(200);ok('help back after deselecting',await p.locator('.cbe-help').count()==1);
// Moving elements
{
await p.goto(B+'/contao/block-editor?id=2');
const fm=p.frameLocator('#cbe-frame');await fm.locator('[data-be-id="10"]').waitFor();
await p.waitForFunction(()=>document.getElementById('cbe-frame').contentDocument.documentElement.classList.contains('cbe-ready'));
const fo=p.frames().find(f=>f.url().includes('_block_editor'));
const order=()=>fo.evaluate(()=>[...document.querySelectorAll('[data-be-id]')].map(e=>+e.dataset.beId));
const at=await p.locator('#cbe-app').getAttribute('data-token');
const mv=(pg,id,body,h={'X-Block-Editor-Token':at})=>pg.evaluate(async([id,body,h])=>{const r=await fetch(`/contao/block-editor/api/elements/${id}/position`,{method:'PATCH',headers:{'Content-Type':'application/json',...h},body:JSON.stringify(body)});return{s:r.status,b:await r.text()}},[id,body,h]);
const rev=async(pg,id)=>(await pg.evaluate(async id=>(await fetch('/contao/block-editor/api/elements?ids='+id)).json(),id)).elements[id]?.revision;
const moved=()=>p.waitForResponse(x=>x.url().endsWith('/position'));
// drag with the handle
await fm.locator('[data-be-id="10"]').hover();
const hb=await fm.locator('.cbe-handle').boundingBox();ok('handle shown',!!hb);
const t=await fm.locator('[data-be-id="11"]').boundingBox();
let w=moved();
await p.mouse.move(hb.x+13,hb.y+13);await p.mouse.down();await p.mouse.move(t.x+40,t.y+t.height/2+1,{steps:4});await p.mouse.move(t.x+40,t.y+t.height-1,{steps:4});await p.mouse.up();
let rm=await w;const o1=await order();
ok('drag: request ok',rm.status()==200,rm.status());
ok('drag: order in page',o1.indexOf(10)==o1.indexOf(11)+1,o1.join());
await p.waitForTimeout(200);await p.reload();await fm.locator('[data-be-id="10"]').waitFor();
await p.waitForFunction(()=>document.getElementById('cbe-frame').contentDocument.documentElement.classList.contains('cbe-ready'));
const fo2=p.frames().find(f=>f.url().includes('_block_editor'));const order2=()=>fo2.evaluate(()=>[...document.querySelectorAll('[data-be-id]')].map(e=>+e.dataset.beId));
const o2=await order2();ok('drag: persisted after reload',o2.join()==o1.join(),o2.join());
// keyboard
await fm.locator('[data-be-id="10"]').focus();w=moved();await p.keyboard.press('Alt+ArrowUp');rm=await w;const o3=await order2();
ok('keyboard: moved up',rm.status()==200&&o3.indexOf(10)==o3.indexOf(11)-1,o3.join());
ok('keyboard: focus kept',await fo2.evaluate(()=>document.activeElement?.dataset.beId)=='10');
await p.waitForTimeout(100);
// failed move puts it back
await p.route('**/position',r=>r.fulfill({status:409,contentType:'application/json',body:'{"error":"Konflikt"}'}));
await p.keyboard.press('Alt+ArrowDown');await p.waitForTimeout(300);await p.unroute('**/position');
ok('failed move: restored',(await order2()).join()==o3.join(),(await order2()).join());
ok('failed move: message',(await p.locator('#cbe-status').innerText())=='Konflikt');
// editing after a move still has a valid revision
const bx=await fm.locator('[data-be-id="10"] .rte').boundingBox();await p.mouse.click(bx.x+20,bx.y+8);await fm.locator('.ProseMirror').waitFor();await p.keyboard.type('M');
const se=await p.waitForResponse(x=>x.url().endsWith('/api/elements/10')&&x.request().method()=='PATCH');ok('save after move',se.status()==200,se.status());
await p.keyboard.press('Escape');await p.waitForTimeout(800);
// API checks
let m=await mv(p,10,{revision:await rev(p,10),target:11,position:'inside'});ok('move: bad position → 400',m.s==400,m.s);
m=await mv(p,10,{revision:await rev(p,10),target:'11',position:'after'});ok('move: bad target → 400',m.s==400,m.s);
m=await mv(p,10,{revision:await rev(p,10),target:10,position:'after'});ok('move: onto itself → 422',m.s==422,m.s);
m=await mv(p,10,{revision:'x',target:12,position:'after'});ok('move: old revision → 409',m.s==409,m.s);
m=await mv(p,10,{revision:await rev(p,10),target:999999,position:'after'});ok('move: unknown target → 404',m.s==404,m.s);
m=await mv(p,10,{revision:await rev(p,10),target:12,position:'after'},{});ok('move: no token → 403',m.s==403,m.s);
m=await mv(p,10,{revision:await rev(p,10),target:20,position:'after'});ok('move: other article ok',m.s==200,m.s+m.b.slice(0,120));
m=await mv(p,10,{revision:await rev(p,10),target:12,position:'before'});ok('move: and back',m.s==200,m.s);
// editor without access to the other page
const eh={'X-Block-Editor-Token':await e.pg.locator('#cbe-app').getAttribute('data-token')};
m=await mv(e.pg,10,{revision:await rev(e.pg,10),target:20,position:'after'},eh);ok('editor: move to foreign page → 404',m.s==404,m.s);
m=await mv(e.pg,20,{revision:'x',target:10,position:'after'},eh);ok('editor: move foreign element → 404',m.s==404,m.s);
m=await mv(e.pg,10,{revision:await rev(e.pg,10),target:12,position:'after'},eh);ok('editor: move on own page ok',m.s==200,m.s);
if(process.env.E2E_DB_CONTAINER){
const q=x=>execFileSync('docker',['exec',process.env.E2E_DB_CONTAINER,'mariadb','-uroot','-pe2e','contao','-N','-e',x]).toString().trim();
// no gap left: all siblings get new numbers and report their revisions
q('UPDATE tl_content SET sorting=id-9 WHERE pid=1');
m=await mv(p,12,{revision:await rev(p,12),target:10,position:'before'});const j=JSON.parse(m.b);
ok('renumber: revisions of siblings',m.s==200&&Object.keys(j.revisions).length>2,m.s+' '+Object.keys(j.revisions||{}).join());
ok('renumber: order',q("SELECT GROUP_CONCAT(id ORDER BY sorting) FROM tl_content WHERE pid=1 AND id IN (10,11,12)").startsWith('12,10'));
const before=q('SELECT sorting,tstamp FROM tl_content WHERE id=12');
m=await mv(p,12,{revision:await rev(p,12),target:10,position:'before'});ok('no-op move changes nothing',m.s==200&&q('SELECT sorting,tstamp FROM tl_content WHERE id=12')==before,m.s);
// an element can't end up inside of itself
q(`INSERT INTO tl_content (id,pid,ptable,sorting,tstamp,type,headline,cssID) VALUES (30,1,'tl_article',9000,1,'element_group','',''),(31,30,'tl_content',128,1,'headline','a:2:{s:5:"value";s:1:"x";s:4:"unit";s:2:"h2";}','')`);
m=await mv(p,30,{revision:await rev(p,30),target:31,position:'after'});ok('move into itself → 422',m.s==422,m.s+m.b.slice(0,120));
q('DELETE FROM tl_content WHERE id IN (30,31)');
}
}
// navigating through the website
{
const fl=p.frameLocator('#cbe-frame');
const shown=id=>p.waitForFunction(i=>{const d=document.getElementById('cbe-frame').contentDocument;return d?.documentElement?.classList.contains('cbe-ready')&&d.querySelector(`[data-be-id="${i}"]`)},id,{timeout:10000});
const addLink=(pg,href)=>pg.evaluate(h=>{const d=document.getElementById('cbe-frame').contentDocument,a=d.createElement('a');a.id='cbe-test-link';a.href=h;a.textContent='Testlink';a.style.cssText='position:fixed;top:40%;left:40%;z-index:9999;background:#fff';d.body.append(a)},href);
const open=async pg=>{await pg.goto(B+'/contao/block-editor?id=2');await pg.frameLocator('#cbe-frame').locator('nav a').first().waitFor({timeout:10000});await pg.waitForFunction(()=>document.getElementById('cbe-frame').contentDocument?.documentElement?.classList.contains('cbe-ready')||document.getElementById('cbe-status').textContent)};
await open(p);await shown(10);
const secret=fl.locator('nav a',{hasText:'Geheim'});
console.log('nav href',await secret.getAttribute('href'));
const b10=await fl.locator('[data-be-id="10"] .rte').boundingBox();await p.mouse.click(b10.x+20,b10.y+8);await fl.locator('.ProseMirror').waitFor();await p.keyboard.type('NAV');
await secret.click();await shown(20);
ok('nav: page shown in frame',await fl.locator('[data-be-id="20"]').count()==1);
ok('nav: address follows',new URL(p.url()).searchParams.get('id')=='3',p.url());
ok('nav: title follows',(await p.locator('#cbe-title').textContent()).includes('Geheim')&&(await p.title()).includes('Geheim'),await p.title());
ok('nav: frame keeps marker',(await p.evaluate(()=>document.getElementById('cbe-frame').contentWindow.location.href)).includes('_block_editor=1'));
const saved=await p.evaluate(async a=>(await(await fetch(a+'?ids=10')).json()).elements[10].values.text,await p.locator('#cbe-app').getAttribute('data-api'));
ok('nav: typed text saved before leaving',saved.includes('NAV'),saved);
const b20=await fl.locator('[data-be-id="20"]').boundingBox();await p.mouse.click(b20.x+20,b20.y+8);
await p.locator('#cbe-inspector .cbe-field').first().waitFor({timeout:3000});ok('nav: new page is editable',await fl.locator('[data-be-id="20"] .ProseMirror').count()==1);
await p.keyboard.press('Escape');
await p.goBack();await shown(10);ok('nav: back',new URL(p.url()).searchParams.get('id')=='2'&&await fl.locator('[data-be-id="20"]').count()==0,p.url());
ok('nav: back resets inspector',await p.locator('#cbe-inspector .cbe-field').count()==0);
await p.goForward();await shown(20);ok('nav: forward',new URL(p.url()).searchParams.get('id')=='3',p.url());
await p.reload();await shown(20);ok('nav: reload stays on the page',await fl.locator('[data-be-id="20"]').count()==1);
await open(p);await shown(10);
// Contao shows no link to a forward page that points to the current page
await fl.locator('nav a',{hasText:'Geheim'}).click();await shown(20);
await fl.locator('nav a',{hasText:'Weiter'}).click();await shown(10);
ok('nav: forward page keeps editor',(await p.evaluate(()=>document.getElementById('cbe-frame').contentWindow.location.href)).includes('_block_editor=1'),await p.evaluate(()=>document.getElementById('cbe-frame').contentWindow.location.href));
// an anchor does not reload
await addLink(p,'#part');await fl.locator('#cbe-test-link').click();await p.waitForTimeout(400);
ok('nav: anchor stays on the page',await fl.locator('#cbe-test-link').count()==1);
// external links and files get their own tab
await p.evaluate(()=>document.getElementById('cbe-frame').contentDocument.getElementById('cbe-test-link').remove());
await addLink(p,'https://example.com/');const [ext]=await Promise.all([p.context().waitForEvent('page'),fl.locator('#cbe-test-link').click()]);
ok('nav: external opens a tab',ext.url().includes('example.com')||ext.url()=='about:blank',ext.url());await ext.close();
ok('nav: external leaves frame alone',await fl.locator('#cbe-test-link').count()==1);
await p.evaluate(()=>document.getElementById('cbe-frame').contentDocument.getElementById('cbe-test-link').remove());
// the back end does not belong into the frame
await addLink(p,'/contao/login');await fl.locator('#cbe-test-link').click();await p.waitForTimeout(400);
ok('nav: back end refused',await fl.locator('#cbe-test-link').count()==1&&(await p.locator('#cbe-status').textContent()).includes('nicht geöffnet'),await p.locator('#cbe-status').textContent());
await p.evaluate(()=>document.getElementById('cbe-frame').contentDocument.getElementById('cbe-test-link').remove());
// error pages have no editor, but there is a way back
await addLink(p,'/gibts-nicht.html');await fl.locator('#cbe-test-link').click();
await p.locator('#cbe-back').waitFor({timeout:10000});ok('nav: error page explained',(await p.locator('#cbe-status').textContent()).includes('nicht angezeigt'),await p.locator('#cbe-status').textContent());
await p.locator('#cbe-back').click();await shown(10);ok('nav: back from error page',await p.locator('#cbe-back').isHidden()&&!(await p.locator('#cbe-status').getAttribute('class')).includes('is-error'));
// a failed save keeps the user on the page
await open(p);await shown(10);
await p.route('**/api/elements/10',r=>r.request().method()=='PATCH'?r.fulfill({status:409,contentType:'application/json',body:'{"error":"Konflikt"}'}):r.continue());
const b=await fl.locator('[data-be-id="10"] .rte').boundingBox();await p.mouse.click(b.x+20,b.y+8);await fl.locator('.ProseMirror').waitFor();await p.keyboard.type('LOST');
await fl.locator('nav a',{hasText:'Geheim'}).click();await p.waitForTimeout(1000);
ok('nav: failed save stays on page',await fl.locator('[data-be-id="10"]').count()==1&&new URL(p.url()).searchParams.get('id')=='2'&&(await p.locator('#cbe-status').textContent()).includes('Konflikt'),await p.locator('#cbe-status').textContent());
await p.unroute('**/api/elements/10');
// without rights to the other page
await open(e.pg);await e.pg.waitForTimeout(500);
await e.pg.frameLocator('#cbe-frame').locator('nav a',{hasText:'Geheim'}).click();await e.pg.frameLocator('#cbe-frame').locator('[data-be-id="20"]').waitFor({timeout:10000});
await e.pg.waitForFunction(()=>document.getElementById('cbe-status').textContent.includes('Nur Ansicht'),null,{timeout:5000}).catch(()=>{});
ok('nav: editor sees read-only hint',(await e.pg.locator('#cbe-status').textContent()).includes('Nur Ansicht'),await e.pg.locator('#cbe-status').textContent());
ok('nav: editor address stays editable',new URL(e.pg.url()).searchParams.get('id')=='2',e.pg.url());
const be=await e.pg.frameLocator('#cbe-frame').locator('[data-be-id="20"]').boundingBox();await e.pg.mouse.click(be.x+20,be.y+8);await e.pg.waitForTimeout(300);
ok('nav: editor cannot edit there',await e.pg.frameLocator('#cbe-frame').locator('.ProseMirror').count()==0);
}
console.log('browser errors:',pageErrors);
await browser.close();
const f=results.filter(r=>!r[0]).length;console.log(`\n${results.length-f}/${results.length} passed`);
