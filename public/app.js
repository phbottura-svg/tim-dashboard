// ─── Estado Global ────────────────────────────────────────────────────────────

const state = {
  abaAtual: 'dashboard',
  pagina: 1, ordenarPor: 'nome', direcao: 'asc',
  _carregando: false,
};
const graficos = {};

// ─── Cores ───────────────────────────────────────────────────────────────────

const C = {
  verde: '#00c853', laranja: '#ff9100', vermelho: '#ff3d57',
  amarelo: '#ffd600', azul: '#0057ff', azulC: '#4da6ff',
  roxo: '#7c4dff', cinza: '#7070a0',
};

const STATUS_LABEL = { ADIMPLENTE: 'Adimplente', INADIMPLENTE: 'Inadimplente', 'SEM DADOS': 'Sem Dados', CHURN: 'Churn' };
const STATUS_COR = { ADIMPLENTE: C.verde, INADIMPLENTE: C.vermelho, 'SEM DADOS': C.cinza };

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await aplicarModoVps();
  conectarSSE();
  verificarStatusRobo();
  setInterval(verificarStatusRobo, 5000);
  await carregarStatusImportacao();
  await carregarOpcoesFiltros();
  await carregarTudo();
});

async function aplicarModoVps() {
  try {
    const { modo } = await fetch('/api/modo').then(r => r.json());
    if (modo === 'vps') {
      document.querySelectorAll('.apenas-local').forEach(el => el.style.display = 'none');
      const aviso = document.getElementById('aviso-vps');
      if (aviso) aviso.style.display = '';
    }
  } catch {}
}

async function carregarTudo() {
  if (state._carregando) return;
  state._carregando = true;
  try {
    await Promise.all([carregarResumo(), carregarGraficos(), carregarTabela()]);
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
    if (d.tipo === 'robo') atualizarBadge('robo', d.status);
    if (d.tipo === 'disparo') {
      atualizarBadge('disparo', d.status);
      if (d.status) {
        atualizarBotoesDisparo(d.status === 'rodando');
        if (d.status === 'parado') {
          carregarRelatoriosDisparo();
          atualizarInfoRelatorio();
          setTimeout(() => { const w = document.getElementById('disparo-progresso-wrap'); if (w) w.style.display = 'none'; }, 5000);
        }
      }
    }
    if (d.tipo === 'progresso') atualizarProgresso(d.atual, d.total);
    if (d.tipo === 'robo-estado') atualizarCardEstado(d.estado, d.status);
    if (d.tipo === 'token-request') { adicionarLog(d.msg || `⏳ Robô ${d.estado} aguardando token!`, 'aviso'); abrirModalTokenRequest(d.estado); }
    if (d.tipo === 'cache') { carregarStatusImportacao(); if (!state._carregando) carregarTudo(); }
  };
  _sse.onerror = () => { if (_sse) { _sse.close(); _sse = null; } setTimeout(conectarSSE, 5000); };
}

function adicionarLog(msg, tipo = 'info') {
  if (!msg) return;
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
  if (aba === 'comandos') { carregarRelatorios(); carregarRelatoriosDisparo(); }
  if (aba === 'faturas') carregarFaturas(1);
  if (aba === 'ajustes') carregarAjustes();
}

function mudarAbaBtn(aba) {
  const btn = document.querySelector(`.nav-btn[data-tab="${aba}"]`);
  if (btn) mudarAba(btn);
}

// ─── Filtros ──────────────────────────────────────────────────────────────────

