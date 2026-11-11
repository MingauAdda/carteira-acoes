'use strict';

// =====================================================================
// Armazenamento
// =====================================================================
const KEY_TX = 'carteira.tx.v1';
const KEY_QUOTES = 'carteira.quotes.v1';
const KEY_TOKEN = 'carteira.token';
const KEY_SCREENER = 'carteira.screener.v1';
const KEY_CLASSES = 'carteira.classes.v1';

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
// Dados do usuário (não dá para buscar de novo) ficam também no IndexedDB, como cópia de segurança.
const KEEP = [KEY_TX, KEY_CLASSES, KEY_TOKEN];
function save(key, value) {
  const s = JSON.stringify(value);
  try { localStorage.setItem(key, s); }
  catch {
    // Sem espaço: descarta caches (cotações/avaliações) e tenta de novo
    if (KEEP.includes(key)) {
      try { localStorage.removeItem(KEY_SCREENER); localStorage.removeItem(KEY_QUOTES); localStorage.setItem(key, s); } catch {}
    }
  }
  if (KEEP.includes(key)) idbPut(key, s);
}

function idb() {
  return new Promise((ok, fail) => {
    if (!window.indexedDB) return fail(new Error('sem IndexedDB'));
    const r = indexedDB.open('carteira', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function idbPut(key, s) {
  try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(s, key); } catch {}
}
async function idbGet(key) {
  try {
    const db = await idb();
    return await new Promise((ok) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => ok(r.result ?? null);
      r.onerror = () => ok(null);
    });
  } catch { return null; }
}

// Se o localStorage foi limpo, recupera do IndexedDB; se o IndexedDB está vazio, copia para ele.
async function syncBackupStore() {
  let restored = false;
  for (const key of KEEP) {
    const local = localStorage.getItem(key);
    const copy = await idbGet(key);
    const empty = !local || local === '[]' || local === '{}' || local === '""';
    if (empty && copy && copy !== local && copy !== '[]' && copy !== '{}' && copy !== '""') {
      try { localStorage.setItem(key, copy); } catch {}
      restored = true;
    } else if (local && !empty) idbPut(key, local);
  }
  if (restored) {
    txs = load(KEY_TX, []); classes = load(KEY_CLASSES, {}); token = load(KEY_TOKEN, '');
    mergeFractional();
    render(); refreshQuotes();
    toast('Dados recuperados');
  }
  // Pede ao navegador para não apagar os dados sozinho
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

// Operações: {id, type: buy|sell|split|income, ticker, qty, price, fees, date, amount?, kind?, broker?, key?}
//  - split: qty com sinal (desdobro/bonificação +, grupamento −), custo total não muda
//  - income: provento recebido (amount em R$; kind = Dividendo/JCP/Rendimento)
// Fracionário (VALE3F) = mesma ação do lote padrão (VALE3)
const normTicker = (t) => String(t || '').trim().toUpperCase().replace(/\.SA$/, '').replace(/^([A-Z0-9]{4}\d{1,2})F$/, '$1');
function mergeFractional() {
  let changed = false;
  for (const t of txs) { const n = normTicker(t.ticker); if (n !== t.ticker) { t.ticker = n; changed = true; } }
  if (changed) save(KEY_TX, txs);
  let cc = false;
  for (const k of Object.keys(classes)) { const n = normTicker(k); if (n !== k) { if (!classes[n]) classes[n] = classes[k]; delete classes[k]; cc = true; } }
  if (cc) save(KEY_CLASSES, classes);
}
let txs = load(KEY_TX, []);
let quotes = load(KEY_QUOTES, {});
let token = load(KEY_TOKEN, '');
let screener = load(KEY_SCREENER, null); // {fetchedAt, rodada, rows: {TICKER: {...}}}
let classes = load(KEY_CLASSES, {});    // {TICKER: 'acao'|'fii'|'etf'|'bdr'|'outro'}
mergeFractional();

// =====================================================================
// Formatação
// =====================================================================
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 });
const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2).replace('.', ',') + '%';
const pct0 = (v) => v.toFixed(1).replace('.', ',') + '%';
const money = (v) => brl.format(v);
const signed = (v) => (v > 0 ? '+' : '') + brl.format(v);
const cls = (v) => (v > 0.0001 ? 'up' : v < -0.0001 ? 'down' : '');
const parseNum = (s) => {
  if (typeof s === 'number') return isFinite(s) ? s : 0;
  if (s == null) return 0;
  s = String(s).trim().replace(/\s|R\$/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
};
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const todayIso = () => new Date().toLocaleDateString('sv-SE');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const $ = (s) => document.querySelector(s);

// =====================================================================
// Posições: preço médio, lucro realizado, proventos
// =====================================================================
const TYPE_ORDER = { buy: 0, split: 1, sell: 2, income: 3 };
function sortedTxs() {
  return [...txs].sort((a, b) => a.date.localeCompare(b.date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id - b.id);
}

function positions() {
  const map = {};
  for (const t of sortedTxs()) {
    const p = map[t.ticker] ||= { ticker: t.ticker, qty: 0, cost: 0, realized: 0, income: 0, txs: [] };
    p.txs.push(t);
    if (t.type === 'buy') {
      p.cost += t.qty * t.price + (t.fees || 0);
      p.qty += t.qty;
    } else if (t.type === 'sell') {
      const avg = p.qty > 0 ? p.cost / p.qty : 0;
      const q = Math.min(t.qty, p.qty);
      p.realized += q * (t.price - avg) - (t.fees || 0);
      p.qty -= q;
      p.cost = avg * p.qty;
    } else if (t.type === 'split') {
      p.qty = Math.max(0, p.qty + t.qty); // custo total igual → PM se ajusta
    } else if (t.type === 'income') {
      p.income += t.amount || 0;
    }
    if (p.qty < 1e-9) { p.qty = 0; p.cost = 0; }
  }
  return Object.values(map).map((p) => {
    p.avg = p.qty > 0 ? p.cost / p.qty : 0;
    const q = quotes[p.ticker];
    p.quote = q;
    p.val = valuation(p.ticker);
    if (q && p.qty > 0) {
      p.value = p.qty * q.price;
      p.pl = p.value - p.cost;
      p.plPct = p.cost > 0 ? (p.pl / p.cost) * 100 : 0;
      p.day = p.qty * (q.change || 0);
    }
    return p;
  });
}

// =====================================================================
// Cotações e histórico (brapi.dev)
// =====================================================================
function brapiUrl(ticker, params = {}) {
  const u = new URL(`https://brapi.dev/api/quote/${encodeURIComponent(ticker)}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (token) u.searchParams.set('token', token);
  return u.toString();
}
async function brapi(ticker, params) {
  const r = await fetch(brapiUrl(ticker, params));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.message || `HTTP ${r.status}`);
  const q = j.results && j.results[0];
  if (!q) throw new Error('sem dados');
  return q;
}
function toQuote(q, ticker) {
  if (q.regularMarketPrice == null) throw new Error('sem cotação');
  return {
    price: q.regularMarketPrice,
    change: q.regularMarketChange || 0,
    changePct: q.regularMarketChangePercent || 0,
    time: q.regularMarketTime,
    name: q.longName || q.shortName || ticker,
    logo: q.logourl || '',
    fetchedAt: Date.now(),
  };
}

// Cotação sem token: lista pública da brapi (atraso de ~15 min, sem cadastro).
// Uma chamada traz todos os ativos da B3; a API limita muitas chamadas seguidas.
function fromList(q, ticker) {
  if (!q || q.close == null) throw new Error('sem cotação');
  const pctCh = q.change || 0;
  return {
    price: q.close,
    change: q.close - q.close / (1 + pctCh / 100),
    changePct: pctCh,
    time: null,
    name: q.name || ticker,
    logo: q.logo || '',
    fetchedAt: Date.now(),
  };
}
async function publicList(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 429 ? 'muitas consultas, tente em 1 min' : j.message || 'HTTP ' + r.status);
  return j.stocks || [];
}
async function publicQuotes(tickers) {
  const out = {};
  try {
    const all = await publicList('https://brapi.dev/api/quote/list?limit=5000');
    const by = new Map(all.map((x) => [x.stock, x]));
    for (const t of tickers) if (by.has(t)) out[t] = fromList(by.get(t), t);
  } catch {}
  for (const t of tickers) {
    if (out[t]) continue;
    try { out[t] = fromList((await publicList('https://brapi.dev/api/quote/list?limit=10&search=' + encodeURIComponent(t))).find((x) => x.stock === t), t); }
    catch (e) { out[t] = e; }
  }
  return out;
}

let refreshing = false;
async function refreshQuotes(manual = false) {
  if (refreshing) return;
  const tickers = [...new Set(positions().filter((p) => p.qty > 0).map((p) => p.ticker))];
  if (!tickers.length) return;
  refreshing = true;
  $('#btnRefresh').classList.add('spin');
  const errors = [];
  let todo = tickers;
  if (token) {
    await Promise.all(tickers.map(async (t) => { try { quotes[t] = toQuote(await brapi(t), t); } catch {} }));
    todo = tickers.filter((t) => !quotes[t] || Date.now() - quotes[t].fetchedAt > 60_000);
  }
  if (todo.length) {
    const got = await publicQuotes(todo);
    for (const t of todo) {
      if (got[t] instanceof Error || !got[t]) errors.push(`${t}: ${got[t]?.message || 'sem cotação'}`);
      else quotes[t] = got[t];
    }
  }
  save(KEY_QUOTES, quotes);
  refreshing = false;
  $('#btnRefresh').classList.remove('spin');
  render();
  if (errors.length && manual) toast(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1})` : ''));
}

const histCache = {};
async function fetchHistory(ticker) {
  if (histCache[ticker] && Date.now() - histCache[ticker].at < 30 * 60_000) return histCache[ticker];
  let q = null;
  for (const range of ['1y', '6mo', '3mo']) {
    try { q = await brapi(ticker, { range, interval: '1d', dividends: 'true' }); if (q.historicalDataPrice?.length) break; }
    catch { q = null; }
  }
  if (!q) throw new Error('sem histórico');
  try { quotes[ticker] = toQuote(q, ticker); save(KEY_QUOTES, quotes); } catch {}
  const prices = (q.historicalDataPrice || []).filter((h) => h.close != null).map((h) => ({ t: h.date * 1000, c: h.close }));
  const divs = (q.dividendsData?.cashDividends || []).map((d) => ({
    rate: d.rate, label: d.label || 'Provento',
    com: (d.lastDatePrior || d.exDate || '').slice(0, 10),
    pay: (d.paymentDate || '').slice(0, 10),
  })).filter((d) => d.com && d.rate > 0);
  return (histCache[ticker] = { at: Date.now(), prices, divs });
}

// =====================================================================
// Screener: fundamentos oficiais da CVM (gerados no GitHub, data/screener.json)
// =====================================================================
const SCREENER_URL = 'data/screener.json';

async function loadScreener(force = false) {
  if (!force && screener?.v === 2 && Date.now() - screener.fetchedAt < 6 * 3600_000) { buildRows(); return; }
  try {
    const r = await fetch(SCREENER_URL, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    if (!j.tk || !Object.keys(j.tk).length) throw new Error('vazio');
    screener = { v: 2, fetchedAt: Date.now(), rodada: j.gerado, anos: j.anos, emp: j.emp, tk: j.tk };
    save(KEY_SCREENER, screener);
    buildRows();
    render();
    renderScreener();
  } catch (e) {
    if (force) toast('Não foi possível baixar o screener');
  }
}
// Dados antigos (outra fonte) não servem mais
if (screener && screener.v !== 2) screener = null;

function buildRows() {
  if (!screener || screener.rows) return;
  screener.rows = {};
  for (const t of Object.keys(screener.tk)) screener.rows[t] = calc(t);
}

const lastNum = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return [a[i], i]; return [null, -1]; };
// Quantos anos seguidos o valor subiu até o último balanço
function streak(a) {
  const [, i0] = lastNum(a);
  let n = 0;
  for (let i = i0; i > 0 && a[i] != null && a[i - 1] != null && a[i] > a[i - 1]; i--) n++;
  return n;
}

// Indicadores de um código com o preço informado (ou o do arquivo)
function calc(t, livePrice) {
  const raw = screener?.tk[t];
  if (!raw) return null;
  const [ei, filePrice, k] = raw;
  const e = screener.emp[ei];
  const price = livePrice || filePrice;
  const pps = price / k;                       // preço por ação (units valem k ações)
  const sh = e.ac;                             // milhões de ações
  const [lc, li] = lastNum(e.lc);
  const pl = e.pl[li], rec = e.r[li], lucro = e.l[li];
  const lpa = sh && lc != null ? lc / sh : null;
  const vpa = sh && pl != null ? pl / sh : null;
  const dv = e.dv.slice(Math.max(0, li - 4), li + 1);
  const dpsAvg3 = sh ? dv.slice(-3).reduce((s, x) => s + (x || 0), 0) / 3 / sh : null;
  const graham = lpa > 0 && vpa > 0 ? Math.sqrt(22.5 * lpa * vpa) * k : null;
  const bazin = dv.length === 5 && dv.every((x) => x > 0) ? dpsAvg3 / 0.06 * k : null;
  const vals = [graham, bazin].filter(Boolean);
  const combined = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const lcs = e.lc.slice(Math.max(0, li - 4), li + 1);
  return {
    ticker: t, name: e.n, sector: e.s || 'Sem setor', fin: !!e.fin, emp: ei, year: screener.anos[li],
    price, vol: raw[3],
    pe: lpa > 0 ? pps / lpa : null,
    pvp: vpa > 0 ? pps / vpa : null,
    roe: pl > 0 && lc != null ? lc / pl * 100 : null,
    margin: rec > 0 && lucro != null && !e.fin ? lucro / rec * 100 : null,
    dy: sh && dv.length && dv[dv.length - 1] != null ? dv[dv.length - 1] / sh / pps * 100 : null,
    debt: !e.fin && pl > 0 && e.dl != null ? e.dl / pl : null,
    profitUp: streak(e.lc), revUp: e.fin ? null : streak(e.r),
    noLoss: lcs.length === 5 && lcs.every((x) => x > 0),
    graham, bazin, combined,
    methods: [['Graham', graham], ['Bazin', bazin]].filter(([, v]) => v),
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
    potential: combined && price ? (combined / price - 1) * 100 : null,
  };
}

// Avaliação de uma ação com o preço mais recente que tivermos
function valuation(ticker) {
  if (!screener?.tk[ticker]) return null;
  return calc(ticker, quotes[ticker]?.price);
}

// =====================================================================
// Classes de ativo
// =====================================================================
const CLASSES = { acao: 'Ações', fii: 'FIIs', etf: 'ETFs', bdr: 'BDRs', outro: 'Outros' };
const CLASS_ONE = { acao: 'Ação', fii: 'FII', etf: 'ETF', bdr: 'BDR', outro: 'Outro' };
const CLASS_COLOR = { acao: '#3b82f6', fii: '#f59e0b', etf: '#22c55e', bdr: '#a855f7', outro: '#8b93a1' };
const KNOWN_ETF = new Set(('BOVA11 BOVV11 BOVX11 BOVB11 BRAX11 SMAL11 SMAC11 IVVB11 SPXI11 NASD11 HASH11 QBTC11 BITH11 ETHE11 QETH11 ' +
  'GOLD11 IMAB11 IRFM11 B5P211 FIXA11 DIVO11 ECOO11 ISUS11 MATB11 PIBB11 XBOV11 BBSD11 GOVE11 FIND11 ACWI11 ' +
  'EURP11 XINA11 TECK11 WRLD11 BDIV11 NSDV11 USDB11 DEBB11 IB5M11 LFTS11 B5MB11 IMBB11 AUPO11 META11 SPXR11').split(' '));
function guessClass(t) {
  if (KNOWN_ETF.has(t)) return 'etf';
  if (screener?.tk?.[t]) return 'acao';
  if (/^[A-Z]{4}3[2-5]$/.test(t)) return 'bdr';
  if (/^[A-Z]{4}11$/.test(t)) return 'fii';
  if (/^[A-Z0-9]{4}([3-8])$/.test(t)) return 'acao';
  return 'outro';
}
const classOf = (t) => classes[t] || guessClass(t);
function setClass(t, c) {
  if (!CLASSES[c]) return;
  if (c === guessClass(t)) delete classes[t]; else classes[t] = c;
  save(KEY_CLASSES, classes);
}

// Gráfico de pizza (rosca) em SVG
function donut(items, total, centerLabel) {
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = items.map(([, v, color]) => {
    const len = (v / total) * C;
    const a = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${color}" stroke-width="26"
      stroke-dasharray="${Math.max(0, len - (items.length > 1 ? 1.5 : 0)).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
    off += len;
    return a;
  }).join('');
  return `<div class="pie">
    <svg viewBox="0 0 140 140" role="img" aria-label="Gráfico de pizza da composição"><g transform="rotate(-90 70 70)">${arcs}</g>
      <text x="70" y="66" text-anchor="middle" class="pie-n">${items.length}</text>
      <text x="70" y="84" text-anchor="middle" class="pie-l">${esc(centerLabel)}</text></svg>
    <div class="legend">${items.map(([k, v, color]) => `<div class="lg"><i style="background:${color}"></i>
      <span>${esc(k)}</span><b>${pct0(v / total * 100)}</b><em>${money(v)}</em></div>`).join('')}</div>
  </div>`;
}

// =====================================================================
// Render — aba Carteira
// =====================================================================
function render() {
  const ps = positions();
  const open = ps.filter((p) => p.qty > 0).sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost));

  let cost = 0, value = 0, day = 0, priced = 0;
  for (const p of open) {
    cost += p.cost;
    if (p.quote) { value += p.value; day += p.day; priced++; }
    else value += p.cost;
  }
  const pl = value - cost;
  $('#sumValue').textContent = money(value);
  $('#sumCost').textContent = money(cost);
  $('#sumPL').innerHTML = priced ? `<span class="${cls(pl)}">${signed(pl)}<br><small>${cost ? pct(pl / cost * 100) : ''}</small></span>` : '—';

  const times = open.map((p) => p.quote && p.quote.fetchedAt).filter(Boolean);
  $('#updated').textContent = times.length
    ? `Atualizado às ${new Date(Math.min(...times)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · cotações com atraso`
    : '';

  $('#tokenWarn').classList.add('hidden');
  updateWarnBtn();
  $('#empty').classList.toggle('hidden', open.length > 0);

  const byClass = {};
  for (const p of open) (byClass[classOf(p.ticker)] ||= []).push(p);
  const multi = Object.keys(byClass).length > 1;
  $('#list').innerHTML = Object.keys(CLASSES).filter((c) => byClass[c]).map((c) => {
    const list = byClass[c];
    const v = list.reduce((s, p) => s + (p.value ?? p.cost), 0);
    const share = value ? v / value * 100 : 0;
    return `<div class="grp"><div class="grp-h"><span><i style="background:${CLASS_COLOR[c]}"></i>${CLASSES[c]}</span>
      <span>${money(v)}${multi ? ` · ${pct0(share)}` : ''}</span></div>${list.map(posHtml).join('')}</div>`;
  }).join('');

  $('#tickerList').innerHTML = [...new Set([...ps.map((p) => p.ticker), ...Object.keys(screener?.rows || {})])]
    .map((t) => `<option value="${esc(t)}">`).join('');

  renderInsights(ps, open, value, cost);
}

