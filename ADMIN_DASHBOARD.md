# ViewFlix Admin Dashboard

## Acesso

A página de admin está disponível em: **`/admin.html`**

Exemplo: `https://seu-dominio.com/admin.html` ou `http://localhost:3000/admin.html`

## Login

1. Acesse `/admin.html`
2. Cole seu **ADMIN_API_TOKEN** (encontrado no `.env`)
3. Clique em "Acessar Admin"

O token é validado automaticamente contra a API.

## Funcionalidades

### 1. Dashboard de Usuários
- **Listagem paginada** de todos os usuários registrados
- **Informações visíveis:**
  - Nome e username
  - Saldo em créditos
  - Total gasto
  - Número total de compras
  - Status (ativo/inativo)
  - Status de bloqueio

### 2. Filtros Avançados
- **Busca por nome/username**: Campo "Pesquisar usuário"
- **Status ativo/inativo**: Dropdown "Todos os status"
- **Usuários bloqueados**: Dropdown "Mostrar Todos"
- **Aplicação dinâmica**: Clique em "Aplicar Filtros" ou pressione Enter

### 3. Estatísticas em Tempo Real
Na parte superior, 4 cards mostram:
- **Total de Usuários**: Contagem de todos os usuários cadastrados
- **Ativos Hoje**: Quantos usuários estão ativos na página atual
- **Total Gasto**: Soma de gastos de todos os usuários visíveis
- **Bloqueados**: Quantos usuários estão bloqueados

### 4. Detalhes do Usuário
Clique em qualquer linha de usuário para abrir um modal com:
- **Informações pessoais**: Nome, username, ID, status
- **Finanças**: Saldo, total gasto, total de compras
- **Bônus**: Indicador se recebeu bônus inicial
- **Últimas Compras**: Até 3 compras recentes com data e preço
- **Timestamps**: Data de registro e último acesso

### 5. Paginação
- **10 usuários por página**
- Botões "Anterior" e "Próxima" habilitados conforme contexto
- Indicador de página atual

### 6. Atualização
Clique em "Atualizar" para recarregar a lista de usuários com filtros atuais.

## Variáveis de Ambiente

O admin utiliza a variável `ADMIN_API_TOKEN` do `.env`:

```env
ADMIN_API_TOKEN=seu-token-super-secreto-aqui
```

## Endpoints Utilizados

A página consome a rota:

```
GET /api/admin/users
  ?page=1
  &limit=10
  &q=termo-busca
  &isActive=true|false
  &blocked=true|false
  &sortBy=registeredAt|credits|totalSpent
  &sortOrder=asc|desc
  &includePurchases=true
  &purchasesLimit=3

Header: Authorization: Bearer {ADMIN_API_TOKEN}
```

## Segurança

- ✅ Página sem índice nos buscadores (`noindex, nofollow`)
- ✅ Token armazenado apenas em memória (sessão)
- ✅ Logout limpa token completamente
- ✅ Validação de token no primeiro acesso
- ✅ Redirecionamento automático ao sair

## Design

A página segue o mesmo padrão visual do site principal:
- Gradiente escuro (tema noturno)
- Cores cyan/azul (#4facfe, #00f2fe)
- Glass morphism com blur
- Responsive (funciona em mobile)
- Ícones FontAwesome
- Animações suaves

## Troubleshooting

| Problema | Solução |
|----------|---------|
| "Token inválido" | Verifique se o token está correto em `.env` |
| Nenhum usuário aparece | Confirme que há usuários na base de dados |
| Página em branco | Abra o console (F12) e procure por erros de CORS |
| Filtros não funcionam | Confirme que a API está acessível em `/api/admin/users` |

## Próximas Melhorias Sugeridas

- [ ] Exportação de dados (CSV)
- [ ] Gráficos de receita e usuários ao longo do tempo
- [ ] Ações em massa (bloquear múltiplos usuários)
- [ ] Edição de créditos direto do dashboard
- [ ] Logs de atividades administrativas
