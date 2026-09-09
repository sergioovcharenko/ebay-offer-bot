import http from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const PROVIDER = process.env.EBAY_PROVIDER || 'fake';
const DRY_RUN = (process.env.GLOBAL_DRY_RUN ?? 'true') !== 'false';
const DATABASE_URL = process.env.DATABASE_URL || '';
const CLIENT = process.env.EBAY_CLIENT_ID || '';
const SECRET = process.env.EBAY_CLIENT_SECRET || '';
const EBAY_RUNAME = process.env.EBAY_RUNAME || '';
const COOKIE = 'ebay_offer_session';
const SCHEDULE_MINUTES = Math.max(1, Number(process.env.SCHEDULE_MINUTES || 10));
const SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
];

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for multi-user mode');
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });
let appToken = { token: null, expires: 0 };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const round = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(data));
}

function html(res, status, content, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(content);
}

async function body(req) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 1e6) throw new Error('Body too large');
  }
  return s ? JSON.parse(s) : {};
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => {
        const i = x.indexOf('=');
        return [decodeURIComponent(x.slice(0, i)), decodeURIComponent(x.slice(i + 1))];
      })
  );
}

function sessionCookie(id) {
  return `${COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`;
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      ebay_user_id text UNIQUE NOT NULL,
      username text NOT NULL DEFAULT '',
      marketplace text NOT NULL DEFAULT '',
      account_type text NOT NULL DEFAULT '',
      access_token text NOT NULL DEFAULT '',
      access_token_expires_at bigint NOT NULL DEFAULT 0,
      refresh_token text NOT NULL DEFAULT '',
      refresh_token_expires_in bigint NOT NULL DEFAULT 0,
      connected_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      notify_enabled boolean NOT NULL DEFAULT true,
      notify_server text NOT NULL DEFAULT 'https://ntfy.sh',
      notify_topic text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS rules (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      product_name text NOT NULL,
      search_keywords text NOT NULL,
      size_variant text NOT NULL DEFAULT '',
      condition text NOT NULL DEFAULT 'ANY',
      max_listing_price numeric NOT NULL,
      require_best_offer boolean NOT NULL DEFAULT true,
      offer_mode text NOT NULL DEFAULT 'fixed',
      discount_percent numeric,
      fixed_offer_amount numeric,
      offer_step_amount numeric NOT NULL,
      max_offer_amount numeric NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS offers (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rule_id uuid NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      item_id text NOT NULL,
      title text NOT NULL,
      item_url text NOT NULL DEFAULT '',
      image_url text NOT NULL DEFAULT '',
      listing_price numeric NOT NULL,
      currency text NOT NULL DEFAULT 'USD',
      amount numeric NOT NULL,
      status text NOT NULL DEFAULT 'OFFER_READY',
      attempt integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS seen (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rule_id uuid NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      item_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, rule_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rules_user_id ON rules(user_id);
    CREATE INDEX IF NOT EXISTS idx_offers_user_id ON offers(user_id);
  `);
}

async function ensureSession(req, res) {
  const existing = cookies(req)[COOKIE];
  if (existing) {
    const r = await pool.query('SELECT id,user_id FROM sessions WHERE id=$1', [existing]);
    if (r.rowCount) return r.rows[0];
  }
  const id = randomUUID();
  await pool.query('INSERT INTO sessions(id) VALUES($1)', [id]);
  res.setHeader('Set-Cookie', sessionCookie(id));
  return { id, user_id: null };
}

async function requireUser(req, res) {
  const session = await ensureSession(req, res);
  if (!session.user_id) {
    const e = new Error('Спочатку увійди через eBay');
    e.status = 401;
    throw e;
  }
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [session.user_id]);
  if (!r.rowCount) {
    const e = new Error('Сесію не знайдено. Увійди через eBay ще раз.');
    e.status = 401;
    throw e;
  }
  return { session, user: r.rows[0] };
}

async function settingsFor(userId) {
  const existing = await pool.query('SELECT * FROM user_settings WHERE user_id=$1', [userId]);
  if (existing.rowCount) return existing.rows[0];
  const topic = 'ebay-offer-' + randomUUID().replaceAll('-', '');
  const r = await pool.query(
    `INSERT INTO user_settings(user_id,notify_topic) VALUES($1,$2)
     RETURNING *`,
    [userId, topic]
  );
  return r.rows[0];
}

function validateRule(x) {
  const searchKeywords = String(x.searchKeywords || '').trim();
  if (!searchKeywords) throw new Error('Ключові слова обов’язкові');
  const productName = String(x.productName || searchKeywords).trim();
  const name = String(x.name || searchKeywords).trim();
  const mode = x.offerMode === 'percentage' ? 'percentage' : 'fixed';
  const maxListingPrice = +x.maxListingPrice;
  const maxOfferAmount = +x.maxOfferAmount;
  const offerStepAmount = +(x.offerStepAmount || 1);
  const offerValue = mode === 'percentage' ? +x.discountPercent : +x.fixedOfferAmount;
  if (!(maxListingPrice > 0 && maxOfferAmount > 0 && offerStepAmount > 0 && offerValue > 0)) {
    throw new Error('Ціни та крок мають бути більше 0');
  }
  if (mode === 'percentage' && offerValue >= 100) throw new Error('Знижка має бути 1–99%');
  return {
    name,
    productName,
    searchKeywords,
    sizeVariant: String(x.sizeVariant || '').trim(),
    condition: ['ANY', 'NEW', 'USED'].includes(x.condition) ? x.condition : 'ANY',
    maxListingPrice,
    requireBestOffer: true,
    offerMode: mode,
    discountPercent: mode === 'percentage' ? offerValue : null,
    fixedOfferAmount: mode === 'fixed' ? offerValue : null,
    offerStepAmount,
    maxOfferAmount
  };
}

function rowRule(r) {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    productName: r.product_name,
    searchKeywords: r.search_keywords,
    sizeVariant: r.size_variant,
    condition: r.condition,
    maxListingPrice: Number(r.max_listing_price),
    requireBestOffer: r.require_best_offer,
    offerMode: r.offer_mode,
    discountPercent: r.discount_percent == null ? null : Number(r.discount_percent),
    fixedOfferAmount: r.fixed_offer_amount == null ? null : Number(r.fixed_offer_amount),
    offerStepAmount: Number(r.offer_step_amount),
    maxOfferAmount: Number(r.max_offer_amount),
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function rowOffer(r) {
  return {
    id: r.id,
    ruleId: r.rule_id,
    itemId: r.item_id,
    title: r.title,
    itemUrl: r.item_url,
    imageUrl: r.image_url,
    listingPrice: Number(r.listing_price),
    currency: r.currency,
    amount: Number(r.amount),
    status: r.status,
    attempt: r.attempt,
    createdAt: r.created_at
  };
}

async function appAccessToken() {
  if (appToken.token && Date.now() < appToken.expires) return appToken.token;
  if (!CLIENT || !SECRET) throw new Error('eBay credentials are not configured');
  const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
  });
  if (!r.ok) throw new Error('eBay auth failed ' + r.status);
  const j = await r.json();
  appToken = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return j.access_token;
}

async function exchangeCode(code) {
  const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString('base64');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: EBAY_RUNAME
  });
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error('eBay user auth failed ' + r.status + (detail ? ' ' + detail : ''));
  }
  return r.json();
}

async function identity(token) {
  let r = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (r.status === 405) {
    r = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
  }
  if (!r.ok) throw new Error('Не вдалося отримати eBay профіль: ' + r.status);
  return r.json();
}

function normalize(i) {
  const raw = String(i.condition || '').toLowerCase();
  let condition = 'OTHER';
  if (raw.includes('new') || raw.includes('open box')) condition = 'NEW';
  else if (raw.includes('used') || raw.includes('pre-owned')) condition = 'USED';
  return {
    itemId: i.itemId,
    title: i.title || '',
    price: +(i.price?.value || 0),
    currency: i.price?.currency || 'USD',
    condition,
    buyingOptions: i.buyingOptions || [],
    itemUrl: i.itemWebUrl || '',
    imageUrl: i.image?.imageUrl || ''
  };
}

function evaluateMatch(rule, listing) {
  const bestOffer = !rule.requireBestOffer || listing.buyingOptions.includes('BEST_OFFER');
  const withinPrice = listing.price > 0 && listing.price <= rule.maxListingPrice;
  const conditionMatch = rule.condition === 'ANY' || listing.condition === rule.condition;
  return {
    bestOffer,
    withinPrice,
    conditionMatch,
    eligible: bestOffer && withinPrice && conditionMatch
  };
}

async function search(rule) {
  if (PROVIDER === 'fake') return [];
  const token = await appAccessToken();
  const query = `${rule.searchKeywords} ${rule.sizeVariant || ''}`.trim();
  const params = new URLSearchParams({ q: query, limit: '50' });
  params.set('filter', `price:[0..${rule.maxListingPrice}],priceCurrency:USD`);
  const r = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?' + params, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US'
    }
  });
  if (!r.ok) throw new Error('eBay search failed ' + r.status);
  const j = await r.json();
  return (j.itemSummaries || []).map(normalize);
}

async function notifyUser(userId, title, message) {
  const s = await settingsFor(userId);
  if (!s.notify_enabled) return;
  await fetch(`${s.notify_server}/${encodeURIComponent(s.notify_topic)}`, {
    method: 'POST',
    headers: { Title: title },
    body: message
  }).catch(() => {});
}

async function runRule(userId, rule) {
  if (rule.userId !== userId) throw new Error('Rule not found');
  const items = await search(rule);
  const diagnostics = { fetched: items.length, bestOffer: 0, withinPrice: 0, conditionMatch: 0, eligible: 0, offersPrepared: 0 };
  for (const listing of items) {
    const m = evaluateMatch(rule, listing);
    if (m.bestOffer) diagnostics.bestOffer++;
    if (m.withinPrice) diagnostics.withinPrice++;
    if (m.conditionMatch) diagnostics.conditionMatch++;
    if (m.eligible) diagnostics.eligible++;
    if (!m.eligible) continue;

    const seen = await pool.query(
      'SELECT 1 FROM seen WHERE user_id=$1 AND rule_id=$2 AND item_id=$3',
      [userId, rule.id, listing.itemId]
    );
    if (seen.rowCount) continue;

    const amount = round(Math.min(
      rule.offerMode === 'percentage'
        ? listing.price * (1 - rule.discountPercent / 100)
        : rule.fixedOfferAmount,
      rule.maxOfferAmount,
      listing.price
    ));

    const claimed = await pool.query(
      'INSERT INTO seen(user_id,rule_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING item_id',
      [userId, rule.id, listing.itemId]
    );
    if (!claimed.rowCount) continue;
    try {
      await pool.query(
        `INSERT INTO offers(id,user_id,rule_id,item_id,title,item_url,image_url,listing_price,currency,amount,status,attempt)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OFFER_READY',1)`,
        [randomUUID(), userId, rule.id, listing.itemId, listing.title, listing.itemUrl, listing.imageUrl, listing.price, listing.currency, amount]
      );
    } catch (e) {
      await pool.query('DELETE FROM seen WHERE user_id=$1 AND rule_id=$2 AND item_id=$3', [userId, rule.id, listing.itemId]);
      throw e;
    }
    diagnostics.offersPrepared++;
    await notifyUser(userId, 'eBay Offer Bot', `${listing.title}\n${listing.price} ${listing.currency} → пропозиція ${amount} ${listing.currency}`);
  }
  return { ...diagnostics, dryRun: DRY_RUN };
}

