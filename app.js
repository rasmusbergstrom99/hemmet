/* Vårt hem: möbelkalkyl, moodboard och planritning för nya lägenheten.

   Allt innehåll ligger i repot rasmusbergstrom99/hemmet, på grenen "data":
     data.json   rum, möbler och moodboard
     budget.json vad var och en lägger per rum, och delarna rummen är fördelade på
     bilder/     uppladdade bilder
   Budgeten ligger i en egen fil så att en äldre version av sidan, som bara känner till
   data.json, aldrig kan skriva över den.
   Sidan själv ligger på grenen main och publiceras med GitHub Pages.

   Att läsa kräver ingen nyckel. För att ändra behövs en GitHub-nyckel (fine-grained token
   med "Contents: Read and write" för bara det här repot). Den sparas i webbläsaren på varje
   enhet och skickas bara till api.github.com. */
'use strict';

const CFG = { owner: 'rasmusbergstrom99', repo: 'hemmet', branch: 'data', file: 'data.json' };
const BUDGET_FILE = 'budget.json';
// Den högsta versionen av varje fil den här sidan förstår. En nyare fil sparas inte över.
const KNOWN_VERSION = { [CFG.file]: 1, [BUDGET_FILE]: 1 };
const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}`;
const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/`;

const PEOPLE = { rasmus: 'Rasmus', emily: 'Emily' };
const STATUS = { ide: 'Idé', vald: 'Vald', kopt: 'Köpt' };
const STATUS_ORDER = { vald: 0, ide: 1, kopt: 2 };
const PAYERS = { delat: 'Delat', rasmus: 'Rasmus', emily: 'Emily' };
const ZONES = { oppet: 'Vardagsrum & kök', sovrum: 'Sovrum', hall: 'Hall', badrum: 'Badrum', balkong: 'Balkong', '': 'Ingen plats på ritningen' };
const DEFAULT_ROOMS = [
  { id: 'vardagsrum', namn: 'Vardagsrum', zon: 'oppet' },
  { id: 'kok', namn: 'Kök', zon: 'oppet' },
  { id: 'matplats', namn: 'Matplats', zon: 'oppet' },
  { id: 'sovrum', namn: 'Sovrum', zon: 'sovrum' },
  { id: 'hall', namn: 'Hall', zon: 'hall' },
  { id: 'badrum', namn: 'Badrum', zon: 'badrum' },
  { id: 'balkong', namn: 'Balkong', zon: 'balkong' },
  { id: 'arbetsplats', namn: 'Arbetsplats', zon: '' },
  { id: 'ovrigt', namn: 'Övrigt', zon: '' },
];
const VIEWS = ['kalkyl', 'budget', 'moodboard', 'ritning'];
const KEY_STORE = 'hemmet.nyckel';
const ME_STORE = 'hemmet.jag';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privat läge */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignoreras */ } },
};

const S = {
  data: null,
  budget: null,
  loading: false,
  loadErr: false,
  budgetErr: false,
  loadedAt: 0,
  key: store.get(KEY_STORE),
  me: PEOPLE[store.get(ME_STORE)] ? store.get(ME_STORE) : null,
  keyBad: false,
  busy: 0,
  view: 'kalkyl',
  filt: { status: 'alla', rum: new Set() },
  moodRum: new Set(),
  zoom: false,
  plan: null,
  localImg: new Map(),
};

// ---------------------------------------------------------------- små hjälpare

const $ = (sel, root = document) => root.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';
const NF = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const DF = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'long' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function icon(name, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', 'ikoner.svg?v=2#i-' + name);   // ?v= byts när ikonerna ändras, så att ingen får en gammal fil
  s.append(u);
  return s;
}

function kr(n, ca) { return (ca ? 'ca ' : '') + NF.format(Math.round(n || 0)) + ' kr'; }

function parseKr(s) {
  const t = String(s ?? '').replace(/[\s ]/g, '').replace(/kr$/i, '').replace(',', '.');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Math.round(parseFloat(t));
}

function parseCm(s) {
  const t = String(s ?? '').replace(/[\s ]/g, '').replace(/cm$/i, '').replace(',', '.');
  if (!t) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : NaN;
}

function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function who() { return PEOPLE[S.me] || 'Någon'; }
function nowIso() { return new Date().toISOString(); }
function pct(v, total) { return total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : 0; }

function safeUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch { return null; }
}

function imgSrc(b) {
  if (!b) return null;
  if (b.startsWith('bilder/')) return S.localImg.get(b) || RAW + b;
  return safeUrl(b);
}

function dimsText(m) {
  const d = m && m.matt ? m.matt : {};
  const parts = [d.b, d.d, d.h].filter((v) => v > 0);
  if (!parts.length) return null;
  const lab = [d.b ? 'B' : null, d.d ? 'D' : null, d.h ? 'H' : null].filter(Boolean).join('×');
  return `${parts.map((v) => NF.format(v)).join(' × ')} cm (${lab})`;
}

// ---------------------------------------------------------------- data

function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }

function normItem(m) {
  return {
    id: String(m.id),
    namn: String(m.namn || '').slice(0, 200),
    rum: String(m.rum || ''),
    status: STATUS[m.status] ? m.status : 'ide',
    pris: m.pris == null || m.pris === '' ? null : num(m.pris),
    antal: Math.max(1, Math.round(num(m.antal) || 1)),
    ca: !!m.ca,
    lank: m.lank ? String(m.lank) : '',
    bild: m.bild ? String(m.bild) : '',
    bildSha: m.bildSha ? String(m.bildSha) : '',
    matt: { b: num(m.matt?.b) || null, d: num(m.matt?.d) || null, h: num(m.matt?.h) || null },
    betalar: PAYERS[m.betalar] ? m.betalar : 'delat',
    not: m.not ? String(m.not).slice(0, 2000) : '',
    gillar: { rasmus: !!m.gillar?.rasmus, emily: !!m.gillar?.emily },
    av: m.av ? String(m.av) : '',
    skapad: m.skapad ? String(m.skapad) : '',
    andrad: m.andrad ? String(m.andrad) : '',
  };
}

function normImg(b) {
  return {
    id: String(b.id),
    bild: b.bild ? String(b.bild) : '',
    bildSha: b.bildSha ? String(b.bildSha) : '',
    rum: b.rum ? String(b.rum) : '',
    text: b.text ? String(b.text).slice(0, 500) : '',
    gillar: { rasmus: !!b.gillar?.rasmus, emily: !!b.gillar?.emily },
    av: b.av ? String(b.av) : '',
    skapad: b.skapad ? String(b.skapad) : '',
  };
}

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  const rum = Array.isArray(d.rum) && d.rum.length
    ? d.rum.filter((r) => r && r.id).map((r) => ({ id: String(r.id), namn: String(r.namn || r.id), zon: ZONES[r.zon] !== undefined ? String(r.zon) : '' }))
    : DEFAULT_ROOMS.map((r) => ({ ...r }));
  return {
    version: 1,
    budget: num(d.budget),
    rum,
    mobler: Array.isArray(d.mobler) ? d.mobler.filter((m) => m && m.id).map(normItem) : [],
    moodboard: Array.isArray(d.moodboard) ? d.moodboard.filter((b) => b && b.id).map(normImg) : [],
    andrad: d.andrad ? String(d.andrad) : '',
  };
}

function lineTotal(m) { return (m.pris || 0) * (m.antal || 1); }

function totals(items) {
  let plan = 0, kopt = 0, ide = 0, ideN = 0;
  for (const m of items) {
    const t = lineTotal(m);
    if (m.status === 'kopt') { kopt += t; plan += t; }
    else if (m.status === 'vald') plan += t;
    else { ide += t; ideN += 1; }
  }
  return { plan, kopt, vald: plan - kopt, ide, ideN };
}

// ---- budget (budget.json)

function normPart(p) {
  return {
    id: String(p.id),
    namn: String(p.namn || '').slice(0, 80),
    belopp: Math.round(num(p.belopp)),
    mobler: Array.isArray(p.mobler) ? [...new Set(p.mobler.map(String))] : [],
  };
}

function normBudget(b) {
  b = b && typeof b === 'object' ? b : {};
  const src = b.rum && typeof b.rum === 'object' && !Array.isArray(b.rum) ? b.rum : {};
  const rum = {};
  for (const [id, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    rum[String(id)] = {
      rasmus: Math.round(num(v.rasmus)),
      emily: Math.round(num(v.emily)),
      delar: Array.isArray(v.delar) ? v.delar.filter((p) => p && p.id).map(normPart) : [],
    };
  }
  return { version: 1, rum, andrad: b.andrad ? String(b.andrad) : '' };
}

function roomBud(rid) {
  const b = S.budget && S.budget.rum[rid];
  if (!b) return { rasmus: 0, emily: 0, total: 0, delar: [] };
  return { rasmus: b.rasmus, emily: b.emily, total: b.rasmus + b.emily, delar: b.delar };
}
function hasBudget(rid) { const b = roomBud(rid); return b.total > 0 || b.delar.length > 0; }

function budgetTotals(d) {
  const r = { rasmus: 0, emily: 0 };
  for (const room of d.rum) { const b = roomBud(room.id); r.rasmus += b.rasmus; r.emily += b.emily; }
  return { ...r, total: r.rasmus + r.emily };
}

/* Hur ett köp fördelas mellan er. Betalar en av er står den för allt. Ett delat köp delas
   som ni delat rummets budget: lägger Rasmus 7 000 och Emily 1 500 på ett rum tar Rasmus
   82 procent av det delade där. Rum utan budget delas lika. */
function split(m) {
  if (m.betalar === 'rasmus') return { rasmus: 1, emily: 0 };
  if (m.betalar === 'emily') return { rasmus: 0, emily: 1 };
  const b = roomBud(m.rum);
  return b.total > 0 ? { rasmus: b.rasmus / b.total, emily: b.emily / b.total } : { rasmus: 0.5, emily: 0.5 };
}

// Var och ens del av det valda och köpta (idéer räknas inte). Med onlyKopt: bara det köpta.
function shares(items, onlyKopt) {
  const r = { rasmus: 0, emily: 0 };
  for (const m of items) {
    if (m.status === 'ide' || (onlyKopt && m.status !== 'kopt')) continue;
    const t = lineTotal(m), s = split(m);
    r.rasmus += t * s.rasmus;
    r.emily += t * s.emily;
  }
  return r;
}

// Rummets delar med det valda i varje del. En möbel räknas i högst en del.
function partsView(d, rid) {
  const b = roomBud(rid);
  const items = d.mobler.filter((m) => m.rum === rid);
  const taken = new Set();
  const parts = b.delar.map((p) => {
    const its = items.filter((m) => p.mobler.includes(m.id) && !taken.has(m.id));
    its.forEach((m) => taken.add(m.id));
    return { ...p, t: totals(its) };
  });
  const fordelat = b.delar.reduce((s, p) => s + p.belopp, 0);
  return { parts, fordelat, rest: { belopp: Math.max(0, b.total - fordelat), t: totals(items.filter((m) => !taken.has(m.id))) } };
}

// Säger rakt ut om ni har råd, tillsammans och var för sig.
function verdict(bt, t, sh) {
  if (!bt.total) return null;
  const diff = bt.total - t.plan;
  const missing = Object.keys(PEOPLE).filter((p) => !bt[p]);
  const overP = Object.keys(PEOPLE).filter((p) => bt[p] && sh[p] > bt[p] + 0.5);
  const parts = [];
  if (diff < -0.5) parts.push(`Det ni valt kostar ${kr(-diff)} mer än er budget.`);
  else if (overP.length) parts.push(`Tillsammans går det ihop, med ${kr(diff)} kvar.`);
  else parts.push(`Ni har råd med det ni valt, och har ${kr(diff)} kvar tillsammans.`);
  if (overP.length) {
    parts.push(overP.map((p, i) => (i === 0 ? `${PEOPLE[p]} går över sin del med ${kr(sh[p] - bt[p])}` : `${PEOPLE[p]} med ${kr(sh[p] - bt[p])}`)).join(' och ') + '.');
  }
  if (missing.length) parts.push(`${PEOPLE[missing[0]]} har inte fyllt i sin budget än.`);
  return { bad: diff < -0.5 || overP.length > 0, text: parts.join(' ') };
}

function roomName(d, id) { return d.rum.find((r) => r.id === id)?.namn || 'Utan rum'; }

// ---------------------------------------------------------------- GitHub

class ApiError extends Error {
  constructor(kind, status) { super(kind); this.kind = kind; this.status = status; }
}

function errText(e) {
  if (!(e instanceof ApiError)) return e && e.message ? e.message : 'Något gick fel.';
  switch (e.kind) {
    case 'nyckel': return 'Nyckeln fungerar inte längre. Lås upp igen med en ny nyckel.';
    case 'skriv': return 'Nyckeln får inte spara. Den behöver "Contents: Read and write" för repot hemmet.';
    case 'konflikt': return 'Någon annan sparade samtidigt. Försök igen.';
    case 'natverk': return 'Ingen kontakt med GitHub. Kolla uppkopplingen och försök igen.';
    case 'bild': return 'Bilden gick inte att spara.';
    case 'ny': return 'Sidan har uppdaterats sedan du öppnade den. Ladda om sidan och försök igen.';
    default: return `Det gick inte att spara (fel ${e.status || '?'}).`;
  }
}

async function gh(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (auth && S.key) headers.Authorization = 'Bearer ' + S.key;
  if (body) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  } catch {
    throw new ApiError('natverk');
  }
}

