// Faturas localizadas no portal da TIM pelo robo, para clientes que ainda nao
// aparecem no Sonar. Ficam fora da base cruzada de proposito: IQ, cards e
// percentuais continuam so com Sonar; so a tabela, a exportacao e a base do robo
// enxergam estes dados.

const soDigitos = s => String(s || '').replace(/\D/g, '');

function dataBr(s) {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}

// Registra o resultado de UMA consulta bem sucedida. Fatura que estava aberta e
// nao veio mais = paga. Consulta sem fatura so marca pagas se o portal mostrou a
// tabela vazia (semFaturaConfirmado), para falha de carregamento nao virar pagamento.
function registrarConsulta(base, { custcode, faturas, consultadoEm, semFaturaConfirmado }) {
  const chave = soDigitos(custcode);
  if (!chave || !Array.isArray(faturas)) return false;
  const quando = new Date(consultadoEm || Date.now());
  if (isNaN(quando)) return false;
  const validas = faturas.filter(f => dataBr(f && f.vencimento));
  if (validas.length !== faturas.length) return false;
  const reg = base[chave] || { custcode, faturas: {} };
  if (reg.consultadoEm && new Date(reg.consultadoEm) > quando) return false; // consulta mais antiga
  const iso = quando.toISOString();
  const vistas = new Set(validas.map(f => f.vencimento));
  if (validas.length || semFaturaConfirmado) {
    for (const f of Object.values(reg.faturas)) {
      if (!f.pagoEm && !vistas.has(f.vencimento)) f.pagoEm = iso;
    }
  }
  for (const f of validas) {
    reg.faturas[f.vencimento] = { vencimento: f.vencimento, valor: String(f.valor || '').slice(0, 30), vistoEm: iso, pagoEm: null };
  }
  reg.consultadoEm = iso;
  base[chave] = reg;
  return true;
}

// Copia da lista em que quem nao tem fatura no Sonar recebe as do portal.
function comPortal(lista, base, hoje = new Date()) {
  const inicioHoje = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return lista.map(c => {
    if (c.totalFaturas) return c;
    const reg = base[soDigitos(c.custcode)];
    if (!reg) return c;
    const faturas = Object.values(reg.faturas)
      .sort((a, b) => dataBr(a.vencimento) - dataBr(b.vencimento))
      .map((f, i) => ({
        numero: i + 1,
        dataVencimento: f.vencimento,
        dataPagamento: null,
        valor: f.valor,
        status: f.pagoEm ? 'ADIMPLENTE' : (dataBr(f.vencimento) < inicioHoje ? 'INADIMPLENTE' : 'A VENCER'),
        portal: true,
        consultadoEm: reg.consultadoEm,
      }));
    if (!faturas.length) return { ...c, fonte: 'portal', consultadoPortalEm: reg.consultadoEm };
    const status = faturas.some(f => f.status === 'INADIMPLENTE') ? 'INADIMPLENTE'
      : faturas.some(f => f.status === 'A VENCER') ? 'A VENCER' : 'ADIMPLENTE';
    return {
      ...c, faturas, status, fonte: 'portal', consultadoPortalEm: reg.consultadoEm,
      totalFaturas: faturas.length,
      faturasPagas: faturas.filter(f => f.status === 'ADIMPLENTE').length,
    };
  });
}

// Filtro "Portal" da tabela
function filtrarPortal(lista, valor) {
  const tem = (c, st) => c.fonte === 'portal' && (c.faturas || []).some(f => f.status === st);
  if (valor === 'todos') return lista.filter(c => c.fonte === 'portal');
  if (valor === 'avencer') return lista.filter(c => tem(c, 'A VENCER'));
  if (valor === 'vencida') return lista.filter(c => tem(c, 'INADIMPLENTE'));
  if (valor === 'semfatura') return lista.filter(c => c.fonte === 'portal' && !(c.faturas || []).some(f => f.status !== 'ADIMPLENTE'));
  return lista;
}

module.exports = { registrarConsulta, comPortal, filtrarPortal };
