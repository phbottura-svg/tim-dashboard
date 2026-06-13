// ─── Estado Global ────────────────────────────────────────────────────────────

const state = {
  abaAtual: 'dashboard',
  pagina: 1, ordenarPor: 'cliente', direcao: 'asc',
  paginaRisco: 1, buscaRisco: '',
  paginaPg: 1, buscaPg: '',
  _carregando: false,
};
const graficos = {};

// ─── Cores ───────────────────────────────────────────────────────────────────

const C = {
  verde:    '#00c853', laranja: '#ff9100',  vermelho: '#ff3d57',
  amarelo:  '#ffd600', azul:    '#0057ff',  azulC:    '#4da6ff',
  roxo:     '#7c4dff', cinza:   '#7070a0',
  n1: '#ffd600', n2: '#ff9100', n3: '#ff6b7a', inadim: '#ff3d57', emDia: '#00c853',
};

const NIVEL_LABEL = {
  EM_DIA: 'Em Dia', N1: 'N1 (1-15d)', N2: 'N2 (16-27d)', N3: 'N3 (28-32d)', INADIMPLENTE: 'Inadimplente (33+d)',
};

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await aplicarModoVps();
  conectarSSE();
  verificarStatusRobo();
  setInterval(verificarStatusRobo, 5000);
  await esperarCache();
  await carregarOpcoesFiltros();
  await carregarTudo();
});

async function aplicarModoVps() {
  try {
    const { modo } = await fetch('/api/modo').then(r => r.json());
    if (modo === 'vps') {
      document.querySelectorAll('.apenas-local').forEach(el => {
        el.style.display = 'none';
      });
      const aviso = document.getElementById('aviso-vps');
      if (aviso) aviso.style.display = '';
    }
  } catch {}
}

async function esperarCache() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('/api/resumo');
      const d = await r.json();
      if (d.ultimaAtualizacao) return;
    } catch {}
    await new Promise(res => setTimeout(res, 500));
  }
}

async function carregarTudo() {
  if (state._carregando) return;
  state._carregando = true;
  try {
    await Promise.all([carregarResumo(), carregarGraficos(), carregarTabela(), carregarTabelaRisco(), carregarTabelaPg()]);
  } finally {
    state._carregando = false;
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────

let _sse = null;
function conectarSSE() {
  if (_sse) { _sse.close(); _sse = null; }
  _sse = new EventSource('/api/eventos');
  _sse.onmessage = e => {
    const d = JSON.parse(e.data);
    adicionarLog(d.msg, d.tipo);
    if (d.tipo === 'robo')        atualizarBadge('robo', d.status);
    if (d.tipo === 'disparo')     {
      atualizarBadge('disparo', d.status);
      if (d.status) {
        atualizarBotoesDisparo(d.status === 'rodando');
        if (d.status === 'parado') {
          carregarRelatoriosDisparo();
          atualizarInfoRelatorio(); // atualiza contagem de disparados/pendentes
          setTimeout(() => { const w = document.getElementById('disparo-progresso-wrap'); if (w) w.style.display = 'none'; }, 5000);
        }
      }
    }
    if (d.tipo === 'progresso')   atualizarProgresso(d.atual, d.total);
    if (d.tipo === 'robo-estado') atualizarCardEstado(d.estado, d.status);
    if (d.tipo === 'token-request') { adicionarLog(d.msg || `⏳ Robô ${d.estado} aguardando token!`, 'aviso'); abrirModalTokenRequest(d.estado); }
    if (d.tipo === 'cache')       { if (!state._carregando) carregarTudo(); }
  };
  _sse.onerror = () => { if (_sse) { _sse.close(); _sse = null; } setTimeout(conectarSSE, 5000); };
}

function adicionarLog(msg, tipo = 'info') {
  if (!msg) return;
  // Logs de disparo vão para o painel esquerdo; o resto para o painel do robô
  const ehDisparo = tipo === 'disparo' || tipo === 'disparo-log';
  const el = document.getElementById(ehDisparo ? 'console-disparo' : 'console-log');
  if (!el) return;
  const l = document.createElement('div');
  const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  const cls = tipo?.includes('erro') ? 'console-erro'
    : tipo?.includes('sucesso') ? 'console-sucesso'
    : tipo?.includes('robo') ? 'console-robo'
    : tipo?.includes('aviso') ? 'console-aviso' : 'console-info';
  l.className = `console-linha ${cls}`;
  l.textContent = `[${ts}] ${msg}`;
  el.appendChild(l);
  // Mantém máximo 200 linhas no console
  while (el.children.length > 200) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function atualizarBadge(tipo, status) {
  const b = document.getElementById(`badge-${tipo}`);
  const emoji = tipo === 'robo' ? '🤖' : '📤';
  const label = tipo === 'robo' ? 'Robô' : 'Disparo';
  if (b) {
    b.textContent = status === 'rodando' ? `${emoji} ${label}: rodando` : `⏹ ${label}: parado`;
    b.className = `badge ${status === 'rodando' ? 'rodando' : ''}`;
  }
  if (tipo === 'robo') {
    document.getElementById('btn-robo-iniciar').disabled = status === 'rodando';
    document.getElementById('btn-robo-parar').disabled   = status !== 'rodando';
  }
}

// ─── Abas ─────────────────────────────────────────────────────────────────────

function mudarAba(btn) {
  const aba = btn.dataset.tab;
  state.abaAtual = aba;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  const el = document.getElementById(`tab-${aba}`);
  if (el) el.classList.add('active');
  // Tabela analítica aparece em dashboard, risco e pg-atraso
  const extra = document.getElementById('tab-dashboard-tabela');
  if (extra) extra.style.display = (aba === 'dashboard' || aba === 'risco' || aba === 'pg-atraso') ? 'block' : 'none';
  if (aba === 'comandos') { carregarRelatorios(); carregarRelatoriosDisparo(); }
  if (aba === 'faturas') { carregarFaturas(1); }
}

// ─── Filtros ──────────────────────────────────────────────────────────────────

async function carregarOpcoesFiltros() {
  try {
    const d = await fetch('/api/filtros/opcoes').then(r => r.json());

    const selSafra = document.getElementById('filtro-safra');
    d.safras?.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s; selSafra.appendChild(o);
    });

    const selVend = document.getElementById('filtro-vendedor');
    d.vendedores?.forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v; selVend.appendChild(o);
    });

    const selEst = document.getElementById('filtro-estado');
    d.estados?.forEach(e => {
      const o = document.createElement('option');
      o.value = e; o.textContent = e; selEst.appendChild(o);
    });
  } catch {}
}

