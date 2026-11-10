"""Gera data/screener.json (anual) e data/tri.json (trimestral) com fundamentos oficiais da CVM.

Fontes (todas sem cadastro):
- CVM, Dados Abertos: DFP (anual), ITR (trimestral) e FCA (cadastro). Receita, lucro,
  EBIT, depreciação, patrimônio, dívida, caixa, dividendos pagos, nº de ações, códigos.
- brapi.dev /api/quote/list: cotação de fechamento, volume, valor de mercado e subsetor.
- Yahoo Finance (gráfico mensal): preço no fim de cada ano e trimestre, para o P/L histórico.
  A CVM não publica cotações.

Só biblioteca padrão do Python. Tudo é baixado em memória.
Roda no GitHub Actions (.github/workflows/screener.yml).
"""
import concurrent.futures as cf
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile

CVM = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC"
YEARS = 10      # anos no histórico anual
QUARTERS = 12   # trimestres no histórico trimestral
UA = {"User-Agent": "carteira-acoes-screener (github actions)"}
UA_WEB = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url, headers=UA, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 400) or i == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if i == tries - 1:
                raise
        time.sleep(2 + 3 * i)


def get_zip(url):
    try:
        return zipfile.ZipFile(io.BytesIO(get(url)))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def read_csv(z, name):
    if name not in z.namelist():
        return []
    raw = z.read(name)
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    return list(csv.DictReader(io.StringIO(text), delimiter=";"))


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def latest_version(rows):
    """Mantém só a versão mais recente de cada documento (CNPJ + data)."""
    best = {}
    for r in rows:
        k = (r["CNPJ_CIA"], r["DT_REFER"])
        best[k] = max(best.get(k, 0), int(r.get("VERSAO") or 0))
    return [r for r in rows if int(r.get("VERSAO") or 0) == best[(r["CNPJ_CIA"], r["DT_REFER"])]]


def value(r):
    v = num(r["VL_CONTA"])
    if v is None:
        return None
    if not r["CD_CONTA"].startswith("3.99"):  # lucro por ação não vem em milhares
        v *= 1000 if norm(r["ESCALA_MOEDA"]) == "mil" else 1
    return v


def by_company_year(rows):
    """DFP → {cnpj: {ano: {cd_conta: (descricao, valor_em_reais, ordem)}}} — ÚLTIMO e PENÚLTIMO."""
    out = {}
    for r in latest_version(rows):
        ordem = norm(r["ORDEM_EXERC"])
        if ordem not in ("ultimo", "penultimo"):
            continue
        v = value(r)
        if v is None:
            continue
        year = int(r["DT_FIM_EXERC"][:4])
        slot = out.setdefault(r["CNPJ_CIA"], {}).setdefault(year, {})
        slot[r["CD_CONTA"]] = (norm(r["DS_CONTA"]), v, ordem)
    return out


def by_company_period(rows):
    """ITR → {cnpj: {(inicio, fim): {cd_conta: (descricao, valor, 'ultimo')}}} — só o ÚLTIMO."""
    out = {}
    for r in latest_version(rows):
        if norm(r["ORDEM_EXERC"]) != "ultimo":
            continue
        v = value(r)
        if v is None:
            continue
        key = (r.get("DT_INI_EXERC", ""), r["DT_FIM_EXERC"])
        out.setdefault(r["CNPJ_CIA"], {}).setdefault(key, {})[r["CD_CONTA"]] = (norm(r["DS_CONTA"]), v, "ultimo")
    return out


def merge(dst, src):
    for cnpj, years in src.items():
        for y, accts in years.items():
            cur = dst.setdefault(cnpj, {}).setdefault(y, {})
            for cd, val in accts.items():
                # dado reapresentado (penúltimo de arquivo mais novo) vence o original
                if cd not in cur or val[2] == "penultimo" or cur[cd][2] == "ultimo":
                    cur[cd] = val


def con_or_ind(z, prefix, kind, y, parse):
    con = parse(read_csv(z, f"{prefix}_{kind}_con_{y}.csv"))
    ind = parse(read_csv(z, f"{prefix}_{kind}_ind_{y}.csv"))
    for cnpj in ind:  # sem consolidado → usa individual
        con.setdefault(cnpj, ind[cnpj])
    return con


