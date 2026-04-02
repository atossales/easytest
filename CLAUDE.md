# EasyTest — CLAUDE.md

> Instruções do projeto para Claude Code.
> Leia TUDO antes de escrever qualquer linha de código.

---

## 🌐 Idioma e comunicação

- **Responda sempre em português brasileiro (pt-BR)**
- Explicações, comentários inline, mensagens de erro ao usuário: pt-BR
- Nomes de variáveis, funções, arquivos, classes: inglês
- Commits: inglês, seguindo Conventional Commits
- Documentação técnica interna (este arquivo, README): pt-BR

---

## 📌 O que é este projeto

**EasyTest** é uma plataforma de testes A/B auto-hospedada, focada em simplicidade e deploy rápido via Docker.

### Contexto de negócio
- **Produto:** ferramenta para agências e freelancers que querem fazer A/B testing sem pagar por plataformas SaaS caras
- **Público-alvo:** times de marketing e devs que já têm páginas HTML prontas e querem comparar variações
- **Deploy:** Docker no EasyPanel (servidor próprio) ou qualquer VPS com Docker

### O que o sistema faz
1. **Gerencia testes A/B** — cria testes com 2+ variações de páginas HTML
2. **Distribui visitantes** — atribui variação por cookie, respeitando percentuais configurados
3. **Rastreia conversões** — via script `embed.js` injetado na página de conversão
4. **Injeta tracking automático** — insere GA4 + Meta Pixel nas páginas servidas
5. **Relatórios internos** — dashboard com views, conversões e taxa por variação
6. **Integração GA4** — dados do GA4 Data API via Service Account
7. **Deploy simples** — Dockerfile + docker-compose, tudo em um container

### O que o sistema NÃO faz (ainda)
- Autenticação de usuários múltiplos
- Proteção por senha do painel (a implementar)
- Testes em URLs externas (só páginas HTML hospedadas aqui)
- Significância estatística automática (a implementar)
- Multi-tenant / SaaS

---

## 🏗️ Arquitetura atual

```
easytest/
├── server.js              # Entry point — Express app + rotas principais
├── lib/
│   └── database.js        # SQLite (better-sqlite3) — schema + helpers
├── routes/
│   ├── tests.js           # CRUD de testes e variações + upload de HTML
│   ├── tracking.js        # POST /api/track/conversion
│   ├── reports.js         # GET /api/reports e /api/reports/:id
│   └── ga4.js             # Integração GA4 Data API
├── public/
│   └── index.html         # SPA — painel admin completo (HTML/CSS/JS puro)
├── db/                    # Criado em runtime
│   ├── easytest.db        # Banco SQLite
│   └── uploads/           # Arquivos HTML das variações
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── CLAUDE.md
```

### Banco de dados (SQLite)

```sql
tests          — id, name, test_uri, conversion_page_url, ga4_*, meta_pixel_id, active
variations     — id, name, percentage, remaining, test_id, file_path, file_original
interactions   — id, client_id, type (view|conversion), test_id, variation_id, created_at
settings       — key, value (armazena GA4 Property ID e Service Account JSON)
```