function coletarFiltros() {
  const p = new URLSearchParams();
  const safra   = document.getElementById('filtro-safra')?.value;
  const vendedor = document.getElementById('filtro-vendedor')?.value;
  const estado   = document.getElementById('filtro-estado')?.value;
  const nivel    = document.getElementById('filtro-nivel')?.value;
  if (safra)   p.set('safra', safra);
  if (vendedor) p.set('vendedor', vendedor);
  if (estado)   p.set('estado', estado);
  if (nivel)    p.set('nivel', nivel);
  return p;
}

async function aplicarFiltros() {
  state.pagina = 1; state.paginaRisco = 1; state.paginaPg = 1;
  await carregarTudo();
}

// ─── Resumo / KPIs ───────────────────────────────────────────────────────────

async function carregarResumo() {
  try {
    const p = coletarFiltros();
    const d = await fetch('/api/resumo?' + p).then(r => r.json());

    const fmt = n => (n ?? 0).toLocaleString('pt-BR');
    const pct = (v, t) => t > 0 ? (v/t*100).toFixed(1) + '%' : '0%';

    setText('v-iq',         d.iq + '%');
    setText('v-total',      fmt(d.total));
    setText('v-f4pagas',    fmt(d.f4Pagas));
    setText('v-com-atraso', fmt(d.comAtraso));
    setText('v-com-atraso-pct', pct(d.comAtraso, d.total) + ' do total');
    setText('v-pg-atraso',  fmt(d.pgAtrasoCount));
    setText('v-pg-atraso-pct', pct(d.pgAtrasoCount, d.total) + ' do total');
    setText('v-em-andamento', fmt(d.emAndamento));
    setText('v-em-risco',   fmt(d.emRisco));
    setText('v-em-risco-sub', `Leve: ${fmt(d.leve)} · Médio: ${fmt(d.medio)} · Alto: ${fmt(d.alto)}`);

    setText('v-pct-f1', d.pctF1 + '%');
    setText('v-sub-f1', `${fmt(d.f1p)} de ${fmt(d.total)} clientes`);
    setText('v-pct-f2', d.pctF2 + '%');
    setText('v-sub-f2', `${fmt(d.f2p)} de ${fmt(d.total)} clientes`);
    setText('v-pct-f3', d.pctF3 + '%');
    setText('v-sub-f3', `${fmt(d.f3p)} de ${fmt(d.total)} clientes`);
    setText('v-pct-f4', d.pctF4 + '%');
    setText('v-sub-f4', `${fmt(d.f4p)} de ${fmt(d.total)} clientes`);

    setText('v-em-dia',   fmt(d.emDia));
    setText('v-n1',       fmt(d.n1));
    setText('v-n2',       fmt(d.n2));
    setText('v-n3',       fmt(d.n3));
    setText('v-inadim',   fmt(d.inadimplentes));
    setText('v-completo', fmt(d.completo));
    setText('v-parcial',  fmt(d.parcial));
    setText('v-quebra',   fmt(d.quebra));

    // Badges de abas
    setText('badge-risco',     fmt(d.inadimplentes));
    setText('badge-pg-atraso', fmt(d.pgAtrasoCount));

    if (d.ultimaAtualizacao) {
      const ts = new Date(d.ultimaAtualizacao);
      setText('v-hora', ts.toLocaleTimeString('pt-BR', { hour12: false }));
      setText('v-data', ts.toLocaleDateString('pt-BR'));
      setText('ultima-atualizacao', 'Atualizado: ' + ts.toLocaleTimeString('pt-BR'));
    }
  } catch (err) { console.error('Erro resumo:', err); }
}

// ─── Gráficos ─────────────────────────────────────────────────────────────────

