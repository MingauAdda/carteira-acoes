"""Gera data/screener.json com fundamentos oficiais da CVM + cotações.

Fontes:
- CVM, Dados Abertos (DFP anual e FCA cadastral): receita, lucro, patrimônio,
  dívida, caixa, dividendos pagos, nº de ações, código de negociação.
- brapi.dev /api/quote/list (público, sem token): cotação de fechamento, volume
  e subsetor. A CVM não publica cotações.

Só biblioteca padrão do Python. Tudo é baixado em memória.
Roda no GitHub Actions (.github/workflows/screener.yml).
"""
import csv
import datetime as dt
import io
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
import zipfile

CVM = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC"
YEARS_BACK = 6
UA = {"User-Agent": "carteira-acoes-screener (github actions)"}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read()


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


def by_company_year(rows):
    """{cnpj: {ano: {cd_conta: (descricao, valor_em_reais)}}}  — ÚLTIMO e PENÚLTIMO exercício."""
    out = {}
    for r in latest_version(rows):
        ordem = norm(r["ORDEM_EXERC"])
        if ordem not in ("ultimo", "penultimo"):
            continue
        v = num(r["VL_CONTA"])
        if v is None:
            continue
        cd = r["CD_CONTA"]
        if not cd.startswith("3.99"):  # lucro por ação não vem em milhares
            v *= 1000 if norm(r["ESCALA_MOEDA"]) == "mil" else 1
        year = int(r["DT_FIM_EXERC"][:4])
        slot = out.setdefault(r["CNPJ_CIA"], {}).setdefault(year, {})
        # ÚLTIMO de um arquivo é sobrescrito pelo PENÚLTIMO do arquivo seguinte (valor reapresentado)
        slot[cd] = (norm(r["DS_CONTA"]), v, ordem)
    return out


def merge(dst, src):
    for cnpj, years in src.items():
        for y, accts in years.items():
            cur = dst.setdefault(cnpj, {}).setdefault(y, {})
            for cd, val in accts.items():
                # dado reapresentado (penúltimo de arquivo mais novo) vence o original
                if cd not in cur or val[2] == "penultimo" or cur[cd][2] == "ultimo":
                    cur[cd] = val


def level(cd):
    return cd.count(".")


def dre_values(a):
    """Receita, lucro total e lucro dos controladores de um ano."""
    receita = a.get("3.01", (None, None))[1]
    lucro_cd = None
    for cd in sorted(a):
        ds = a[cd][0]
        if re.fullmatch(r"3\.\d\d", cd) and cd != "3.99" and ("lucro" in ds or "prejuizo" in ds):
            lucro_cd = cd
    fin = "intermediacao financeira" in a.get("3.01", ("",))[0] or "seguro" in a.get("3.01", ("",))[0]
    if not lucro_cd:
        return receita, None, None, fin
    lucro = a[lucro_cd][1]
    ctrl = lucro
    for cd, (ds, v, _) in a.items():
        if cd.startswith(lucro_cd + ".") and level(cd) == 2 and "controladora" in ds and "nao" not in ds and v:
            ctrl = v  # algumas empresas deixam a abertura zerada: aí vale o lucro total
    return receita, lucro, ctrl, fin


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
    return pl, debt - cash


def dividends_paid(a):
    hits = {cd: v for cd, (ds, v, _) in a.items()
            if cd.startswith("6.") and v < 0 and ("dividendo" in ds or re.search(r"juros sobre (o )?capital", ds))
            and "recebid" not in ds}
    # evita somar pai e filho
    top = [cd for cd in hits if not any(cd != p and cd.startswith(p + ".") for p in hits)]
    return -sum(hits[cd] for cd in top)


def unit_size(comp):
    """'1 ON + 2 PN' → 3 ações por unit."""
    parts = re.findall(r"(\d+)\s*(?:acao|acoes)?\s*(?:on|pn|ordinaria|preferencia|[a-z]{4}\d)", norm(comp))
    n = sum(int(x) for x in parts)
    return n if 2 <= n <= 10 and len(parts) >= 2 else None