const CSS = `:root{--bg:#f2f2f7;--card:#fff;--text:#111;--muted:#6e6e73;--line:#3c3c4324;--blue:#007aff;--soft:#eaf3ff;--red:#ff3b30}html[data-theme=dark]{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--muted:#98989d;--line:#ffffff1f;--blue:#0a84ff;--soft:#17263a;--red:#ff453a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,system-ui}header{display:flex;justify-content:space-between;padding:16px 20px;background:var(--card);border-bottom:1px solid var(--line)}main{max-width:980px;margin:auto;padding:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:18px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.field{display:flex;flex-direction:column;gap:6px}label{font-size:13px;font-weight:700}.muted{color:var(--muted);font-size:13px}input,select,button{width:100%;font:inherit;border-radius:14px;padding:13px}input,select{background:var(--card);color:var(--text);border:1px solid var(--line)}button{border:0;background:var(--blue);color:white;font-weight:700}.secondary{background:var(--soft);color:var(--blue)}.danger{background:#ff3b3020;color:var(--red)}.row{display:flex;gap:8px}.row>*{flex:1}.pill{display:inline-block;padding:5px 9px;border-radius:999px;background:var(--soft);color:var(--blue);font-size:12px;font-weight:700}.item{border-top:1px solid var(--line);padding-top:14px;margin-top:14px}.top{display:flex;justify-content:space-between;gap:10px}.icon{width:44px}.legal{max-width:760px;margin:40px auto;padding:16px}@media(max-width:650px){.grid{grid-template-columns:1fr}.row{flex-direction:column}}`;