function b64encBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64encText = (t) => b64encBytes(new TextEncoder().encode(t));
function b64decText(b) {
  const bin = atob(String(b).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const DATA_PATH = `/contents/${CFG.file}?ref=${CFG.branch}`;

async function fetchRemote() {
  let r = null;
  try { r = await gh(DATA_PATH, { auth: !!S.key }); } catch { r = null; }
  if (r && r.status === 401 && S.key) {
    S.keyBad = true;
    try { r = await gh(DATA_PATH, { auth: false }); } catch { r = null; }
  }
  if (r && r.ok) {
    const j = await r.json();
    return normalize(JSON.parse(b64decText(j.content)));
  }
  // Reserv: GitHubs filserver (kan vara upp till fem minuter gammal).
  const rr = await fetch(RAW + CFG.file + '?t=' + Date.now(), { cache: 'no-store' });
  if (rr.ok) return normalize(await rr.json());
  throw new ApiError('hamta', rr.status);
}

// budget.json finns inte förrän någon sparat en budget första gången; då är budgeten tom.
async function fetchBudget() {
  let r = null;
  try { r = await gh(`/contents/${BUDGET_FILE}?ref=${CFG.branch}`, { auth: !!S.key }); } catch { r = null; }
  if (r && r.status === 404) return normBudget({});
  if (r && r.ok) {
    const j = await r.json();
    return normBudget(JSON.parse(b64decText(j.content)));
  }
  const rr = await fetch(RAW + BUDGET_FILE + '?t=' + Date.now(), { cache: 'no-store' });
  if (rr.status === 404) return normBudget({});
  if (rr.ok) return normBudget(await rr.json());
  throw new ApiError('hamta', rr.status);
}

async function load(silent) {
  if (S.loading) return;
  S.loading = true;
  if (!silent) render();
  const [dr, br] = await Promise.allSettled([fetchRemote(), fetchBudget()]);
  if (dr.status === 'fulfilled') { S.data = dr.value; S.loadErr = false; S.loadedAt = Date.now(); }
  else S.loadErr = true;
  if (br.status === 'fulfilled') { S.budget = br.value; S.budgetErr = false; }
  else S.budgetErr = true;
  S.loading = false;
  render();
  openChatLink();
}

/* Varje ändring läser senaste versionen, gör ändringen och sparar med versionens sha.
   Har någon annan hunnit spara emellan svarar GitHub 409, då görs samma ändring om på
   den nya versionen. Ändringarna är därför skrivna som "sätt", aldrig som "växla".
   Är filen sparad av en nyare version av sidan sparas inget, så att inget försvinner. */
async function commitJson(file, norm, mutate, message, opts = {}) {
  if (!S.key) { openUnlock(); throw new ApiError('last'); }
  S.busy += 1; renderTop();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r0 = await gh(`/contents/${file}?ref=${CFG.branch}`);
      if (r0.status === 401) { S.keyBad = true; throw new ApiError('nyckel', 401); }
      let sha = null, raw = {};
      if (r0.ok) {
        const j0 = await r0.json();
        sha = j0.sha;
        raw = JSON.parse(b64decText(j0.content));
      } else if (!(r0.status === 404 && opts.mayCreate)) {
        throw new ApiError('hamta', r0.status);
      }
      if (Number(raw.version) > (KNOWN_VERSION[file] || 1)) throw new ApiError('ny');
      const next = norm(raw);
      mutate(next);
      next.andrad = nowIso();
      const body = { message, content: b64encText(JSON.stringify(next, null, 1) + '\n'), branch: CFG.branch };
      if (sha) body.sha = sha;
      const r1 = await gh(`/contents/${file}`, { method: 'PUT', body });
      if (r1.ok) { S.loadedAt = Date.now(); S.keyBad = false; return next; }
      if (r1.status === 409 || r1.status === 422) { await sleep(400 * (attempt + 1)); continue; }
      if (r1.status === 401) { S.keyBad = true; throw new ApiError('nyckel', 401); }
      if (r1.status === 403 || r1.status === 404) throw new ApiError('skriv', r1.status);
      throw new ApiError('spara', r1.status);
    }
    throw new ApiError('konflikt');
  } finally {
    S.busy -= 1; renderTop();
  }
}

async function commit(mutate, message) {
  const next = await commitJson(CFG.file, normalize, mutate, message);
  S.data = next;
  render();
  return next;
}

async function commitBudget(mutate, message) {
  const next = await commitJson(BUDGET_FILE, normBudget, mutate, message, { mayCreate: true });
  S.budget = next; S.budgetErr = false;
  render();
  return next;
}

async function uploadImage(blob) {
  const path = `bilder/${newId('b')}.jpg`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  S.busy += 1; renderTop();
  try {
    const r = await gh(`/contents/${path}`, {
      method: 'PUT',
      body: { message: `${who()}: ny bild`, content: b64encBytes(bytes), branch: CFG.branch },
    });
    if (r.status === 401) { S.keyBad = true; throw new ApiError('nyckel', 401); }
    if (r.status === 403 || r.status === 404) throw new ApiError('skriv', r.status);
    if (!r.ok) throw new ApiError('bild', r.status);
    const j = await r.json();
    S.localImg.set(path, URL.createObjectURL(blob));
    return { path, sha: j.content.sha };
  } finally {
    S.busy -= 1; renderTop();
  }
}

async function deleteFile(path, sha) {
  if (!path || !path.startsWith('bilder/') || !sha || !S.key) return;
  try {
    await gh(`/contents/${path}`, { method: 'DELETE', body: { message: `${who()}: tog bort en bild`, sha, branch: CFG.branch } });
  } catch { /* en kvarglömd bildfil gör ingen skada */ }
}

// Gör om en vald bild till en JPEG på högst 1600 px, så att den går fort att ladda.
async function prepareImage(file) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('Filen är ingen bild.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try { await img.decode(); } catch {
      throw new Error('Bildformatet går inte att läsa här. Ta en skärmdump och ladda upp den i stället.');
    }
    const max = 1600;
    const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * sc));
    const hh = Math.max(1, Math.round(img.naturalHeight * sc));
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, hh);
    ctx.drawImage(img, 0, 0, w, hh);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Bilden gick inte att göra om.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- toast, dialog

function toast(msg, opts = {}) {
  const box = $('#toasts');
  let done = false;
  const el = h('div', { class: 'toast' + (opts.err ? ' err' : ''), role: opts.err ? 'alert' : 'status' }, h('span', null, msg));
  const finish = (expired) => {
    if (done) return;
    done = true;
    el.remove();
    if (expired && opts.onExpire) opts.onExpire();
  };
  if (opts.action) {
    el.dataset.action = '1';
    el.append(h('button', { type: 'button', onclick: () => { finish(false); opts.action.fn(); } }, opts.action.label));
  }
  box.querySelectorAll('.toast').forEach((t) => { if (!t.dataset.action || opts.action) t.remove(); });
  box.append(el);
  setTimeout(() => finish(true), opts.timeout || (opts.err ? 6000 : 2600));
}
const toastErr = (e) => { if (!(e instanceof ApiError && e.kind === 'last')) toast(errText(e), { err: true }); };

const dlg = () => $('#dlg');
let dlgBusy = false;

function openDialog(title, body, foot, opts = {}) {
  const d = dlg();
  const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Stäng', onclick: () => closeDialog() }, icon('x'));
  d.replaceChildren(
    h('div', { class: 'sheet-head' }, h('h2', { id: 'dlg-title' }, title), close),
    h('div', { class: 'sheet-body' }, body),
    foot ? h('div', { class: 'sheet-foot' }, foot) : null,
  );
  d.onpaste = opts.onPaste || null;
  if (!d.open) d.showModal();
  const first = opts.focus === false ? null : (opts.focus || d.querySelector('input.in, select.in, textarea.in'));
  if (first && window.matchMedia('(min-width: 700px)').matches) first.focus();
}

function closeDialog() {
  if (dlgBusy) return;
  const d = dlg();
  d.onpaste = null;
  if (d.open) d.close();
}

function field(labelText, control, opts = {}) {
  const id = control.id || newId('f');
  control.id = id;
  const err = h('p', { class: 'err', id: id + '-err', hidden: true });
  control.setAttribute('aria-describedby', id + '-err' + (opts.help ? ' ' + id + '-help' : ''));
  return {
    el: h('div', { class: 'field' },
      h('label', { for: id }, labelText),
      control,
      opts.help ? h('p', { class: 'help', id: id + '-help' }, opts.help) : null,
      err),
    setErr(msg) {
      err.hidden = !msg; err.textContent = msg || '';
      control.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (msg) control.focus();
    },
  };
}

function radios(name, options, value) {
  const wrap = h('div', { class: 'radios', role: 'radiogroup' });
  for (const [val, label] of Object.entries(options)) {
    wrap.append(h('label', null,
      h('input', { type: 'radio', name, value: val, checked: val === value }),
      h('span', null, label)));
  }
  return { el: wrap, get value() { return wrap.querySelector('input:checked')?.value; } };
}

function guardEdit() {
  if (!S.key) { openUnlock(); return false; }
  if (!S.me) { openWho(); return false; }
  return true;
}

// ---------------------------------------------------------------- rendering

function render() {
  renderTop();
  renderBanner();
  for (const v of VIEWS) $('#view-' + v).hidden = v !== S.view;
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.view === S.view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (S.view === 'kalkyl') renderKalkyl();
  else if (S.view === 'budget') renderBudget();
  else if (S.view === 'moodboard') renderMoodboard();
  else renderRitning();
  renderFab();
}

function renderTop() {
  const box = $('#top-actions');
  if (!box) return;
  $('#chatgpt').hidden = !S.key;
  const kids = [];
  if (S.busy > 0) kids.push(h('span', { class: 'busy-pill' }, 'Sparar'));
  if (S.key) {
    const name = PEOPLE[S.me] || 'Vem är du?';
    kids.push(h('button', { class: 'me-btn', type: 'button', onclick: openSettings, 'aria-label': `Inställningar, du är ${name}` },
      h('span', { class: 'init', 'aria-hidden': 'true' }, S.me ? name[0] : '?'), h('span', null, name)));
  } else {
    kids.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: openUnlock }, icon('key'), 'Lås upp'));
  }
  box.replaceChildren(...kids);
}

function renderBanner() {
  const b = $('#banner');
  let node = null;
  if (S.keyBad) {
    node = [icon('warning-circle'), h('span', null, 'Nyckeln på den här enheten fungerar inte längre.'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: openUnlock }, 'Lås upp igen')];
  } else if (S.loadErr && S.data) {
    node = [icon('warning-circle'), h('span', null, 'Kunde inte hämta senaste versionen.'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() }, 'Försök igen')];
  } else if (S.budgetErr && S.data) {
    node = [icon('warning-circle'), h('span', null, S.budget ? 'Kunde inte hämta senaste budgeten.' : 'Budgeten gick inte att hämta, så den räknas inte med just nu.'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load() }, 'Försök igen')];
  }
  b.hidden = !node;
  b.replaceChildren(...(node || []));
}

function renderFab() {
  const f = $('#fab');
  const show = !!S.key && !!S.data && (S.view === 'kalkyl' || S.view === 'moodboard');
  f.hidden = !show;
  f.querySelector('span').textContent = S.view === 'moodboard' ? 'Lägg till bild' : 'Lägg till möbel';
  f.onclick = () => (S.view === 'moodboard' ? openImage(null) : openItem(null));
}

function skeleton() {
  return h('div', { class: 'k-grid', 'aria-busy': 'true', 'aria-label': 'Laddar' },
    h('div', null,
      h('div', { class: 'panel' },
        h('div', { class: 'sk', style: { width: '40%', height: '14px' } }),
        h('div', { class: 'sk', style: { width: '70%', height: '40px', marginTop: '12px' } }),
        h('div', { class: 'sk', style: { width: '100%', height: '14px', marginTop: '20px' } }))),
    h('div', null,
      ...[1, 2, 3].map(() => h('div', { style: { display: 'flex', gap: '12px', padding: '12px 0' } },
        h('div', { class: 'sk', style: { width: '64px', height: '64px' } }),
        h('div', { style: { flex: '1' } },
          h('div', { class: 'sk', style: { width: '60%', height: '16px' } }),
          h('div', { class: 'sk', style: { width: '35%', height: '12px', marginTop: '10px' } }))))));
}

function loadFailed() {
  return h('div', { class: 'panel empty' },
    h('p', null, 'Listan gick inte att hämta just nu.'),
    h('button', { class: 'btn', type: 'button', onclick: () => load() }, 'Försök igen'));
}

// ---- kalkyl

function renderKalkyl() {
  const root = $('#view-kalkyl');
  if (!S.data) { root.replaceChildren(S.loadErr ? loadFailed() : skeleton()); return; }
  const d = S.data;
  const t = totals(d.mobler);
  root.replaceChildren(h('div', { class: 'k-grid' },
    h('div', { class: 'k-side' }, budgetPanel(d, t), roomsPanel(d)),
    h('div', { class: 'k-main', id: 'lista' }, listPanel(d))));
}

