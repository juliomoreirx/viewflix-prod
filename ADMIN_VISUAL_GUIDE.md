# 🎨 Preview Visual do Admin Dashboard

## Estrutura da Página

```
┌─────────────────────────────────────────────────────────────────┐
│  VIEWFLIX SPACE                                    🔒 Admin      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  LOGIN PAGE                                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                                                            │   │
│  │                    🎬 VIEWFLIX ADMIN                      │   │
│  │              Painel administrativo restrito               │   │
│  │                                                            │   │
│  │  ┌─ Token de Acesso ─────────────────────────────────┐  │   │
│  │  │ [*** Sua senha super secreta aqui ***]           │  │   │
│  │  │ Cole seu admin token aqui                        │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  │                                                            │   │
│  │  ┌─ Botão ──────────────────────────────────────────┐   │   │
│  │  │  🔓 ACESSAR ADMIN                                 │   │   │
│  │  └──────────────────────────────────────────────────┘   │   │
│  │                                                            │   │
│  │  🔒 Esta página está protegida. Acesso apenas              │   │
│  │     com token válido.                                      │   │
│  │                                                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Após Login

```
┌──────────────────────────────────────────────────────────────────────────┐
│ VIEWFLIX ADMIN                                          Logout           │
├──────────────────────┬───────────────────────────────────────────────────┤
│                      │                                                    │
│ 👥 Usuarios      │  Dashboard Administrativo                            │
│ 📊 Estatísticas  │  Visão completa de usuários e atividades             │
│ 🔧 Filtros       │                                               [↻ Atualizar]│
│                      │                                                    │
│                      ├───────────────────────────────────────────────────┤
│                      │                                                    │
│                      │  📊 ESTATÍSTICAS EM TEMPO REAL                     │
│                      │                                                    │
│                      │  ┌─────────────┐  ┌─────────────┐                 │
│                      │  │ 👥 125      │  │ 👤 42       │                 │
│                      │  │ Total de    │  │ Ativos      │                 │
│                      │  │ Usuários    │  │ Hoje        │                 │
│                      │  └─────────────┘  └─────────────┘                 │
│                      │                                                    │
│                      │  ┌─────────────┐  ┌─────────────┐                 │
│                      │  │ R$ 3.258,50 │  │ 8           │                 │
│                      │  │ Total Gasto │  │ Bloqueados  │                 │
│                      │  └─────────────┘  └─────────────┘                 │
│                      │                                                    │
│                      ├───────────────────────────────────────────────────┤
│                      │                                                    │
│                      │  🔍 FILTROS E BUSCA                                │
│                      │                                                    │
│                      │  ┌──────────────────┐ ┌──────────────────┐        │
│                      │  │ Pesquisar...     │ │ Todos os status▼ │        │
│                      │  └──────────────────┘ └──────────────────┘        │
│                      │                                                    │
│                      │  ┌──────────────────┐ ┌──────────────────┐        │
│                      │  │ Mostrar Todos▼   │ │ [Aplicar Filtros]│       │
│                      │  └──────────────────┘ └──────────────────┘        │
│                      │                                                    │
│                      ├───────────────────────────────────────────────────┤
│                      │                                                    │
│                      │  👥 LISTA DE USUÁRIOS (10 por página)             │
│                      │                                                    │
│                      │  ┌───────────────────────────────────────────┐   │
│                      │  │ 👤 João Silva                   ATIVO     │   │
│                      │  │ @joaosilva • ID: 123456789               │   │
│                      │  │                                           │   │
│                      │  │ Saldo: R$ 3,50  │ Gasto: R$ 24,50 │ 12  │   │
│                      │  │                            compras      │   │
│                      │  └───────────────────────────────────────────┘   │
│                      │                                                    │
│                      │  ┌───────────────────────────────────────────┐   │
│                      │  │ 👤 Maria Santos          INATIVO | BLOQUEADO  │
│                      │  │ @mariasantos • ID: 987654321              │   │
│                      │  │                                           │   │
│                      │  │ Saldo: R$ 0,00  │ Gasto: R$ 125,00 │ 35 │   │
│                      │  │                            compras      │   │
│                      │  └───────────────────────────────────────────┘   │
│                      │                                                    │
│                      │  ┌───────────────────────────────────────────┐   │
│                      │  │ 👤 Pedro Costa                  ATIVO     │   │
│                      │  │ @pedrocosta • ID: 555666777              │   │
│                      │  │                                           │   │
│                      │  │ Saldo: R$ 15,75 │ Gasto: R$ 9,75  │ 5   │   │
│                      │  │                            compras      │   │
│                      │  └───────────────────────────────────────────┘   │
│                      │                                                    │
│                      │  [◀ Anterior]        Página 1 de 13     [Próxima ▶]│
│                      │                                                    │
│                      └───────────────────────────────────────────────────┘
```

## Modal de Detalhes (Clique em usuário)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Detalhes do Usuário                                          [✕]     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ INFORMAÇÕES PESSOAIS                                              │
│                                                                     │
│ Nome: João Silva              │  Username: @joaosilva              │
│ ID: 123456789                 │  Status: ATIVO                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ FINANÇAS                                                            │
│                                                                     │
│ ┌─────────────┐  ┌──────────────┐  ┌──────────────┐               │
│ │ Saldo       │  │ Total Gasto  │  │ Total Compras│               │
│ │ R$ 3,50     │  │ R$ 24,50     │  │ 12           │               │
│ └─────────────┘  └──────────────┘  └──────────────┘               │
│                                                                     │
│ 🎁 Bônus inicial concedido em 20/04/2026                          │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ ÚLTIMAS COMPRAS                                                     │
│                                                                     │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ Homem de Ferro 3            R$ 3,75                         │  │
│ │ 📅 27/04/2026                                               │  │
│ └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ Breaking Bad - Season 4     R$ 1,75                         │  │
│ │ 📅 25/04/2026                                               │  │
│ └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│ ┌──────────────────────────────────────────────────────────────┐  │
│ │ Canal 570 - Live TV         R$ 5,00                         │  │
│ │ 📅 22/04/2026                                               │  │
│ └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ TIMESTAMPS                                                          │
│                                                                     │
│ Registrado em: 20/04/2026 14:32:15                                │
│ Último acesso: 27/04/2026 22:45:33                                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Estados e Animações

### Loading
```
┌─ Carregando Usuários ─┐
│ ▌▌▌▌▌▌▌▌▌▌ (shimmer) │  ← Animação de carregamento
│ ▌▌▌▌▌▌▌▌▌▌ (shimmer) │
│ ▌▌▌▌▌▌▌▌▌▌ (shimmer) │
└─ Aguarde... ──────────┘
```

### Estados de Botões
```
Filtros desabilitados        Filtros habilitados
[◀ Anterior]                 [◀ Anterior]  ← clicável
[Próxima ▶]                  [Próxima ▶]   ← clicável