function posHtml(p) {
    const q = p.quote;
    const right = q
      ? `<div class="v">${money(p.value)}</div><div class="p ${cls(p.pl)}">${signed(p.pl)} (${pct(p.plPct)})</div>`
      : `<div class="v">${money(p.cost)}</div><div class="p">sem cotação</div>`;
    const dayChip = q ? `<span class="now">${money(q.price)}</span><span class="chip ${cls(q.changePct)}">${pct(q.changePct)}</span>` : '';
    return `<button class="pos" data-t="${esc(p.ticker)}">
      ${logoHtml(p.ticker)}
      <div><div class="t">${esc(p.ticker)}${dayChip}</div>
        <div class="s">${num.format(p.qty)} × PM ${money(p.avg)}</div></div>
      <div class="r">${right}</div>
    </button>`;
}

function logoHtml(ticker, big = false) {
  const q = quotes[ticker];
  const inner = q && q.logo ? `<img src="${esc(q.logo)}" alt="" loading="lazy" onerror="this.remove()">` : esc(ticker.slice(0, 4));
  return `<div class="logo${big ? ' big' : ''}">${inner}</div>`;
}

function renderInsights(ps, open, value, cost) {
  buildRows();
  $('#insights').classList.toggle('hidden', !ps.length);
  if (!ps.length) return;

  // ---- Composição (pizza): por ativo, por classe ou por setor
  const mode = document.querySelector('input[name=comp]:checked').value;
  const groups = {};
  for (const p of open) {
    const c = classOf(p.ticker);
    const k = mode === 'classe' ? c : mode === 'setor' ? (screener?.rows?.[p.ticker]?.sector || CLASS_ONE[c] + (c === 'acao' ? ' (sem setor)' : '')) : p.ticker;
    groups[k] = (groups[k] || 0) + (p.value ?? p.cost);
  }
  const tot = Object.values(groups).reduce((a, b) => a + b, 0) || 1;
  const items = Object.entries(groups).sort((a, b) => b[1] - a[1])
    .map(([k, v], i) => mode === 'classe' ? [CLASSES[k], v, CLASS_COLOR[k]] : [k, v, PALETTE[i % PALETTE.length]]);
  const top = items[0];
  const center = { ativo: items.length === 1 ? 'ativo' : 'ativos', classe: items.length === 1 ? 'classe' : 'classes', setor: items.length === 1 ? 'setor' : 'setores' }[mode];
  $('#composition').innerHTML = (open.length ? donut(items, tot, center) : '') + (top && top[1] / tot > 0.35 && items.length > 1 && mode !== 'classe'
    ? `<div class="note warn-t">Concentração: ${esc(top[0])} é ${pct0(top[1] / tot * 100)} da carteira.</div>` : '');



}
const PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#0ea5e9', '#eab308'];

