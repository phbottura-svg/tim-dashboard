// ─── Estado Global ────────────────────────────────────────────────────────────

const state = {
  abaAtual: 'dashboard',
  pagina: 1, ordenarPor: 'nome', direcao: 'asc',
  _carregando: false,
};
const graficos = {};

// ─── Cores ───────────────────────────────────────────────────────────────────

const C = {
  verde: '#00d68f', laranja: '#ff9142', vermelho: '#ff4757',
  amarelo: '#f0b90b', azul: '#7b5cfa', azulC: '#9b8cff',
  roxo: '#7b5cfa', cinza: '#8892a4',
};

const STATUS_LABEL = { ADIMPLENTE: 'Adimplente', INADIMPLENTE: 'Inadimplente', PAGO_ATRASO: 'Pago com atraso', 'SEM DADOS': 'Sem Dados', CHURN: 'Churn' };
const STATUS_COR = { ADIMPLENTE: C.verde, INADIMPLENTE: C.vermelho, PAGO_ATRASO: C.laranja, 'SEM DADOS': C.cinza };

// Marcadores de atendimento — a ordem aqui define a ordem nos filtros e no modal.
const MARCADORES = ['pagou', 'promessa', 'problema_tecnico', 'problema_app', 'cancelamento', 'venda_errada'];
const MARCADOR_INFO = {
  pagou:            { icone: '💰', label: 'Cliente pagou' },
  promessa:         { icone: '🤝', label: 'Promessa de pagamento' },
  problema_tecnico: { icone: '🔧', label: 'Problema técnico' },
  problema_app:     { icone: '📱', label: 'Problema no app' },
  cancelamento:     { icone: '🚫', label: 'Solicitou cancelamento' },
  venda_errada:     { icone: '🔁', label: 'Venda errada' },
};

// ─── Init ─────────────────────────────────────────────────────────────────────

// Último valor que o usuário realmente digitou no campo de busca.
let _buscaTabelaDigitado = '';

function vigiarBuscaTabelaAutofill() {
  const el = document.getElementById('busca-tabela');
  if (!el) return;

  // O autofill do Chrome preenche o campo ao clicar nele, disparando eventos
  // sintéticos: no "input" o inputType vem vazio, enquanto digitação ou
  // colagem real sempre traz um inputType ("insertText", "insertFromPaste",
  // "deleteContentBackward"...). É esse o critério para descartar só o
  // preenchimento automático sem atrapalhar quem está digitando.
  el.addEventListener('input', e => {
    if (e.inputType) { _buscaTabelaDigitado = el.value; buscarTabela(); return; }
    if (el.value === _buscaTabelaDigitado) return;
    el.value = _buscaTabelaDigitado;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  vigiarBuscaTabelaAutofill();
  restaurarSidebarRecolhida();
  restaurarTema();

  carregarSessao();
  await aplicarModoVps();
  iniciarScrollTop();
  restaurarEstadoDisparo();
  conectarSSE();
  verificarStatusRobo();
  setInterval(verificarStatusRobo, 5000);
  await carregarStatusImportacao();
  await carregarOpcoesFiltros();
  await carregarTudo();
  atualizarInfoRelatorio();
  atualizarFilaStatus();
  setInterval(atualizarFilaStatus, 10000);
  atualizarBasePagosStatus();
  carregarHistoricoRobos();
});

const DISPARO_CAMPOS = ['disparo-forcar', 'disparo-delay', 'disparo-lote', 'disparo-pausa-lote', 'disparo-limite'];

function restaurarEstadoDisparo() {
  for (const id of DISPARO_CAMPOS) {
    const val = localStorage.getItem(id);
    if (val === null) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = val === 'true';
    else if (val !== '') el.value = val;
  }
  const inicio = localStorage.getItem('disparo-inicio');
  if (inicio) _progressoInicio = parseInt(inicio);
  // Log para debug
  console.log('[restaurar] disparo-forcar =', localStorage.getItem('disparo-forcar'), '→ checked =', document.getElementById('disparo-forcar')?.checked);
}

function salvarEstadoDisparo() {
  for (const id of DISPARO_CAMPOS) {
    const el = document.getElementById(id);
    if (!el) continue;
    localStorage.setItem(id, el.type === 'checkbox' ? el.checked : el.value);
  }
}

document.addEventListener('change', e => {
  if (DISPARO_CAMPOS.includes(e.target?.id)) salvarEstadoDisparo();
});
document.addEventListener('input', e => {
  if (DISPARO_CAMPOS.includes(e.target?.id)) salvarEstadoDisparo();
});

function iniciarScrollTop() {
  const wrapper = document.getElementById('tabela-wrapper');
  const scrollTop = document.getElementById('tabela-scroll-top');
  const inner = document.getElementById('tabela-scroll-top-inner');
  if (!wrapper || !scrollTop || !inner) return;

  // Sincroniza largura do inner com a tabela
  const syncWidth = () => { inner.style.width = wrapper.scrollWidth + 'px'; };
  new ResizeObserver(syncWidth).observe(wrapper);
  syncWidth();

  // Sincroniza scroll nos dois sentidos
  let sync = false;
  scrollTop.addEventListener('scroll', () => { if (!sync) { sync = true; wrapper.scrollLeft = scrollTop.scrollLeft; sync = false; } });
  wrapper.addEventListener('scroll', () => { if (!sync) { sync = true; scrollTop.scrollLeft = wrapper.scrollLeft; sync = false; } });
}

async function enviarFilaParaRobo() {
  const btn = document.getElementById('btn-enviar-robo');
  // Coleta os mesmos filtros que a tabela usa
  const p = coletarFiltros();
  const busca = document.getElementById('busca-tabela')?.value;
  if (busca) p.set('busca', busca);
  const statusTabela = document.getElementById('tabela-filtro-status')?.value;
  if (statusTabela) p.set('statusTabela', statusTabela);
  const ufTabela = document.getElementById('tabela-filtro-uf')?.value;
  if (ufTabela) p.set('uf', ufTabela);
  const safra = document.getElementById('tabela-filtro-safra')?.value;
  if (safra) p.set('safra', safra);
  const vencimento = document.getElementById('tabela-filtro-vencimento')?.value;
  if (vencimento) p.set('dataVencimento', vencimento);
  if (document.getElementById('tabela-filtro-churn')?.checked) p.set('churn', '1');
  if (document.getElementById('tabela-filtro-sem-match')?.checked) p.set('semMatch', '1');
  if (document.getElementById('tabela-filtro-acionaveis')?.checked) p.set('acionaveis', '1');
  if (document.getElementById('tabela-filtro-pago-manual')?.checked) p.set('pagoManual', '1');
  if (document.getElementById('tabela-filtro-iq-dentro')?.checked) p.set('iqSafra', 'dentro');
  else if (document.getElementById('tabela-filtro-iq-fora')?.checked) p.set('iqSafra', 'fora');
  for (const m of MARCADORES) {
    if (document.getElementById(`tabela-filtro-mk-${m}`)?.checked) p.set(`marcador_${m}`, '1');
  }
  for (let n = 1; n <= 5; n++) {
    const v = document.getElementById(`tf-f${n}`)?.value;
    if (v) p.set(`f${n}`, v);
  }

  if (!confirm(`Gerar base do robô com os filtros atuais?\n\nIsso vai sobrescrever o clientes.xlsx no localhost e resetar a fila.`)) return;

  btn.disabled = true;
  btn.textContent = '⏳ Buscando clientes...';
  try {
    // 1. Busca clientes filtrados do VPS
    const d = await fetch('/api/gerar-fila-dados?' + p).then(r => r.json());
    if (d.erro) { alert('Erro: ' + d.erro); return; }

    btn.textContent = '⏳ Enviando para robô...';

    // 2. Envia para o localhost salvar como clientes.xlsx
    const r = await fetch('http://localhost:3000/api/receber-fila', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientes: d.clientes }),
    }).then(r => r.json()).catch(() => ({ erro: 'Localhost não respondeu. Verifique se o iniciar.bat está aberto.' }));

    if (r.erro) { alert('❌ ' + r.erro); return; }
    alert(`✅ Base gerada com ${r.total} clientes!\n\nO robô já pode ser iniciado.`);
  } catch (err) {
    alert('Erro: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Gerar Base Robô';
  }
}

