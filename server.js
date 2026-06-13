require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const RELATORIOS_PATH = path.resolve(__dirname, process.env.RELATORIOS_PATH || '../tim-playwright/relatorios');
const DISPARO_LOG_PATH = path.resolve(__dirname, process.env.DISPARO_LOG_PATH || '../tim-playwright/disparo_log');
const RELATORIOS_DISPARO_PATH = path.resolve(__dirname, '../tim-playwright/relatorios_disparo');
const PLAYWRIGHT_PATH = path.resolve(__dirname, process.env.PLAYWRIGHT_PATH || '../tim-playwright');
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const CREDS_PATH = path.resolve(__dirname, process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './credentials/google-service-account.json');
const MODO = (process.env.MODO || 'local').toLowerCase(); // 'local' ou 'vps'

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Remove ANSI escape codes from strings
const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');

// ─── Cache ────────────────────────────────────────────────────────────────────

let cache = { clientes: [], ultimaAtualizacao: null };
let processoRobo = null;
let processoDisparo = null;
let sseClients = [];

// Robôs por estado
const processoEstado = { PR: null, SC: null, RS: null };

// ─── SSE ──────────────────────────────────────────────────────────────────────

app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

function emitirEvento(tipo, dados) {
  const payload = JSON.stringify({ tipo, ...dados });
  sseClients.forEach(c => c.write(`data: ${payload}\n\n`));
}

// ─── Constantes de colunas da planilha ───────────────────────────────────────

const VENC_COLS = [28, 31, 34, 37, 40, 43, 46, 49, 52, 55];
const PAG_COLS  = [30, 33, 36, 39, 42, 45, 48, 51, 54, 57];

const PAGO_SET = new Set(['PAGO', 'BÔNUS', 'PG EM ATRASO', 'PG FATURA EM ATRASO', 'PAGO FATURA EM ABERTO']);
const PG_ATRASO_SET = new Set(['PG EM ATRASO', 'PG FATURA EM ATRASO', 'PAGO FATURA EM ABERTO']);

const MESES_PT = {
  'jan': 1, 'fev': 2, 'mar': 3, 'abr': 4, 'mai': 5, 'jun': 6,
  'jul': 7, 'ago': 8, 'set': 9, 'out': 10, 'nov': 11, 'dez': 12,
};

// ─── Parsers de data ──────────────────────────────────────────────────────────