function budgetPanel(d, t) {
  const bt = budgetTotals(d);
  const B = bt.total;
  const over = B > 0 && t.plan > B;
  const scale = Math.max(B, t.plan);
  let label, value;
  if (!B) { label = 'Valt hittills'; value = t.plan; }
  else if (over) { label = 'Över budgeten med'; value = t.plan - B; }
  else { label = 'Kvar av budgeten'; value = B - t.plan; }

  const segs = [];
  if (scale > 0 && t.kopt > 0) segs.push(h('span', { class: 'seg kopt', style: { flexBasis: pct(t.kopt, scale) + '%' } }));
  if (scale > 0 && t.vald > 0) segs.push(h('span', { class: 'seg plan', style: { flexBasis: pct(t.vald, scale) + '%' } }));
  segs.push(h('span', { class: 'seg rest' }));
  const aria = `Köpt ${kr(t.kopt)}, att köpa ${kr(t.vald)}` + (B ? `, budget ${kr(B)}` : '');
  const meter = h('div', { class: 'meter-wrap' + (over ? ' mark' : '') },
    h('div', { class: 'meter', role: 'img', 'aria-label': aria }, segs),
    over ? h('div', { class: 'budget-mark', style: { left: `calc(${pct(B, scale)}% - 1px)` } }, h('span', null, 'budget')) : null);

  const edit = S.key
    ? h('a', { class: 'btn btn-quiet btn-sm', href: '#budget' }, icon('pencil-simple'), B ? 'Ändra' : 'Sätt budget')
    : null;

  const sh = shares(d.mobler);
  const paid = shares(d.mobler, true);
  const notes = [];
  if (t.ideN === 1) notes.push(h('p', null, '1 idé för ', h('b', null, kr(t.ide)), ' räknas inte med förrän den är vald.'));
  else if (t.ideN > 1) notes.push(h('p', null, `${t.ideN} idéer för `, h('b', null, kr(t.ide)), ' räknas inte med förrän de är valda.'));
  if (t.kopt > 0) notes.push(h('p', null, 'Utlagt hittills: Rasmus ', h('b', null, kr(paid.rasmus)), ', Emily ', h('b', null, kr(paid.emily)), '. Delade köp delas som ni delat rummets budget, annars lika.'));

  return h('section', { class: 'panel budget' + (over ? ' over' : ''), 'aria-label': 'Budget' },
    h('div', { class: 'budget-top' },
      h('div', null, h('p', { class: 'label' }, label), h('p', { class: 'hero' }, NF.format(Math.round(value)), h('small', null, 'kr'))),
      edit),
    over ? h('p', { class: 'over-note' }, icon('warning-circle'), 'Det valda kostar mer än budgeten.') : null,
    !B && !t.plan ? h('p', { class: 'help', style: { marginTop: '10px', color: 'var(--ink-2)' } },
      S.key ? 'Sätt en budget och börja lägga till möbler.' : 'Ingen budget satt än.') : null,
    t.plan || B ? meter : null,
    h('ul', { class: 'legend' },
      h('li', null, h('i', { class: 'sw kopt', 'aria-hidden': 'true' }), 'Köpt', h('b', null, kr(t.kopt))),
      h('li', null, h('i', { class: 'sw plan', 'aria-hidden': 'true' }), 'Att köpa', h('b', null, kr(t.vald))),
      B ? h('li', null, h('i', { class: 'sw rest', 'aria-hidden': 'true' }), 'Budget', h('b', null, kr(B))) : null),
    B ? h('div', { class: 'people' }, h('h3', null, 'Per person'),
      Object.keys(PEOPLE).map((p) => personRow(p, bt[p], sh[p]))) : null,
    notes.length ? h('div', { class: 'subnote' }, notes) : null);
}

// En rad per person: din del av det valda mot din budget, med en egen liten stapel.
function personRow(p, budget, used) {
  const over = used > budget + 0.5;
  const scale = Math.max(budget, used, 1);
  const val = !budget
    ? h('span', { class: 'p-val' }, kr(used), h('small', null, ' ingen budget'))
    : h('span', { class: 'p-val' }, NF.format(Math.round(used)), h('small', null, ` av ${kr(budget)}`));
  // Utan budget finns inget att fylla, så då ritas ingen stapel (en full stapel skulle se ut som 100 procent).
  const bar = !budget ? null : h('span', { class: 'pmeter', role: 'img', 'aria-label': `${PEOPLE[p]}: ${kr(used)} av ${kr(budget)}` },
    h('span', { class: 'fill', style: { width: pct(Math.min(used, budget), scale) + '%' } }),
    over ? h('span', { class: 'fill over', style: { width: pct(used - budget, scale) + '%' } }) : null,
    over ? h('span', { class: 'mark', style: { left: `calc(${pct(budget, scale)}% - 1px)` } }) : null);
  return h('div', { class: 'prow' + (over && budget ? ' over' : '') },
    h('span', { class: 'p-name' }, PEOPLE[p]), val, bar,
    over && budget ? h('span', { class: 'p-sub' }, `Över med ${kr(used - budget)}`) : null);
}

function roomsPanel(d) {
  const known = new Set(d.rum.map((r) => r.id));
  const rows = d.rum.map((r) => ({ r, items: d.mobler.filter((m) => m.rum === r.id), b: roomBud(r.id).total }));
  const orphans = d.mobler.filter((m) => !known.has(m.rum));
  if (orphans.length) rows.push({ r: { id: '__utan', namn: 'Utan rum' }, items: orphans, b: 0 });
  const shown = rows.filter((x) => x.items.length || x.b);
  if (!shown.length) return null;
  const max = Math.max(1, ...shown.map((x) => Math.max(totals(x.items).plan, x.b)));
  const anyBudget = shown.some((x) => x.b);
  const ul = h('ul', { class: 'roombars' });
  const empty = rows.filter((x) => !x.items.length && !x.b).map((x) => x.r.namn);
  for (const { r, items, b } of shown) {
    const t = totals(items);
    const over = b > 0 && t.plan > b;
    const pressed = S.filt.rum.has(r.id);
    const track = h('span', { class: 'rb-track', 'aria-hidden': 'true' });
    if (t.kopt > 0) track.append(h('span', { class: 'seg kopt', style: { flex: `0 1 ${pct(t.kopt, max)}%` } }));
    if (t.vald > 0) track.append(h('span', { class: 'seg plan', style: { flex: `0 1 ${pct(t.vald, max)}%` } }));
    if (!t.plan) track.append(h('span', { class: 'base' }));
    if (b) track.prepend(h('span', { class: 'rb-cap', style: { width: pct(b, max) + '%' } }));   // rummets budget som ljus yta
    if (over) track.append(h('span', { class: 'rb-mark', style: { left: `calc(${pct(b, max)}% - 1px)` } }));
    const sub = [];
    if (items.length) sub.push(`${items.length} st`);
    if (t.ideN) sub.push(`${t.ideN} ${t.ideN === 1 ? 'idé' : 'idéer'}`);
    if (b && !over) sub.push(`${kr(b - t.plan)} kvar`);
    const val = b
      ? h('span', { class: 'rb-val' + (over ? ' over' : '') }, NF.format(Math.round(t.plan)), h('small', null, ` av ${kr(b)}`))
      : h('span', { class: 'rb-val' + (t.plan ? '' : ' zero') }, t.plan ? kr(t.plan) : '0 kr');
    ul.append(h('li', null, h('button', {
      class: 'roombar', type: 'button', 'aria-pressed': pressed ? 'true' : 'false',
      onclick: () => { setRoomFilter(pressed ? [] : [r.id]); scrollToList(); },
    },
      h('span', { class: 'rb-name' }, r.namn),
      val,
      track,
      sub.length || over ? h('span', { class: 'rb-sub' }, sub.join(', '),
        over ? h('b', { class: 'rb-over' }, `${sub.length ? ', ' : ''}${kr(t.plan - b)} över`) : null) : null)));
  }
  return h('section', { class: 'panel', 'aria-label': 'Per rum' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Per rum'),
      h('ul', { class: 'legend inline' },
        h('li', null, h('i', { class: 'sw kopt', 'aria-hidden': 'true' }), 'Köpt'),
        h('li', null, h('i', { class: 'sw plan', 'aria-hidden': 'true' }), 'Att köpa'),
        anyBudget ? h('li', null, h('i', { class: 'sw rest', 'aria-hidden': 'true' }), 'Budget') : null)),
    ul,
    empty.length ? h('p', { class: 'rb-empty' }, `Inget än i ${listSv(empty)}.`) : null);
}

function listSv(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}`;
}

function scrollToList() {
  const el = $('#lista');
  if (el && window.matchMedia('(max-width: 899px)').matches) {
    el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }
}

function setRoomFilter(ids) {
  S.filt.rum = new Set(ids);
  render();
}

function roomChips(d, selected, onPick) {
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrera på rum' });
  wrap.append(h('button', { class: 'chip', type: 'button', 'aria-pressed': selected.size === 0 ? 'true' : 'false', onclick: () => onPick([]) }, 'Alla rum'));
  for (const r of d.rum) {
    const on = selected.has(r.id);
    wrap.append(h('button', { class: 'chip', type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => onPick(on && selected.size === 1 ? [] : [r.id]) }, r.namn));
  }
  return wrap;
}

function listPanel(d) {
  const f = S.filt;
  const all = d.mobler;
  const inRooms = all.filter((m) => f.rum.size === 0 || f.rum.has(m.rum));
  const count = (s) => inRooms.filter((m) => m.status === s).length;
  const statuses = [['alla', 'Alla', inRooms.length], ['vald', 'Att köpa', count('vald')], ['ide', 'Idéer', count('ide')], ['kopt', 'Köpta', count('kopt')]];
  const seg = h('div', { class: 'segctl', role: 'group', 'aria-label': 'Filtrera på status' },
    statuses.map(([val, label, n]) => h('button', {
      type: 'button', 'aria-pressed': f.status === val ? 'true' : 'false',
      onclick: () => { S.filt.status = val; render(); },
    }, label, h('span', { class: 'n' }, n))));

  const shown = inRooms.filter((m) => f.status === 'alla' || m.status === f.status);
  const head = h('div', { class: 'list-head' }, h('h2', null, 'Möbler'),
    S.key ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openItem(null) }, icon('plus'), 'Lägg till möbel') : null);

  const body = [];
  if (!all.length) {
    body.push(h('div', { class: 'empty' },
      h('p', null, 'Inga möbler än. Lägg till en riktig produkt med länk och bild, eller en uppskattning som "soffa, ca 15 000 kr".'),
      S.key ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openItem(null) }, icon('plus'), 'Lägg till den första')
        : h('button', { class: 'btn', type: 'button', onclick: openUnlock }, icon('key'), 'Lås upp för att lägga till')));
  } else if (!shown.length) {
    body.push(h('div', { class: 'empty' }, h('p', null, 'Inget matchar filtret.'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { S.filt = { status: 'alla', rum: new Set() }; render(); } }, 'Visa allt')));
  } else {
    const order = d.rum.map((r) => r.id);
    const groups = new Map();
    for (const m of shown) {
      const key = order.includes(m.rum) ? m.rum : '__utan';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const keys = [...order.filter((k) => groups.has(k)), ...(groups.has('__utan') ? ['__utan'] : [])];
    for (const k of keys) {
      const items = groups.get(k).sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.namn.localeCompare(b.namn, 'sv'));
      const t = totals(items);
      body.push(h('div', { class: 'group' },
        h('div', { class: 'group-head' }, h('h3', null, k === '__utan' ? 'Utan rum' : roomName(d, k)),
          h('span', null, t.plan ? `${kr(t.plan)} valt` : `${items.length} ${items.length === 1 ? 'idé' : 'idéer'}`)),
        items.map((m) => itemRow(m))));
    }
  }
  return h('section', { 'aria-label': 'Möbler' }, head, seg, roomChips(d, f.rum, setRoomFilter), body);
}

function statusChip(s) {
  return h('span', { class: 'st st-' + s }, s === 'kopt' ? icon('check') : null, STATUS[s]);
}

function thumbImg(src, alt) {
  const img = h('img', { src, alt: alt || '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(icon('armchair')), { once: true });
  return img;
}

function itemRow(m) {
  const src = imgSrc(m.bild);
  const meta = [];
  if (m.antal > 1) meta.push(h('span', null, m.pris == null ? `${m.antal} st` : `${m.antal} st à ${kr(m.pris, m.ca)}`));
  const dims = dimsText(m);
  if (dims) meta.push(h('span', null, dims));
  if (m.betalar !== 'delat' && m.status !== 'ide') meta.push(h('span', null, `${PAYERS[m.betalar]} betalar`));
  const price = m.pris == null ? h('span', { class: 'price ide' }, 'Pris saknas')
    : h('span', { class: 'price' + (m.status === 'ide' ? ' ide' : '') }, kr(lineTotal(m), m.ca));
  const link = safeUrl(m.lank);
  const liked = Object.keys(PEOPLE).some((p) => m.gillar[p]);
  const like = liked ? likeButton('mobler', m) : null;
  return h('article', { class: 'item' },
    h('button', { class: 'item-main', type: 'button', onclick: () => openItem(m.id), 'aria-label': `${m.namn}, ${STATUS[m.status]}` },
      h('span', { class: 'thumb' }, src ? thumbImg(src, '') : icon('armchair')),
      h('span', { class: 'item-text' },
        h('span', { class: 'item-name' }, m.namn),
        meta.length ? h('span', { class: 'item-meta' }, meta) : null,
        m.not ? h('span', { class: 'item-note' }, m.not) : null),
      h('span', { class: 'item-right' }, price, statusChip(m.status))),
    like || link ? h('div', { class: 'item-acts' }, like,
      link ? h('a', { class: 'link-btn', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('arrow-square-out'), 'Till butiken') : null) : null);
}

function likeButton(kind, obj, opt = {}) {
  const likers = Object.keys(PEOPLE).filter((p) => obj.gillar && obj.gillar[p]);
  const mine = !!(S.me && obj.gillar && obj.gillar[S.me]);
  if (!S.key && !likers.length && !opt.always) return null;
  const long = likers.length ? `${likers.map((p) => PEOPLE[p]).join(' och ')} gillar` : 'Gilla';
  const text = opt.compact ? (likers.length === 2 ? 'Båda' : likers.length ? PEOPLE[likers[0]] : '') : long;
  const label = S.key ? (mine ? 'Ta bort ditt gilla' : 'Gilla') + (likers.length ? ` (${long})` : '') : long;
  return h('button', {
    class: 'like' + (likers.length ? ' has' : '') + (mine ? ' on' : '') + (opt.compact ? ' compact' : ''), type: 'button', 'data-like': kind + ':' + obj.id,
    'aria-pressed': S.key ? (mine ? 'true' : 'false') : null, 'aria-label': label, disabled: S.key ? null : true,
    onclick: (ev) => toggleLike(kind, obj.id, ev.currentTarget),
  }, icon(likers.length ? 'heart-fill' : 'heart'), text ? h('span', null, text) : null);
}

async function toggleLike(kind, id, btn) {
  if (!guardEdit()) return;
  const obj = S.data[kind].find((x) => x.id === id);
  if (!obj) return;
  const val = !obj.gillar[S.me];
  const me = S.me;
  obj.gillar = { ...obj.gillar, [me]: val };
  render();
  refreshLikes(kind, obj, val);
  const name = kind === 'mobler' ? obj.namn : 'en bild';
  try {
    await commit((d) => { const o = d[kind].find((x) => x.id === id); if (o) o.gillar = { ...o.gillar, [me]: val }; },
      `${who()}: ${val ? 'gillar' : 'gillar inte längre'} ${name}`);
  } catch (e) {
    obj.gillar = { ...obj.gillar, [me]: !val };
    render();
    refreshLikes(kind, obj, false);
    toastErr(e);
  }
}

function refreshLikes(kind, obj, pop) {
  document.querySelectorAll(`#dlg [data-like="${kind}:${CSS.escape(obj.id)}"]`).forEach((b) => {
    const nb = likeButton(kind, obj, { always: true, compact: b.classList.contains('compact') });
    if (nb) b.replaceWith(nb);
  });
  if (pop) document.querySelectorAll(`[data-like="${kind}:${CSS.escape(obj.id)}"]`).forEach((b) => b.classList.add('pop'));
}

