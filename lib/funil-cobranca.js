// Funil da última base mandada ao robô: base → robô baixou a fatura → disparo enviou → marcado como cobrado.
// Para quem ficou para trás, diz ONDE parou (motivo). Cálculo puro: o server.js entrega os dados já lidos.
'use strict';

const MOTIVOS = {
  foraBase: {
    titulo: 'Não estava na base entregue ao robô',
    explicacao: 'Entrou em risco depois que a base foi gerada, ou ficou de fora na geração (prometeu pagar, sem custcode ou sem telefone).',
    acao: 'Gere uma base nova: o botão "Mandar para o robô" já filtra quem ainda não foi cobrado.',
  },
  semPdf: {
    titulo: 'O robô não baixou a fatura',
    explicacao: 'Não há PDF dessa fatura. Costuma ser "Sem faturas" no portal (o cliente pode ter pago depois do último Sonar) ou erro do robô.',
    acao: 'Espere o próximo Sonar: quem pagou sai da lista. Quem continuar aqui, confira no relatório do robô daquele dia.',
  },
  telInvalido: {
    titulo: 'Fatura baixada, mas o telefone é inválido',
    explicacao: 'O número principal não tem formato de celular brasileiro (55 + DDD + 8 ou 9 dígitos), então o WhatsApp não aceita.',
    acao: 'Corrija o telefone no cadastro e mande de novo.',
  },
  naoEnviado: {
    titulo: 'Fatura baixada, mas o disparo não enviou',
    explicacao: 'O PDF existe e o telefone tem formato válido, mas não há registro de envio. O motivo exato está no log do disparo (PC do robô).',
    acao: 'Veja as pastas disparo_log / relatorios_disparo no PC do robô, ou gere uma nova base e rode de novo.',
  },
  jaRecebeu: {
    titulo: 'Só recebeu essa fatura antes desta base',
    explicacao: 'Há envio dessa fatura em data anterior, mas nenhum desde que esta base foi gerada. O motivo de não ter saído de novo está no relatório do robô e no log do disparo (PC do robô).',
    acao: 'Confira os dois no PC do robô, ou mande uma base nova para tentar outra vez.',
  },
  enviadoSemMarca: {
    titulo: 'Enviado, mas não marcado como cobrado',
    explicacao: 'Há registro de envio depois da base, mas o cliente não foi marcado (telefone diferente do cadastro ou campanha já vencida).',
    acao: 'Marque na mão com o botão "Cobrei", se for o caso.',
  },
};

const telefoneValido = t => /^55\d{2}\d{8,9}$/.test(String(t || '').replace(/\D/g, ''));
const mesAno = d => `${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

// Índice dos PDFs por "identificador|MM-AAAA" (o nome é NOME_ID_MM-AAAA.pdf, e o ID pode ser custcode ou CPF).
function indexarPdfs(pdfs) {
  const idx = new Map();
  for (const p of pdfs || []) {
    const m = String(p.nome).match(/_([^_]+)_(\d{2}-\d{4})\.pdf$/i);
    if (!m) continue;
    const k = `${m[1]}|${m[2]}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(p);
  }
  return idx;
}

// Faturas que estavam em aberto (já vencidas, até ~30 dias) quando a base foi gerada.
function faturasAlvo(cliente, criadoEm, parseDataBr) {
  const dia = new Date(new Date(criadoEm).getTime() - 3 * 3600e3); // Brasília
  const base = new Date(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate());
  const limite = new Date(base); limite.setDate(limite.getDate() - 31);
  const alvo = [];
  for (const f of cliente.faturas || []) {
    if (f.pagoManual) continue;
    const venc = parseDataBr(f.dataVencimento);
    if (!venc || venc > base || venc < limite) continue;
    const pag = parseDataBr(f.dataPagamento);
    if (pag && pag < base) continue;                       // já estava paga antes da base: nunca foi alvo
    alvo.push({ venc, mes: mesAno(venc), paga: !!pag });
  }
  return alvo;
}