const defOpts = {
  responsive: true, maintainAspectRatio: true,
  plugins: { legend: { labels: { color: '#7070a0', font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#7070a0', maxRotation: 45 }, grid: { color: 'rgba(30,30,74,0.8)' } },
    y: { ticks: { color: '#7070a0' }, grid: { color: 'rgba(30,30,74,0.8)' } },
  },
};

function criarOuAtualizar(id, tipo, dados, opts = {}) {
  const ctx = document.getElementById(id)?.getContext('2d');
  if (!ctx) return;
  if (graficos[id]) { graficos[id].data = dados; graficos[id].update(); return; }
  graficos[id] = new Chart(ctx, { type: tipo, data: dados, options: { ...defOpts, ...opts } });
}

async function carregarGraficos() {
  const p = coletarFiltros();
  await Promise.all([
    carregarStatusGeral(p),
    carregarRiscoDist(p),
    carregarIqSafra(p),
    carregarStatusSafra(p),
    carregarCompFaturas(p),
    carregarRiscoSafra(p),
    carregarRankVendedores(p),
    carregarAtrasosVendedores(p),
    carregarEstados(p),
    carregarCidades(p),
    carregarFunil(p),
  ]);
}

async function carregarStatusGeral(p) {
  try {
    const d = await fetch('/api/graficos/status-geral?' + p).then(r => r.json());
    const cores = [C.verde, C.amarelo, C.laranja, '#ff6b7a', C.vermelho];
    const ctx = document.getElementById('g-status-geral')?.getContext('2d');
    if (!ctx) return;

    if (graficos['g-status-geral']) {
      graficos['g-status-geral'].data.datasets[0].data = d.valores;
      graficos['g-status-geral'].update();
    } else {
      graficos['g-status-geral'] = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: d.labels, datasets: [{ data: d.valores, backgroundColor: cores, borderWidth: 0, hoverOffset: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { display: false } } },
      });
    }

    setText('donut-iq', d.iq + '%');

    const legEl = document.getElementById('donut-legenda');
    if (legEl) {
      legEl.innerHTML = d.labels.map((l, i) => {
        const v = d.valores[i];
        const pct = d.total > 0 ? (v/d.total*100).toFixed(1) : 0;
        return `<div class="donut-leg-item">
          <div class="donut-leg-cor" style="background:${cores[i]}"></div>
          <div class="donut-leg-txt">${l}</div>
          <div class="donut-leg-val">${v.toLocaleString('pt-BR')}</div>
          <div class="donut-leg-pct">${pct}%</div>
        </div>`;
      }).join('');
    }
  } catch {}
}

async function carregarRiscoDist(p) {
  try {
    const d = await fetch('/api/graficos/status-geral?' + p).then(r => r.json());
    // Usa só N1-N3-Inadimplente para distribuição de risco
    const vals = d.valores.slice(1);
    const labels = d.labels.slice(1);
    const cores = [C.amarelo, C.laranja, '#ff6b7a', C.vermelho];
    criarOuAtualizar('g-risco', 'bar', {
      labels,
      datasets: [{ label: 'Clientes', data: vals, backgroundColor: cores, borderRadius: 6 }],
    }, { plugins: { legend: { display: false } }, scales: defOpts.scales });
  } catch {}
}

async function carregarIqSafra(p) {
  try {
    const d = await fetch('/api/graficos/iq-safra?' + p).then(r => r.json());
    const melhorIdx = d.valores.indexOf(d.melhor);
    const piorIdx   = d.valores.indexOf(d.pior);
    setText('g-iq-safra-sub', `🏆 Melhor: ${d.labels[melhorIdx]} (${d.melhor}%)   ⚠ Pior: ${d.labels[piorIdx]} (${d.pior}%)   Média: ${d.media}%`);
    criarOuAtualizar('g-iq-safra', 'line', {
      labels: d.labels,
      datasets: [{
        label: 'IQ %', data: d.valores,
        borderColor: C.azulC, backgroundColor: 'rgba(77,166,255,0.1)',
        fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: C.azulC,
      }, {
        label: 'Média', data: d.labels.map(() => d.media),
        borderColor: 'rgba(255,255,255,0.2)', borderDash: [6,4],
        pointRadius: 0, fill: false,
      }],
    }, { plugins: { legend: { labels: { color: '#7070a0' } } }, scales: { ...defOpts.scales, y: { ...defOpts.scales.y, min: 50, max: 100 } } });
  } catch {}
}

async function carregarStatusSafra(p) {
  try {
    const d = await fetch('/api/graficos/status-safra?' + p).then(r => r.json());
    criarOuAtualizar('g-status-safra', 'bar', {
      labels: d.labels,
      datasets: [
        { label: 'Em Dia',            data: d.emDia,  backgroundColor: 'rgba(0,200,83,0.7)',   borderRadius: 2 },
        { label: 'N1 (1-15d)',        data: d.n1,     backgroundColor: 'rgba(255,214,0,0.7)',  borderRadius: 2 },
        { label: 'N2 (16-27d)',       data: d.n2,     backgroundColor: 'rgba(255,145,0,0.7)', borderRadius: 2 },
        { label: 'N3 (28-32d)',       data: d.n3,     backgroundColor: 'rgba(255,107,122,0.7)', borderRadius: 2 },
        { label: 'Inadimplente (33+d)', data: d.inadim, backgroundColor: 'rgba(255,61,87,0.8)', borderRadius: 2 },
      ],
    }, { plugins: { legend: { labels: { color: '#7070a0' } } }, scales: { x: { stacked: true, ticks: { color: '#7070a0', maxRotation: 45 }, grid: { color: 'rgba(30,30,74,0.8)' } }, y: { stacked: true, ticks: { color: '#7070a0' }, grid: { color: 'rgba(30,30,74,0.8)' } } } });
  } catch {}
}