async function gerarFilaRobo() {
  const btn = document.getElementById('btn-fila-robo');
  const p = coletarFiltros();
  const busca = document.getElementById('busca-tabela')?.value;
  if (busca) p.set('busca', busca);
  const params = Object.fromEntries(p.entries());

  if (!confirm(`Gerar fila do robô com os filtros atuais?\n\nIsso vai sobrescrever o clientes.xlsx na pasta do robô e resetar a fila.`)) return;

  btn.disabled = true;
  btn.textContent = '⏳ Gerando...';
  try {
    const d = await fetch('/api/gerar-fila-robo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }).then(r => r.json());
    if (d.erro) { alert('Erro: ' + d.erro); return; }
    alert(`✅ Fila gerada com ${d.total} clientes!\n\nO robô usará essa base na próxima execução.`);
    atualizarFilaStatus();
  } catch (err) {
    alert('Erro: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 Usar como fila do robô';
  }
}

async function atualizarFilaStatus() {
  try {
    const d = await fetch('/api/fila-status').then(r => r.json());
    if (d.erro) return;
    const box = document.getElementById('fila-status-box');
    if (box) box.style.display = '';
    setText('fila-total', d.total);
    setText('fila-processados', d.processados);
    setText('fila-pendentes', d.pendentes);
  } catch {}
  atualizarReprocStatus();
}

async function atualizarReprocStatus() {
  try {
    const d = await fetch('/api/reprocessamento-status').then(r => r.json());
    const box = document.getElementById('reproc-status-box');
    if (!box) return;
    if (!d.ativo) { box.style.display = 'none'; return; }
    box.style.display = '';
    setText('reproc-total', d.total);
    setText('reproc-feitos', d.feitos);
    setText('reproc-pendentes', d.pendentes);
    setText('reproc-recuperados', d.recuperados);
    setText('reproc-aindaerro', d.aindaErro);
  } catch {}
}

async function aplicarModoVps() {
  try {
    const { modo } = await fetch('/api/modo').then(r => r.json());
    if (modo === 'vps') {
      document.querySelectorAll('.apenas-local').forEach(el => el.style.display = 'none');
      const aviso = document.getElementById('aviso-vps');
      if (aviso) aviso.style.display = '';
    } else {
      // Modo local: remove abas Dashboard, Faturas e Ajustes — só Comandos
      ['dashboard', 'faturas', 'ajustes'].forEach(aba => {
        document.querySelector(`.nav-btn[data-tab="${aba}"]`)?.remove();
        document.getElementById(`tab-${aba}`)?.remove();
      });
      // Esconde elementos exclusivos do VPS
      document.querySelectorAll('.apenas-vps').forEach(el => el.style.display = 'none');
      // Mostra botão "Usar como fila do robô" só no localhost
      const btnFila = document.getElementById('btn-fila-robo');
      if (btnFila) btnFila.style.display = '';
      mudarAbaBtn('comandos');
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

let _abaLogAtiva = 'todos';

function trocarAbaLog(aba) {
  _abaLogAtiva = aba;
  ['todos', 'PR', 'SC', 'RS', 'PR2', 'SC2', 'RS2'].forEach(a => {
    const painel = document.getElementById(`console-log-${a}`);
    const btn = document.getElementById(`aba-log-${a}`);
    if (painel) painel.style.display = a === aba ? '' : 'none';
    if (btn) btn.classList.toggle('ativa', a === aba);
  });
}

function adicionarLog(msg, tipo = 'info') {
  if (!msg) return;
  const ehDisparo = tipo === 'disparo' || tipo === 'disparo-log';
  if (ehDisparo) {
    const el = document.getElementById('console-disparo');
    if (!el) return;
    const l = document.createElement('div');
    const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    l.className = 'console-linha console-info';
    l.textContent = `[${ts}] ${msg}`;
    el.appendChild(l);
    while (el.children.length > 200) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
    return;
  }

  // Detecta estado da mensagem ([PR], [SC], [RS])
  const estadoMatch = msg.match(/\[(PR2?|SC2?|RS2?)\]/);
  const estado = estadoMatch ? estadoMatch[1] : null;

  const cls = tipo?.includes('erro') ? 'console-erro'
    : tipo?.includes('sucesso') ? 'console-sucesso'
    : tipo?.includes('robo') ? 'console-robo'
    : tipo?.includes('aviso') ? 'console-aviso' : 'console-info';

  const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });

  // Adiciona no painel "todos"
  const elTodos = document.getElementById('console-log-todos');
  if (elTodos) {
    const l = document.createElement('div');
    l.className = `console-linha ${cls}`;
    l.textContent = `[${ts}] ${msg}`;
    elTodos.appendChild(l);
    while (elTodos.children.length > 500) elTodos.removeChild(elTodos.firstChild);
    if (_abaLogAtiva === 'todos') elTodos.scrollTop = elTodos.scrollHeight;
  }

  // Adiciona no painel do estado específico
  if (estado) {
    const elEstado = document.getElementById(`console-log-${estado}`);
    if (elEstado) {
      const l = document.createElement('div');
      l.className = `console-linha ${cls}`;
      l.textContent = `[${ts}] ${msg}`;
      elEstado.appendChild(l);
      while (elEstado.children.length > 300) elEstado.removeChild(elEstado.firstChild);
      if (_abaLogAtiva === estado) elEstado.scrollTop = elEstado.scrollHeight;
    }
  }
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
  if (document.getElementById('sidebar')?.classList.contains('aberta')) toggleSidebar(false);
  if (aba === 'comandos') { carregarRelatorios(); carregarRelatoriosDisparo(); }
  if (aba === 'faturas') carregarFaturas(1);
  if (aba === 'ajustes') carregarAjustes();
  if (aba === 'usuarios') carregarUsuarios();
}

// ─── Usuários ─────────────────────────────────────────────────────────────────

async function carregarSessao() {
  try {
    const { usuario } = await fetch('/api/sessao').then(r => r.json());
    const el = document.getElementById('usuario-logado');
    if (el && usuario) el.textContent = usuario.nome;
    const avatar = document.getElementById('user-avatar');
    if (avatar && usuario?.nome) avatar.textContent = usuario.nome.trim().charAt(0).toUpperCase();
  } catch {}
}

async function sair() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/login.html';
}

function toggleSidebar(forcarAberto) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const abrir = forcarAberto !== undefined ? forcarAberto : !sidebar.classList.contains('aberta');
  sidebar.classList.toggle('aberta', abrir);
  overlay.classList.toggle('aberta', abrir);
}

// Recolher a sidebar para ganhar largura de tela. A preferência fica salva no
// navegador para não precisar recolher de novo a cada visita.
function aplicarSidebarRecolhida(recolher) {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('btn-recolher');
  if (!sidebar) return;
  sidebar.classList.toggle('recolhida', recolher);
  if (btn) btn.title = recolher ? 'Expandir menu' : 'Recolher menu';
  localStorage.setItem('sidebar-recolhida', recolher ? '1' : '0');
}

function toggleRecolherSidebar() {
  aplicarSidebarRecolhida(!document.getElementById('sidebar').classList.contains('recolhida'));
}

function restaurarSidebarRecolhida() {
  if (localStorage.getItem('sidebar-recolhida') === '1') aplicarSidebarRecolhida(true);
}

// Tema claro/escuro — o <head> já aplica o tema salvo antes da tela pintar
// (evita flash do tema errado); aqui só sincroniza o botão com o estado atual
// e trata o clique de alternar.
function aplicarTema(tema) {
  const claro = tema === 'light';
  if (claro) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('tema', claro ? 'light' : 'dark');
  const icone = document.getElementById('icone-tema');
  if (icone) icone.textContent = claro ? '☀️' : '🌙';
}

function alternarTema() {
  const atual = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  aplicarTema(atual === 'light' ? 'dark' : 'light');
}

function restaurarTema() {
  aplicarTema(localStorage.getItem('tema') || 'dark');
}

async function carregarUsuarios() {
  const tbody = document.getElementById('usuarios-tbody');
  try {
    const usuarios = await fetch('/api/usuarios').then(r => r.json());
    tbody.innerHTML = usuarios.map(u => `
      <tr>
        <td>${u.usuario}</td>
        <td>${u.nome || ''}</td>
        <td>${u.criadoEm ? new Date(u.criadoEm).toLocaleDateString('pt-BR') : ''}</td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="trocarSenhaUsuario('${u.usuario}')">🔑 Trocar senha</button>
          <button class="btn btn-danger btn-sm" onclick="excluirUsuario('${u.usuario}')">🗑 Excluir</button>
        </td>
      </tr>
    `).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="4">Erro ao carregar usuários</td></tr>';
  }
}

async function criarUsuario() {
  const usuario = document.getElementById('novo-usuario-usuario').value.trim();
  const nome = document.getElementById('novo-usuario-nome').value.trim();
  const senha = document.getElementById('novo-usuario-senha').value;

  if (!usuario || !senha) return alert('Usuário e senha são obrigatórios');

  const res = await fetch('/api/usuarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, senha, nome }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.erro || 'Erro ao criar usuário');

  document.getElementById('novo-usuario-usuario').value = '';
  document.getElementById('novo-usuario-nome').value = '';
  document.getElementById('novo-usuario-senha').value = '';
  carregarUsuarios();
}

async function trocarSenhaUsuario(usuario) {
  const senha = prompt(`Nova senha para "${usuario}" (mín. 6 caracteres):`);
  if (!senha) return;

  const res = await fetch(`/api/usuarios/${encodeURIComponent(usuario)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.erro || 'Erro ao trocar senha');
  alert('Senha atualizada.');
}

async function excluirUsuario(usuario) {
  if (!confirm(`Excluir o usuário "${usuario}"?`)) return;

  const res = await fetch(`/api/usuarios/${encodeURIComponent(usuario)}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) return alert(data.erro || 'Erro ao excluir usuário');
  carregarUsuarios();
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
    const selMesAtalho = document.getElementById('tabela-filtro-mesgross');
    d.mesesGross?.forEach(s => {
      const o = document.createElement('option');
      o.value = s; o.textContent = s; selMes.appendChild(o);
      if (selMesAtalho) selMesAtalho.appendChild(o.cloneNode(true));
    });
    const selVend = document.getElementById('filtro-vendedor');
    selVend.innerHTML = '<option value="">Todos Vendedores</option>';
    d.vendedores?.forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v; selVend.appendChild(o);
    });
    const selEst = document.getElementById('filtro-estado');
    selEst.innerHTML = '<option value="">Todas UFs</option>';
    d.estados?.forEach(e => {
      const o = document.createElement('option');
      o.value = e; o.textContent = e; selEst.appendChild(o);
    });
    const selSafra = document.getElementById('tabela-filtro-safra');
    if (selSafra) {
      selSafra.innerHTML = '<option value="">Todas Safras</option>';
      d.safras?.forEach(s => {
        const o = document.createElement('option');
        o.value = s; o.textContent = `Safra ${s}`;
        selSafra.appendChild(o);
      });
    }
    const selVenc = document.getElementById('tabela-filtro-vencimento');
    if (selVenc) {
      selVenc.innerHTML = '<option value="">Todos Vencimentos</option>';
      d.datasVencimento?.forEach(v => {
        const o = document.createElement('option');
        o.value = v; o.textContent = v;
        selVenc.appendChild(o);
      });
    }
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

// Mês Gross tem dois seletores na tela (o do topo e o atalho na Tabela de
// Clientes) que representam o MESMO filtro — mudar um reflete no outro pra
// não precisar subir/descer a tela pra trocar de mês.
async function mudarMesGrossAtalho(valor) {
  const topo = document.getElementById('filtro-mesGross');
  const atalho = document.getElementById('tabela-filtro-mesgross');
  if (topo) topo.value = valor;
  if (atalho) atalho.value = valor;
  await atualizarVendedoresPorMesGross(valor);
  aplicarFiltros();
}

// Restringe o filtro de Vendedor a quem tem venda no Mês Gross selecionado,
// pra casar com quem realmente aparece na Tabela de Clientes filtrada — sem
// mês selecionado, volta a listar todo mundo. Mantém o vendedor já escolhido
// se ele continuar valendo na nova lista.
async function atualizarVendedoresPorMesGross(mesGross) {
  const sel = document.getElementById('filtro-vendedor');
  if (!sel) return;
  const atual = sel.value;
  try {
    const qs = mesGross ? '?mesGross=' + encodeURIComponent(mesGross) : '';
    const d = await fetch('/api/filtros/opcoes' + qs).then(r => r.json());
    sel.innerHTML = '<option value="">Todos Vendedores</option>';
    d.vendedores?.forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v; sel.appendChild(o);
    });
    sel.value = (atual && d.vendedores?.includes(atual)) ? atual : '';
  } catch {}
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