### Rotas principais

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/t/:slug` | Entrada do teste — atribui variação e redireciona |
| GET | `/p/:tid/:vid` | Serve a página da variação com tracking injetado |
| GET | `/embed.js` | Script de conversão para incluir na página de destino |
| GET/POST/PUT/DELETE | `/api/tests` | CRUD de testes |
| POST | `/api/track/conversion` | Registra conversão via cookie |
| GET | `/api/reports` | Relatório geral de todos os testes |
| GET | `/api/reports/:id` | Relatório detalhado de um teste |
| POST | `/api/ga4/connect` | Conecta GA4 via Service Account |
| GET | `/api/ga4/report` | Busca dados do GA4 Data API |

---

## 🔧 Stack tecnológico

| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| Runtime | Node.js | 20+ |
| Framework | Express | 4.x |
| Banco | SQLite (better-sqlite3) | 11.x |
| Upload | Multer | 1.4.x |
| Auth Google | google-auth-library | 9.x |
| Frontend | HTML/CSS/JS puro | — |
| Deploy | Docker + docker-compose | — |
| Hospedagem | EasyPanel no VPS | — |

---

## 📦 Features a desenvolver (backlog priorizado)

### P0 — Crítico (sistema não está pronto sem isso)
- [ ] **Proteção por senha do painel** — autenticação simples com senha configurável via `.env`
- [ ] **Rate limiting no webhook de tracking** — evitar abuso no `/api/track/conversion`
- [ ] **Validação de entrada nos uploads** — sanitizar nomes de arquivo, verificar HTML válido
- [ ] **Significância estatística** — calcular p-value e mostrar se resultado é confiável

### P1 — Importante
- [ ] **Exportar relatório CSV** — botão no painel para baixar dados brutos
- [ ] **Pausa/ativação por data** — agendar início e fim de testes automaticamente
- [ ] **Preview das variações** — miniaturas ou preview inline no painel
- [ ] **Teste de múltiplos objetivos** — suportar múltiplas páginas de conversão por teste

### P2 — Melhorias
- [ ] **UI mais polida** — melhorar visual do painel com componentes modernos
- [ ] **Notificações** — alertar quando um teste atingir significância estatística
- [ ] **API key** — proteger a API pública com token para integrações externas
- [ ] **Logs de acesso** — registrar IP e user-agent nas interações
- [ ] **Relatório de heat por horário** — quando os acessos concentram

---

## 🤖 Workflow de desenvolvimento (AIOX + GSD + OMC)

Este projeto usa o mesmo stack de agentes do ambiente global.

### Roteamento Automático de Agents — OBRIGATÓRIO

| Se o usuário pedir... | Agent acionado |
|----------------------|----------------|
| Implementar feature, corrigir código | `@aiox-dev` |
| Revisar código, testar, QA | `@aiox-qa` |
| Criar story, critérios de aceite | `@aiox-sm` |
| Arquitetura, decisão técnica | `@aiox-architect` |
| Roadmap, priorização | `@aiox-pm` |
| Deploy, Docker, EasyPanel | `@aiox-devops` |
| UI, frontend, acessibilidade | `@aiox-ux` |
| Bug com causa desconhecida | `/gsd:debug` |
| Feature grande / múltiplos arquivos | `/gsd:discuss-phase` → `/gsd:plan-phase` → `/gsd:execute-phase` |
| Tarefa rápida, small fix | Resolve diretamente |

### Comandos GSD

```
/gsd:discuss-phase    → trava decisões antes de implementar
/gsd:plan-phase       → gera plano com tasks em waves paralelas
/gsd:execute-phase    → executa atomicamente com commit por task
/gsd:verify-work      → verifica se o objetivo foi atingido
/gsd:debug            → investiga bug com método científico
/enhance-claude-md    → atualiza este CLAUDE.md automaticamente
```

---

## 📐 Regras de código

### Geral
- **DRY** — sem duplicação de lógica
- **YAGNI** — não implementar o que não está na story
- Funções com responsabilidade única, máximo 50 linhas
- Arquivos com responsabilidade única, máximo 300 linhas
- Sem `console.log` solto — use log estruturado ou remova

### JavaScript (Node.js)
- Sem `var` — use `const` e `let`
- Async/await em vez de callbacks aninhados
- Tratamento de erro em todas as rotas (`try/catch`)
- Validar entradas do usuário antes de usar no banco

### Backend (Express)
- Validação de entrada em todas as rotas que recebem dados
- Middleware de erro centralizado
- Variáveis de ambiente validadas na inicialização
- Rate limiting em rotas públicas (`/t/:slug`, `/api/track/`)
- Nunca expor stack traces em produção

### Banco de dados (SQLite)
- Usar prepared statements sempre (já implementado via better-sqlite3)
- Transações para operações multi-tabela
- Índices nos campos usados em `WHERE`

### Frontend (HTML/JS puro)
- Sem frameworks externos desnecessários
- Fetch API para chamadas ao backend
- Loading states em todas as operações assíncronas
- Mensagens de erro amigáveis ao usuário

---

## 🔒 Segurança

- **Uploads:** aceitar apenas `.html` e `.htm`, validar tamanho (max 10MB)
- **SQL Injection:** usar prepared statements — sem interpolação de string em queries
- **XSS:** sanitizar qualquer dado do usuário renderizado no painel
- **Rate limiting:** `/api/track/conversion` e `/t/:slug` são públicos — limitar requisições
- **Painel:** implementar autenticação antes de ir para produção
- **Secrets:** nunca commitar `.env` com valores reais
- **CORS:** restringir origem em produção

---

## 🔄 Como o sistema funciona (fluxo completo)

```
1. Gestor cria teste no painel
   → Upload de 2+ arquivos HTML
   → Define test_uri (slug), percentuais, página de conversão