async function carregarCompFaturas(p) {
  try {
    const d = await fetch('/api/graficos/comparativo-faturas?' + p).then(r => r.json());
    criarOuAtualizar('g-comp-faturas', 'line', {
      labels: d.labels,
      datasets: [
        { label: 'F1 %', data: d.f1, borderColor: C.verde,   backgroundColor: 'transparent', tension: 0.4, pointRadius: 3 },
        { label: 'F2 %', data: d.f2, borderColor: C.azulC,   backgroundColor: 'transparent', tension: 0.4, pointRadius: 3 },
        { label: 'F3 %', data: d.f3, borderColor: C.laranja, backgroundColor: 'transparent', tension: 0.4, pointRadius: 3 },
        { label: 'F4 %', data: d.f4, borderColor: C.vermelho, backgroundColor: 'transparent', tension: 0.4, pointRadius: 3 },
      ],
    }, { plugins: { legend: { labels: { color: '#7070a0' } } }, scales: { ...defOpts.scales, y: { ...defOpts.scales.y, min: 0, max: 100 } } });
  } catch {}
}

async function carregarRiscoSafra(p) {
  try {
    const d = await fetch('/api/graficos/risco-safra?' + p).then(r => r.json());
    criarOuAtualizar('g-risco-safra', 'bar', {
      labels: d.labels,
      datasets: [
        { label: 'N1 (1-15d)',        data: d.n1,     backgroundColor: 'rgba(255,214,0,0.7)',  borderRadius: 2 },
        { label: 'N2 (16-27d)',       data: d.n2,     backgroundColor: 'rgba(255,145,0,0.7)', borderRadius: 2 },
        { label: 'N3 (28-32d)',       data: d.n3,     backgroundColor: 'rgba(255,107,122,0.7)', borderRadius: 2 },
        { label: 'Inadimplente (33+d)', data: d.inadim, backgroundColor: 'rgba(255,61,87,0.8)', borderRadius: 2 },
      ],
    }, { plugins: { legend: { labels: { color: '#7070a0' } } }, scales: { x: { stacked: true, ticks: { color: '#7070a0', maxRotation: 45 }, grid: { color: 'rgba(30,30,74,0.8)' } }, y: { stacked: true, ticks: { color: '#7070a0' }, grid: { color: 'rgba(30,30,74,0.8)' } } } });
  } catch {}
}

async function carregarRankVendedores(p) {
  try {
    const d = await fetch('/api/graficos/ranking-vendedores?' + p).then(r => r.json());
    const cores = d.labels.map((_, i) => i === 0 ? '#ffd700' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : 'rgba(77,166,255,0.7)');
    criarOuAtualizar('g-rank-vendedores', 'bar', {
      labels: d.labels,
      datasets: [{ label: 'IQ %', data: d.valores, backgroundColor: cores, borderRadius: 4 }],
    }, { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ...defOpts.scales.x, min: 0, max: 100 }, y: { ticks: { color: '#7070a0', font: { size: 10 } }, grid: { display: false } } } });
  } catch {}
}

async function carregarAtrasosVendedores(p) {
  try {
    const d = await fetch('/api/graficos/atrasos-vendedores?' + p).then(r => r.json());
    criarOuAtualizar('g-atrasos-vendedores', 'bar', {
      labels: d.labels,
      datasets: [
        { label: 'N1 (1-15d)',        data: d.n1,     backgroundColor: 'rgba(255,214,0,0.7)' },
        { label: 'N2 (16-27d)',       data: d.n2,     backgroundColor: 'rgba(255,145,0,0.7)' },
        { label: 'N3 (28-32d)',       data: d.n3,     backgroundColor: 'rgba(255,107,122,0.7)' },
        { label: 'Inadimplente (33+d)', data: d.inadim, backgroundColor: 'rgba(255,61,87,0.8)' },
      ],
    }, { indexAxis: 'y', plugins: { legend: { labels: { color: '#7070a0', font: { size: 10 } } } }, scales: { x: { stacked: true, ticks: { color: '#7070a0' }, grid: { color: 'rgba(30,30,74,0.8)' } }, y: { stacked: true, ticks: { color: '#7070a0', font: { size: 10 } }, grid: { display: false } } } });
  } catch {}
}

async function carregarEstados(p) {
  try {
    const d = await fetch('/api/graficos/estados?' + p).then(r => r.json());
    criarOuAtualizar('g-estados', 'bar', {
      labels: d.labels,
      datasets: [{ label: 'Clientes', data: d.valores, backgroundColor: 'rgba(0,87,255,0.7)', borderRadius: 4 }],
    }, { plugins: { legend: { display: false } }, scales: defOpts.scales });
  } catch {}
}