// ---- budget

function budgetFailed() {
  return h('div', { class: 'panel empty' },
    h('p', null, 'Budgeten gick inte att hämta just nu.'),
    h('button', { class: 'btn', type: 'button', onclick: () => load() }, 'Försök igen'));
}

function renderBudget() {
  const root = $('#view-budget');
  if (!S.data) { root.replaceChildren(S.loadErr ? loadFailed() : skeleton()); return; }
  if (!S.budget) { root.replaceChildren(S.budgetErr ? budgetFailed() : skeleton()); return; }
  const d = S.data;
  const bt = budgetTotals(d);
  const t = totals(d.mobler);
  const sh = shares(d.mobler);
  const v = verdict(bt, t, sh);

  const summary = h('section', { class: 'panel bud-sum', 'aria-label': 'Er budget' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Er budget'),
      S.key ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openMyBudget }, icon('pencil-simple'), 'Fyll i din budget') : null),
    bt.total ? budgetTable(bt, t, sh)
      : h('p', { class: 'sheet-lead' }, 'Sätt vad ni var och en vill lägga på varje rum. Då ser ni både tillsammans och var för sig om ni har råd med det ni valt.'),
    v ? h('p', { class: 'verdict' + (v.bad ? ' bad' : '') }, icon(v.bad ? 'warning-circle' : 'check'), h('span', null, v.text)) : null,
    h('p', { class: 'help' }, 'Bara valda och köpta möbler räknas. Ett delat köp delas som ni delat rummets budget, och lika i rum utan budget.'));

  const rooms = d.rum.map((r) => ({ r, items: d.mobler.filter((m) => m.rum === r.id) }));
  const full = rooms.filter((x) => x.items.length || hasBudget(x.r.id));
  const bare = rooms.filter((x) => !x.items.length && !hasBudget(x.r.id));
  const bareBox = bare.length ? h('div', { class: 'bud-bare' },
    h('p', null, full.length ? 'Ingen budget och inga möbler än:' : 'Rummen:'),
    h('div', { class: 'chipset' }, bare.map((x) => (S.key
      ? h('button', { class: 'chip', type: 'button', onclick: () => openRoomBudget(x.r.id), 'aria-label': `Sätt budget för ${x.r.namn}` }, icon('plus'), x.r.namn)
      : h('span', { class: 'chip static' }, x.r.namn))))) : null;

  root.replaceChildren(h('div', { class: 'bud-grid' }, summary,
    h('section', { class: 'bud-rooms', 'aria-label': 'Per rum' },
      h('div', { class: 'list-head' }, h('h2', null, 'Per rum')),
      full.length ? h('div', { class: 'bud-cards' }, full.map((x) => budgetCard(d, x.r, x.items))) : null,
      bareBox)));
}

function budgetTable(bt, t, sh) {
  const row = (name, b, used, cls) => {
    const left = Math.round(b) - Math.round(used);
    return h('tr', { class: cls || null },
      h('th', { scope: 'row' }, name),
      h('td', null, NF.format(Math.round(b))),
      h('td', null, NF.format(Math.round(used))),
      h('td', { class: left < 0 ? 'neg' : null }, NF.format(left)));
  };
  return h('table', { class: 'bud-table' },
    h('caption', { class: 'vh' }, 'Budget, valt och kvar per person, i kronor'),
    h('thead', null, h('tr', null,
      h('td', null), h('th', { scope: 'col' }, 'Budget'), h('th', { scope: 'col' }, 'Valt'), h('th', { scope: 'col' }, 'Kvar'))),
    h('tbody', null,
      Object.keys(PEOPLE).map((p) => row(PEOPLE[p], bt[p], sh[p])),
      row('Tillsammans', bt.total, t.plan, 'sum')));
}

function partLine(name, t, belopp, rest) {
  const over = t.plan > belopp + 0.5;
  return h('li', { class: (over ? 'over' : '') + (rest ? ' rest' : '') || null },
    h('span', { class: 'pl-name' }, name),
    h('span', { class: 'pl-val' }, NF.format(Math.round(t.plan)), h('small', null, ` av ${kr(belopp)}`)));
}

function budgetCard(d, r, items) {
  const b = roomBud(r.id);
  const t = totals(items);
  const over = b.total > 0 && t.plan > b.total;
  const scale = Math.max(b.total, t.plan, 1);
  const segs = [];
  if (t.kopt > 0) segs.push(h('span', { class: 'seg kopt', style: { flexBasis: pct(t.kopt, scale) + '%' } }));
  if (t.vald > 0) segs.push(h('span', { class: 'seg plan', style: { flexBasis: pct(t.vald, scale) + '%' } }));
  segs.push(h('span', { class: 'seg rest' }));
  // Utan budget finns inget att mäta mot; en full stapel skulle se ut som 100 procent.
  const meter = !b.total ? null : h('div', { class: 'meter-wrap slim' },
    h('div', { class: 'meter', role: 'img', 'aria-label': `${r.namn}: köpt ${kr(t.kopt)}, att köpa ${kr(t.vald)}` + (b.total ? `, budget ${kr(b.total)}` : '') }, segs),
    over ? h('div', { class: 'budget-mark', style: { left: `calc(${pct(b.total, scale)}% - 1px)` } }) : null);

  let status;
  if (!b.total) status = h('p', { class: 'bc-status muted' }, t.plan ? `${kr(t.plan)} valt, ingen budget satt` : 'Ingen budget satt');
  else if (over) status = h('p', { class: 'bc-status over' }, `${kr(t.plan)} valt, `, h('b', null, `${kr(t.plan - b.total)} över`));
  else status = h('p', { class: 'bc-status' }, `${kr(t.plan)} valt, ${kr(b.total - t.plan)} kvar`);

  const sh = shares(items);
  const who2 = Object.keys(PEOPLE).filter((p) => b[p] > 0 || sh[p] >= 0.5);   // den som varken lagt något eller har en del här visas inte
  const people = b.total ? h('ul', { class: 'bc-people' }, who2.map((p) => {
    const o = sh[p] > b[p] + 0.5;
    return h('li', { class: o ? 'over' : null }, h('span', null, PEOPLE[p]),
      h('span', { class: 'pl-val' }, NF.format(Math.round(sh[p])), h('small', null, ` av ${kr(b[p])}`)));
  })) : null;

  const pv = b.delar.length ? partsView(d, r.id) : null;
  const parts = pv ? h('ul', { class: 'bc-parts', 'aria-label': 'Delar' },
    pv.parts.map((p, i) => partLine(p.namn || `Del ${i + 1}`, p.t, p.belopp)),
    partLine('Resten av rummet', pv.rest.t, pv.rest.belopp, true)) : null;
  const partsWarn = pv && pv.fordelat > b.total
    ? h('p', { class: 'bc-warn' }, icon('warning-circle'), `Delarna är ${kr(pv.fordelat - b.total)} mer än rummets budget.`) : null;
  const ideas = t.ideN ? h('p', { class: 'bc-ide' }, `${t.ideN} ${t.ideN === 1 ? 'idé' : 'idéer'} för ${kr(t.ide)} räknas inte med.`) : null;

  return h('article', { class: 'panel bcard' + (over ? ' over' : ''), 'aria-label': r.namn },
    h('div', { class: 'bc-head' },
      h('div', null, h('h3', null, r.namn), h('p', { class: 'bc-total' }, b.total ? kr(b.total) : '')),
      S.key ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openRoomBudget(r.id), 'aria-label': `Ändra budgeten för ${r.namn}` }, icon('pencil-simple'), 'Ändra') : null),
    meter, status, people, parts, partsWarn, ideas);
}

// ---- moodboard

function renderMoodboard() {
  const root = $('#view-moodboard');
  if (!S.data) { root.replaceChildren(S.loadErr ? loadFailed() : skeleton()); return; }
  const d = S.data;
  const sel = S.moodRum;
  const shown = d.moodboard.filter((b) => sel.size === 0 || sel.has(b.rum)).slice().reverse();
  const head = h('div', { class: 'list-head' }, h('h2', null, 'Moodboard'),
    S.key ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openImage(null) }, icon('plus'), 'Lägg till bild') : null);
  let body;
  if (!d.moodboard.length) {
    body = h('div', { class: 'empty' },
      h('p', null, 'Samla bilder som visar känslan ni vill ha: skärmdumpar från Instagram och Pinterest, foton från butiker, egna foton.'),
      S.key ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openImage(null) }, icon('plus'), 'Lägg till den första bilden')
        : h('button', { class: 'btn', type: 'button', onclick: openUnlock }, icon('key'), 'Lås upp för att lägga till'));
  } else if (!shown.length) {
    body = h('div', { class: 'empty' }, h('p', null, 'Inga bilder för det rummet än.'));
  } else {
    body = h('div', { class: 'masonry' }, shown.map((b) => tile(b, d)));
  }
  root.replaceChildren(h('section', { 'aria-label': 'Moodboard' }, head,
    roomChips(d, sel, (ids) => { S.moodRum = new Set(ids); render(); }), body));
}

