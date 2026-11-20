// ─── Aba "Risco IQ" ──────────────────────────────────────────────────────────
// Alerta antecipado do IQ: quem ainda dá para salvar (1–30 dias de atraso) e
// quem já afetou o IQ (+30). O cálculo está no servidor (lib/risco-iq.js) —
// aqui só desenha. Depende de escaparHtml() e renderPag() do app.js.

const RISCO_FAIXAS = [
  { chave: 'avencer',  rotulo: 'A vencer',      sub: 'vence em até 7 dias',           cor: '#9B8CFF', classe: 'risco-k-avencer' },
  { chave: 'd1_10',    rotulo: '1 a 10 dias',   sub: 'atraso recente',                cor: '#F0B90B', classe: 'risco-k-d1' },
  { chave: 'd11_20',   rotulo: '11 a 20 dias',  sub: 'atenção',                       cor: '#FF9142', classe: 'risco-k-d2' },
  { chave: 'd21_30',   rotulo: '21 a 30 dias',  sub: 'crítico — últimos dias',        cor: '#FF6B4A', classe: 'risco-k-d3' },
  { chave: 'queimado', rotulo: 'Mais de 30 dias', sub: 'já afetou o IQ',              cor: '#FF4757', classe: 'risco-k-queimado' },
];

const risco = {
  modo: 'safra',
  faixa: '',
  pagina: 1,
  opcoesCarregadas: false,
  timerBusca: null,
  reqId: 0,
};

function riscoFmtPct(v) { return v == null ? '—' : `${String(v).replace('.', ',')}%`; }
function riscoFmtNum(n) { return Number(n || 0).toLocaleString('pt-BR'); }

function riscoMudarModo(modo) {
  if (risco.modo === modo) return;
  risco.modo = modo;
  risco.faixa = '';
  risco.pagina = 1;
  document.getElementById('risco-modo-safra').classList.toggle('ativo', modo === 'safra');
  document.getElementById('risco-modo-mes').classList.toggle('ativo', modo === 'mes');
  document.getElementById('risco-grupo-safra').style.display = modo === 'safra' ? '' : 'none';
  document.getElementById('risco-grupo-mes').style.display = modo === 'mes' ? '' : 'none';
  carregarRisco();
}

function riscoFiltrar(resetPagina = true) {
  if (resetPagina) risco.pagina = 1;
  carregarRisco();
}

function riscoBuscaDebounce() {
  clearTimeout(risco.timerBusca);
  risco.timerBusca = setTimeout(() => riscoFiltrar(), 350);
}

function riscoFiltrarFaixa(chave) {
  risco.faixa = risco.faixa === chave ? '' : chave;
  risco.pagina = 1;
  carregarRisco();
}

function riscoFiltrarLinha(nome) {
  if (risco.modo === 'safra') {
    const sel = document.getElementById('risco-safra');
    if ([...sel.options].some(o => o.value === nome)) sel.value = nome;
  } else {
    const sel = document.getElementById('risco-estado');
    if ([...sel.options].some(o => o.value === nome)) sel.value = nome;
  }
  riscoFiltrar();
}

function riscoQuery() {
  const p = new URLSearchParams();
  p.set('modo', risco.modo);
  if (risco.modo === 'safra') {
    const v = document.getElementById('risco-safra').value;
    if (v) p.set('safra', v);
  } else {
    const v = document.getElementById('risco-mesvenc').value;
    if (v) p.set('mesVenc', v);
  }
  const estado = document.getElementById('risco-estado').value;
  const vend = document.getElementById('risco-vendedor').value;
  const busca = document.getElementById('risco-busca').value.trim();
  const cobranca = document.getElementById('risco-cobranca').value;
  if (estado) p.set('estado', estado);
  if (vend) p.set('vendedor', vend);
  if (busca) p.set('busca', busca);
  if (cobranca) p.set('cobranca', cobranca);
  if (risco.faixa) p.set('faixa', risco.faixa);
  p.set('ordenar', document.getElementById('risco-ordenar').value);
  p.set('pagina', risco.pagina);
  p.set('porPagina', 50);
  return p.toString();
}

// Baixa a lista inteira (sem paginar) com os filtros que estão na tela.
function riscoExportar() {
  const p = new URLSearchParams(riscoQuery());
  p.delete('pagina');
  p.delete('porPagina');
  const a = document.createElement('a');
  a.href = '/api/risco-iq/exportar?' + p.toString();
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Registra a cobrança direto na linha (usa as anotações do cliente).
async function riscoAcao(os, tipo, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/risco-iq/cobranca/' + encodeURIComponent(os), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || `HTTP ${r.status}`);
    await carregarRisco();
  } catch (e) {
    if (btn) btn.disabled = false;
    alert('Não foi possível registrar: ' + e.message);
  }
}