function funilCampanha({ camp, todos, linhasRisco, pdfs, envios, parseDataBr, limiteLista = 300 }) {
  const porOs = new Map(todos.map(c => [c.os, c]));
  const noRisco = new Map(linhasRisco.map(d => [d.os, d]));
  const idxPdf = indexarPdfs(pdfs);
  const enviosPorArquivo = new Map();
  for (const v of Object.values(envios || {})) {
    for (const f of (v.faturas || (v.arquivo ? [v] : []))) {
      if (!enviosPorArquivo.has(f.arquivo)) enviosPorArquivo.set(f.arquivo, new Set());
      enviosPorArquivo.get(f.arquivo).add(f.enviadoEm);
    }
  }
  const criadoMs = new Date(camp.criadoEm).getTime();
  const osBase = [...new Set(Object.values(camp.mapa || {}))];
  const marcados = camp.marcados || {};

  const etapas = { base: osBase.length, baixou: 0, enviou: 0, marcou: 0 };
  const grupos = {};
  const add = (cod, cli) => { (grupos[cod] = grupos[cod] || []).push(cli); };
  const dtBrt = iso => { const d = new Date(new Date(iso).getTime() - 3 * 3600e3); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

  let saiuDoRisco = 0, tratados = 0;
  for (const os of osBase) {
    const c = porOs.get(os); if (!c) continue;
    const alvo = faturasAlvo(c, camp.criadoEm, parseDataBr);
    const arqs = [];
    for (const a of alvo) for (const id of [c.custcode, c.cpf]) for (const p of idxPdf.get(`${id}|${a.mes}`) || []) arqs.push(p);
    const temPdf = arqs.length > 0;
    const enviosCli = arqs.flatMap(p => [...(enviosPorArquivo.get(p.nome) || [])]);
    const enviouDepois = enviosCli.filter(e => new Date(e).getTime() >= criadoMs);
    const enviouAntes = enviosCli.filter(e => new Date(e).getTime() < criadoMs);
    const marcou = !!marcados[os];

    if (temPdf) etapas.baixou++;
    if (enviouDepois.length || marcou) etapas.enviou++;
    if (marcou) etapas.marcou++;

    const linha = noRisco.get(os);
    if (!linha) { saiuDoRisco++; continue; }                        // pagou / saiu do risco: nada a fazer
    if (marcou) continue;
    if (linha.cobranca.status !== 'pendente') { tratados++; continue; } // prometeu pagar ou cobrado à mão

    const info = { os, nome: c.nome, custcode: c.custcode, telefone: c.contatoPrincipal || '', vencimento: linha.vencimento, diasAtraso: linha.diasAtraso, vendedor: c.vendedor || '', uf: c.uf || '' };
    if (enviouDepois.length) add('enviadoSemMarca', { ...info, detalhe: 'Enviado em ' + [...new Set(enviouDepois.map(dtBrt))].join(', ') });
    else if (enviouAntes.length) add('jaRecebeu', { ...info, detalhe: 'Fatura já enviada em ' + [...new Set(enviouAntes.map(dtBrt))].join(', ') });
    else if (!temPdf) add('semPdf', { ...info, detalhe: 'Nenhum PDF da fatura de ' + [...new Set(alvo.map(a => a.mes.replace('-', '/')))].join(', ') });
    else if (!telefoneValido(c.contatoPrincipal)) add('telInvalido', { ...info, detalhe: 'Telefone com formato inválido: ' + (c.contatoPrincipal || '(vazio)') });
    else add('naoEnviado', { ...info, detalhe: 'PDF baixado em ' + [...new Set(arqs.map(p => dtBrt(p.em)))].join(', ') });
  }

  // Quem está pendente hoje mas nem entrou na base
  const naBase = new Set(osBase);
  for (const d of linhasRisco) {
    if (d.cobranca.status !== 'pendente' || naBase.has(d.os)) continue;
    if (camp.faixa && camp.faixa !== 'emRisco' && d.faixa !== camp.faixa) continue; // a base era só de uma faixa
    const c = porOs.get(d.os) || {};
    add('foraBase', { os: d.os, nome: d.nome, custcode: d.custcode, telefone: d.contato || '', vencimento: d.vencimento, diasAtraso: d.diasAtraso, vendedor: d.vendedor || '', uf: d.uf || '',
      detalhe: !c.contatoPrincipal ? 'Sem telefone' : 'Entrou em risco depois da base ou ficou de fora na geração' });
  }

  const motivos = Object.keys(MOTIVOS).filter(k => grupos[k]).map(k => ({
    codigo: k, ...MOTIVOS[k], qtd: grupos[k].length,
    clientes: grupos[k].sort((a, b) => String(a.nome).localeCompare(String(b.nome))).slice(0, limiteLista),
  }));
  const pendentes = motivos.reduce((s, m) => s + m.qtd, 0);
  return {
    campanha: { id: camp.id, criadoEm: camp.criadoEm, faixa: camp.faixa, total: camp.total },
    etapas, saiuDoRisco, tratados, pendentes, motivos,
  };
}

module.exports = { funilCampanha, faturasAlvo, indexarPdfs, telefoneValido, MOTIVOS };