function tile(b, d) {
  const src = imgSrc(b.bild);
  const img = src ? h('img', { src, alt: b.text || (b.rum ? `Inspiration, ${roomName(d, b.rum)}` : 'Inspiration'), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : null;
  if (img) img.addEventListener('error', () => img.replaceWith(h('span', { class: 'broken' }, 'Bilden går inte att visa. Sidan den kom ifrån kan blockera länkning.')), { once: true });
  return h('figure', { class: 'tile' },
    h('button', { class: 'tile-img', type: 'button', onclick: () => openImage(b.id), 'aria-label': S.key ? 'Ändra bilden' : 'Visa bilden' },
      img || h('span', { class: 'broken' }, 'Ingen bild')),
    h('figcaption', null,
      h('div', { class: 'tile-words' },
        b.rum ? h('span', { class: 'tile-room' }, roomName(d, b.rum)) : null,
        b.text ? h('p', { class: 'tile-text' }, b.text) : null),
      likeButton('moodboard', b, { compact: true })));
}

// ---- ritning

async function ensurePlan() {
  if (S.plan) return S.plan;
  const r = await fetch('planritning.svg', { cache: 'no-cache' });
  if (!r.ok) throw new Error('plan');
  const doc = new DOMParser().parseFromString(await r.text(), 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName !== 'svg') throw new Error('plan');
  svg.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  const node = document.importNode(svg, true);
  node.removeAttribute('width');
  node.removeAttribute('height');
  node.querySelectorAll('[data-zon]').forEach((el) => {
    const zon = el.getAttribute('data-zon');
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${ZONES[zon] || zon}: visa möbler`);
    const go = () => openZone(zon);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
  });
  S.plan = node;
  return node;
}

function openZone(zon) {
  const ids = (S.data ? S.data.rum : DEFAULT_ROOMS).filter((r) => r.zon === zon).map((r) => r.id);
  S.filt = { status: 'alla', rum: new Set(ids) };
  location.hash = '#kalkyl';
}

async function renderRitning() {
  const root = $('#view-ritning');
  let plan;
  try {
    plan = await ensurePlan();
  } catch {
    root.replaceChildren(h('div', { class: 'panel empty' }, h('p', null, 'Ritningen gick inte att ladda.')));
    return;
  }
  if (S.view !== 'ritning') return;
  const zones = new Set();
  if (S.data) for (const r of S.data.rum) if (S.filt.rum.has(r.id) && r.zon) zones.add(r.zon);
  plan.querySelectorAll('[data-zon]').forEach((el) => el.classList.toggle('aktiv', zones.has(el.getAttribute('data-zon'))));
  const inner = h('div', { class: 'plan-inner' });
  inner.append(plan);
  const wrap = h('div', { class: 'plan-wrap' + (S.zoom ? ' zoom' : '') }, inner);
  root.replaceChildren(h('section', { class: 'panel', 'aria-label': 'Planritning' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Planritning'),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': S.zoom ? 'true' : 'false', onclick: () => { S.zoom = !S.zoom; render(); } },
          icon(S.zoom ? 'magnifying-glass-minus' : 'magnifying-glass-plus'), S.zoom ? 'Mindre' : 'Förstora'),
        h('a', { class: 'btn btn-sm btn-quiet', href: 'planritning.svg', target: '_blank', rel: 'noopener' }, icon('arrow-square-out'), 'Egen flik'))),
    wrap,
    h('p', { class: 'hint' }, 'Tryck på ett rum för att se möblerna där. Rött är uppmätt på plats, i centimeter.')));
}

// ---------------------------------------------------------------- dialoger

function imagePicker(initial) {
  // initial: befintlig bild (sökväg eller url). Returnerar kontroll med .result()
  let file = null;
  let url = initial && !initial.startsWith('bilder/') ? initial : '';
  let current = initial || '';
  let removed = false;
  const prev = h('div', { class: 'imgprev' });
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const urlIn = h('input', { class: 'in', type: 'url', inputmode: 'url', placeholder: 'https://', value: url, 'aria-label': 'Bildlänk' });
  const urlRow = h('div', { class: 'field', hidden: !url }, h('label', { for: urlIn.id = newId('f') }, 'Bildlänk'), urlIn,
    h('p', { class: 'help' }, 'Högerklicka på en bild och välj "Kopiera bildadress". Vissa butiker blockerar det, ladda då upp en skärmdump.'));
  const err = h('p', { class: 'err', hidden: true });
  const wrap = h('div', { class: 'imgfield' });

  function show() {
    let src = null;
    if (file) src = URL.createObjectURL(file);
    else if (!removed && urlIn.value.trim()) src = safeUrl(urlIn.value.trim());
    else if (!removed && current) src = imgSrc(current);
    if (src) {
      const img = h('img', { src, alt: 'Förhandsvisning', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.replaceWith(h('div', { class: 'ph' }, icon('warning-circle'), 'Bilden går inte att visa.')), { once: true });
      prev.replaceChildren(img);
    } else {
      prev.replaceChildren(h('div', { class: 'ph' }, icon('image-square'), 'Ingen bild vald'));
    }
    rmBtn.hidden = !src;
  }
  async function takeFile(f) {
    err.hidden = true;
    try {
      file = await prepareImage(f);
      removed = false; urlIn.value = ''; urlRow.hidden = true;
      show();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }
  fileIn.addEventListener('change', () => { if (fileIn.files && fileIn.files[0]) takeFile(fileIn.files[0]); fileIn.value = ''; });
  urlIn.addEventListener('change', () => { file = null; removed = false; show(); });
  const upBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => fileIn.click() }, icon('camera'), 'Ladda upp bild');
  const linkBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { urlRow.hidden = false; urlIn.focus(); } }, icon('link-simple'), 'Bildlänk');
  const rmBtn = h('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => { file = null; urlIn.value = ''; removed = true; show(); } }, icon('trash'), 'Ta bort');
  wrap.addEventListener('dragover', (ev) => { ev.preventDefault(); wrap.classList.add('drag'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag'));
  wrap.addEventListener('drop', (ev) => {
    ev.preventDefault(); wrap.classList.remove('drag');
    const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) takeFile(f);
  });
  wrap.append(prev, h('div', { class: 'imgbtns' }, upBtn, linkBtn, rmBtn), fileIn, urlRow, err);
  show();
  return {
    el: wrap,
    onPaste(ev) {
      const items = ev.clipboardData ? [...ev.clipboardData.items] : [];
      const it = items.find((x) => x.kind === 'file' && /^image\//.test(x.type));
      if (it) { ev.preventDefault(); takeFile(it.getAsFile()); }
    },
    hasImage() { return !!(file || (!removed && (urlIn.value.trim() || current))); },
    // → { bild, bildSha, uploaded, oldToDelete }
    async result(old) {
      const out = { bild: old ? old.bild : '', bildSha: old ? old.bildSha : '' };
      const oldFile = old && old.bild && old.bild.startsWith('bilder/') ? { path: old.bild, sha: old.bildSha } : null;
      if (file) {
        const up = await uploadImage(file);
        out.bild = up.path; out.bildSha = up.sha;
      } else if (removed) {
        out.bild = ''; out.bildSha = '';
      } else if (urlIn.value.trim()) {
        const u = safeUrl(urlIn.value.trim());
        if (!u) throw new Error('Bildlänken ser inte ut som en webbadress.');
        if (u !== out.bild) { out.bild = u; out.bildSha = ''; }
      }
      out.oldToDelete = oldFile && oldFile.path !== out.bild ? oldFile : null;
      return out;
    },
  };
}

function setBusyButton(btn, busy, text) {
  btn.disabled = busy;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = text || 'Sparar'; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
}

// ---- möbel

function openItem(id) {
  const d = S.data;
  if (!d) return;
  const m = id ? d.mobler.find((x) => x.id === id) : null;
  if (id && !m) return;
  if (!S.key) { viewItem(m); return; }
  if (!guardEdit()) return;

  const nameIn = h('input', { class: 'in', type: 'text', maxlength: '200', value: m ? m.namn : '', autocomplete: 'off', placeholder: 'Till exempel soffa, matbord, sänglampa' });
  const fName = field('Vad?', nameIn);
  const defaultRoom = S.filt.rum.size === 1 ? [...S.filt.rum][0] : (d.rum[0] ? d.rum[0].id : '');
  const roomSel = h('select', { class: 'in' }, d.rum.map((r) => h('option', { value: r.id, selected: (m ? m.rum : defaultRoom) === r.id }, r.namn)));
  const fRoom = field('Rum', roomSel);
  const st = radios('status', STATUS, m ? m.status : 'ide');
  const priceIn = h('input', { class: 'in', type: 'text', inputmode: 'decimal', value: m && m.pris != null ? NF.format(m.pris) : '', placeholder: '0', autocomplete: 'off' });
  const fPrice = field('Pris per styck (kr)', priceIn);
  const qtyIn = h('input', { class: 'in', type: 'number', min: '1', step: '1', inputmode: 'numeric', value: m ? m.antal : 1 });
  const fQty = field('Antal', qtyIn);
  const caIn = h('input', { type: 'checkbox', checked: m ? m.ca : false });
  const linkIn = h('input', { class: 'in', type: 'url', inputmode: 'url', value: m ? m.lank : '', placeholder: 'https://', autocomplete: 'off' });
  const fLink = field('Länk till produkten', linkIn);
  const pic = imagePicker(m ? m.bild : '');
  const dimIn = ['b', 'd', 'h'].map((k) => h('input', { class: 'in', type: 'text', inputmode: 'decimal', value: m && m.matt[k] ? String(m.matt[k]).replace('.', ',') : '', 'aria-label': { b: 'Bredd i cm', d: 'Djup i cm', h: 'Höjd i cm' }[k], placeholder: { b: 'Bredd', d: 'Djup', h: 'Höjd' }[k] }));
  const dimErr = h('p', { class: 'err', hidden: true });
  const pay = radios('betalar', PAYERS, m ? m.betalar : 'delat');
  const noteIn = h('textarea', { class: 'in', maxlength: '2000', placeholder: 'Färg, storlek, alternativ, vad ni tycker' }, m ? m.not : '');
  const fNote = field('Anteckning', noteIn);

  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, m ? 'Spara' : 'Lägg till');
  const delBtn = m ? h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Ta bort') : null;
  const cancel = h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Avbryt');
  const formErr = h('p', { class: 'err', hidden: true, role: 'alert' });

  saveBtn.addEventListener('click', async () => {
    formErr.hidden = true;
    fName.setErr(''); fPrice.setErr(''); fLink.setErr(''); dimErr.hidden = true;
    const namn = nameIn.value.trim();
    if (!namn) { fName.setErr('Skriv vad det är.'); return; }
    const pris = parseKr(priceIn.value);
    if (Number.isNaN(pris)) { fPrice.setErr('Skriv ett belopp, till exempel 12 995.'); return; }
    const antal = Math.max(1, Math.round(Number(qtyIn.value) || 1));
    const lank = linkIn.value.trim();
    if (lank && !safeUrl(lank)) { fLink.setErr('Länken ska börja med https://'); return; }
    const matt = {};
    for (const [i, k] of ['b', 'd', 'h'].entries()) {
      const v = parseCm(dimIn[i].value);
      if (Number.isNaN(v)) { dimErr.textContent = 'Måtten ska vara siffror i centimeter.'; dimErr.hidden = false; dimIn[i].focus(); return; }
      matt[k] = v;
    }
    setBusyButton(saveBtn, true); if (delBtn) delBtn.disabled = true; dlgBusy = true;
    try {
      const img = await pic.result(m);
      const fields = {
        namn, rum: roomSel.value, status: st.value, pris, antal, ca: caIn.checked, lank: safeUrl(lank) || '',
        bild: img.bild, bildSha: img.bildSha, matt, betalar: pay.value, not: noteIn.value.trim(), andrad: nowIso(),
      };
      const itemId = m ? m.id : newId('m');
      await commit((dd) => {
        const i = dd.mobler.findIndex((x) => x.id === itemId);
        if (i >= 0) dd.mobler[i] = normItem({ ...dd.mobler[i], ...fields });
        else dd.mobler.push(normItem({ id: itemId, ...fields, gillar: {}, av: who(), skapad: nowIso() }));
      }, `${who()}: ${m ? 'ändrade' : 'lade till'} ${namn}`);
      if (img.oldToDelete) deleteFile(img.oldToDelete.path, img.oldToDelete.sha);
      dlgBusy = false;
      closeDialog();
      toast(m ? 'Sparat' : `${namn} är tillagd`);
    } catch (e) {
      dlgBusy = false;
      setBusyButton(saveBtn, false); if (delBtn) delBtn.disabled = false;
      formErr.textContent = e instanceof ApiError ? errText(e) : (e.message || 'Något gick fel.');
      formErr.hidden = false;
    }
  });

  if (delBtn) delBtn.addEventListener('click', async () => {
    setBusyButton(delBtn, true, 'Tar bort'); saveBtn.disabled = true; dlgBusy = true;
    const snap = structuredClone(m);
    try {
      await commit((dd) => { dd.mobler = dd.mobler.filter((x) => x.id !== snap.id); }, `${who()}: tog bort ${snap.namn}`);
      dlgBusy = false;
      closeDialog();
      let undone = false;
      toast(`${snap.namn} är borttagen`, {
        timeout: 7000,
        action: { label: 'Ångra', fn: async () => {
          undone = true;
          try {
            await commit((dd) => { if (!dd.mobler.some((x) => x.id === snap.id)) dd.mobler.push(snap); }, `${who()}: ångrade borttagningen av ${snap.namn}`);
            toast(`${snap.namn} är tillbaka`);
          } catch (e) { toastErr(e); }
        } },
        onExpire: () => { if (!undone) deleteFile(snap.bild, snap.bildSha); },
      });
    } catch (e) {
      dlgBusy = false;
      setBusyButton(delBtn, false); saveBtn.disabled = false;
      formErr.textContent = errText(e); formErr.hidden = false;
    }
  });

  const body = [
    m ? h('div', { class: 'dlg-like' }, likeButton('mobler', m, { always: true })) : null,
    fName.el,
    fRoom.el,
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'Status'), st.el, h('p', { class: 'help' }, 'Bara valda och köpta räknas mot budgeten. Idéer kan vara hur många som helst.')),
    h('div', { class: 'row' }, fPrice.el, fQty.el),
    h('label', { class: 'check' }, caIn, 'Priset är en uppskattning'),
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'Vem betalar'), pay.el),
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'Bild'), pic.el),
    fLink.el,
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'Mått i cm (om ni vill jämföra med väggarna)'), h('div', { class: 'row3' }, dimIn), dimErr),
    fNote.el,
    formErr,
  ];
  openDialog(m ? 'Ändra möbel' : 'Ny möbel', body, [delBtn, h('span', { class: 'spacer' }), cancel, saveBtn], { onPaste: pic.onPaste, focus: nameIn });
}

function viewItem(m) {
  if (!m) return;
  const d = S.data;
  const src = imgSrc(m.bild);
  const link = safeUrl(m.lank);
  const facts = [
    ['Rum', roomName(d, m.rum)],
    ['Status', STATUS[m.status]],
    ['Pris', m.pris == null ? (m.antal > 1 ? `Saknas (${m.antal} st)` : 'Saknas') : (m.antal > 1 ? `${m.antal} st à ${kr(m.pris, m.ca)} = ${kr(lineTotal(m), m.ca)}` : kr(m.pris, m.ca))],
    dimsText(m) ? ['Mått', dimsText(m)] : null,
    m.status !== 'ide' ? ['Betalar', PAYERS[m.betalar]] : null,
    m.av ? ['Tillagd av', m.av + (m.skapad ? `, ${DF.format(new Date(m.skapad))}` : '')] : null,
  ].filter(Boolean);
  const body = [
    src ? h('div', { class: 'view-img' }, h('img', { src, alt: m.namn, referrerpolicy: 'no-referrer' })) : null,
    h('dl', { class: 'facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    m.not ? h('p', null, m.not) : null,
    likeButton('mobler', m),
  ];
  openDialog(m.namn, body, [h('span', { class: 'spacer' }),
    link ? h('a', { class: 'btn btn-primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('arrow-square-out'), 'Till butiken') : null,
    h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Stäng')]);
}

// ---- moodboardbild

function openImage(id) {
  const d = S.data;
  if (!d) return;
  const b = id ? d.moodboard.find((x) => x.id === id) : null;
  if (id && !b) return;
  if (!S.key) {
    const src = imgSrc(b.bild);
    openDialog(b.rum ? roomName(d, b.rum) : 'Inspiration', [
      src ? h('div', { class: 'view-img' }, h('img', { src, alt: b.text || '', referrerpolicy: 'no-referrer' })) : null,
      b.text ? h('p', null, b.text) : null,
      likeButton('moodboard', b),
    ], [h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Stäng')]);
    return;
  }
  if (!guardEdit()) return;
  const pic = imagePicker(b ? b.bild : '');
  const roomSel = h('select', { class: 'in' }, h('option', { value: '' }, 'Inget särskilt rum'),
    d.rum.map((r) => h('option', { value: r.id, selected: b ? b.rum === r.id : (S.moodRum.size === 1 && S.moodRum.has(r.id)) }, r.namn)));
  const fRoom = field('Rum', roomSel);
  const textIn = h('textarea', { class: 'in', maxlength: '500', placeholder: 'Vad gillar ni med bilden?' }, b ? b.text : '');
  const fText = field('Kommentar', textIn);
  const formErr = h('p', { class: 'err', hidden: true, role: 'alert' });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, b ? 'Spara' : 'Lägg till');
  const delBtn = b ? h('button', { class: 'btn btn-danger', type: 'button' }, icon('trash'), 'Ta bort') : null;

  saveBtn.addEventListener('click', async () => {
    formErr.hidden = true;
    if (!pic.hasImage()) { formErr.textContent = 'Välj en bild först.'; formErr.hidden = false; return; }
    setBusyButton(saveBtn, true); if (delBtn) delBtn.disabled = true; dlgBusy = true;
    try {
      const img = await pic.result(b);
      if (!img.bild) throw new Error('Välj en bild först.');
      const fields = { bild: img.bild, bildSha: img.bildSha, rum: roomSel.value, text: textIn.value.trim() };
      const imgId = b ? b.id : newId('i');
      await commit((dd) => {
        const i = dd.moodboard.findIndex((x) => x.id === imgId);
        if (i >= 0) dd.moodboard[i] = normImg({ ...dd.moodboard[i], ...fields });
        else dd.moodboard.push(normImg({ id: imgId, ...fields, gillar: {}, av: who(), skapad: nowIso() }));
      }, `${who()}: ${b ? 'ändrade en bild' : 'ny bild i moodboarden'}`);
      if (img.oldToDelete) deleteFile(img.oldToDelete.path, img.oldToDelete.sha);
      dlgBusy = false;
      closeDialog();
      toast(b ? 'Sparat' : 'Bilden är tillagd');
    } catch (e) {
      dlgBusy = false;
      setBusyButton(saveBtn, false); if (delBtn) delBtn.disabled = false;
      formErr.textContent = e instanceof ApiError ? errText(e) : (e.message || 'Något gick fel.');
      formErr.hidden = false;
    }
  });

  if (delBtn) delBtn.addEventListener('click', async () => {
    setBusyButton(delBtn, true, 'Tar bort'); saveBtn.disabled = true; dlgBusy = true;
    const snap = structuredClone(b);
    try {
      await commit((dd) => { dd.moodboard = dd.moodboard.filter((x) => x.id !== snap.id); }, `${who()}: tog bort en bild ur moodboarden`);
      dlgBusy = false;
      closeDialog();
      let undone = false;
      toast('Bilden är borttagen', {
        timeout: 7000,
        action: { label: 'Ångra', fn: async () => {
          undone = true;
          try {
            await commit((dd) => { if (!dd.moodboard.some((x) => x.id === snap.id)) dd.moodboard.push(snap); }, `${who()}: ångrade borttagningen av en bild`);
            toast('Bilden är tillbaka');
          } catch (e) { toastErr(e); }
        } },
        onExpire: () => { if (!undone) deleteFile(snap.bild, snap.bildSha); },
      });
    } catch (e) {
      dlgBusy = false;
      setBusyButton(delBtn, false); saveBtn.disabled = false;
      formErr.textContent = errText(e); formErr.hidden = false;
    }
  });

  openDialog(b ? 'Ändra bild' : 'Ny bild', [pic.el, fRoom.el, fText.el, formErr],
    [delBtn, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Avbryt'), saveBtn],
    { onPaste: pic.onPaste, focus: false });
}

// ---- budget: ändra

function amountInput(v, label) {
  return h('input', { class: 'in amt', type: 'text', inputmode: 'numeric', value: v ? NF.format(v) : '', placeholder: '0', autocomplete: 'off', 'aria-label': label });
}

// "Fyll i din budget": ditt belopp för alla rum på en gång. Sparar bara det du ändrat,
// så att det som den andra sparat under tiden ligger kvar.
function openMyBudget() {
  if (!guardEdit()) return;
  const d = S.data;
  const me = S.me;
  const other = me === 'emily' ? 'rasmus' : 'emily';
  const rows = d.rum.map((r) => {
    const init = roomBud(r.id)[me];
    return { r, init, inp: amountInput(init, `${r.namn}, ditt belopp i kronor`) };
  });
  const sumEl = h('b');
  const err = h('p', { class: 'err', hidden: true, role: 'alert' });
  const recalc = () => {
    let s = 0;
    for (const x of rows) { const v = parseKr(x.inp.value); if (v && !Number.isNaN(v)) s += v; }
    sumEl.textContent = kr(s);
  };
  rows.forEach((x) => x.inp.addEventListener('input', recalc));
  recalc();

  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Spara');
  saveBtn.addEventListener('click', async () => {
    err.hidden = true;
    const changed = [];
    for (const x of rows) {
      x.inp.setAttribute('aria-invalid', 'false');
      const v = parseKr(x.inp.value);
      if (Number.isNaN(v)) {
        x.inp.setAttribute('aria-invalid', 'true');
        err.textContent = `Skriv ett belopp för ${x.r.namn}, till exempel 5 000.`;
        err.hidden = false; x.inp.focus(); return;
      }
      if ((v || 0) !== x.init) changed.push([x.r.id, v || 0]);
    }
    if (!changed.length) { closeDialog(); return; }
    setBusyButton(saveBtn, true); dlgBusy = true;
    try {
      await commitBudget((bb) => {
        for (const [rid, v] of changed) {
          const e = bb.rum[rid] || (bb.rum[rid] = { rasmus: 0, emily: 0, delar: [] });
          e[me] = v;
          if (!e.rasmus && !e.emily && !e.delar.length) delete bb.rum[rid];
        }
      }, `${who()}: sin budget för ${changed.map(([rid]) => roomName(d, rid)).join(', ')}`);
      dlgBusy = false; closeDialog(); toast('Din budget är sparad');
    } catch (e) {
      dlgBusy = false; setBusyButton(saveBtn, false);
      err.textContent = errText(e); err.hidden = false;
    }
  });

  const list = h('div', { class: 'mb-list' }, rows.map((x) => {
    const o = roomBud(x.r.id)[other];
    x.inp.id = newId('f');
    return h('div', { class: 'mb-row' },
      h('label', { for: x.inp.id }, h('span', null, x.r.namn), o ? h('small', null, `${PEOPLE[other]} lägger ${kr(o)}`) : null),
      x.inp);
  }));
  openDialog(`Din budget, ${PEOPLE[me]}`, [
    h('p', { class: 'sheet-lead' }, `Hur mycket vill du lägga på varje rum? Lämna tomt där du inte vill lägga något. ${PEOPLE[other]} fyller i sin del på samma sätt.`),
    list,
    h('p', { class: 'mb-sum' }, h('span', null, 'Din budget totalt'), sumEl),
    err,
  ], [h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Avbryt'), saveBtn],
  { focus: rows[0] ? rows[0].inp : false });
}

// Ett rum: båda beloppen och delarna, och vilken del varje möbel hör till.
function openRoomBudget(rid) {
  if (!guardEdit()) return;
  const d = S.data;
  const room = d.rum.find((r) => r.id === rid);
  if (!room) return;
  const b0 = roomBud(rid);
  const items = d.mobler.filter((m) => m.rum === rid)
    .sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || a.namn.localeCompare(b.namn, 'sv'));
  const itemIds = new Set(items.map((m) => m.id));
  const tidy = (list) => list.map((p) => normPart({ ...p, mobler: p.mobler.filter((id) => itemIds.has(id)) }));
  const initParts = JSON.stringify(tidy(b0.delar));
  const parts = tidy(b0.delar);

  const inR = amountInput(b0.rasmus, 'Rasmus belopp i kronor');
  const inE = amountInput(b0.emily, 'Emily belopp i kronor');
  const fR = field('Rasmus (kr)', inR);
  const fE = field('Emily (kr)', inE);
  const val = (inp) => { const v = parseKr(inp.value); return v && !Number.isNaN(v) ? v : 0; };
  const partsBox = h('div', { class: 'parts' });
  const linkBox = h('div', { class: 'links' });
  const sumLine = h('p', { class: 'help parts-sum' });

  const drawSum = () => {
    const total = val(inR) + val(inE);
    const f = parts.reduce((s, p) => s + (p._in ? val(p._in) : p.belopp), 0);
    sumLine.classList.toggle('warn-over', !!parts.length && f > total);
    if (!parts.length) sumLine.textContent = total ? `Rummets budget: ${kr(total)}.` : '';
    else if (f > total) sumLine.textContent = `Delarna är ${kr(f - total)} mer än rummets budget på ${kr(total)}.`;
    else sumLine.textContent = `Fördelat ${kr(f)} av ${kr(total)}. Resten av rummet: ${kr(total - f)}.`;
  };
  const drawLinks = () => {
    if (!parts.length || !items.length) { linkBox.replaceChildren(); return; }
    linkBox.replaceChildren(
      h('p', { class: 'flabel' }, 'Vilken del hör möblerna till?'),
      ...items.map((m) => {
        const cur = parts.find((p) => p.mobler.includes(m.id));
        const sel = h('select', { class: 'in', 'aria-label': `Del för ${m.namn}` },
          h('option', { value: '', selected: !cur }, 'Resten av rummet'),
          parts.map((p, i) => h('option', { value: p.id, selected: cur === p }, p.namn.trim() || `Del ${i + 1}`)));
        sel.addEventListener('change', () => {
          for (const p of parts) p.mobler = p.mobler.filter((x) => x !== m.id);
          const p = parts.find((x) => x.id === sel.value);
          if (p) p.mobler.push(m.id);
        });
        const price = m.pris == null ? 'pris saknas' : kr(lineTotal(m), m.ca);
        return h('div', { class: 'link-row' },
          h('span', { class: 'lr-name' }, m.namn, h('small', null, `${price}, ${STATUS[m.status].toLowerCase()}`)),
          sel);
      }));
  };
  const drawParts = (focusLast) => {
    partsBox.replaceChildren(...parts.map((p, i) => {
      const nameIn = h('input', { class: 'in', type: 'text', maxlength: '80', value: p.namn, placeholder: 'Till exempel skrivbord', 'aria-label': `Del ${i + 1}, vad`, autocomplete: 'off' });
      nameIn.addEventListener('input', () => { p.namn = nameIn.value; });
      nameIn.addEventListener('change', drawLinks);
      const amtIn = amountInput(p.belopp, `Del ${i + 1}, belopp i kronor`);
      if (p._raw != null) amtIn.value = p._raw;   // det som skrivits står kvar när rutan ritas om
      amtIn.addEventListener('input', () => { p._raw = amtIn.value; p.belopp = val(amtIn); drawSum(); });
      p._name = nameIn; p._in = amtIn;
      const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Ta bort delen ${p.namn || i + 1}`,
        onclick: () => { parts.splice(i, 1); drawParts(); drawLinks(); drawSum(); } }, icon('trash'));
      return h('div', { class: 'part-row' }, nameIn, amtIn, del);
    }));
    if (focusLast) { const last = partsBox.querySelector('.part-row:last-child input'); if (last) last.focus(); }
  };
  const addBtn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
    parts.push({ id: newId('d'), namn: '', belopp: 0, mobler: [] });
    drawParts(true); drawLinks(); drawSum();
  } }, icon('plus'), 'Lägg till del');
  inR.addEventListener('input', drawSum);
  inE.addEventListener('input', drawSum);
  drawParts(); drawLinks(); drawSum();

  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Spara');
  const formErr = h('p', { class: 'err', hidden: true, role: 'alert' });
  saveBtn.addEventListener('click', async () => {
    formErr.hidden = true; fR.setErr(''); fE.setErr('');
    const r = parseKr(inR.value);
    if (Number.isNaN(r)) { fR.setErr('Skriv ett belopp, till exempel 5 000.'); return; }
    const e = parseKr(inE.value);
    if (Number.isNaN(e)) { fE.setErr('Skriv ett belopp, till exempel 5 000.'); return; }
    const clean = [];
    for (const p of parts) {
      const v = parseKr(p._in ? p._in.value : p.belopp);
      if (Number.isNaN(v)) { formErr.textContent = 'Beloppen för delarna ska vara siffror.'; formErr.hidden = false; if (p._in) p._in.focus(); return; }
      const namn = p.namn.trim();
      if (!namn && !v && !p.mobler.length) continue;   // en tom rad sparas inte
      if (!namn) { formErr.textContent = 'Skriv vad varje del är.'; formErr.hidden = false; if (p._name) p._name.focus(); return; }
      clean.push(normPart({ id: p.id, namn, belopp: v || 0, mobler: p.mobler }));
    }
    const nr = r || 0, ne = e || 0;
    const partsChanged = JSON.stringify(clean) !== initParts;
    if (nr === b0.rasmus && ne === b0.emily && !partsChanged) { closeDialog(); return; }
    setBusyButton(saveBtn, true); dlgBusy = true;
    try {
      await commitBudget((bb) => {
        const x = bb.rum[rid] || (bb.rum[rid] = { rasmus: 0, emily: 0, delar: [] });
        if (nr !== b0.rasmus) x.rasmus = nr;       // bara det som ändrats skrivs,
        if (ne !== b0.emily) x.emily = ne;         // så att den andras ändring står kvar
        if (partsChanged) x.delar = clean;
        if (!x.rasmus && !x.emily && !x.delar.length) delete bb.rum[rid];
      }, `${who()}: budget för ${room.namn}`);
      dlgBusy = false; closeDialog(); toast(`Budgeten för ${room.namn} är sparad`);
    } catch (err) {
      dlgBusy = false; setBusyButton(saveBtn, false);
      formErr.textContent = errText(err); formErr.hidden = false;
    }
  });

  openDialog(`Budget för ${room.namn}`, [
    h('p', { class: 'sheet-lead' }, 'Hur mycket lägger ni var på rummet?'),
    h('div', { class: 'row' }, fR.el, fE.el),
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'Fördela på delar'),
      h('p', { class: 'help' }, 'Valfritt. Dela upp rummets budget på det ni ska köpa, till exempel skrivbord och kontorsstol.'),
      partsBox, h('div', null, addBtn), sumLine),
    linkBox,
    formErr,
  ], [h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Avbryt'), saveBtn], { focus: inR });
}