async function carregarCidades(p) {
  try {
    const d = await fetch('/api/graficos/cidades?' + p).then(r => r.json());
    criarOuAtualizar('g-cidades', 'bar', {
      labels: d.labels,
      datasets: [{ label: 'Clientes', data: d.valores, backgroundColor: 'rgba(77,166,255,0.7)', borderRadius: 4 }],
    }, { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#7070a0' }, grid: { color: 'rgba(30,30,74,0.8)' } }, y: { ticks: { color: '#7070a0', font: { size: 10 } }, grid: { display: false } } } });
  } catch {}
}

async function carregarFunil(p) {
  try {
    const d = await fetch('/api/graficos/funil?' + p).then(r => r.json());
    const cores = ['rgba(0,87,255,0.8)', 'rgba(0,200,83,0.8)', 'rgba(77,166,255,0.8)', 'rgba(255,145,0,0.8)', 'rgba(124,77,255,0.8)'];
    criarOuAtualizar('g-funil', 'bar', {
      labels: d.labels,
      datasets: [{ label: 'Clientes', data: d.valores, backgroundColor: cores, borderRadius: 6 }],
    }, { plugins: { legend: { display: false } }, scales: defOpts.scales });

    const tbl = document.getElementById('funil-tabela');
    if (tbl && d.retencao) {
      tbl.innerHTML = d.retencao.map((r, i) => `
        <div class="funil-row">
          <div>
            <div class="funil-etapa">${r.label}</div>
            <div class="funil-sub">${i === 0 ? 'base' : `−${r.perda.toLocaleString('pt-BR')} nesta etapa`}</div>
          </div>
          <div class="funil-nums">
            <div class="funil-val">${r.valor.toLocaleString('pt-BR')}</div>
            <div class="${i === 0 ? '' : r.pct >= 80 ? 'funil-pct' : 'funil-perda'}">${r.pct}%</div>
          </div>
        </div>`).join('');
    }
  } catch {}
}

// ─── Tabela Principal ─────────────────────────────────────────────────────────

async function carregarTabela() {
  const p = coletarFiltros();
  p.set('pagina', state.pagina);
  p.set('porPagina', 50);
  p.set('ordenar', state.ordenarPor);
  p.set('direcao', state.direcao);
  const busca = document.getElementById('busca-tabela')?.value;
  if (busca) p.set('busca', busca);

  try {
    const d = await fetch('/api/clientes?' + p).then(r => r.json());
    const tbody = document.getElementById('tabela-body');
    if (!d.dados?.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="loading">Nenhum cliente encontrado</td></tr>';
      setText('tabela-info', '0 clientes');
      document.getElementById('paginacao').innerHTML = '';
      return;
    }
    tbody.innerHTML = d.dados.map(c => `<tr>
      <td>${c.cliente || '—'}</td>
      <td>${c.vendedor || '—'}</td>
      <td>${c.safra || '—'}</td>
      <td>${c.plano || '—'}</td>
      <td>${c.estado || '—'}</td>
      <td><span class="nivel-tag nivel-${c.nivelAlerta}">${NIVEL_LABEL[c.nivelAlerta] || c.nivelAlerta}</span></td>
    </tr>`).join('');
    setText('tabela-info', `${d.total.toLocaleString('pt-BR')} clientes`);
    renderPag('paginacao', d.pagina, d.totalPaginas, p => { state.pagina = p; carregarTabela(); });
  } catch {}
}

function ordenar(col) {
  if (state.ordenarPor === col) state.direcao = state.direcao === 'asc' ? 'desc' : 'asc';
  else { state.ordenarPor = col; state.direcao = 'asc'; }
  carregarTabela();
}

// ─── Tabela Risco ─────────────────────────────────────────────────────────────

async function carregarTabelaRisco() {
  const p = coletarFiltros();
  p.set('nivelAlerta', 'N1,N2,N3,INADIMPLENTE');
  p.set('pagina', state.paginaRisco);
  p.set('porPagina', 50);
  if (state.buscaRisco) p.set('busca', state.buscaRisco);

  try {
    const d = await fetch('/api/clientes?' + p).then(r => r.json());
    const tbody = document.getElementById('tbody-risco');
    if (!d.dados?.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="loading">Nenhum cliente em risco</td></tr>';
      setText('tabela-risco-info', '0 clientes');
      document.getElementById('pag-risco').innerHTML = '';
      return;
    }
    tbody.innerHTML = d.dados.map(c => {
      const maxDias = Math.max(0, ...c.faturas.filter(f => f.status === 'ATRASADO').map(f => f.diasAtraso));
      return `<tr>
        <td>${c.cliente || '—'}</td>
        <td>${c.vendedor || '—'}</td>
        <td>${c.safra || '—'}</td>
        <td>${c.plano || '—'}</td>
        <td>${c.estado || '—'}</td>
        <td><span class="nivel-tag nivel-${c.nivelAlerta}">${NIVEL_LABEL[c.nivelAlerta]}</span></td>
        <td>${maxDias > 0 ? maxDias + ' dias' : '—'}</td>
      </tr>`;
    }).join('');
    setText('tabela-risco-info', `${d.total.toLocaleString('pt-BR')} clientes`);
    renderPag('pag-risco', d.pagina, d.totalPaginas, p => { state.paginaRisco = p; carregarTabelaRisco(); });
  } catch {}
}

// ─── Tabela Pago em Atraso ────────────────────────────────────────────────────

async function carregarTabelaPg() {
  const p = coletarFiltros();
  p.set('pagina', state.paginaPg);
  p.set('porPagina', 50);
  if (state.buscaPg) p.set('busca', state.buscaPg);

  try {
    const d = await fetch('/api/clientes?' + p).then(r => r.json());
    const pgClientes = d.dados?.filter(c => c.pgAtraso) || [];
    const tbody = document.getElementById('tbody-pg');
    if (!pgClientes.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="loading">Nenhum cliente com pagamento em atraso</td></tr>';
      setText('tabela-pg-info', '0 clientes');
      return;
    }
    tbody.innerHTML = pgClientes.map(c => `<tr>
      <td>${c.cliente || '—'}</td>
      <td>${c.vendedor || '—'}</td>
      <td>${c.safra || '—'}</td>
      <td>${c.plano || '—'}</td>
      <td>${c.estado || '—'}</td>
    </tr>`).join('');
    setText('tabela-pg-info', `${pgClientes.length.toLocaleString('pt-BR')} clientes`);
  } catch {}
}

function buscarTabela(tipo) {
  if (tipo === 'main') { state.pagina = 1; carregarTabela(); }
  else if (tipo === 'risco') { state.buscaRisco = document.getElementById('busca-risco').value; state.paginaRisco = 1; carregarTabelaRisco(); }
  else if (tipo === 'pg') { state.buscaPg = document.getElementById('busca-pg').value; state.paginaPg = 1; carregarTabelaPg(); }
}

// ─── Paginação ────────────────────────────────────────────────────────────────

function renderPag(elId, pagAtual, totalPag, onPag) {
  const el = document.getElementById(elId);
  if (!el || totalPag <= 1) { if(el) el.innerHTML = ''; return; }
  const pages = [];
  pages.push(`<button onclick="(${onPag.toString()})(${pagAtual-1})" ${pagAtual===1?'disabled':''}>‹</button>`);
  const ini = Math.max(1, pagAtual-2), fim = Math.min(totalPag, pagAtual+2);
  if (ini > 1) pages.push(`<button onclick="(${onPag.toString()})(1)">1</button>`);
  if (ini > 2) pages.push(`<span>…</span>`);
  for (let i = ini; i <= fim; i++) pages.push(`<button onclick="(${onPag.toString()})(${i})" class="${i===pagAtual?'ativa':''}">${i}</button>`);
  if (fim < totalPag-1) pages.push(`<span>…</span>`);
  if (fim < totalPag) pages.push(`<button onclick="(${onPag.toString()})(${totalPag})">${totalPag}</button>`);
  pages.push(`<button onclick="(${onPag.toString()})(${pagAtual+1})" ${pagAtual===totalPag?'disabled':''}>›</button>`);
  el.innerHTML = pages.join('');
}

// ─── Modal Token ──────────────────────────────────────────────────────────────

let _estadoModal = null;

// Abre modal quando robô sinaliza que precisa do token (SSE token-request)
function abrirModalTokenRequest(estado) {
  _estadoModal = estado;
  const lbl = document.getElementById('modal-estado-label');
  if (lbl) lbl.textContent = estado;
  const subtitulo = document.getElementById('modal-token-subtitulo');
  if (subtitulo) subtitulo.textContent = '⚡ Robô pronto! Digite o token AGORA (válido por ~30s):';
  const inp = document.getElementById('modal-token-input');
  inp.value = '';
  document.getElementById('modal-token').style.display = 'flex';
  // Pisca a borda para chamar atenção
  inp.style.border = '2px solid #f59e0b';
  setTimeout(() => inp.focus(), 50);
}

function fecharModalBtn() {
  document.getElementById('modal-token').style.display = 'none';
  _estadoModal = null;
}

function fecharModal(e) {
  if (e.target === document.getElementById('modal-token')) fecharModalBtn();
}

async function confirmarToken() {
  const token = document.getElementById('modal-token-input').value.trim();
  if (!token || token.length < 4) {
    document.getElementById('modal-token-input').focus();
    return;
  }
  const estado = _estadoModal;
  fecharModalBtn();
  adicionarLog(`🔑 Enviando token para Robô ${estado}...`, 'robo');
  try {
    const d = await fetch('/api/comando/token-fornecer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado, token }),
    }).then(r => r.json());
    if (d.erro) adicionarLog(`Erro: ` + d.erro, 'erro');
  } catch (e) { adicionarLog('Erro: ' + e.message, 'erro'); }
}

async function iniciarEstado(estado) {
  adicionarLog(`🤖 Iniciando Robô ${estado}...`, 'robo');
  try {
    const d = await fetch('/api/comando/robo-estado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado }),
    }).then(r => r.json());
    if (d.erro) adicionarLog(`Erro Robô ${estado}: ` + d.erro, 'erro');
    else atualizarCardEstado(estado, 'rodando');
  } catch (e) { adicionarLog('Erro: ' + e.message, 'erro'); }
}