function parsarData(str) {
  if (!str) return null;
  str = String(str).trim();
  const m1 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  const m2 = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  const n = parseFloat(str);
  if (!isNaN(n) && n > 40000) {
    const d = new Date(Math.round((n - 25569) * 86400 * 1000));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Parseia "20/ago." usando safra para inferir o ano
function parsarVencimento(str, safraMes, safraAno) {
  if (!str) return null;
  str = String(str).trim();
  const m = str.match(/^(\d{1,2})\/([a-záéíóúãõâêô]+)/i);
  if (m) {
    const day = parseInt(m[1]);
    const key = m[2].replace(/\.$/, '').toLowerCase().slice(0, 3);
    const monthNum = MESES_PT[key];
    if (!monthNum || !day) return null;
    // Se o mês do vencimento é menor que o mês da safra, está no ano seguinte
    const year = monthNum < safraMes ? safraAno + 1 : safraAno;
    return new Date(year, monthNum - 1, day);
  }
  return parsarData(str);
}

// ─── Processamento de cada cliente ───────────────────────────────────────────

function processarCliente(row, hoje) {
  const get = i => (row[i] || '').toString().trim();

  const safraMes = parseInt(get(3)) || 0;
  const safraAno = parseInt(get(4)) || 0;
  if (!safraMes || !safraAno) return null;

  const safra = String(safraMes).padStart(2, '0') + '/' + safraAno;

  // Processa cada fatura
  const faturas = [];
  let maxDiasAtraso = 0;
  let pgAtraso = false;

  for (let i = 0; i < VENC_COLS.length; i++) {
    const vencStr = get(VENC_COLS[i]);
    const statusRaw = get(PAG_COLS[i]);
    if (!vencStr && !statusRaw) continue;

    const status = statusRaw.toUpperCase();
    const vencDate = parsarVencimento(vencStr, safraMes, safraAno);

    let diasAtraso = 0;
    if (status === 'ATRASADO' && vencDate) {
      diasAtraso = Math.max(0, Math.floor((hoje - vencDate) / 86400000));
      if (diasAtraso > maxDiasAtraso) maxDiasAtraso = diasAtraso;
    }
    if (PG_ATRASO_SET.has(status)) pgAtraso = true;

    faturas.push({
      num: i + 1,
      status,
      diasAtraso,
      vencDate: vencDate ? vencDate.toISOString().split('T')[0] : null,
    });
  }

  // Nível de alerta (baseado no pior vencimento em atraso)
  let nivelAlerta = 'EM_DIA';
  if (maxDiasAtraso >= 33)      nivelAlerta = 'INADIMPLENTE';
  else if (maxDiasAtraso >= 28) nivelAlerta = 'N3';
  else if (maxDiasAtraso >= 16) nivelAlerta = 'N2';
  else if (maxDiasAtraso >= 1)  nivelAlerta = 'N1';

  const fStatus = n => faturas.find(f => f.num === n)?.status || '';
  const fPago   = n => PAGO_SET.has(fStatus(n));

  const temF3 = faturas.some(f => f.num === 3);
  const temF4 = faturas.some(f => f.num === 4);

  // Status da safra (só para clientes que já têm F4)
  let statusSafra = 'EM_ANDAMENTO';
  if (temF4) {
    if ([1,2,3,4].every(fPago)) statusSafra = 'COMPLETO';
    else if (nivelAlerta === 'INADIMPLENTE') statusSafra = 'QUEBRA';
    else statusSafra = 'PARCIAL';
  }

  return {
    vendedor:  get(1),
    cliente:   get(5),
    cpf:       get(7),
    contato:   get(8),
    estado:    get(17).toUpperCase(),
    cidade:    get(16).toUpperCase(),
    plano:     get(18),
    custcode:  get(19),
    os:        get(24),
    safra,
    safraMes,
    safraAno,
    faturas,
    nivelAlerta,
    statusSafra,
    f1Pago: fPago(1), f2Pago: fPago(2), f3Pago: fPago(3), f4Pago: fPago(4),
    temF3, temF4,
    pgAtraso,
    dataInstalacao: parsarData(get(2))?.toISOString().split('T')[0] || '',
  };
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function lerGoogleSheets() {
  const { google } = require('googleapis');
  let creds;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (fs.existsSync(CREDS_PATH)) {
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  } else {
    throw new Error('Credenciais Google não encontradas. Configure GOOGLE_SERVICE_ACCOUNT_JSON ou o arquivo em ' + CREDS_PATH);
  }
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'BaseDados!A1:BF10000',
  });
  const [, ...dataRows] = res.data.values || [];

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const clientes = [];
  for (const row of dataRows) {
    const c = processarCliente(row, hoje);
    if (c) clientes.push(c);
  }
  return clientes;
}

async function atualizarCache(forcar = false) {
  const CINCO_MIN = 5 * 60 * 1000;
  if (!forcar && cache.ultimaAtualizacao && Date.now() - cache.ultimaAtualizacao < CINCO_MIN) {
    return cache.clientes;
  }
  try {
    cache.clientes = await lerGoogleSheets();
    cache.ultimaAtualizacao = Date.now();
    emitirEvento('cache', { msg: `Base atualizada: ${cache.clientes.length} clientes`, ts: new Date().toISOString() });
  } catch (err) {
    emitirEvento('erro', { msg: 'Erro ao buscar Google Sheets: ' + err.message });
    if (!cache.clientes.length) cache.clientes = [];
  }
  return cache.clientes;
}

// ─── Filtros ──────────────────────────────────────────────────────────────────

function aplicarFiltros(clientes, q) {
  let l = clientes;
  if (q.safra)     l = l.filter(c => c.safra === q.safra);
  if (q.safraAno)  l = l.filter(c => c.safraAno === parseInt(q.safraAno));
  if (q.estado)    l = l.filter(c => q.estado.split(',').includes(c.estado));
  if (q.vendedor)  l = l.filter(c => c.vendedor === q.vendedor);
  if (q.nivel)     l = l.filter(c => q.nivel.split(',').includes(c.nivelAlerta));
  return l;
}

// Ordenação de safras cronologicamente
function ordenarSafras(safras) {
  return [...safras].sort((a, b) => {
    const [ma, ya] = a.split('/').map(Number);
    const [mb, yb] = b.split('/').map(Number);
    return (ya * 12 + ma) - (yb * 12 + mb);
  });
}

// ─── API: Resumo ──────────────────────────────────────────────────────────────

app.get('/api/resumo', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const total = f.length;

    const inadimplentes = f.filter(c => c.nivelAlerta === 'INADIMPLENTE').length;
    const iq = total > 0 ? +((1 - inadimplentes / total) * 100).toFixed(1) : 0;

    const f4Pagas = f.filter(c => c.statusSafra === 'COMPLETO').length;
    const comAtraso = f.filter(c => c.nivelAlerta !== 'EM_DIA').length;
    const pgAtrasoCount = f.filter(c => c.pgAtraso).length;
    const emAndamento = f.filter(c => !c.temF4).length;
    const emRisco = comAtraso;

    const n1 = f.filter(c => c.nivelAlerta === 'N1').length;
    const n2 = f.filter(c => c.nivelAlerta === 'N2').length;
    const n3 = f.filter(c => c.nivelAlerta === 'N3').length;
    const emDia = f.filter(c => c.nivelAlerta === 'EM_DIA').length;

    const comF1 = f.filter(c => c.temF3 || c.faturas.some(x => x.num === 1)).length;
    const f1p = f.filter(c => c.f1Pago).length;
    const f2p = f.filter(c => c.f2Pago).length;
    const f3p = f.filter(c => c.f3Pago).length;
    const f4p = f.filter(c => c.f4Pago).length;
    const comF3 = f.filter(c => c.temF3).length;

    const completo = f.filter(c => c.statusSafra === 'COMPLETO').length;
    const parcial  = f.filter(c => c.statusSafra === 'PARCIAL').length;
    const quebra   = f.filter(c => c.statusSafra === 'QUEBRA').length;

    res.json({
      total, iq, inadimplentes,
      f4Pagas, comAtraso, pgAtrasoCount, emAndamento, emRisco,
      n1, n2, n3, emDia,
      pctF1: total > 0 ? +(f1p/total*100).toFixed(1) : 0, f1p,
      pctF2: total > 0 ? +(f2p/total*100).toFixed(1) : 0, f2p,
      pctF3: total > 0 ? +(f3p/total*100).toFixed(1) : 0, f3p,
      pctF4: total > 0 ? +(f4p/total*100).toFixed(1) : 0, f4p,
      completo, parcial, quebra,
      leve: n1, medio: n2 + n3, alto: inadimplentes,
      ultimaAtualizacao: cache.ultimaAtualizacao,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Clientes ────────────────────────────────────────────────────────────

app.get('/api/clientes', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    let lista = aplicarFiltros(clientes, req.query);

    // Busca textual
    if (req.query.busca) {
      const b = req.query.busca.toLowerCase();
      lista = lista.filter(c =>
        c.cliente.toLowerCase().includes(b) ||
        c.vendedor.toLowerCase().includes(b) ||
        c.cpf.includes(b) ||
        c.custcode.includes(b)
      );
    }

    // Filtro de nível
    if (req.query.nivelAlerta) {
      const niveis = req.query.nivelAlerta.split(',');
      lista = lista.filter(c => niveis.includes(c.nivelAlerta));
    }

    // Ordenação
    const { ordenar = 'cliente', direcao = 'asc' } = req.query;
    lista.sort((a, b) => {
      const va = String(a[ordenar] || '');
      const vb = String(b[ordenar] || '');
      return direcao === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    const pagina = parseInt(req.query.pagina) || 1;
    const porPagina = parseInt(req.query.porPagina) || 50;
    const total = lista.length;
    const dados = lista.slice((pagina - 1) * porPagina, pagina * porPagina);

    res.json({ total, pagina, porPagina, totalPaginas: Math.ceil(total / porPagina), dados });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Filtros/Opções ──────────────────────────────────────────────────────

app.get('/api/filtros/opcoes', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const safras = ordenarSafras([...new Set(clientes.map(c => c.safra))]);
    const vendedores = [...new Set(clientes.map(c => c.vendedor).filter(Boolean))].sort();
    const estados = [...new Set(clientes.map(c => c.estado).filter(Boolean))].sort();
    res.json({ safras, vendedores, estados });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Status Geral (donut) ─────────────────────────────────────

app.get('/api/graficos/status-geral', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const total = f.length;
    const emDia  = f.filter(c => c.nivelAlerta === 'EM_DIA').length;
    const n1     = f.filter(c => c.nivelAlerta === 'N1').length;
    const n2     = f.filter(c => c.nivelAlerta === 'N2').length;
    const n3     = f.filter(c => c.nivelAlerta === 'N3').length;
    const inadim = f.filter(c => c.nivelAlerta === 'INADIMPLENTE').length;
    res.json({
      labels: ['Em Dia', 'N1 (1-15d)', 'N2 (16-27d)', 'N3 (28-32d)', 'Inadimplente (33+d)'],
      valores: [emDia, n1, n2, n3, inadim],
      total,
      iq: total > 0 ? +((1 - inadim/total)*100).toFixed(1) : 0,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — IQ por Safra (linha) ─────────────────────────────────────

app.get('/api/graficos/iq-safra', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const safras = ordenarSafras([...new Set(f.map(c => c.safra))]);
    const iqPorSafra = safras.map(s => {
      const grupo = f.filter(c => c.safra === s);
      const inadim = grupo.filter(c => c.nivelAlerta === 'INADIMPLENTE').length;
      return grupo.length > 0 ? +((1 - inadim/grupo.length)*100).toFixed(1) : 0;
    });
    const melhor = Math.max(...iqPorSafra);
    const pior   = Math.min(...iqPorSafra);
    const media  = iqPorSafra.length > 0
      ? +(iqPorSafra.reduce((a,b) => a+b, 0) / iqPorSafra.length).toFixed(1) : 0;
    res.json({ labels: safras, valores: iqPorSafra, melhor, pior, media });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Status por Safra (barras empilhadas) ─────────────────────

app.get('/api/graficos/status-safra', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const safras = ordenarSafras([...new Set(f.map(c => c.safra))]);
    const mkSerie = nivel => safras.map(s => f.filter(c => c.safra === s && c.nivelAlerta === nivel).length);
    res.json({
      labels: safras,
      emDia:  mkSerie('EM_DIA'),
      n1:     mkSerie('N1'),
      n2:     mkSerie('N2'),
      n3:     mkSerie('N3'),
      inadim: mkSerie('INADIMPLENTE'),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Comparativo F1-F4 por Safra ──────────────────────────────

app.get('/api/graficos/comparativo-faturas', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    // Safras com F4 completa (mais maduras)
    const safrasComF4 = ordenarSafras([...new Set(
      f.filter(c => c.temF4).map(c => c.safra)
    )]);
    const pct = (safra, campo) => {
      const grupo = f.filter(c => c.safra === safra);
      const n = grupo.filter(c => c[campo]).length;
      return grupo.length > 0 ? +(n/grupo.length*100).toFixed(1) : 0;
    };
    res.json({
      labels: safrasComF4,
      f1: safrasComF4.map(s => pct(s, 'f1Pago')),
      f2: safrasComF4.map(s => pct(s, 'f2Pago')),
      f3: safrasComF4.map(s => pct(s, 'f3Pago')),
      f4: safrasComF4.map(s => pct(s, 'f4Pago')),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Risco por Safra (barras empilhadas) ──────────────────────

app.get('/api/graficos/risco-safra', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const safras = ordenarSafras([...new Set(f.map(c => c.safra))]);
    const mkSerie = nivel => safras.map(s => f.filter(c => c.safra === s && c.nivelAlerta === nivel).length);
    res.json({
      labels: safras,
      n1:     mkSerie('N1'),
      n2:     mkSerie('N2'),
      n3:     mkSerie('N3'),
      inadim: mkSerie('INADIMPLENTE'),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Ranking de Vendedores por IQ ─────────────────────────────

app.get('/api/graficos/ranking-vendedores', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const vendedores = [...new Set(f.map(c => c.vendedor).filter(Boolean))];
    const ranking = vendedores.map(v => {
      const grupo = f.filter(c => c.vendedor === v);
      const inadim = grupo.filter(c => c.nivelAlerta === 'INADIMPLENTE').length;
      return { vendedor: v, total: grupo.length, iq: +(((grupo.length - inadim)/grupo.length)*100).toFixed(1) };
    }).filter(v => v.total >= 5)
      .sort((a, b) => b.iq - a.iq)
      .slice(0, 10);
    res.json({ labels: ranking.map(v => v.vendedor), valores: ranking.map(v => v.iq), totais: ranking.map(v => v.total) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Vendedores com Mais Atrasos ──────────────────────────────

app.get('/api/graficos/atrasos-vendedores', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const vendedores = [...new Set(f.map(c => c.vendedor).filter(Boolean))];
    const atrasos = vendedores.map(v => {
      const grupo = f.filter(c => c.vendedor === v);
      return {
        vendedor: v,
        n1:     grupo.filter(c => c.nivelAlerta === 'N1').length,
        n2:     grupo.filter(c => c.nivelAlerta === 'N2').length,
        n3:     grupo.filter(c => c.nivelAlerta === 'N3').length,
        inadim: grupo.filter(c => c.nivelAlerta === 'INADIMPLENTE').length,
        total:  grupo.filter(c => c.nivelAlerta !== 'EM_DIA').length,
      };
    }).filter(v => v.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
    res.json({
      labels: atrasos.map(v => v.vendedor),
      n1:     atrasos.map(v => v.n1),
      n2:     atrasos.map(v => v.n2),
      n3:     atrasos.map(v => v.n3),
      inadim: atrasos.map(v => v.inadim),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Distribuição por Estado ──────────────────────────────────

app.get('/api/graficos/estados', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const cont = {};
    f.forEach(c => { if(c.estado) cont[c.estado] = (cont[c.estado]||0)+1; });
    const sorted = Object.entries(cont).sort((a,b) => b[1]-a[1]).slice(0, 10);
    res.json({ labels: sorted.map(e=>e[0]), valores: sorted.map(e=>e[1]) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Distribuição por Cidade ──────────────────────────────────

app.get('/api/graficos/cidades', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const cont = {};
    f.forEach(c => { if(c.cidade) cont[c.cidade] = (cont[c.cidade]||0)+1; });
    const sorted = Object.entries(cont).sort((a,b) => b[1]-a[1]).slice(0, 10);
    res.json({ labels: sorted.map(e=>e[0]), valores: sorted.map(e=>e[1]) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Gráfico — Funil da Safra ───────────────────────────────────────────

app.get('/api/graficos/funil', async (req, res) => {
  try {
    const clientes = await atualizarCache();
    const f = aplicarFiltros(clientes, req.query);
    const total  = f.length;
    const f1Pago = f.filter(c => c.f1Pago).length;
    const f2Pago = f.filter(c => c.f2Pago).length;
    const f3Pago = f.filter(c => c.f3Pago).length;
    const f4Pago = f.filter(c => c.f4Pago).length;
    res.json({
      labels: ['Instalados', 'F1 Pago', 'F2 Pago', 'F3 Pago', 'F4 / IQ+'],
      valores: [total, f1Pago, f2Pago, f3Pago, f4Pago],
      retencao: [
        { label: 'Instalados', valor: total, pct: 100, perda: 0 },
        { label: 'F1 Pago', valor: f1Pago, pct: total?+(f1Pago/total*100).toFixed(1):0, perda: total-f1Pago },
        { label: 'F2 Pago', valor: f2Pago, pct: f1Pago?+(f2Pago/f1Pago*100).toFixed(1):0, perda: f1Pago-f2Pago },
        { label: 'F3 Pago', valor: f3Pago, pct: f2Pago?+(f3Pago/f2Pago*100).toFixed(1):0, perda: f2Pago-f3Pago },
        { label: 'F4 / IQ+', valor: f4Pago, pct: f3Pago?+(f4Pago/f3Pago*100).toFixed(1):0, perda: f3Pago-f4Pago },
      ],
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── API: Atualizar cache ─────────────────────────────────────────────────────

app.post('/api/atualizar', async (req, res) => {
  try {
    await atualizarCache(true);
    res.json({ ok: true, total: cache.clientes.length, ts: cache.ultimaAtualizacao });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Modo VPS — expõe flag para o frontend ────────────────────────────────────

app.get('/api/modo', (req, res) => res.json({ modo: MODO }));

// Bloqueia endpoints de robô quando rodando no VPS (sem interface gráfica)
function apenasLocal(req, res, next) {
  if (MODO === 'vps') return res.status(403).json({ erro: 'Disponível apenas localmente. No VPS, o robô SGR roda no PC com Chrome.' });
  next();
}

// ─── Comandos ─────────────────────────────────────────────────────────────────

app.get('/api/status-robo', (req, res) => {
  res.json({ robo: processoRobo ? 'rodando' : 'parado', disparo: processoDisparo ? 'rodando' : 'parado' });
});

app.post('/api/comando/robo-iniciar', apenasLocal, (req, res) => {
  if (processoRobo) return res.status(400).json({ erro: 'Robô já está rodando' });
  emitirEvento('robo', { msg: '🤖 Iniciando robô SGR...', status: 'rodando' });
  processoRobo = spawn('node', ['index.js'], { cwd: PLAYWRIGHT_PATH });
  processoRobo.stdout.on('data', d => emitirEvento('robo-log', { msg: stripAnsi(d.toString().trim()) }));
  processoRobo.stderr.on('data', d => emitirEvento('robo-log', { msg: '⚠️ ' + stripAnsi(d.toString().trim()) }));
  processoRobo.on('close', code => { emitirEvento('robo', { msg: `🤖 Robô finalizado (${code})`, status: 'parado' }); processoRobo = null; });
  res.json({ ok: true });
});

app.post('/api/comando/robo-parar', apenasLocal, (req, res) => {
  if (!processoRobo) return res.status(400).json({ erro: 'Robô não está rodando' });
  processoRobo.kill(); processoRobo = null;
  emitirEvento('robo', { msg: '⏹ Robô interrompido', status: 'parado' });
  res.json({ ok: true });
});

// ─── Robôs por Estado ────────────────────────────────────────────────────────

app.get('/api/status-robos', (req, res) => {
  const status = {};
  ['PR', 'SC', 'RS'].forEach(e => { status[e] = processoEstado[e] ? 'rodando' : 'parado'; });
  res.json({ estados: status, robo: processoRobo ? 'rodando' : 'parado', disparo: processoDisparo ? 'rodando' : 'parado' });
});

// Relatório parcial: lê os progressos dos 3 robôs e gera Excel na hora
// (funciona mesmo com robôs rodando — o progresso é salvo a cada cliente)
app.get('/api/relatorio-parcial', (req, res) => {
  try {
    const resultados = [];
    for (const est of ['PR', 'SC', 'RS']) {
      const arq = path.join(PLAYWRIGHT_PATH, `progresso_${est}.json`);
      if (fs.existsSync(arq)) {
        try {
          const p = JSON.parse(fs.readFileSync(arq, 'utf8'));
          for (const r of (p.resultados || [])) resultados.push({ ...r, robo: est });
        } catch {}
      }
    }
    if (resultados.length === 0) return res.status(404).json({ erro: 'Nenhum resultado ainda' });

    const maxFat = Math.max(...resultados.map(r => (r.numerosFaturas || []).length), 1);
    const headers = ['Nome', 'CPF', 'Custcode', 'Contato', 'Robô', 'Faturas Baixadas'];
    for (let i = 1; i <= maxFat; i++) headers.push(`Número ${i}`, `Valor ${i}`, `Vencimento ${i}`);
    headers.push('Status');

    const linhas = [headers];
    for (const r of resultados) {
      const row = [r.nome, r.cpf, r.custcode, r.contato, r.robo, r.faturasBaixadas || 0];
      for (let i = 0; i < maxFat; i++) {
        row.push((r.numerosFaturas || [])[i] || '');
        row.push((r.valores || [])[i] || '');
        row.push((r.vencimentos || [])[i] || '');
      }
      row.push(r.status || 'Erro');
      linhas.push(row);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Relatório');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });

    const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio_parcial_${ts}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/comando/token-fornecer', apenasLocal, (req, res) => {
  const { estado, token } = req.body;
  if (!estado || !processoEstado[estado]) return res.status(400).json({ erro: 'Robô não está rodando' });
  if (!token || token.trim().length < 4) return res.status(400).json({ erro: 'Token inválido' });
  processoEstado[estado].stdin.write(token.trim() + '\n');
  emitirEvento('robo-log', { msg: `[${estado}] 🔑 Token enviado ao robô`, estado });
  res.json({ ok: true });
});

app.post('/api/comando/robo-estado', apenasLocal, (req, res) => {
  const { estado } = req.body;
  if (!estado || !['PR', 'SC', 'RS'].includes(estado)) return res.status(400).json({ erro: 'Estado inválido' });
  if (processoEstado[estado]) return res.status(400).json({ erro: `Robô ${estado} já está rodando` });

  emitirEvento('robo-estado', { msg: `🤖 Iniciando Robô ${estado}...`, estado, status: 'rodando' });

  const proc = spawn('node', ['robo-estado.js', estado], { cwd: PLAYWRIGHT_PATH, stdio: ['pipe', 'pipe', 'pipe'] });
  processoEstado[estado] = proc;

  proc.stdout.on('data', d => {
    for (const linha of d.toString().split('\n')) {
      const t = stripAnsi(linha.trim());
      if (!t) continue;
      const tokReq = t.match(/^AGUARDANDO_TOKEN:(\w+)$/);
      if (tokReq) {
        emitirEvento('token-request', { estado: tokReq[1], msg: `[${estado}] ⏳ Robô aguardando token — DIGITE AGORA!` });
      } else {
        emitirEvento('robo-log', { msg: `[${estado}] ` + t, estado });
      }
    }
  });
  proc.stderr.on('data', d => emitirEvento('robo-log', { msg: `[${estado}] ⚠️ ` + stripAnsi(d.toString().trim()), estado }));
  proc.on('close', code => {
    emitirEvento('robo-estado', { msg: `🏁 Robô ${estado} finalizado (código ${code})`, estado, status: 'parado' });
    processoEstado[estado] = null;
  });

  res.json({ ok: true, estado });
});

app.post('/api/comando/robo-estado-parar', apenasLocal, (req, res) => {
  const { estado } = req.body;
  if (!estado || !processoEstado[estado]) return res.status(400).json({ erro: `Robô ${estado} não está rodando` });
  processoEstado[estado].kill();
  processoEstado[estado] = null;
  emitirEvento('robo-estado', { msg: `⏹ Robô ${estado} interrompido`, estado, status: 'parado' });
  res.json({ ok: true });
});

app.get('/api/relatorios', (req, res) => {
  if (!fs.existsSync(RELATORIOS_PATH)) return res.json({ arquivos: [] });
  const arquivos = fs.readdirSync(RELATORIOS_PATH)
    .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .sort()
    .reverse();
  res.json({ arquivos });
});

app.get('/api/relatorios/info/:arquivo', (req, res) => {
  const arquivo = path.basename(req.params.arquivo);
  const filePath = path.join(RELATORIOS_PATH, arquivo);
  if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Não encontrado' });
  try {
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const statusOk = new Set(['Sucesso', 'Sucesso (2ª tentativa)']);
    const sucesso = rows.filter(r => statusOk.has(String(r.Status || '').trim()));
    const total = sucesso.length;

    // Conta quantos já foram disparados (PDFs no disparo_log)
    const jaEnviadosPdfs = new Set();
    if (fs.existsSync(DISPARO_LOG_PATH)) {
      for (const f of fs.readdirSync(DISPARO_LOG_PATH).filter(f => f.endsWith('.json'))) {
        try {
          const entries = JSON.parse(fs.readFileSync(path.join(DISPARO_LOG_PATH, f), 'utf8'));
          for (const e of (Array.isArray(entries) ? entries : [])) {
            if (e.status === 'enviado' && e.pdf) jaEnviadosPdfs.add(e.pdf);
          }
        } catch {}
      }
    }
    // Um cliente conta como disparado se algum dos seus PDFs já foi enviado
    let disparados = 0;
    for (const r of sucesso) {
      const numeros = Object.keys(r)
        .filter(k => /^Número/i.test(k))
        .map(k => String(r[k] || '').trim())
        .filter(n => n.toLowerCase().endsWith('.pdf'));
      if (numeros.some(n => jaEnviadosPdfs.has(n))) disparados++;
    }

    res.json({ total, disparados, pendentes: total - disparados, linhas: rows.length });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/api/relatorios-disparo', (req, res) => {
  if (!fs.existsSync(RELATORIOS_DISPARO_PATH)) return res.json({ arquivos: [] });
  const arquivos = fs.readdirSync(RELATORIOS_DISPARO_PATH)
    .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .sort()
    .reverse();
  res.json({ arquivos });
});

app.get('/api/relatorios-disparo/download/:arquivo', (req, res) => {
  const arquivo = path.basename(req.params.arquivo);
  const filePath = path.join(RELATORIOS_DISPARO_PATH, arquivo);
  if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(filePath);
});

app.post('/api/comando/disparar', apenasLocal, (req, res) => {
  if (processoDisparo) return res.status(400).json({ erro: 'Disparo já está rodando' });
  if (!fs.existsSync(RELATORIOS_PATH)) return res.status(400).json({ erro: 'Pasta de relatórios não encontrada' });
  const arquivos = fs.readdirSync(RELATORIOS_PATH).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$')).sort().reverse();
  if (!arquivos.length) return res.status(400).json({ erro: 'Nenhum relatório encontrado' });
  const escolhido = req.body?.relatorio && arquivos.includes(req.body.relatorio) ? req.body.relatorio : arquivos[0];
  const relatorio = path.join(RELATORIOS_PATH, escolhido);
  const limite    = parseInt(req.body?.limite) || 0;
  const delay     = parseInt(req.body?.delay) || 30;
  const lote      = parseInt(req.body?.lote) || 50;
  const pausaLote = parseInt(req.body?.pausaLote) || 300;
  const args = ['disparar-faturas.js', relatorio,
    `--delay=${delay}`, `--lote=${lote}`, `--pausa-lote=${pausaLote}`];
  if (limite > 0) args.push(`--limit=${limite}`);
  const limiteMsg = limite > 0 ? ` (limite: ${limite})` : '';
  emitirEvento('disparo', { msg: `📤 Iniciando disparo: ${escolhido}${limiteMsg}`, status: 'rodando' });
  processoDisparo = spawn('node', args, { cwd: PLAYWRIGHT_PATH });
  processoDisparo.stdout.on('data', d => {
    const txt = d.toString();
    for (const linha of txt.split('\n')) {
      const trim = stripAnsi(linha.trim());
      if (!trim) continue;
      const prog = trim.match(/^PROGRESSO:(\d+):(\d+)$/);
      if (prog) {
        emitirEvento('progresso', { atual: parseInt(prog[1]), total: parseInt(prog[2]) });
      } else {
        emitirEvento('disparo-log', { msg: trim });
      }
    }
  });
  processoDisparo.stderr.on('data', d => emitirEvento('disparo-log', { msg: '⚠️ ' + stripAnsi(d.toString().trim()) }));
  processoDisparo.on('close', code => { emitirEvento('disparo', { msg: `📤 Disparo finalizado (código ${code})`, status: 'parado' }); processoDisparo = null; });
  res.json({ ok: true, relatorio: escolhido });
});

app.post('/api/comando/disparo-parar', apenasLocal, (req, res) => {
  if (!processoDisparo) return res.status(400).json({ erro: 'Nenhum disparo rodando' });
  processoDisparo.kill('SIGTERM');
  processoDisparo = null;
  emitirEvento('disparo', { msg: '⏹ Disparo interrompido manualmente', status: 'parado' });
  res.json({ ok: true });
});

// ─── Upload e consulta de faturas PDF ────────────────────────────────────────

const multer = require('multer');
const PDFS_PATH = path.join(__dirname, 'data', 'pdfs');
if (!fs.existsSync(PDFS_PATH)) fs.mkdirSync(PDFS_PATH, { recursive: true });

const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const NOME_PDF_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 _\-]+_\d{3}\.\d{3}\.\d{3}-\d{2}_\d{2}-\d{4}\.pdf$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PDFS_PATH),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.pdf'))
      return cb(new Error('Apenas arquivos .pdf são aceitos'));
    if (!NOME_PDF_RE.test(file.originalname))
      return cb(new Error('Nome inválido. Use o padrão NOME_CPF_MM-AAAA.pdf'));
    cb(null, true);
  },
});

function autorizarUpload(req, res, next) {
  if (!UPLOAD_TOKEN) return res.status(500).json({ erro: 'UPLOAD_TOKEN não configurado no servidor' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${UPLOAD_TOKEN}`) return res.status(401).json({ erro: 'Token inválido' });
  next();
}

// Remove acentos para busca case-insensitive sem acento
function semAcento(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

app.post('/api/upload-pdf', autorizarUpload, upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  res.json({ ok: true, arquivo: req.file.filename, tamanho: req.file.size });
});

app.get('/api/faturas', (req, res) => {
  try {
    const busca = semAcento(req.query.busca || '');
    const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
    const porPagina = 20;

    let arquivos = fs.readdirSync(PDFS_PATH)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .sort();

    if (busca) {
      arquivos = arquivos.filter(f => semAcento(f).includes(busca));
    }

    const total = arquivos.length;
    const paginas = Math.ceil(total / porPagina) || 1;
    const slice = arquivos.slice((pagina - 1) * porPagina, pagina * porPagina);

    // Agrupa por cliente — âncora pelo MM-YYYY no final do nome
    const clientes = {};
    for (const arq of slice) {
      const m = arq.match(/^(.+)_(\d{2}-\d{4})\.pdf$/i);
      let nome, cpf, mesAno, chave;
      if (m) {
        const antes = m[1]; // tudo antes de _MM-YYYY
        mesAno = m[2];
        const sep = antes.lastIndexOf('_');
        cpf  = sep >= 0 ? antes.substring(sep + 1) : '';
        nome = sep >= 0 ? antes.substring(0, sep)  : antes;
        chave = `${nome}_${cpf}`;
      } else {
        nome = arq.replace('.pdf', '');
        cpf = '';
        mesAno = '';
        chave = nome;
      }
      if (!clientes[chave]) clientes[chave] = { nome, cpf, faturas: [] };
      clientes[chave].faturas.push({ arquivo: arq, mesAno });
    }

    res.json({ total, pagina, paginas, clientes: Object.values(clientes) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/faturas/download/:arquivo', (req, res) => {
  // Valida contra path traversal
  const arquivo = path.basename(req.params.arquivo);
  if (!arquivo.toLowerCase().endsWith('.pdf')) return res.status(400).json({ erro: 'Arquivo inválido' });
  const filePath = path.join(PDFS_PATH, arquivo);
  if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(filePath);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Dashboard rodando em http://0.0.0.0:${PORT} [modo: ${MODO}]`);
  atualizarCache(true).catch(() => {});
});