// =====================================================================
// Render — aba Screener
// =====================================================================
const dec = (v, d = 1) => v == null || !isFinite(v) ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const FILTERS = {
  fProfit: (r, v) => r.profitUp >= +v,
  fRev: (r, v) => r.revUp != null && r.revUp >= +v,
  fRoe: (r, v) => r.roe != null && r.roe >= +v,
  fPe: (r, v) => r.pe != null && r.pe <= +v,
  fDy: (r, v) => r.dy != null && r.dy >= +v,
  fDebt: (r, v) => r.debt == null ? r.fin : r.debt <= +v,
  fMargin: (r, v) => r.margin != null && r.margin >= +v,
};

function spark(vals) {
  const v = vals.slice(-6);
  const max = Math.max(...v.map((x) => Math.abs(x || 0)), 1e-9);
  const w = 6, gap = 3, h = 22;
  return `<svg class="spark" viewBox="0 0 ${v.length * (w + gap)} ${h}" aria-hidden="true">${v.map((x, i) => {
    const bh = Math.max(1.5, Math.abs(x || 0) / max * (h / 2 - 1));
    return `<rect x="${i * (w + gap)}" y="${x >= 0 ? h / 2 - bh : h / 2}" width="${w}" height="${bh}" rx="1.5" class="${x == null ? 'na' : x >= 0 ? 'up' : 'down'}"/>`;
  }).join('')}</svg>`;
}

function renderScreener() {
  if (!screener) { $('#scrMeta').textContent = 'Carregando dados da CVM…'; $('#scrList').innerHTML = ''; return; }
  buildRows();
  const sel = $('#scrSector');
  if (sel.options.length <= 1) {
    const sectors = [...new Set(Object.values(screener.rows).map((r) => r.sector))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    sel.insertAdjacentHTML('beforeend', sectors.map((s) => `<option>${esc(s)}</option>`).join(''));
  }
  const term = norm($('#scrSearch').value);
  const sector = sel.value;
  const need = [...document.querySelectorAll('#scrMethods input[value]:checked')].map((i) => i.value);
  const liquid = $('#scrLiquid').checked;
  const noLoss = $('#fNoLoss').checked;
  const good = $('#scrGood').checked;
  const active = Object.keys(FILTERS).filter((id) => $('#' + id).value);
  const owned = new Set(positions().filter((p) => p.qty > 0).map((p) => p.ticker));
  const nAdv = active.length + (noLoss ? 1 : 0);
  $('#advCount').textContent = nAdv ? `(${nAdv})` : '';

  const rows = Object.keys(screener.rows).map((t) => valuation(t))
    .filter((r) => !term || norm(r.ticker).includes(term) || norm(r.sector).includes(term) || norm(r.name).includes(term))
    .filter((r) => !sector || r.sector === sector)
    .filter((r) => need.every((m) => r[m]))
    .filter((r) => !liquid || r.vol >= 1 || owned.has(r.ticker))
    .filter((r) => !noLoss || r.noLoss)
    .filter((r) => !good || gradeOf(r).good)
    .filter((r) => active.every((id) => FILTERS[id](r, $('#' + id).value)));
  const sortBy = $('#scrSort').value;
  const asc = (f) => (a, b) => (f(a) ?? Infinity) - (f(b) ?? Infinity);
  const desc = (f) => (a, b) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity);
  rows.sort({
    pot: desc((r) => r.potential), potAsc: asc((r) => r.potential), pe: asc((r) => r.pe), dy: desc((r) => r.dy),
    roe: desc((r) => r.roe), up: (a, b) => b.profitUp - a.profitUp || (b.roe ?? -1e9) - (a.roe ?? -1e9),
    tk: (a, b) => a.ticker.localeCompare(b.ticker),
    nota: (a, b) => gradeOf(b).score - gradeOf(a).score || (b.roe ?? -1e9) - (a.roe ?? -1e9),
  }[$('#scrSort').value] || desc((r) => r.potential));

  const d = screener.rodada ? new Date(screener.rodada) : null;
  const year = Object.values(screener.rows)[0]?.year;
  $('#scrMeta').innerHTML = `${rows.length} ações · balanço ${year || ''} (CVM)` +
    (d && !isNaN(d) ? ` · preços de ${d.toLocaleDateString('pt-BR')}` : '') +
    (good ? '<div class="scr-good-note">★ Boas empresas: lucro crescente, dívida líq./EBITDA abaixo de 2x (ou caixa líquido), ROE acima de 15% de forma recorrente, margens estáveis e P/L abaixo da média do setor ou do próprio histórico.</div>' : '');

  const shown = rows.slice(0, 150);
  $('#scrList').innerHTML = (shown.map((r) => {
    const pot = r.potential;
    return `<button class="scr" data-a="${esc(r.ticker)}">
      <div class="scr-top">
        <div class="scr-l"><span class="t">${esc(r.ticker)}</span>${owned.has(r.ticker) ? '<span class="chip own">na carteira</span>' : ''}
          <div class="s">${esc(r.sector)}</div></div>
        <div class="scr-sp" title="Lucro por ano">${spark(screener.emp[r.emp].lc)}</div>
        <div class="r"><div class="v ${pot == null ? '' : cls(pot)}">${pot == null ? '—' : pct(pot)}</div>
          <div class="s">${money(r.price)}${r.combined ? ` → ${money(r.combined)}` : ''}</div></div>
      </div>
      <div class="kpis"><span>P/L <b>${dec(r.pe)}</b></span><span>ROE <b>${r.roe == null ? '—' : pct0(r.roe)}</b></span>
        <span>DY <b>${r.dy == null ? '—' : pct0(r.dy)}</b></span>${r.profitUp >= 2 ? `<span class="up">lucro ↑ ${r.profitUp} anos</span>` : ''}${good || sortBy === 'nota' ? (() => { const g = gradeOf(r); return `<span class="nota">✓ ${g.score}/${g.total}</span>`; })() : ''}</div>
    </button>`;
  }).join('') + (rows.length > shown.length ? `<p class="note">Mostrando 150 de ${rows.length}. Use a busca ou os filtros.</p>` : ''))
    || '<p class="empty">Nenhuma ação com esses filtros.</p>';
}

// =====================================================================
// Detalhe / análise de uma ação
// =====================================================================
async function openAsset(ticker) {
  const p = positions().find((x) => x.ticker === ticker);
  drawAsset(ticker, p, null);
  $('#posAddTx').dataset.t = ticker;
  showDialog('#dlgPos');
  try {
    const h = await fetchHistory(ticker);
    if ($('#dlgPos').open && $('#posBody').dataset.t === ticker) drawAsset(ticker, positions().find((x) => x.ticker === ticker), h);
  } catch {
    const el = $('#chart'); if (el) el.innerHTML = '<div class="note">Histórico indisponível (confira o token em ⚙).</div>';
  }
}

function barChart(title, years, vals) {
  if (!vals.some((x) => x != null)) return '';
  const max = Math.max(...vals.map((x) => Math.abs(x || 0)), 1e-9);
  const fmt = (x) => x == null ? '—' : Math.abs(x) >= 1000 ? `${dec(x / 1000)} bi` : `${dec(x, 0)} mi`;
  return `<div class="bars"><div class="bars-t">${title}</div><div class="bars-g">${vals.map((x, i) => `
    <div class="bc" title="${years[i]}: ${fmt(x)}"><div class="bw"><div class="b ${x < 0 ? 'down' : ''}" style="height:${x == null ? 0 : Math.max(2, Math.abs(x) / max * 100).toFixed(1)}%"></div></div><span>${years[i]}</span></div>`).join('')}
  </div></div>`;
}