const HTML = `<!doctype html><html lang="uk" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>eBay Offer Bot</title><style>${CSS}</style></head><body><header><div><b>eBay Offer Bot</b><div class="muted">Multi-user · Пошук + Best Offer</div></div><button class="icon" onclick="toggleTheme()">◐</button></header><main><div class="card"><h3>Підключений eBay акаунт</h3><div id="account"></div></div><div class="card"><h3 id="formTitle">Нове правило</h3><div class="grid"><div class="field"><label>Ключові слова</label><input id="keywords" placeholder="Merrell Moab 3"></div><div class="field"><label>Товар / модель</label><input id="product" readonly></div><div class="field"><label>Розмір / варіант</label><input id="size" placeholder="9.5"></div><div class="field"><label>Стан</label><select id="condition"><option value="ANY">Будь-який</option><option value="NEW">Новий</option><option value="USED">Вживаний</option></select></div><div class="field"><label>Макс. ціна, USD</label><input id="maxListing" type="number"></div><div class="field"><label>Тип пропозиції</label><select id="mode"><option value="fixed">Фіксована</option><option value="percentage">% знижки</option></select></div><div class="field"><label>Початкова пропозиція</label><input id="offerValue" type="number"></div><div class="field"><label>Крок після відхилення</label><input id="step" type="number"></div><div class="field"><label>Максимум пропозиції</label><input id="maxOffer" type="number"></div></div><p class="row"><button id="saveBtn" onclick="saveRule()">Додати правило</button><button id="cancelBtn" class="secondary" style="display:none" onclick="cancelEdit()">Скасувати</button></p></div><div class="card"><h3>Сповіщення</h3><div id="notify"></div></div><div class="card"><h3>Правила</h3><div id="rules"></div></div><div class="card"><h3>Пропозиції</h3><div id="offers"></div></div></main><script>
const $=id=>document.getElementById(id);const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let editingId=null,lastRules=[];async function api(p,o={}){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});const j=await r.json();if(!r.ok)throw Error(j.error||'Error');return j}function toggleTheme(){const d=document.documentElement;const n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;localStorage.setItem('theme',n)}const savedTheme=localStorage.getItem('theme');document.documentElement.dataset.theme=savedTheme||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');$('keywords').oninput=()=>$('product').value=$('keywords').value.trim();function resetRuleForm(){editingId=null;for(const x of ['keywords','product','size','maxListing','offerValue','step','maxOffer'])$(x).value='';$('condition').value='ANY';$('mode').value='fixed';$('formTitle').textContent='Нове правило';$('saveBtn').textContent='Додати правило';$('cancelBtn').style.display='none'}function payload(){const mode=$('mode').value,v=+$('offerValue').value;return {searchKeywords:$('keywords').value,productName:$('product').value,sizeVariant:$('size').value,condition:$('condition').value,maxListingPrice:+$('maxListing').value,offerMode:mode,discountPercent:mode==='percentage'?v:undefined,fixedOfferAmount:mode==='fixed'?v:undefined,offerStepAmount:+$('step').value,maxOfferAmount:+$('maxOffer').value}}async function saveRule(){try{await api(editingId?'/api/rules/'+editingId:'/api/rules',{method:editingId?'PUT':'POST',body:JSON.stringify(payload())});resetRuleForm();await load()}catch(e){alert(e.message)}}function editRule(id){const r=lastRules.find(x=>x.id===id);if(!r)return;editingId=id;$('keywords').value=r.searchKeywords;$('product').value=r.productName||r.searchKeywords;$('size').value=r.sizeVariant||'';$('condition').value=r.condition;$('maxListing').value=r.maxListingPrice;$('mode').value=r.offerMode;$('offerValue').value=r.offerMode==='percentage'?r.discountPercent:r.fixedOfferAmount;$('step').value=r.offerStepAmount;$('maxOffer').value=r.maxOfferAmount;$('formTitle').textContent='Редагувати правило';$('saveBtn').textContent='Зберегти';$('cancelBtn').style.display='block';scrollTo({top:0,behavior:'smooth'})}function cancelEdit(){resetRuleForm()}async function deleteRule(id){if(!confirm('Видалити правило?'))return;await api('/api/rules/'+id,{method:'DELETE'});if(editingId===id)resetRuleForm();load()}async function run(id){try{const x=await api('/api/rules/'+id+'/run',{method:'POST'});alert('Знайдено: '+x.fetched+'\nBest Offer: '+x.bestOffer+'\nУ межах ціни: '+x.withinPrice+'\nСтан підходить: '+x.conditionMatch+'\nПідходять: '+x.eligible+'\nНових пропозицій: '+x.offersPrepared);load()}catch(e){alert(e.message)}}async function logout(){await api('/api/ebay/account',{method:'DELETE'});location.reload()}async function load(){try{const s=await api('/api/settings');$('account').innerHTML=s.ebayAccount?.connected?'<span class="pill">Підключено</span><p><b>'+E(s.ebayAccount.username||'eBay акаунт')+'</b><br><span class="muted">'+E(s.ebayAccount.marketplace||'')+'</span></p><div class="row"><a href="/auth/ebay/login"><button>Змінити акаунт</button></a><button class="danger" onclick="logout()">Вийти</button></div>':'<p class="muted">Кожна людина входить у свій eBay акаунт. Її правила і пропозиції бачить тільки вона.</p><a href="/auth/ebay/login"><button>Увійти через eBay</button></a>';if(!s.ebayAccount?.connected){$('rules').innerHTML='<p class="muted">Увійди через eBay, щоб створювати свої правила.</p>';$('offers').innerHTML='<p class="muted">Пропозицій немає.</p>';$('notify').innerHTML='<p class="muted">Сповіщення з’являться після входу.</p>';return}const [rules,offers]=await Promise.all([api('/api/rules'),api('/api/offers')]);lastRules=rules;$('notify').innerHTML='<p class="muted">Канал ntfy: <b>'+E(s.notifications.notifyTopic)+'</b></p><a target="_blank" href="'+E(s.notifications.notifyServer+'/'+s.notifications.notifyTopic)+'"><button>Підключити сповіщення</button></a>';$('rules').innerHTML=rules.length?rules.map(r=>'<div class="item"><div class="top"><b>'+E(r.name)+'</b><span class="pill">активне</span></div><p class="muted">'+E(r.sizeVariant||'без розміру')+' · до '+E(r.maxListingPrice)+' USD</p><div class="row"><button onclick="run(\\''+r.id+'\\')">Перевірити зараз</button><button class="secondary" onclick="editRule(\\''+r.id+'\\')">Редагувати</button><button class="danger" onclick="deleteRule(\\''+r.id+'\\')">Видалити</button></div></div>').join(''):'<p class="muted">Правил немає.</p>';$('offers').innerHTML=offers.length?offers.map(o=>'<div class="item"><b>'+E(o.title)+'</b><p>Ціна: '+E(o.listingPrice)+' '+E(o.currency)+'<br><b>Наша пропозиція: '+E(o.amount)+' '+E(o.currency)+'</b></p><a target="_blank" href="'+E(o.itemUrl)+'"><button class="secondary">Відкрити товар на eBay</button></a></div>').join(''):'<p class="muted">Пропозицій немає.</p>'}catch(e){alert(e.message)}}load();
</script></body></html>`;

