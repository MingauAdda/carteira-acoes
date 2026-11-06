'use strict';

// ---------- Armazenamento ----------
const KEY_TX = 'carteira.tx.v1';
const KEY_QUOTES = 'carteira.quotes.v1';
const KEY_TOKEN = 'carteira.token';

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let txs = load(KEY_TX, []);          // [{id,type,ticker,qty,price,fees,date}]
let quotes = load(KEY_QUOTES, {});   // {TICKER: {price, change, changePct, time, name, logo, fetchedAt}}
let token = load(KEY_TOKEN, '');

// ---------- Formatação ----------
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 8 });
const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(2).replace('.', ',') + '%';
const money = (v) => brl.format(v);
const signed = (v) => (v > 0 ? '+' : '') + brl.format(v);
const cls = (v) => (v > 0.0001 ? 'up' : v < -0.0001 ? 'down' : '');
const parseNum = (s) => {
  if (s == null) return 0;
  s = String(s).trim().replace(/\s|R\$/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
};
const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Cálculo de posição (preço médio) ----------
// Compra: custo += qtd*preço + taxas; PM = custo / qtd.
// Venda: não altera o PM; lucro realizado = qtd*(preço - PM) - taxas.
function positions() {
  const map = {};
  const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  for (const t of sorted) {
    const p = map[t.ticker] ||= { ticker: t.ticker, qty: 0, cost: 0, realized: 0, txs: [] };
    p.txs.push(t);
    if (t.type === 'buy') {
      p.cost += t.qty * t.price + (t.fees || 0);
      p.qty += t.qty;
    } else {
      const avg = p.qty > 0 ? p.cost / p.qty : 0;
      const q = Math.min(t.qty, p.qty);
      p.realized += q * (t.price - avg) - (t.fees || 0);
      p.qty -= q;
      p.cost = avg * p.qty;
    }
    if (p.qty < 1e-9) { p.qty = 0; p.cost = 0; }
  }
  return Object.values(map).map((p) => {
    p.avg = p.qty > 0 ? p.cost / p.qty : 0;
    const q = quotes[p.ticker];
    p.quote = q;
    if (q && p.qty > 0) {
      p.value = p.qty * q.price;
      p.pl = p.value - p.cost;
      p.plPct = p.cost > 0 ? (p.pl / p.cost) * 100 : 0;
      p.day = p.qty * (q.change || 0);
    }
    return p;
  });
}

// ---------- Cotações (brapi.dev) ----------
async function fetchQuote(ticker) {
  const url = `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}` + (token ? `?token=${encodeURIComponent(token)}` : '');
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.message || `HTTP ${r.status}`);
  const q = j.results && j.results[0];
  if (!q || q.regularMarketPrice == null) throw new Error('sem cotação');
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

let refreshing = false;
async function refreshQuotes(manual = false) {
  if (refreshing) return;
  const tickers = [...new Set(positions().filter((p) => p.qty > 0).map((p) => p.ticker))];
  if (!tickers.length) return;
  refreshing = true;
  $('#btnRefresh').classList.add('spin');
  const errors = [];
  await Promise.all(tickers.map(async (t) => {
    try { quotes[t] = await fetchQuote(t); }
    catch (e) { errors.push(`${t}: ${e.message}`); }
  }));
  save(KEY_QUOTES, quotes);
  refreshing = false;
  $('#btnRefresh').classList.remove('spin');
  render();
  if (errors.length && (manual || !token)) toast(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1})` : ''));
}

// ---------- UI ----------
const $ = (s) => document.querySelector(s);

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
  const prevValue = value - day;
  $('#sumDay').innerHTML = priced ? `<span class="${cls(day)}">${signed(day)}<br><small>${prevValue ? pct(day / prevValue * 100) : ''}</small></span>` : '—';

  const times = open.map((p) => p.quote && p.quote.fetchedAt).filter(Boolean);
  $('#updated').textContent = times.length
    ? `Atualizado às ${new Date(Math.min(...times)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · cotações com atraso`
    : '';

  $('#tokenWarn').classList.toggle('hidden', !!token || !open.length);
  $('#empty').classList.toggle('hidden', open.length > 0);

  $('#list').innerHTML = open.map((p) => {
    const q = p.quote;
    const logo = q && q.logo ? `<img src="${esc(q.logo)}" alt="" loading="lazy" onerror="this.remove()">` : esc(p.ticker.slice(0, 4));
    const right = q
      ? `<div class="v">${money(p.value)}</div><div class="p ${cls(p.pl)}">${signed(p.pl)} (${pct(p.plPct)})</div>`
      : `<div class="v">${money(p.cost)}</div><div class="p">sem cotação</div>`;
    const dayChip = q ? `<span class="chip ${cls(q.changePct)}">${pct(q.changePct)}</span>` : '';
    return `<button class="pos" data-t="${esc(p.ticker)}">
      <div class="logo">${logo}</div>
      <div><div class="t">${esc(p.ticker)}${dayChip}</div>
        <div class="s">${num.format(p.qty)} × PM ${money(p.avg)}${q ? ` · ${money(q.price)}` : ''}</div></div>
      <div class="r">${right}</div>
    </button>`;
  }).join('');

  $('#tickerList').innerHTML = ps.map((p) => `<option value="${esc(p.ticker)}">`).join('');
}

function openPosition(ticker) {
  const p = positions().find((x) => x.ticker === ticker);
  if (!p) return;
  const q = p.quote;
  const logo = q && q.logo ? `<img src="${esc(q.logo)}" alt="" onerror="this.remove()">` : esc(ticker.slice(0, 4));
  const cell = (l, v, c = '') => `<div class="cell"><div class="label">${l}</div><div class="v ${c}">${v}</div></div>`;
  $('#posBody').innerHTML = `
    <div class="det-head"><div class="logo">${logo}</div>
      <div><div class="t">${esc(ticker)}</div><div class="s">${q ? esc(q.name) : ''}</div></div></div>
    <div class="grid">
      ${cell('Quantidade', num.format(p.qty))}
      ${cell('Preço médio', money(p.avg))}
      ${cell('Cotação', q ? money(q.price) : '—')}
      ${cell('Hoje', q ? pct(q.changePct) : '—', q ? cls(q.changePct) : '')}
      ${cell('Investido', money(p.cost))}
      ${cell('Valor atual', q ? money(p.value) : '—')}
      ${cell('Lucro/Prejuízo', q ? `${signed(p.pl)}<br><small>${pct(p.plPct)}</small>` : '—', q ? cls(p.pl) : '')}
      ${cell('Lucro realizado', signed(p.realized), cls(p.realized))}
    </div>
    <div class="txs"><h3>Operações</h3>
      ${[...p.txs].reverse().map((t) => `<div class="tx">
        <div><span class="tag ${t.type}">${t.type === 'buy' ? 'COMPRA' : 'VENDA'}</span>${num.format(t.qty)} × ${money(t.price)}
          <div class="d">${fmtDate(t.date)}${t.fees ? ` · taxas ${money(t.fees)}` : ''}</div></div>
        <div>${money(t.qty * t.price)}</div>
        <button class="del" data-del="${t.id}" aria-label="Apagar operação">✕</button>
      </div>`).join('')}
    </div>`;
  $('#posAddTx').dataset.t = ticker;
  showDialog('#dlgPos');
}

function openTxForm(ticker = '') {
  const f = $('#formTx');
  f.reset();
  f.ticker.value = ticker;
  f.date.value = new Date().toLocaleDateString('sv-SE');
  $('#txHint').textContent = '';
  showDialog('#dlgTx');
  if (!ticker) setTimeout(() => f.ticker.focus(), 50);
  else setTimeout(() => f.qty.focus(), 50);
}

function updateTxHint() {
  const f = $('#formTx');
  const t = f.ticker.value.trim().toUpperCase();
  const p = positions().find((x) => x.ticker === t);
  const qty = parseNum(f.qty.value), price = parseNum(f.price.value), fees = parseNum(f.fees.value);
  const type = f.type.value;
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

function showDialog(sel) { const d = $(sel); if (!d.open) d.showModal(); }

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ---------- Eventos ----------
document.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { close.closest('dialog').close(); return; }
  if (e.target.tagName === 'DIALOG') { e.target.close(); return; } // toque fora
  const pos = e.target.closest('.pos');
  if (pos) { openPosition(pos.dataset.t); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    const id = Number(del.dataset.del);
    const t = txs.find((x) => x.id === id);
    if (t && confirm(`Apagar ${t.type === 'buy' ? 'compra' : 'venda'} de ${num.format(t.qty)} ${t.ticker} em ${fmtDate(t.date)}?`)) {
      txs = txs.filter((x) => x.id !== id);
      save(KEY_TX, txs);
      render();
      const still = positions().find((x) => x.ticker === t.ticker);
      if (still && still.txs.length) openPosition(t.ticker); else $('#dlgPos').close();
    }
  }
});

$('#btnAdd').onclick = () => openTxForm();
$('#posAddTx').onclick = (e) => { const t = e.target.dataset.t; $('#dlgPos').close(); openTxForm(t); };
$('#btnRefresh').onclick = () => refreshQuotes(true);
$('#btnSettings').onclick = () => { $('#setToken').value = token; showDialog('#dlgSettings'); };
$('#formTx').addEventListener('input', updateTxHint);

$('#formTx').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const ticker = f.ticker.value.trim().toUpperCase().replace(/\.SA$/, '');
  const qty = parseNum(f.qty.value), price = parseNum(f.price.value), fees = parseNum(f.fees.value);
  const type = f.type.value;
  if (!/^[A-Z0-9]{4,8}$/.test(ticker)) return toast('Código inválido (ex.: PETR4)');
  if (qty <= 0 || price <= 0) return toast('Quantidade e preço precisam ser maiores que zero');
  if (type === 'sell') {
    const p = positions().find((x) => x.ticker === ticker);
    if (!p || p.qty < qty - 1e-9) return toast(`Você só tem ${p ? num.format(p.qty) : 0} ${ticker}`);
  }
  txs.push({ id: Date.now(), type, ticker, qty, price, fees, date: f.date.value });
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

$('#btnExport').onclick = async () => {
  const data = JSON.stringify({ app: 'carteira', version: 1, exportedAt: new Date().toISOString(), txs }, null, 2);
  const name = `carteira-${new Date().toLocaleDateString('sv-SE')}.json`;
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
    const clean = list.filter((t) => t && t.ticker && t.qty > 0 && t.price > 0 && t.date && (t.type === 'buy' || t.type === 'sell'));
    if (!confirm(`Importar ${clean.length} operações? Isso substitui as ${txs.length} atuais.`)) return;
    txs = clean.map((t, i) => ({ id: t.id || Date.now() + i, type: t.type, ticker: String(t.ticker).toUpperCase(), qty: +t.qty, price: +t.price, fees: +t.fees || 0, date: t.date }));
    save(KEY_TX, txs);
    $('#dlgSettings').close();
    render();
    refreshQuotes();
    toast('Backup importado');
  } catch { toast('Arquivo inválido'); }
};

// Atualiza ao abrir / voltar para o app e a cada 5 min com o app visível
const STALE_MS = 5 * 60_000;
function refreshIfStale() {
  const open = positions().filter((p) => p.qty > 0);
  if (open.some((p) => !p.quote || Date.now() - p.quote.fetchedAt > STALE_MS)) refreshQuotes();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfStale(); });
setInterval(() => { if (!document.hidden) refreshIfStale(); }, 60_000);

render();
refreshIfStale();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