def main(out_path):
    today = dt.date.today()
    years = list(range(today.year - YEARS_BACK, today.year + 1))

    dre, bpa, bpp, dfc, shares = {}, {}, {}, {}, {}
    for y in years:
        z = get_zip(f"{CVM}/DFP/DADOS/dfp_cia_aberta_{y}.zip")
        if not z:
            print(f"DFP {y}: ainda não publicado", file=sys.stderr)
            continue
        print(f"DFP {y}", file=sys.stderr)
        for kind, dst in (("DRE", dre), ("BPA", bpa), ("BPP", bpp)):
            con = by_company_year(read_csv(z, f"dfp_cia_aberta_{kind}_con_{y}.csv"))
            ind = by_company_year(read_csv(z, f"dfp_cia_aberta_{kind}_ind_{y}.csv"))
            for cnpj in ind:  # sem consolidado → usa individual
                con.setdefault(cnpj, ind[cnpj])
            merge(dst, con)
        for kind in ("DFC_MI", "DFC_MD"):
            con = by_company_year(read_csv(z, f"dfp_cia_aberta_{kind}_con_{y}.csv"))
            ind = by_company_year(read_csv(z, f"dfp_cia_aberta_{kind}_ind_{y}.csv"))
            for cnpj in ind:
                con.setdefault(cnpj, ind[cnpj])
            merge(dfc, con)
        for r in latest_version(read_csv(z, f"dfp_cia_aberta_composicao_capital_{y}.csv")):
            total = (num(r["QT_ACAO_TOTAL_CAP_INTEGR"]) or 0) - (num(r["QT_ACAO_TOTAL_TESOURO"]) or 0)
            if total > 0:
                shares[r["CNPJ_CIA"]] = total
        del z

    # Códigos de negociação (FCA mais recente que existir)
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
    print(f"{len(tickers)} códigos na CVM", file=sys.stderr)

    # Cotações
    q = json.loads(get("https://brapi.dev/api/quote/list?type=stock&limit=5000"))
    quotes = {s["stock"]: s for s in q["stocks"] if s.get("close")}

    # último ano com balanço da maioria das empresas (exercícios que fecham no meio do ano não contam)
    cover = {}
    for c in dre.values():
        for y in c:
            cover[y] = cover.get(y, 0) + 1
    last_year = max((y for y, n in cover.items() if n >= max(cover.values()) * 0.5), default=today.year - 1)

    # valor de mercado por empresa (brapi) e preço por ação correspondente, para conferir o nº de ações
    mcap = {}
    for code, (cnpj, k) in tickers.items():
        s = quotes.get(code)
        if s and s.get("market_cap") and cnpj not in mcap:
            mcap[cnpj] = (s["market_cap"], s["close"] / k)
    yrs = list(range(last_year - YEARS_BACK + 1, last_year + 1))

    emp, emp_idx, tk = [], {}, {}
    for code, (cnpj, k) in sorted(tickers.items()):
        s = quotes.get(code)
        if not s or cnpj not in dre:
            continue
        if cnpj not in emp_idx:
            rec, luc, ctrl, pls, divs = [], [], [], [], []
            fin = False
            nd = None
            for y in yrs:
                a = dre[cnpj].get(y, {})
                r_, l_, c_, f_ = dre_values(a) if a else (None, None, None, False)
                fin = fin or f_
                pl_, nd_ = bp_values(bpa.get(cnpj, {}).get(y, {}), bpp.get(cnpj, {}).get(y, {}))
                d_ = dividends_paid(dfc.get(cnpj, {}).get(y, {})) if dfc.get(cnpj, {}).get(y) else None
                m = lambda v: None if v is None else round(v / 1e6, 2)
                rec.append(m(r_)); luc.append(m(l_)); ctrl.append(m(c_)); pls.append(m(pl_)); divs.append(m(d_))
                if a:
                    nd = m(nd_)
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
                "dl": None if fin else nd,
                "ac": round(n_sh / 1e6, 3) if n_sh else None,  # milhões de ações em circulação
            })
        vol = round((s.get("volume") or 0) * s["close"] / 1e6, 2)  # R$ milhões no dia
        tk[code] = [emp_idx[cnpj], s["close"], k, vol]

    data = {
        "gerado": dt.datetime.now(dt.timezone(dt.timedelta(hours=-3))).isoformat(timespec="minutes"),
        "anos": yrs,
        "emp": emp,
        "tk": tk,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(tk)} códigos, {len(emp)} empresas, anos {yrs[0]}–{yrs[-1]}", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/screener.json")
