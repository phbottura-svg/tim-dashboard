require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const { parse: parseCSV } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;

const RELATORIOS_PATH = path.resolve(__dirname, process.env.RELATORIOS_PATH || '../tim-playwright/relatorios');
const DISPARO_LOG_PATH = path.resolve(__dirname, process.env.DISPARO_LOG_PATH || '../tim-playwright/disparo_log');
const RELATORIOS_DISPARO_PATH = path.resolve(__dirname, '../tim-playwright/relatorios_disparo');
const PLAYWRIGHT_PATH = path.resolve(__dirname, process.env.PLAYWRIGHT_PATH || '../tim-playwright');
const MODO = (process.env.MODO || 'local').toLowerCase();

const DATA_PATH = path.join(__dirname, 'data');
const PDFS_PATH = path.join(DATA_PATH, 'pdfs');
const BASE_CLIENTES_PATH = path.join(DATA_PATH, 'base-clientes.json');
const BASE_SONAR = {
  PR: path.join(DATA_PATH, 'base-sonar-PR.json'),
  SC: path.join(DATA_PATH, 'base-sonar-SC.json'),
  RS: path.join(DATA_PATH, 'base-sonar-RS.json'),
};
const BASE_CRUZADA_PATH = path.join(DATA_PATH, 'base-cruzada.json');
const SONAR_META_PATH = path.join(DATA_PATH, 'sonar-meta.json');
const CORRECOES_OS_PATH = path.join(DATA_PATH, 'correcoes-os.json');
const AJUSTES_META_PATH = path.join(DATA_PATH, 'ajustes-meta.json');

