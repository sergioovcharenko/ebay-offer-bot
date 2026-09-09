import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PORT=Number(process.env.PORT||3000);
const PROVIDER=process.env.EBAY_PROVIDER||'fake';
const DRY_RUN=(process.env.GLOBAL_DRY_RUN??'true')!=='false';
const SCHEDULE=Math.max(15,Number(process.env.SCHEDULE_MINUTES||30));
const DATA=process.env.DATA_FILE||'./data.json';
const EBAY_CLIENT_ID=process.env.EBAY_CLIENT_ID||'';
const EBAY_CLIENT_SECRET=process.env.EBAY_CLIENT_SECRET||'';
let tokenCache={token:null,expires:0};

function load(){
  if(existsSync(DATA)) try{return JSON.parse(readFileSync(DATA,'utf8'));}catch{}
  return {rules:[],offers:[],history:[],seen:[],settings:{notifyEnabled:true,notifyServer:'https://ntfy.sh',notifyTopic:'ebay-offer-'+randomUUID().replaceAll('-','')}};
}
let db=load();
function save(){writeFileSync(DATA,JSON.stringify(db,null,2));}
function log(type,message,meta={}){db.history.unshift({id:randomUUID(),type,message,meta,at:new Date().toISOString()});db.history=db.history.slice(0,500);save();}
const round=n=>Math.round((Number(n)+Number.EPSILON)*100)/100;
const txt=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[×xX]/g,'x').replace(/\s+/g,' ').trim();
function arr(v){return Array.isArray(v)?v.map(String).map(s=>s.trim()).filter(Boolean):String(v||'').split(',').map(s=>s.trim()).filter(Boolean);}
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>1e6)throw new Error('Body too large');}return s?JSON.parse(s):{};}