function riscoCelulaCobranca(c) {
  const cb = c.cobranca || { status: 'pendente' };
  const os = escaparHtml(c.os);
  if (cb.status === 'pendente') {
    return `<div class="risco-cob">
      <button type="button" class="risco-cob-btn" onclick="riscoAcao('${os}','cobrado',this)" title="Registrar que já cobrei este cliente">📞 Cobrei</button>
      <button type="button" class="risco-cob-btn" onclick="riscoAcao('${os}','promessa',this)" title="Cliente prometeu pagar">🤝 Prometeu</button>
    </div>`;
  }
  const quando = cb.diasDesde == null ? '' : (cb.diasDesde === 0 ? 'hoje' : `há ${cb.diasDesde}d`);
  const quem = cb.ultimaPor ? ` · ${escaparHtml(cb.ultimaPor)}` : '';
  const rot = cb.status === 'promessa' ? '🤝 Prometeu pagar' : '📞 Cobrado';
  return `<div class="risco-cob">
    <span class="risco-cob-chip ${cb.status}" title="Última ação registrada">${rot}${quando ? ' ' + quando : ''}${quem}</span>
    ${cb.status === 'cobrado' ? `<button type="button" class="risco-cob-btn" onclick="riscoAcao('${os}','promessa',this)" title="Cliente prometeu pagar">🤝</button>` : ''}
    <button type="button" class="risco-cob-btn desfazer" onclick="riscoAcao('${os}','limpar',this)" title="Desfazer o registro de cobrança">↩</button>
  </div>`;
}

// Preenche os selects só na primeira carga (preservando a escolha do usuário
// nas seguintes). Safra e mês só mudam quando a base é reimportada.
function riscoPreencherOpcoes(op, ref) {
  if (risco.opcoesCarregadas) return;
  const selSafra = document.getElementById('risco-safra');
  selSafra.innerHTML = '<option value="">Todas em andamento</option>' +
    [...op.safras].reverse().map(s =>
      `<option value="${escaparHtml(s.valor)}">${escaparHtml(s.valor)}${s.fechada ? ' (fechada)' : ''}</option>`).join('');

  const selMes = document.getElementById('risco-mesvenc');
  const mesAtual = ref.mesVenc || '';
  selMes.innerHTML = [...op.mesesVenc].reverse().map(m =>
    `<option value="${escaparHtml(m)}">${escaparHtml(m)}</option>`).join('');
  if (mesAtual) selMes.value = mesAtual;

  document.getElementById('risco-estado').innerHTML = '<option value="">Todos</option>' +
    op.estados.map(e => `<option value="${escaparHtml(e)}">${escaparHtml(e)}</option>`).join('');
  document.getElementById('risco-vendedor').innerHTML = '<option value="">Todos</option>' +
    op.vendedores.map(v => `<option value="${escaparHtml(v)}">${escaparHtml(v)}</option>`).join('');
  risco.opcoesCarregadas = true;
}