// ---------------------------------------------------------------- ChatGPT

// Ren validering: varken DOM, tid, slump eller skrivningar. Identitet och datum sätts vid spara.
function chatName(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function chatHttps(value) {
  const url = safeUrl(value);
  return url && url.startsWith('https:') ? url : '';
}
function chatAmount(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseKr(value) : null;
  return n != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function chatDuplicate(items, item) {
  return items.some((m) => m.rum === item.rum && chatName(m.namn) === chatName(item.namn));
}
function parseChatGPT(text, data) {
  const out = { mobler: [], moodboard: [], budget: [], skipped: [], error: '' };
  if (!text.trim()) return out;
  const unreadable = 'Koden gick inte att läsa. Be ChatGPT skriva den igen, hela.';
  const block = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let src;
  try { src = JSON.parse(block); }
  catch {
    try { src = JSON.parse(block.replace(/[“”‘’„]/g, '"')); }
    catch { out.error = unreadable; return out; }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) { out.error = unreadable; return out; }
  if ('vartHem' in src && src.vartHem !== 1) { out.error = 'Koden har en annan version. Be ChatGPT skriva den igen för Vårt hem 1.'; return out; }
  let count = 0;
  for (const kind of ['mobler', 'moodboard', 'budget']) {
    if (src[kind] === undefined) continue;
    if (!Array.isArray(src[kind])) { out.skipped.push(`${kind}: ska vara en lista`); continue; }
    for (const [i, entry] of src[kind].entries()) {
      const v = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      const label = typeof v.namn === 'string' && v.namn.trim() ? v.namn.trim() : `${kind === 'mobler' ? 'Möbel' : kind === 'moodboard' ? 'Bild' : 'Budget'} ${i + 1}`;
      const skip = (reason) => out.skipped.push(`${label}: ${reason}`);
      if (count >= 20) { skip('Högst 20 åt gången'); continue; }
      const room = data.rum.find((r) => chatName(v.rum) && (chatName(r.id) === chatName(v.rum) || chatName(r.namn) === chatName(v.rum)));
      if (!room) { skip(`okänt rum "${String(v.rum ?? '')}"`); continue; }
      if (kind === 'mobler') {
        if (typeof v.namn !== 'string' || !v.namn.trim()) { skip('namn saknas'); continue; }
        const namn = v.namn.trim().slice(0, 200);
        if (chatDuplicate([...data.mobler, ...out.mobler], { namn, rum: room.id })) { skip('Finns redan'); continue; }
        let status = new Map([['ide', 'ide'], ['idea', 'ide'], ['vald', 'vald'], ['kopt', 'kopt']]).get(chatName(v.status));
        // Utelämnat fält ger standardvärdet i tysthet; bara ett fält som finns men är fel varnar.
        const given = (x) => x != null && x !== '';
        if (!status) { status = 'ide'; if (given(v.status)) skip('status blev idé'); }
        const betalar = ['delat', 'emily', 'rasmus'].includes(v.betalar) ? v.betalar : 'delat';
        if (given(v.betalar) && betalar !== v.betalar) skip('betalar blev delat');
        const urls = {};
        for (const key of ['lank', 'bild']) {
          urls[key] = v[key] ? chatHttps(v[key]) : '';
          if (v[key] && !urls[key]) skip('länken togs bort');
        }
        const pris = typeof v.pris === 'number' && Number.isFinite(v.pris) && v.pris >= 0 ? v.pris : chatAmount(v.pris);
        if (pris === null && v.pris != null && v.pris !== '') skip('priset saknas');
        const antal = Number.isInteger(v.antal) && v.antal >= 1 ? v.antal : 1;
        const matt = {};
        for (const key of ['b', 'd', 'h']) {
          const value = v.matt?.[key];
          const n = typeof value === 'number' ? value : typeof value === 'string' ? parseCm(value) : null;
          matt[key] = Number.isFinite(n) && n > 0 ? n : null;
        }
        out.mobler.push(normItem({ namn, rum: room.id, status, pris, antal, ca: v.ca === true,
          ...urls, matt, betalar, not: typeof v.not === 'string' ? v.not : '', id: '' }));
      } else if (kind === 'moodboard') {
        const bild = chatHttps(v.bild);
        if (!bild) { skip('bilden behöver en https-länk'); continue; }
        out.moodboard.push(normImg({ id: '', rum: room.id, bild, text: typeof v.text === 'string' ? v.text : '' }));
      } else {
        const mitt = chatAmount(v.mitt_belopp);
        if ('mitt_belopp' in v && mitt === null) skip('ditt belopp gick inte att läsa');
        const delar = [];
        if ('delar' in v && !Array.isArray(v.delar)) skip('delarna ska vara en lista');
        for (const p of Array.isArray(v.delar) ? v.delar : []) {
          const namn = typeof p?.namn === 'string' ? p.namn.trim().slice(0, 80) : '';
          const belopp = chatAmount(p?.belopp);
          if (!namn || belopp === null) { skip('en del saknar namn eller belopp'); continue; }
          const prev = delar.find((part) => chatName(part.namn) === chatName(namn));
          if (prev) { skip(`delen ${namn} finns flera gånger`); continue; }
          delar.push({ namn, belopp });
        }
        if (mitt === null && !delar.length) { skip('inget giltigt belopp eller någon giltig del'); continue; }
        // En rad per rum gör förhandsvisningen entydig, även vid upprepat rum i koden.
        if (out.budget.some((b) => b.rum === room.id)) { skip('budgeten för rummet finns flera gånger'); continue; }
        out.budget.push({ rum: room.id, ...(mitt !== null ? { mitt_belopp: mitt } : {}), delar });
      }
      count += 1;
    }
  }
  return out;
}

function chatPrice(m) {
  return m.pris == null ? 'pris saknas' : `${m.ca ? 'ca ' : ''}${m.antal > 1 ? `${m.antal} × ` : ''}${kr(m.pris)}`;
}
function chatNote(text) {
  // En rad per anteckning, så att radbrytningar i anteckningen inte ser ut som nya rubriker i läget.
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  return cut.replace(/\s+\S*$/, '').trimEnd() + '…';
}
function chatSummary(date = new Date()) {
  const d = S.data || normalize({});
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const bits = Object.fromEntries(stamp.formatToParts(date).map((p) => [p.type, p.value]));
  const lines = [`Läget i Vårt hem, ${bits.day} ${bits.month.replace(/\.$/, '')} ${bits.year} kl. ${bits.hour}:${bits.minute}`, '',
    `Rum (id): ${d.rum.map((r) => `${r.namn} (${r.id})`).join(', ')}.`, '',
    'Budget per rum. Rummets budget är Rasmus och Emilys belopp tillsammans.'];
  for (const r of d.rum) {
    const items = d.mobler.filter((m) => m.rum === r.id), b = roomBud(r.id);
    if (!items.length && !hasBudget(r.id)) continue;
    const parts = partsView(d, r.id).parts.map((p) => `${p.namn} ${kr(p.belopp)}`);
    lines.push(`- ${r.namn}: Rasmus ${kr(b.rasmus)}, Emily ${kr(b.emily)}, totalt ${kr(b.total)}. Valt ${kr(totals(items).plan)}.${parts.length ? ` Delar: ${parts.join(', ')}.` : ''}`);
  }
  const bt = budgetTotals(d);
  lines.push(`Totalt: budget ${kr(bt.total)} (Rasmus ${NF.format(bt.rasmus)}, Emily ${NF.format(bt.emily)}). Valt och köpt ${kr(totals(d.mobler).plan)}.`, '', 'Möbler');
  for (const r of d.rum) {
    const items = d.mobler.filter((m) => m.rum === r.id);
    if (!items.length) continue;
    lines.push(r.namn);
    for (const m of items) {
      const dims = dimsText(m);
      lines.push(`- ${m.namn}: ${STATUS[m.status].toLowerCase()}, ${chatPrice(m)}${dims ? `, ${dims}` : ''}.${safeUrl(m.lank) ? ` ${safeUrl(m.lank)}` : ''}`);
      if (m.not) lines.push(`  Not: ${chatNote(m.not)}`);
    }
  }
  const rooms = d.rum.map((r) => ({ namn: r.namn, n: d.moodboard.filter((b) => b.rum === r.id).length })).filter((r) => r.n);
  lines.push('', `Moodboard: ${d.moodboard.length} ${d.moodboard.length === 1 ? 'bild' : 'bilder'}${rooms.length ? ` (${rooms.map((r) => `${r.namn} ${r.n}`).join(', ')})` : ''}.`);
  return lines.join('\n');
}
function chatCount(draft) { return draft.mobler.length + draft.moodboard.length + draft.budget.length; }
function chatCountText(draft) {
  return listSv([
    draft.mobler.length ? `${draft.mobler.length} ${draft.mobler.length === 1 ? 'möbel' : 'möbler'}` : '',
    draft.moodboard.length ? `${draft.moodboard.length} ${draft.moodboard.length === 1 ? 'bild' : 'bilder'}` : '',
    draft.budget.length ? `budget för ${draft.budget.length} rum` : '',
  ].filter(Boolean));
}
function chatPreview(draft) {
  const box = h('div', { class: 'chat-preview', 'aria-live': 'polite' });
  if (draft.error) { box.append(h('p', { class: 'err', role: 'alert' }, draft.error)); return box; }
  if (chatCount(draft)) box.append(h('p', { class: 'chat-count' }, `${chatCountText(draft)} läggs in.`));
  const group = (title, rows) => { if (rows.length) box.append(h('section', { class: 'chat-group' }, h('h4', null, title), rows)); };
  group('Möbler', draft.mobler.map((m) => h('div', { class: 'chat-row' },
    h('strong', null, m.namn), h('div', { class: 'chat-meta' }, roomName(S.data, m.rum), statusChip(m.status)),
    h('p', null, chatPrice(m)), dimsText(m) ? h('p', { class: 'help' }, dimsText(m)) : null)));
  group('Moodboard', draft.moodboard.map((b) => {
    const img = h('img', { src: b.bild, alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'help' }, 'Bilden går inte att visa')), { once: true });
    return h('div', { class: 'chat-row chat-image' }, h('div', { class: 'chat-thumb' }, img),
      h('div', null, h('strong', null, roomName(S.data, b.rum)), b.text ? h('p', null, b.text) : null));
  }));
  group('Budget', draft.budget.map((b) => {
    const cur = roomBud(b.rum), parts = cur.delar.map((p) => ({ ...p }));
    const rows = [];
    if (b.mitt_belopp !== undefined) rows.push(h('p', null, `Ditt belopp: ${kr(cur[S.me])} → ${kr(b.mitt_belopp)}`));
    for (const p of b.delar) {
      const old = parts.find((x) => chatName(x.namn) === chatName(p.namn));
      rows.push(h('p', null, `${p.namn} ${kr(p.belopp)} (${old ? `var ${kr(old.belopp)}` : 'ny'})`));
      if (old) old.belopp = p.belopp; else parts.push(p);
    }
    const total = cur.total - (cur[S.me] || 0) + (b.mitt_belopp ?? cur[S.me] ?? 0);
    const sum = parts.reduce((s, p) => s + p.belopp, 0);
    if (sum > total) rows.push(h('p', { class: 'help parts-sum warn-over' }, `Delarna är ${kr(sum - total)} mer än rummets budget på ${kr(total)}.`));
    return h('div', { class: 'chat-row' }, h('strong', null, roomName(S.data, b.rum)), rows);
  }));
  group('Hoppas över eller ändras', draft.skipped.map((msg) => h('p', { class: 'help' }, msg)));
  return box;
}