Em carregamento
[↻ Carregando...]
```

### Badges de Status
```
✅ ATIVO    (Verde)
❌ INATIVO  (Vermelho)
🚫 BLOQUEADO (Roxo)
```

## Paleta de Cores

```
Background Principal: #050505 (Preto)
Gradiente: #0b0c1b a #1a1025
Texto Principal: #e2e8f0 (Cinza claro)
Texto Secundário: #a0aec0 (Cinza médio)
Accent Primário: #4facfe (Azul)
Accent Secundário: #00f2fe (Ciano)
Sucesso: #22c55e (Verde)
Erro: #ef4444 (Vermelho)
Aviso: #a855f7 (Roxo)
```

## Responsividade

### Desktop (> 768px)
- Sidebar fixa à esquerda (280px)
- Layout em 4 colunas para cards de stats
- Tabela completa de usuários

### Tablet (> 640px, < 768px)
- Sidebar se torna full-width (top)
- Cards stats em grid 2x2
- Lista compacta

### Mobile (< 640px)
- Sidebar stacked
- Cards stats em 1 coluna
- Lista responsiva com scroll horizontal
- Toque-friendly buttons (52px min-height)

## Interatividade

### Hover Effects
```
Card de usuário:
NORMAL:        [Usuario 1]
HOVER:         [Usuario 1] ← Borda cyan, fundo com tint
               (smooth transition 0.3s)

Botão:
NORMAL:        [Botão]
HOVER:         [Botão] ↑ (translateY -2px)
               box-shadow aumenta
               (smooth transition 0.3s)
```

### Click Interactions
```
Usuário → Clique → Modal de detalhes abre
         ↓ (fade in 0.2s)
      [Detalhes completos]
         ↓ (clique fora ou X)
      Modal fecha (fade out 0.2s)

Filtro → Clique em "Aplicar Filtros"
         ↓
      Skeleton loader
      (2-3 segundos)
         ↓
      Lista atualiza com novos dados
```

## Fluxo de Uso Típico

```
1. Acessa /admin.html
   ↓
2. Vê página de login
   ↓
3. Cola token (ADMIN_API_TOKEN do .env)
   ↓
4. Clica "Acessar Admin"
   ↓
5. API valida token
   ↓
6. Dashboard carrega com dados
   ↓
7. Pode filtrar, buscar, paginar
   ↓
8. Clica usuário para ver detalhes
   ↓
9. Modal mostra info completa
   ↓
10. Clique fora fecha modal
    ↓
11. Continua explorando ou sai
```

---

**Design by**: ViewFlix Team  
**Framework**: TailwindCSS + Vanilla JS  
**Responsive**: ✅ Mobile First  
**Accessibility**: ✅ ARIA Labels  
