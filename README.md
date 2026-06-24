# TIM SGR — Dashboard

Dashboard web local para gestão de faturas TIM. Mostra adimplência, disparos, gráficos e permite controlar o robô e o disparo de WhatsApp.

---

## Instalação e execução

```bash
cd tim-dashboard
npm install
node server.js
```

Acesse: **http://localhost:3000**

---

## Iniciar com um clique (Windows)

- Dê **duplo clique em `iniciar.bat`** para iniciar o dashboard manualmente. Ele reinicia o servidor automaticamente se ele cair.
- Dê **duplo clique em `instalar-startup.bat` uma única vez** para configurar o início automático junto com o Windows (toda vez que você fizer login, o dashboard sobe sozinho).

---

## Configuração do `.env`

```env
PORT=3000
GOOGLE_SHEET_ID=1a6DIXWja1uPSGtHSm_UKk7B9rdZ6YX7Gfk1OBJOXjV4
GOOGLE_SERVICE_ACCOUNT_PATH=./credentials/google-service-account.json
RELATORIOS_PATH=../tim-playwright/relatorios
DISPARO_LOG_PATH=../tim-playwright/disparo_log
PLAYWRIGHT_PATH=../tim-playwright
```

---

## Configurar Google Sheets (Service Account)

### 1. Criar projeto no Google Cloud Console

1. Acesse [console.cloud.google.com](https://console.cloud.google.com)
2. Clique em **"Novo Projeto"** → dê um nome (ex: `tim-dashboard`) → **Criar**
3. Com o projeto selecionado, vá em **APIs e Serviços** → **Biblioteca**
4. Pesquise **"Google Sheets API"** → clique em **Ativar**

### 2. Criar Service Account

1. Vá em **APIs e Serviços** → **Credenciais**
2. Clique em **"Criar credenciais"** → **"Conta de serviço"**
3. Dê um nome (ex: `tim-dashboard`) → **Criar e continuar** → **Concluído**
4. Clique na conta criada → aba **"Chaves"** → **"Adicionar chave"** → **"Criar nova chave"** → **JSON**
5. O arquivo JSON será baixado — renomeie para `google-service-account.json` e mova para `tim-dashboard/credentials/`

### 3. Compartilhar a planilha com a Service Account

1. Abra o arquivo JSON e copie o campo `client_email` (ex: `tim-dashboard@meu-projeto.iam.gserviceaccount.com`)
2. Abra a planilha no Google Sheets
3. Clique em **Compartilhar** → cole o e-mail da Service Account → permissão **Leitor** → **Enviar**

---

## Como interpretar os gráficos

| Gráfico | O que mostra |
|---|---|
| **Evolução Mensal** | Adimplentes vs Inadimplentes mês a mês (últimos 6 meses) |
| **Distribuição por Estado** | Pizza com proporção de clientes por PR / SC / RS |
| **Faturas Enviadas por Dia** | Barras com quantidade de PDFs disparados via WhatsApp nos últimos 30 dias |
| **Inadimplência por Vendedor** | Top 10 vendedores com mais clientes inadimplentes |
| **Faturas Baixadas pelo Robô** | Quantidade de faturas baixadas com sucesso pelo robô por dia |

---

## Filtros disponíveis

- **De / Até** → filtra por data de ativação do cliente
- **Vendedor** → filtra por vendedor específico
- **Estado** → PR, SC, RS (múltipla seleção)
- **Status** → Adimplente / Inadimplente

Todos os filtros afetam os cards, gráficos e tabela simultaneamente.

---

## Painel de comandos

| Botão | Ação |
|---|---|
| **▶ Iniciar Robô SGR** | Executa `node index.js` no diretório do playwright |
| **⏹ Parar Robô** | Interrompe o processo do robô |
| **📤 Disparar Faturas WhatsApp** | Executa `disparar-faturas.js` com o relatório mais recente |
| **🔄 Atualizar Dashboard** | Força nova leitura do Google Sheets e dos logs |

O log de saída aparece em tempo real no console abaixo dos botões.