// ---- Análise (checklist) e histórico anual/trimestral
const median = (a) => { const v = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const sumN = (a) => a.every((x) => x != null) ? a.reduce((s, x) => s + x, 0) : null;

// Séries por ano de uma ação (P/L pelo preço no fim de cada ano)
function yearSeries(t) {
  const [ei, , k, , px = []] = screener.tk[t];
  const e = screener.emp[ei];
  const n = screener.anos.length;
  const out = { labels: screener.anos.map(String), lc: e.lc, r: e.r, eb: e.eb || [], dv: e.dv, roe: [], margin: [], ndEb: [], pe: [], dy: [] };
  for (let i = 0; i < n; i++) {
    const lc = e.lc[i], pl = e.pl[i], r = e.r[i], eb = e.eb?.[i], dl = e.dla?.[i];
    const mc = px[i] != null && e.ac ? px[i] / k * e.ac : null; // valor de mercado no fim do ano (R$ mi)
    out.roe.push(lc != null && pl > 0 ? lc / pl * 100 : null);
    out.margin.push(!e.fin && r > 0 && lc != null ? lc / r * 100 : null);
    out.ndEb.push(!e.fin && dl != null && eb > 0 ? dl / eb : null);
    out.pe.push(mc && lc > 0 ? mc / lc : null);
    out.dy.push(mc && e.dv[i] != null ? e.dv[i] / mc * 100 : null);
  }
  return out;
}

// Séries por trimestre (ROE, P/L e Dív./EBITDA usam os últimos 12 meses)
function quarterSeries(t) {
  const [ei, , k] = screener.tk[t];
  const e = screener.emp[ei];
  const q = tri?.emp[ei];
  if (!q) return null;
  const px = tri.px[t] || [];
  const out = { labels: tri.tri.map((s) => s.slice(5) + 'T' + s.slice(2, 4)), lc: q.lc, r: q.r, eb: q.eb, roe: [], margin: [], ndEb: [], pe: [] };
  for (let i = 0; i < q.lc.length; i++) {
    const w = (a) => i >= 3 ? sumN(a.slice(i - 3, i + 1)) : null;
    const lc12 = w(q.lc), eb12 = w(q.eb);
    const mc = px[i] != null && e.ac ? px[i] / k * e.ac : null;
    out.roe.push(lc12 != null && q.pl[i] > 0 ? lc12 / q.pl[i] * 100 : null);
    out.margin.push(!e.fin && q.r[i] > 0 && q.lc[i] != null ? q.lc[i] / q.r[i] * 100 : null);
    out.ndEb.push(!e.fin && q.dl[i] != null && eb12 > 0 ? q.dl[i] / eb12 : null);
    out.pe.push(mc && lc12 > 0 ? mc / lc12 : null);
  }
  return out;
}

let tri = null, triLoading = null;
function loadTri() {
  if (tri || triLoading) return triLoading;
  triLoading = fetch('data/tri.json', { cache: 'no-cache' }).then((r) => r.ok ? r.json() : null)
    .then((j) => { tri = j; return j; }).catch(() => null).finally(() => { triLoading = null; });
  return triLoading;
}

// P/L mediano do setor (empresas com lucro)
let secPE = null;
function sectorPE(sector) {
  buildRows();
  if (secPE?.rows === screener.rows) return secPE.map.get(sector) ?? null;
  secPE = { rows: screener.rows, map: new Map() };
  for (const sec of new Set(Object.values(screener.rows).map((r) => r.sector))) secPE.map.set(sec, sectorPE0(sec));
  return secPE.map.get(sector) ?? null;
}
function sectorPE0(sector) {
  const v = Object.values(screener.rows).filter((r) => r.sector === sector && r.pe > 0 && r.pe < 100);
  const seen = new Set(), pes = [];
  for (const r of v) if (!seen.has(r.emp)) { seen.add(r.emp); pes.push(r.pe); }
  return pes.length >= 3 ? { pe: median(pes), n: pes.length } : null;
}

function analysisItems(t, v) {
  const e = screener.emp[v.emp];
  const s = yearSeries(t);
  const items = [];
  const add = (st, title, text, id) => items.push({ st, title, text, id });
  const last = (a, n) => a.slice(-n);

  // 1. Lucro crescente e consistente
  const lcs = e.lc.map((x, i) => [x, i]).filter(([x]) => x != null);
  if (lcs.length >= 3) {
    let ups = 0;
    for (let i = 1; i < lcs.length; i++) if (lcs[i][0] > lcs[i - 1][0]) ups++;
    const losses = lcs.filter(([x]) => x <= 0).length;
    const [a0, i0] = lcs[0], [a1, i1] = lcs[lcs.length - 1];
    const cagr = a0 > 0 && a1 > 0 ? (Math.pow(a1 / a0, 1 / (i1 - i0)) - 1) * 100 : null;
    const ratio = ups / (lcs.length - 1);
    add(losses === 0 && ratio >= 0.6 && cagr > 0 ? 'ok' : cagr > 0 && losses <= 1 ? 'warn' : 'bad', 'Lucro crescente',
      `Subiu em ${ups} de ${lcs.length - 1} anos (${screener.anos[i0]}–${screener.anos[i1]})` +
      (cagr != null ? ` · ${cagr >= 0 ? '+' : ''}${dec(cagr)}% ao ano` : '') + (losses ? ` · ${losses} ano${losses > 1 ? 's' : ''} com prejuízo` : ''), 'lucro');
  }

  // 2. Dívida líquida / EBITDA
  if (e.fin) add('na', 'Dívida líquida/EBITDA', 'Não se aplica a bancos e seguradoras.', 'divida');
  else {
    const [nd] = lastNum(s.ndEb);
    const [dl] = lastNum(e.dla || []);
    if (dl != null && dl < 0) add('ok', 'Dívida líquida/EBITDA', 'Caixa maior que a dívida (caixa líquido).', 'divida');
    else if (nd != null) add(nd < 2 ? 'ok' : nd <= 3 ? 'warn' : 'bad', 'Dívida líquida/EBITDA', `${dec(nd, 2)}x · bom abaixo de 2–3x (varia por setor)`, 'divida');
    else add('bad', 'Dívida líquida/EBITDA', 'EBITDA negativo ou sem dados.', 'divida');
  }

  // 3. ROE acima de 15% de forma recorrente
  const roes = last(s.roe, 5).filter((x) => x != null);
  if (roes.length) {
    const hi = roes.filter((x) => x >= 15).length;
    add(hi >= 4 && roes[roes.length - 1] >= 15 ? 'ok' : hi >= 2 ? 'warn' : 'bad', 'ROE acima de 15%',
      `Em ${hi} de ${roes.length} anos · último ${pct0(roes[roes.length - 1])} · média ${pct0(roes.reduce((a, b) => a + b, 0) / roes.length)}`, 'roe');
  }

  // 4. Margens estáveis ou crescentes
  if (!e.fin) {
    const ms = last(s.margin, 5).filter((x) => x != null);
    if (ms.length >= 3) {
      const first = ms.slice(0, -1).reduce((a, b) => a + b, 0) / (ms.length - 1), lastM = ms[ms.length - 1];
      const st = lastM <= 0 ? 'bad' : lastM >= first - 1 ? (lastM < 3 ? 'warn' : 'ok') : lastM >= first * 0.7 ? 'warn' : 'bad';
      add(st, 'Margens', `Margem líquida ${pct0(lastM)} no último ano · média anterior ${pct0(first)}`, 'margem');
    }
  }

  // 5. P/L vs setor e vs histórico
  if (v.pe != null) {
    const sp = sectorPE(v.sector);
    if (sp) add(v.pe <= sp.pe ? 'ok' : v.pe <= sp.pe * 1.3 ? 'warn' : 'bad', 'P/L vs setor',
      `${dec(v.pe)} vs ${dec(sp.pe)} (mediana de ${sp.n} empresas de ${v.sector})`, 'plSetor');
    else add('info', 'P/L vs setor', `${dec(v.pe)} · poucas empresas no setor ${v.sector} para comparar`, 'plSetor');
    const hist = median(last(s.pe, 5));
    if (hist) add(v.pe <= hist ? 'ok' : v.pe <= hist * 1.3 ? 'warn' : 'bad', 'P/L vs histórico',
      `${dec(v.pe)} vs ${dec(hist)} (mediana dos últimos 5 anos)`, 'plHist');
  } else add('bad', 'P/L', 'Sem lucro no último ano: P/L não se aplica.', 'plSetor');

  // 6. P/VP (mais útil para bancos e empresas com muitos ativos)
  if (v.pvp != null) add(e.fin ? (v.pvp <= 1.5 ? 'ok' : v.pvp <= 2.5 ? 'warn' : 'bad') : 'info', 'P/VP',
    `${dec(v.pvp, 2)}` + (e.fin ? ' · em bancos, abaixo de 1,5 costuma ser barato' : ' · mais útil para bancos e empresas com muitos ativos'));

  // 7. Dividend yield (desconfiar de muito alto)
  if (v.dy != null) {
    const dvs = last(e.dv, 4).filter((x) => x != null);
    const spike = dvs.length >= 3 && dvs[dvs.length - 1] > 2 * median(dvs.slice(0, -1));
    add(v.dy > 12 || spike ? 'warn' : v.dy >= 4 ? 'ok' : 'info', 'Dividend yield',
      `${pct0(v.dy)}` + (v.dy > 12 ? ' · muito alto: pode ser pontual ou sinal de problema' : spike ? ' · último ano bem acima da média (pode não se repetir)' : v.dy >= 4 ? ' · bom para renda' : ' · baixo para quem busca renda'));
  }

  return items;
}

// "Boa empresa": saúde financeira toda boa e preço não esticado
function grade(t, v) {
  const it = analysisItems(t, v);
  const st = (id) => it.filter((x) => x.id === id).map((x) => x.st);
  const okOr = (id, ...alt) => { const a = st(id); return a.length > 0 && a.every((x) => x === 'ok' || alt.includes(x)); };
  const health = okOr('lucro') && okOr('divida', 'na') && okOr('roe') && (v.fin || okOr('margem'));
  const price = [...st('plSetor'), ...st('plHist')];
  const fair = price.length > 0 && !price.includes('bad') && price.includes('ok');
  const score = it.filter((x) => x.st === 'ok').length, total = it.filter((x) => x.st !== 'info' && x.st !== 'na').length;
  return { good: health && fair, score, total };
}
const gradeCache = new Map();
function gradeOf(r) {
  const key = r.ticker + '|' + r.price;
  if (!gradeCache.has(key)) gradeCache.set(key, grade(r.ticker, r));
  return gradeCache.get(key);
}

function analysis(t, v) {
  const items = analysisItems(t, v);
  const icon = { ok: '✓', warn: '!', bad: '✕', info: 'i', na: '–' };
  return `<h3 class="sub">Análise <small>balanço ${v.year} · CVM</small></h3><div class="card ana">
    ${items.map((x) => `<div class="ck s-${x.st}"><i>${icon[x.st]}</i><div><b>${x.title}</b><span>${esc(x.text)}</span></div></div>`).join('')}
    <div class="note">Regras de bolso para estudo, não é recomendação.</div></div>`;
}

let histMode = 'ano';
const scrollHist = () => document.querySelectorAll('#posBody .htab').forEach((el) => (el.scrollLeft = el.scrollWidth));
function histBlock(t, v) {
  const e = screener.emp[v.emp];
  const s = histMode === 'tri' ? (tri ? quarterSeries(t) : null) : yearSeries(t);
  const seg = `<div class="seg small" id="histSeg">
    <label><input type="radio" name="hm" value="ano"${histMode === 'ano' ? ' checked' : ''}><span>Anual</span></label>
    <label><input type="radio" name="hm" value="tri"${histMode === 'tri' ? ' checked' : ''}><span>Trimestral</span></label></div>`;
  if (!s) return `<h3 class="sub">Histórico</h3>${seg}<div class="card"><div class="note">${histMode === 'tri' && !tri ? 'Carregando trimestres…' : 'Sem dados trimestrais desta empresa.'}</div></div>`;
  const big = (x) => x == null ? '—' : Math.abs(x) >= 1000 ? `${dec(x / 1000)} bi` : `${dec(x, 0)} mi`;
  const p0 = (x) => x == null ? '—' : dec(x, 0) + '%';
  const tri_ = histMode === 'tri';
  const rows = [
    ['Lucro líquido', s.lc, big],
    ...(e.fin ? [] : [['Receita', s.r, big], ['EBITDA', s.eb, big], ['Margem líq.', s.margin, p0]]),
    [tri_ ? 'ROE 12m' : 'ROE', s.roe, p0],
    ...(e.fin ? [] : [[tri_ ? 'Dív.líq./EBITDA 12m' : 'Dív.líq./EBITDA', s.ndEb, (x) => dec(x)]]),
    [tri_ ? 'P/L 12m' : 'P/L', s.pe, (x) => dec(x)],
    ...(tri_ ? [] : [['DY', s.dy, (x) => x == null ? '—' : dec(x) + '%'], ['Dividendos', s.dv, big]]),
  ];
  const n = s.labels.length;
  const table = `<div class="htab"><table><thead><tr><th></th>${s.labels.map((l) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(([l, a, f]) => `<tr><th>${l}</th>${Array.from({ length: n }, (_, i) => `<td class="${a[i] < 0 ? 'down' : ''}">${f(a[i])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
  const lab = s.labels.map((l) => tri_ ? l : l.slice(2));
  return `<h3 class="sub">Histórico <small>${tri_ ? 'por trimestre' : 'por ano'}</small></h3>${seg}
    <div class="card">${barChart('Lucro líquido', lab, s.lc)}${e.fin ? '' : barChart('Receita', lab, s.r) + barChart('EBITDA', lab, s.eb)}
      ${table}
      <div class="note">${tri_ ? 'Trimestre de 3 meses (o 4º = ano − 9 meses). ROE, Dív./EBITDA e P/L usam os últimos 12 meses.' : 'P/L e DY de cada ano usam o preço no fim do ano.'} Fonte: CVM; preços: Yahoo Finance.</div></div>`;
}

function drawAsset(ticker, p, h) {
  const q = quotes[ticker];
  const v = valuation(ticker);
  const price = q?.price ?? v?.price;
  const has = p && (p.qty > 0 || p.txs.length);
  const cell = (l, val, c = '') => `<div class="cell"><div class="label">${l}</div><div class="v ${c}">${val}</div></div>`;

  let html = `<div class="det-head">${logoHtml(ticker, true)}
      <div><div class="t">${esc(ticker)}</div><div class="s">${esc(q?.name || v?.sector || '')}</div></div>
      <div class="det-price">${price ? money(price) : ''}${q ? `<div class="${cls(q.changePct)}">${pct(q.changePct)} hoje</div>` : ''}</div></div>
    ${has ? `<label class="cls-row">Tipo de ativo <select id="posClass">${Object.keys(CLASSES).map((c) =>
      `<option value="${c}"${classOf(ticker) === c ? ' selected' : ''}>${CLASS_ONE[c]}</option>`).join('')}</select></label>` : ''}
    <div id="chart" class="chart">${h ? chartSvg(h.prices, p && p.qty > 0 ? p.avg : null) : '<div class="note">Carregando gráfico…</div>'}</div>`;

  if (has) {
    html += `<div class="grid">
      ${cell('Quantidade', num.format(p.qty))}
      ${cell('Preço médio', money(p.avg))}
      ${cell('Investido', money(p.cost))}
      ${cell('Valor atual', p.quote ? money(p.value) : '—')}
      ${cell('Lucro/Prejuízo', p.quote ? `${signed(p.pl)}<br><small>${pct(p.plPct)}</small>` : '—', p.quote ? cls(p.pl) : '')}
      ${cell('Lucro realizado', signed(p.realized), cls(p.realized))}
      ${cell('Proventos recebidos', signed(p.income), cls(p.income))}
      ${cell('Resultado total', signed((p.pl || 0) + p.realized + p.income), cls((p.pl || 0) + p.realized + p.income))}
    </div>`;
  }

  // Valor justo + fundamentos (CVM)
  if (v) {
    const e = screener.emp[v.emp];
    if (v.combined) {
      const scale = Math.max(price || 0, ...v.methods.map(([, x]) => x), v.combined || 0) * 1.05;
      const row = (label, x, strong) => `<div class="vj ${strong ? 'strong' : ''}"><span>${label}</span>
        <div class="track"><div style="width:${(x / scale * 100).toFixed(1)}%"></div>${price ? `<i style="left:${(price / scale * 100).toFixed(1)}%"></i>` : ''}</div>
        <b>${money(x)}</b><em class="${cls(x - price)}">${price ? pct((x / price - 1) * 100) : ''}</em></div>`;
      html += `<h3 class="sub">Valor justo estimado</h3><div class="card">
        ${row('Combinado', v.combined, true)}
        ${v.methods.map(([m, x]) => row(m, x)).join('')}
        ${['Graham', 'Bazin'].filter((m) => !v.methods.some(([n]) => n === m)).map((m) => `<div class="vj na"><span>${m}</span><div class="na-t">não se aplica</div></div>`).join('')}
        <div class="note">Linha branca = preço atual.</div>
        <details class="how"><summary>Como é calculado</summary>
          <p><b>Graham:</b> √(22,5 × LPA × VPA), com lucro e patrimônio dos controladores do último balanço anual.</p>
          <p><b>Bazin:</b> média dos dividendos e JCP pagos nos últimos 3 anos ÷ 6%; só se pagou em cada um dos últimos 5 anos.</p>
          <p><b>Combinado:</b> média dos métodos que se aplicam. Estimativa para estudo, não é recomendação.</p>
        </details>
      </div>`;
    }
    const cellv = (l, val) => `<div class="cell"><div class="label">${l}</div><div class="v">${val}</div></div>`;
    html += `<h3 class="sub">Fundamentos <small>balanço ${v.year} · CVM</small></h3>
      <div class="grid three">
        ${cellv('P/L', dec(v.pe))}${cellv('P/VP', dec(v.pvp, 2))}${cellv('ROE', v.roe == null ? '—' : pct0(v.roe))}
        ${cellv('Margem líq.', v.margin == null ? '—' : pct0(v.margin))}${cellv('Div. Yield', v.dy == null ? '—' : pct0(v.dy))}
        ${cellv('Dív.líq./EBITDA', v.fin ? 'n/a' : (() => { const [x] = lastNum(yearSeries(ticker).ndEb); return x == null ? '—' : dec(x, 2) + 'x'; })())}
      </div>
      ${analysis(ticker, v)}
      <div id="histBox">${histBlock(ticker, v)}</div>`;
  }

  // Proventos por ação (brapi)
  if (h && h.divs.length) {
    const yearAgo = new Date(); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const y0 = yearAgo.toLocaleDateString('sv-SE');
    const last12 = h.divs.filter((d) => d.com >= y0);
    const sum12 = last12.reduce((s, d) => s + d.rate, 0);
    const heldAt = (iso) => p ? qtyAt(p.ticker, iso) : 0;
    const recent = [...h.divs].sort((a, b) => b.com.localeCompare(a.com)).slice(0, 8);
    html += `<h3 class="sub">Proventos</h3><div class="card">
      <div class="kv"><span>Últimos 12 meses (por ação)</span><b>${money(sum12)}</b></div>
      ${price ? `<div class="kv"><span>Dividend yield 12m</span><b>${pct0(sum12 / price * 100)}</b></div>` : ''}
      ${recent.map((d) => { const qh = heldAt(d.com); return `<div class="tx">
        <div><span class="tag income">${esc(d.label)}</span>${money(d.rate)}/ação
          <div class="d">data com ${fmtDate(d.com)}${d.pay ? ` · paga ${fmtDate(d.pay)}` : ''}</div></div>
        <div>${qh ? money(qh * d.rate) : ''}</div><div></div></div>`; }).join('')}
      ${p ? '<div class="note">Valor à direita = estimativa pelo que você tinha na data com (bruto, antes do IR do JCP).</div>' : ''}
    </div>`;
  }

  // Operações
  if (has) {
    html += `<h3 class="sub">Operações</h3><div class="txs">
      ${[...p.txs].reverse().map((t) => txRow(t)).join('')}
    </div>`;
  }
  $('#posBody').innerHTML = html;
  $('#posBody').dataset.t = ticker;
  scrollHist();
}

function txRow(t) {
  const label = { buy: 'COMPRA', sell: 'VENDA', split: t.qty > 0 ? 'EVENTO +' : 'EVENTO −', income: (t.kind || 'PROVENTO').toUpperCase() }[t.type];
  const main = t.type === 'income' ? money(t.amount)
    : t.type === 'split' ? `${num.format(Math.abs(t.qty))} ações`
    : `${num.format(t.qty)} × ${money(t.price)}`;
  const right = t.type === 'buy' || t.type === 'sell' ? money(t.qty * t.price) : '';
  return `<div class="tx">
    <div><span class="tag ${t.type}">${esc(label)}</span>${main}
      <div class="d">${fmtDate(t.date)}${t.fees ? ` · taxas ${money(t.fees)}` : ''}${t.broker ? ` · ${esc(t.broker)}` : ''}</div></div>
    <div>${right}</div>
    <button class="del" data-del="${t.id}" aria-label="Apagar operação">✕</button>
  </div>`;
}

function qtyAt(ticker, iso) {
  let q = 0;
  for (const t of sortedTxs()) {
    if (t.ticker !== ticker || t.date > iso) continue;
    if (t.type === 'buy') q += t.qty;
    else if (t.type === 'sell') q -= Math.min(q, t.qty);
    else if (t.type === 'split') q = Math.max(0, q + t.qty);
  }
  return q;
}

function chartSvg(prices, avg) {
  if (!prices || prices.length < 2) return '<div class="note">Sem histórico.</div>';
  const W = 340, H = 140, P = 4;
  const ys = prices.map((p) => p.c).concat(avg ? [avg] : []);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const x = (i) => P + (i / (prices.length - 1)) * (W - 2 * P);
  const y = (v) => P + (1 - (v - min) / span) * (H - 2 * P);
  const d = prices.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join('');
  const up = prices[prices.length - 1].c >= prices[0].c;
  const color = up ? 'var(--up)' : 'var(--down)';
  const chg = (prices[prices.length - 1].c / prices[0].c - 1) * 100;
  const start = new Date(prices[0].t).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Gráfico de preço">
      <path d="${d} L${x(prices.length - 1)},${H} L${x(0)},${H}Z" fill="${color}" opacity=".12"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
      ${avg ? `<line x1="0" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" stroke="#fff" stroke-dasharray="4 4" opacity=".5" vector-effect="non-scaling-stroke"/>` : ''}
    </svg>
    <div class="chart-leg"><span>desde ${start}: <b class="${cls(chg)}">${pct(chg)}</b></span>
      <span>mín ${money(Math.min(...prices.map((p) => p.c)))} · máx ${money(Math.max(...prices.map((p) => p.c)))}</span>
      ${avg ? '<span>- - - seu preço médio</span>' : ''}</div>`;
}

// =====================================================================
// Formulário de operação + lançamento por frase
// =====================================================================
function openTxForm(ticker = '') {
  const f = $('#formTx');
  f.reset();
  f.ticker.value = ticker;
  f.date.value = todayIso();
  $('#txHint').textContent = '';
  clsTouched = false;
  syncClassPick();
  setTxMode('buy');
  showDialog('#dlgTx');
  setTimeout(() => (ticker ? f.qty : $('#quick')).focus(), 50);
}

function setTxMode(type) {
  const f = $('#formTx');
  f.querySelector(`input[name=type][value=${type}]`).checked = true;
  const inc = type === 'income';
  $('#fQty').classList.toggle('hidden', inc);
  $('#fPrice').classList.toggle('hidden', inc);
  $('#fFees').classList.toggle('hidden', inc);
  $('#fAmount').classList.toggle('hidden', !inc);
  $('#fKind').classList.toggle('hidden', !inc);
  f.qty.required = !inc; f.price.required = !inc; f.amount.required = inc;
  $('#fClass').classList.toggle('hidden', type !== 'buy');
}

// Tipo de ativo no formulário: sugere pelo código até a pessoa escolher
let clsTouched = false;
function syncClassPick() {
  if (clsTouched) return;
  const t = normTicker($('#formTx').ticker.value);
  const c = t ? classOf(t) : 'acao';
  $('#formTx').querySelector(`input[name=cls][value=${c}]`).checked = true;
}

function updateTxHint() {
  const f = $('#formTx');
  const type = f.type.value;
  if (type === 'income') { $('#txHint').textContent = ''; return; }
  const t = normTicker(f.ticker.value);
  const p = positions().find((x) => x.ticker === t);
  const qty = parseNum(f.qty.value), price = parseNum(f.price.value), fees = parseNum(f.fees.value);
  if (!p || !p.qty) { $('#txHint').textContent = qty && price ? `Total: ${money(qty * price + (type === 'buy' ? fees : -fees))}` : ''; return; }
  if (type === 'buy' && qty && price) {
    const newAvg = (p.cost + qty * price + fees) / (p.qty + qty);
    $('#txHint').textContent = `Você tem ${num.format(p.qty)} a PM ${money(p.avg)} → novo PM ${money(newAvg)}`;
  } else if (type === 'sell' && qty && price) {
    const res = Math.min(qty, p.qty) * (price - p.avg) - fees;
    $('#txHint').innerHTML = `Você tem ${num.format(p.qty)} · resultado da venda: <span class="${cls(res)}">${signed(res)}</span>`;
  } else {
    $('#txHint').textContent = `Você tem ${num.format(p.qty)} a PM ${money(p.avg)}`;
  }
}

// "comprei 100 petr4 a 32,50 ontem" · "vendi 50 vale3 por 61 dia 03/11" · "recebi 12,40 de dividendos de itsa4"
function parseQuick(text) {
  // "1.000" = mil (milhar com ponto); converte antes de usar parseNum
  const s = norm(text).replace(/r\$\s*/g, '').replace(/\b\d{1,3}(?:\.\d{3})+(?![\d,])/g, (m) => m.replace(/\./g, ''));
  const out = {};
  if (/\b(vend|venda)/.test(s)) out.type = 'sell';
  else if (/\b(receb|provento|dividendo|jcp|juros sobre|rendimento)/.test(s)) out.type = 'income';
  else if (/\b(compr|compra|adquiri|aport)/.test(s)) out.type = 'buy';
  const tk = s.match(/\b([a-z]{4}\d{1,2}f?)\b/);
  if (tk) out.ticker = tk[1].toUpperCase().replace(/^([A-Z]{4}\d{1,2})F$/, '$1');
  const n = '(\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?|\\d+(?:[.,]\\d+)?)';
  if (out.type === 'income') {
    const m = s.match(new RegExp(`(?:receb\\w*|de)\\s+${n}`)) || s.match(new RegExp(n));
    if (m) out.amount = parseNum(m[1]);
    if (/jcp|juros sobre/.test(s)) out.kind = 'JCP'; else if (/rendimento/.test(s)) out.kind = 'Rendimento'; else out.kind = 'Dividendo';
  } else {
    const q = s.match(new RegExp(`${n}\\s*(?:acoes|acao|cotas?|papeis)?\\s*(?:de\\s+)?[a-z]{4}\\d`));
    if (q) out.qty = parseNum(q[1]);
    const pr = s.match(new RegExp(`(?:\\ba\\b|\\bpor\\b|@|cada|preco)\\s*${n}`));
    if (pr) out.price = parseNum(pr[1]);
    const tx = s.match(new RegExp(`(?:taxa|taxas|corretagem)\\s*(?:de\\s*)?${n}`));
    if (tx) out.fees = parseNum(tx[1]);
  }
  const d = new Date();
  if (/\banteontem\b/.test(s)) { d.setDate(d.getDate() - 2); out.date = d.toLocaleDateString('sv-SE'); }
  else if (/\bontem\b/.test(s)) { d.setDate(d.getDate() - 1); out.date = d.toLocaleDateString('sv-SE'); }
  const dm = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (dm) {
    let y = dm[3] ? +dm[3] : d.getFullYear(); if (y < 100) y += 2000;
    out.date = `${y}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
  }
  return out;
}

function applyQuick() {
  const text = $('#quick').value;
  if (!text.trim()) return;
  const r = parseQuick(text);
  const f = $('#formTx');
  if (r.type) setTxMode(r.type);
  if (r.ticker) { f.ticker.value = r.ticker; syncClassPick(); }
  if (r.qty) f.qty.value = String(r.qty);
  if (r.price) f.price.value = String(r.price).replace('.', ',');
  if (r.fees) f.fees.value = String(r.fees).replace('.', ',');
  if (r.amount) f.amount.value = String(r.amount).replace('.', ',');
  if (r.kind) f.kind.value = r.kind;
  if (r.date) f.date.value = r.date;
  const missing = [];
  if (!r.ticker) missing.push('código');
  if (r.type !== 'income' && !r.qty) missing.push('quantidade');
  if (r.type !== 'income' && !r.price) missing.push('preço');
  if (r.type === 'income' && !r.amount) missing.push('valor');
  updateTxHint();
  if (missing.length) toast(`Confira: faltou ${missing.join(', ')}`);
}

// =====================================================================
// Importar planilhas da B3 (Área do Investidor: Negociação e Movimentação)
// =====================================================================
let pendingImport = null;

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Falha ao carregar o leitor de planilhas'));
    document.head.appendChild(s);
  });
}

