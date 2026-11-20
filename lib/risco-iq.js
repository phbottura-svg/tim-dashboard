'use strict';

// ─── Risco de IQ ─────────────────────────────────────────────────────────────
// Alerta antecipado do IQ (Índice de Qualidade). Usa a MESMA regra do cálculo
// oficial do dashboard (clienteForaDoIQ em server.js):
//   • fatura com mais de 30 dias de atraso tira o cliente do IQ da safra;
//   • de 1 a 30 dias ainda dá para salvar (se pagar dentro dos 30 dias);
//   • churn dentro da janela da safra também tira o cliente do IQ.
// Aqui o foco é separar quem JÁ afetou o IQ de quem ainda dá para salvar, e
// dizer quantos dias faltam para cada cliente "queimar" o IQ.
//
// Módulo puro: recebe os clientes e os helpers do server.js por parâmetro, pra
// poder ser testado sem subir o servidor.

const MS_DIA = 86400000;

// Ordem de gravidade — o cliente fica na pior faixa entre as faturas dele.
const FAIXAS = ['avencer', 'd1_10', 'd11_20', 'd21_30', 'queimado'];
const GRAVIDADE = { ok: 0, avencer: 1, d1_10: 2, d11_20: 3, d21_30: 4, queimado: 5 };
const JANELA_A_VENCER_DIAS = 7;
const LIMITE_IQ_DIAS = 30;