async function pararEstado(estado) {
  adicionarLog(`⏹ Parando Robô ${estado}...`, 'aviso');
  try {
    await fetch('/api/comando/robo-estado-parar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado }),
    });
    atualizarCardEstado(estado, 'parado');
  } catch (e) { adicionarLog('Erro: ' + e.message, 'erro'); }
}

function atualizarCardEstado(estado, status) {
  const card  = document.getElementById(`card-${estado}`);
  const badge = document.getElementById(`badge-${estado}`);
  const btnParar = document.getElementById(`parar-${estado}`);
  if (!card || !badge) return;

  if (status === 'rodando') {
    card.classList.add('rodando');
    badge.textContent = '🟢 rodando';
    badge.className = 'robo-badge rodando';
    if (btnParar) btnParar.disabled = false;
  } else {
    card.classList.remove('rodando');
    badge.textContent = '⏹ parado';
    badge.className = 'robo-badge';
    if (btnParar) btnParar.disabled = true;
  }
}

// ─── Comandos ─────────────────────────────────────────────────────────────────

async function verificarStatusRobo() {
  try {
    const d = await fetch('/api/status-robos').then(r => r.json());
    atualizarBadge('robo', d.robo);
    atualizarBadge('disparo', d.disparo);
    if (d.estados) {
      ['PR', 'SC', 'RS'].forEach(e => atualizarCardEstado(e, d.estados[e]));
    }
  } catch {}
}