function cellDate(v) {
  if (v instanceof Date) { const d = new Date(v.getTime() + 12 * 3600_000); return d.toISOString().slice(0, 10); }
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const iso = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}
const cellNum = (v) => (v === '-' || v === '' || v == null ? 0 : parseNum(v));
const tickerFromProduct = (p) => { const m = String(p || '').toUpperCase().match(/^\s*([A-Z0-9]{4}\d{1,2}[A-Z]?)\b/); return m ? m[1].replace(/^([A-Z0-9]{4}\d{1,2})F$/, '$1') : null; };

const MOV_INCOME = { 'dividendo': 'Dividendo', 'juros sobre capital proprio': 'JCP', 'rendimento': 'Rendimento', 'juros': 'Juros', 'pagamento de juros': 'Juros' };
const MOV_IGNORED = {
  'transferencia - liquidacao': 'Liquidação de compra/venda (vem da planilha de Negociação)',
  'transferencia': 'Transferência entre corretoras: a posição total não muda',
  'fracao em ativos': 'Fração de evento (vendida no leilão)',
  'leilao de fracao': 'Venda de frações de evento',
  'direito de subscricao': 'Direito de subscrição recebido',
  'direitos de subscricao - nao exercido': 'Direito de subscrição não exercido',
  'cessao de direitos': 'Venda de direitos de subscrição',
  'cessao de direitos - solicitada': 'Venda de direitos de subscrição',
  'emprestimo': 'Aluguel de ações: a posição continua sua',
  'cobranca de taxa semestral': 'Taxa de custódia do Tesouro',
  'atualizacao': 'Atualização de posição pela B3',
};
const MOV_MANUAL = {
  'grupamento': 'Grupamento: lance o evento manualmente (quantidade que saiu)',
  'direitos de subscricao - exercido': 'Subscrição exercida: lance a compra manualmente',
  'recibo de subscricao': 'Subscrição: lance a compra manualmente',
  'subscricao': 'Subscrição: lance a compra manualmente',
  'incorporacao': 'Incorporação: lance a troca de ativos manualmente',
  'amortizacao': 'Amortização: não ajusta o preço médio automaticamente',
  'restituicao de capital': 'Restituição de capital: não ajusta o preço médio automaticamente',
};

