require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const XLSX = require('xlsx');
const multer = require('multer');
const { parse: parseCSV } = require('csv-parse/sync');
const session = require('express-session');
const bcrypt = require('bcryptjs');

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
const HISTORICO_ROBOS_PATH = path.join(DATA_PATH, 'historico-robos.json');
// Faturas marcadas manualmente como pagas ("Base Pagos") — persiste entre cruzamentos.
// Estrutura: { [custcodeNormalizado]: { cpf, vencimentos: ["10/06/2026", ...] } }
const PAGOS_MANUAIS_PATH = path.join(DATA_PATH, 'pagos-manuais.json');
const USUARIOS_PATH = path.join(DATA_PATH, 'usuarios.json');
// Fechamento oficial mensal da TIM (planilha "Cesta de Qualidade") — quando existe
// pra uma safra, substitui a nossa estimativa por atraso (ver calcularIQSafra).
const CESTA_OFICIAL_PATH = path.join(DATA_PATH, 'cesta-oficial.json');

[DATA_PATH, PDFS_PATH].forEach(p => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); });

function salvarHistoricoRobo(estado) {
  try {
    const prog = lerJSON(path.join(PLAYWRIGHT_PATH, `progresso_${estado}.json`), {});
    const resultados = prog.resultados || [];
    const sucesso = resultados.filter(r => /^Sucesso/.test(r.status || '')).length;
    const hist = lerJSON(HISTORICO_ROBOS_PATH, {});
    hist[estado] = { ultimoRun: new Date().toISOString(), total: resultados.length, sucesso };
    fs.writeFileSync(HISTORICO_ROBOS_PATH, JSON.stringify(hist, null, 2));
  } catch {}
}

app.use(express.json({ limit: '10mb' }));

// CORS para o localhost aceitar chamadas do browser vindo do VPS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Login / sessão ────────────────────────────────────────────────────────────

app.use(session({
  secret: process.env.SESSION_SECRET || 'troque-este-segredo-no-env',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, sameSite: 'lax' }, // 7 dias
}));

// Rotas que não exigem login: a própria página/endpoint de login, e os
// endpoints chamados por máquina (tim-playwright, Chatwoot) que já têm sua
// própria autenticação (Bearer token ou nenhuma, no caso do webhook externo).
const ROTAS_PUBLICAS = [
  { method: 'GET',  path: '/login.html' },
  { method: 'POST', path: '/api/login' },
  { method: 'POST', path: '/api/upload-pdf' },
  { method: 'POST', path: '/api/faturas/codigos' },
  { method: 'POST', path: '/api/faturas/envio' },
  { method: 'GET',  path: '/api/faturas/nomes' },
  { method: 'POST', path: '/webhook/chatwoot' },
];

function exigirLogin(req, res, next) {
  // O login existe para proteger o dashboard exposto na internet (VPS). Rodando
  // localmente é o companion do robô, acessível só na própria máquina — pedir
  // senha ali só atrapalharia a operação.
  if (MODO !== 'vps') {
    // Abas/atalhos antigos apontando direto para a tela de login continuariam
    // mostrando um formulário inútil aqui — manda para a raiz.
    if (req.path === '/login.html') return res.redirect('/');
    return next();
  }
  const publico = ROTAS_PUBLICAS.some(r => r.method === req.method && req.path === r.path);
  if (publico) return next();
  if (req.session && req.session.usuario) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return res.status(401).json({ erro: 'Não autenticado' });
  }
  return res.redirect('/login.html');
}

app.use(exigirLogin);
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ erro: 'Usuário e senha obrigatórios' });

  const usuarios = lerJSON(USUARIOS_PATH, []);
  const encontrado = usuarios.find(u => u.usuario === usuario);
  if (!encontrado || !bcrypt.compareSync(senha, encontrado.senhaHash)) {
    return res.status(401).json({ erro: 'Usuário ou senha inválidos' });
  }

  req.session.usuario = { usuario: encontrado.usuario, nome: encontrado.nome };
  res.json({ ok: true, nome: encontrado.nome });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/sessao', (req, res) => {
  res.json({ logado: !!(req.session && req.session.usuario), usuario: req.session?.usuario || null });
});

// ─── Gestão de usuários ────────────────────────────────────────────────────────

app.get('/api/usuarios', (req, res) => {
  const usuarios = lerJSON(USUARIOS_PATH, []);
  res.json(usuarios.map(u => ({ usuario: u.usuario, nome: u.nome, criadoEm: u.criadoEm })));
});

app.post('/api/usuarios', (req, res) => {
  const { usuario, senha, nome } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ erro: 'Usuário e senha obrigatórios' });
  if (senha.length < 6) return res.status(400).json({ erro: 'Senha precisa de pelo menos 6 caracteres' });

  const usuarios = lerJSON(USUARIOS_PATH, []);
  if (usuarios.some(u => u.usuario === usuario)) {
    return res.status(400).json({ erro: 'Já existe um usuário com esse nome' });
  }

  usuarios.push({
    usuario,
    senhaHash: bcrypt.hashSync(senha, 10),
    nome: nome || usuario,
    criadoEm: new Date().toISOString(),
  });
  salvarJSON(USUARIOS_PATH, usuarios);
  res.json({ ok: true });
});

app.put('/api/usuarios/:usuario', (req, res) => {
  const { senha, nome } = req.body || {};
  const usuarios = lerJSON(USUARIOS_PATH, []);
  const alvo = usuarios.find(u => u.usuario === req.params.usuario);
  if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado' });

  if (senha) {
    if (senha.length < 6) return res.status(400).json({ erro: 'Senha precisa de pelo menos 6 caracteres' });
    alvo.senhaHash = bcrypt.hashSync(senha, 10);
  }
  if (nome) alvo.nome = nome;

  salvarJSON(USUARIOS_PATH, usuarios);
  res.json({ ok: true });
});

app.delete('/api/usuarios/:usuario', (req, res) => {
  const usuarios = lerJSON(USUARIOS_PATH, []);
  if (usuarios.length <= 1) return res.status(400).json({ erro: 'Não é possível excluir o último usuário' });

  const restantes = usuarios.filter(u => u.usuario !== req.params.usuario);
  if (restantes.length === usuarios.length) return res.status(404).json({ erro: 'Usuário não encontrado' });

  salvarJSON(USUARIOS_PATH, restantes);
  res.json({ ok: true });
});

const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');

let processoRobo = null;
let processoDisparo = null;
let sseClients = [];
const processoEstado = { PR: null, SC: null, RS: null, PR2: null, SC2: null, RS2: null };
const ESTADOS_VALIDOS = ['PR', 'SC', 'RS', 'PR2', 'SC2', 'RS2'];

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
  // Números com 12+ dígitos começando com 55 já têm código do país
  // Números com 10-11 dígitos começando com 55 têm DDD 55 (ex: Caxias do Sul)
  return (n.length >= 12 && n.startsWith('55')) ? n : `55${n}`;
}

const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MESES_MAP = Object.fromEntries(MESES_PT.map((m, i) => [m.toLowerCase(), String(i + 1).padStart(2, '0')]));

// Normaliza qualquer formato de mês para MM/YYYY
function normalizarMes(val) {
  if (!val) return null;
  // Date object
  if (val instanceof Date) {
    return `${String(val.getUTCMonth() + 1).padStart(2, '0')}/${val.getUTCFullYear()}`;
  }
  const s = String(val).trim();
  if (!s) return null;
  // Serial Excel numérico
  if (!isNaN(s)) {
    const d = new Date(Math.round((Number(s) - 25569) * 86400 * 1000));
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  }
  // DD/MM/YYYY
  const mDMY = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mDMY) return `${mDMY[2].padStart(2, '0')}/${mDMY[3]}`;
  // Janeiro/2026 → 01/2026
  const mNome = s.match(/^([A-Za-zÀ-ú]+)\/(\d{4})$/);
  if (mNome) {
    const mm = MESES_MAP[mNome[1].toLowerCase()];
    if (mm) return `${mm}/${mNome[2]}`;
  }
  // Já é MM/YYYY
  return s;
}

// Alias para compatibilidade
const converterDataParaMesAno = normalizarMes;
const excelSerialParaMes = normalizarMes;