async function importarBasePagos(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('btn-base-pagos');
  const txt = btn.childNodes[0];
  const orig = txt.nodeValue;
  txt.nodeValue = ' ⏳ Enviando... ';
  btn.style.opacity = '0.7';
  try {
    const fd = new FormData();
    fd.append('arquivo', file);
    const r = await fetch('/api/clientes/base-pagos', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.erro) { mostrarMsg('❌ Erro: ' + d.erro, 'erro'); }
    else {
      let msg = `💛 ${d.faturasMarcadas} fatura(s) marcada(s) como paga(s) em ${d.clientesAfetados} cliente(s)`;
      if (d.vencIgnorados) msg += ` · ${d.vencIgnorados} vencimento(s) ignorado(s) (sem fatura no sistema)`;
      if (d.semCliente) msg += ` · ${d.semCliente} não encontrado(s)`;
      mostrarMsg(msg, 'ok');
      await atualizarBasePagosStatus();
      await carregarTudo();
    }
  } catch (err) { mostrarMsg('❌ ' + err.message, 'erro'); }
  finally {
    txt.nodeValue = orig;
    btn.style.opacity = '';
    input.value = '';
  }
}

// Contador ao lado do botão "Base Pagos" + visibilidade do botão de reset total.
async function atualizarBasePagosStatus() {
  try {
    const d = await fetch('/api/clientes/base-pagos/status').then(r => r.json());
    const badge = document.getElementById('base-pagos-count');
    const btnLimpar = document.getElementById('btn-limpar-base-pagos');
    if (badge) badge.textContent = d.totalClientes > 0 ? ` (${d.totalClientes})` : '';
    if (btnLimpar) btnLimpar.style.display = d.totalClientes > 0 ? '' : 'none';
  } catch {}
}