def level(cd):
    return cd.count(".")


def dre_values(a):
    """Receita, lucro total, lucro dos controladores, EBIT e se é financeira."""
    receita = a.get("3.01", (None, None))[1]
    lucro_cd = ebit = None
    for cd in sorted(a):
        ds = a[cd][0]
        if re.fullmatch(r"3\.\d\d", cd) and cd != "3.99":
            if "lucro" in ds or "prejuizo" in ds:
                lucro_cd = cd
            if ebit is None and "antes do resultado financeiro" in ds:
                ebit = a[cd][1]
    d301 = a.get("3.01", ("",))[0]
    fin = "intermediacao financeira" in d301 or "seguro" in d301
    if not lucro_cd:
        return receita, None, None, ebit, fin
    lucro = a[lucro_cd][1]
    ctrl = lucro
    for cd, (ds, v, _) in a.items():
        if cd.startswith(lucro_cd + ".") and level(cd) == 2 and "controladora" in ds and "nao" not in ds and v:
            ctrl = v  # algumas empresas deixam a abertura zerada: aí vale o lucro total
    return receita, lucro, ctrl, ebit, fin


def bp_values(ativo, passivo):
    pl = minor = None
    debt = 0.0
    for cd, (ds, v, _) in passivo.items():
        if re.fullmatch(r"2\.\d\d", cd) and "patrimonio liquido" in ds:
            pl = v
        elif level(cd) == 2 and "nao controladores" in ds and cd.startswith("2.0"):
            minor = v
        elif re.fullmatch(r"2\.0[12]\.\d\d", cd) and "emprestimos e financiamentos" in ds:
            debt += v
    cash = sum(v for cd, (ds, v, _) in ativo.items() if cd in ("1.01.01", "1.01.02"))
    if pl is not None and minor:
        pl -= minor  # patrimônio dos controladores
    if not passivo:
        return None, None
    return pl, debt - cash


def dividends_paid(a):
    hits = {cd: v for cd, (ds, v, _) in a.items()
            if cd.startswith("6.") and v < 0 and ("dividendo" in ds or re.search(r"juros sobre (o )?capital", ds))
            and "recebid" not in ds}
    top = [cd for cd in hits if not any(cd != p and cd.startswith(p + ".") for p in hits)]
    return -sum(hits[cd] for cd in top)


def dep_amort(a):
    """Depreciação/amortização/exaustão somada de volta no fluxo de caixa operacional."""
    hits = {cd: v for cd, (ds, v, _) in a.items()
            if cd.startswith("6.01.") and re.search(r"deprecia|amortiza|exaust", ds) and "arrendamento" not in ds}
    if not hits:
        return None
    top = [cd for cd in hits if not any(cd != p and cd.startswith(p + ".") for p in hits)]
    return sum(abs(hits[cd]) for cd in top)


def unit_size(comp):
    """'1 ON + 2 PN' → 3 ações por unit."""
    parts = re.findall(r"(\d+)\s*(?:acao|acoes)?\s*(?:on|pn|ordinaria|preferencia|[a-z]{4}\d)", norm(comp))
    n = sum(int(x) for x in parts)
    return n if 2 <= n <= 10 and len(parts) >= 2 else None