// Robô SGR legado (mantido por compatibilidade)
async function iniciarRobo() {
  adicionarLog('Use os botões Robô PR / SC / RS acima.', 'aviso');
}
async function pararRobo() {
  adicionarLog('Parando robô...', 'aviso');
  await fetch('/api/comando/robo-parar', { method: 'POST' }).catch(() => {});
}

async function carregarRelatorios() {
  const sel = document.getElementById('select-relatorio');
  const info = document.getElementById('disparo-relatorio-info');
  try {
    const { arquivos } = await fetch('/api/relatorios').then(r => r.json());
    sel.innerHTML = '<option value="">— Selecione um relatório —</option>';
    if (!arquivos.length) {
      info.textContent = 'Nenhum relatório encontrado em relatorios/';
      return;
    }
    arquivos.forEach((f, i) => {
      const opt = document.createElement('option');
      opt.value = f;
      opt.textContent = f + (i === 0 ? ' (mais recente)' : '');
      if (i === 0) opt.selected = true;
      sel.appendChild(opt);
    });
    info.textContent = `${arquivos.length} relatório(s) disponível(is)`;
    // Carrega info do selecionado
    await atualizarInfoRelatorio();
  } catch (e) {
    info.textContent = 'Erro ao carregar lista: ' + e.message;
  }
}

async function atualizarInfoRelatorio() {
  const sel = document.getElementById('select-relatorio');
  const info = document.getElementById('disparo-relatorio-info');
  const arquivo = sel?.value;
  if (!arquivo) { info.textContent = ''; return; }
  try {
    const d = await fetch(`/api/relatorios/info/${encodeURIComponent(arquivo)}`).then(r => r.json());
    if (d.erro) { info.textContent = d.erro; return; }
    const disp = d.disparados || 0;
    const pend = d.pendentes != null ? d.pendentes : d.total;
    info.textContent = `📋 ${d.total} cliente(s) no relatório · ✅ ${disp} já disparados · ⏳ ${pend} pendentes`;
    info.style.color = pend > 0 ? 'var(--azul-c)' : 'var(--verde)';
  } catch (e) {
    info.textContent = 'Erro ao ler relatório: ' + e.message;
  }
}

function atualizarProgresso(atual, total) {
  const wrap = document.getElementById('disparo-progresso-wrap');
  const bar  = document.getElementById('progresso-bar-fill');
  const pct  = document.getElementById('progresso-pct');
  const lbl  = document.getElementById('progresso-label');
  const sub  = document.getElementById('progresso-sub');
  if (!wrap) return;
  wrap.style.display = 'block';
  const p = total > 0 ? Math.round((atual / total) * 100) : 0;
  bar.style.width = p + '%';
  pct.textContent = p + '%';
  lbl.textContent = atual >= total ? '✅ Disparo concluído!' : '📤 Disparando...';
  sub.textContent = `${atual} / ${total} clientes`;
}

function atualizarBotoesDisparo(rodando) {
  const btnDisparar = document.getElementById('btn-disparar');
  const btnParar = document.getElementById('btn-parar-disparo');
  if (btnDisparar) btnDisparar.style.display = rodando ? 'none' : '';
  if (btnParar) btnParar.style.display = rodando ? '' : 'none';
}

async function dispararFaturas() {
  const sel = document.getElementById('select-relatorio');
  const relatorio = sel ? sel.value : '';
  if (!relatorio) {
    adicionarLog('Selecione um relatório antes de disparar.', 'erro');
    return;
  }
  const limite     = parseInt(document.getElementById('disparo-limite')?.value) || 0;
  const delay      = parseInt(document.getElementById('disparo-delay')?.value) || 30;
  const lote       = parseInt(document.getElementById('disparo-lote')?.value) || 50;
  const pausaLote  = parseInt(document.getElementById('disparo-pausa-lote')?.value) || 300;
  const limiteMsg  = limite > 0 ? ` (teste: ${limite})` : '';
  adicionarLog(`Iniciando disparo: ${relatorio}${limiteMsg} · ${delay}s/envio · lote ${lote} · pausa ${pausaLote}s`, 'disparo-log');
  try {
    const d = await fetch('/api/comando/disparar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relatorio, limite: limite || undefined, delay, lote, pausaLote }),
    }).then(r => r.json());
    if (d.erro) adicionarLog('Erro: ' + d.erro, 'disparo-log');
    else { adicionarLog('Disparando: ' + d.relatorio, 'disparo-log'); atualizarBotoesDisparo(true); }
  } catch (e) { adicionarLog('Erro: ' + e.message, 'disparo-log'); }
}

