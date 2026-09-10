import { readFileSync, writeFileSync } from 'node:fs';

const sourceUrl = new URL('./server-v7.js', import.meta.url);
const runtimeUrl = new URL('./.server-v7-live.runtime.mjs', import.meta.url);
let source = readFileSync(sourceUrl, 'utf8');

function mustReplace(search, replacement, label) {
  if (!source.includes(search)) throw new Error('Live patch failed: '+label);
  source = source.replace(search, replacement);
}

mustReplace(
  "status text NOT NULL DEFAULT 'OFFER_READY',attempt integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());",
  "status text NOT NULL DEFAULT 'OFFER_READY',best_offer_id text NOT NULL DEFAULT '',attempt integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());\nALTER TABLE offers ADD COLUMN IF NOT EXISTS best_offer_id text NOT NULL DEFAULT '';",
  'offers best_offer_id migration'
);

mustReplace(
  "function rowOffer(r){return {id:r.id,ruleId:r.rule_id,itemId:r.item_id,title:r.title,itemUrl:r.item_url,imageUrl:r.image_url,listingPrice:Number(r.listing_price),currency:r.currency,amount:Number(r.amount),status:r.status,attempt:r.attempt};}",
  "function rowOffer(r){return {id:r.id,ruleId:r.rule_id,itemId:r.item_id,title:r.title,itemUrl:r.item_url,imageUrl:r.image_url,listingPrice:Number(r.listing_price),currency:r.currency,amount:Number(r.amount),status:r.status,bestOfferId:r.best_offer_id||'',attempt:r.attempt};}",
  'rowOffer bestOfferId'
);

const liveHelpers = String.raw`
function xmlEscape(value){return String(value??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&apos;'}[c]));}
function xmlText(xml,tag){const m=String(xml||'').match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+tag+'>','i'));return m?m[1].replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'\"').replace(/&apos;/g,"'").trim():'';}
function parseRestItemId(itemId){const raw=String(itemId||'').trim();const m=raw.match(/^v1\|(\d+)\|(\d+)$/);return m?{legacyItemId:m[1],variationId:m[2]==='0'?'':m[2]}:{legacyItemId:raw,variationId:''};}
function clientPublicIp(req){let raw=String(req?.headers?.['x-forwarded-for']||req?.headers?.['cf-connecting-ip']||req?.socket?.remoteAddress||'').split(',')[0].trim();if(raw.startsWith('::ffff:'))raw=raw.slice(7);if(raw.startsWith('[')&&raw.endsWith(']'))raw=raw.slice(1,-1);return raw;}
async function userAccessToken(userId){const ur=await pool.query('SELECT access_token,access_token_expires_at,refresh_token FROM users WHERE id=$1',[userId]);if(!ur.rowCount)throw Error('eBay акаунт не знайдено');const u=ur.rows[0];if(u.access_token&&Number(u.access_token_expires_at)>Date.now()+60000)return u.access_token;if(!u.refresh_token)throw Error('Сесія eBay завершилась. Увійди через eBay ще раз.');const basic=Buffer.from(CLIENT+':'+SECRET).toString('base64');const form=new URLSearchParams({grant_type:'refresh_token',refresh_token:u.refresh_token,scope:SCOPES.join(' ')});const r=await fetch('https://api.ebay.com/identity/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+basic,'Content-Type':'application/x-www-form-urlencoded'},body:form});if(!r.ok)throw Error('Не вдалося оновити eBay авторизацію: '+r.status);const t=await r.json();await pool.query('UPDATE users SET access_token=$1,access_token_expires_at=$2,refresh_token=CASE WHEN $3<>\'\' THEN $3 ELSE refresh_token END WHERE id=$4',[t.access_token,Date.now()+Number(t.expires_in||7200)*1000,t.refresh_token||'',userId]);return t.access_token;}
async function browseVariationSpecifics(restItemId){const ids=parseRestItemId(restItemId);if(!ids.variationId)return [];const token=await appAccessToken();const headers={Authorization:'Bearer '+token,'X-EBAY-C-MARKETPLACE-ID':'EBAY_US'};const one=await fetch('https://api.ebay.com/buy/browse/v1/item/'+encodeURIComponent(restItemId),{headers});if(!one.ok)throw Error('Не вдалося отримати варіант товару з eBay: '+one.status);const item=await one.json();if(!item.itemGroupId)throw Error('eBay не повернув групу варіантів для цього товару');const gr=await fetch('https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id='+encodeURIComponent(item.itemGroupId),{headers});if(!gr.ok)throw Error('Не вдалося отримати варіанти товару з eBay: '+gr.status);const group=await gr.json();const items=Array.isArray(group.items)?group.items:[];const values=new Map();for(const x of items){for(const a of (x.localizedAspects||[])){if(!a?.name||a.value==null)continue;const key=String(a.name);if(!values.has(key))values.set(key,new Set());values.get(key).add(String(a.value));}}
const varying=new Set([...values.entries()].filter(([,set])=>set.size>1).map(([name])=>name));const specifics=(item.localizedAspects||[]).filter(a=>a?.name&&a.value!=null&&varying.has(String(a.name))).map(a=>({name:String(a.name),value:String(a.value)}));if(!specifics.length)throw Error('Не вдалося безпечно визначити розмір/варіант для цього лота. Відкрий товар на eBay і перевір варіант вручну.');return specifics.slice(0,5);}
function parseTradingResponse(xml){const Ack=xmlText(xml,'Ack');const bestOfferId=xmlText(xml,'BestOfferID');const errors=[];const blocks=String(xml||'').match(/<Errors>[\s\S]*?<\/Errors>/gi)||[];for(const b of blocks){errors.push({code:xmlText(b,'ErrorCode'),message:xmlText(b,'LongMessage')||xmlText(b,'ShortMessage')});}return {Ack,bestOfferId,Errors:errors};}
async function placeBestOffer(userId,restItemId,amount,endUserIp){const token=await userAccessToken(userId);const ids=parseRestItemId(restItemId);if(!/^\d+$/.test(ids.legacyItemId))throw Error('eBay повернув невідомий ItemID: '+restItemId);const specifics=await browseVariationSpecifics(restItemId);const variationXml=specifics.length?'<VariationSpecifics>'+specifics.map(a=>'<NameValueList><Name>'+xmlEscape(a.name)+'</Name><Value>'+xmlEscape(a.value)+'</Value></NameValueList>').join('')+'</VariationSpecifics>':'';const body='<?xml version="1.0" encoding="utf-8"?><PlaceOfferRequest xmlns="urn:ebay:apis:eBLBaseComponents"><EndUserIP>'+xmlEscape(endUserIp)+'</EndUserIP><ItemID>'+xmlEscape(ids.legacyItemId)+'</ItemID><Offer><Action>Offer</Action><Quantity>1</Quantity><MaxBid>'+xmlEscape(amount)+'</MaxBid></Offer>'+variationXml+'</PlaceOfferRequest>';const r=await fetch('https://api.ebay.com/ws/api.dll',{method:'POST',headers:{'Content-Type':'text/xml','X-EBAY-API-CALL-NAME':'PlaceOffer','X-EBAY-API-COMPATIBILITY-LEVEL':'1477','X-EBAY-API-SITEID':'0','X-EBAY-API-IAF-TOKEN':token},body});const text=await r.text();const parsed=parseTradingResponse(text);if(!r.ok||!['Success','Warning'].includes(parsed.Ack)){const detail=parsed.Errors.map(e=>(e.code?e.code+': ':'')+e.message).filter(Boolean).join(' | ');const err=Error('PlaceOffer недоступний або eBay відхилив пропозицію'+(detail?': '+detail:' (HTTP '+r.status+')'));err.status=502;throw err;}return parsed;}
`;