// Desmarca UMA fatura marcada manualmente (clique no ícone 💛 na tabela).
async function desmarcarPagoManual(idx, numeroFatura) {
  const c = tabelaClientesAtual[idx];
  const fat = c && (c.faturas || []).find(f => f.numero === numeroFatura);
  if (!fat) return;
  if (!confirm(`Desmarcar o pagamento manual do vencimento ${fat.dataVencimento}?\n\nA fatura volta a valer o status real do Sonar.`)) return;
  try {
    const r = await fetch('/api/clientes/base-pagos/desmarcar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custcode: c.custcode, cpf: c.cpf, vencimento: fat.dataVencimento }),
    });
    const d = await r.json();
    if (d.erro) { alert('Erro: ' + d.erro); return; }
    await atualizarBasePagosStatus();
    await carregarTudo();
  } catch (err) { alert('Erro: ' + err.message); }
}

// Reset completo da Base Pagos (botão 🗑️, só aparece quando há algo marcado).
async function limparBasePagos() {
  if (!confirm('Remover TODAS as marcações manuais da Base Pagos?\n\nTodas as faturas 💛 voltam a valer o status real do Sonar.')) return;
  try {
    const r = await fetch('/api/clientes/base-pagos', { method: 'DELETE' });
    const d = await r.json();
    if (d.erro) { alert('Erro: ' + d.erro); return; }
    await atualizarBasePagosStatus();
    await carregarTudo();
  } catch (err) { alert('Erro: ' + err.message); }
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

async function importarCestaOficial(input) {
  const file = input.files[0];
  if (!file) return;
  const btn = document.getElementById('btn-importar-cesta-oficial');
  btn.textContent = '⏳ Importando...';
  btn.style.opacity = '0.7';
  try {
    const fd = new FormData();
    fd.append('arquivo', file);
    const r = await fetch('/api/importar-cesta-oficial', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.erro) { mostrarMsg('❌ Erro: ' + d.erro, 'erro'); }
    else {
      mostrarMsg(`✅ Fechamento oficial importado: ${d.total} clientes · safra(s) ${d.safras.join(', ')}`, 'ok');
      const st = document.getElementById('status-cesta-oficial');
      if (st) st.textContent = `✅ Última importação: ${d.safras.join(', ')} (${d.total} clientes)`;
      await carregarTudo();
    }
  } catch (err) { mostrarMsg('❌ ' + err.message, 'erro'); }
  finally {
    btn.textContent = '📥 Importar Fechamento (.xlsx)';
    btn.style.opacity = '';
    input.value = '';
  }
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
    ['PR', 'SC', 'RS', 'PR2', 'SC2', 'RS2'].forEach(est => {
      const el = document.getElementById(`status-sonar-${est}`);
      if (el) {
        const s = d.sonar[est];
        const emoji = badgeEmoji(s.status);
        const baseTs = s.ultimaAtualizacaoBase ? ` · base atualizada em ${s.ultimaAtualizacaoBase}` : '';
        el.textContent = `${emoji} ${est} — ${s.total} reg${baseTs}`;
        el.className = `importar-status status-${s.status}`;
        el.title = s.importadoEm ? `Importado em ${fmtTs(s.importadoEm)}` : '';
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
  const atalho = document.getElementById('tabela-filtro-mesgross');
  if (atalho) atalho.innerHTML = '<option value="">Todos Meses Gross</option>';
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

    // Card do IQ (Índice de Qualidade), sempre à esquerda de "Fatura 1" —
    // só existe quando um Mês Gross específico está selecionado no filtro,
    // pois o IQ depende de uma única janela de safra bem definida.
    const cardIQ = (() => {
      const r = d.iqSafra;
      if (!r) {
        return `<div class="kpi kpi-iq" title="Selecione um Mês Gross no filtro para ver o IQ daquela safra">
          <div class="kpi-label">📐 IQ Safra</div>
          <div class="kpi-value">—</div>
          <div class="kpi-sub">selecione um Mês Gross</div>
        </div>`;
      }
      const corIQ = r.percentual >= 80 ? 'kpi-verde' : r.percentual >= 50 ? 'kpi-amarelo' : 'kpi-vermelho';
      const fonteTxt = r.oficial ? ' · ✅ fechamento oficial TIM'
        : r.previa ? ' · prévia (safra em andamento)'
        : r.congelado ? ' · 🔒 estimativa travada (aguardando fechamento oficial)'
        : ' · estimativa por atraso';
      const tituloCongelado = r.congelado ? ` — travado em ${new Date(r.congeladoEm).toLocaleDateString('pt-BR')}` : '';
      return `<div class="kpi ${corIQ}" title="Janela: ${r.janela.join(', ')} — corte em ${r.dataCorte}${tituloCongelado}">
        <div class="kpi-label">📐 IQ Safra ${r.safra}</div>
        <div class="kpi-value">${r.percentual}%</div>
        <div class="kpi-sub">${fmt(r.clientesOk)} de ${fmt(r.totalClientes)} dentro do IQ${fonteTxt}</div>
      </div>`;
    })();

    // Cards dinâmicos por fatura
    const grid = document.getElementById('kpi-faturas-grid');
    if (grid && d.faturaStats) {
      const cardsFatura = Object.entries(d.faturaStats).map(([key, s]) => {
        const n = key.replace('f', '');
        const corPaga = s.pct >= 80 ? 'kpi-verde' : s.pct >= 50 ? 'kpi-amarelo' : 'kpi-vermelho';
        return `<div class="kpi ${corPaga}">
          <div class="kpi-label">Fatura ${n}</div>
          <div class="kpi-value">${s.pct}%</div>
          <div class="kpi-sub">${fmt(s.pagas)} pagas · ${fmt(s.naoPagas)} não pagas · ${fmt(s.total)} clientes</div>
        </div>`;
      }).join('');
      grid.innerHTML = cardIQ + cardsFatura;
    }
  } catch (err) { console.error('Erro resumo:', err); }
}

// ─── Gráficos ─────────────────────────────────────────────────────────────────

const defOpts = {
  responsive: true, maintainAspectRatio: true,
  plugins: { legend: { labels: { color: '#8892a4', font: { size: 11 } } } },
  scales: {
    x: { ticks: { color: '#8892a4', maxRotation: 45 }, grid: { color: 'rgba(30,30,74,0.8)' } },
    y: { ticks: { color: '#8892a4' }, grid: { color: 'rgba(30,30,74,0.8)' } },
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
    }, { maintainAspectRatio: false, plugins: { legend: { labels: { color: '#8892a4' } } }, scales: {} });
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
    }, { plugins: { legend: { labels: { color: '#8892a4' } } }, scales: defOpts.scales });
  } catch {}
}