async function carregarRelatoriosDisparo() {
  const lista = document.getElementById('rel-disparo-lista');
  try {
    const { arquivos } = await fetch('/api/relatorios-disparo').then(r => r.json());
    if (!arquivos.length) {
      lista.innerHTML = '<span class="disparo-info">Nenhum relatório de disparo ainda.</span>';
      return;
    }
    lista.innerHTML = '';
    for (const f of arquivos) {
      // Extrai contagens do JSON de log correspondente se disponível
      const item = document.createElement('div');
      item.className = 'rel-disparo-item';
      // Nome formatado: relatorio_disparo_2026-06-12_12-40 → 12/06/2026 12:40
      const m = f.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
      const label = m ? `${m[3]}/${m[2]}/${m[1]} — ${m[4]}:${m[5]}` : f;
      item.innerHTML = `
        <span class="rel-disparo-nome">📊 ${label}</span>
        <div class="rel-disparo-badges">
          <a href="/api/relatorios-disparo/download/${encodeURIComponent(f)}" class="btn btn-secondary btn-sm" download>⬇ Baixar</a>
        </div>`;
      lista.appendChild(item);
    }
  } catch (e) {
    lista.innerHTML = `<span class="disparo-info">Erro: ${e.message}</span>`;
  }
}

async function pararDisparo() {
  adicionarLog('Interrompendo disparo...', 'disparo-log');
  try {
    const d = await fetch('/api/comando/disparo-parar', { method: 'POST' }).then(r => r.json());
    if (d.erro) adicionarLog('Erro: ' + d.erro, 'disparo-log');
    else { adicionarLog('Disparo interrompido.', 'disparo-log'); atualizarBotoesDisparo(false); }
  } catch (e) { adicionarLog('Erro: ' + e.message, 'disparo-log'); }
}

async function atualizarDados() {
  adicionarLog('Atualizando dados...', 'info');
  try {
    await fetch('/api/atualizar', { method: 'POST' });
    await carregarTudo();
    adicionarLog('Dados atualizados!', 'sucesso');
  } catch (e) { adicionarLog('Erro: ' + e.message, 'erro'); }
}

// ─── Aba Faturas ──────────────────────────────────────────────────────────────

let faturasPagina = 1;
let faturasBuscaAtual = '';
let faturasDebounceTimer = null;

function debounceBuscarFaturas(valor) {
  clearTimeout(faturasDebounceTimer);
  faturasDebounceTimer = setTimeout(() => {
    faturasPagina = 1;
    faturasBuscaAtual = valor.trim();
    carregarFaturas();
  }, 300);
}

async function carregarFaturas(pagina) {
  if (pagina) faturasPagina = pagina;
  const lista = document.getElementById('faturas-lista');
  const totalEl = document.getElementById('faturas-total');
  const paginacaoEl = document.getElementById('faturas-paginacao');

  lista.innerHTML = '<div class="faturas-loading">Carregando...</div>';

  try {
    const params = new URLSearchParams({ busca: faturasBuscaAtual, pagina: faturasPagina });
    const d = await fetch('/api/faturas?' + params).then(r => r.json());

    if (d.erro) { lista.innerHTML = `<div class="faturas-vazio">Erro: ${d.erro}</div>`; return; }

    totalEl.textContent = d.total > 0 ? `${d.total} fatura${d.total !== 1 ? 's' : ''}` : '';

    if (!d.clientes || d.clientes.length === 0) {
      lista.innerHTML = '<div class="faturas-vazio">Nenhuma fatura encontrada</div>';
      paginacaoEl.innerHTML = '';
      return;
    }

    lista.innerHTML = d.clientes.map(c => `
      <div class="fatura-card">
        <div class="fatura-cliente-header">
          <span class="fatura-nome">${c.nome.replace(/_/g, ' ')}</span>
          <span class="fatura-cpf">${c.cpf || ''}</span>
        </div>
        <div class="fatura-items">
          ${c.faturas.map(f => `
            <div class="fatura-item">
              <span class="fatura-mes">${formatarMesAno(f.mesAno)}</span>
              <a class="btn btn-sm btn-secondary fatura-dl" href="/api/faturas/download/${encodeURIComponent(f.arquivo)}" download>⬇ Baixar</a>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    // Paginação
    if (d.paginas > 1) {
      const btns = [];
      if (faturasPagina > 1) btns.push(`<button class="pag-btn" onclick="carregarFaturas(${faturasPagina - 1})">‹ Anterior</button>`);
      btns.push(`<span class="pag-info">${faturasPagina} / ${d.paginas}</span>`);
      if (faturasPagina < d.paginas) btns.push(`<button class="pag-btn" onclick="carregarFaturas(${faturasPagina + 1})">Próxima ›</button>`);
      paginacaoEl.innerHTML = btns.join('');
    } else {
      paginacaoEl.innerHTML = '';
    }
  } catch (e) {
    lista.innerHTML = `<div class="faturas-vazio">Erro ao carregar: ${e.message}</div>`;
  }
}

function formatarMesAno(mesAno) {
  if (!mesAno) return '—';
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const [m, a] = mesAno.split('-');
  const idx = parseInt(m) - 1;
  return (idx >= 0 && idx < 12) ? `${meses[idx]} ${a}` : mesAno;
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