def yahoo_monthly(code):
    """{(ano, mês): fechamento} — preço ajustado só por desdobro/grupamento."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.SA?range=12y&interval=1mo"
    j = json.loads(get(url, UA_WEB, tries=2))
    res = j["chart"]["result"][0]
    out = {}
    for t, c in zip(res.get("timestamp") or [], res["indicators"]["quote"][0].get("close") or []):
        if c:
            d = dt.datetime.fromtimestamp(t, dt.timezone(dt.timedelta(hours=-3)))
            out[(d.year, d.month)] = c
    return out


def qlabel(y, q):
    return f"{y}T{q}"


def main(out_path, tri_path):
    today = dt.date.today()
    m = lambda v: None if v is None else round(v / 1e6, 2)

    # ---------------- DFP (anual) ----------------
    dre, bpa, bpp, dfc, shares = {}, {}, {}, {}, {}
    for y in range(today.year - YEARS - 1, today.year + 1):
        z = get_zip(f"{CVM}/DFP/DADOS/dfp_cia_aberta_{y}.zip")
        if not z:
            log(f"DFP {y}: ainda não publicado")
            continue
        log(f"DFP {y}")
        for kind, dst in (("DRE", dre), ("BPA", bpa), ("BPP", bpp), ("DFC_MI", dfc), ("DFC_MD", dfc)):
            merge(dst, con_or_ind(z, "dfp_cia_aberta", kind, y, by_company_year))
        for r in latest_version(read_csv(z, f"dfp_cia_aberta_composicao_capital_{y}.csv")):
            total = (num(r["QT_ACAO_TOTAL_CAP_INTEGR"]) or 0) - (num(r["QT_ACAO_TOTAL_TESOURO"]) or 0)
            if total > 0:
                shares[r["CNPJ_CIA"]] = total
        del z

    # ---------------- ITR (trimestral, períodos de 3 meses e acumulado de 9 meses) ----------------
    idre, ibpa, ibpp, idfc = {}, {}, {}, {}
    for y in range(today.year - QUARTERS // 4 - 1, today.year + 1):
        z = get_zip(f"{CVM}/ITR/DADOS/itr_cia_aberta_{y}.zip")
        if not z:
            continue
        log(f"ITR {y}")
        for kind, dst in (("DRE", idre), ("BPA", ibpa), ("BPP", ibpp), ("DFC_MI", idfc), ("DFC_MD", idfc)):
            for cnpj, per in con_or_ind(z, "itr_cia_aberta", kind, y, by_company_period).items():
                dst.setdefault(cnpj, {}).update(per)
        del z

    # ---------------- Códigos de negociação (FCA mais recente que existir) ----------------
    tickers, sector_cvm, names = {}, {}, {}
    for y in (today.year, today.year - 1):
        z = get_zip(f"{CVM}/FCA/DADOS/fca_cia_aberta_{y}.zip")
        if not z:
            continue
        for r in read_csv(z, f"fca_cia_aberta_geral_{y}.csv"):
            sector_cvm.setdefault(r["CNPJ_Companhia"], r["Setor_Atividade"])
            names.setdefault(r["CNPJ_Companhia"], r["Nome_Empresarial"])
        for r in read_csv(z, f"fca_cia_aberta_valor_mobiliario_{y}.csv"):
            code = (r["Codigo_Negociacao"] or "").strip().upper()
            if not re.fullmatch(r"[A-Z0-9]{4}\d{1,2}", code) or norm(r["Mercado"]) != "bolsa" or r["Data_Fim_Negociacao"]:
                continue
            k = unit_size(r["Composicao_BDR_Unit"]) if code.endswith("11") else 1
            if k:
                tickers.setdefault(code, (r["CNPJ_Companhia"], k))
    log(f"{len(tickers)} códigos na CVM")

    # ---------------- Cotações atuais ----------------
    q = json.loads(get("https://brapi.dev/api/quote/list?type=stock&limit=5000"))
    quotes = {s["stock"]: s for s in q["stocks"] if s.get("close")}

    # último ano com balanço da maioria das empresas (exercícios que fecham no meio do ano não contam)
    cover = {}
    for c in dre.values():
        for y in c:
            cover[y] = cover.get(y, 0) + 1
    last_year = max((y for y, n in cover.items() if n >= max(cover.values()) * 0.5), default=today.year - 1)
    yrs = list(range(last_year - YEARS + 1, last_year + 1))

    # trimestres: até o último com resultado da maioria das empresas
    qcover = {}
    for per in idre.values():
        for (ini, fim) in per:
            if ini and fim[5:7] in ("03", "06", "09") and ini[5:7] == {"03": "01", "06": "04", "09": "07"}[fim[5:7]]:
                qcover[fim] = qcover.get(fim, 0) + 1
    last_q_end = max((f for f, n in qcover.items() if n >= max(qcover.values()) * 0.5), default=f"{last_year}-09-30")
    ly, lq = int(last_q_end[:4]), int(last_q_end[5:7]) // 3
    if last_year >= ly and lq < 4:  # anual mais novo que o último ITR → o último trimestre é o T4
        ly, lq = last_year, 4
    qs = []
    y_, q_ = ly, lq
    for _ in range(QUARTERS):
        qs.insert(0, (y_, q_))
        y_, q_ = (y_, q_ - 1) if q_ > 1 else (y_ - 1, 4)

    # valor de mercado por empresa (brapi) e preço por ação correspondente, para conferir o nº de ações
    mcap = {}
    for code, (cnpj, k) in tickers.items():
        s = quotes.get(code)
        if s and s.get("market_cap") and cnpj not in mcap:
            mcap[cnpj] = (s["market_cap"], s["close"] / k)

    def quarter(cnpj, y, qn):
        """Valores de um trimestre: receita, lucro ctrl, EBIT, D&A (3 meses) e PL, dív. líq. no fim."""
        fim = f"{y}-{qn * 3:02d}-{[31, 30, 30, 31][qn - 1]}"
        ini = f"{y}-{qn * 3 - 2:02d}-01"
        if qn < 4:
            a = idre.get(cnpj, {}).get((ini, fim))
            if not a:
                return None
            r_, _, c_, e_, _ = dre_values(a)
            # D&A: fluxo de caixa é acumulado no ano → diferença para o trimestre anterior
            cum = lambda f: dep_amort(idfc.get(cnpj, {}).get((f"{y}-01-01", f), {}))
            d_ = cum(fim)
            if qn > 1 and d_ is not None:
                prev = cum(f"{y}-{(qn - 1) * 3:02d}-{[31, 30, 30][qn - 2]}")
                d_ = None if prev is None else d_ - prev
            pl_, nd_ = bp_values(ibpa.get(cnpj, {}).get(("", fim), {}), ibpp.get(cnpj, {}).get(("", fim), {}))
        else:
            a = dre.get(cnpj, {}).get(y)
            nine = idre.get(cnpj, {}).get((f"{y}-01-01", f"{y}-09-30"))
            if not a or not nine:
                return None
            ra, _, ca, ea, _ = dre_values(a)
            r9, _, c9, e9, _ = dre_values(nine)
            sub = lambda x, w: None if x is None or w is None else x - w
            r_, c_, e_ = sub(ra, r9), sub(ca, c9), sub(ea, e9)
            d_ = sub(dep_amort(dfc.get(cnpj, {}).get(y, {})), dep_amort(idfc.get(cnpj, {}).get((f"{y}-01-01", f"{y}-09-30"), {})))
            pl_, nd_ = bp_values(bpa.get(cnpj, {}).get(y, {}), bpp.get(cnpj, {}).get(y, {}))
        return r_, c_, e_, d_, pl_, nd_

    emp, emp_idx, tk, tri = [], {}, {}, {}
    for code, (cnpj, k) in sorted(tickers.items()):
        s = quotes.get(code)
        if not s or cnpj not in dre:
            continue
        if cnpj not in emp_idx:
            rec, luc, ctrl, pls, divs, ebd, dls = [], [], [], [], [], [], []
            fin = False
            for y in yrs:
                a = dre[cnpj].get(y, {})
                r_, l_, c_, e_, f_ = dre_values(a) if a else (None, None, None, None, False)
                fin = fin or f_
                pl_, nd_ = bp_values(bpa.get(cnpj, {}).get(y, {}), bpp.get(cnpj, {}).get(y, {}))
                cash = dfc.get(cnpj, {}).get(y)
                d_ = dividends_paid(cash) if cash else None
                da = dep_amort(cash) if cash else None
                rec.append(m(r_)); luc.append(m(l_)); ctrl.append(m(c_)); pls.append(m(pl_)); divs.append(m(d_))
                ebd.append(m(e_ + (da or 0)) if e_ is not None else None)
                dls.append(m(nd_) if a else None)
            if all(v is None for v in luc):
                continue
            n_sh = shares.get(cnpj)
            # nº de ações às vezes vem em milhares ou desatualizado (grupamento/desdobro):
            # se ficar muito longe do valor de mercado da brapi, usa o nº implícito nele
            if cnpj in mcap:
                implied = mcap[cnpj][0] / mcap[cnpj][1]
                if not n_sh or not (1 / 3 < implied / n_sh < 3):
                    n_sh = implied
            fin = fin or "banco" in norm(sector_cvm.get(cnpj, "")) or "segur" in norm(sector_cvm.get(cnpj, ""))
            emp_idx[cnpj] = len(emp)
            emp.append({
                "n": names.get(cnpj, s.get("name", "")).strip(),
                "s": s.get("subsector") or sector_cvm.get(cnpj, ""),
                "fin": int(fin),
                "r": rec, "l": luc, "lc": ctrl, "pl": pls, "dv": divs,
                "eb": [None] * len(yrs) if fin else ebd,  # EBITDA = EBIT + depreciação/amortização
                "dla": [None] * len(yrs) if fin else dls,  # dívida líquida no fim de cada ano
                "dl": None if fin else next((v for v in reversed(dls) if v is not None), None),
                "ac": round(n_sh / 1e6, 3) if n_sh else None,  # milhões de ações em circulação
            })
            # trimestres
            t = {"r": [], "lc": [], "eb": [], "pl": [], "dl": []}
            for (y, qn) in qs:
                v = quarter(cnpj, y, qn)
                r_, c_, e_, d_, pl_, nd_ = v if v else (None,) * 6
                t["r"].append(m(r_)); t["lc"].append(m(c_)); t["pl"].append(m(pl_))
                t["eb"].append(None if fin or e_ is None else m(e_ + (d_ or 0)))
                t["dl"].append(None if fin else m(nd_))
            if any(x is not None for x in t["lc"]):
                tri[str(emp_idx[cnpj])] = t
        vol = round((s.get("volume") or 0) * s["close"] / 1e6, 2)  # R$ milhões no dia
        tk[code] = [emp_idx[cnpj], s["close"], k, vol]

    # ---------------- Preço histórico (Yahoo), para o P/L de cada ano/trimestre ----------------
    old_px, old_qpx = {}, {}
    try:  # se o Yahoo falhar, reaproveita o histórico da rodada anterior
        with open(out_path, encoding="utf-8") as f:
            o = json.load(f)
        old_px = {c: dict(zip(o["anos"], v[4])) for c, v in o["tk"].items() if len(v) > 4}
        with open(tri_path, encoding="utf-8") as f:
            o = json.load(f)
        old_qpx = {c: dict(zip(o["tri"], v)) for c, v in o.get("px", {}).items()}
    except (OSError, ValueError, KeyError):
        pass

    def fetch(code):
        try:
            return code, yahoo_monthly(code)
        except Exception:
            return code, None

    hist, fails = {}, 0
    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        for code, h in ex.map(fetch, list(tk)):
            if h:
                hist[code] = h
            else:
                fails += 1
    log(f"preço histórico: {len(hist)} ok, {fails} sem dados")
    qpx = {}
    for code in tk:
        h = hist.get(code, {})
        ann = [round(h[(y, 12)], 2) if (y, 12) in h else old_px.get(code, {}).get(y) for y in yrs]
        tk[code].append(ann)
        qv = [round(h[(y, qn * 3)], 2) if (y, qn * 3) in h else old_qpx.get(code, {}).get(qlabel(y, qn)) for y, qn in qs]
        if any(x is not None for x in qv):
            qpx[code] = qv

    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat(timespec="minutes")
    data = {"gerado": now, "anos": yrs, "emp": emp, "tk": tk}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    with open(tri_path, "w", encoding="utf-8") as f:
        json.dump({"gerado": now, "tri": [qlabel(*x) for x in qs], "emp": tri, "px": qpx},
                  f, ensure_ascii=False, separators=(",", ":"))
    log(f"{len(tk)} códigos, {len(emp)} empresas, anos {yrs[0]}–{yrs[-1]}, "
        f"trimestres {qlabel(*qs[0])}–{qlabel(*qs[-1])} ({len(tri)} empresas)")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "data/screener.json"
    main(out, os.path.join(os.path.dirname(out) or ".", "tri.json"))