function calcularStatus(statusPagamento, dataVencimento) {
  if (!statusPagamento) return 'SEM DADOS';
  const sp = String(statusPagamento).trim();
  // 01 = pagou no vencimento, 02 = pagou até 30 dias após → ADIMPLENTE
  if (sp.startsWith('01') || sp.startsWith('02')) return 'ADIMPLENTE';
  // 03, 04 = pagou com atraso >30 dias — já foi pago (não é mais uma cobrança em
  // aberto), mas conta como atraso pra qualidade/IQ do mesmo jeito que antes.
  if (sp.startsWith('03') || sp.startsWith('04')) return 'PAGO_ATRASO';
  // 05 = não pagou → INADIMPLENTE
  if (sp.startsWith('05')) return 'INADIMPLENTE';
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

const soDigitos = s => String(s || '').replace(/\D/g, '');

// Marca como pagas (amarelo/manual) as faturas cujo vencimento consta na "Base Pagos".
// Só afeta faturas EXISTENTES que estão INADIMPLENTE → vira ADIMPLENTE com flag pagoManual.
function aplicarPagosManuais(custcode, cpf, faturasProc, pagos) {
  const reg = pagos[soDigitos(custcode)] || (cpf ? Object.values(pagos).find(p => soDigitos(p.cpf) === soDigitos(cpf)) : null);
  if (!reg || !Array.isArray(reg.vencimentos) || !reg.vencimentos.length) return;
  const alvo = new Set(reg.vencimentos.map(v => String(v).trim()));
  for (const f of faturasProc) {
    if (alvo.has(String(f.dataVencimento || '').trim()) && f.status !== 'ADIMPLENTE') {
      f.status = 'ADIMPLENTE';
      f.pagoManual = true; // usado para pintar de amarelo na tabela
    }
  }
}

function cruzarBases() {
  const clientes = lerJSON(BASE_CLIENTES_PATH, []);
  const pagosManuais = lerJSON(PAGOS_MANUAIS_PATH, {});
  const sonarPR = lerJSON(BASE_SONAR.PR, []);
  const sonarSC = lerJSON(BASE_SONAR.SC, []);
  const sonarRS = lerJSON(BASE_SONAR.RS, []);
  const sonarTotal = [...sonarPR, ...sonarSC, ...sonarRS];

  // Índice de clientes por OS
  const indiceClientes = {};
  clientes.forEach(c => { if (c.os) indiceClientes[c.os] = c; });

  // Agrupar faturas por OS
  const grupos = {};
  sonarTotal.forEach(s => {
    if (!s.os) return;
    if (!grupos[s.os]) grupos[s.os] = [];
    grupos[s.os].push(s);
  });

  // 1 registro por OS (cliente único)
  const baseCruzada = Object.entries(grupos).map(([os, faturas]) => {
    faturas.sort((a, b) => (Number(a.numeroFatura) || 0) - (Number(b.numeroFatura) || 0));
    const ref = faturas[0];
    const cliente = indiceClientes[os] || null;

    const faturasProc = faturas.map(f => ({
      numero: Number(f.numeroFatura) || 0,
      statusPagamento: f.statusPagamento || null,
      detalhamento: f.detalhamento || null,
      mesVencimento: f.mesVencimento || null,
      dataVencimento: f.dataVencimento || null,
      dataPagamento: f.dataPagamento || null,
      opcaoPagamento: f.opcaoPagamento || null,
      insucessoDacc: f.insucessoDacc || null,
      nomeBanco: f.nomeBanco || null,
      suspensaoFraude: f.suspensaoFraude || null,
      churn: f.churn || null,
      status: calcularStatus(f.statusPagamento, f.dataVencimento),
    }));

    // Aplica as marcações manuais de "Base Pagos" ANTES de calcular status/totais
    aplicarPagosManuais(ref.custcode, cliente?.cpf, faturasProc, pagosManuais);

    // PAGO_ATRASO conta como paga (o cliente já quitou, só que fora do prazo).
    const faturasPagas = faturasProc.filter(f => f.status === 'ADIMPLENTE' || f.status === 'PAGO_ATRASO').length;
    const algumaNaoPaga = faturasProc.some(f => f.status === 'INADIMPLENTE');
    const algumaPagaAtraso = faturasProc.some(f => f.status === 'PAGO_ATRASO');
    const statusGeral = algumaNaoPaga ? 'INADIMPLENTE' : (algumaPagaAtraso ? 'PAGO_ATRASO' : (faturasPagas > 0 ? 'ADIMPLENTE' : 'SEM DADOS'));

    return {
      os,
      mesGross: ref.mesGross || null,
      uf: ref.uf || null,
      churn: faturas.some(f => f.churn === 'Sim'),
      loginVendedor: ref.loginVendedor || null,
      custcode: ref.custcode || null,
      nome: cliente?.nome || null,
      cpf: cliente?.cpf || null,
      vendedor: cliente?.vendedor || null,
      contatoPrincipal: cliente?.contatoPrincipal || null,
      contatoResponsavel: cliente?.contatoResponsavel || null,
      mesGrossManual: cliente?.mesGrossManual || null,
      contatos: cliente ? [cliente.contatoPrincipal, cliente.contatoResponsavel].filter(Boolean) : [],
      cruzado: cliente !== null,
      faturas: faturasProc,
      totalFaturas: faturasProc.length,
      faturasPagas,
      status: statusGeral,
    };
  });

  // Clientes importados que ainda não têm nenhuma fatura no Sonar — sem esta
  // passada eles ficavam totalmente invisíveis na Tabela de Clientes (a base
  // cruzada só existia a partir das faturas). Entram com status "SEM DADOS" e
  // usam o Mês Gross da própria planilha (mesGrossManual) já que o Sonar ainda
  // não tem nada sobre eles. Assim que o Sonar gerar a 1ª fatura, na próxima
  // Recruzada eles passam a vir pelo caminho normal acima, com mesGross do
  // Sonar — não sobra nenhum resquício deste "modo provisório".
  clientes.forEach(c => {
    if (!c.os || grupos[c.os]) return; // já entrou pelo caminho normal acima

    baseCruzada.push({
      os: c.os,
      mesGross: c.mesGrossManual || null,
      uf: null,
      churn: false,
      loginVendedor: null,
      custcode: null,
      nome: c.nome || null,
      cpf: c.cpf || null,
      vendedor: c.vendedor || null,
      contatoPrincipal: c.contatoPrincipal || null,
      contatoResponsavel: c.contatoResponsavel || null,
      mesGrossManual: c.mesGrossManual || null,
      contatos: [c.contatoPrincipal, c.contatoResponsavel].filter(Boolean),
      cruzado: true,
      faturas: [],
      totalFaturas: 0,
      faturasPagas: 0,
      status: 'SEM DADOS',
    });
  });

  salvarJSON(BASE_CRUZADA_PATH, baseCruzada);
  const meta = lerJSON(SONAR_META_PATH, {});
  meta.ultimaAtualizacao = new Date().toISOString();
  meta.totalOSs = baseCruzada.length;
  meta.totalCruzados = baseCruzada.filter(c => c.cruzado).length;
  salvarJSON(SONAR_META_PATH, meta);

  emitirEvento('cache', { msg: `Base cruzada: ${meta.totalCruzados}/${baseCruzada.length} clientes`, ts: meta.ultimaAtualizacao });
  return baseCruzada;
}

// ─── Anotações de atendimento por cliente ────────────────────────────────────
// Ficam num arquivo próprio (chave = OS) em vez de dentro da base cruzada, para
// sobreviverem ao Recruzar e às reimportações do Sonar.

const ANOTACOES_PATH = path.join(DATA_PATH, 'anotacoes-clientes.json');
const MARCADORES_VALIDOS = ['pagou', 'promessa', 'problema_tecnico', 'problema_app', 'cancelamento', 'venda_errada'];

// ─── Filtros ──────────────────────────────────────────────────────────────────

function safraParaMeses(mesInicio) {
  // mesInicio formato "MM/YYYY" → retorna array com mesInicio + 4 meses seguintes
  const [mm, yyyy] = mesInicio.split('/').map(Number);
  const meses = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(yyyy, mm - 1 + i, 1);
    meses.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
  }
  return meses;
}

// ─── IQ (Índice de Qualidade) por safra ──────────────────────────────────────
// Regra TIM: a safra é o mês do Gross + os 4 meses seguintes (5 meses no total).
// Um cliente conta como "dentro do IQ" se, na data de referência (o último dia
// do 5º mês da safra — ou hoje, se a safra ainda não fechou, para dar uma
// prévia), nenhuma fatura dele com vencimento dentro da janela da safra estiver
// com mais de 30 dias de atraso. Usa a data de pagamento quando existe (e é
// anterior à referência); senão, conta os dias até a própria data de
// referência, tratando a fatura como ainda em aberto naquele momento.

// Janela (5 meses) + data de referência de uma safra. Usado tanto pelo
// cálculo agregado (calcularIQSafra) quanto pelo filtro por cliente
// (aplicarFiltros) — cache simples por safra evita recalcular a mesma janela
// várias vezes num loop sobre a lista de clientes.
function referenciaSafra(safra) {
  const janela = safraParaMeses(safra);
  const janelaSet = new Set(janela);
  const [mmUlt, yyyyUlt] = janela[janela.length - 1].split('/').map(Number);
  const dataCorte = new Date(yyyyUlt, mmUlt, 0); // último dia do 5º mês da safra
  const hoje = new Date();
  const previa = hoje < dataCorte;
  const dataReferencia = previa ? hoje : dataCorte;
  return { janela, janelaSet, dataCorte, dataReferencia, previa };
}

function criarCacheReferenciaSafra() {
  const cache = new Map();
  return safra => {
    if (!safra) return null;
    if (!cache.has(safra)) cache.set(safra, referenciaSafra(safra));
    return cache.get(safra);
  };
}

// Fechamento oficial da TIM (planilha "Cesta de Qualidade") pra uma safra —
// null se a TIM ainda não fechou/enviou essa safra. Quando existe, é a
// verdade absoluta (pega downgrade, recompra, suspensão e fraude que a Sonar
// não informa); sem ela, caímos na estimativa por atraso (clienteForaDoIQ).
function carregarCestaOficialPorSafra(safra) {
  const todos = lerJSON(CESTA_OFICIAL_PATH, []);
  const mapa = {};
  todos.forEach(r => { if (r.mesGross === safra) mapa[r.os] = r; });
  return Object.keys(mapa).length ? mapa : null;
}

function criarCacheCestaOficial() {
  const cache = new Map();
  return safra => {
    if (!safra) return null;
    if (!cache.has(safra)) cache.set(safra, carregarCestaOficialPorSafra(safra));
    return cache.get(safra);
  };
}

// true se o cliente está fora da qualidade/IQ da safra. Usa o fechamento
// oficial da TIM quando disponível pra essa safra (ver carregarCestaOficialPorSafra);
// senão cai na estimativa por atraso — a MESMA regra usada no card do IQ e no
// filtro "Dentro/Fora do IQ" da tabela, pra nunca divergirem entre si.
function clienteForaDoIQ(cliente, janelaSet, dataReferencia, oficialPorOS) {
  if (oficialPorOS && oficialPorOS[cliente.os]) return !oficialPorOS[cliente.os].eleg;

  const faturasNaJanela = (cliente.faturas || [])
    .filter(f => janelaSet.has(normalizarMes(f.mesVencimento || '')));
  return faturasNaJanela.some(f => {
    // Churn na janela da safra tira o cliente da qualidade, independente de pagamento.
    if (f.churn === 'Sim') return true;
    // Fatura marcada manualmente como paga (Base Pagos) conta como em dia,
    // mesmo sem dataPagamento preenchida — mesmo criterio do status geral.
    if (f.pagoManual) return false;
    const venc = parseDataBr(f.dataVencimento);
    if (!venc || venc > dataReferencia) return false; // ainda não venceu até a referência
    const pago = parseDataBr(f.dataPagamento);
    const fimContagem = (pago && pago <= dataReferencia) ? pago : dataReferencia;
    const dias = Math.round((fimContagem - venc) / 86400000);
    return dias > 30;
  });
}