2. Visitante acessa /t/:slug
   → Cookie cp_uid atribuído (ID único do visitante)
   → Variação escolhida por peso (remaining counter)
   → Cookie cp_t{testId} salvo com a variação escolhida
   → Interação tipo 'view' registrada
   → Redireciona para /p/:tid/:vid

3. Servidor serve a variação em /p/:tid/:vid
   → Lê o arquivo HTML do uploads/
   → Injeta script de tracking (GA4 + Meta Pixel + cookies)
   → Envia HTML modificado ao browser

4. Visitante converte (acessa página de destino)
   → Site do cliente inclui <script src="/embed.js">
   → embed.js envia POST /api/track/conversion com a URL atual
   → Backend cruza URL com conversion_page_url dos testes ativos
   → Se match: atualiza interação de 'view' para 'conversion'

5. Gestor vê resultados no painel
   → /api/reports retorna views, conversions, taxa por variação
   → Gráfico de série temporal por variação
   → Integração GA4 mostra dados do Analytics
```

---

## 🛠️ Comandos úteis

```bash
# Desenvolvimento local
npm start                    # Inicia servidor na porta 3000
node server.js               # Alternativa direta

# Docker
docker-compose up -d         # Sobe em produção
docker-compose down          # Para
docker-compose logs -f       # Acompanha logs

# Banco (debug)
npx better-sqlite3 db/easytest.db  # REPL SQLite (se instalado)
# ou:
sqlite3 db/easytest.db ".tables"

# Claude Code
claude                       # Inicia sessão
/gsd:discuss-phase           # Antes de implementar nova feature
/enhance-claude-md           # Atualizar este CLAUDE.md
```

---

## 🚫 Proibições absolutas

- Nunca commitar `.env` com valores reais
- Nunca usar query SQL por interpolação de string
- Nunca aceitar uploads sem validar tipo de arquivo
- Nunca expor stack trace em produção
- Nunca servir arquivos fora do diretório `db/uploads/`
- Nunca instalar dependências sem justificativa clara

---

## ✅ Checklist antes de cada commit

- [ ] Funcionalidade testada manualmente no browser
- [ ] Nenhum `console.log` esquecido
- [ ] Nenhum secret hardcoded
- [ ] Uploads validados (tipo + tamanho)
- [ ] Rotas públicas com tratamento de erro
- [ ] Docker funciona: `docker-compose up -d`

---

## 📌 Contexto sempre relevante

- O banco SQLite fica em `db/easytest.db` — **não commitar este arquivo**
- Uploads ficam em `db/uploads/` — **não commitar esta pasta**
- O `remaining` counter nas variações controla a distribuição proporcional de visitantes
- Visitante com cookie já atribuído sempre recebe a mesma variação (stickiness)
- O `embed.js` precisa ser incluído **apenas** na página de conversão (ex: `/obrigado`)
- GA4 usa dois modos: Measurement Protocol (server-side no `/t/:slug`) + gtag.js (client-side no `/p/:tid/:vid`)

---

*Última atualização: 2026-04-01*
*Versão: 1.0.0*
*Mantenha este arquivo atualizado com `/enhance-claude-md`*