function parseSheetRows(rows) {
  // Descobre a linha de cabeçalho e o tipo de planilha
  const out = [];
  if (!rows.length) return { kind: null, out };
  const head = Object.keys(rows[0]).map(norm);
  const pick = (r, ...names) => { for (const k of Object.keys(r)) if (names.includes(norm(k))) return r[k]; return undefined; };
  const isNeg = head.includes('data do negocio');
  const isMov = head.includes('movimentacao') && head.includes('entrada/saida');
  rows.forEach((r, i) => {
    const line = i + 2;
    if (isNeg) {
      const market = norm(pick(r, 'mercado') || 'mercado a vista');
      const tipo = norm(pick(r, 'tipo de movimentacao'));
      const code = String(pick(r, 'codigo de negociacao') || '').toUpperCase().trim();
      if (!code && !tipo) return;
      if (!['mercado a vista', 'mercado fracionario'].includes(market)) return out.push({ line, ignored: `${pick(r, 'mercado')}: opções, termo e futuros não entram` });
      if (!['compra', 'venda'].includes(tipo)) return out.push({ line, error: `Tipo desconhecido: ${pick(r, 'tipo de movimentacao')}` });
      const date = cellDate(pick(r, 'data do negocio'));
      const qty = cellNum(pick(r, 'quantidade')), price = cellNum(pick(r, 'preco'));
      if (!date || !code || qty <= 0 || price <= 0) return out.push({ line, error: 'Data, código, quantidade ou preço inválido' });
      out.push({ line, tx: { type: tipo === 'compra' ? 'buy' : 'sell', ticker: code.replace(/^([A-Z0-9]{4}\d{1,2})F$/, '$1'), qty, price, fees: 0, date, broker: String(pick(r, 'instituicao') || '').trim() } });
    } else if (isMov) {
      const label = String(pick(r, 'movimentacao') || '').trim();
      const kind = norm(label);
      if (!kind) return;
      const credit = norm(pick(r, 'entrada/saida')) === 'credito';
      const date = cellDate(pick(r, 'data'));
      const ticker = tickerFromProduct(pick(r, 'produto'));
      const broker = String(pick(r, 'instituicao') || '').trim();
      if (MOV_IGNORED[kind]) return out.push({ line, ignored: MOV_IGNORED[kind] });
      if (MOV_MANUAL[kind]) return out.push({ line, error: `${MOV_MANUAL[kind]} (${ticker || pick(r, 'produto')})` });
      if (MOV_INCOME[kind]) {
        const amount = cellNum(pick(r, 'valor da operacao'));
        if (!credit) return out.push({ line, ignored: `${label} a débito` });
        if (!date || !ticker || amount <= 0) return out.push({ line, error: `${label}: data, ativo ou valor inválido` });
        return out.push({ line, tx: { type: 'income', ticker, amount, kind: MOV_INCOME[kind], qty: cellNum(pick(r, 'quantidade')), price: 0, fees: 0, date, broker } });
      }
      if (kind === 'desdobro' || kind === 'bonificacao em ativos') {
        const qty = cellNum(pick(r, 'quantidade'));
        if (!date || !ticker || qty <= 0) return out.push({ line, error: `${label}: dados inválidos` });
        return out.push({ line, tx: { type: 'split', ticker, qty, price: 0, fees: 0, date, broker, kind: label } });
      }
      out.push({ line, ignored: `${label}: tipo não tratado` });
    }
  });
  return { kind: isNeg ? 'Negociação' : isMov ? 'Movimentação' : null, out };
}