[DATA_PATH, PDFS_PATH].forEach(p => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');

let processoRobo = null;
let processoDisparo = null;
let sseClients = [];
const processoEstado = { PR: null, SC: null, RS: null };

// ─── JSON helpers ─────────────────────────────────────────────────────────────

function lerJSON(filePath, def = null) {
  try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch {}
  return def;
}

function salvarJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

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

// ─── Processamento ────────────────────────────────────────────────────────────

function limparTelefone(tel) {
  if (!tel) return null;
  const n = String(tel).replace(/\D/g, '');
  if (!n) return null;
  return n.startsWith('55') ? n : `55${n}`;
}

function calcularStatus(statusPagamento, dataVencimento) {
  if (!statusPagamento) return 'SEM DADOS';
  const sp = String(statusPagamento);
  const pagou = sp.startsWith('01') || sp.startsWith('02') || sp.startsWith('03');
  if (pagou) return 'ADIMPLENTE';
  if (!dataVencimento) return 'INADIMPLENTE';
  try {
    const partes = String(dataVencimento).split('/');
    if (partes.length === 3) {
      const venc = new Date(+partes[2], +partes[1] - 1, +partes[0]);
      return venc < new Date() ? 'INADIMPLENTE' : 'ADIMPLENTE';
    }
  } catch {}
  return 'INADIMPLENTE';
}

function cruzarBases() {
  const clientes = lerJSON(BASE_CLIENTES_PATH, []);
  const sonarPR = lerJSON(BASE_SONAR.PR, []);
  const sonarSC = lerJSON(BASE_SONAR.SC, []);
  const sonarRS = lerJSON(BASE_SONAR.RS, []);
  const sonarTotal = [...sonarPR, ...sonarSC, ...sonarRS];

  const indiceSonar = {};
  sonarTotal.forEach(s => { if (s.os) indiceSonar[s.os] = s; });

  const baseCruzada = clientes.map(cliente => {
    const sonar = indiceSonar[cliente.os] || null;
    return {
      ...cliente,
      mesGross: sonar?.mesGross || null,
      status: sonar ? calcularStatus(sonar.statusPagamento, sonar.dataVencimento) : 'SEM DADOS',
      statusPagamento: sonar?.statusPagamento || null,
      detalhamento: sonar?.detalhamento || null,
      dataVencimento: sonar?.dataVencimento || null,
      dataPagamento: sonar?.dataPagamento || null,
      numeroFatura: sonar?.numeroFatura || null,
      mesVencimento: sonar?.mesVencimento || null,
      churn: sonar?.churn === 'Sim',
      uf: sonar?.uf || null,
      cruzado: sonar !== null,
      contatos: [cliente.contatoPrincipal, cliente.contatoResponsavel].filter(Boolean),
    };
  });

  salvarJSON(BASE_CRUZADA_PATH, baseCruzada);
  const meta = lerJSON(SONAR_META_PATH, {});
  meta.ultimaAtualizacao = new Date().toISOString();
  meta.totalClientes = clientes.length;
  meta.totalCruzados = baseCruzada.filter(c => c.cruzado).length;
  salvarJSON(SONAR_META_PATH, meta);

  emitirEvento('cache', { msg: `Base cruzada: ${meta.totalCruzados}/${clientes.length} clientes`, ts: meta.ultimaAtualizacao });
  return baseCruzada;
}

// ─── Filtros ──────────────────────────────────────────────────────────────────

function aplicarFiltros(lista, q) {
  let l = lista;
  if (q.mesGross) l = l.filter(c => c.mesGross === q.mesGross);
  if (q.estado)   l = l.filter(c => q.estado.split(',').includes(c.uf));
  if (q.vendedor) l = l.filter(c => c.vendedor === q.vendedor);
  if (q.status)   l = l.filter(c => q.status.split(',').includes(c.status));
  if (q.contatos === '2') l = l.filter(c => (c.contatos?.length || 0) >= 2);
  if (q.contatos === '1') l = l.filter(c => (c.contatos?.length || 0) === 1);
  return l;
}

// ─── Upload (memória) ─────────────────────────────────────────────────────────

const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Importar Clientes Excel ──────────────────────────────────────────────────

app.post('/api/importar-clientes', uploadMemory.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    const clientes = rows.slice(1)
      .map(row => ({
        vendedor: String(row[0] || '').trim(),
        nome: String(row[1] || '').trim(),
        cpf: String(row[2] || '').trim(),
        contatoPrincipal: limparTelefone(row[3]),
        contatoResponsavel: limparTelefone(row[4]) || null,
        os: String(row[5] || '').trim(),
      }))
      .filter(r => r.nome && r.os);

    // Aplica correções salvas
    const correcoes = lerJSON(CORRECOES_OS_PATH, []);
    correcoes.forEach(c => {
      const idx = clientes.findIndex(cl => cl.cpf === c.cpf && cl.nome === c.nome);
      if (idx >= 0 && c.osNova) clientes[idx].os = c.osNova;
    });

    const warnings = [];
    const totalLinhas = rows.slice(1).filter(r => String(r[1] || '').trim()).length;
    const semOS = rows.slice(1).filter(r => String(r[1] || '').trim() && !String(r[5] || '').trim()).length;
    if (totalLinhas > 0 && semOS / totalLinhas > 0.2) {
      warnings.push(`${semOS} de ${totalLinhas} linhas sem OS (${(semOS / totalLinhas * 100).toFixed(0)}%)`);
    }
    const osSet = new Set();
    const osDups = [];
    clientes.forEach(c => { if (osSet.has(c.os)) osDups.push(c.os); else osSet.add(c.os); });
    if (osDups.length) warnings.push(`${osDups.length} OS duplicadas encontradas`);

    salvarJSON(BASE_CLIENTES_PATH, clientes);
    const meta = lerJSON(SONAR_META_PATH, {});
    if (!meta.clientes) meta.clientes = {};
    meta.clientes.total = clientes.length;
    meta.clientes.importadoEm = new Date().toISOString();
    salvarJSON(SONAR_META_PATH, meta);

    const baseCruzada = cruzarBases();
    res.json({ ok: true, total: clientes.length, cruzados: baseCruzada.filter(c => c.cruzado).length, warnings });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── Importar Sonar CSV ───────────────────────────────────────────────────────

app.post('/api/importar-sonar', uploadMemory.single('arquivo'), (req, res) => {
  const estado = (req.query.estado || '').toUpperCase();
  if (!['PR', 'SC', 'RS'].includes(estado)) return res.status(400).json({ erro: 'Estado inválido. Use PR, SC ou RS' });
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  try {
    const mime = req.file.mimetype || '';
    const nome = req.file.originalname || '';
    const isXlsx = nome.endsWith('.xlsx') || nome.endsWith('.xls') || mime.includes('spreadsheet') || mime.includes('excel');

    let registros;
    if (isXlsx) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      registros = XLSX.utils.sheet_to_json(ws, { defval: '' });
    } else {
      const conteudo = req.file.buffer.toString('utf8').replace(/^﻿/, '');
      registros = parseCSV(conteudo, {
        delimiter: ';',
        columns: true,
        skip_empty_lines: true,
        relax_quotes: true,
        trim: true,
      });
    }

    const ufsNoArquivo = [...new Set(registros.map(r => r['UF']).filter(Boolean))];
    if (ufsNoArquivo.length > 0 && !ufsNoArquivo.includes(estado)) {
      return res.status(400).json({
        erro: `Arquivo contém UF: ${ufsNoArquivo.join(', ')}. Esperado: ${estado}. Verifique se selecionou o arquivo correto.`,
      });
    }

    const processados = registros.map(r => ({
      os: String(r['NÚMERO ORDEM'] || '').trim(),
      custcode: String(r['COD CUSTCODE CLIENTE'] || '').replace(/[="]/g, '').trim(),
      mesGross: r['MÊS GROSS'] || null,
      numeroFatura: r['NÚMERO FATURA'] || null,
      statusPagamento: r['STATUS PAGAMENTO'] || null,
      detalhamento: r['DETALHAMENTO FATURA'] || null,
      mesVencimento: r['MÊS VENCIMENTO'] || null,
      dataVencimento: r['DATA VENCIMENTO'] || null,
      dataPagamento: r['DATA PAGAMENTO'] || null,
      uf: r['UF'] || estado,
      churn: r['CHURN'] || null,
      loginVendedor: r['LOGIN VENDEDOR'] || null,
      ultimaAtualizacao: r['ÚLTIMA DATA ATUALIZAÇÃO'] || null,
      status: calcularStatus(r['STATUS PAGAMENTO'], r['DATA VENCIMENTO']),
    })).filter(r => r.os);

    salvarJSON(BASE_SONAR[estado], processados);
    const meta = lerJSON(SONAR_META_PATH, {});
    if (!meta.sonar) meta.sonar = {};
    meta.sonar[estado] = { total: processados.length, importadoEm: new Date().toISOString() };
    salvarJSON(SONAR_META_PATH, meta);

    const baseCruzada = cruzarBases();
    res.json({ ok: true, estado, total: processados.length, cruzados: baseCruzada.filter(c => c.cruzado).length });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── Status de importação ─────────────────────────────────────────────────────

app.get('/api/importacao/status', (req, res) => {
  try {
    const meta = lerJSON(SONAR_META_PATH, {});
    const hoje = new Date().toDateString();

    const statusImport = (importadoEm) => {
      if (!importadoEm) return 'nunca';
      const d = new Date(importadoEm);
      if (d.toDateString() === hoje) return 'hoje';
      const diff = (Date.now() - d) / 86400000;
      return diff <= 1 ? 'ontem' : 'antigo';
    };

    const baseCruzada = lerJSON(BASE_CRUZADA_PATH, []);
    res.json({
      clientes: {
        total: meta.clientes?.total || 0,
        importadoEm: meta.clientes?.importadoEm || null,
        status: statusImport(meta.clientes?.importadoEm),
      },
      sonar: {
        PR: { total: meta.sonar?.PR?.total || 0, importadoEm: meta.sonar?.PR?.importadoEm || null, status: statusImport(meta.sonar?.PR?.importadoEm) },
        SC: { total: meta.sonar?.SC?.total || 0, importadoEm: meta.sonar?.SC?.importadoEm || null, status: statusImport(meta.sonar?.SC?.importadoEm) },
        RS: { total: meta.sonar?.RS?.total || 0, importadoEm: meta.sonar?.RS?.importadoEm || null, status: statusImport(meta.sonar?.RS?.importadoEm) },
      },
      cruzamento: {
        total: baseCruzada.length,
        cruzados: baseCruzada.filter(c => c.cruzado).length,
        semMatch: baseCruzada.filter(c => !c.cruzado).length,
      },
      ultimaAtualizacao: meta.ultimaAtualizacao || null,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Resumo ───────────────────────────────────────────────────────────────────

app.get('/api/resumo', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    const meta = lerJSON(SONAR_META_PATH, {});
    const f = aplicarFiltros(todos, req.query);
    const total = f.length;

    const adimplentes = f.filter(c => c.status === 'ADIMPLENTE' && !c.churn).length;
    const inadimplentes = f.filter(c => c.status === 'INADIMPLENTE' && !c.churn).length;
    const semDados = f.filter(c => c.status === 'SEM DADOS').length;
    const churn = f.filter(c => c.churn).length;
    const com2Contatos = f.filter(c => (c.contatos?.length || 0) >= 2).length;
    const soSoPrincipal = f.filter(c => (c.contatos?.length || 0) === 1).length;
    const semCruzamento = f.filter(c => !c.cruzado).length;
    const totalFaturas = fs.existsSync(PDFS_PATH) ? fs.readdirSync(PDFS_PATH).filter(f => f.endsWith('.pdf')).length : 0;

    res.json({
      total, adimplentes, inadimplentes, semDados, churn,
      com2Contatos, soSoPrincipal, semCruzamento, totalFaturas,
      pctAdimplentes: total > 0 ? +(adimplentes / total * 100).toFixed(1) : 0,
      pctInadimplentes: total > 0 ? +(inadimplentes / total * 100).toFixed(1) : 0,
      ultimaAtualizacao: meta.ultimaAtualizacao || null,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Clientes ─────────────────────────────────────────────────────────────────

app.get('/api/clientes', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    let lista = aplicarFiltros(todos, req.query);

    if (req.query.busca) {
      const b = req.query.busca.toLowerCase();
      lista = lista.filter(c =>
        (c.nome || '').toLowerCase().includes(b) ||
        (c.vendedor || '').toLowerCase().includes(b) ||
        (c.cpf || '').includes(b) ||
        (c.os || '').includes(b)
      );
    }

    const { ordenar = 'nome', direcao = 'asc' } = req.query;
    lista.sort((a, b) => {
      const va = String(a[ordenar] || '');
      const vb = String(b[ordenar] || '');
      return direcao === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });

    const pagina = parseInt(req.query.pagina) || 1;
    const porPagina = parseInt(req.query.porPagina) || 50;
    const total = lista.length;
    const dados = lista.slice((pagina - 1) * porPagina, pagina * porPagina);

    res.json({ total, pagina, porPagina, totalPaginas: Math.ceil(total / porPagina) || 1, dados });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Filtros/Opções ───────────────────────────────────────────────────────────

app.get('/api/filtros/opcoes', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    const mesesGross = [...new Set(todos.map(c => c.mesGross).filter(Boolean))].sort();
    const vendedores = [...new Set(todos.map(c => c.vendedor).filter(Boolean))].sort();
    const estados = [...new Set(todos.map(c => c.uf).filter(Boolean))].sort();
    res.json({ mesesGross, vendedores, estados });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Atualizar (recruzar a partir dos JSONs) ──────────────────────────────────

app.post('/api/atualizar', (req, res) => {
  try {
    const baseCruzada = cruzarBases();
    const meta = lerJSON(SONAR_META_PATH, {});
    res.json({ ok: true, total: baseCruzada.length, ts: meta.ultimaAtualizacao });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Gráficos ─────────────────────────────────────────────────────────────────

app.get('/api/graficos/status-geral', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    const f = aplicarFiltros(todos, req.query);
    const total = f.length;
    const adimplentes = f.filter(c => c.status === 'ADIMPLENTE' && !c.churn).length;
    const inadimplentes = f.filter(c => c.status === 'INADIMPLENTE' && !c.churn).length;
    const semDados = f.filter(c => c.status === 'SEM DADOS').length;
    const churn = f.filter(c => c.churn).length;
    res.json({
      labels: ['Adimplente', 'Inadimplente', 'Sem Dados', 'Churn'],
      valores: [adimplentes, inadimplentes, semDados, churn],
      total,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/graficos/evolucao', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    const f = aplicarFiltros(todos, req.query).filter(c => c.mesGross);
    const meses = [...new Set(f.map(c => c.mesGross))].sort();
    res.json({
      labels: meses,
      adimplentes: meses.map(m => f.filter(c => c.mesGross === m && c.status === 'ADIMPLENTE').length),
      inadimplentes: meses.map(m => f.filter(c => c.mesGross === m && c.status === 'INADIMPLENTE').length),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/graficos/estados', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    const f = aplicarFiltros(todos, req.query);
    const cont = {};
    f.forEach(c => { if (c.uf) cont[c.uf] = (cont[c.uf] || 0) + 1; });
    const sorted = Object.entries(cont).sort((a, b) => b[1] - a[1]);
    res.json({ labels: sorted.map(e => e[0]), valores: sorted.map(e => e[1]) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/graficos/vendedores', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    const f = aplicarFiltros(todos, req.query);
    const vendedores = [...new Set(f.map(c => c.vendedor).filter(Boolean))];
    const ranking = vendedores.map(v => {
      const grupo = f.filter(c => c.vendedor === v);
      const inadim = grupo.filter(c => c.status === 'INADIMPLENTE').length;
      return { vendedor: v, total: grupo.length, inadimplentes: inadim, pct: grupo.length > 0 ? +(inadim / grupo.length * 100).toFixed(1) : 0 };
    }).filter(v => v.total >= 3).sort((a, b) => b.inadimplentes - a.inadimplentes).slice(0, 10);
    res.json({
      labels: ranking.map(v => v.vendedor),
      valores: ranking.map(v => v.inadimplentes),
      totais: ranking.map(v => v.total),
      pcts: ranking.map(v => v.pct),
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/graficos/disparos', (req, res) => {
  try {
    const contPorDia = {};
    if (fs.existsSync(DISPARO_LOG_PATH)) {
      for (const f of fs.readdirSync(DISPARO_LOG_PATH).filter(f => f.endsWith('.json'))) {
        try {
          const entries = JSON.parse(fs.readFileSync(path.join(DISPARO_LOG_PATH, f), 'utf8'));
          for (const e of (Array.isArray(entries) ? entries : [])) {
            if (e.status === 'enviado' && e.ts) {
              const dia = String(e.ts).slice(0, 10);
              contPorDia[dia] = (contPorDia[dia] || 0) + 1;
            }
          }
        } catch {}
      }
    }
    const labels = [], valores = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dia = d.toISOString().slice(0, 10);
      labels.push(dia.slice(5).replace('-', '/'));
      valores.push(contPorDia[dia] || 0);
    }
    res.json({ labels, valores });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/graficos/robo', (req, res) => {
  try {
    const contPorDia = {};
    if (fs.existsSync(RELATORIOS_PATH)) {
      for (const f of fs.readdirSync(RELATORIOS_PATH).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))) {
        const m = f.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) {
          const dia = m[1];
          try {
            const wb = XLSX.readFile(path.join(RELATORIOS_PATH, f));
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
            const ok = new Set(['Sucesso', 'Sucesso (2ª tentativa)']);
            const n = rows.filter(r => ok.has(String(r.Status || '').trim())).length;
            contPorDia[dia] = (contPorDia[dia] || 0) + n;
          } catch {}
        }
      }
    }
    const labels = [], valores = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dia = d.toISOString().slice(0, 10);
      labels.push(dia.slice(5).replace('-', '/'));
      valores.push(contPorDia[dia] || 0);
    }
    res.json({ labels, valores });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Ajustes ──────────────────────────────────────────────────────────────────

app.get('/api/ajustes/resumo', (req, res) => {
  try {
    const baseCruzada = lerJSON(BASE_CRUZADA_PATH, []);
    const ajustesMeta = lerJSON(AJUSTES_META_PATH, {});
    const semMatch = baseCruzada.filter(c => !c.cruzado);

    const grupos = {};
    semMatch.forEach(c => {
      const chave = c.mesGross || 'Sem data';
      if (!grupos[chave]) grupos[chave] = [];
      grupos[chave].push(c);
    });

    const resumo = Object.entries(grupos).map(([mes, clientes]) => ({
      mes,
      total: clientes.length,
      concluido: ajustesMeta[mes]?.concluido || false,
      dataConclusao: ajustesMeta[mes]?.dataConclusao || null,
    })).sort((a, b) => {
      if (a.mes === 'Sem data') return 1;
      if (b.mes === 'Sem data') return -1;
      return a.mes.localeCompare(b.mes);
    });

    res.json({ total: semMatch.length, grupos: resumo });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/ajustes/mes/:mes', (req, res) => {
  try {
    const mes = decodeURIComponent(req.params.mes);
    const baseCruzada = lerJSON(BASE_CRUZADA_PATH, []);
    const clientes = baseCruzada.filter(c => !c.cruzado && (c.mesGross === mes || (mes === 'Sem data' && !c.mesGross)));
    res.json({ mes, total: clientes.length, clientes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/ajustes/exportar/:mes', (req, res) => {
  try {
    const mes = decodeURIComponent(req.params.mes);
    const baseCruzada = lerJSON(BASE_CRUZADA_PATH, []);
    const clientes = baseCruzada.filter(c => !c.cruzado && (c.mesGross === mes || (mes === 'Sem data' && !c.mesGross)));
    const headers = ['Nome', 'CPF', 'OS', 'Vendedor', 'Estado', 'Mês Gross'];
    const linhas = [headers, ...clientes.map(c => [c.nome, c.cpf, c.os, c.vendedor, c.uf, c.mesGross])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Ajustes');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const nomeMes = mes.replace(/[/\\:*?"<>|]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="ajustes_${nomeMes}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/corrigir-os', (req, res) => {
  try {
    const { nome, cpf, osAntiga, osNova } = req.body;
    if (!nome || !osNova) return res.status(400).json({ erro: 'nome e osNova são obrigatórios' });

    const correcoes = lerJSON(CORRECOES_OS_PATH, []);
    const idx = correcoes.findIndex(c => c.cpf === cpf && c.nome === nome);
    const nova = { nome, cpf: cpf || '', osAntiga: osAntiga || '', osNova: osNova.trim(), dataCorrecao: new Date().toISOString() };
    if (idx >= 0) correcoes[idx] = nova; else correcoes.push(nova);
    salvarJSON(CORRECOES_OS_PATH, correcoes);

    const clientes = lerJSON(BASE_CLIENTES_PATH, []);
    const ci = clientes.findIndex(c => c.cpf === cpf && c.nome === nome);
    if (ci >= 0) { clientes[ci].os = osNova.trim(); salvarJSON(BASE_CLIENTES_PATH, clientes); }

    cruzarBases();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/ajustes/concluir', (req, res) => {
  try {
    const { mes } = req.body;
    if (!mes) return res.status(400).json({ erro: 'mes é obrigatório' });
    const meta = lerJSON(AJUSTES_META_PATH, {});
    meta[mes] = { concluido: true, dataConclusao: new Date().toISOString() };
    salvarJSON(AJUSTES_META_PATH, meta);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Modo ─────────────────────────────────────────────────────────────────────

app.get('/api/modo', (req, res) => res.json({ modo: MODO }));

function apenasLocal(req, res, next) {
  if (MODO === 'vps') return res.status(403).json({ erro: 'Disponível apenas localmente. No VPS, o robô SGR roda no PC com Chrome.' });
  next();
}

// ─── Status robôs ─────────────────────────────────────────────────────────────

app.get('/api/status-robo', (req, res) => {
  res.json({ robo: processoRobo ? 'rodando' : 'parado', disparo: processoDisparo ? 'rodando' : 'parado' });
});

app.get('/api/status-robos', (req, res) => {
  const status = {};
  ['PR', 'SC', 'RS'].forEach(e => { status[e] = processoEstado[e] ? 'rodando' : 'parado'; });
  res.json({ estados: status, robo: processoRobo ? 'rodando' : 'parado', disparo: processoDisparo ? 'rodando' : 'parado' });
});

// ─── Robôs por estado ─────────────────────────────────────────────────────────

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
      if (tokReq) emitirEvento('token-request', { estado: tokReq[1], msg: `[${estado}] ⏳ Robô aguardando token — DIGITE AGORA!` });
      else emitirEvento('robo-log', { msg: `[${estado}] ` + t, estado });
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

// ─── Relatórios ───────────────────────────────────────────────────────────────

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

app.get('/api/relatorios', (req, res) => {
  if (!fs.existsSync(RELATORIOS_PATH)) return res.json({ arquivos: [] });
  const arquivos = fs.readdirSync(RELATORIOS_PATH)
    .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .sort().reverse();
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
    let disparados = 0;
    for (const r of sucesso) {
      const numeros = Object.keys(r).filter(k => /^Número/i.test(k)).map(k => String(r[k] || '').trim()).filter(n => n.toLowerCase().endsWith('.pdf'));
      if (numeros.some(n => jaEnviadosPdfs.has(n))) disparados++;
    }
    res.json({ total, disparados, pendentes: total - disparados, linhas: rows.length });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/relatorios-disparo', (req, res) => {
  if (!fs.existsSync(RELATORIOS_DISPARO_PATH)) return res.json({ arquivos: [] });
  const arquivos = fs.readdirSync(RELATORIOS_DISPARO_PATH)
    .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .sort().reverse();
  res.json({ arquivos });
});

app.get('/api/relatorios-disparo/download/:arquivo', (req, res) => {
  const arquivo = path.basename(req.params.arquivo);
  const filePath = path.join(RELATORIOS_DISPARO_PATH, arquivo);
  if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(filePath);
});

// ─── Disparo WhatsApp ─────────────────────────────────────────────────────────

app.post('/api/comando/disparar', apenasLocal, (req, res) => {
  const lockFile = path.join(PLAYWRIGHT_PATH, 'disparo_log', '.disparo.lock');
  if (processoDisparo) return res.status(400).json({ erro: 'Disparo já está rodando pelo dashboard' });
  if (fs.existsSync(lockFile)) {
    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim());
      process.kill(pid, 0);
      return res.status(400).json({ erro: `Disparo já está rodando (PID ${pid}). Pare antes de iniciar outro.` });
    } catch { fs.unlinkSync(lockFile); }
  }
  if (!fs.existsSync(RELATORIOS_PATH)) return res.status(400).json({ erro: 'Pasta de relatórios não encontrada' });
  const arquivos = fs.readdirSync(RELATORIOS_PATH).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$')).sort().reverse();
  if (!arquivos.length) return res.status(400).json({ erro: 'Nenhum relatório encontrado' });
  const escolhido = req.body?.relatorio && arquivos.includes(req.body.relatorio) ? req.body.relatorio : arquivos[0];
  const relatorio = path.join(RELATORIOS_PATH, escolhido);
  const limite = parseInt(req.body?.limite) || 0;
  const delay = parseInt(req.body?.delay) || 30;
  const lote = parseInt(req.body?.lote) || 50;
  const pausaLote = parseInt(req.body?.pausaLote) || 300;
  const args = ['disparar-faturas.js', relatorio, `--delay=${delay}`, `--lote=${lote}`, `--pausa-lote=${pausaLote}`];
  if (limite > 0) args.push(`--limit=${limite}`);
  emitirEvento('disparo', { msg: `📤 Iniciando disparo: ${escolhido}${limite > 0 ? ` (limite: ${limite})` : ''}`, status: 'rodando' });
  processoDisparo = spawn('node', args, { cwd: PLAYWRIGHT_PATH });
  processoDisparo.stdout.on('data', d => {
    const txt = d.toString();
    for (const linha of txt.split('\n')) {
      const trim = stripAnsi(linha.trim());
      if (!trim) continue;
      const prog = trim.match(/^PROGRESSO:(\d+):(\d+)$/);
      if (prog) emitirEvento('progresso', { atual: parseInt(prog[1]), total: parseInt(prog[2]) });
      else emitirEvento('disparo-log', { msg: trim });
    }
  });
  processoDisparo.stderr.on('data', d => emitirEvento('disparo-log', { msg: '⚠️ ' + stripAnsi(d.toString().trim()) }));
  processoDisparo.on('close', code => { emitirEvento('disparo', { msg: `📤 Disparo finalizado (código ${code})`, status: 'parado' }); processoDisparo = null; });
  res.json({ ok: true, relatorio: escolhido });
});

app.post('/api/comando/disparo-parar', apenasLocal, (req, res) => {
  if (!processoDisparo) return res.status(400).json({ erro: 'Nenhum disparo rodando' });
  processoDisparo.kill('SIGTERM'); processoDisparo = null;
  emitirEvento('disparo', { msg: '⏹ Disparo interrompido manualmente', status: 'parado' });
  res.json({ ok: true });
});

// ─── Upload e faturas PDF ─────────────────────────────────────────────────────

const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const NOME_PDF_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 _\-]+_\d{3}\.\d{3}\.\d{3}-\d{2}_\d{2}-\d{4}\.pdf$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PDFS_PATH),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.pdf')) return cb(new Error('Apenas arquivos .pdf são aceitos'));
    if (!NOME_PDF_RE.test(file.originalname)) return cb(new Error('Nome inválido. Use o padrão NOME_CPF_MM-AAAA.pdf'));
    cb(null, true);
  },
});

function autorizarUpload(req, res, next) {
  if (!UPLOAD_TOKEN) return res.status(500).json({ erro: 'UPLOAD_TOKEN não configurado no servidor' });
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${UPLOAD_TOKEN}`) return res.status(401).json({ erro: 'Token inválido' });
  next();
}

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

    let arquivos = fs.readdirSync(PDFS_PATH).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
    if (busca) arquivos = arquivos.filter(f => semAcento(f).includes(busca));

    const total = arquivos.length;
    const paginas = Math.ceil(total / porPagina) || 1;
    const slice = arquivos.slice((pagina - 1) * porPagina, pagina * porPagina);

    const clientes = {};
    for (const arq of slice) {
      const m = arq.match(/^(.+)_(\d{2}-\d{4})\.pdf$/i);
      let nome, cpf, mesAno, chave;
      if (m) {
        const antes = m[1]; mesAno = m[2];
        const sep = antes.lastIndexOf('_');
        cpf = sep >= 0 ? antes.substring(sep + 1) : '';
        nome = sep >= 0 ? antes.substring(0, sep) : antes;
        chave = `${nome}_${cpf}`;
      } else {
        nome = arq.replace('.pdf', ''); cpf = ''; mesAno = ''; chave = nome;
      }
      if (!clientes[chave]) clientes[chave] = { nome, cpf, faturas: [] };
      clientes[chave].faturas.push({ arquivo: arq, mesAno });
    }

    res.json({ total, pagina, paginas, clientes: Object.values(clientes) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/faturas/download/:arquivo', (req, res) => {
  const arquivo = path.basename(req.params.arquivo);
  if (!arquivo.toLowerCase().endsWith('.pdf')) return res.status(400).json({ erro: 'Arquivo inválido' });
  const filePath = path.join(PDFS_PATH, arquivo);
  if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(filePath);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Dashboard rodando em http://0.0.0.0:${PORT} [modo: ${MODO}]`);
});