// "Hoje" no fuso de Brasília — o servidor roda em UTC, e sem isso a data
// virava às 21h (horário de Brasília) e os dias de atraso saltavam 1.
function hojeBrasilia(override) {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
    const [y, m, d] = override.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const fmtData = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const diffDias = (a, b) => Math.round((a - b) / MS_DIA);

function faixaPorDias(dias) {
  if (dias > LIMITE_IQ_DIAS) return 'queimado';
  if (dias >= 21) return 'd21_30';
  if (dias >= 11) return 'd11_20';
  if (dias >= 1) return 'd1_10';
  if (-dias <= JANELA_A_VENCER_DIAS) return 'avencer'; // vence hoje ou nos próximos 7 dias
  return 'ok';                                          // vence só mais pra frente
}

// Classifica UMA fatura na data de referência `ref`.
// Devolve { faixa, dias, venc, aberta, motivo? }.
//   dias   = dias de atraso (negativo = ainda não venceu)
//   aberta = true se a fatura ainda está sem pagamento na data de referência
function classificarFatura(f, ref, parseDataBr) {
  const venc = parseDataBr(f.dataVencimento);
  if (!venc) return null;

  // Marcada manualmente como paga (Base Pagos): conta como em dia.
  if (f.pagoManual) return { faixa: 'ok', dias: null, venc, aberta: false };

  const pago = parseDataBr(f.dataPagamento);
  if (pago && pago <= ref) {
    const diasPagou = diffDias(pago, venc);
    return diasPagou > LIMITE_IQ_DIAS
      ? { faixa: 'queimado', dias: diasPagou, venc, aberta: false, motivo: 'Paga com mais de 30 dias de atraso' }
      : { faixa: 'ok', dias: diasPagou, venc, aberta: false };
  }
  // Sem data de pagamento nenhuma, o status é o que resta. (Se HÁ data mas ela
  // é posterior à referência — safra já fechada, vale a data de corte — a
  // fatura estava em aberto naquele dia: cai na conta de atraso abaixo, igual
  // ao clienteForaDoIQ.)
  if (!pago) {
    if (f.status === 'PAGO_ATRASO') {
      return { faixa: 'queimado', dias: null, venc, aberta: false, motivo: 'Paga com mais de 30 dias de atraso' };
    }
    if (f.status === 'ADIMPLENTE') return { faixa: 'ok', dias: null, venc, aberta: false };
  }

  // Em aberto na data de referência.
  const dias = diffDias(ref, venc);
  const faixa = faixaPorDias(dias);
  return {
    faixa, dias, venc, aberta: true,
    motivo: faixa === 'queimado' ? 'Em aberto com mais de 30 dias de atraso' : undefined,
  };
}

// Resultado por cliente, considerando só as faturas do escopo.
function classificarCliente(faturas, ref, parseDataBr, { considerarChurnFatura = false } = {}) {
  let pior = 'ok';
  let diasMax = null;          // maior atraso entre as faturas em aberto
  let critica = null;          // fatura que define a faixa
  let abertas = 0;
  let motivo = null;

  for (const f of faturas) {
    if (considerarChurnFatura && f.churn === 'Sim') {
      if (GRAVIDADE.queimado > GRAVIDADE[pior]) { pior = 'queimado'; motivo = 'Churn na janela da safra'; critica = f; }
      continue;
    }
    const r = classificarFatura(f, ref, parseDataBr);
    if (!r) continue;
    if (r.aberta && r.faixa !== 'ok') {
      abertas++;
      if (diasMax === null || r.dias > diasMax) diasMax = r.dias;
    }
    const piorou = GRAVIDADE[r.faixa] > GRAVIDADE[pior];
    const empateMaisAtrasada = r.faixa === pior && r.faixa !== 'ok' && r.aberta && r.dias > (critica?._dias ?? -Infinity);
    if (piorou || empateMaisAtrasada) {
      pior = r.faixa;
      motivo = r.motivo || motivo;
      critica = { ...f, _dias: r.dias, _venc: r.venc };
    }
  }
  return { faixa: pior, diasMax, critica, abertas, motivo };
}

// Meses (MM/YYYY) → ordenação cronológica.
const chaveMes = s => { const [m, y] = s.split('/').map(Number); return y * 100 + m; };

// "Data" (sem hora) no fuso de Brasília a partir de um ISO (ex.: carimbo de cobrança).
function dataBrasiliaDe(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  const [y, m, dd] = s.split('-').map(Number);
  return new Date(y, m - 1, dd);
}

const dataIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const FAIXAS_RISCO = ['d1_10', 'd11_20', 'd21_30'];       // ainda dá para salvar
const FAIXAS_ATENCAO = ['avencer', ...FAIXAS_RISCO];

// Estado da cobrança de um cliente a partir das anotações (marcadores + registros).
function statusCobranca(an, hoje) {
  const marc = an?.marcadores || [];
  const ult = (an?.cobrancas || []).slice(-1)[0] || null;
  const status = marc.includes('promessa') ? 'promessa' : (marc.includes('cobrado') ? 'cobrado' : 'pendente');
  let diasDesde = null;
  const dt = ult ? dataBrasiliaDe(ult.em) : null;
  if (dt) diasDesde = Math.max(0, diffDias(hoje, dt));
  return { status, ultimaEm: ult?.em || null, ultimaPor: ult?.autor || null, ultimaTipo: ult?.tipo || null, diasDesde };
}

function criarServico({ parseDataBr, normalizarMes, safraParaMeses, carregarCestaOficialPorSafra }) {
  function dataCorteSafra(safra) {
    const janela = safraParaMeses(safra);
    const [mm, yyyy] = janela[janela.length - 1].split('/').map(Number);
    return new Date(yyyy, mm, 0); // último dia do 5º mês
  }

  function opcoes(todos, hoje) {
    const safras = [...new Set(todos.map(c => c.mesGross).filter(Boolean))]
      .sort((a, b) => chaveMes(a) - chaveMes(b))
      .map(valor => {
        const oficial = !!(carregarCestaOficialPorSafra && carregarCestaOficialPorSafra(valor));
        const fechada = oficial || hoje > dataCorteSafra(valor);
        return { valor, fechada, oficial };
      });
    const mesesVenc = [...new Set(todos.flatMap(c => (c.faturas || []).map(f => normalizarMes(f.mesVencimento || '')).filter(Boolean)))]
      .filter(m => /^\d{2}\/\d{4}$/.test(m))
      .sort((a, b) => chaveMes(a) - chaveMes(b));
    const estados = [...new Set(todos.map(c => c.uf).filter(Boolean))].sort();
    const vendedores = [...new Set(todos.map(c => c.vendedor).filter(Boolean))].sort();
    return { safras, mesesVenc, estados, vendedores };
  }

  function zerarContadores() {
    return { avencer: 0, d1_10: 0, d11_20: 0, d21_30: 0, queimado: 0, ok: 0 };
  }

  // Classifica todos os clientes do escopo pedido (safra ou mês a mês).
  function coletar(todos, q, hoje, opts) {
    const modo = q.modo === 'mes' ? 'mes' : 'safra';

    // Filtros comuns (estado / vendedor) — a faixa e a busca só afetam a lista.
    let base = todos;
    if (q.estado)    base = base.filter(c => String(q.estado).split(',').includes(c.uf));
    if (q.vendedor)  base = base.filter(c => c.vendedor === q.vendedor);

    const linhas = [];              // um item por cliente no escopo
    const distribuicao = new Map(); // safra (ou UF) → contadores
    let semDados = 0, churnMes = 0;
    let mesVenc = null;

    const dist = (nome) => {
      if (!distribuicao.has(nome)) distribuicao.set(nome, { nome, total: 0, ...zerarContadores() });
      return distribuicao.get(nome);
    };

    if (modo === 'safra') {
      // Safras do escopo: a escolhida, ou todas as que ainda estão em andamento.
      const safrasEscopo = q.safra
        ? opts.safras.filter(s => s.valor === q.safra)
        : opts.safras.filter(s => !s.fechada);
      const infoSafra = new Map(safrasEscopo.map(s => [s.valor, s]));

      for (const c of base) {
        const info = infoSafra.get(c.mesGross);
        if (!info) continue;
        if (!c.totalFaturas) { semDados++; continue; } // sem fatura no Sonar: não dá para medir atraso

        const corte = dataCorteSafra(c.mesGross);
        const janelaSet = new Set(safraParaMeses(c.mesGross));
        const ref = hoje < corte ? hoje : corte; // safra fechada: o IQ vale na data de corte
        const faturas = (c.faturas || []).filter(f => janelaSet.has(normalizarMes(f.mesVencimento || '')));
        const r = classificarCliente(faturas, ref, parseDataBr, { considerarChurnFatura: true });
        linhas.push({ c, r, safra: c.mesGross, fechada: info.fechada, corte });
        const d = dist(c.mesGross);
        d.total++; d[r.faixa]++;
      }
    } else {
      mesVenc = q.mesVenc || `${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
      for (const c of base) {
        const faturas = (c.faturas || []).filter(f => normalizarMes(f.mesVencimento || '') === mesVenc);
        if (!faturas.length) continue;
        if (c.churn) { churnMes++; continue; } // cancelado: cobrança não se aplica
        const r = classificarCliente(faturas, hoje, parseDataBr);
        linhas.push({ c, r, safra: c.mesGross, fechada: false, corte: null });
        const d = dist(c.uf || 'Sem UF');
        d.total++; d[r.faixa]++;
      }
    }
    return { modo, mesVenc, linhas, distribuicao, semDados, churnMes };
  }

  // Contadores e tabela de impacto (heatmap) a partir do escopo coletado.
  function resumir(col, opts) {
    const { modo, linhas, distribuicao, semDados, churnMes } = col;
    const contadores = { ...zerarContadores(), total: linhas.length, semDados, churn: churnMes };
    for (const l of linhas) contadores[l.r.faixa]++;
    contadores.emRisco = contadores.d1_10 + contadores.d11_20 + contadores.d21_30;

    const linhasDist = [...distribuicao.values()].map(d => {
      const out = { ...d, emRisco: d.d1_10 + d.d11_20 + d.d21_30 };
      if (modo === 'safra') {
        const info = opts.safras.find(s => s.valor === d.nome);
        out.fechada = !!info?.fechada;
        out.oficial = !!info?.oficial;
        out.iqAtual = d.total ? +(((d.total - d.queimado) / d.total) * 100).toFixed(1) : null;
        // Pior caso REALISTA: quem está com 1–30 dias de atraso ainda dá para
        // salvar; se nenhum deles pagar a tempo, todos viram +30 e saem do IQ.
        // (Fatura "a vencer" não entra: ainda nem venceu.) Safra fechada não muda mais.
        out.iqPiorCaso = out.fechada ? out.iqAtual
          : (d.total ? +(((d.total - d.queimado - out.emRisco) / d.total) * 100).toFixed(1) : null);
        out.pontosEmJogo = out.iqAtual != null && out.iqPiorCaso != null ? +(out.iqAtual - out.iqPiorCaso).toFixed(1) : null;
      }
      return out;
    }).sort((a, b) => modo === 'safra' ? chaveMes(a.nome) - chaveMes(b.nome) : b.total - a.total);

    return { contadores, linhasDist };
  }

  /**
   * @param {object[]} todos  base-cruzada
   * @param {object}   q      { modo, safra, mesVenc, estado, vendedor, faixa, cobranca, busca, ordenar, pagina, porPagina, todos, hoje }
   * @param {object}   extras { anotacoes }  — anotações por OS (marcadores + cobranças)
   */
  function calcular(todos, q = {}, extras = {}) {
    const hoje = hojeBrasilia(q.hoje);
    const anotacoes = extras.anotacoes || {};
    const opts = opcoes(todos, hoje);
    const col = coletar(todos, q, hoje, opts);
    const { modo, linhas } = col;
    const { contadores, linhasDist } = resumir(col, opts);

    // Cobrança de cada cliente (só calculada uma vez por linha).
    const cob = new Map();
    const cobDe = l => {
      if (!cob.has(l)) cob.set(l, statusCobranca(anotacoes[l.c.os], hoje));
      return cob.get(l);
    };
    // Quantos dos "salváveis" ainda não tiveram nenhuma cobrança registrada.
    contadores.emRiscoPendentes = linhas.filter(l => FAIXAS_RISCO.includes(l.r.faixa) && cobDe(l).status === 'pendente').length;

    // ── Lista ──
    let lista = linhas;
    if (q.faixa && FAIXAS.includes(q.faixa)) lista = lista.filter(l => l.r.faixa === q.faixa);
    else if (q.faixa === 'emRisco') lista = lista.filter(l => FAIXAS_RISCO.includes(l.r.faixa));
    else lista = lista.filter(l => l.r.faixa !== 'ok'); // sem faixa: tudo que pede atenção

    if (q.cobranca === 'pendente') lista = lista.filter(l => cobDe(l).status === 'pendente');
    else if (q.cobranca === 'cobrado') lista = lista.filter(l => cobDe(l).status !== 'pendente');
    else if (q.cobranca === 'promessa') lista = lista.filter(l => cobDe(l).status === 'promessa');

    if (q.busca) {
      const b = String(q.busca).toLowerCase();
      lista = lista.filter(({ c }) =>
        (c.nome || '').toLowerCase().includes(b) || (c.vendedor || '').toLowerCase().includes(b) ||
        (c.cpf || '').includes(b) || (c.os || '').includes(b) || (c.custcode || '').includes(b));
    }

    // Urgência: quem está mais perto de queimar primeiro; queimados por último
    // (não dá mais para salvar).
    const urg = l => (l.r.faixa === 'queimado' ? -1 : (l.r.diasMax ?? -999));
    const ordenar = q.ordenar || 'urgencia';
    lista = [...lista].sort((a, b) => {
      if (ordenar === 'nome') return (a.c.nome || '').localeCompare(b.c.nome || '');
      if (ordenar === 'vendedor') return (a.c.vendedor || '').localeCompare(b.c.vendedor || '') || urg(b) - urg(a);
      return urg(b) - urg(a) || (a.c.nome || '').localeCompare(b.c.nome || '');
    });

    const totalLista = lista.length;
    const porPagina = q.todos ? Math.max(totalLista, 1) : Math.min(Math.max(parseInt(q.porPagina) || 50, 1), 500);
    const totalPaginas = Math.ceil(totalLista / porPagina) || 1;
    const pagina = Math.min(Math.max(parseInt(q.pagina) || 1, 1), totalPaginas);

    const dados = lista.slice((pagina - 1) * porPagina, pagina * porPagina).map(l => {
      const { c, r, safra, fechada } = l;
      const venc = r.critica?._venc || parseDataBr(r.critica?.dataVencimento);
      const emAtencao = FAIXAS_ATENCAO.includes(r.faixa);
      const dataLimite = venc ? new Date(venc.getTime() + LIMITE_IQ_DIAS * MS_DIA) : null;
      return {
        os: c.os, nome: c.nome, custcode: c.custcode,
        contato: c.contatoPrincipal || null, contato2: c.contatoResponsavel || null,
        vendedor: c.vendedor || null, uf: c.uf || null, safra,
        faixa: r.faixa,
        diasAtraso: r.diasMax,
        diasRestantes: emAtencao && r.diasMax != null ? LIMITE_IQ_DIAS - r.diasMax : null,
        dataLimite: emAtencao && dataLimite ? fmtData(dataLimite) : null,
        vencimento: r.critica?.dataVencimento || null,
        mesVencimento: r.critica?.mesVencimento || null,
        faturasAbertas: r.abertas,
        motivo: r.motivo || null,
        safraFechada: fechada,
        cobranca: cobDe(l),
      };
    });

    return {
      modo,
      referencia: {
        hoje: fmtData(hoje),
        safra: q.safra || null,
        mesVenc: modo === 'mes' ? col.mesVenc : null,
      },
      contadores,
      distribuicao: { rotulo: modo === 'safra' ? 'Safra' : 'Estado', linhas: linhasDist },
      tabela: { total: totalLista, pagina, porPagina, totalPaginas, dados },
      opcoes: opts,
    };
  }

  /**
   * Foto diária do risco (escopo: todas as safras em andamento). Guarda os
   * contadores e, de forma compacta, o estado de cada cliente que pede atenção
   * ('a' a vencer, 'r' dá para salvar, 'q' já afetou) — é com isso que o dia
   * seguinte calcula quantos foram salvos, quantos queimaram e quantos entraram.
   *
   * @param {object|null} anterior  foto anterior (precisa ter .estado) p/ calcular o fluxo
   */
  function snapshot(todos, { hoje: hojeStr, anterior = null } = {}) {
    const hoje = hojeBrasilia(hojeStr);
    const opts = opcoes(todos, hoje);
    const col = coletar(todos, { modo: 'safra' }, hoje, opts);
    const { contadores, linhasDist } = resumir(col, opts);

    const estado = {};
    const hojeMap = new Map(); // os → faixa (todos do escopo, inclusive "ok")
    for (const { c, r } of col.linhas) {
      if (!c.os) continue;
      hojeMap.set(c.os, r.faixa);
      if (r.faixa === 'queimado') estado[c.os] = 'q';
      else if (FAIXAS_RISCO.includes(r.faixa)) estado[c.os] = 'r';
      else if (r.faixa === 'avencer') estado[c.os] = 'a';
    }

    let fluxo = null;
    if (anterior && anterior.estado) {
      let salvos = 0, queimaram = 0, continuamEmRisco = 0, saiuDoEscopo = 0, novosEmRisco = 0;
      for (const [os, cod] of Object.entries(anterior.estado)) {
        if (cod !== 'r') continue;
        const hojeFaixa = hojeMap.get(os);
        if (hojeFaixa === undefined) saiuDoEscopo++;          // safra fechou / saiu da base
        else if (hojeFaixa === 'queimado') queimaram++;
        else if (FAIXAS_RISCO.includes(hojeFaixa)) continuamEmRisco++;
        else salvos++;                                         // voltou a "em dia" (ou ainda a vencer)
      }
      for (const [os, cod] of Object.entries(estado)) {
        if (cod === 'r' && anterior.estado[os] !== 'r') novosEmRisco++;
      }
      fluxo = { desde: anterior.data, salvos, queimaram, continuamEmRisco, saiuDoEscopo, novosEmRisco };
    }

    return {
      data: dataIso(hoje),
      geradoEm: new Date().toISOString(),
      contadores,
      porSafra: linhasDist.map(l => ({
        nome: l.nome, total: l.total, ok: l.ok, avencer: l.avencer, emRisco: l.emRisco,
        d1_10: l.d1_10, d11_20: l.d11_20, d21_30: l.d21_30, queimado: l.queimado, iqAtual: l.iqAtual,
      })),
      fluxo,
      estado,
    };
  }

  return { calcular, snapshot };
}

module.exports = { criarServico, classificarFatura, classificarCliente, faixaPorDias, hojeBrasilia, statusCobranca, FAIXAS };