function calcularIQSafra(safra) {
  const { janela, janelaSet, dataCorte, dataReferencia, previa } = referenciaSafra(safra);

  const todos = lerJSON(BASE_CRUZADA_PATH, []);
  const oficialPorOS = carregarCestaOficialPorSafra(safra);

  let cohort;
  if (oficialPorOS) {
    // Fechamento oficial da TIM já chegou pra essa safra — ele é quem manda quem
    // entra na conta, não a nossa aproximação por fatura (pega cliente suspenso
    // por fraude/downgrade/recompra que às vezes nem gera fatura na Sonar).
    cohort = todos.filter(c => oficialPorOS[c.os]);
  } else {
    // Sem fechamento oficial ainda: prévia por atraso. totalFaturas > 0 exclui
    // clientes importados que ainda não têm nenhuma fatura no Sonar (ver
    // cruzarBases) — sem essa trava eles passariam trivialmente no IQ (não há
    // como estar em atraso sem fatura nenhuma) e inflariam o percentual com
    // quem nem começou a ser cobrado ainda.
    cohort = todos.filter(c => c.mesGross === safra && c.totalFaturas > 0);
  }

  const ok = [], atrasados = [];
  for (const c of cohort) {
    (clienteForaDoIQ(c, janelaSet, dataReferencia, oficialPorOS) ? atrasados : ok).push(c);
  }

  const fmtData = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

  return {
    safra,
    janela,
    dataCorte: fmtData(dataCorte),
    dataReferencia: fmtData(dataReferencia),
    previa,
    oficial: !!oficialPorOS,
    totalClientes: cohort.length,
    clientesOk: ok.length,
    percentual: cohort.length ? Math.round((ok.length / cohort.length) * 1000) / 10 : null,
    _ok: ok.map(c => ({ nome: c.nome, custcode: c.custcode, motivo: oficialPorOS?.[c.os]?.motivo || null })),
    _atrasados: atrasados.map(c => ({ nome: c.nome, custcode: c.custcode, motivo: oficialPorOS?.[c.os]?.motivo || null })),
  };
}