async function carregarVendedores(p) {
  try {
    const d = await fetch('/api/graficos/vendedores?' + p).then(r => r.json());
    criarOuAtualizar('g-vendedores', 'bar', {
      labels: d.labels,
      datasets: [{ label: 'Inadimplentes', data: d.valores, backgroundColor: 'rgba(255,61,87,0.8)', borderRadius: 4 }],
    }, { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#8892a4' }, grid: { color: 'rgba(30,30,74,0.8)' } }, y: { ticks: { color: '#8892a4', font: { size: 10 } }, grid: { display: false } } } });
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
      datasets: [{ label: 'Faturas Baixadas', data: d.valores, borderColor: C.amarelo, backgroundColor: 'rgba(240,185,11,0.1)', fill: true, tension: 0.4, pointRadius: 3 }],
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
  const safra = document.getElementById('tabela-filtro-safra')?.value;
  if (safra) p.set('safra', safra);
  const vencimento = document.getElementById('tabela-filtro-vencimento')?.value;
  if (vencimento) p.set('dataVencimento', vencimento);
  if (document.getElementById('tabela-filtro-churn')?.checked) p.set('churn', '1');
  if (document.getElementById('tabela-filtro-sem-match')?.checked) p.set('semMatch', '1');
  if (document.getElementById('tabela-filtro-acionaveis')?.checked) p.set('acionaveis', '1');
  if (document.getElementById('tabela-filtro-pago-manual')?.checked) p.set('pagoManual', '1');
  if (document.getElementById('tabela-filtro-iq-dentro')?.checked) p.set('iqSafra', 'dentro');
  else if (document.getElementById('tabela-filtro-iq-fora')?.checked) p.set('iqSafra', 'fora');
  for (const m of MARCADORES) {
    if (document.getElementById(`tabela-filtro-mk-${m}`)?.checked) p.set(`marcador_${m}`, '1');
  }
  for (let n = 1; n <= 5; n++) {
    const v = document.getElementById(`tf-f${n}`)?.value;
    if (v) p.set(`f${n}`, v);
  }

  try {
    const d = await fetch('/api/clientes?' + p).then(r => r.json());
    const tbody = document.getElementById('tabela-body');
    if (!d.dados?.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="loading">Nenhum cliente encontrado</td></tr>';
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
        <th>Ação</th>
        <th onclick="ordenar('nome')">Cliente ↕</th>
        <th onclick="ordenar('cpf')">CPF ↕</th>
        <th>Contato 1</th>
        <th>Contato 2</th>
        <th>Custcode</th>
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
    tabelaClientesAtual = d.dados;
    tbody.innerHTML = d.dados.map((c, idx) => {
      const fCells = Array.from({length: maxF}, (_, i) => {
        const fat = (c.faturas || []).find(f => f.numero === i + 1);
        if (!fat) return '<td class="dim">—</td>';
        const cls = fat.pagoManual ? 'status-PAGO-MANUAL' : fat.status === 'ADIMPLENTE' ? 'status-ADIMPLENTE' : fat.status === 'PAGO_ATRASO' ? 'status-PAGO-ATRASO' : fat.status === 'INADIMPLENTE' ? 'status-INADIMPLENTE' : '';
        const icone = fat.pagoManual ? '💛' : fat.status === 'ADIMPLENTE' ? '✅' : fat.status === 'PAGO_ATRASO' ? '🟠' : fat.status === 'INADIMPLENTE' ? '❌' : '—';
        const label = fat.pagoManual ? 'Pago (marcado manualmente via Base Pagos) — clique para desmarcar' : (fat.detalhamento || fat.statusPagamento || '—');
        const acao = fat.pagoManual ? ` onclick="desmarcarPagoManual(${idx}, ${i + 1})" style="cursor:pointer"` : '';
        return `<td><span class="status-tag ${cls}" title="${label}"${acao}>${icone} ${fat.dataVencimento || ''}</span></td>`;
      }).join('');
      const fmtTel = t => t ? t.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3') : '—';
      const marcs = (c.marcadores || []).map(m => {
        const info = MARCADOR_INFO[m];
        return info ? `<span class="marc-tag" title="${info.label}">${info.icone}</span>` : '';
      }).join('');
      const temAnot = c.totalAnotacoes > 0;
      const tituloAnot = temAnot ? `${c.totalAnotacoes} anotação(ões)` : 'Adicionar anotação';
      return `<tr id="tb-row-${idx}">
        <td id="tb-acao-${idx}" class="acao-col">
          <button class="btn-edit-os" onclick="editarClienteTabela(${idx})" title="Editar dados">✏️</button>
          <button class="btn-edit-os${temAnot ? ' tem-anotacao' : ''}" onclick="abrirModalAnotacoes(${idx})" title="${tituloAnot}">📝</button>
        </td>
        <td id="tb-nome-${idx}">${c.nome || '<em class="dim">Sem match</em>'}${marcs ? ' ' + marcs : ''}</td>
        <td id="tb-cpf-${idx}" class="cpf-col">${c.cpf || '—'}</td>
        <td id="tb-c1-${idx}" class="tel-col">${fmtTel(c.contatoPrincipal)}</td>
        <td id="tb-c2-${idx}" class="tel-col">${fmtTel(c.contatoResponsavel)}</td>
        <td id="tb-custcode-${idx}" class="custcode-col">${c.custcode || '—'}</td>
        <td id="tb-os-${idx}" class="os-col">${c.os || '—'}</td>
        <td id="tb-vendedor-${idx}">${c.vendedor || '—'}</td>
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
  aplicarFiltros();
}

// Checkboxes "Dentro do IQ" / "Fora do IQ" são mutuamente exclusivos — marcar
// um desmarca o outro, já que um cliente não pode estar nos dois ao mesmo tempo.
function onIqCheckbox(qual) {
  const outro = document.getElementById(qual === 'dentro' ? 'tabela-filtro-iq-fora' : 'tabela-filtro-iq-dentro');
  if (outro) outro.checked = false;
  buscarTabela();
}

function limparTodosFiltros() {
  const ids = ['busca-tabela', 'tabela-filtro-status', 'tabela-filtro-uf', 'tabela-filtro-safra', 'tabela-filtro-vencimento'];
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const topo = document.getElementById('filtro-mesGross');
  const atalho = document.getElementById('tabela-filtro-mesgross');
  if (topo) topo.value = '';
  if (atalho) atalho.value = '';
  atualizarVendedoresPorMesGross('');
  _buscaTabelaDigitado = '';
  ['tabela-filtro-churn', 'tabela-filtro-sem-match', 'tabela-filtro-acionaveis',
   'tabela-filtro-pago-manual', 'tabela-filtro-iq-dentro', 'tabela-filtro-iq-fora',
   ...MARCADORES.map(m => `tabela-filtro-mk-${m}`)].forEach(id => {
    const el = document.getElementById(id); if (el) el.checked = false;
  });
  for (let n = 1; n <= 5; n++) { const el = document.getElementById(`tf-f${n}`); if (el) el.value = ''; }
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
let tabelaClientesAtual = [];

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
    tbody.innerHTML = '<tr><td colspan="8" class="loading">✅ Nenhum cliente pendente</td></tr>';
    return;
  }
  const fmtTel = t => t ? t.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3') : '—';
  tbody.innerHTML = clientes.map((c, i) => `
    <tr id="ajuste-row-${i}">
      <td>${i + 1}</td>
      <td id="aj-nome-${i}">${c.nome || '<em class="dim">—</em>'}</td>
      <td id="aj-cpf-${i}" class="cpf-col">${c.cpf || '<em class="dim">—</em>'}</td>
      <td id="aj-c1-${i}" class="tel-col">${fmtTel(c.contatoPrincipal)}</td>
      <td id="aj-c2-${i}" class="tel-col">${fmtTel(c.contatoResponsavel)}</td>
      <td id="aj-mes-${i}">${c.mesGross || c.mesGrossManual || '<em class="dim">Sem data</em>'}</td>
      <td id="aj-os-${i}" class="os-col">${c.os || '<em class="dim">vazio</em>'}</td>
      <td id="aj-acao-${i}">
        <button class="btn-edit-os" onclick="editarCliente(${i})" title="Editar">✏️</button>
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

function editarCliente(idx) {
  const c = ajusteClientesAtual[idx];
  const fmtTelInput = t => t ? t.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3') : '';
  document.getElementById(`aj-nome-${idx}`).innerHTML = `<input class="input-inline" id="ei-nome-${idx}" value="${(c.nome||'').replace(/"/g,'&quot;')}" placeholder="Nome">`;
  document.getElementById(`aj-cpf-${idx}`).innerHTML  = `<input class="input-inline" id="ei-cpf-${idx}"  value="${(c.cpf||'').replace(/"/g,'&quot;')}" placeholder="CPF">`;
  document.getElementById(`aj-c1-${idx}`).innerHTML   = `<input class="input-inline" id="ei-c1-${idx}"   value="${fmtTelInput(c.contatoPrincipal)}" placeholder="(41) 99999-0000">`;
  document.getElementById(`aj-c2-${idx}`).innerHTML   = `<input class="input-inline" id="ei-c2-${idx}"   value="${fmtTelInput(c.contatoResponsavel)}" placeholder="(41) 99999-0000">`;
  document.getElementById(`aj-mes-${idx}`).innerHTML  = `<input class="input-inline" id="ei-mes-${idx}"  value="${c.mesGross || c.mesGrossManual || ''}" placeholder="MM/AAAA">`;
  document.getElementById(`aj-os-${idx}`).innerHTML   = `<input class="input-inline" id="ei-os-${idx}"   value="${(c.os||'').replace(/"/g,'&quot;')}" placeholder="OS">`;
  document.getElementById(`aj-acao-${idx}`).innerHTML = `
    <button class="btn btn-primary btn-sm" onclick="salvarCliente(${idx})" title="Salvar">✅</button>
    <button class="btn btn-secondary btn-sm" onclick="renderTabelaAjustes(ajusteClientesAtual)" title="Cancelar">✖</button>
  `;
  document.getElementById(`ei-nome-${idx}`)?.focus();
}

async function salvarCliente(idx) {
  const c = ajusteClientesAtual[idx];
  const val = id => document.getElementById(id)?.value?.trim() || '';
  const payload = {
    osAtual: c.os,
    nome: val(`ei-nome-${idx}`),
    cpf: val(`ei-cpf-${idx}`),
    contatoPrincipal: val(`ei-c1-${idx}`),
    contatoResponsavel: val(`ei-c2-${idx}`),
    mesGross: val(`ei-mes-${idx}`),
  };
  try {
    const d = await fetch('/api/ajustes/corrigir-cliente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (d.erro) { alert('Erro: ' + d.erro); return; }
    ajusteClientesAtual[idx] = { ...c, nome: payload.nome, cpf: payload.cpf, mesGross: payload.mesGross };
    renderTabelaAjustes(ajusteClientesAtual);
    const acao = document.getElementById(`aj-acao-${idx}`);
    if (acao) acao.innerHTML = `<span class="${d.cruzado ? 'ajuste-corrigido' : 'ajuste-pendente'}">${d.cruzado ? '✅ Cruzado' : '✅ Salvo'}</span>`;
    await carregarStatusImportacao();
  } catch (err) { alert('Erro: ' + err.message); }
}

function editarClienteTabela(idx) {
  const c = tabelaClientesAtual[idx];
  const fmtTelInput = t => t ? t.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3') : '';
  document.getElementById(`tb-nome-${idx}`).innerHTML = `<input class="input-inline" id="tei-nome-${idx}" value="${(c.nome||'').replace(/"/g,'&quot;')}" placeholder="Nome">`;
  document.getElementById(`tb-cpf-${idx}`).innerHTML  = `<input class="input-inline" id="tei-cpf-${idx}"  value="${(c.cpf||'').replace(/"/g,'&quot;')}" placeholder="CPF">`;
  document.getElementById(`tb-c1-${idx}`).innerHTML   = `<input class="input-inline" id="tei-c1-${idx}"   value="${fmtTelInput(c.contatoPrincipal)}" placeholder="(41) 99999-0000">`;
  document.getElementById(`tb-c2-${idx}`).innerHTML   = `<input class="input-inline" id="tei-c2-${idx}"   value="${fmtTelInput(c.contatoResponsavel)}" placeholder="(41) 99999-0000">`;
  document.getElementById(`tb-os-${idx}`).innerHTML   = `<input class="input-inline" id="tei-os-${idx}"   value="${(c.os||'').replace(/"/g,'&quot;')}" placeholder="OS">`;
  document.getElementById(`tb-vendedor-${idx}`).innerHTML = `<input class="input-inline" id="tei-vendedor-${idx}" value="${(c.vendedor||'').replace(/"/g,'&quot;')}" placeholder="Vendedor">`;
  document.getElementById(`tb-custcode-${idx}`).innerHTML = `<input class="input-inline" id="tei-custcode-${idx}" value="${(c.custcode||'').replace(/"/g,'&quot;')}" placeholder="Custcode">`;
  document.getElementById(`tb-acao-${idx}`).innerHTML = `
    <button class="btn btn-primary btn-sm" onclick="salvarClienteTabela(${idx})" title="Salvar">✅</button>
    <button class="btn btn-secondary btn-sm" onclick="carregarTabela()" title="Cancelar">✖</button>
  `;
  document.getElementById(`tei-nome-${idx}`)?.focus();
}

async function salvarClienteTabela(idx) {
  const c = tabelaClientesAtual[idx];
  const val = id => document.getElementById(id)?.value?.trim() || '';
  const payload = {
    osAtual: c.os,
    nome: val(`tei-nome-${idx}`),
    cpf: val(`tei-cpf-${idx}`),
    contatoPrincipal: val(`tei-c1-${idx}`),
    contatoResponsavel: val(`tei-c2-${idx}`),
    mesGross: c.mesGross,
    vendedor: val(`tei-vendedor-${idx}`),
    custcode: val(`tei-custcode-${idx}`),
  };
  try {
    const d = await fetch('/api/ajustes/corrigir-cliente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (d.erro) { alert('Erro: ' + d.erro); return; }
    await carregarTabela();
  } catch (err) { alert('Erro: ' + err.message); }
}

// ─── Modal de anotações do cliente ───────────────────────────────────────────

let _anotClienteOs = null;

async function abrirModalAnotacoes(idx) {
  const c = tabelaClientesAtual[idx];
  if (!c?.os) return alert('Cliente sem OS — não é possível anotar.');

  _anotClienteOs = c.os;
  setText('anot-cliente-nome', c.nome || 'Cliente sem match');
  setText('anot-cliente-sub', `OS ${c.os}${c.cpf ? ' · CPF ' + c.cpf : ''}`);
  document.getElementById('anot-texto').value = '';
  document.getElementById('anot-historico').innerHTML = '<div class="dim">Carregando...</div>';
  document.getElementById('modal-anotacoes').style.display = 'flex';

  try {
    const d = await fetch(`/api/clientes/anotacoes/${encodeURIComponent(c.os)}`).then(r => r.json());
    aplicarDadosAnotacoes(d);
  } catch {
    document.getElementById('anot-historico').innerHTML = '<div class="dim">Erro ao carregar histórico.</div>';
  }
}

function aplicarDadosAnotacoes(d) {
  for (const m of MARCADORES) {
    const el = document.getElementById(`anot-mk-${m}`);
    if (el) el.checked = (d.marcadores || []).includes(m);
  }

  const lista = d.anotacoes || [];
  setText('anot-hist-count', lista.length ? `(${lista.length})` : '');
  const box = document.getElementById('anot-historico');

  if (!lista.length) {
    box.innerHTML = '<div class="dim">Nenhuma anotação ainda.</div>';
    return;
  }

  // Mais recentes primeiro — é o que interessa em um atendimento.
  box.innerHTML = lista.map((a, i) => `
    <div class="anot-item">
      <div class="anot-item-topo">
        <span class="anot-item-meta">${a.autor || 'Sistema'} · ${new Date(a.criadoEm).toLocaleString('pt-BR')}</span>
        <button class="btn-excluir-anot" title="Excluir anotação" onclick="excluirAnotacao(${i})">🗑 Excluir</button>
      </div>
      <div class="anot-item-texto">${escaparHtml(a.texto)}</div>
    </div>
  `).reverse().join('');
}

function escaparHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}

async function salvarAnotacao() {
  if (!_anotClienteOs) return;
  const texto = document.getElementById('anot-texto').value.trim();
  const marcadores = MARCADORES.filter(m => document.getElementById(`anot-mk-${m}`)?.checked);

  try {
    const d = await fetch(`/api/clientes/anotacoes/${encodeURIComponent(_anotClienteOs)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto, marcadores }),
    }).then(r => r.json());
    if (d.erro) return alert('Erro: ' + d.erro);

    document.getElementById('anot-texto').value = '';
    aplicarDadosAnotacoes(d);
    carregarTabela(); // atualiza os indicadores na linha
  } catch (e) { alert('Erro: ' + e.message); }
}

async function excluirAnotacao(indice) {
  if (!_anotClienteOs || !confirm('Excluir esta anotação?')) return;
  try {
    const d = await fetch(`/api/clientes/anotacoes/${encodeURIComponent(_anotClienteOs)}/${indice}`, { method: 'DELETE' })
      .then(r => r.json());
    if (d.erro) return alert('Erro: ' + d.erro);
    aplicarDadosAnotacoes(d);
    carregarTabela();
  } catch (e) { alert('Erro: ' + e.message); }
}

function fecharModalAnotacoes(ev) {
  if (ev.target.id === 'modal-anotacoes') fecharModalAnotacoesBtn();
}

function fecharModalAnotacoesBtn() {
  document.getElementById('modal-anotacoes').style.display = 'none';
  _anotClienteOs = null;
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

// ─── Reprocessar Erros ───────────────────────────────────────────────────────

async function reprocessarErros() {
  const info = document.getElementById('reproc-info');
  if (info) info.textContent = 'Montando fila de erros...';
  try {
    const d = await fetch('/api/comando/reprocessar-erros', { method: 'POST' }).then(r => r.json());
    if (d.erro) {
      adicionarLog('Erro ao reprocessar: ' + d.erro, 'erro');
      if (info) info.textContent = 'Erro: ' + d.erro;
      return;
    }
    if (d.total === 0) {
      adicionarLog('✅ Nenhum erro para reprocessar!', 'robo');
      if (info) info.textContent = '✅ Nenhum erro pendente.';
    } else {
      adicionarLog(`🔄 ${d.total} erro(s) na fila. Inicie os robôs para reprocessar (divididos entre eles).`, 'robo');
      if (info) info.textContent = `🔄 ${d.total} erro(s) prontos — inicie os robôs para reprocessar.`;
    }
  } catch (e) {
    adicionarLog('Erro: ' + e.message, 'erro');
    if (info) info.textContent = 'Erro: ' + e.message;
  }
}

async function gerarBaseReprocessados() {
  const info = document.getElementById('reproc-info');
  if (info) info.textContent = 'Gerando base dos reprocessados...';
  try {
    const d = await fetch('/api/comando/base-reprocessados', { method: 'POST' }).then(r => r.json());
    if (d.erro) {
      adicionarLog('Erro: ' + d.erro, 'erro');
      if (info) info.textContent = 'Erro: ' + d.erro;
      return;
    }
    adicionarLog(`📤 Base gerada com ${d.total} reprocessado(s): ${d.arquivo}`, 'robo');
    if (info) info.textContent = `📤 ${d.total} reprocessado(s) — base "${d.arquivo}" pronta para disparo.`;
    // Atualiza o dropdown de relatórios e já seleciona a base nova
    if (typeof carregarRelatorios === 'function') {
      await carregarRelatorios();
      const sel = document.getElementById('select-relatorio');
      if (sel) { sel.value = d.arquivo; sel.dispatchEvent(new Event('change')); }
    }
  } catch (e) {
    adicionarLog('Erro: ' + e.message, 'erro');
    if (info) info.textContent = 'Erro: ' + e.message;
  }
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
    carregarHistoricoRobos();
  }
}

async function verificarStatusRobo() {
  try {
    const d = await fetch('/api/status-robos').then(r => r.json());
    atualizarBadge('robo', d.robo);
    atualizarBadge('disparo', d.disparo);
    if (d.estados) ['PR', 'SC', 'RS', 'PR2', 'SC2', 'RS2'].forEach(e => atualizarCardEstado(e, d.estados[e]));
    atualizarBotoesDisparo(d.disparo === 'rodando');
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
    const forcar = document.getElementById('disparo-forcar')?.checked || false;
    // "Pendentes" sempre mostra o real (quem ainda não recebeu) — não muda de
    // significado com a caixa "Reenviar já disparados" pra não confundir; o
    // efeito dessa caixa aparece só no aviso abaixo.
    const pendMsg = (d.totalDisparos || 0) - (d.disparadosMsg || 0);
    const avisoForcar = document.getElementById('disparo-forcar-aviso');
    if (avisoForcar) avisoForcar.style.display = forcar ? 'block' : 'none';

    // Distribuição por número de faturas
    const fat1 = d.clientesUmaFatura || 0;
    const fat2 = d.clientesDuasFaturas || 0;
    const fat3 = d.clientesTresMaisFaturas || 0;
    const fatStr = [
      fat1 ? `${fat1} com 1 fat.` : '',
      fat2 ? `${fat2} com 2 fat.` : '',
      fat3 ? `<span style="color:var(--laranja,#f97316);font-weight:600">${fat3} com 3+ fat.</span>` : '',
    ].filter(Boolean).join(' · ');

    const totalMsg = d.totalDisparos || 0;
    const dispMsg = d.disparadosMsg || 0;
    const hojeMsg = d.disparadosHojeMsg || 0;
    const hojeStr = hojeMsg > 0 ? ` <span style="color:var(--verde);font-size:11px">(+${hojeMsg} hoje)</span>` : '';
    if (info) {
      info.innerHTML = `📋 ${d.total} cliente(s) · 📨 ${dispMsg} / ${totalMsg} msgs disparadas${hojeStr} · ⏳ ${pendMsg} pendentes`
        + (fatStr ? `<br>📊 ${fatStr}` : '');
      info.style.color = pendMsg > 0 ? 'var(--azul-c)' : 'var(--verde)';
    }

    // Barra de progresso estática
    const barraWrap = document.getElementById('disparo-barra-static-wrap');
    const barraFill = document.getElementById('disparo-barra-fill');
    const barraPct  = document.getElementById('disparo-barra-pct');
    const barraLbl  = document.getElementById('disparo-barra-label');
    const barraSub  = document.getElementById('disparo-barra-sub');
    if (barraWrap && totalMsg > 0) {
      const pct = Math.round((dispMsg / totalMsg) * 100);
      const pendentesReais = totalMsg - dispMsg;
      barraWrap.style.display = 'block';
      barraFill.style.width = pct + '%';
      barraPct.textContent = pct + '%';
      barraLbl.textContent = `Disparados total (${hojeMsg} hoje)`;
      barraSub.textContent = `${dispMsg} / ${totalMsg} msgs · ${pendentesReais} pendentes`;
    } else if (barraWrap) {
      barraWrap.style.display = 'none';
    }

    // Com "Reenviar já disparados" ativo, o robô manda pra TODO mundo de novo,
    // não só pros pendentes — a estimativa de tempo precisa refletir isso.
    calcularTempoDisparo(forcar ? totalMsg : pendMsg);
  } catch (e) { if (info) info.textContent = 'Erro ao ler relatório: ' + e.message; }
}

function calcularTempoDisparo(pendentes) {
  const el = document.getElementById('disparo-tempo-estimado');
  if (!el) return;
  const qtd     = pendentes || 0;
  const delay   = parseInt(document.getElementById('disparo-delay')?.value) || 30;
  const lote    = parseInt(document.getElementById('disparo-lote')?.value)  || 50;
  const pausa   = parseInt(document.getElementById('disparo-pausa-lote')?.value) || 300;
  const limite  = parseInt(document.getElementById('disparo-limite')?.value) || qtd;
  const total   = Math.min(qtd, limite);
  if (total <= 0) { el.textContent = ''; return; }
  const lotes   = Math.floor(total / lote);
  const totalSeg = (total * delay) + (lotes * pausa);
  const h = Math.floor(totalSeg / 3600);
  const m = Math.floor((totalSeg % 3600) / 60);
  const s = totalSeg % 60;
  const tempo = h > 0 ? `${h}h ${m}min` : m > 0 ? `${m}min ${s}s` : `${s}s`;
  el.textContent = `⏱ Tempo estimado para ${total} envios: ${tempo} (${delay}s/envio · lote ${lote} · pausa ${pausa}s)`;
}

let _progressoInicio = null;
let _progressoUltimoAtual = 0;

function atualizarProgresso(atual, total) {
  const wrap = document.getElementById('disparo-progresso-wrap');
  const bar  = document.getElementById('progresso-bar-fill');
  const pct  = document.getElementById('progresso-pct');
  const lbl  = document.getElementById('progresso-label');
  const sub  = document.getElementById('progresso-sub');
  const vel  = document.getElementById('progresso-velocidade');
  if (!wrap) return;
  wrap.style.display = 'block';

  if (!_progressoInicio && atual > 0) {
    _progressoInicio = Date.now();
    localStorage.setItem('disparo-inicio', _progressoInicio);
  }
  _progressoUltimoAtual = atual;

  const p = total > 0 ? Math.round((atual / total) * 100) : 0;
  bar.style.width = p + '%';
  pct.textContent = p + '%';
  lbl.textContent = atual >= total ? '✅ Disparo concluído!' : '📤 Disparando...';
  sub.textContent = `${atual} / ${total} msgs`;

  if (vel && _progressoInicio && atual > 0) {
    const minutos = (Date.now() - _progressoInicio) / 60000;
    const ritmo = atual / minutos; // msgs/min
    const restantes = total - atual;
    const minRestantes = restantes / ritmo;
    const horasR = Math.floor(minRestantes / 60);
    const minR = Math.round(minRestantes % 60);
    const tempoStr = horasR > 0 ? `${horasR}h${minR}min` : `${Math.round(minRestantes)}min`;
    vel.textContent = atual >= total
      ? `✅ Concluído em ${Math.round(minutos)}min`
      : `⚡ ${ritmo.toFixed(1)} msgs/min · resta ~${tempoStr}`;
    if (atual >= total) { _progressoInicio = null; _progressoUltimoAtual = 0; }
  }
}

let _autoRefreshBarraInterval = null;

function atualizarBotoesDisparo(rodando) {
  const btnDisparar = document.getElementById('btn-disparar');
  const btnParar = document.getElementById('btn-parar-disparo');
  if (btnDisparar) btnDisparar.style.display = rodando ? 'none' : '';
  if (btnParar) btnParar.style.display = rodando ? '' : 'none';

  if (rodando && !_autoRefreshBarraInterval) {
    _autoRefreshBarraInterval = setInterval(() => atualizarInfoRelatorio(), 30000);
  } else if (!rodando && _autoRefreshBarraInterval) {
    clearInterval(_autoRefreshBarraInterval);
    _autoRefreshBarraInterval = null;
    _progressoInicio = null;
    localStorage.removeItem('disparo-inicio');
    atualizarInfoRelatorio(); // atualiza uma última vez ao parar
  }
}

async function dispararFaturas() {
  salvarEstadoDisparo();
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
      body: JSON.stringify({ relatorio, limite: limite || undefined, delay, lote, pausaLote, forcar: document.getElementById('disparo-forcar')?.checked || false }),
    }).then(r => r.json());
    if (d.erro) adicionarLog('Erro: ' + d.erro, 'disparo-log');
    else { adicionarLog('Disparando: ' + d.relatorio, 'disparo-log'); atualizarBotoesDisparo(true); }
  } catch (e) { adicionarLog('Erro: ' + e.message, 'disparo-log'); }
}

async function limparRelatoriosDisparo() {
  if (!confirm('Apagar todos os relatórios de disparo? Esta ação não pode ser desfeita.')) return;
  try {
    const r = await fetch('/api/relatorios-disparo', { method: 'DELETE' }).then(r => r.json());
    if (r.ok) carregarRelatoriosDisparo();
  } catch (e) { alert('Erro ao limpar: ' + e.message); }
}

async function carregarRelatoriosDisparo() {
  const inline = document.getElementById('rel-disparo-lista-inline');
  try {
    const { arquivos } = await fetch('/api/relatorios-disparo').then(r => r.json());
    if (!inline) return;
    if (!arquivos.length) { inline.textContent = 'nenhum relatório'; return; }
    // Mostra os arquivos como links inline, separados por ·
    inline.innerHTML = arquivos.map(f => {
      const m = f.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
      const label = m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : f;
      return `<a href="/api/relatorios-disparo/download/${encodeURIComponent(f)}" style="color:var(--azul-c);text-decoration:none;font-size:10px" download>📊 ${label}</a>`;
    }).join(' · ');
  } catch (e) { if (inline) inline.textContent = 'erro'; }
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
              <div class="fatura-item-topo">
                <span class="fatura-mes">${formatarMesAno(f.mesAno)}</span>
                <a class="btn btn-sm btn-secondary fatura-dl" href="/api/faturas/download/${encodeURIComponent(f.arquivo)}" download>⬇ Baixar</a>
              </div>
              <div class="fatura-codigos">
                ${f.pix
                  ? `<button class="btn-copiar-codigo" onclick="copiarCodigoFatura(this)" data-codigo="${escaparHtml(f.pix)}" title="${escaparHtml(f.pix)}">📋 Pix</button>`
                  : `<span class="fatura-codigo-vazio" title="Código Pix não encontrado nessa fatura">— Pix</span>`}
                ${f.linhaDigitavel
                  ? `<button class="btn-copiar-codigo" onclick="copiarCodigoFatura(this)" data-codigo="${escaparHtml(f.linhaDigitavel)}" title="${escaparHtml(f.linhaDigitavel)}">📋 Boleto</button>`
                  : `<span class="fatura-codigo-vazio" title="Linha digitável não encontrada nessa fatura">— Boleto</span>`}
              </div>
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

async function copiarCodigoFatura(btn) {
  const codigo = btn.dataset.codigo;
  if (!codigo) return;
  try {
    await navigator.clipboard.writeText(codigo);
    const original = btn.textContent;
    btn.textContent = '✅ Copiado!';
    btn.classList.add('copiado');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copiado'); }, 1500);
  } catch {
    alert('Não foi possível copiar automaticamente. Código:\n\n' + codigo);
  }
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


// ─── Histórico de Robôs ───────────────────────────────────────────────────────

async function carregarHistoricoRobos() {
  try {
    const hist = await fetch('/api/historico-robos').then(r => r.json());
    const estados = ['PR', 'SC', 'RS', 'PR2', 'SC2', 'RS2'];
    const agora = Date.now();
    for (const est of estados) {
      const el = document.getElementById(`robo-historico-${est}`);
      if (!el) continue;
      const h = hist[est];
      if (!h) { el.textContent = ''; continue; }
      const dt = new Date(h.ultimoRun);
      const diffH = (agora - dt.getTime()) / 3600000;
      const dataStr = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const taxaSucesso = h.total > 0 ? Math.round((h.sucesso / h.total) * 100) : 0;
      let html = `🕐 ${dataStr} · ${h.sucesso}/${h.total} (${taxaSucesso}%)`;
      if (diffH > 8) html += `<br><span class="aviso-sessao">⚠️ Sessão pode ter expirado</span>`;
      el.innerHTML = html;
    }
  } catch {}
}