function openChatGPT() {
  if (!S.data) return;
  let draft = parseChatGPT('', S.data), saving = false, dataSaved = false;
  const input = h('textarea', { class: 'in', id: 'chat-code', rows: 4, spellcheck: 'false' });
  const preview = h('div');
  const formErr = h('p', { class: 'err', hidden: true, role: 'alert' });
  const save = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Lägg in');
  const draw = () => {
    if (saving) return;
    draft = parseChatGPT(input.value, S.data);
    preview.replaceChildren(chatPreview(draft));
    const count = chatCount(draft);
    save.disabled = !count;
    save.textContent = count ? `Lägg in ${count} ${count === 1 ? 'sak' : 'saker'}` : 'Lägg in';
    formErr.hidden = true;
  };
  input.addEventListener('input', draw);
  const fallback = h('div', { class: 'chat-group', hidden: true });
  const copy = h('button', { class: 'btn', type: 'button', onclick: async () => {
    const text = chatSummary();
    try { await navigator.clipboard.writeText(text); toast('Kopierat. Klistra in i ChatGPT.'); }
    catch {
      const area = h('textarea', { class: 'in', readonly: true, rows: 5, 'aria-label': 'Läget att kopiera' }, text);
      fallback.hidden = false;
      fallback.replaceChildren(h('p', { class: 'help' }, 'Markera allt och kopiera.'), area);
      area.focus(); area.select();
    }
  } }, icon('copy'), 'Kopiera läget');
  const pasteHelp = h('p', { class: 'help', hidden: true, role: 'status' });
  const paste = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { const text = await navigator.clipboard.readText(); if (!saving) { input.value = text; draw(); pasteHelp.hidden = true; } }
    catch { input.focus(); pasteHelp.textContent = 'Tryck länge i rutan och välj Klistra in.'; pasteHelp.hidden = false; }
  } }, icon('clipboard-text'), 'Klistra in');
  save.addEventListener('click', async () => {
    if (!guardEdit() || saving || !chatCount(draft)) return;
    const me = S.me, author = who(), now = nowIso();
    const items = draft.mobler.map((m) => normItem({ ...m, id: newId('m'), av: author, skapad: now, andrad: now }));
    const images = draft.moodboard.map((b) => normImg({ ...b, id: newId('i'), av: author, skapad: now }));
    const budgets = draft.budget.map((b) => ({ ...b, delar: b.delar.map((p) => normPart({ ...p, id: newId('p'), mobler: [] })) }));
    const summary = chatCountText(draft);
    saving = true; dlgBusy = true; setBusyButton(save, true); input.disabled = true; paste.disabled = true; formErr.hidden = true;
    try {
      if (!dataSaved && (items.length || images.length)) {
        await commit((d) => {
          for (const m of items) if (!chatDuplicate(d.mobler, m)) d.mobler.push(m);
          for (const b of images) if (!d.moodboard.some((old) => old.id === b.id)) d.moodboard.push(b);
        }, `${author}: från ChatGPT, lade till ${[...items.map((m) => m.namn), ...images.map((b) => b.text || roomName(S.data, b.rum))].join(', ').slice(0, 120)}`);
        dataSaved = true;
      }
      if (budgets.length) await commitBudget((bb) => {
        for (const b of budgets) {
          const cur = bb.rum[b.rum] || (bb.rum[b.rum] = { rasmus: 0, emily: 0, delar: [] });
          if (b.mitt_belopp !== undefined) cur[me] = b.mitt_belopp;
          for (const p of b.delar) {
            const old = cur.delar.find((x) => chatName(x.namn) === chatName(p.namn));
            if (old) old.belopp = p.belopp; else cur.delar.push({ ...p });
          }
        }
      }, `${author}: budget från ChatGPT (${budgets.map((b) => roomName(S.data, b.rum)).join(', ')})`);
      dlgBusy = false; closeDialog(); toast(`Inlagt: ${summary}`); render();
    } catch (err) {
      const saved = items.length && images.length ? 'Möblerna och bilderna är inlagda' : items.length ? 'Möblerna är inlagda' : 'Bilderna är inlagda';
      formErr.textContent = dataSaved ? `${saved}, men budgeten sparades inte: ${errText(err)}` : errText(err);
      formErr.hidden = false;
      // Vid delvis lyckad import får man försöka med samma budget igen utan fler bilder.
      input.disabled = dataSaved; paste.disabled = dataSaved;
      saving = false; dlgBusy = false; setBusyButton(save, false);
      if (dataSaved) save.textContent = 'Försök med budgeten igen';
    }
  });
  openDialog('ChatGPT', [
    h('section', { class: 'chat-group' }, h('h3', null, 'Ge ChatGPT läget'),
      h('p', { class: 'help' }, 'Kopiera och klistra in i ChatGPT, så vet den vad ni redan har.'), h('div', null, copy), fallback),
    h('section', { class: 'chat-group' }, h('h3', null, 'Lägg in från ChatGPT'),
      h('p', { class: 'help' }, 'Klistra in koden du fick av ChatGPT.'), h('div', null, paste), pasteHelp,
      field('Kod från ChatGPT', input).el, preview, formErr),
  ], [h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Avbryt'), save], { focus: false });
}

// ---- lås upp, vem är du

function openUnlock() {
  const keyIn = h('input', { class: 'in', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'github_pat_…' });
  const f = field('Nyckel', keyIn, { help: 'Nyckeln sparas bara i den här webbläsaren.' });
  const me = radios('jag', PEOPLE, S.me || '');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, icon('lock-simple-open'), 'Lås upp');
  const formErr = h('p', { class: 'err', hidden: true, role: 'alert' });
  const go = async () => {
    formErr.hidden = true; f.setErr('');
    const key = keyIn.value.trim();
    if (!key) { f.setErr('Klistra in nyckeln.'); return; }
    if (!me.value) { formErr.textContent = 'Välj vem du är.'; formErr.hidden = false; return; }
    setBusyButton(saveBtn, true, 'Kontrollerar');
    const ok = await tryKey(key);
    setBusyButton(saveBtn, false);
    if (ok === 'bad') { f.setErr('Nyckeln fungerar inte. Kontrollera att du kopierat hela.'); return; }
    if (ok === 'net') { formErr.textContent = 'Ingen kontakt med GitHub just nu. Försök igen.'; formErr.hidden = false; return; }
    unlockWith(key, me.value);
    closeDialog();
    toast(`Upplåst. Du är ${PEOPLE[S.me]}.`);
  };
  saveBtn.addEventListener('click', go);
  keyIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } });
  openDialog('Lås upp för att ändra', [
    h('p', { class: 'sheet-lead' }, 'Alla med länken kan titta. För att lägga till och ändra behövs nyckeln. Har du fått en länk av Rasmus räcker det att öppna den, då låses sidan upp direkt.'),
    f.el,
    h('div', { class: 'field' }, h('span', { class: 'flabel' }, 'Vem är du?'), me.el),
    formErr,
  ], [h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Avbryt'), saveBtn], { focus: keyIn });
}

async function tryKey(key) {
  try {
    const r = await fetch(API + DATA_PATH, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + key }, cache: 'no-store' });
    if (r.status === 401) return 'bad';
    return 'ok';
  } catch { return 'net'; }
}