// Chave pelo conteúdo + posição entre linhas iguais: reimportar não duplica
function txKey(t) {
  return [t.date, t.type, t.ticker, +(+t.qty || 0).toFixed(6), +(+t.price || 0).toFixed(6), +(+t.amount || 0).toFixed(2), t.broker || ''].join('|');
}
function withKeys(list) {
  const seen = {};
  return list.map((t) => { const b = t.key ? t.key.replace(/#\d+$/, '') : txKey(t); seen[b] = (seen[b] || 0) + 1; return { ...t, key: `${b}#${seen[b]}` }; });
}

async function handleImportFiles(files) {
  $('#impPreview').innerHTML = '<div class="note">Lendo planilhas…</div>';
  try { await loadSheetJS(); } catch (e) { $('#impPreview').innerHTML = `<div class="note warn-t">${esc(e.message)}</div>`; return; }
  const parsed = [];
  const kinds = [];
  for (const file of files) {
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: true });
        const { kind, out } = parseSheetRows(rows);
        if (!kind) continue;
        kinds.push(`${file.name} (${kind})`);
        out.forEach((o) => parsed.push({ ...o, file: file.name }));
      }
    } catch { parsed.push({ file: file.name, line: '-', error: 'Não consegui ler este arquivo' }); }
  }
  if (!kinds.length && !parsed.length) {
    $('#impPreview').innerHTML = '<div class="note warn-t">Não reconheci a planilha. Use os arquivos de Negociação ou Movimentação da Área do Investidor da B3.</div>';
    return;
  }
  const existing = new Set(withKeys(txs).map((t) => t.key));
  const incoming = withKeys(parsed.filter((o) => o.tx).map((o) => o.tx));
  const fresh = incoming.filter((t) => !existing.has(t.key));
  const dup = incoming.length - fresh.length;
  const ignored = parsed.filter((o) => o.ignored);
  const errors = parsed.filter((o) => o.error);
  pendingImport = fresh;

  const count = (type) => fresh.filter((t) => t.type === type).length;
  const list = (arr, k) => arr.slice(0, 30).map((o) => `<li>${esc(o.file)} · linha ${o.line}: ${esc(o[k])}</li>`).join('') + (arr.length > 30 ? `<li>… e mais ${arr.length - 30}</li>` : '');
  $('#impPreview').innerHTML = `
    <div class="note">${esc(kinds.join(', '))}</div>
    <div class="imp-grid">
      <div class="cell"><div class="label">Novas</div><div class="v up">${fresh.length}</div></div>
      <div class="cell"><div class="label">Já existiam</div><div class="v">${dup}</div></div>
      <div class="cell"><div class="label">Ignoradas</div><div class="v">${ignored.length}</div></div>
      <div class="cell"><div class="label">Com erro</div><div class="v ${errors.length ? 'down' : ''}">${errors.length}</div></div>
    </div>
    ${fresh.length ? `<div class="note">${count('buy')} compras · ${count('sell')} vendas · ${count('income')} proventos · ${count('split')} eventos</div>` : ''}
    ${errors.length ? `<details open><summary>Com erro (não entram)</summary><ul>${list(errors, 'error')}</ul></details>` : ''}
    ${ignored.length ? `<details><summary>Ignoradas</summary><ul>${list(ignored, 'ignored')}</ul></details>` : ''}`;
  $('#btnDoImport').disabled = !fresh.length;
  $('#btnDoImport').textContent = fresh.length ? `Importar ${fresh.length}` : 'Nada novo';
}

