// Mescla a planilha de clientes importada com a base que já existe. Cálculo puro.
//
// Regra: quem identifica o cadastro é a OS. Um mesmo CPF pode ter 2 planos (2 OS, cada um com o
// seu custcode) — antes a junção era por CPF primeiro, e reimportar um cliente assim duplicava uma
// OS e copiava o custcode de um plano para o outro. CPF só serve para completar um cadastro antigo
// que ainda não tinha OS. Quem não veio na planilha continua na base.
'use strict';

const digitos = s => String(s || '').replace(/\D/g, '');
const nomeNorm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

// Mesma pessoa: CPF/CNPJ igual, ou (se algum não tem documento ou ele foi corrigido) o mesmo nome.
function mesmaPessoa(a, b) {
  const x = digitos(a.cpf), y = digitos(b.cpf);
  if (x && y && x === y) return true;
  const n = nomeNorm(a.nome), m = nomeNorm(b.nome);
  if (n && m) return n === m;
  return !n || !m; // um dos dois é um cadastro em branco
}

// Junta cadastros repetidos: o primeiro vale, os outros só preenchem o que estiver vazio.
function completar(lista) {
  const r = { ...lista[0] };
  for (const outro of lista.slice(1)) {
    for (const [k, v] of Object.entries(outro)) if ((r[k] === undefined || r[k] === null || r[k] === '') && v) r[k] = v;
  }
  return r;
}

function mesclarClientes(baseExistente, novos) {
  // 1) Linhas repetidas dentro da própria planilha (mesma OS, mesma pessoa) viram uma só
  const linhas = [];
  const porOsPlanilha = new Map();
  for (const n of novos) {
    const iguais = n.os ? (porOsPlanilha.get(n.os) || []) : [];
    const i = iguais.find(idx => mesmaPessoa(linhas[idx], n));
    if (i !== undefined) { linhas[i] = completar([n, linhas[i]]); continue; }
    if (n.os) porOsPlanilha.set(n.os, [...iguais, linhas.length]);
    linhas.push(n);
  }

  const porOs = new Map(), semOsPorCpf = new Map();
  for (const c of baseExistente) {
    if (c.os) { if (!porOs.has(c.os)) porOs.set(c.os, []); porOs.get(c.os).push(c); }
    else if (digitos(c.cpf)) { if (!semOsPorCpf.has(digitos(c.cpf))) semOsPorCpf.set(digitos(c.cpf), []); semOsPorCpf.get(digitos(c.cpf)).push(c); }
  }

  const consumidos = new Set();
  const resultado = [];
  const osComOutraPessoa = [];
  let adicionados = 0, atualizados = 0;

  for (const novo of linhas) {
    const daOs = (porOs.get(novo.os) || []).filter(c => !consumidos.has(c));
    let existentes = daOs.filter(c => mesmaPessoa(c, novo));
    if (!existentes.length && !daOs.length) {
      existentes = (semOsPorCpf.get(digitos(novo.cpf)) || []).filter(c => !consumidos.has(c));
    }
    // A OS já é de outra pessoa na base: não sobrescreve ninguém nem herda o custcode — avisa.
    if (!existentes.length && daOs.length) osComOutraPessoa.push(novo.os);

    if (existentes.length) {
      resultado.push({ ...completar(existentes), ...novo });
      existentes.forEach(c => consumidos.add(c));
      atualizados++;
    } else {
      resultado.push(novo);
      adicionados++;
    }
  }

  // Preserva quem já existia e não veio nesta importação (planilha parcial)
  for (const c of baseExistente) if (!consumidos.has(c)) resultado.push(c);

  return { resultado, adicionados, atualizados, osComOutraPessoa };
}

module.exports = { mesclarClientes, mesmaPessoa, completar };
