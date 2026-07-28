// Cria ou atualiza um usuário de acesso ao dashboard.
// Uso: node criar-usuario.js <usuario> <senha> [nome]

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const USUARIOS_PATH = path.join(__dirname, 'data', 'usuarios.json');

const [, , usuario, senha, ...resto] = process.argv;
const nome = resto.join(' ') || usuario;

if (!usuario || !senha) {
  console.error('\nUso: node criar-usuario.js <usuario> <senha> [nome]\n');
  process.exit(1);
}

const usuarios = fs.existsSync(USUARIOS_PATH)
  ? JSON.parse(fs.readFileSync(USUARIOS_PATH, 'utf8'))
  : [];

const senhaHash = bcrypt.hashSync(senha, 10);
const existente = usuarios.find(u => u.usuario === usuario);

if (existente) {
  existente.senhaHash = senhaHash;
  existente.nome = nome;
  console.log(`✅ Senha atualizada para o usuário "${usuario}"`);
} else {
  usuarios.push({ usuario, senhaHash, nome, criadoEm: new Date().toISOString() });
  console.log(`✅ Usuário "${usuario}" criado`);
}

fs.mkdirSync(path.dirname(USUARIOS_PATH), { recursive: true });
fs.writeFileSync(USUARIOS_PATH, JSON.stringify(usuarios, null, 2));