const startMarker = 'async function requestOfferSend(userId,offerId,amount)';
if (!source.includes(startMarker)) throw new Error('Live patch failed: requestOfferSend start');
source = source.replace(startMarker, liveHelpers+'\n'+startMarker);

const requestOfferPattern = /async function requestOfferSend\(userId,offerId,amount\)\{[\s\S]*?\}\n\nasync function updateOfferStatus/;
if (!requestOfferPattern.test(source)) throw new Error('Live patch failed: requestOfferSend body');
source = source.replace(requestOfferPattern, String.raw`async function requestOfferSend(userId,offerId,amount,req){const or=await pool.query('SELECT * FROM offers WHERE id=$1 AND user_id=$2',[offerId,userId]);if(!or.rowCount){const e=Error('Offer not found');e.status=404;throw e;}const offer=or.rows[0];const value=round(Number(amount));if(!(value>0))throw Error('Сума пропозиції має бути більше 0');const endUserIp=clientPublicIp(req);if(!endUserIp)throw Error('Не вдалося визначити публічну IP-адресу користувача. Спробуй ще раз без VPN або проксі.');if(DRY_RUN){const e=Error('Реальне надсилання вимкнено (DRY RUN). Пропозицію продавцю не відправлено.');e.status=409;throw e;}const result=await placeBestOffer(userId,offer.item_id,value,endUserIp);await pool.query("UPDATE offers SET amount=$1,status='OFFER_SENT',best_offer_id=$2 WHERE id=$3 AND user_id=$4",[value,result.bestOfferId||'',offerId,userId]);await notifyUser(userId,'eBay Offer Bot','Пропозицію реально відправлено продавцю: '+offer.title+'\n'+value+' '+offer.currency);return {ok:true,status:'OFFER_SENT',bestOfferId:result.bestOfferId||'',amount:value,message:'Пропозицію реально відправлено продавцю',dryRun:DRY_RUN};}

async function updateOfferStatus`);

mustReplace(
  "return json(res,200,await requestOfferSend(user.id,m[1],body.amount));",
  "return json(res,200,await requestOfferSend(user.id,m[1],body.amount,req));",
  'send route passes request for EndUserIP'
);

writeFileSync(runtimeUrl, source, 'utf8');
await import(runtimeUrl.href+'?v='+Date.now());
