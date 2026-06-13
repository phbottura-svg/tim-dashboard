# Deploy no Coolify (VPS Hostinger)

## Arquitetura

```
PC local                    VPS (Coolify)
─────────────              ──────────────
tim-playwright/             tim-dashboard/
(robô PDF + disparo WA)     (visualização + dados)
        │                          │
        └──── Google Sheets ───────┘
              (fonte comum de dados)
```

O robô continua rodando no seu PC (precisa de Chrome visível). O dashboard fica acessível de qualquer lugar via VPS, sempre mostrando os dados atualizados do Google Sheets.

---

## 1. Preparar o repositório Git

No terminal, dentro da pasta `tim-dashboard`:

```bash
git init
git add .
git commit -m "Dashboard TIM inicial"
```

Crie um repositório **privado** no GitHub/GitLab e faça o push:

```bash
git remote add origin https://github.com/SEU_USUARIO/tim-dashboard.git
git push -u origin main
```

> ⚠️ O `.gitignore` já exclui `node_modules`, `.env` e as credenciais JSON.

---

## 2. No Coolify: criar o recurso

1. Acesse seu painel Coolify (ex: `coolify.suaVPS.com`)
2. Clique em **New Resource → Application**
3. Selecione **Dockerfile** como método de deploy
4. Conecte ao repositório Git criado acima
5. Branch: `main`
6. Porta exposta: `3000`

---

## 3. Variáveis de ambiente no Coolify

Configure as seguintes variáveis no painel do Coolify (aba **Environment Variables**):

| Variável | Valor | Obrigatório |
|---|---|---|
| `PORT` | `3000` | Sim |
| `GOOGLE_SHEET_ID` | `1a6DIXWja1uPSGtHSm_UKk7B9rdZ6YX7Gfk1OBJOXjV4` | Sim |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | *(conteúdo do JSON, ver abaixo)* | Sim |
| `MODO` | `vps` | Sim |
| `UPLOAD_TOKEN` | *(token seguro, ver abaixo)* | Sim |

### Como obter o valor de `GOOGLE_SERVICE_ACCOUNT_JSON`

No seu PC, abra o arquivo `credentials/google-service-account.json` e copie **todo o conteúdo** como uma única linha. Cole como valor da variável no Coolify.

No PowerShell:
```powershell
(Get-Content credentials\google-service-account.json -Raw) -replace "`r`n|`n", " "
```

Ou use o site [jsonformatter.org](https://jsonformatter.org) para minificar o JSON e colar tudo em uma linha.

### Como gerar o `UPLOAD_TOKEN`

O `UPLOAD_TOKEN` protege o endpoint de upload de PDFs do PC para o VPS. Gere um token aleatório seguro:

No PowerShell:
```powershell
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Ou no Linux/Mac:
```bash
openssl rand -base64 32
```

Exemplo de resultado: `K3mXp9Rq2vTsLwNbYcJdHfAuEgZiOk7lQnPmVxWyDs=`

Guarde esse token — ele será usado tanto no Coolify quanto no `tim-playwright/.env` local para enviar os PDFs.

---

## 4. Volume persistente para os PDFs (IMPORTANTE)

Sem um volume, os PDFs seriam apagados a cada novo deploy. Configure assim no Coolify:

1. Na tela do seu recurso, vá em **Storages** (ou **Volumes**)
2. Clique em **Add Volume**
3. Configure:
   - **Source** (Host Path): `/data/tim-dashboard/pdfs` *(ou outro caminho na VPS)*
   - **Destination** (Container Path): `/app/data/pdfs`
4. Salve e faça um novo deploy

Após configurado, os PDFs enviados pelo PC ficam persistentes mesmo após atualizações do dashboard.

---

## 5. Configurar domínio

No Coolify, aba **Domains**:
- Domínio: `dashboard.vonixxsc.com.br` (ou o subdomínio que preferir)
- O Coolify configura o HTTPS (Let's Encrypt) automaticamente

---

## 6. Deploy

Clique em **Deploy**. O Coolify vai:
1. Fazer o build da imagem Docker
2. Iniciar o container
3. Configurar o proxy reverso com HTTPS

---

## 7. Testar o upload de PDF via curl

Após o deploy, teste o envio de um PDF do PC para o VPS:

```bash
curl -X POST https://dashboard.vonixxsc.com.br/api/upload-pdf \
  -H "Authorization: Bearer SEU_UPLOAD_TOKEN" \
  -F "pdf=@/caminho/para/JOAO_SILVA_123.456.789-00_06-2026.pdf"
```

Resposta esperada:
```json
{"ok":true,"arquivo":"JOAO_SILVA_123.456.789-00_06-2026.pdf","tamanho":45231}
```

### Padrão de nome obrigatório

Os arquivos devem seguir o formato:
```
NOME_CPF_MM-AAAA.pdf
```
Exemplos válidos:
- `JOAO_SILVA_123.456.789-00_06-2026.pdf`
- `MARIA_SOUZA_987.654.321-00_05-2026.pdf`

### Configurar o `tim-playwright` para enviar PDFs automaticamente

No `tim-playwright/.env`, adicione:
```
VPS_UPLOAD_URL=https://dashboard.vonixxsc.com.br/api/upload-pdf
UPLOAD_TOKEN=SEU_UPLOAD_TOKEN
```

*(O código de envio automático pode ser adicionado ao `confirmarRecibo.js` após salvar o PDF local)*

---

## 8. Comportamento no VPS (MODO=vps)

Quando `MODO=vps`, o dashboard:
- **Oculta** os botões de Iniciar/Parar robôs SGR (PR/SC/RS)
- **Oculta** o painel de disparo WhatsApp
- **Mostra** um aviso explicando que os robôs rodam apenas localmente
- **Mantém** todos os gráficos, filtros, tabela de clientes e atualização do Google Sheets

---

## Atualizar o dashboard

Sempre que fizer mudanças no código:

```bash
git add .
git commit -m "descrição da mudança"
git push
```

O Coolify pode ser configurado para **auto-deploy** (webhook) ao receber push — ative em Settings → Auto Deploy.