async function carregarOpcoesFiltros() {
  try {
    const d = await fetch('/api/filtros/opcoes').then(r => r.json());
    const selMes = document.getElementById('filtro-mesGross');
    d.mesesGross?.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s; selMes.appendChild(o);
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
  const mesGross = document.getElementById('filtro-mesGross')?.value;
  const vendedor = document.getElementById('filtro-vendedor')?.value;
  const estado   = document.getElementById('filtro-estado')?.value;
  const status   = document.getElementById('filtro-status')?.value;
  const contatos = document.getElementById('filtro-contatos')?.value;
  if (mesGross) p.set('mesGross', mesGross);
  if (vendedor) p.set('vendedor', vendedor);
  if (estado)   p.set('estado', estado);
  if (status)   p.set('status', status);
  if (contatos) p.set('contatos', contatos);
  return p;
}

async function aplicarFiltros() {
  state.pagina = 1;
  await carregarTudo();
}

// ─── Importação ───────────────────────────────────────────────────────────────

function mostrarMsg(msg, tipo = 'info') {
  const el = document.getElementById('importar-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.className = `importar-msg importar-msg-${tipo}`;
  setTimeout(() => { el.style.display = 'none'; }, 8000);
}

async function limparBaseClientes() {
  if (!confirm('Remover toda a base de clientes importada?')) return;
  const r = await fetch('/api/limpar-base-clientes', { method: 'DELETE' });
  const d = await r.json();
  if (d.ok) { await carregarStatusImportacao(); await atualizarTudo(); }
  else alert('Erro: ' + d.erro);
}

async function importarClientes(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('btn-importar-clientes');
  btn.textContent = '⏳ Importando...';
  btn.style.opacity = '0.7';
  try {
    const fd = new FormData();
    fd.append('arquivo', file);
    const r = await fetch('/api/importar-clientes', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.erro) { mostrarMsg('❌ Erro: ' + d.erro, 'erro'); }
    else {
      let msg = `✅ ${d.total} clientes importados · ${d.cruzados} cruzados`;
      if (d.warnings?.length) msg += ' · ⚠️ ' + d.warnings.join(' · ');
      mostrarMsg(msg, 'ok');
      await carregarStatusImportacao();
      await carregarOpcoesFiltrosReset();
      await carregarTudo();
    }
  } catch (err) { mostrarMsg('❌ ' + err.message, 'erro'); }
  finally {
    btn.textContent = '📥 Importar Base Clientes (.xlsx)';
    btn.style.opacity = '';
    input.value = '';
  }
}

async function importarSonar(input, estado) {
  const file = input.files[0];
  if (!file) return;
  mostrarMsg(`⏳ Importando ${estado}...`, 'info');
  try {
    const fd = new FormData();
    fd.append('arquivo', file);
    const r = await fetch(`/api/importar-sonar?estado=${estado}`, { method: 'POST', body: fd });
    const d = await r.json();
    if (d.erro) mostrarMsg(`❌ Erro ${estado}: ` + d.erro, 'erro');
    else {
      mostrarMsg(`✅ ${estado}: ${d.total} registros importados · ${d.cruzados} cruzamentos`, 'ok');
      await carregarStatusImportacao();
      await carregarOpcoesFiltrosReset();
      await carregarTudo();
    }
  } catch (err) { mostrarMsg('❌ ' + err.message, 'erro'); }
  finally { input.value = ''; }
}

async function carregarStatusImportacao() {
  try {
    const d = await fetch('/api/importacao/status').then(r => r.json());

    // Status clientes
    const elC = document.getElementById('status-clientes');
    if (elC) {
      const emoji = badgeEmoji(d.clientes.status);
      const ts = d.clientes.importadoEm ? fmtTs(d.clientes.importadoEm) : '';
      elC.textContent = `${emoji} ${ts ? 'Atualizado ' + ts + ' · ' : ''}${d.clientes.total} clientes`;
      elC.className = `importar-status status-${d.clientes.status}`;
    }

    // Status Sonar por estado
    ['PR', 'SC', 'RS'].forEach(est => {
      const el = document.getElementById(`status-sonar-${est}`);
      if (el) {
        const s = d.sonar[est];
        const emoji = badgeEmoji(s.status);
        const ts = s.importadoEm ? fmtTs(s.importadoEm) : '';
        el.textContent = `${emoji} ${est} ${ts ? '— ' + ts + ' · ' : '— '}${s.total} reg`;
        el.className = `importar-status status-${s.status}`;
      }
    });

    // Cruzamento
    const elCruz = document.getElementById('status-cruzamento');
    if (elCruz) {
      const { total, cruzados, semMatch } = d.cruzamento;
      if (total === 0) {
        elCruz.textContent = '— Nenhum dado importado';
      } else {
        elCruz.textContent = `✅ ${cruzados} registros Sonar com cliente · ⚠️ ${semMatch} sem match`;
      }
    }

    // Última atualização
    const elTs = document.getElementById('importar-ultima-ts');
    if (elTs && d.ultimaAtualizacao) {
      elTs.textContent = '🕐 Última atualização: ' + fmtTs(d.ultimaAtualizacao, true);
    }

    // Última atualização no header
    if (d.ultimaAtualizacao) {
      setText('ultima-atualizacao', 'Cruzado: ' + fmtTs(d.ultimaAtualizacao));
    }

    // Badge Ajustes
    const badgeAj = document.getElementById('badge-ajustes');
    if (badgeAj) {
      if (d.cruzamento.semMatch > 0) {
        badgeAj.textContent = d.cruzamento.semMatch;
        badgeAj.style.display = '';
      } else {
        badgeAj.style.display = 'none';
      }
    }
  } catch {}
}

function badgeEmoji(status) {
  if (status === 'hoje') return '🟢';
  if (status === 'ontem') return '🟡';
  return '🔴';
}

function fmtTs(iso, completo = false) {
  const d = new Date(iso);
  const data = d.toLocaleDateString('pt-BR');
  if (completo) return data + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return data;
}

async function carregarOpcoesFiltrosReset() {
  // Recria os selects de filtros com novas opções
  ['filtro-mesGross', 'filtro-vendedor', 'filtro-estado'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<option value="">Todos</option>';
  });
  await carregarOpcoesFiltros();
}

// ─── Resumo / KPIs ───────────────────────────────────────────────────────────

async function carregarResumo() {
  try {
    const p = coletarFiltros();
    const d = await fetch('/api/resumo?' + p).then(r => r.json());
    const fmt = n => (n ?? 0).toLocaleString('pt-BR');
    const pct = (v, t) => t > 0 ? (v / t * 100).toFixed(1) + '%' : '0%';

    setText('v-total', fmt(d.total));
    setText('v-adimplentes', fmt(d.adimplentes));
    setText('v-pct-adim', pct(d.adimplentes, d.total) + ' do total');
    setText('v-inadimplentes', fmt(d.inadimplentes));
    setText('v-pct-inadim', pct(d.inadimplentes, d.total) + ' do total');
    setText('v-churn', fmt(d.churn));
    setText('v-com2', fmt(d.com2Contatos));
    setText('v-pct-com2', pct(d.com2Contatos, d.total) + ' da base');
    setText('v-so1', fmt(d.soSoPrincipal));
    setText('v-pct-so1', pct(d.soSoPrincipal, d.total) + ' da base');
    setText('v-faturas', fmt(d.totalFaturasPdf));
    setText('v-sem-cruzamento', fmt(d.semCruzamento));

    // Cards dinâmicos por fatura
    const grid = document.getElementById('kpi-faturas-grid');
    if (grid && d.faturaStats) {
      grid.innerHTML = Object.entries(d.faturaStats).map(([key, s]) => {
        const n = key.replace('f', '');
        const corPaga = s.pct >= 80 ? 'kpi-verde' : s.pct >= 50 ? 'kpi-amarelo' : 'kpi-vermelho';
        return `<div class="kpi ${corPaga}">
          <div class="kpi-label">Fatura ${n}</div>
          <div class="kpi-value">${s.pct}%</div>
          <div class="kpi-sub">${fmt(s.pagas)} pagas · ${fmt(s.naoPagas)} não pagas · ${fmt(s.total)} clientes</div>
        </div>`;
      }).join('');
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
    carregarEstados(p),
    carregarEvolucao(p),
    carregarVendedores(p),
    carregarDisparos(p),
    carregarRobo(p),
  ]);
}

async function carregarStatusGeral(p) {
  try {
    const d = await fetch('/api/graficos/status-geral?' + p).then(r => r.json());
    const cores = [C.verde, C.vermelho, C.cinza, C.laranja];
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
    const total = d.total || 1;
    const pctAdim = d.valores[0] ? (d.valores[0] / total * 100).toFixed(1) : 0;
    setText('donut-pct', pctAdim + '%');
    const legEl = document.getElementById('donut-legenda');
    if (legEl) {
      legEl.innerHTML = d.labels.map((l, i) => {
        const v = d.valores[i];
        const pct = total > 0 ? (v / total * 100).toFixed(1) : 0;
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

async function carregarEstados(p) {
  try {
    const d = await fetch('/api/graficos/estados?' + p).then(r => r.json());
    criarOuAtualizar('g-estados', 'doughnut', {
      labels: d.labels,
      datasets: [{ data: d.valores, backgroundColor: [C.azulC, C.verde, C.laranja, C.roxo, C.vermelho], borderWidth: 0 }],
    }, { maintainAspectRatio: false, plugins: { legend: { labels: { color: '#7070a0' } } }, scales: {} });
  } catch {}
}

async function carregarEvolucao(p) {
  try {
    const d = await fetch('/api/graficos/evolucao?' + p).then(r => r.json());
    criarOuAtualizar('g-evolucao', 'line', {
      labels: d.labels,
      datasets: [
        { label: 'Adimplentes', data: d.adimplentes, borderColor: C.verde, backgroundColor: 'rgba(0,200,83,0.1)', fill: true, tension: 0.4, pointRadius: 4 },
        { label: 'Inadimplentes', data: d.inadimplentes, borderColor: C.vermelho, backgroundColor: 'rgba(255,61,87,0.1)', fill: true, tension: 0.4, pointRadius: 4 },
      ],
    }, { plugins: { legend: { labels: { color: '#7070a0' } } }, scales: defOpts.scales });
  } catch {}
}

async function carregarVendedores(p) {
  try {
    const d = await fetch('/api/graficos/vendedores?' + p).then(r => r.json());
    criarOuAtualizar('g-vendedores', 'bar', {
      labels: d.labels,
      datasets: [{ label: 'Inadimplentes', data: d.valores, backgroundColor: 'rgba(255,61,87,0.8)', borderRadius: 4 }],
    }, { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#7070a0' }, grid: { color: 'rgba(30,30,74,0.8)' } }, y: { ticks: { color: '#7070a0', font: { size: 10 } }, grid: { display: false } } } });
  } catch {}
}

async function carregarDisparos(p) {
  try {
    const d = await fetch('/api/graficos/disparos').then(r => r.json());
    criarOuAtualizar('g-disparos', 'bar', {
      labels: d.labels,
      datasets: [{ label: 'Faturas Enviadas', data: d.valores, backgroundColor: 'rgba(77,166,255,0.7)', borderRadius: 4 }],
    }, { plugins: { legend: { display: false } }, scales: defOpts.scales });
  } catch {}
}

async function carregarRobo(p) {
  try {
    const d = await fetch('/api/graficos/robo').then(r => r.json());
    criarOuAtualizar('g-robo', 'line', {
      labels: d.labels,
      datasets: [{ label: 'Faturas Baixadas', data: d.valores, borderColor: C.amarelo, backgroundColor: 'rgba(255,214,0,0.1)', fill: true, tension: 0.4, pointRadius: 3 }],
    }, { plugins: { legend: { display: false } }, scales: defOpts.scales });
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
  const statusTabela = document.getElementById('tabela-filtro-status')?.value;
  if (statusTabela) p.set('statusTabela', statusTabela);
  const ufTabela = document.getElementById('tabela-filtro-uf')?.value;
  if (ufTabela) p.set('uf', ufTabela);
  if (document.getElementById('tabela-filtro-churn')?.checked) p.set('churn', '1');
  if (document.getElementById('tabela-filtro-sem-match')?.checked) p.set('semMatch', '1');
  for (let n = 1; n <= 5; n++) {
    const v = document.getElementById(`tf-f${n}`)?.value;
    if (v) p.set(`f${n}`, v);
  }

  try {
    const d = await fetch('/api/clientes?' + p).then(r => r.json());
    const tbody = document.getElementById('tabela-body');
    if (!d.dados?.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="loading">Nenhum cliente encontrado</td></tr>';
      setText('tabela-info', '0 clientes');
      document.getElementById('paginacao').innerHTML = '';
      return;
    }
    // Descobre número máximo de faturas para gerar colunas dinâmicas
    const maxF = Math.max(0, ...d.dados.map(c => c.totalFaturas || 0));
    // Atualiza cabeçalho com colunas de fatura
    const thead = document.getElementById('tabela-thead');
    if (thead) {
      const fCols = Array.from({length: maxF}, (_, i) => `<th>F${i+1}</th>`).join('');
      thead.innerHTML = `<tr>
        <th onclick="ordenar('nome')">Cliente ↕</th>
        <th onclick="ordenar('cpf')">CPF ↕</th>
        <th onclick="ordenar('os')">OS ↕</th>
        <th onclick="ordenar('vendedor')">Vendedor ↕</th>
        <th onclick="ordenar('uf')">UF ↕</th>
        <th onclick="ordenar('mesGross')">Mês Gross ↕</th>
        <th onclick="ordenar('totalFaturas')">Faturas ↕</th>
        <th onclick="ordenar('status')">Status ↕</th>
        <th>Churn</th>
        ${fCols}
      </tr>`;
    }
    tbody.innerHTML = d.dados.map(c => {
      const fCells = Array.from({length: maxF}, (_, i) => {
        const fat = (c.faturas || []).find(f => f.numero === i + 1);
        if (!fat) return '<td class="dim">—</td>';
        const cls = fat.status === 'ADIMPLENTE' ? 'status-ADIMPLENTE' : fat.status === 'INADIMPLENTE' ? 'status-INADIMPLENTE' : '';
        const label = fat.detalhamento || fat.statusPagamento || '—';
        return `<td><span class="status-tag ${cls}" title="${label}">${fat.status === 'ADIMPLENTE' ? '✅' : fat.status === 'INADIMPLENTE' ? '❌' : '—'} ${fat.dataVencimento || ''}</span></td>`;
      }).join('');
      return `<tr>
        <td>${c.nome || '<em class="dim">Sem match</em>'}</td>
        <td class="cpf-col">${c.cpf || '—'}</td>
        <td class="os-col">${c.os || '—'}</td>
        <td>${c.vendedor || '—'}</td>
        <td>${c.uf || '—'}</td>
        <td>${c.mesGross || '—'}</td>
        <td>${c.totalFaturas || 0} (${c.faturasPagas || 0} pagas)</td>
        <td><span class="status-tag status-${(c.status||'SEM_DADOS').replace(' ','_')}">${STATUS_LABEL[c.status]||c.status||'—'}</span></td>
        <td>${c.churn ? '⚠️' : '—'}</td>
        ${fCells}
      </tr>`;
    }).join('');
    setText('tabela-info', `${d.total.toLocaleString('pt-BR')} clientes`);
    const btnExp = document.getElementById('btn-exportar-clientes');
    if (btnExp) btnExp.href = '/api/clientes/exportar?' + p;
    renderPag('paginacao', d.pagina, d.totalPaginas, pg => { state.pagina = pg; carregarTabela(); });
  } catch {}
}

function ordenar(col) {
  if (state.ordenarPor === col) state.direcao = state.direcao === 'asc' ? 'desc' : 'asc';
  else { state.ordenarPor = col; state.direcao = 'asc'; }
  carregarTabela();
}

function buscarTabela() {
  state.pagina = 1;
  carregarTabela();
}

function limparFiltrosFaturas() {
  for (let n = 1; n <= 5; n++) {
    const el = document.getElementById(`tf-f${n}`);
    if (el) el.value = '';
  }
  buscarTabela();
}

// ─── Paginação ────────────────────────────────────────────────────────────────

function renderPag(elId, pagAtual, totalPag, onPag) {
  const el = document.getElementById(elId);
  if (!el || totalPag <= 1) { if (el) el.innerHTML = ''; return; }
  const pages = [];
  pages.push(`<button onclick="(${onPag.toString()})(${pagAtual - 1})" ${pagAtual === 1 ? 'disabled' : ''}>‹</button>`);
  const ini = Math.max(1, pagAtual - 2), fim = Math.min(totalPag, pagAtual + 2);
  if (ini > 1) pages.push(`<button onclick="(${onPag.toString()})(1)">1</button>`);
  if (ini > 2) pages.push(`<span>…</span>`);
  for (let i = ini; i <= fim; i++) pages.push(`<button onclick="(${onPag.toString()})(${i})" class="${i === pagAtual ? 'ativa' : ''}">${i}</button>`);
  if (fim < totalPag - 1) pages.push(`<span>…</span>`);
  if (fim < totalPag) pages.push(`<button onclick="(${onPag.toString()})(${totalPag})">${totalPag}</button>`);
  pages.push(`<button onclick="(${onPag.toString()})(${pagAtual + 1})" ${pagAtual === totalPag ? 'disabled' : ''}>›</button>`);
  el.innerHTML = pages.join('');
}

// ─── Aba Ajustes ──────────────────────────────────────────────────────────────

let ajusteClientesAtual = [];

async function carregarAjustes() {
  const mesSel = document.getElementById('ajustes-filtro-mes')?.value || '';
  const tbody = document.getElementById('ajustes-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Carregando...</td></tr>';

  try {
    const d = await fetch('/api/ajustes/resumo').then(r => r.json());
    setText('ajustes-total-label', `Total sem cruzamento: ${d.total}`);

    // Popula filtro de mês
    const sel = document.getElementById('ajustes-filtro-mes');
    const mesAnterior = sel.value;
    sel.innerHTML = '<option value="">Todos os meses</option>' +
      (d.grupos || []).map(g => `<option value="${g.mes}" ${g.mes === mesAnterior ? 'selected' : ''}>${g.mes} (${g.total})</option>`).join('');

    // Atualiza link exportar
    const btnExp = document.getElementById('btn-exportar-mes');
    if (btnExp) btnExp.href = mesSel ? `/api/ajustes/exportar/${encodeURIComponent(mesSel)}` : '/api/ajustes/exportar/';

    // Carrega clientes do mês selecionado ou todos
    let clientes = [];
    if (mesSel) {
      const r = await fetch(`/api/ajustes/mes/${encodeURIComponent(mesSel)}`).then(r => r.json());
      clientes = r.clientes || [];
    } else {
      const r = await fetch('/api/ajustes/todos').then(r => r.json());
      clientes = r.clientes || [];
    }

    ajusteClientesAtual = clientes;
    renderTabelaAjustes(clientes);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">Erro: ${err.message}</td></tr>`;
  }
}

function renderTabelaAjustes(clientes) {
  const tbody = document.getElementById('ajustes-tbody');
  if (!clientes.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading">✅ Nenhum cliente pendente</td></tr>';
    return;
  }
  tbody.innerHTML = clientes.map((c, i) => `
    <tr id="ajuste-row-${i}">
      <td>${i + 1}</td>
      <td>${c.nome || '—'}</td>
      <td class="cpf-col">${c.cpf || '—'}</td>
      <td>${c.mesGrossManual || '<em class="dim">Sem data</em>'}</td>
      <td id="os-cell-${i}" class="os-edit-cell">
        <span class="os-valor">${c.os || '<em class="dim">vazio</em>'}</span>
        <button class="btn-edit-os" onclick="editarOS(${i})" title="Editar OS">✏️</button>
      </td>
      <td id="status-cell-${i}">
        <span class="ajuste-pendente">Pendente</span>
      </td>
    </tr>
  `).join('');
}

function filtrarTabelaAjustes() {
  const busca = document.getElementById('busca-ajustes')?.value.toLowerCase() || '';
  const filtrados = ajusteClientesAtual.filter(c =>
    (c.nome || '').toLowerCase().includes(busca) ||
    (c.cpf || '').includes(busca) ||
    (c.os || '').includes(busca)
  );
  renderTabelaAjustes(filtrados);
}

function editarOS(idx) {
  const cell = document.getElementById(`os-cell-${idx}`);
  const c = ajusteClientesAtual[idx];
  if (!cell) return;
  cell.innerHTML = `
    <input type="text" class="os-input" id="os-input-${idx}" value="${c.os || ''}" placeholder="Digite a OS…" />
    <button class="btn btn-success btn-sm" onclick="salvarOS(${idx})">✓</button>
    <button class="btn btn-secondary btn-sm" onclick="cancelarOS(${idx}, '${(c.os || '').replace(/'/g, "\\'")}')">✕</button>
  `;
  const inp = document.getElementById(`os-input-${idx}`);
  inp.focus();
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') salvarOS(idx); if (e.key === 'Escape') cancelarOS(idx, c.os || ''); });
}

async function salvarOS(idx) {
  const inp = document.getElementById(`os-input-${idx}`);
  const c = ajusteClientesAtual[idx];
  const osNova = inp?.value.trim();
  if (!osNova) return;

  try {
    const r = await fetch('/api/corrigir-os', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: c.nome, cpf: c.cpf, osAntiga: c.os || '', osNova }),
    });
    const d = await r.json();
    if (d.erro) { alert('Erro: ' + d.erro); return; }

    ajusteClientesAtual[idx].os = osNova;
    const cell = document.getElementById(`os-cell-${idx}`);
    if (cell) cell.innerHTML = `<span class="os-valor">${osNova}</span> <button class="btn-edit-os" onclick="editarOS(${idx})" title="Editar OS">✏️</button>`;
    const statusCell = document.getElementById(`status-cell-${idx}`);
    if (statusCell) statusCell.innerHTML = `<span class="ajuste-corrigido">✅ Corrigido</span>`;
    await carregarStatusImportacao();
  } catch (err) { alert('Erro: ' + err.message); }
}

function cancelarOS(idx, osOriginal) {
  const cell = document.getElementById(`os-cell-${idx}`);
  if (cell) cell.innerHTML = `<span class="os-valor">${osOriginal || '<em class="dim">vazio</em>'}</span> <button class="btn-edit-os" onclick="editarOS(${idx})" title="Editar OS">✏️</button>`;
}

// ─── Modal Token ──────────────────────────────────────────────────────────────

let _estadoModal = null;

function abrirModalTokenRequest(estado) {
  _estadoModal = estado;
  setText('modal-estado-label', estado);
  const inp = document.getElementById('modal-token-input');
  inp.value = '';
  document.getElementById('modal-token').style.display = 'flex';
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
  if (!token || token.length < 4) { document.getElementById('modal-token-input').focus(); return; }
  const estado = _estadoModal;
  fecharModalBtn();
  adicionarLog(`🔑 Enviando token para Robô ${estado}...`, 'robo');
  try {
    const d = await fetch('/api/comando/token-fornecer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado, token }),
    }).then(r => r.json());
    if (d.erro) adicionarLog('Erro: ' + d.erro, 'erro');
  } catch (e) { adicionarLog('Erro: ' + e.message, 'erro'); }
}

// ─── Robôs por Estado ────────────────────────────────────────────────────────

async function iniciarEstado(estado) {
  adicionarLog(`🤖 Iniciando Robô ${estado}...`, 'robo');
  try {
    const d = await fetch('/api/comando/robo-estado', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado }),
    });
    atualizarCardEstado(estado, 'parado');
  } catch (e) { adicionarLog('Erro: ' + e.message, 'erro'); }
}

function atualizarCardEstado(estado, status) {
  const card = document.getElementById(`card-${estado}`);
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

async function verificarStatusRobo() {
  try {
    const d = await fetch('/api/status-robos').then(r => r.json());
    atualizarBadge('robo', d.robo);
    atualizarBadge('disparo', d.disparo);
    if (d.estados) ['PR', 'SC', 'RS'].forEach(e => atualizarCardEstado(e, d.estados[e]));
  } catch {}
}

// ─── Disparo ──────────────────────────────────────────────────────────────────

async function carregarRelatorios() {
  const sel = document.getElementById('select-relatorio');
  const info = document.getElementById('disparo-relatorio-info');
  try {
    const { arquivos } = await fetch('/api/relatorios').then(r => r.json());
    sel.innerHTML = '<option value="">— Selecione um relatório —</option>';
    if (!arquivos.length) { if (info) info.textContent = 'Nenhum relatório encontrado em relatorios/'; return; }
    arquivos.forEach((f, i) => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f + (i === 0 ? ' (mais recente)' : '');
      if (i === 0) opt.selected = true;
      sel.appendChild(opt);
    });
    if (info) info.textContent = `${arquivos.length} relatório(s) disponível(is)`;
    await atualizarInfoRelatorio();
  } catch (e) { if (info) info.textContent = 'Erro ao carregar lista: ' + e.message; }
}

async function atualizarInfoRelatorio() {
  const sel = document.getElementById('select-relatorio');
  const info = document.getElementById('disparo-relatorio-info');
  const arquivo = sel?.value;
  if (!arquivo) { if (info) info.textContent = ''; return; }
  try {
    const d = await fetch(`/api/relatorios/info/${encodeURIComponent(arquivo)}`).then(r => r.json());
    if (d.erro) { if (info) info.textContent = d.erro; return; }
    const pend = d.pendentes != null ? d.pendentes : d.total;
    if (info) {
      info.textContent = `📋 ${d.total} cliente(s) · ✅ ${d.disparados || 0} já disparados · ⏳ ${pend} pendentes`;
      info.style.color = pend > 0 ? 'var(--azul-c)' : 'var(--verde)';
    }
  } catch (e) { if (info) info.textContent = 'Erro ao ler relatório: ' + e.message; }
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
  if (!relatorio) { adicionarLog('Selecione um relatório antes de disparar.', 'erro'); return; }
  const limite = parseInt(document.getElementById('disparo-limite')?.value) || 0;
  const delay = parseInt(document.getElementById('disparo-delay')?.value) || 30;
  const lote = parseInt(document.getElementById('disparo-lote')?.value) || 50;
  const pausaLote = parseInt(document.getElementById('disparo-pausa-lote')?.value) || 300;
  adicionarLog(`Iniciando disparo: ${relatorio} · ${delay}s/envio`, 'disparo-log');
  try {
    const d = await fetch('/api/comando/disparar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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
    if (!arquivos.length) { lista.innerHTML = '<span class="disparo-info">Nenhum relatório de disparo ainda.</span>'; return; }
    lista.innerHTML = '';
    for (const f of arquivos) {
      const item = document.createElement('div');
      item.className = 'rel-disparo-item';
      const m = f.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
      const label = m ? `${m[3]}/${m[2]}/${m[1]} — ${m[4]}:${m[5]}` : f;
      item.innerHTML = `<span class="rel-disparo-nome">📊 ${label}</span>
        <div class="rel-disparo-badges">
          <a href="/api/relatorios-disparo/download/${encodeURIComponent(f)}" class="btn btn-secondary btn-sm" download>⬇ Baixar</a>
        </div>`;
      lista.appendChild(item);
    }
  } catch (e) { lista.innerHTML = `<span class="disparo-info">Erro: ${e.message}</span>`; }
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
  adicionarLog('Recruzando dados...', 'info');
  try {
    await fetch('/api/atualizar', { method: 'POST' });
    await carregarStatusImportacao();
    await carregarOpcoesFiltrosReset();
    await carregarTudo();
    adicionarLog('Dados recruzados!', 'sucesso');
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
      paginacaoEl.innerHTML = ''; return;
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
    if (d.paginas > 1) {
      const btns = [];
      if (faturasPagina > 1) btns.push(`<button class="pag-btn" onclick="carregarFaturas(${faturasPagina - 1})">‹ Anterior</button>`);
      btns.push(`<span class="pag-info">${faturasPagina} / ${d.paginas}</span>`);
      if (faturasPagina < d.paginas) btns.push(`<button class="pag-btn" onclick="carregarFaturas(${faturasPagina + 1})">Próxima ›</button>`);
      paginacaoEl.innerHTML = btns.join('');
    } else { paginacaoEl.innerHTML = ''; }
  } catch (e) { lista.innerHTML = `<div class="faturas-vazio">Erro ao carregar: ${e.message}</div>`; }
}

function formatarMesAno(mesAno) {
  if (!mesAno) return '—';
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const [m, a] = mesAno.split('-');
  const idx = parseInt(m) - 1;
  return (idx >= 0 && idx < 12) ? `${meses[idx]} ${a}` : mesAno;
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