function doImport() {
  if (!pendingImport?.length) return;
  let id = Date.now();
  txs = withKeys(txs).concat(pendingImport.map((t) => ({ ...t, id: id++ })));
  save(KEY_TX, txs);
  const n = pendingImport.length;
  pendingImport = null;
  $('#dlgImport').close();
  render(); refreshQuotes();
  // Avisa se alguma venda ficou maior que a posição (falta histórico antigo)
  const neg = [];
  const hold = {};
  for (const t of sortedTxs()) {
    hold[t.ticker] ||= 0;
    if (t.type === 'buy') hold[t.ticker] += t.qty;
    else if (t.type === 'split') hold[t.ticker] += t.qty;
    else if (t.type === 'sell') { if (t.qty > hold[t.ticker] + 1e-9) neg.push(t.ticker); hold[t.ticker] = Math.max(0, hold[t.ticker] - t.qty); }
  }
  toast(`${n} operações importadas` + (neg.length ? ` · atenção: venda maior que a posição em ${[...new Set(neg)].join(', ')} (faltam compras antigas)` : ''));
}

// =====================================================================
// Diálogos, toast, abas
// =====================================================================
function updateWarnBtn() {
  const n = document.querySelectorAll('#dlgWarn .warn:not(.hidden)').length;
  $('#btnWarn').classList.toggle('hidden', !n);
  $('#warnCount').textContent = n > 1 ? n : '';
}
function showDialog(sel) { const d = $(sel); if (!d.open) d.showModal(); }
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

let tab = 'Carteira';
function setTab(name) {
  tab = name;
  $('#tabCarteira').classList.toggle('hidden', name !== 'Carteira');
  $('#tabScreener').classList.toggle('hidden', name !== 'Screener');
  $('#pageTitle').textContent = name;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'Screener') { renderScreener(); loadScreener(); }
  window.scrollTo(0, 0);
}

// =====================================================================
// Eventos
// =====================================================================
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { close.closest('dialog').close(); return; }
  if (e.target.tagName === 'DIALOG') { e.target.close(); return; } // toque fora
  const tb = e.target.closest('.tabbar button');
  if (tb) { setTab(tb.dataset.tab); return; }
  const pos = e.target.closest('.pos');
  if (pos) { openAsset(pos.dataset.t); return; }
  const scr = e.target.closest('.scr');
  if (scr) { openAsset(scr.dataset.a); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = Number(del.dataset.del);
    const t = txs.find((x) => x.id === id);
    const what = { buy: 'compra', sell: 'venda', split: 'evento', income: 'provento' }[t?.type];
    if (t && confirm(`Apagar ${what} de ${t.ticker} em ${fmtDate(t.date)}?`)) {
      txs = txs.filter((x) => x.id !== id);
      save(KEY_TX, txs);
      render();
      const still = positions().find((x) => x.ticker === t.ticker);
      if (still && still.txs.length) drawAsset(t.ticker, still, histCache[t.ticker]); else $('#dlgPos').close();
    }
  }
});

$('#btnAdd').onclick = () => openTxForm();
$('#posAddTx').onclick = (e) => { const t = e.target.dataset.t; $('#dlgPos').close(); openTxForm(t); };
$('#btnRefresh').onclick = () => { refreshQuotes(true); loadScreener(true); };
$('#btnSettings').onclick = () => { $('#setToken').value = token; showDialog('#dlgSettings'); };
$('#formTx').addEventListener('input', updateTxHint);
$('#formTx').addEventListener('change', (e) => {
  if (e.target.name === 'type') { setTxMode(e.target.value); updateTxHint(); }
  if (e.target.name === 'cls') clsTouched = true;
});
$('#txTicker').addEventListener('input', syncClassPick);
$('#posBody').addEventListener('change', (e) => {
  if (e.target.id !== 'posClass') return;
  const t = $('#posBody').dataset.t;
  setClass(t, e.target.value);
  render();
  toast(`${t} agora está em ${CLASSES[e.target.value]}`);
});
$('#btnQuick').onclick = applyQuick;
$('#quick').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyQuick(); } });
document.querySelectorAll('input[name=comp]').forEach((i) => i.addEventListener('change', render));
['#scrSearch', '#scrSector', '#scrSort'].forEach((s) => $(s).addEventListener('input', renderScreener));
$('#scrMethods').addEventListener('change', renderScreener);
$('#scrAdv').addEventListener('change', renderScreener);
$('#posBody').addEventListener('change', async (ev) => {
  if (ev.target.name !== 'hm') return;
  histMode = ev.target.value;
  const t = $('#posBody').dataset.t, box = $('#histBox'), v = valuation(t);
  if (!box || !v) return;
  box.innerHTML = histBlock(t, v); scrollHist();
  if (histMode === 'tri' && !tri) { await loadTri(); if ($('#posBody').dataset.t === t && $('#histBox')) $('#histBox').innerHTML = histBlock(t, v); scrollHist(); }
});
$('#advClear').onclick = () => { document.querySelectorAll('#scrAdv select').forEach((x) => (x.value = '')); $('#fNoLoss').checked = false; renderScreener(); };

$('#formTx').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const ticker = normTicker(f.ticker.value);
  const type = f.type.value;
  if (!/^[A-Z0-9]{4,8}$/.test(ticker)) return toast('Código inválido (ex.: PETR4)');
  if (type === 'income') {
    const amount = parseNum(f.amount.value);
    if (amount <= 0) return toast('Informe o valor recebido');
    txs.push({ id: Date.now(), type, ticker, amount, kind: f.kind.value, qty: 0, price: 0, fees: 0, date: f.date.value });
  } else {
    const qty = parseNum(f.qty.value), price = parseNum(f.price.value), fees = parseNum(f.fees.value);
    if (qty <= 0 || price <= 0) return toast('Quantidade e preço precisam ser maiores que zero');
    if (type === 'sell') {
      const p = positions().find((x) => x.ticker === ticker);
      if (!p || p.qty < qty - 1e-9) return toast(`Você só tem ${p ? num.format(p.qty) : 0} ${ticker}`);
    }
    txs.push({ id: Date.now(), type, ticker, qty, price, fees, date: f.date.value });
    if (type === 'buy') setClass(ticker, f.cls.value);
  }
  save(KEY_TX, txs);
  f.closest('dialog').close();
  render();
  if (!quotes[ticker] || Date.now() - quotes[ticker].fetchedAt > 60_000) refreshQuotes();
});

$('#formSettings').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('#setToken').value.trim();
  save(KEY_TOKEN, token);
  $('#dlgSettings').close();
  render();
  refreshQuotes(true);
});

$('#btnOpenImport').onclick = () => {
  $('#dlgSettings').close();
  pendingImport = null;
  $('#impPreview').innerHTML = '';
  $('#btnDoImport').disabled = true;
  $('#btnDoImport').textContent = 'Importar';
  showDialog('#dlgImport');
};
$('#emptyImport').onclick = (e) => { e.preventDefault(); $('#btnOpenImport').click(); };
$('#impFiles').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) handleImportFiles(files); };
$('#btnDoImport').onclick = doImport;

$('#btnExport').onclick = async () => {
  const data = JSON.stringify({ app: 'carteira', version: 3, exportedAt: new Date().toISOString(), txs, classes }, null, 2);
  const name = `carteira-${todayIso()}.json`;
  const file = new File([data], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Backup Carteira' }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('#fileImport').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    const list = Array.isArray(j) ? j : j.txs;
    if (!Array.isArray(list)) throw new Error();
    const types = ['buy', 'sell', 'split', 'income'];
    const clean = list.filter((t) => t && t.ticker && t.date && types.includes(t.type) &&
      (t.type === 'income' ? t.amount > 0 : t.type === 'split' ? t.qty : t.qty > 0 && t.price > 0));
    if (!confirm(`Importar ${clean.length} operações? Isso substitui as ${txs.length} atuais.`)) return;
    txs = clean.map((t, i) => ({
      id: t.id || Date.now() + i, type: t.type, ticker: normTicker(t.ticker),
      qty: +t.qty || 0, price: +t.price || 0, fees: +t.fees || 0, date: t.date,
      ...(t.amount ? { amount: +t.amount } : {}), ...(t.kind ? { kind: t.kind } : {}),
      ...(t.broker ? { broker: t.broker } : {}), ...(t.key ? { key: t.key } : {}),
    }));
    save(KEY_TX, txs);
    if (j && j.classes && typeof j.classes === 'object') {
      classes = Object.fromEntries(Object.entries(j.classes).filter(([, c]) => CLASSES[c]));
      save(KEY_CLASSES, classes);
    }
    mergeFractional();
    $('#dlgSettings').close();
    render(); refreshQuotes();
    toast('Backup importado');
  } catch { toast('Arquivo inválido'); }
};

// Atualiza ao abrir / voltar para o app e a cada 5 min com o app visível
const STALE_MS = 5 * 60_000;
function refreshIfStale() {
  const open = positions().filter((p) => p.qty > 0);
  if (open.some((p) => !p.quote || Date.now() - p.quote.fetchedAt > STALE_MS)) refreshQuotes();
  loadScreener();
 
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
setInterval(() => { if (!document.hidden) refreshIfStale(); }, 60_000);

try { render(); } catch (err) { console.error(err); }
refreshIfStale();
syncBackupStore();

// Fora do app instalado (Safari, navegador do WhatsApp/Instagram) os dados ficam em outro lugar
// e o iPhone apaga depois de alguns dias sem uso.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installHidden = false;
try { installHidden = localStorage.getItem('carteira.installHidden') === '1'; } catch {}
$('#installWarn').classList.toggle('hidden', standalone || installHidden);
updateWarnBtn();
$('#btnWarn').onclick = () => showDialog('#dlgWarn');
$('#tokenGo').onclick = () => { $('#dlgWarn').close(); $('#btnSettings').click(); };
$('#installClose').onclick = () => {
  $('#installWarn').classList.add('hidden');
  updateWarnBtn();
  if (!document.querySelectorAll('#dlgWarn .warn:not(.hidden)').length) $('#dlgWarn').close();
  try { localStorage.setItem('carteira.installHidden', '1'); } catch {}
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