function unlockWith(key, me) {
  S.key = key; S.keyBad = false;
  store.set(KEY_STORE, key);
  if (PEOPLE[me]) { S.me = me; store.set(ME_STORE, me); }
  render();
}

function openWho() {
  const me = radios('jag2', PEOPLE, S.me || '');
  const btn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
    if (!me.value) return;
    S.me = me.value; store.set(ME_STORE, S.me); closeDialog(); render();
  } }, 'Klar');
  openDialog('Vem är du?', [h('p', { class: 'sheet-lead' }, 'Så att det syns vem som gillar och lägger till saker.'), me.el],
    [h('span', { class: 'spacer' }), btn]);
}

// ---- inställningar

function openSettings() {
  const d = S.data;
  const bt = d && S.budget ? budgetTotals(d) : null;
  const me = radios('jag3', PEOPLE, S.me || '');
  me.el.addEventListener('change', () => { if (me.value) { S.me = me.value; store.set(ME_STORE, S.me); renderTop(); } });

  const rows = h('div', { class: 'field' });
  const draft = (d ? d.rum : DEFAULT_ROOMS).map((r) => ({ ...r }));
  const used = new Set([...(d ? d.mobler.map((m) => m.rum) : []), ...(d ? d.moodboard.map((b) => b.rum) : []),
    ...(d ? d.rum.filter((r) => hasBudget(r.id)).map((r) => r.id) : [])]);
  const drawRooms = () => {
    rows.replaceChildren(...draft.map((r, i) => {
      const nameIn = h('input', { class: 'in', type: 'text', value: r.namn, 'aria-label': 'Rummets namn' });
      nameIn.addEventListener('input', () => { r.namn = nameIn.value; });
      const zonSel = h('select', { class: 'in', 'aria-label': 'Plats på ritningen' },
        Object.entries(ZONES).map(([z, lab]) => h('option', { value: z, selected: r.zon === z }, lab)));
      zonSel.addEventListener('change', () => { r.zon = zonSel.value; });
      const del = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Ta bort ${r.namn}`, disabled: used.has(r.id) ? true : null,
        title: used.has(r.id) ? 'Rummet har möbler, bilder eller budget' : null, onclick: () => { draft.splice(i, 1); drawRooms(); } }, icon('trash'));
      return h('div', { class: 'room-row' }, nameIn, zonSel, del);
    }));
  };
  drawRooms();
  const addRoom = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { draft.push({ id: newId('r'), namn: 'Nytt rum', zon: '' }); drawRooms(); } }, icon('plus'), 'Lägg till rum');
  const roomErr = h('p', { class: 'err', hidden: true, role: 'alert' });
  const saveRooms = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Spara rummen');
  saveRooms.addEventListener('click', async () => {
    roomErr.hidden = true;
    const clean = draft.map((r) => ({ ...r, namn: r.namn.trim() })).filter((r) => r.namn);
    if (!clean.length) { roomErr.textContent = 'Det måste finnas minst ett rum.'; roomErr.hidden = false; return; }
    setBusyButton(saveRooms, true);
    try {
      await commit((dd) => {
        const still = new Set(clean.map((r) => r.id));
        const inUse = new Set([...dd.mobler.map((m) => m.rum), ...dd.moodboard.map((b) => b.rum)]);
        const keep = dd.rum.filter((r) => !still.has(r.id) && inUse.has(r.id)); // tas aldrig bort om någon hunnit använda det
        dd.rum = [...clean, ...keep];
      }, `${who()}: ändrade rummen`);
      setBusyButton(saveRooms, false);
      toast('Rummen är sparade');
    } catch (e) {
      setBusyButton(saveRooms, false);
      roomErr.textContent = errText(e); roomErr.hidden = false;
    }
  });

  const other = S.me === 'emily' ? 'rasmus' : 'emily';
  const shareOut = h('div', { hidden: true, class: 'field' });
  const shareBtn = h('button', { class: 'btn btn-sm', type: 'button' }, icon('share-network'), `Skapa länk till ${PEOPLE[other]}`);
  shareBtn.addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}#nyckel=${encodeURIComponent(S.key)}&jag=${other}`;
    const copyBtn = h('button', { class: 'btn btn-sm', type: 'button' }, icon('copy'), 'Kopiera');
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); toast('Länken är kopierad'); }
      catch { toast('Markera länken och kopiera den för hand.'); }
    });
    const nativeShare = navigator.share ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => navigator.share({ title: 'Vårt hem', text: 'Öppna den här så kan du också lägga till saker:', url: link }).catch(() => {}) }, icon('share-network'), 'Dela') : null;
    shareOut.replaceChildren(
      h('p', { class: 'sharebox' }, link),
      h('div', { class: 'imgbtns' }, copyBtn, nativeShare),
      h('p', { class: 'warn' }, `Länken ger rätt att ändra. Skicka den bara till ${PEOPLE[other]}.`));
    shareOut.hidden = false;
  });

  const backup = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
    const blob = new Blob([JSON.stringify(S.data, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `hemmet-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
  } }, icon('download-simple'), 'Ladda ner säkerhetskopia');

  const lock = h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => {
    S.key = null; store.del(KEY_STORE); closeDialog(); render(); toast('Den här enheten är låst');
  } }, icon('lock-simple'), 'Lås den här enheten');

  openDialog('Inställningar', [
    h('div', { class: 'settings-sec' }, h('h3', null, 'Du är'), me.el),
    h('div', { class: 'settings-sec' }, h('h3', null, 'Budget'),
      h('p', { class: 'sheet-lead' }, bt && bt.total ? `Er budget är ${kr(bt.total)}: Rasmus ${kr(bt.rasmus)}, Emily ${kr(bt.emily)}.` : 'Ingen budget satt.'),
      h('div', null, h('a', { class: 'btn btn-sm', href: '#budget', onclick: () => closeDialog() }, icon('wallet'), 'Till budgeten'))),
    h('div', { class: 'settings-sec' }, h('h3', null, 'Rum'),
      h('p', { class: 'help' }, 'Platsen på ritningen styr vilka rum som visas när man trycker på ritningen. Rum med möbler, bilder eller budget går inte att ta bort.'),
      rows, h('div', { class: 'imgbtns' }, addRoom, saveRooms), roomErr),
    h('div', { class: 'settings-sec' }, h('h3', null, 'Dela'),
      h('p', { class: 'help' }, 'Skapar en länk som låser upp sidan på den andras telefon.'),
      h('div', null, shareBtn), shareOut),
    h('div', { class: 'settings-sec' }, h('h3', null, 'Den här enheten'),
      h('div', { class: 'imgbtns' }, backup, lock)),
  ], [h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: closeDialog }, 'Klar')], { focus: false });
}

// ---------------------------------------------------------------- start

function route() {
  const chat = takeChatLink();
  const v = (location.hash || '').replace(/^#/, '');
  S.view = VIEWS.includes(v) ? v : 'kalkyl';
  render();
  window.scrollTo(0, 0);
  if (chat) openChatLink();
}

/* Länken som ChatGPT-projektet ger (…/hemmet/#chatgpt) öppnar ChatGPT-rutan direkt.
   På iPhone öppnar ChatGPT-appen länkar i sitt eget fönster, som inte har nyckeln från Safari.
   Då förklarar sidan i stället hur man kommer till Safari. Adressen följer med dit. */
function takeChatLink() {
  // Tål ett skiljetecken som följt med länken, till exempel "#chatgpt." i slutet av en mening.
  let raw = (location.hash || '').replace(/^#/, '');
  try { raw = decodeURIComponent(raw); } catch { /* behåll som den är */ }
  if (!/^chatgpt[.,;:!?)\]]*$/i.test(raw)) return false;
  S.chatLink = true;
  return true;
}

function openChatLink() {
  if (!S.chatLink || !S.data) return;   // körs igen när datat har laddats
  S.chatLink = false;
  if (S.key) {
    history.replaceState(null, '', location.pathname + location.search + '#kalkyl');
    openChatGPT();
    return;
  }
  // Utan nyckel står #chatgpt kvar, så att Öppna i Safari tar med sig den och rutan öppnas där.
  openDialog('Öppna i Safari', [
    h('p', { class: 'sheet-lead' }, 'Den här webbläsaren har inte nyckeln till Vårt hem, så sidan är låst här.'),
    h('p', null, 'På iPhone öppnar ChatGPT länkar i sitt eget fönster. Välj Öppna i Safari, så kommer rutan upp där. Du kan också öppna Vårt hem från hemskärmen och trycka på ChatGPT.'),
  ], [h('span', { class: 'spacer' }), h('button', { class: 'btn btn-primary', type: 'button', onclick: closeDialog }, 'Okej')]);
}

function takeSetupLink() {
  const raw = (location.hash || '').replace(/^#/, '');
  if (!raw.includes('nyckel=')) return false;
  const p = new URLSearchParams(raw);
  const key = (p.get('nyckel') || '').trim();
  const me = p.get('jag');
  history.replaceState(null, '', location.pathname + location.search + '#kalkyl');
  if (!key) return false;
  unlockWith(key, PEOPLE[me] ? me : S.me);
  setTimeout(() => toast(S.me ? `Upplåst. Välkommen, ${PEOPLE[S.me]}.` : 'Upplåst.'), 300);
  if (!S.me) setTimeout(openWho, 400);
  return true;
}

function boot() {
  $('#chatgpt').addEventListener('click', openChatGPT);
  const d = dlg();
  d.addEventListener('cancel', (ev) => { if (dlgBusy) ev.preventDefault(); });
  d.addEventListener('click', (ev) => { if (ev.target === d) closeDialog(); });
  takeSetupLink();
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !dlg().open && !S.busy && Date.now() - S.loadedAt > 15000) load(true);
  });
  route();
  load();
}

document.addEventListener('DOMContentLoaded', boot);