async function carregarRisco() {
  const meuId = ++risco.reqId;
  const tbody = document.getElementById('risco-tbody');
  if (tbody && !tbody.children.length) tbody.innerHTML = '<tr><td colspan="12" class="loading">Carregando…</td></tr>';
  try {
    const resp = await fetch('/api/risco-iq?' + riscoQuery());
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d = await resp.json();
    if (meuId !== risco.reqId) return; // chegou uma resposta mais nova — ignora esta
    riscoPreencherOpcoes(d.opcoes, d.referencia);
    riscoRenderAviso(d);
    riscoRenderExplica(d);
    riscoRenderKpis(d);
    riscoRenderImpacto(d);
    riscoRenderLista(d);
    riscoRenderGraficoDist(d);
    riscoCarregarHistorico();
    riscoCarregarCampanha();
    riscoAtualizarBadge(d.contadores);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="12" class="loading">Não foi possível carregar: ${escaparHtml(e.message)}</td></tr>`;
  }
}

// Badge no menu: quantos clientes estão na faixa crítica (21–30 dias).
function riscoAtualizarBadge(c) {
  const b = document.getElementById('badge-risco');
  if (!b) return;
  const n = c.d21_30 || 0;
  b.textContent = n > 999 ? '999+' : n;
  b.style.display = n > 0 ? '' : 'none';
}

// Carrega o badge sem precisar abrir a aba (chamado ao entrar no VPS).
async function carregarBadgeRisco() {
  try {
    const d = await fetch('/api/risco-iq?porPagina=1').then(r => r.json());
    if (d && d.contadores) riscoAtualizarBadge(d.contadores);
  } catch {}
}

function riscoRenderAviso(d) {
  const el = document.getElementById('risco-aviso');
  const dias = d.dados?.defasagemDias;
  const ds = d.dados?.sonar || {};
  const datas = Object.entries(ds).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (dias == null) {
    el.style.display = '';
    el.innerHTML = '⚠️ Não encontrei a data da última atualização do Sonar — confira se a base foi importada.';
  } else if (dias >= 2) {
    el.style.display = '';
    el.innerHTML = `⚠️ <strong>Dados do Sonar com ${dias} dias de defasagem</strong> (${escaparHtml(datas)}). ` +
      'Os dias de atraso são contados até hoje, então podem estar exagerados — atualize a base antes de cobrar.';
  } else {
    el.style.display = 'none';
  }
}

function riscoRenderExplica(d) {
  const el = document.getElementById('risco-explica');
  const hoje = d.referencia.hoje;
  const safraSel = d.referencia.safra;
  const info = d.opcoes.safras.find(s => s.valor === safraSel);
  let txt;
  if (d.modo === 'safra') {
    txt = `Regra do IQ: fatura da janela da safra com <strong>mais de 30 dias de atraso</strong> já afetou o IQ. ` +
      `De 1 a 30 dias ainda dá para salvar — basta o cliente pagar dentro do prazo. Posição em <strong>${escaparHtml(hoje)}</strong>.`;
    if (d.referencia?.corte && !info?.fechada) {
      txt += ` O IQ é medido no fechamento da safra (<strong>${escaparHtml(d.referencia.corte)}</strong>): ` +
        `só é risco a fatura que passa de 30 dias de atraso até essa data. Atraso que não chega lá não afeta o IQ desta safra.`;
    }
    if (info?.fechada) {
      txt += ` <strong>Safra fechada${info.oficial ? ' (fechamento oficial da TIM)' : ''}:</strong> o IQ vale na data de corte e não muda mais; os números mostram como ficou.`;
    } else if (!safraSel && d.opcoes.safras.every(s => s.fechada)) {
      txt += ' <strong>Não há safra em andamento</strong> — escolha uma safra acima para ver como ela fechou.';
    }
  } else {
    txt = `Mês a mês: faturas com vencimento em <strong>${escaparHtml(d.referencia.mesVenc || '—')}</strong>, ` +
      `contando o atraso até <strong>${escaparHtml(hoje)}</strong>. Clientes cancelados (churn) ficam de fora.`;
  }
  el.innerHTML = txt;
}

function riscoRenderKpis(d) {
  const c = d.contadores;
  const ativa = risco.faixa;
  const cartoes = RISCO_FAIXAS.map(f => `
    <button type="button" class="kpi risco-kpi ${f.classe} ${ativa === f.chave ? 'selecionado' : ''}"
            onclick="riscoFiltrarFaixa('${f.chave}')" title="Clique para filtrar a lista">
      <div class="kpi-label">${f.rotulo}</div>
      <div class="kpi-value">${riscoFmtNum(c[f.chave])}</div>
      <div class="kpi-sub">${f.sub}</div>
    </button>`).join('');

  const salvaveis = `
    <button type="button" class="kpi kpi-destaque risco-kpi risco-k-salvar ${ativa === 'emRisco' ? 'selecionado' : ''}"
            onclick="riscoFiltrarFaixa('emRisco')" title="Clique para filtrar a lista">
      <div class="kpi-label">Ainda dá para salvar</div>
      <div class="kpi-value">${riscoFmtNum(c.emRisco)}</div>
      <div class="kpi-sub">${d.modo === 'safra' ? 'vão passar de 30 dias antes do fechamento' : '1 a 30 dias de atraso'}${c.emRisco ? `<br><strong class="risco-pend">${riscoFmtNum(c.emRiscoPendentes)} sem cobrança</strong>` : ''}</div>
    </button>`;
  document.getElementById('risco-kpis').innerHTML = salvaveis + cartoes;

  const extras = [];
  if (c.emRisco) {
    const cobrados = c.emRisco - (c.emRiscoPendentes || 0);
    extras.push(`<span title="Dos clientes que ainda dá para salvar"><strong>${riscoFmtNum(cobrados)}</strong> de ${riscoFmtNum(c.emRisco)} já cobrados</span>`);
  }
  extras.push(`<span><strong>${riscoFmtNum(c.ok - (c.semRisco || 0))}</strong> em dia</span>`);
  if (d.modo === 'safra' && c.semRisco) {
    extras.push(`<span title="Têm fatura atrasada, mas ela não passa de 30 dias até o fechamento da safra — não afeta o IQ"><strong>${riscoFmtNum(c.semRisco)}</strong> atrasados sem risco para o IQ</span>`);
  }
  extras.push(`<span><strong>${riscoFmtNum(c.total)}</strong> clientes no recorte</span>`);
  if (d.modo === 'safra' && c.semDados) extras.push(`<span title="Sem nenhuma fatura no Sonar — não dá para medir atraso"><strong>${riscoFmtNum(c.semDados)}</strong> sem dados no Sonar</span>`);
  if (d.modo === 'mes' && c.churn) extras.push(`<span title="Clientes cancelados, fora da cobrança"><strong>${riscoFmtNum(c.churn)}</strong> churn (fora da conta)</span>`);
  document.getElementById('risco-extras').innerHTML = extras.join('<i>·</i>');
}

// Mapa de calor: linhas = safra (ou estado), colunas = faixas de atraso. A cor
// da célula cresce com a fatia de clientes da linha naquela faixa.
function riscoCelula(n, total, cor) {
  if (!n) return '<td class="risco-cel zero">–</td>';
  const intensidade = Math.min(0.62, 0.14 + (n / Math.max(total, 1)) * 2.2);
  return `<td class="risco-cel" style="background:${cor}${Math.round(intensidade * 255).toString(16).padStart(2, '0')}">${riscoFmtNum(n)}</td>`;
}

function riscoRenderImpacto(d) {
  const ehSafra = d.modo === 'safra';
  document.getElementById('risco-impacto-titulo').textContent = ehSafra ? 'Impacto no IQ por safra' : 'Distribuição por estado';
  document.getElementById('risco-impacto-sub').textContent = ehSafra
    ? 'IQ hoje × IQ se ninguém que ainda pode queimar pagar a tempo · clique numa linha para filtrar'
    : 'Clique numa linha para filtrar';

  const cab = `<tr>
    <th>${d.distribuicao.rotulo}</th><th>Clientes</th><th>Em dia</th>
    ${ehSafra ? '<th title="Têm fatura atrasada, mas ela não passa de 30 dias até o fechamento da safra — não afeta o IQ">Atraso sem risco</th>' : ''}
    <th>A vencer</th><th>1–10</th><th>11–20</th><th>21–30</th><th>+30</th>
    ${ehSafra ? '<th title="% de clientes dentro do IQ hoje">IQ hoje</th><th title="IQ se nenhum cliente que ainda pode passar de 30 dias até o fechamento pagar a tempo (todos viram +30)">Se ninguém pagar</th><th title="Pontos de IQ que ainda dá para salvar com cobrança">Em jogo</th>' : ''}
  </tr>`;
  document.getElementById('risco-heat-head').innerHTML = cab;

  const linhas = d.distribuicao.linhas;
  const cols = ehSafra ? 12 : 8;
  if (!linhas.length) {
    document.getElementById('risco-heat-body').innerHTML = `<tr><td colspan="${cols}" class="loading">Nenhum cliente neste recorte.</td></tr>`;
    return;
  }
  document.getElementById('risco-heat-body').innerHTML = linhas.map(l => {
    const nome = escaparHtml(l.nome);
    const tag = ehSafra && l.fechada ? ' <span class="risco-mini-tag">fechada</span>' : '';
    let iq = '';
    if (ehSafra) {
      const emJogo = l.pontosEmJogo;
      iq = `<td class="num">${riscoFmtPct(l.iqAtual)}</td>
            <td class="num">${riscoFmtPct(l.iqPiorCaso)}</td>
            <td class="num ${emJogo > 0 ? 'risco-jogo' : ''}">${emJogo > 0 ? '−' + String(emJogo).replace('.', ',') + ' p.p.' : '—'}</td>`;
    }
    return `<tr class="risco-linha" onclick="riscoFiltrarLinha('${nome}')">
      <td><strong>${nome}</strong>${tag}</td>
      <td class="num">${riscoFmtNum(l.total)}</td>
      <td class="num">${riscoFmtNum(l.ok - (l.semRisco || 0))}</td>
      ${ehSafra ? `<td class="num">${l.semRisco ? riscoFmtNum(l.semRisco) : '–'}</td>` : ''}
      ${riscoCelula(l.avencer, l.total, '#9B8CFF')}
      ${riscoCelula(l.d1_10, l.total, '#F0B90B')}
      ${riscoCelula(l.d11_20, l.total, '#FF9142')}
      ${riscoCelula(l.d21_30, l.total, '#FF6B4A')}
      ${riscoCelula(l.queimado, l.total, '#FF4757')}
      ${iq}
    </tr>`;
  }).join('');
}

function riscoTagFaixa(faixa) {
  const f = RISCO_FAIXAS.find(x => x.chave === faixa);
  if (!f) return '';
  const rotulos = { avencer: 'A vencer', d1_10: '1–10 dias', d11_20: '11–20 dias', d21_30: 'Crítico', queimado: 'Afetou o IQ' };
  return `<span class="risco-tag ${f.classe}">${rotulos[faixa]}</span>`;
}

function riscoRenderLista(d) {
  const t = d.tabela;
  const f = RISCO_FAIXAS.find(x => x.chave === risco.faixa);
  const chip = document.getElementById('risco-faixa-ativa');
  if (risco.faixa) {
    const rotulo = risco.faixa === 'emRisco' ? 'Ainda dá para salvar' : (f ? f.rotulo : risco.faixa);
    chip.style.display = '';
    chip.innerHTML = `${escaparHtml(rotulo)} <button type="button" onclick="riscoFiltrarFaixa('${risco.faixa}')" title="Limpar filtro">✕</button>`;
  } else {
    chip.style.display = 'none';
  }
  document.getElementById('risco-lista-titulo').textContent = risco.faixa ? 'Clientes na faixa selecionada' : 'Clientes que pedem atenção';
  document.getElementById('risco-lista-total').textContent = `${riscoFmtNum(t.total)} cliente${t.total === 1 ? '' : 's'}`;

  const tbody = document.getElementById('risco-tbody');
  if (!t.dados.length) {
    tbody.innerHTML = '<tr><td colspan="12" class="loading">Nenhum cliente nesta situação.</td></tr>';
    document.getElementById('risco-paginacao').innerHTML = '';
    riscoAjustarTopo();
    return;
  }
  tbody.innerHTML = t.dados.map(c => {
    const faltam = c.diasRestantes == null ? '—'
      : (c.diasRestantes <= 0 ? '<strong class="risco-hoje">hoje!</strong>' : `${c.diasRestantes} dia${c.diasRestantes === 1 ? '' : 's'}`);
    const atraso = c.diasAtraso == null ? '—'
      : (c.diasAtraso === 0 ? 'vence hoje'
        : (c.diasAtraso < 0 ? 'vence em ' + Math.abs(c.diasAtraso) + 'd' : c.diasAtraso + ' dias'));
    return `<tr>
      <td><strong>${escaparHtml(c.nome || '—')}</strong></td>
      <td>${riscoTagFaixa(c.faixa)}</td>
      <td>${faltam}</td>
      <td>${escaparHtml(c.dataLimite || '—')}</td>
      <td>${riscoCelulaCobranca(c)}</td>
      <td>${atraso}</td>
      <td>${escaparHtml(c.contato || '—')}</td>
      <td>${escaparHtml(c.vendedor || '—')}</td>
      <td>${escaparHtml(c.uf || '—')}</td>
      <td>${escaparHtml(c.safra || '—')}</td>
      <td>${escaparHtml(c.vencimento || '—')}</td>
      <td class="risco-obs">${escaparHtml(c.motivo || '')}${c.faturasAbertas > 1 ? ` ${c.faturasAbertas} faturas em aberto` : ''}</td>
    </tr>`;
  }).join('');
  renderPag('risco-paginacao', t.pagina, t.totalPaginas, pg => { risco.pagina = pg; carregarRisco(); });
  riscoAjustarTopo();
}

// reajusta a barra de rolagem do topo depois que a lista muda de tamanho
function riscoAjustarTopo() {
  if (window.riscoAjustarScrollTopo) { window.riscoAjustarScrollTopo(); setTimeout(window.riscoAjustarScrollTopo, 0); }
}

// ─── Gráficos ────────────────────────────────────────────────────────────────

risco.graficos = { dist: null, evo: null };

function riscoCss(nome, padrao) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
  return v || padrao;
}

function riscoOpcoesEixos() {
  const texto = riscoCss('--dim', '#8892A4');
  const grade = riscoCss('--border', '#1E2436');
  return { texto, grade };
}

// Barras empilhadas: como cada safra (ou estado) se divide entre as faixas de atraso.
function riscoRenderGraficoDist(d) {
  const canvas = document.getElementById('risco-chart-dist');
  if (!canvas || typeof Chart === 'undefined') return;
  const linhas = d.distribuicao.linhas;
  const porSafra = d.modo === 'safra';
  document.getElementById('risco-graf1-titulo').textContent = porSafra ? 'Situação dos clientes por safra' : 'Situação dos clientes por estado';
  document.getElementById('risco-graf-sub').textContent = porSafra ? 'Clique numa barra para filtrar a safra' : 'Clique numa barra para filtrar o estado';

  const series = [
    ['Em dia', 'ok', '#00D68F'],
    ['A vencer', 'avencer', '#9B8CFF'],
    ['1–10 dias', 'd1_10', '#F0B90B'],
    ['11–20 dias', 'd11_20', '#FF9142'],
    ['21–30 dias', 'd21_30', '#FF6B4A'],
    ['+30 dias (afetou o IQ)', 'queimado', '#FF4757'],
  ];
  const { texto, grade } = riscoOpcoesEixos();
  const dados = {
    labels: linhas.map(l => l.nome),
    datasets: series.map(([label, chave, cor]) => ({
      label, data: linhas.map(l => l[chave] || 0), backgroundColor: cor, borderWidth: 0,
    })),
  };
  const opcoes = {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    onClick: (_e, els) => { if (els.length) riscoFiltrarLinha(linhas[els[0].index].nome); },
    scales: {
      x: { stacked: true, ticks: { color: texto }, grid: { color: grade } },
      y: { stacked: true, ticks: { color: texto }, grid: { display: false } },
    },
    plugins: {
      legend: { position: 'bottom', labels: { color: texto, boxWidth: 12, font: { size: 11 } } },
      tooltip: { callbacks: { footer: items => {
        const l = linhas[items[0].dataIndex];
        return l.total ? `Total: ${riscoFmtNum(l.total)} clientes` : '';
      } } },
    },
  };
  if (risco.graficos.dist) {
    risco.graficos.dist.data = dados;
    risco.graficos.dist.options = opcoes;
    risco.graficos.dist.update();
  } else {
    risco.graficos.dist = new Chart(canvas, { type: 'bar', data: dados, options: opcoes });
  }
}

// 'YYYY-MM-DD' → 'dd/mm'
function riscoDiaCurto(iso) {
  const [, m, d] = String(iso).split('-');
  return `${d}/${m}`;
}

async function riscoCarregarHistorico() {
  try {
    const resp = await fetch('/api/risco-iq/historico?dias=60');
    if (!resp.ok) return;
    const h = await resp.json();
    riscoRenderEvolucao(h.dias || []);
  } catch {}
}

// Linha do tempo (foto diária) + resumo do que mudou desde o dia anterior.
function riscoRenderEvolucao(dias) {
  const vazio = document.getElementById('risco-evo-vazio');
  const wrap = document.getElementById('risco-evo-canvas-wrap');
  const fluxoEl = document.getElementById('risco-fluxo');
  if (!vazio || !wrap || !fluxoEl) return;

  if (!dias.length) {
    wrap.style.display = 'none';
    fluxoEl.innerHTML = '';
    vazio.style.display = '';
    vazio.textContent = 'O histórico começa a ser gravado automaticamente — a primeira foto aparece em instantes e o gráfico ganha forma a partir do segundo dia.';
    return;
  }
  wrap.style.display = '';
  vazio.style.display = dias.length < 2 ? '' : 'none';
  if (dias.length < 2) vazio.textContent = `Primeira foto gravada em ${riscoDiaCurto(dias[0].data)}. A linha de evolução aparece a partir do segundo dia.`;

  // O que mudou desde a foto anterior (usa o último dia que já tem comparação).
  const ultimo = dias[dias.length - 1];
  const f = ultimo.fluxo;
  if (f) {
    const aviso = ultimo.defasagemDias != null && ultimo.defasagemDias >= 2
      ? `<span class="risco-fluxo-aviso" title="Os atrasos desse dia foram calculados com dados do Sonar de ${ultimo.defasagemDias} dias atrás">⚠ Sonar defasado</span>` : '';
    fluxoEl.innerHTML = `
      <span class="risco-fluxo-ref">Desde ${riscoDiaCurto(f.desde)}:</span>
      <span class="risco-fluxo-chip salvos" title="Estavam com 1–30 dias de atraso e hoje estão em dia">✅ ${riscoFmtNum(f.salvos)} salvos</span>
      <span class="risco-fluxo-chip queimaram" title="Estavam com 1–30 dias e passaram de 30 sem pagar">🔥 ${riscoFmtNum(f.queimaram)} queimaram</span>
      <span class="risco-fluxo-chip novos" title="Entraram na faixa de 1–30 dias">➕ ${riscoFmtNum(f.novosEmRisco)} novos em risco</span>
      ${aviso}`;
  } else {
    fluxoEl.innerHTML = '';
  }

  if (typeof Chart === 'undefined') return;
  const canvas = document.getElementById('risco-chart-evo');
  const { texto, grade } = riscoOpcoesEixos();
  const linha = (label, chave, cor) => ({
    label, data: dias.map(x => x.contadores[chave] || 0), borderColor: cor, backgroundColor: cor,
    tension: 0.25, pointRadius: dias.length > 30 ? 0 : 3, borderWidth: 2,
  });
  const dados = {
    labels: dias.map(x => riscoDiaCurto(x.data)),
    datasets: [
      linha('Ainda dá para salvar (1–30)', 'emRisco', '#7B5CFA'),
      linha('Críticos (21–30)', 'd21_30', '#FF6B4A'),
      linha('Já afetaram o IQ (+30)', 'queimado', '#FF4757'),
    ],
  };
  const opcoes = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: { ticks: { color: texto, maxTicksLimit: 10 }, grid: { color: grade } },
      y: { beginAtZero: true, ticks: { color: texto }, grid: { color: grade } },
    },
    plugins: { legend: { position: 'bottom', labels: { color: texto, boxWidth: 12, font: { size: 11 } } } },
  };
  if (risco.graficos.evo) {
    risco.graficos.evo.data = dados;
    risco.graficos.evo.options = opcoes;
    risco.graficos.evo.update();
  } else {
    risco.graficos.evo = new Chart(canvas, { type: 'line', data: dados, options: opcoes });
  }
}

// ─── Lembrete por WhatsApp: "Mandar para o robô" ─────────────────────────────
// Gera o clientes.xlsx do robô (mesmo caminho do "Gerar Base Robô") só com a faixa
// crítica e os filtros da tela. NÃO envia nada: o disparo segue no painel local.

const RISCO_ROTULO_FAIXA = {
  d21_30: 'faixa crítica (21 a 30 dias)', d11_20: '11 a 20 dias', d1_10: '1 a 10 dias',
  avencer: 'a vencer (até 7 dias)', emRisco: 'todos que ainda dá para salvar (1 a 30 dias)',
};

function riscoCorpoCampanha(faixa) {
  const p = new URLSearchParams(riscoQuery());
  const corpo = { faixa };
  for (const k of ['modo', 'safra', 'mesVenc', 'estado', 'vendedor', 'busca', 'cobranca']) {
    if (p.get(k)) corpo[k] = p.get(k);
  }
  return corpo;
}

async function riscoPost(url, corpo) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || `HTTP ${r.status}`);
  return d;
}

async function riscoMandarRobo() {
  const btn = document.getElementById('risco-btn-robo');
  const faixa = risco.faixa || 'd21_30'; // sem faixa escolhida: a crítica
  if (faixa === 'queimado') {
    alert('Esses clientes já passaram de 30 dias e já afetaram o IQ — não dá mais para salvar, então não vão para o robô.\n\nEscolha uma faixa de 1 a 30 dias (ou "Ainda dá para salvar").');
    return;
  }
  const rotuloBtn = btn.textContent;
  btn.disabled = true;
  try {
    // 1) Prévia: só calcula, não grava nada.
    btn.textContent = '⏳ Calculando…';
    const corpo = riscoCorpoCampanha(faixa);
    const prev = await riscoPost('/api/risco-iq/campanha', corpo);
    if (!prev.total) {
      alert('Nenhum cliente elegível com os filtros atuais.' +
        (prev.excluidos && prev.excluidos.promessa ? `\n(${prev.excluidos.promessa} prometeram pagar e ficam de fora.)` : ''));
      return;
    }
    const ex = prev.excluidos || {};
    const msg = [
      `Mandar ${riscoFmtNum(prev.total)} cliente${prev.total === 1 ? '' : 's'} para o robô?`,
      `Faixa: ${RISCO_ROTULO_FAIXA[faixa] || faixa}.`,
      '',
      ex.promessa ? `• ${ex.promessa} que prometeram pagar ficam de fora.` : '',
      (ex.semCustcode || ex.semContato) ? `• ${(ex.semCustcode || 0) + (ex.semContato || 0)} sem custcode ou sem telefone ficam de fora.` : '',
      prev.jaCobrados ? `• ⚠ ${prev.jaCobrados} já foram cobrados antes — para não repetir, filtre "Ainda não cobrados" antes.` : '',
      '',
      'Isso SOBRESCREVE o clientes.xlsx do PC do robô e reinicia a fila dele.',
      'Nada é enviado por WhatsApp agora: depois você roda o robô e dispara pelo painel local.',
      'Cada disparo que sair marca o cliente aqui como "Cobrado · WhatsApp (disparo)".',
    ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i !== 0)).join('\n');
    if (!confirm(msg)) return;

    // 2) Calcula de verdade (fica pendente no servidor).
    btn.textContent = '⏳ Gerando…';
    const camp = await riscoPost('/api/risco-iq/campanha', { ...corpo, confirmar: true });

    // 3) Entrega ao PC do robô (o painel local precisa estar aberto — iniciar.bat).
    btn.textContent = '⏳ Enviando ao robô…';
    const r = await fetch('http://localhost:3000/api/receber-fila', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientes: camp.clientes }),
    }).then(x => x.json()).catch(() => ({ erro: 'O painel local (localhost:3000) não respondeu. Abra este dashboard pelo PC do robô e confirme que o iniciar.bat está aberto.' }));
    if (r.erro) {
      alert('❌ A base não chegou ao robô.\n\n' + r.erro + '\n\nNada foi marcado como cobrado. Corrija e clique de novo.');
      return;
    }

    // 4) Só agora a campanha passa a valer para marcar "cobrado" quando o disparo sair.
    await riscoPost(`/api/risco-iq/campanha/${encodeURIComponent(camp.id)}/ativar`);
    alert(`✅ Base do robô gerada com ${riscoFmtNum(r.total)} clientes.\n\nPróximos passos:\n1) Rode o robô no painel local para baixar as faturas.\n2) Dispare pelo painel local.\n\nCada envio marca o cliente como cobrado aqui.`);
    riscoCarregarCampanha();
  } catch (e) {
    alert('Não foi possível mandar para o robô: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = rotuloBtn;
  }
}

// Linha de status: última base entregue ao robô e quantos já receberam o lembrete.
async function riscoCarregarCampanha() {
  const el = document.getElementById('risco-campanha');
  if (!el) return;
  try {
    const resp = await fetch('/api/risco-iq/campanha');
    if (!resp.ok) return;
    const { atual } = await resp.json();
    if (!atual) { el.style.display = 'none'; return; }
    const quando = new Date(atual.criadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rotulo = (RISCO_ROTULO_FAIXA[atual.faixa] || atual.faixa);
    el.style.display = '';
    el.innerHTML = `🚀 <strong>Última base mandada ao robô:</strong> ${escaparHtml(quando)} por ${escaparHtml(atual.autor || '—')} · ${escaparHtml(rotulo)} · ` +
      `${riscoFmtNum(atual.total)} clientes · <strong>${riscoFmtNum(atual.marcados)}</strong> já receberam o lembrete` +
      (atual.ativa ? '' : ' <span class="risco-campanha-venc">(passou de 7 dias — não marca mais)</span>');
  } catch {}
}

// Barra de rolagem horizontal também no TOPO da lista (sincronizada com a de baixo)
(function riscoScrollTopo() {
  const wrapper = document.getElementById('risco-wrapper');
  const topo = document.getElementById('risco-scroll-top');
  const inner = document.getElementById('risco-scroll-top-inner');
  const tabela = document.getElementById('risco-tabela');
  if (!wrapper || !topo || !inner || !tabela) return;
  const ajustar = () => {
    inner.style.width = tabela.scrollWidth + 'px';
    // sem rolagem horizontal (ex.: aba oculta ou tela larga) a barra de cima some
    topo.style.display = tabela.scrollWidth > wrapper.clientWidth + 1 ? '' : 'none';
  };
  if (window.ResizeObserver) { const ro = new ResizeObserver(ajustar); ro.observe(wrapper); ro.observe(tabela); }
  window.addEventListener('resize', ajustar);
  window.riscoAjustarScrollTopo = ajustar;
  ajustar();
  // compara valores (o evento de scroll chega depois, uma trava booleana nao funciona)
  topo.addEventListener('scroll', () => { if (wrapper.scrollLeft !== topo.scrollLeft) wrapper.scrollLeft = topo.scrollLeft; });
  wrapper.addEventListener('scroll', () => { if (topo.scrollLeft !== wrapper.scrollLeft) topo.scrollLeft = wrapper.scrollLeft; });
})();
