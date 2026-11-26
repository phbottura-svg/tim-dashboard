// Proteção da importação do Sonar: um custcode válido NUNCA é trocado por "0" ou vazio.
// (Em 25/11/2026 as planilhas de SC e RS vieram com 0 em todas as linhas e apagaram 2.701 códigos.)
// Cálculo puro. O Sonar tem um custcode por OS, então a OS diz qual código manter.
'use strict';

const LIMITE_AVISO = 0.02; // até 2% de linhas sem código é normal no Sonar (alguns já vêm zerados)

function protegerCustcode(antigos, novos, valido) {
  const porOs = new Map();
  for (const r of [...antigos, ...novos]) if (r.os && valido(r.custcode) && !porOs.has(r.os)) porOs.set(r.os, r.custcode);

  let semCodigo = 0, mantidos = 0;
  const registros = novos.map(r => {
    if (valido(r.custcode)) return r;
    semCodigo++;
    if (!porOs.has(r.os)) return r;
    mantidos++;
    return { ...r, custcode: porOs.get(r.os) };
  });

  const suspeito = novos.length > 0 && semCodigo / novos.length > LIMITE_AVISO;
  const aviso = suspeito
    ? `ATENÇÃO: ${semCodigo} de ${novos.length} linhas deste arquivo vieram sem custcode (0 ou vazio). ` +
      `Os códigos que o sistema já tinha foram mantidos (${mantidos}); ${semCodigo - mantidos} ficaram sem. ` +
      'Confira a coluna COD CUSTCODE CLIENTE da planilha.'
    : null;
  return { registros, semCodigo, mantidos, aviso };
}

module.exports = { protegerCustcode };