app.get('/api/iq-safra', (req, res) => {
  try {
    const { safra } = req.query;
    if (!safra || !/^\d{2}\/\d{4}$/.test(safra)) {
      return res.status(400).json({ erro: 'Informe a safra no formato MM/YYYY' });
    }
    const resultado = calcularIQSafra(safra);
    if (req.query.detalhe !== '1') { delete resultado._ok; delete resultado._atrasados; }
    res.json(resultado);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

function aplicarFiltros(lista, q) {
  let l = lista;
  if (q.safra)         l = l.filter(c => safraParaMeses(q.safra).includes(c.mesGross));
  if (q.dataVencimento) l = l.filter(c => {
    const faturas = (c.faturas || []).filter(f => f.dataVencimento);
    if (!faturas.length) return false;
    const ultima = faturas[faturas.length - 1];
    // Última fatura deve ter a data selecionada e estar INADIMPLENTE
    if (ultima.dataVencimento !== q.dataVencimento) return false;
    if (ultima.status !== 'INADIMPLENTE') return false;
    // Todas as faturas anteriores devem estar ADIMPLENTES
    const anteriores = faturas.slice(0, -1);
    return anteriores.every(f => f.status === 'ADIMPLENTE');
  });
  if (q.mesGross) l = l.filter(c => c.mesGross === q.mesGross);
  if (q.estado)   l = l.filter(c => q.estado.split(',').includes(c.uf));
  if (q.uf)       l = l.filter(c => c.uf === q.uf);
  if (q.vendedor) l = l.filter(c => c.vendedor === q.vendedor);
  if (q.status)   l = l.filter(c => q.status.split(',').includes(c.status));
  if (q.statusTabela) l = l.filter(c => c.status === q.statusTabela);
  if (q.contatos === '2') l = l.filter(c => (c.contatos?.length || 0) >= 2);
  if (q.contatos === '1') l = l.filter(c => (c.contatos?.length || 0) === 1);
  if (q.churn === '1') l = l.filter(c => c.churn);
  if (q.semMatch === '1') l = l.filter(c => !c.cruzado);
  if (q.pagoManual === '1') l = l.filter(c => (c.faturas || []).some(f => f.pagoManual));
  if (q.iqSafra === 'dentro' || q.iqSafra === 'fora') {
    const getRef = criarCacheReferenciaSafra();
    const getOficial = criarCacheCestaOficial();
    l = l.filter(c => {
      if (!c.mesGross) return false; // sem safra definida, nao entra em nenhum dos dois lados
      const oficialPorOS = getOficial(c.mesGross);
      if (oficialPorOS) {
        // Fechamento oficial da safra existe — mesma regra e mesmo grupo do
        // card do IQ (calcularIQSafra): só entra quem está no fechamento.
        // Cliente com esse mesGross mas fora do arquivo (ex: entrou depois do
        // fechamento) não conta em nenhum dos dois lados, pra tabela e card
        // nunca divergirem.
        if (!oficialPorOS[c.os]) return false;
        const fora = !oficialPorOS[c.os].eleg;
        return q.iqSafra === 'fora' ? fora : !fora;
      }
      // Sem fechamento oficial da safra, só entra quem já tem fatura no Sonar
      // (sem isso não dá pra saber se está ou não em atraso).
      if (!c.totalFaturas) return false;
      const ref = getRef(c.mesGross);
      if (!ref) return false;
      const fora = clienteForaDoIQ(c, ref.janelaSet, ref.dataReferencia);
      return q.iqSafra === 'fora' ? fora : !fora;
    });
  }
  if (q.acionaveis === '1') l = l.filter(c => {
    if (c.churn) return false;
    const atrasos = (c.faturas || []).filter(f => f.status === 'INADIMPLENTE').length;
    return atrasos <= 2;
  });
  // Marcadores de atendimento (anotações). Vários podem ser pedidos ao mesmo
  // tempo — o cliente precisa ter todos os marcadores selecionados.
  const marcadoresPedidos = MARCADORES_VALIDOS.filter(m => q[`marcador_${m}`] === '1');
  if (marcadoresPedidos.length) {
    const anotacoes = lerJSON(ANOTACOES_PATH, {});
    l = l.filter(c => {
      const marcados = anotacoes[c.os]?.marcadores || [];
      return marcadoresPedidos.every(m => marcados.includes(m));
    });
  }
  // Filtros por fatura individual (f1..f5)
  for (let n = 1; n <= 5; n++) {
    const val = q[`f${n}`];
    if (!val) continue;
    if (val === 'SEM') {
      l = l.filter(c => !(c.faturas || []).some(f => f.numero === n));
    } else {
      l = l.filter(c => (c.faturas || []).find(f => f.numero === n)?.status === val);
    }
  }
  return l;
}

// ─── Upload (memória) ─────────────────────────────────────────────────────────

const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── Modelo / Base de Clientes ────────────────────────────────────────────────

app.get('/api/modelo-base-clientes', (req, res) => {
  res.download(path.join(__dirname, 'public', 'modelo-base-clientes.xlsx'), 'modelo-base-clientes.xlsx');
});

// Exporta a base de clientes já cadastrada, no mesmo formato que o import
// espera — permite baixar, só acrescentar as linhas novas (outro mês/safra) e
// subir de novo; o import já mescla por CPF (atualiza quem existe, adiciona
// quem é novo).
app.get('/api/base-clientes/exportar', (req, res) => {
  try {
    const clientes = lerJSON(BASE_CLIENTES_PATH, []);
    // Sem isso, a ordem seria "por quando entrou no sistema" — clientes recém
    // importados ficam no fim da lista independente do mês, dificultando
    // revisar a planilha antes de subir de novo. Quem não tem Mês Gross vai
    // para o final.
    const chaveMes = c => {
      const m = String(c.mesGrossManual || '').match(/^(\d{2})\/(\d{4})$/);
      return m ? (+m[2] * 12 + +m[1]) : Infinity;
    };
    const clientesOrdenados = [...clientes].sort((a, b) => chaveMes(a) - chaveMes(b));
    const headers = ['Vendedor', 'Cliente', 'CPF', 'Contato Principal WhatsApp', 'Contato Responsável', 'Número Ordem/OS', 'Mês Gross'];
    const linhas = [headers, ...clientesOrdenados.map(c => [
      c.vendedor || '', c.nome || '', c.cpf || '',
      c.contatoPrincipal || '', c.contatoResponsavel || '',
      c.os || '', c.mesGrossManual || '',
    ])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Clientes');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Disposition', 'attachment; filename="base-clientes.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Limpar Base Clientes ─────────────────────────────────────────────────────

app.delete('/api/limpar-base-clientes', (req, res) => {
  salvarJSON(BASE_CLIENTES_PATH, []);
  salvarJSON(BASE_CRUZADA_PATH, []);
  const meta = lerJSON(SONAR_META_PATH, {});
  delete meta.clientes;
  salvarJSON(SONAR_META_PATH, meta);
  res.json({ ok: true });
});

// Remove um único cliente da Base de Clientes por OS — útil pra limpar
// entradas erradas (ex: linha digitada com as colunas trocadas na planilha)
// sem precisar apagar a base inteira.
app.delete('/api/base-clientes/:os', (req, res) => {
  const os = req.params.os;
  const clientes = lerJSON(BASE_CLIENTES_PATH, []);
  const restantes = clientes.filter(c => c.os !== os);
  if (restantes.length === clientes.length) return res.status(404).json({ erro: 'Nenhum cliente com essa OS' });

  salvarJSON(BASE_CLIENTES_PATH, restantes);
  const baseCruzada = cruzarBases();
  res.json({ ok: true, removidos: clientes.length - restantes.length, total: baseCruzada.length });
});

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
        mesGrossManual: converterDataParaMesAno(String(row[6] || '').trim()),
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

    // Mescla com base existente por CPF — atualiza quem já existe, adiciona quem é novo
    const baseExistente = lerJSON(BASE_CLIENTES_PATH, []);
    const mapaExistente = {};
    baseExistente.forEach(c => { if (c.cpf) mapaExistente[c.cpf] = c; });
    let adicionados = 0, atualizados = 0;
    clientes.forEach(novo => {
      if (novo.cpf && mapaExistente[novo.cpf]) {
        mapaExistente[novo.cpf] = { ...mapaExistente[novo.cpf], ...novo };
        atualizados++;
      } else {
        mapaExistente[novo.cpf || novo.os] = novo;
        adicionados++;
      }
    });
    const clientesMesclados = Object.values(mapaExistente);

    salvarJSON(BASE_CLIENTES_PATH, clientesMesclados);
    const meta = lerJSON(SONAR_META_PATH, {});
    if (!meta.clientes) meta.clientes = {};
    meta.clientes.total = clientesMesclados.length;
    meta.clientes.importadoEm = new Date().toISOString();
    salvarJSON(SONAR_META_PATH, meta);

    const baseCruzada = cruzarBases();
    res.json({ ok: true, total: clientesMesclados.length, adicionados, atualizados, cruzados: baseCruzada.filter(c => c.cruzado).length, warnings });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── Importar Sonar CSV ───────────────────────────────────────────────────────

app.post('/api/importar-sonar', uploadMemory.single('arquivo'), (req, res) => {
  const estado = (req.query.estado || '').toUpperCase();
  if (!ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ erro: 'Estado inválido. Use PR, SC ou RS' });
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  try {
    const mime = req.file.mimetype || '';
    const nome = req.file.originalname || '';
    const isXlsx = nome.endsWith('.xlsx') || nome.endsWith('.xls') || mime.includes('spreadsheet') || mime.includes('excel');

    let registros;
    if (isXlsx) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true, cellNF: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      registros = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
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
      mesGross: normalizarMes(r['MÊS GROSS']),
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

// ─── Importar Fechamento Oficial (Cesta de Qualidade da TIM) ─────────────────
// Planilha mensal que a TIM manda com o fechamento oficial do IQ por safra —
// tem eventos que a Sonar não informa (downgrade, recompra, suspensão comum e
// por fraude). Quando existe fechamento pra uma safra, ele vira a fonte de
// verdade do IQ daquela safra (ver calcularIQSafra); sem ele, a gente usa a
// prévia por atraso, igual já era.

app.post('/api/importar-cesta-oficial', uploadMemory.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const registros = XLSX.utils.sheet_to_json(ws, { defval: '' });

    const processados = registros.map(r => ({
      os: String(r['COD_ORDEM_SIEBEL'] || '').trim(),
      mesGross: normalizarMes(r['MES_GROSS_SIEBEL']),
      eleg: String(r['FL_ELEG_CESTA_QUAL']).trim() === '1',
      motivo: r['1o_EVENTO_NAO_QUALIDADE_GROSS'] || null,
    })).filter(r => r.os && r.mesGross);

    if (!processados.length) return res.status(400).json({ erro: 'Nenhum registro válido encontrado (confira as colunas COD_ORDEM_SIEBEL / MES_GROSS_SIEBEL)' });

    const safrasNoArquivo = [...new Set(processados.map(r => r.mesGross))];

    // Substitui por safra — permite reimportar/corrigir um fechamento sem duplicar.
    const existente = lerJSON(CESTA_OFICIAL_PATH, []);
    const mantidos = existente.filter(r => !safrasNoArquivo.includes(r.mesGross));
    salvarJSON(CESTA_OFICIAL_PATH, [...mantidos, ...processados]);

    res.json({ ok: true, total: processados.length, safras: safrasNoArquivo });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── Status de importação ─────────────────────────────────────────────────────

function parseDataBr(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [, dd, mm, yyyy] = m;
  if (yyyy.length === 2) yyyy = '20' + yyyy;
  const d = new Date(+yyyy, +mm - 1, +dd);
  return isNaN(d.getTime()) ? null : d;
}

function ultimaAtualizacaoBase(estado) {
  const registros = lerJSON(BASE_SONAR[estado], []);
  let max = null;
  registros.forEach(r => {
    const d = parseDataBr(r.ultimaAtualizacao);
    if (d && (!max || d > max)) max = d;
  });
  return max ? `${String(max.getDate()).padStart(2,'0')}/${String(max.getMonth()+1).padStart(2,'0')}/${max.getFullYear()}` : null;
}

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
    // "Cruzamento" descreve especificamente faturas do Sonar × cliente — os
    // clientes importados sem fatura ainda (ver cruzarBases) não fazem parte
    // dessa conta nem de nenhum dos dois lados, senão o indicador passaria a
    // mentir sobre o que de fato representa.
    const baseSonar = baseCruzada.filter(c => c.totalFaturas > 0);
    res.json({
      clientes: {
        total: meta.clientes?.total || 0,
        importadoEm: meta.clientes?.importadoEm || null,
        status: statusImport(meta.clientes?.importadoEm),
      },
      sonar: {
        PR: { total: meta.sonar?.PR?.total || 0, importadoEm: meta.sonar?.PR?.importadoEm || null, status: statusImport(meta.sonar?.PR?.importadoEm), ultimaAtualizacaoBase: ultimaAtualizacaoBase('PR') },
        SC: { total: meta.sonar?.SC?.total || 0, importadoEm: meta.sonar?.SC?.importadoEm || null, status: statusImport(meta.sonar?.SC?.importadoEm), ultimaAtualizacaoBase: ultimaAtualizacaoBase('SC') },
        RS: { total: meta.sonar?.RS?.total || 0, importadoEm: meta.sonar?.RS?.importadoEm || null, status: statusImport(meta.sonar?.RS?.importadoEm), ultimaAtualizacaoBase: ultimaAtualizacaoBase('RS') },
      },
      cruzamento: {
        total: baseSonar.length,
        cruzados: baseSonar.filter(c => c.cruzado).length,
        semMatch: baseSonar.filter(c => !c.cruzado).length,
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

    const churn = f.filter(c => c.churn).length;
    const com2Contatos = f.filter(c => (c.contatos?.length || 0) >= 2).length;
    const soSoPrincipal = f.filter(c => (c.contatos?.length || 0) === 1).length;
    const semCruzamento = f.filter(c => !c.cruzado).length;
    const totalFaturasPdf = fs.existsSync(PDFS_PATH) ? fs.readdirSync(PDFS_PATH).filter(f => f.endsWith('.pdf')).length : 0;

    // Métricas por número de fatura (F1 a F10)
    const faturaStats = {};
    for (let n = 1; n <= 10; n++) {
      const comFatura = f.filter(c => c.faturas?.some(fat => fat.numero === n));
      if (!comFatura.length) continue;
      const pagas = comFatura.filter(c => c.faturas.find(fat => fat.numero === n)?.status === 'ADIMPLENTE').length;
      // Fatura N% mantém o critério de antes: PAGO_ATRASO conta como não-paga
      // aqui (mesmo já tendo sido quitada), só a Tabela de Clientes mudou a
      // exibição — este indicador continua igual ao que já era.
      const naoPagas = comFatura.filter(c => ['INADIMPLENTE', 'PAGO_ATRASO'].includes(c.faturas.find(fat => fat.numero === n)?.status)).length;
      faturaStats[`f${n}`] = { total: comFatura.length, pagas, naoPagas, pct: +(pagas / comFatura.length * 100).toFixed(1) };
    }

    const inadimplentes = f.filter(c => c.status === 'INADIMPLENTE' && !c.churn).length;
    // PAGO_ATRASO conta como adimplente aqui — já foi pago, só que fora do prazo.
    const adimplentes = f.filter(c => (c.status === 'ADIMPLENTE' || c.status === 'PAGO_ATRASO') && !c.churn).length;

    // IQ da safra selecionada no filtro "Mês Gross" do topo (card ao lado de
    // Fatura 1). Sem um mês especifico escolhido não há uma janela única de
    // 5 meses para calcular, então fica null. As listas de detalhe (_ok/
    // _atrasados) não interessam aqui — só ao endpoint /api/iq-safra.
    let iqSafra = null;
    if (req.query.mesGross) {
      iqSafra = calcularIQSafra(req.query.mesGross);
      delete iqSafra._ok;
      delete iqSafra._atrasados;
    }

    res.json({
      total, adimplentes, inadimplentes, churn,
      com2Contatos, soSoPrincipal, semCruzamento, totalFaturasPdf,
      pctAdimplentes: total > 0 ? +(adimplentes / total * 100).toFixed(1) : 0,
      pctInadimplentes: total > 0 ? +(inadimplentes / total * 100).toFixed(1) : 0,
      faturaStats,
      iqSafra,
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
    const pagina_ = lista.slice((pagina - 1) * porPagina, pagina * porPagina);

    // Anexa os marcadores só da página atual, para a tabela mostrar o indicador
    // sem precisar consultar cliente por cliente.
    const anotacoes = lerJSON(ANOTACOES_PATH, {});
    const dados = pagina_.map(c => ({
      ...c,
      marcadores: anotacoes[c.os]?.marcadores || [],
      totalAnotacoes: (anotacoes[c.os]?.anotacoes || []).length,
    }));

    res.json({ total, pagina, porPagina, totalPaginas: Math.ceil(total / porPagina) || 1, dados });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Anotações de atendimento ────────────────────────────────────────────────

app.get('/api/clientes/anotacoes/:os', (req, res) => {
  const dados = lerJSON(ANOTACOES_PATH, {});
  const item = dados[req.params.os] || { marcadores: [], anotacoes: [] };
  res.json(item);
});

app.post('/api/clientes/anotacoes/:os', (req, res) => {
  const { texto, marcadores } = req.body || {};
  const os = req.params.os;
  if (!os) return res.status(400).json({ erro: 'OS obrigatória' });

  const dados = lerJSON(ANOTACOES_PATH, {});
  const atual = dados[os] || { marcadores: [], anotacoes: [] };

  if (Array.isArray(marcadores)) {
    atual.marcadores = marcadores.filter(m => MARCADORES_VALIDOS.includes(m));
  }

  const limpo = String(texto || '').trim();
  if (limpo) {
    atual.anotacoes.push({
      texto: limpo,
      autor: req.session?.usuario?.nome || 'Sistema',
      criadoEm: new Date().toISOString(),
    });
  }

  atual.atualizadoEm = new Date().toISOString();
  dados[os] = atual;
  salvarJSON(ANOTACOES_PATH, dados);
  res.json({ ok: true, ...atual });
});

app.delete('/api/clientes/anotacoes/:os/:indice', (req, res) => {
  const dados = lerJSON(ANOTACOES_PATH, {});
  const atual = dados[req.params.os];
  if (!atual) return res.status(404).json({ erro: 'Não encontrado' });

  const i = parseInt(req.params.indice);
  if (isNaN(i) || i < 0 || i >= atual.anotacoes.length) return res.status(400).json({ erro: 'Índice inválido' });

  atual.anotacoes.splice(i, 1);
  salvarJSON(ANOTACOES_PATH, dados);
  res.json({ ok: true, ...atual });
});

app.get('/api/clientes/exportar', (req, res) => {
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
    // Descobre max faturas
    const maxF = Math.max(0, ...lista.map(c => c.totalFaturas || 0));
    const fHeaders = Array.from({length: maxF}, (_, i) => [`F${i+1} Status`, `F${i+1} Vencimento`, `F${i+1} Pagamento`]).flat();
    const headers = ['Cliente', 'CPF', 'Contato 1', 'Contato 2', 'CustCode', 'OS', 'Vendedor', 'UF', 'Mês Gross', 'Total Faturas', 'Faturas Pagas', 'Status', 'Churn', ...fHeaders];
    const linhas = lista.map(c => {
      const base = [c.nome||'', c.cpf||'', c.contatoPrincipal||'', c.contatoResponsavel||'', c.custcode||'', c.os||'', c.vendedor||'', c.uf||'', c.mesGross||'', c.totalFaturas||0, c.faturasPagas||0, c.status||'', c.churn ? 'Sim' : 'Não'];
      const fCols = Array.from({length: maxF}, (_, i) => {
        const fat = (c.faturas||[]).find(f => f.numero === i+1);
        return fat ? [fat.status||'', fat.dataVencimento||'', fat.dataPagamento||''] : ['','',''];
      }).flat();
      return [...base, ...fCols];
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...linhas]), 'Clientes');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Recebe a "Base Pagos" (.xlsx com Custcode/CPF + Vencimento N) e marca como pagas
// (amarelo/manual) as faturas EXISTENTES cujo vencimento consta na planilha.
// Persiste em pagos-manuais.json e recruza para aplicar na hora.
app.post('/api/clientes/base-pagos', uploadMemory.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (!rows.length) return res.status(400).json({ erro: 'Planilha vazia' });

    const cols = Object.keys(rows[0]);
    const colCust = cols.find(c => /custcode/i.test(c));
    const colCpf = cols.find(c => /cpf/i.test(c));
    const colsVenc = cols.filter(c => /^vencimento\s*\d+$/i.test(c) || /vencimento/i.test(c));
    if (!colCust && !colCpf) return res.status(400).json({ erro: 'Planilha sem coluna Custcode/CPF' });
    if (!colsVenc.length) return res.status(400).json({ erro: 'Planilha sem coluna de Vencimento' });

    // Índice das faturas atuais por cliente (para só marcar vencimentos que existem)
    const base = lerJSON(BASE_CRUZADA_PATH, []);
    const porCust = new Map(), porCpf = new Map();
    for (const c of base) {
      const vencs = new Set((c.faturas || []).map(f => String(f.dataVencimento || '').trim()).filter(Boolean));
      if (soDigitos(c.custcode)) porCust.set(soDigitos(c.custcode), vencs);
      if (soDigitos(c.cpf)) porCpf.set(soDigitos(c.cpf), vencs);
    }

    const pagos = lerJSON(PAGOS_MANUAIS_PATH, {});
    let clientesAfetados = 0, faturasMarcadas = 0, vencIgnorados = 0, semCliente = 0;
    for (const r of rows) {
      const cust = soDigitos(r[colCust]);
      const cpf = colCpf ? soDigitos(r[colCpf]) : '';
      const vencsCliente = porCust.get(cust) || porCpf.get(cpf);
      if (!vencsCliente) { semCliente++; continue; }
      const marcar = [];
      for (const cv of colsVenc) {
        const v = String(r[cv] || '').trim();
        if (!v) continue;
        if (vencsCliente.has(v)) marcar.push(v); else vencIgnorados++;
      }
      if (!marcar.length) continue;
      const chave = cust || cpf;
      if (!pagos[chave]) pagos[chave] = { cpf: r[colCpf] || '', vencimentos: [] };
      const set = new Set([...pagos[chave].vencimentos, ...marcar]);
      const antes = pagos[chave].vencimentos.length;
      pagos[chave].vencimentos = [...set];
      faturasMarcadas += pagos[chave].vencimentos.length - antes;
      clientesAfetados++;
    }

    salvarJSON(PAGOS_MANUAIS_PATH, pagos);
    cruzarBases(); // aplica na base cruzada imediatamente

    res.json({ ok: true, clientesAfetados, faturasMarcadas, vencIgnorados, semCliente });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Quantidade de clientes/faturas atualmente marcados via "Base Pagos" (para o
// contador ao lado do botão).
app.get('/api/clientes/base-pagos/status', (req, res) => {
  try {
    const pagos = lerJSON(PAGOS_MANUAIS_PATH, {});
    const totalClientes = Object.keys(pagos).length;
    const totalFaturas = Object.values(pagos)
      .reduce((soma, p) => soma + (p.vencimentos || []).length, 0);
    res.json({ totalClientes, totalFaturas });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Desmarca UM vencimento de UM cliente (engano pontual na Base Pagos).
// A fatura volta a valer o status real vindo do Sonar no proximo cruzamento.
app.post('/api/clientes/base-pagos/desmarcar', (req, res) => {
  try {
    const { custcode, cpf, vencimento } = req.body || {};
    if (!vencimento) return res.status(400).json({ erro: 'Vencimento não informado' });

    const pagos = lerJSON(PAGOS_MANUAIS_PATH, {});
    const cust = soDigitos(custcode);
    let chave = cust && pagos[cust] ? cust : null;
    if (!chave && cpf) {
      const cpfNorm = soDigitos(cpf);
      chave = Object.keys(pagos).find(k => soDigitos(pagos[k].cpf) === cpfNorm) || null;
    }
    if (!chave) return res.status(404).json({ erro: 'Cliente não encontrado na Base Pagos' });

    const antes = pagos[chave].vencimentos.length;
    pagos[chave].vencimentos = pagos[chave].vencimentos.filter(v => String(v).trim() !== String(vencimento).trim());
    if (pagos[chave].vencimentos.length === antes) {
      return res.status(404).json({ erro: 'Vencimento não estava marcado' });
    }
    if (!pagos[chave].vencimentos.length) delete pagos[chave]; // sem faturas restantes: remove o cliente

    salvarJSON(PAGOS_MANUAIS_PATH, pagos);
    cruzarBases();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Remove TODAS as marcacoes manuais da Base Pagos (reset completo).
app.delete('/api/clientes/base-pagos', (req, res) => {
  try {
    salvarJSON(PAGOS_MANUAIS_PATH, {});
    cruzarBases();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Filtros/Opções ───────────────────────────────────────────────────────────

app.get('/api/filtros/opcoes', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    const mesesGross = [...new Set(todos.map(c => c.mesGross).filter(Boolean))].sort();
    // Com um Mês Gross selecionado, a lista de vendedores só traz quem teve
    // venda naquele mês — pra casar com quem realmente aparece na Tabela de
    // Clientes filtrada, em vez de listar todo mundo da base inteira.
    const baseVendedores = req.query.mesGross ? todos.filter(c => c.mesGross === req.query.mesGross) : todos;
    const vendedores = [...new Set(baseVendedores.map(c => c.vendedor).filter(Boolean))].sort();
    const estados = [...new Set(todos.map(c => c.uf).filter(Boolean))].sort();
    const safras = mesesGross;
    const datasVencimento = [...new Set(
      todos.flatMap(c => (c.faturas || []).map(f => f.dataVencimento).filter(Boolean))
    )].sort((a, b) => {
      const [da, ma, ya] = a.split('/').map(Number);
      const [db, mb, yb] = b.split('/').map(Number);
      return new Date(ya, ma-1, da) - new Date(yb, mb-1, db);
    });
    res.json({ mesesGross, vendedores, estados, safras, datasVencimento });
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
    const adimplentes = f.filter(c => (c.status === 'ADIMPLENTE' || c.status === 'PAGO_ATRASO') && !c.churn).length;
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
      adimplentes: meses.map(m => f.filter(c => c.mesGross === m && (c.status === 'ADIMPLENTE' || c.status === 'PAGO_ATRASO')).length),
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

app.get('/api/ajustes/todos', (req, res) => {
  try {
    const baseCruzada = lerJSON(BASE_CRUZADA_PATH, []);
    const clientes = baseCruzada.filter(c => !c.cruzado);
    res.json({ total: clientes.length, clientes });
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

// Corrigir qualquer campo de um cliente sem match (cria/atualiza na base de clientes)
app.post('/api/ajustes/corrigir-cliente', (req, res) => {
  try {
    const { osAtual, nome, cpf, contatoPrincipal, contatoResponsavel, mesGross, vendedor } = req.body;
    if (!osAtual) return res.status(400).json({ erro: 'osAtual é obrigatório' });

    const clientes = lerJSON(BASE_CLIENTES_PATH, []);
    // Tenta localizar pelo OS original (sem match não tem cpf/nome na base)
    const idx = clientes.findIndex(c => c.os === osAtual);
    // vendedor só é sobrescrito se vier no payload (a tela de Ajustes não manda
    // esse campo) — sem isso, salvar por lá apagaria o vendedor já cadastrado.
    const vendedorAtual = idx >= 0 ? (clientes[idx].vendedor || '') : '';
    const entrada = {
      os: osAtual,
      nome: (nome || '').trim(),
      cpf: (cpf || '').trim(),
      contatoPrincipal: limparTelefone(contatoPrincipal),
      contatoResponsavel: limparTelefone(contatoResponsavel) || null,
      mesGrossManual: converterDataParaMesAno((mesGross || '').trim()),
      vendedor: vendedor !== undefined ? String(vendedor).trim() : vendedorAtual,
    };
    if (idx >= 0) clientes[idx] = { ...clientes[idx], ...entrada };
    else clientes.push(entrada);
    salvarJSON(BASE_CLIENTES_PATH, clientes);

    const baseCruzada = cruzarBases();
    const cruzado = baseCruzada.find(c => c.os === osAtual);
    res.json({ ok: true, cruzado: cruzado?.cruzado || false });
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

// ─── Gerar fila do robô a partir dos filtros atuais ──────────────────────────

// Retorna os clientes filtrados como JSON (chamado pelo VPS, usado pelo browser)
app.get('/api/gerar-fila-dados', (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    let lista = aplicarFiltros(todos, req.query);
    if (req.query.busca) {
      const b = req.query.busca.toLowerCase();
      lista = lista.filter(c =>
        (c.nome || '').toLowerCase().includes(b) ||
        (c.cpf || '').includes(b) ||
        (c.os || '').includes(b)
      );
    }
    lista = lista.filter(c => c.os && c.nome && c.custcode);
    const clientes = lista.map(c => ({
      nome: c.nome || '',
      cpf: c.cpf || '',
      custcode: c.custcode || '',
      contato: c.contatoPrincipal || '',
      mesGross: c.mesGross || c.mesGrossManual || '',
    }));
    res.json({ total: clientes.length, clientes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Recebe clientes do browser (vindos do VPS), gera clientes.xlsx e reseta fila
app.post('/api/receber-fila', apenasLocal, (req, res) => {
  try {
    const { clientes } = req.body;
    if (!Array.isArray(clientes)) return res.status(400).json({ erro: 'clientes inválido' });
    // Formato que o robo-estado.js espera: col0=Nome, col1=CPF, col2=Custcode, col3=Contato.
    // Col4 "Mês Gross" é extra (o robô ignora, mas o relatório usa como referência).
    const headers = ['Nome', 'CPF', 'Custcode', 'Contato', 'Mês Gross'];
    const linhas = clientes.map(c => [c.nome, c.cpf, c.custcode, c.contato, c.mesGross || c.mesGrossManual || '']);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...linhas]), 'Base Clientes');
    const destino = path.join(PLAYWRIGHT_PATH, 'clientes.xlsx');
    XLSX.writeFile(wb, destino);
    const filaPath = path.join(PLAYWRIGHT_PATH, 'fila_clientes.json');
    try { fs.unlinkSync(filaPath); } catch {}
    res.json({ ok: true, total: clientes.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/gerar-fila-robo', apenasLocal, (req, res) => {
  try {
    const todos = lerJSON(BASE_CRUZADA_PATH, []);
    let lista = aplicarFiltros(todos, req.body || {});
    if (req.body?.busca) {
      const b = req.body.busca.toLowerCase();
      lista = lista.filter(c =>
        (c.nome || '').toLowerCase().includes(b) ||
        (c.cpf || '').includes(b) ||
        (c.os || '').includes(b)
      );
    }
    // Remove sem custcode/nome (sem esses dados o robô não consegue processar)
    lista = lista.filter(c => c.custcode && c.nome);

    // Formato que o robo-estado.js espera: col0=Nome, col1=CPF, col2=Custcode, col3=Contato.
    // Col4 "Mês Gross" é extra (o robô ignora, mas o relatório usa como referência).
    const headers = ['Nome', 'CPF', 'Custcode', 'Contato', 'Mês Gross'];
    const linhas = lista.map(c => [
      c.nome || '',
      c.cpf || '',
      c.custcode || '',
      c.contatoPrincipal || '',
      c.mesGross || c.mesGrossManual || '',
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...linhas]), 'Base Clientes');
    const destino = path.join(PLAYWRIGHT_PATH, 'clientes.xlsx');
    XLSX.writeFile(wb, destino);

    // Reseta fila para que o robô recomece do zero
    const filaPath = path.join(PLAYWRIGHT_PATH, 'fila_clientes.json');
    try { fs.unlinkSync(filaPath); } catch {}

    res.json({ ok: true, total: lista.length, arquivo: destino });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Status da Fila do Robô ───────────────────────────────────────────────────

app.get('/api/fila-status', apenasLocal, (req, res) => {
  try {
    const filaPath = path.join(PLAYWRIGHT_PATH, 'fila_clientes.json');
    const excelPath = path.join(PLAYWRIGHT_PATH, process.env.ARQUIVO_CLIENTES || 'clientes.xlsx');
    const fila = lerJSON(filaPath, { proximoIndice: 0 });
    let total = 0;
    if (fs.existsSync(excelPath)) {
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      total = rows.slice(1).filter(r => String(r[1] || '').trim()).length;
    }
    const processados = Math.min(fila.proximoIndice || 0, total);
    const pendentes = Math.max(0, total - processados);
    res.json({ total, processados, pendentes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

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
  ESTADOS_VALIDOS.forEach(e => { status[e] = processoEstado[e] ? 'rodando' : 'parado'; });
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
  if (!estado || !ESTADOS_VALIDOS.includes(estado)) return res.status(400).json({ erro: 'Estado inválido' });
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
    salvarHistoricoRobo(estado);
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

// Reconstrói a fila de reprocessamento com os erros atuais (para os robôs pegarem ao iniciar)
app.post('/api/comando/reprocessar-erros', apenasLocal, (req, res) => {
  try {
    const { reconstruirFilaErros } = require(path.join(PLAYWRIGHT_PATH, 'utils', 'filaErros'));
    const planilha = path.join(PLAYWRIGHT_PATH, 'clientes.xlsx');
    if (!fs.existsSync(planilha)) return res.status(400).json({ erro: 'clientes.xlsx não encontrado' });
    const mtime = String(fs.statSync(planilha).mtimeMs);
    Promise.resolve(reconstruirFilaErros(mtime)).then(fila => {
      emitirEvento('robo-estado', { msg: `🔄 Fila de reprocessamento criada: ${fila.clientes.length} erro(s). Inicie os robôs para reprocessar.`, status: 'parado' });
      res.json({ ok: true, total: fila.clientes.length });
    }).catch(err => res.status(500).json({ erro: err.message }));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Baixa uma planilha só com os clientes que continuam com erro
app.get('/api/comando/planilha-erros', (req, res) => {
  try {
    const { coletarErros } = require(path.join(PLAYWRIGHT_PATH, 'utils', 'filaErros'));
    const resultados = [];
    for (const est of ESTADOS_VALIDOS) {
      const arq = path.join(PLAYWRIGHT_PATH, `progresso_${est}.json`);
      if (!fs.existsSync(arq)) continue;
      try {
        const p = JSON.parse(fs.readFileSync(arq, 'utf8'));
        for (const r of (p.resultados || [])) resultados.push({ ...r, robo: est });
      } catch {}
    }
    // Aplica reprocessamento (erro recuperado não aparece)
    try {
      const rp = JSON.parse(fs.readFileSync(path.join(PLAYWRIGHT_PATH, 'reprocessamento.json'), 'utf8'));
      for (const r of (rp.resultados || [])) {
        const idx = resultados.findIndex(x => String(x.custcode) === String(r.custcode));
        if (idx !== -1) resultados[idx] = { ...r, robo: r.robo };
        else resultados.push(r);
      }
    } catch {}

    const erros = resultados.filter(r => {
      const s = r.status || '';
      return s.startsWith('Erro') || s === 'Cliente não encontrado' || s === 'Custcode inválido';
    });

    const headers = ['Robô', 'Nome', 'CPF', 'Custcode', 'Contato', 'Status'];
    const linhas = [headers];
    for (const r of erros) linhas.push([r.robo || '', r.nome, r.cpf, r.custcode, r.contato, r.status || 'Erro']);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Erros');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const ts = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    res.setHeader('Content-Disposition', `attachment; filename="ERROS_${ts}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Gera uma base SÓ com os clientes reprocessados com sucesso (para disparo isolado)
app.post('/api/comando/base-reprocessados', apenasLocal, (req, res) => {
  try {
    let reproc;
    try { reproc = JSON.parse(fs.readFileSync(path.join(PLAYWRIGHT_PATH, 'reprocessamento.json'), 'utf8')); }
    catch { return res.status(400).json({ erro: 'Nenhum reprocessamento encontrado' }); }

    const okStatus = s => String(s || '').startsWith('Sucesso');
    const resultados = (reproc.resultados || []).filter(r => okStatus(r.status));
    if (resultados.length === 0) return res.status(404).json({ erro: 'Nenhum reprocessado com sucesso ainda' });

    const maxFat = Math.max(...resultados.map(r => (r.numerosFaturas || []).length), 1);
    const headers = ['Robô', 'Nome', 'CPF', 'Custcode', 'Contato', 'Faturas Baixadas'];
    for (let i = 1; i <= maxFat; i++) headers.push(`Número ${i}`, `Valor ${i}`, `Vencimento ${i}`);
    headers.push('Status');

    const linhas = [headers];
    for (const r of resultados) {
      const row = [r.robo || '', r.nome, r.cpf, r.custcode, r.contato, r.faturasBaixadas || 0];
      for (let i = 0; i < maxFat; i++) {
        row.push((r.numerosFaturas || [])[i] || '');
        row.push((r.valores || [])[i] || '');
        row.push((r.vencimentos || [])[i] || '');
      }
      row.push(r.status || '');
      linhas.push(row);
    }

    const data = new Date().toISOString().split('T')[0];
    const hora = new Date().toTimeString().slice(0, 5).replace(':', '-');
    const nome = `relatorio_${data}_${hora}_REPROCESSADOS.xlsx`;
    if (!fs.existsSync(RELATORIOS_PATH)) fs.mkdirSync(RELATORIOS_PATH, { recursive: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Relatório');
    XLSX.writeFile(wb, path.join(RELATORIOS_PATH, nome));

    emitirEvento('robo-estado', { msg: `📤 Base dos reprocessados gerada: ${resultados.length} cliente(s) — ${nome}`, status: 'parado' });
    res.json({ ok: true, total: resultados.length, arquivo: nome });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Status da fila de reprocessamento (para o painel ao vivo)
app.get('/api/reprocessamento-status', (req, res) => {
  try {
    const arq = path.join(PLAYWRIGHT_PATH, 'reprocessamento.json');
    if (!fs.existsSync(arq)) return res.json({ ativo: false });
    const r = JSON.parse(fs.readFileSync(arq, 'utf8'));
    const total = (r.clientes || []).length;
    const feitos = (r.resultados || []).length;
    const recuperados = (r.resultados || []).filter(x => String(x.status || '').startsWith('Sucesso')).length;
    const aindaErro = feitos - recuperados;
    const pendentes = Math.max(total - feitos, 0);
    res.json({ ativo: total > 0, total, feitos, pendentes, recuperados, aindaErro });
  } catch (err) { res.status(500).json({ ativo: false, erro: err.message }); }
});

app.get('/api/historico-robos', (req, res) => {
  res.json(lerJSON(HISTORICO_ROBOS_PATH, {}));
});

// ─── Relatórios ───────────────────────────────────────────────────────────────

app.get('/api/relatorio-parcial', (req, res) => {
  try {
    const resultados = [];
    for (const est of ESTADOS_VALIDOS) {
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
    .map(f => ({ nome: f, mtime: fs.statSync(path.join(RELATORIOS_PATH, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(a => a.nome);
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
    const statusOk = new Set(['Sucesso', 'Sucesso (2ª tentativa)', 'Sucesso (3ª tentativa)']);
    const sucesso = rows.filter(r => statusOk.has(String(r.Status || '').trim()));
    const totalClientes = sucesso.length;

    // Conta total de disparos reais (1 por PDF/fatura)
    let totalDisparos = 0;
    for (const r of sucesso) {
      const pdfs = Object.keys(r).filter(k => /^Número/i.test(k)).map(k => String(r[k] || '').trim()).filter(n => n.toLowerCase().endsWith('.pdf'));
      totalDisparos += pdfs.length;
    }

    const jaEnviadosPdfs = new Set();
    const hoje = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const hojePdfs = new Set();
    if (fs.existsSync(DISPARO_LOG_PATH)) {
      const logFiles = fs.readdirSync(DISPARO_LOG_PATH).filter(f => f.endsWith('.json')).sort();
      for (const f of logFiles) {
        try {
          const entries = JSON.parse(fs.readFileSync(path.join(DISPARO_LOG_PATH, f), 'utf8'));
          const eHoje = f.startsWith(`disparo_${hoje}`) || f === 'disparo_parcial.json';
          for (const e of (Array.isArray(entries) ? entries : [])) {
            if (e.status === 'enviado' && e.pdf) {
              jaEnviadosPdfs.add(e.pdf);
              if (eHoje) hojePdfs.add(e.pdf);
            }
          }
        } catch {}
      }
    }
    let disparados = 0;
    let disparadosMsg = 0;
    let disparadosHojeMsg = 0;
    let clientesUmaFatura = 0;
    let clientesDuasFaturas = 0;
    let clientesTresMaisFaturas = 0;

    for (const r of sucesso) {
      const numeros = Object.keys(r).filter(k => /^Número/i.test(k)).map(k => String(r[k] || '').trim()).filter(n => n.toLowerCase().endsWith('.pdf'));
      if (numeros.length > 0 && numeros.every(n => jaEnviadosPdfs.has(n))) { disparados++; disparadosMsg += numeros.length; }
      disparadosHojeMsg += numeros.filter(n => hojePdfs.has(n)).length;

      if (numeros.length === 1) clientesUmaFatura++;
      else if (numeros.length === 2) clientesDuasFaturas++;
      else if (numeros.length >= 3) clientesTresMaisFaturas++;
    }

    res.json({
      total: totalClientes, totalDisparos, disparados, disparadosMsg, disparadosHojeMsg,
      pendentes: totalClientes - disparados, linhas: rows.length,
      clientesUmaFatura, clientesDuasFaturas, clientesTresMaisFaturas,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/relatorios-disparo', (req, res) => {
  if (!fs.existsSync(RELATORIOS_DISPARO_PATH)) return res.json({ arquivos: [] });
  const arquivos = fs.readdirSync(RELATORIOS_DISPARO_PATH)
    .filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .map(f => ({ nome: f, mtime: fs.statSync(path.join(RELATORIOS_DISPARO_PATH, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(a => a.nome);
  res.json({ arquivos });
});

app.delete('/api/relatorios-disparo', (req, res) => {
  try {
    if (!fs.existsSync(RELATORIOS_DISPARO_PATH)) return res.json({ ok: true });
    const arquivos = fs.readdirSync(RELATORIOS_DISPARO_PATH).filter(f => f.endsWith('.xlsx'));
    arquivos.forEach(f => fs.unlinkSync(path.join(RELATORIOS_DISPARO_PATH, f)));
    res.json({ ok: true, removidos: arquivos.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/relatorios-disparo/download/:arquivo', (req, res) => {
  const arquivo = path.basename(req.params.arquivo);
  const filePath = path.join(RELATORIOS_DISPARO_PATH, arquivo);
  if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
  res.download(filePath);
});

app.get('/api/relatorio-parcial-disparo', (req, res) => {
  try {
    const XLSX = require('xlsx');
    const parcialPath = path.join(DISPARO_LOG_PATH, 'disparo_parcial.json');
    // Usa parcial (sessão ativa) se existir, senão o log mais recente
    let entries = [];
    let fonte = 'parcial';
    if (fs.existsSync(parcialPath)) {
      entries = JSON.parse(fs.readFileSync(parcialPath, 'utf8') || '[]');
    } else {
      const logs = fs.existsSync(DISPARO_LOG_PATH)
        ? fs.readdirSync(DISPARO_LOG_PATH).filter(f => f.endsWith('.json') && !f.startsWith('.')).sort().reverse()
        : [];
      if (logs.length === 0) return res.status(404).json({ erro: 'Nenhum log de disparo encontrado' });
      entries = JSON.parse(fs.readFileSync(path.join(DISPARO_LOG_PATH, logs[0]), 'utf8') || '[]');
      fonte = logs[0].replace('.json', '');
    }
    const rows = entries.map(e => ({
      Nome: e.nome || '',
      CPF: e.cpf || '',
      Número: e.numero || '',
      PDF: e.pdf || '',
      Valor: e.valor || '',
      Vencimento: e.dataVencimento || '',
      Status: e.status || '',
      Erro: e.erro || '',
      Timestamp: e.timestamp || '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Disparo');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="relatorio_disparo_${fonte}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ─── Disparo WhatsApp ─────────────────────────────────────────────────────────

const DISPARO_PID_FILE = path.join(DISPARO_LOG_PATH, '.disparo.pid');

function salvarParcialComData(prefixo) {
  try {
    const parcialPath = path.join(DISPARO_LOG_PATH, 'disparo_parcial.json');
    if (!fs.existsSync(parcialPath)) return;
    const entries = JSON.parse(fs.readFileSync(parcialPath, 'utf8') || '[]');
    if (!Array.isArray(entries) || entries.length === 0) return;
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
    const dest = path.join(DISPARO_LOG_PATH, `disparo_${stamp}${prefixo ? '_'+prefixo : ''}.json`);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, JSON.stringify(entries, null, 2));
      console.log(`💾 Parcial salvo automaticamente: ${path.basename(dest)} (${entries.length} entradas)`);
    }
  } catch (e) { console.error('⚠️ Erro ao salvar parcial:', e.message); }
}

app.post('/api/comando/disparar', apenasLocal, (req, res) => {
  const lockFile = path.join(PLAYWRIGHT_PATH, 'disparo_log', '.disparo.lock');
  if (processoDisparo) return res.status(400).json({ erro: 'Disparo já está rodando pelo dashboard' });

  // Verificar via PID file se há processo ativo
  if (fs.existsSync(DISPARO_PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(DISPARO_PID_FILE, 'utf8').trim());
      process.kill(pid, 0);
      return res.status(400).json({ erro: `Disparo já está rodando (PID ${pid}). Pare antes de iniciar outro.` });
    } catch { fs.unlinkSync(DISPARO_PID_FILE); }
  }

  if (fs.existsSync(lockFile)) {
    try {
      const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim());
      process.kill(pid, 0);
      return res.status(400).json({ erro: `Disparo já está rodando (PID ${pid}). Pare antes de iniciar outro.` });
    } catch { fs.unlinkSync(lockFile); }
  }

  // Salvar parcial anterior automaticamente antes de sobrescrever
  salvarParcialComData('auto');
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
  if (req.body?.forcar) args.push('--forcar');
  emitirEvento('disparo', { msg: `📤 Iniciando disparo: ${escolhido}${limite > 0 ? ` (limite: ${limite})` : ''}`, status: 'rodando' });
  processoDisparo = spawn('node', args, { cwd: PLAYWRIGHT_PATH });
  // Salvar PID para recuperação após restart do servidor
  fs.writeFileSync(DISPARO_PID_FILE, String(processoDisparo.pid));
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
  processoDisparo.on('close', code => {
    emitirEvento('disparo', { msg: `📤 Disparo finalizado (código ${code})`, status: 'parado' });
    processoDisparo = null;
    try { if (fs.existsSync(DISPARO_PID_FILE)) fs.unlinkSync(DISPARO_PID_FILE); } catch {}
  });
  res.json({ ok: true, relatorio: escolhido });
});

app.post('/api/comando/disparo-parar', apenasLocal, (req, res) => {
  if (!processoDisparo) {
    // Tentar via PID file (servidor reiniciou mas processo ainda ativo)
    if (fs.existsSync(DISPARO_PID_FILE)) {
      try {
        const pid = parseInt(fs.readFileSync(DISPARO_PID_FILE, 'utf8').trim());
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(DISPARO_PID_FILE);
        emitirEvento('disparo', { msg: '⏹ Disparo interrompido (via PID file)', status: 'parado' });
        return res.json({ ok: true });
      } catch (e) {
        try { fs.unlinkSync(DISPARO_PID_FILE); } catch {}
        return res.status(400).json({ erro: 'Processo não encontrado: ' + e.message });
      }
    }
    return res.status(400).json({ erro: 'Nenhum disparo rodando' });
  }
  processoDisparo.kill('SIGTERM'); processoDisparo = null;
  try { if (fs.existsSync(DISPARO_PID_FILE)) fs.unlinkSync(DISPARO_PID_FILE); } catch {}
  emitirEvento('disparo', { msg: '⏹ Disparo interrompido manualmente', status: 'parado' });
  res.json({ ok: true });
});

// ─── Upload e faturas PDF ─────────────────────────────────────────────────────

const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
// Exigia CPF no formato exato 3.3.3-2 antes do mês — rejeitava (silenciosamente,
// sem retry, do lado do robô) qualquer cliente PJ, cujo "cpf" na verdade é um
// CNPJ/custcode com outra quantidade de dígitos, e nomes de empresa com "&".
// Agora só exige terminar em "_MM-AAAA.pdf", sem travar o formato do meio.
const NOME_PDF_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 ._&-]+_\d{2}-\d{4}\.pdf$/i;

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

// ─── Códigos Pix / linha digitável extraídos das faturas ──────────────────────
// Chave = nome do arquivo PDF (mesma chave usada em toda a fila/log de disparo).

const FATURA_CODIGOS_PATH = path.join(DATA_PATH, 'fatura-codigos.json');

app.post('/api/faturas/codigos', autorizarUpload, (req, res) => {
  const { arquivo, pix, linhaDigitavel } = req.body || {};
  if (!arquivo) return res.status(400).json({ erro: 'Campo "arquivo" obrigatório' });

  const dados = lerJSON(FATURA_CODIGOS_PATH, {});
  dados[arquivo] = {
    pix: pix || null,
    linhaDigitavel: linhaDigitavel || null,
    atualizadoEm: new Date().toISOString(),
  };
  salvarJSON(FATURA_CODIGOS_PATH, dados);
  res.json({ ok: true });
});

app.get('/api/faturas/codigos/:arquivo', (req, res) => {
  const dados = lerJSON(FATURA_CODIGOS_PATH, {});
  const item = dados[req.params.arquivo];
  if (!item) return res.status(404).json({ erro: 'Não encontrado' });
  res.json(item);
});

// ─── Última fatura enviada por número ────────────────────────────────────────
// O Chatwoot entrega apenas o texto do botão clicado ("Copiar chave Pix"), sem
// nenhum identificador da fatura. Para saber a qual cobrança o clique se refere,
// registramos no disparo qual PDF foi para cada número e consultamos aqui.

const FATURA_ENVIOS_PATH = path.join(DATA_PATH, 'fatura-envios.json');

// O WhatsApp ora devolve o número com o nono dígito, ora sem. Gera as duas
// formas para que o registro e a consulta se encontrem em qualquer caso.
function chavesTelefone(telefone) {
  const d = String(telefone || '').replace(/\D/g, '');
  if (!d) return [];
  const chaves = new Set([d]);
  const m = d.match(/^55(\d{2})(\d{8,9})$/);
  if (m) {
    const [, ddd, numero] = m;
    if (numero.length === 9 && numero.startsWith('9')) chaves.add(`55${ddd}${numero.slice(1)}`);
    if (numero.length === 8) chaves.add(`55${ddd}9${numero}`);
  }
  return [...chaves];
}

// Um cliente com várias faturas em aberto recebe uma mensagem por fatura, todas
// com os mesmos botões, e o Chatwoot não diz em qual delas o clique aconteceu.
// Por isso guardamos todas as faturas da rodada e respondemos com todos os
// códigos identificados, em vez de arriscar devolver o de outra cobrança.
// 45 dias (não 24h) porque o cliente não paga na hora que recebe a mensagem —
// no uso real ele clica no botão dias depois; com 24h o sistema "esquecia" a
// fatura enviada e respondia "não encontramos" pra quem só demorou pra pagar.
const JANELA_ENVIOS_MS = 45 * 24 * 60 * 60 * 1000;

app.post('/api/faturas/envio', autorizarUpload, (req, res) => {
  const { telefone, arquivo, vencimento, mesRef } = req.body || {};
  if (!telefone || !arquivo) return res.status(400).json({ erro: 'Campos "telefone" e "arquivo" obrigatórios' });

  const envios = lerJSON(FATURA_ENVIOS_PATH, {});
  const agora = Date.now();
  const novo = { arquivo, vencimento: vencimento || null, mesRef: mesRef || null, enviadoEm: new Date(agora).toISOString() };

  for (const chave of chavesTelefone(telefone)) {
    const anteriores = (envios[chave]?.faturas || [])
      .filter(f => f.arquivo !== arquivo)
      .filter(f => agora - new Date(f.enviadoEm).getTime() < JANELA_ENVIOS_MS);
    envios[chave] = { faturas: [...anteriores, novo] };
  }

  salvarJSON(FATURA_ENVIOS_PATH, envios);
  res.json({ ok: true });
});

// Faturas enviadas recentemente para o número, da mais antiga para a mais nova.
function faturasDoTelefone(telefone) {
  const envios = lerJSON(FATURA_ENVIOS_PATH, {});
  const agora = Date.now();
  for (const chave of chavesTelefone(telefone)) {
    const registro = envios[chave];
    if (!registro) continue;

    // Formato antigo (uma única fatura por número) — mantém compatibilidade.
    const faturas = registro.faturas || (registro.arquivo ? [registro] : []);
    const validas = faturas.filter(f => agora - new Date(f.enviadoEm).getTime() < JANELA_ENVIOS_MS);
    if (validas.length) {
      return validas.sort((a, b) => new Date(a.enviadoEm) - new Date(b.enviadoEm));
    }
  }
  return [];
}

// ─── Webhook Chatwoot (log cru, temporário) ────────────────────────────────────
// Etapa de descoberta: só grava o payload bruto pra entendermos o formato real
// de um clique de botão interativo antes de implementar a lógica final.

const CHATWOOT_WEBHOOK_LOG_PATH = path.join(DATA_PATH, 'chatwoot-webhook-log.json');

const CHATWOOT_URL = (process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN || '';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '';

// Comparados sem acento: o mesmo "ó" chega ora composto, ora decomposto,
// dependendo de quem originou a mensagem — comparar o texto cru falha.
const BOTAO_PIX = 'copiar chave pix';
const BOTAO_BOLETO = 'copiar codigo boleto';

async function responderNoChatwoot(conversaId, texto) {
  if (!CHATWOOT_URL || !CHATWOOT_TOKEN || !CHATWOOT_ACCOUNT_ID) {
    console.log('⚠️ Chatwoot não configurado — resposta não enviada');
    return false;
  }
  try {
    const r = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations/${conversaId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', api_access_token: CHATWOOT_TOKEN },
      body: JSON.stringify({ content: texto, message_type: 'outgoing' }),
    });
    if (!r.ok) { console.log('⚠️ Chatwoot respondeu', r.status, await r.text().catch(() => '')); return false; }
    return true;
  } catch (e) {
    console.log('⚠️ Falha ao responder no Chatwoot:', e.message);
    return false;
  }
}

app.post('/webhook/chatwoot', (req, res) => {
  const body = req.body || {};

  const log = lerJSON(CHATWOOT_WEBHOOK_LOG_PATH, []);
  log.push({ recebidoEm: new Date().toISOString(), body });
  while (log.length > 50) log.shift(); // mantém só os últimos 50 eventos
  salvarJSON(CHATWOOT_WEBHOOK_LOG_PATH, log);

  // Responde imediatamente: o Chatwoot não deve ficar esperando o envio.
  res.status(200).json({ ok: true });

  if (body.event !== 'message_created' || body.message_type !== 'incoming') return;

  const texto = semAcento(String(body.content || '').trim());
  const querPix = texto === BOTAO_PIX;
  const querBoleto = texto === BOTAO_BOLETO;
  if (!querPix && !querBoleto) return;

  const conversaId = body.conversation?.id;
  const telefone = body.sender?.phone_number;
  if (!conversaId) return;

  const faturas = faturasDoTelefone(telefone);
  const todosCodigos = lerJSON(FATURA_CODIGOS_PATH, {});

  const encontrados = faturas
    .map(f => ({ ...f, codigo: querPix ? todosCodigos[f.arquivo]?.pix : todosCodigos[f.arquivo]?.linhaDigitavel }))
    .filter(f => f.codigo);

  if (!encontrados.length) {
    const oQue = querPix ? 'o código Pix' : 'o código de barras';
    responderNoChatwoot(conversaId, `Não encontramos ${oQue} dessa fatura. Vou verificar e te retorno.`);
    console.log(`⚠️ Código ausente para ${telefone} (${faturas.length} fatura(s) registrada(s))`);
    return;
  }

  (async () => {
    // Com mais de uma fatura em aberto, identifica cada código — o cliente
    // precisa saber a qual cobrança cada um corresponde.
    const varias = encontrados.length > 1;
    for (const f of encontrados) {
      if (varias) {
        const ref = f.mesRef || 'sua fatura';
        const venc = f.vencimento ? ` · vencimento ${f.vencimento}` : '';
        await responderNoChatwoot(conversaId, `📄 ${ref}${venc}:`);
      }
      await responderNoChatwoot(conversaId, f.codigo);
    }
  })();
});

app.get('/webhook/chatwoot/log', (req, res) => {
  res.json(lerJSON(CHATWOOT_WEBHOOK_LOG_PATH, []));
});

// Lista crua de todos os nomes de PDF no servidor — usado pra diagnosticar
// reconciliação (comparar com o que existe localmente na máquina do robô,
// já que o upload pro VPS pode falhar silenciosamente e nunca é reprocessado).
app.get('/api/faturas/nomes', autorizarUpload, (req, res) => {
  try {
    const arquivos = fs.readdirSync(PDFS_PATH).filter(f => f.toLowerCase().endsWith('.pdf'));
    res.json({ total: arquivos.length, arquivos });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/faturas', (req, res) => {
  try {
    // O nome do arquivo usa "_" no lugar de espaço (ex: "ROBERTO_CARLOS_GALINA_...pdf"),
    // mas quem busca digita com espaço normal — sem normalizar os dois lados
    // pro mesmo separador, a busca por nome completo nunca dava match.
    const busca = semAcento(req.query.busca || '').replace(/_/g, ' ');
    const pagina = Math.max(1, parseInt(req.query.pagina) || 1);
    const porPagina = 20;

    let arquivos = fs.readdirSync(PDFS_PATH).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
    if (busca) arquivos = arquivos.filter(f => semAcento(f).replace(/_/g, ' ').includes(busca));

    const total = arquivos.length;
    const paginas = Math.ceil(total / porPagina) || 1;
    const slice = arquivos.slice((pagina - 1) * porPagina, pagina * porPagina);

    const codigos = lerJSON(FATURA_CODIGOS_PATH, {});
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
      clientes[chave].faturas.push({
        arquivo: arq,
        mesAno,
        pix: codigos[arq]?.pix || null,
        linhaDigitavel: codigos[arq]?.linhaDigitavel || null,
      });
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

// ─── Proteção parcial no startup ──────────────────────────────────────────────
(function salvarParcialAoIniciar() {
  try {
    const parcialPath = path.join(DISPARO_LOG_PATH, 'disparo_parcial.json');
    if (!fs.existsSync(parcialPath)) return;
    const entries = JSON.parse(fs.readFileSync(parcialPath, 'utf8') || '[]');
    if (!Array.isArray(entries) || entries.length === 0) return;
    const stamp = new Date().toISOString().replace('T','_').slice(0,16).replace(':','-');
    const dest = path.join(DISPARO_LOG_PATH, `disparo_${stamp}_startup.json`);
    fs.writeFileSync(dest, JSON.stringify(entries, null, 2));
    console.log(`💾 Parcial salvo no startup: ${path.basename(dest)} (${entries.length} entradas)`);
  } catch (e) { console.error('⚠️ Erro ao salvar parcial no startup:', e.message); }
})();

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Dashboard rodando em http://0.0.0.0:${PORT} [modo: ${MODO}]`);
});