const PRIVACY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Privacy Policy — eBay Offer Bot</title><style>${CSS}</style></head><body><div class="legal"><h1>Privacy Policy</h1><p><b>eBay Offer Bot</b> lets multiple users connect their own eBay accounts and keeps each user's rules, offers, OAuth credentials and notification settings separated.</p><p>OAuth tokens and account identifiers are stored only to operate the service. The application does not sell personal data or use it for advertising.</p><p>Users may disconnect their eBay account and delete their search rules at any time.</p><p><a href="/">Return to eBay Offer Bot</a></p></div></body></html>`;
const DECLINED = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>eBay authorization cancelled</title><style>${CSS}</style></head><body><div class="legal"><h1>Авторизацію eBay скасовано</h1><p>Акаунт не підключено.</p><p><a href="/"><button>Повернутися до бота</button></a></p></div></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://local');
    const p = u.pathname;

    if (p === '/' && req.method === 'GET') return html(res, 200, HTML);
    if (p === '/privacy' && req.method === 'GET') return html(res, 200, PRIVACY);
    if (p === '/auth/ebay/declined' && req.method === 'GET') return html(res, 200, DECLINED);
    if ((p === '/health' || p === '/api/health') && req.method === 'GET') {
      await pool.query('SELECT 1');
      return json(res, 200, { ok: true, provider: PROVIDER, dryRun: DRY_RUN, database: true });
    }

    if (p === '/auth/ebay/login' && req.method === 'GET') {
      if (!EBAY_RUNAME) return json(res, 400, { error: 'EBAY_RUNAME не налаштований' });
      const session = await ensureSession(req, res);
      const state = randomUUID();
      await pool.query('DELETE FROM oauth_states WHERE session_id=$1', [session.id]);
      await pool.query('INSERT INTO oauth_states(state,session_id) VALUES($1,$2)', [state, session.id]);
      const q = new URLSearchParams({
        client_id: CLIENT,
        response_type: 'code',
        redirect_uri: EBAY_RUNAME,
        scope: SCOPES.join(' '),
        state,
        prompt: 'login'
      });
      res.writeHead(302, { Location: 'https://auth.ebay.com/oauth2/authorize?' + q });
      return res.end();
    }

    if (p === '/auth/ebay/callback' && req.method === 'GET') {
      const session = await ensureSession(req, res);
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      if (!code) throw new Error('eBay не повернув authorization code');
      const st = await pool.query('SELECT state FROM oauth_states WHERE state=$1 AND session_id=$2', [state, session.id]);
      if (!st.rowCount) throw new Error('Невірний OAuth state');
      await pool.query('DELETE FROM oauth_states WHERE state=$1', [state]);

      const token = await exchangeCode(code);
      const profile = await identity(token.access_token);
      const ebayUserId = String(profile.userId || profile.username || '').trim();
      if (!ebayUserId) throw new Error('eBay не повернув user id');
      const userId = randomUUID();
      const r = await pool.query(
        `INSERT INTO users(id,ebay_user_id,username,marketplace,account_type,access_token,access_token_expires_at,refresh_token,refresh_token_expires_in,connected_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT(ebay_user_id) DO UPDATE SET
           username=EXCLUDED.username, marketplace=EXCLUDED.marketplace, account_type=EXCLUDED.account_type,
           access_token=EXCLUDED.access_token, access_token_expires_at=EXCLUDED.access_token_expires_at,
           refresh_token=CASE WHEN EXCLUDED.refresh_token<>'' THEN EXCLUDED.refresh_token ELSE users.refresh_token END,
           refresh_token_expires_in=EXCLUDED.refresh_token_expires_in, connected_at=now()
         RETURNING id`,
        [userId, ebayUserId, profile.username || '', profile.registrationMarketplaceId || '', profile.accountType || '', token.access_token, Date.now() + token.expires_in * 1000, token.refresh_token || '', token.refresh_token_expires_in || 0]
      );
      await pool.query('UPDATE sessions SET user_id=$1,updated_at=now() WHERE id=$2', [r.rows[0].id, session.id]);
      await settingsFor(r.rows[0].id);
      res.writeHead(302, { Location: '/?ebay=connected' });
      return res.end();
    }

    if (p === '/api/settings' && req.method === 'GET') {
      const session = await ensureSession(req, res);
      if (!session.user_id) {
        return json(res, 200, { provider: PROVIDER, dryRun: DRY_RUN, ebayConfigured: Boolean(CLIENT && SECRET), oauthConfigured: Boolean(EBAY_RUNAME), ebayAccount: null, notifications: null });
      }
      const ur = await pool.query('SELECT id,username,marketplace,account_type FROM users WHERE id=$1', [session.user_id]);
      if (!ur.rowCount) return json(res, 200, { provider: PROVIDER, dryRun: DRY_RUN, ebayAccount: null, notifications: null });
      const s = await settingsFor(session.user_id);
      return json(res, 200, {
        provider: PROVIDER,
        dryRun: DRY_RUN,
        ebayConfigured: Boolean(CLIENT && SECRET),
        oauthConfigured: Boolean(EBAY_RUNAME),
        ebayAccount: { connected: true, username: ur.rows[0].username, marketplace: ur.rows[0].marketplace, accountType: ur.rows[0].account_type },
        notifications: { notifyEnabled: s.notify_enabled, notifyServer: s.notify_server, notifyTopic: s.notify_topic }
      });
    }

    if (p === '/api/ebay/account' && req.method === 'DELETE') {
      const session = await ensureSession(req, res);
      await pool.query('UPDATE sessions SET user_id=NULL,updated_at=now() WHERE id=$1', [session.id]);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/rules' && req.method === 'GET') {
      const { user } = await requireUser(req, res);
      const r = await pool.query('SELECT * FROM rules WHERE user_id=$1 ORDER BY created_at DESC', [user.id]);
      return json(res, 200, r.rows.map(rowRule));
    }

    if (p === '/api/rules' && req.method === 'POST') {
      const { user } = await requireUser(req, res);
      const x = validateRule(await body(req));
      const id = randomUUID();
      const r = await pool.query(
        `INSERT INTO rules(id,user_id,name,product_name,search_keywords,size_variant,condition,max_listing_price,require_best_offer,offer_mode,discount_percent,fixed_offer_amount,offer_step_amount,max_offer_amount)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [id, user.id, x.name, x.productName, x.searchKeywords, x.sizeVariant, x.condition, x.maxListingPrice, true, x.offerMode, x.discountPercent, x.fixedOfferAmount, x.offerStepAmount, x.maxOfferAmount]
      );
      return json(res, 201, rowRule(r.rows[0]));
    }

    let m = p.match(/^\/api\/rules\/([^/]+)$/);
    if (m && req.method === 'PUT') {
      const { user } = await requireUser(req, res);
      const x = validateRule(await body(req));
      const r = await pool.query(
        `UPDATE rules SET name=$1,product_name=$2,search_keywords=$3,size_variant=$4,condition=$5,max_listing_price=$6,offer_mode=$7,discount_percent=$8,fixed_offer_amount=$9,offer_step_amount=$10,max_offer_amount=$11,updated_at=now()
         WHERE id=$12 AND user_id=$13 RETURNING *`,
        [x.name, x.productName, x.searchKeywords, x.sizeVariant, x.condition, x.maxListingPrice, x.offerMode, x.discountPercent, x.fixedOfferAmount, x.offerStepAmount, x.maxOfferAmount, m[1], user.id]
      );
      if (!r.rowCount) return json(res, 404, { error: 'Rule not found' });
      return json(res, 200, rowRule(r.rows[0]));
    }

    if (m && req.method === 'DELETE') {
      const { user } = await requireUser(req, res);
      const r = await pool.query('DELETE FROM rules WHERE id=$1 AND user_id=$2 RETURNING id', [m[1], user.id]);
      if (!r.rowCount) return json(res, 404, { error: 'Rule not found' });
      return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/rules\/([^/]+)\/run$/);
    if (m && req.method === 'POST') {
      const { user } = await requireUser(req, res);
      const r = await pool.query('SELECT * FROM rules WHERE id=$1 AND user_id=$2', [m[1], user.id]);
      if (!r.rowCount) return json(res, 404, { error: 'Rule not found' });
      return json(res, 200, await runRule(user.id, rowRule(r.rows[0])));
    }

    if (p === '/api/offers' && req.method === 'GET') {
      const { user } = await requireUser(req, res);
      const r = await pool.query('SELECT * FROM offers WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200', [user.id]);
      return json(res, 200, r.rows.map(rowOffer));
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, e.status || 400, { error: e.message });
  }
});

async function scheduledRun() {
  try {
    const r = await pool.query('SELECT * FROM rules WHERE enabled=true');
    for (const row of r.rows) {
      try { await runRule(row.user_id, rowRule(row)); } catch (e) { console.error('scheduled rule failed', row.id, e.message); }
    }
  } catch (e) {
    console.error('scheduler failed', e.message);
  }
}

await migrate();
server.listen(PORT, () => console.log(`eBay Offer Bot v5 on ${PORT}; provider=${PROVIDER}; dryRun=${DRY_RUN}; postgres=true`));
setInterval(scheduledRun, SCHEDULE_MINUTES * 60_000).unref();