function validateRule(x){
  const searchKeywords=String(x.searchKeywords||'').trim();
  if(!searchKeywords)throw new Error('Ключові слова обов’язкові');
  const productName=String(x.productName||searchKeywords).trim();
  const name=String(x.name||searchKeywords).trim();
  const offerMode=x.offerMode==='percentage'?'percentage':'fixed';
  const maxListingPrice=Number(x.maxListingPrice); const maxOfferAmount=Number(x.maxOfferAmount); const offerStepAmount=Number(x.offerStepAmount||1);
  if(!(maxListingPrice>0)||!(maxOfferAmount>0)||!(offerStepAmount>0)) throw new Error('Ціни та крок мають бути більше 0');
  let discountPercent, fixedOfferAmount;
  if(offerMode==='percentage'){discountPercent=Number(x.discountPercent);if(!(discountPercent>0&&discountPercent<100))throw new Error('Знижка має бути 1–99%');}
  else {fixedOfferAmount=Number(x.fixedOfferAmount);if(!(fixedOfferAmount>0))throw new Error('Початкова пропозиція має бути більше 0');}
  return {id:x.id||randomUUID(),name,productName,searchKeywords,requiredKeywords:arr(x.requiredKeywords),excludedKeywords:arr(x.excludedKeywords),sizeVariant:String(x.sizeVariant||'').trim(),condition:String(x.condition||'ANY'),maxListingPrice,requireBestOffer:x.requireBestOffer!==false,offerMode,discountPercent,fixedOfferAmount,offerStepAmount,maxOfferAmount,enabled:x.enabled!==false,createdAt:x.createdAt||new Date().toISOString()};
}
function initialOffer(r,price){const a=r.offerMode==='percentage'?price*(1-r.discountPercent/100):r.fixedOfferAmount;return round(Math.min(a,r.maxOfferAmount));}
function nextOffer(r,current){if(current>=r.maxOfferAmount)return null;return round(Math.min(current+r.offerStepAmount,r.maxOfferAmount));}
function matches(r,l){
  const t=txt(l.title);
  for(const w of txt(r.searchKeywords).split(' ').filter(Boolean)) if(!t.includes(w)) return false;
  for(const w of r.requiredKeywords) if(!t.includes(txt(w))) return false;
  for(const w of r.excludedKeywords) if(t.includes(txt(w))) return false;
  if(r.sizeVariant&&!t.includes(txt(r.sizeVariant).replace(/\s*x\s*/g,'x'))) return false;
  if(r.condition!=='ANY'&&l.condition!==r.condition)return false;
  if(r.requireBestOffer&&!l.buyingOptions.includes('BEST_OFFER'))return false;
  if(l.price>r.maxListingPrice)return false;
  return true;
}
async function notify(title,message,click){
  const s=db.settings;if(!s.notifyEnabled||!s.notifyTopic)return;
  try{await fetch(`${s.notifyServer.replace(/\/$/,'')}/${encodeURIComponent(s.notifyTopic)}`,{method:'POST',headers:{Title:title,Click:click||''},body:message});}catch(e){log('NOTIFY_ERROR',e.message);}
}
async function ebayToken(){
  if(tokenCache.token&&Date.now()<tokenCache.expires)return tokenCache.token;
  if(!EBAY_CLIENT_ID||!EBAY_CLIENT_SECRET)throw new Error('eBay credentials are not configured');
  const basic=Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'});
  if(!r.ok)throw new Error('eBay auth failed '+r.status);const j=await r.json();tokenCache={token:j.access_token,expires:Date.now()+(j.expires_in-60)*1000};return j.access_token;
}
function normalizeEbay(i){
  const c=txt(i.condition||''); let condition='UNKNOWN';
  if(c.includes('new with tags'))condition='NEW_WITH_TAGS';else if(c.includes('new without tags'))condition='NEW_WITHOUT_TAGS';else if(c.includes('open box'))condition='OPEN_BOX';else if(c==='new'||c.startsWith('new '))condition='NEW';else if(c.includes('refurb'))condition='REFURBISHED';else if(c.includes('used')||c.includes('pre-owned'))condition='USED';
  return {itemId:i.itemId,title:i.title||'',price:Number(i.price?.value||0),currency:i.price?.currency||'USD',condition,buyingOptions:i.buyingOptions||[],itemUrl:i.itemWebUrl||'',imageUrl:i.image?.imageUrl||''};
}
async function searchEbay(rule){
  if(PROVIDER==='fake') return [{itemId:'fake-'+Date.now(),title:`${rule.searchKeywords} ${rule.sizeVariant}`.trim(),price:Math.min(rule.maxListingPrice,100),currency:'USD',condition:rule.condition==='ANY'?'USED':rule.condition,buyingOptions:['FIXED_PRICE','BEST_OFFER'],itemUrl:'https://www.ebay.com/',imageUrl:''}];
  const token=await ebayToken();
  const q=encodeURIComponent(`${rule.searchKeywords} ${rule.sizeVariant||''}`.trim());
  const filter=encodeURIComponent(`price:[0..${rule.maxListingPrice}],priceCurrency:USD`);
  const r=await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&limit=50&filter=${filter}`,{headers:{Authorization:`Bearer ${token}`,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'}});
  if(!r.ok)throw new Error('eBay search failed '+r.status);const j=await r.json();return (j.itemSummaries||[]).map(normalizeEbay);
}
async function runRule(id){
  const rule=db.rules.find(r=>r.id===id);if(!rule)throw new Error('Rule not found');
  const items=await searchEbay(rule);let prepared=0;
  for(const l of items){
    const key=rule.id+'|'+l.itemId;if(db.seen.includes(key))continue;if(!matches(rule,l)){db.seen.push(key);continue;}
    const amount=initialOffer(rule,l.price);if(!(amount>0)){db.seen.push(key);continue;}
    const offer={id:randomUUID(),ruleId:rule.id,itemId:l.itemId,title:l.title,itemUrl:l.itemUrl,imageUrl:l.imageUrl,listingPrice:l.price,currency:l.currency,amount,status:'OFFER_READY',attempt:1,createdAt:new Date().toISOString()};
    db.offers.unshift(offer);db.seen.push(key);prepared++;log('OFFER_READY',`Пропозиція ${amount} ${l.currency} для ${l.title}`,{offerId:offer.id});await notify('eBay Offer Bot',`${l.title}\nЦіна: ${l.price} ${l.currency}\nПропозиція: ${amount} ${l.currency}`,l.itemUrl);
  }
  save();return {fetched:items.length,offersPrepared:prepared};
}
async function runAll(){for(const r of db.rules.filter(r=>r.enabled))try{await runRule(r.id)}catch(e){log('ERROR',e.message,{ruleId:r.id});}}
setInterval(runAll,SCHEDULE*60_000).unref?.();

const CSS=`:root{color-scheme:light;--bg:#f2f2f7;--card:rgba(255,255,255,.82);--text:#111113;--muted:#6e6e73;--line:rgba(60,60,67,.14);--input:#fff;--primary:#007aff;--danger:#ff3b30;--soft:#e9f2ff;--shadow:0 10px 30px rgba(0,0,0,.07)}html[data-theme="dark"]{color-scheme:dark;--bg:#000;--card:rgba(28,28,30,.88);--text:#f5f5f7;--muted:#98989d;--line:rgba(255,255,255,.12);--input:#1c1c1e;--primary:#0a84ff;--danger:#ff453a;--soft:#17263a;--shadow:0 10px 30px rgba(0,0,0,.35)}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text);transition:.2s background,.2s color}header{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:color-mix(in srgb,var(--card) 88%,transparent);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--line)}header h1{font-size:20px;margin:0}main{max-width:980px;margin:auto;padding:18px}.card{background:var(--card);backdrop-filter:blur(18px);border:1px solid var(--line);border-radius:22px;padding:18px;margin:14px 0;box-shadow:var(--shadow)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.field{display:flex;flex-direction:column;gap:6px}.field label{font-size:13px;font-weight:700}.hint,.muted{font-size:13px;color:var(--muted)}input,select,button{width:100%;font:inherit;border-radius:14px}input,select{padding:13px 14px;border:1px solid var(--line);background:var(--input);color:var(--text);outline:none}input:focus,select:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 20%,transparent)}input[readonly]{opacity:.72}button{padding:13px 16px;border:0;background:var(--primary);color:#fff;font-weight:700;cursor:pointer}.secondary{background:var(--soft);color:var(--primary)}.danger{background:color-mix(in srgb,var(--danger) 13%,transparent);color:var(--danger)}.iconbtn{width:44px;height:38px;padding:0;border-radius:18px;background:var(--soft);color:var(--primary)}.row{display:flex;gap:9px;flex-wrap:wrap}.row>*{flex:1}.pill{display:inline-block;padding:5px 9px;border-radius:999px;background:var(--soft);color:var(--primary);font-size:12px;font-weight:700}.offer,.rule{border-top:1px solid var(--line);padding-top:14px;margin-top:14px}.rule-head{display:flex;justify-content:space-between;gap:10px;align-items:center}.linkbtn{display:inline-block;text-decoration:none;width:100%}.product{display:grid;grid-template-columns:92px 1fr;gap:14px;align-items:start}.product img{width:92px;height:92px;object-fit:cover;border-radius:16px;background:var(--input)}.notify-box{padding:14px;border-radius:16px;background:var(--soft)}@media(max-width:650px){.grid{grid-template-columns:1fr}.product{grid-template-columns:72px 1fr}.product img{width:72px;height:72px}header{position:static}main{padding:12px}.card{border-radius:18px}}`;

const HTML=`<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#f2f2f7"><link rel="manifest" href="/manifest.webmanifest"><title>eBay Offer Bot</title><style>${CSS}</style></head><body><header><div><h1>eBay Offer Bot</h1><div class="muted">Пошук + Best Offer</div></div><button class="iconbtn" onclick="toggleTheme()" id="themeBtn" aria-label="Змінити тему">◐</button></header><main><div class="card"><h3>Нове правило</h3><p class="muted">Одне правило = один окремий пошук. Можна створювати багато правил для взуття, техніки, одягу та іншого.</p><div class="grid"><div class="field"><label>Ключові слова</label><input id="keywords" placeholder="iPhone 16 Pro 256GB або Merrell Moab 3 Mid GTX"><span class="hint">Головний запит для eBay.</span></div><div class="field"><label>Товар / модель</label><input id="product" readonly placeholder="Заповниться автоматично"></div><div class="field"><label>Розмір / варіант</label><input id="size" placeholder="9.5, 34x32, XL, 256GB, M4..."></div><div class="field"><label>Стан</label><select id="condition"><option value="ANY">Будь-який стан</option><option value="NEW">Новий</option><option value="NEW_WITH_TAGS">Новий з бірками</option><option value="NEW_WITHOUT_TAGS">Новий без бірок</option><option value="OPEN_BOX">Open box</option><option value="USED">Вживаний</option><option value="REFURBISHED">Refurbished</option></select></div><div class="field"><label>Максимальна ціна товару, USD</label><input id="maxListing" type="number" min="0" step="0.01" placeholder="500"></div><div class="field"><label>Тип пропозиції</label><select id="mode"><option value="fixed">Фіксована пропозиція</option><option value="percentage">Знижка у % від ціни</option></select></div><div class="field"><label>Початкова пропозиція</label><input id="offerValue" type="number" min="0" step="0.01" placeholder="400 або 20%"></div><div class="field"><label>Крок після відхилення</label><input id="step" type="number" min="0" step="0.01" placeholder="10"></div><div class="field"><label>Максимальна пропозиція</label><input id="maxOffer" type="number" min="0" step="0.01" placeholder="450"></div></div><p><button onclick="addRule()">Додати правило</button></p></div><div class="card"><h3>Сповіщення</h3><div id="notify"></div></div><div class="card"><h3>Правила пошуку</h3><div id="rules"></div></div><div class="card"><h3>Знайдені пропозиції</h3><div id="offers"></div></div></main><script>
const byId=id=>document.getElementById(id);
async function api(p,o){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});const j=await r.json();if(!r.ok)throw new Error(j.error||'Error');return j}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function applyTheme(theme){document.documentElement.setAttribute('data-theme',theme);localStorage.setItem('theme',theme);byId('themeBtn').textContent=theme==='dark'?'☀️':'🌙';}
function toggleTheme(){applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark')}
const savedTheme=localStorage.getItem('theme');applyTheme(savedTheme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
byId('keywords').addEventListener('input',()=>{byId('product').value=byId('keywords').value.trim()});
function resetRuleForm(){for(const id of ['keywords','product','size','maxListing','offerValue','step','maxOffer'])byId(id).value='';byId('condition').value='ANY';byId('mode').value='fixed';}
async function addRule(){try{const searchKeywords=byId('keywords').value.trim();const mode=byId('mode').value,v=+byId('offerValue').value;await api('/api/rules',{method:'POST',body:JSON.stringify({name:searchKeywords,productName:byId('product').value.trim()||searchKeywords,searchKeywords,sizeVariant:byId('size').value,condition:byId('condition').value,maxListingPrice:+byId('maxListing').value,requireBestOffer:true,offerMode:mode,discountPercent:mode==='percentage'?v:undefined,fixedOfferAmount:mode==='fixed'?v:undefined,offerStepAmount:+byId('step').value,maxOfferAmount:+byId('maxOffer').value})});resetRuleForm();await load()}catch(e){alert(e.message)}}
async function run(id){try{const result=await api('/api/rules/'+id+'/run',{method:'POST'});alert('Знайдено: '+result.fetched+'; підготовлено пропозицій: '+result.offersPrepared);await load()}catch(e){alert(e.message)}}
async function deleteRule(id){if(!confirm('Видалити це правило?'))return;try{await api('/api/rules/'+id,{method:'DELETE'});await load()}catch(e){alert(e.message)}}
async function reject(id){await api('/api/offers/'+id+'/rejected',{method:'POST'});await load()}
function connectNotifications(url){window.open(url,'_blank','noopener')}
async function load(){const [rules,offers,s]=await Promise.all([api('/api/rules'),api('/api/offers'),api('/api/settings')]);const notifyUrl=s.notifications.notifyServer+'/'+s.notifications.notifyTopic;byId('notify').innerHTML='<div class="notify-box"><b>Сповіщення на телефон</b><p class="muted">Встанови ntfy на iPhone/Android і підпишись на цей канал:</p><code>'+esc(s.notifications.notifyTopic)+'</code><p><button onclick="connectNotifications(\\''+esc(notifyUrl)+'\\')">Підключити сповіщення</button></p></div>';byId('rules').innerHTML=rules.length?rules.map(r=>'<div class="rule"><div class="rule-head"><div><b>'+esc(r.name)+'</b><div class="muted">'+esc(r.searchKeywords)+(r.sizeVariant?' · '+esc(r.sizeVariant):'')+' · до '+esc(r.maxListingPrice)+' USD</div></div><span class="pill">активне</span></div><div class="row" style="margin-top:12px"><button onclick="run(\\''+r.id+'\\')">Перевірити зараз</button><button class="danger" onclick="deleteRule(\\''+r.id+'\\')">Видалити</button></div></div>').join(''):'<p class="muted">Правил ще немає. Створи перший пошук вище.</p>';byId('offers').innerHTML=offers.length?offers.map(o=>'<div class="offer"><div class="product">'+(o.imageUrl?'<img src="'+esc(o.imageUrl)+'" alt="">':'<div></div>')+'<div><b>'+esc(o.title)+'</b><br><span class="pill">'+esc(o.status)+'</span><p>Ціна: '+esc(o.listingPrice)+' '+esc(o.currency)+'<br><b>Наша пропозиція: '+esc(o.amount)+' '+esc(o.currency)+'</b><br>Спроба: '+esc(o.attempt)+'</p></div></div><div class="row"><a class="linkbtn" href="'+esc(o.itemUrl)+'" target="_blank" rel="noopener"><button class="secondary">Відкрити товар на eBay</button></a><button class="danger" onclick="reject(\\''+o.id+'\\')">Відхилено</button></div></div>').join(''):'<p class="muted">Пропозицій поки немає.</p>'}
if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js');load();
</script></body></html>`;

const manifest={name:'eBay Offer Bot',short_name:'Offer Bot',start_url:'/',display:'standalone',background_color:'#f2f2f7',theme_color:'#007aff'};
const sw=`const C='ebay-offer-v3';self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll(['/']))));self.addEventListener('fetch',e=>{if(e.request.method==='GET')e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)))})`;

const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://local'),p=u.pathname;
  if(p==='/'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(HTML)}
  if(p==='/manifest.webmanifest'){res.writeHead(200,{'content-type':'application/manifest+json'});return res.end(JSON.stringify(manifest))}
  if(p==='/sw.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});return res.end(sw)}
  if((p==='/health'||p==='/api/health')&&req.method==='GET')return json(res,200,{ok:true,provider:PROVIDER,dryRun:DRY_RUN});
  if(p==='/api/settings'&&req.method==='GET')return json(res,200,{provider:PROVIDER,dryRun:DRY_RUN,ebayConfigured:Boolean(EBAY_CLIENT_ID&&EBAY_CLIENT_SECRET),notifications:db.settings});
  if(p==='/api/rules'&&req.method==='GET')return json(res,200,db.rules);
  if(p==='/api/rules'&&req.method==='POST'){const r=validateRule(await body(req));db.rules.unshift(r);save();log('RULE_CREATED',r.name,{ruleId:r.id});return json(res,201,r)}
  let m=p.match(/^\/api\/rules\/([^/]+)$/);if(m&&req.method==='DELETE'){const i=db.rules.findIndex(x=>x.id===m[1]);if(i<0)return json(res,404,{error:'Rule not found'});const [removed]=db.rules.splice(i,1);db.offers=db.offers.filter(o=>o.ruleId!==removed.id);db.seen=db.seen.filter(k=>!k.startsWith(removed.id+'|'));save();log('RULE_DELETED',removed.name,{ruleId:removed.id});return json(res,200,{ok:true})}
  m=p.match(/^\/api\/rules\/([^/]+)\/run$/);if(m&&req.method==='POST')return json(res,200,await runRule(m[1]));
  if(p==='/api/offers'&&req.method==='GET')return json(res,200,db.offers);
  m=p.match(/^\/api\/offers\/([^/]+)\/rejected$/);if(m&&req.method==='POST'){const o=db.offers.find(x=>x.id===m[1]);if(!o)return json(res,404,{error:'Offer not found'});const r=db.rules.find(x=>x.id===o.ruleId);if(!r)return json(res,404,{error:'Rule not found'});const n=nextOffer(r,o.amount);if(n===null){o.status='MAX_OFFER_REACHED';log('MAX_OFFER_REACHED','Максимум досягнуто',{offerId:o.id});save();return json(res,200,o)}o.amount=n;o.attempt++;o.status=n>=r.maxOfferAmount?'OFFER_READY_MAX':'OFFER_READY';log('OFFER_INCREMENTED',`Нова пропозиція ${n} ${o.currency}`,{offerId:o.id});await notify('eBay Offer Bot',`${o.title}\nНова пропозиція: ${n} ${o.currency}`,o.itemUrl);save();return json(res,200,o)}
  if(p==='/api/history'&&req.method==='GET')return json(res,200,db.history);
  return json(res,404,{error:'Not found'});
}catch(e){log('ERROR',e.message,{path:req.url});return json(res,400,{error:e.message})}});
server.listen(PORT,()=>console.log(`eBay Offer Bot listening on ${PORT}; provider=${PROVIDER}; dryRun=${DRY_RUN}`));
