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
  if (estado) p.set('estado', estado);
  if (vend) p.set('vendedor', vend);
  if (busca) p.set('busca', busca);
  if (risco.faixa) p.set('faixa', risco.faixa);
  p.set('ordenar', document.getElementById('risco-ordenar').value);
  p.set('pagina', risco.pagina);
  p.set('porPagina', 50);
  return p.toString();
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
  if (tbody && !tbody.children.length) tbody.innerHTML = '<tr><td colspan="11" class="loading">Carregando…</td></tr>';
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
    riscoAtualizarBadge(d.contadores);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="11" class="loading">Não foi possível carregar: ${escaparHtml(e.message)}</td></tr>`;
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
      <div class="kpi-sub">1 a 30 dias de atraso</div>
    </button>`;
  document.getElementById('risco-kpis').innerHTML = salvaveis + cartoes;

  const extras = [];
  extras.push(`<span><strong>${riscoFmtNum(c.ok)}</strong> em dia</span>`);
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
    ? 'IQ hoje × IQ se nenhum cliente de 1 a 30 dias pagar a tempo · clique numa linha para filtrar'
    : 'Clique numa linha para filtrar';

  const cab = `<tr>
    <th>${d.distribuicao.rotulo}</th><th>Clientes</th><th>Em dia</th>
    <th>A vencer</th><th>1–10</th><th>11–20</th><th>21–30</th><th>+30</th>
    ${ehSafra ? '<th title="% de clientes dentro do IQ hoje">IQ hoje</th><th title="IQ se nenhum cliente com 1 a 30 dias de atraso pagar a tempo (todos viram +30)">Se ninguém pagar</th><th title="Pontos de IQ que ainda dá para salvar com cobrança">Em jogo</th>' : ''}
  </tr>`;
  document.getElementById('risco-heat-head').innerHTML = cab;

  const linhas = d.distribuicao.linhas;
  const cols = ehSafra ? 11 : 8;
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
      <td class="num">${riscoFmtNum(l.ok)}</td>
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
    const rotulo = risco.faixa === 'emRisco' ? 'Ainda dá para salvar (1–30 dias)' : (f ? f.rotulo : risco.faixa);
    chip.style.display = '';
    chip.innerHTML = `${escaparHtml(rotulo)} <button type="button" onclick="riscoFiltrarFaixa('${risco.faixa}')" title="Limpar filtro">✕</button>`;
  } else {
    chip.style.display = 'none';
  }
  document.getElementById('risco-lista-titulo').textContent = risco.faixa ? 'Clientes na faixa selecionada' : 'Clientes que pedem atenção';
  document.getElementById('risco-lista-total').textContent = `${riscoFmtNum(t.total)} cliente${t.total === 1 ? '' : 's'}`;

  const tbody = document.getElementById('risco-tbody');
  if (!t.dados.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="loading">Nenhum cliente nesta situação.</td></tr>';
    document.getElementById('risco-paginacao').innerHTML = '';
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
}
