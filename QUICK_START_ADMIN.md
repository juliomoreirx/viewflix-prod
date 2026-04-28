# 🚀 Quick Start - Admin Dashboard ViewFlix

## ⚡ 30 Segundos para Começar

### 1. Verificar Token
Abra `.env` e encontre:
```env
ADMIN_API_TOKEN=3276427420213442
```
Copie este valor (será usado no login).

### 2. Iniciar Servidor
```bash
cd fasttv
npm start
```

Aguarde "Server iniciado na porta 3000" ✅

### 3. Acessar Admin
Abra no navegador:
```
http://localhost:3000/admin.html
```

### 4. Fazer Login
1. Cole o token
2. Clique em "Acessar Admin"
3. Dashboard carregará em 2-3 segundos

✅ **Pronto!** Você está no dashboard.

---

## 📊 O que Você Vê

### Cards de Estatísticas (Topo)
- **Total de Usuários**: Todos cadastrados
- **Ativos Hoje**: Usuários ativos na página atual
- **Total Gasto**: Soma de gastos de todos
- **Bloqueados**: Quantos estão bloqueados

### Lista de Usuários
Cada linha mostra:
- Nome e username (clickável)
- Saldo em créditos
- Total gasto em R$
- Número de compras
- Status (ativo/inativo/bloqueado)

### Clique em Qualquer Usuário
Abre modal com:
- Informações pessoais completas
- Histórico financeiro
- Últimas 3 compras com datas
- Bônus inicial (se recebeu)
- Data de registro e último acesso

---

## 🔍 Filtros

### Busca Rápida
Campo "Pesquisar usuário" busca por:
- Nome
- Username
- Qualquer parte do texto

### Filtro por Status
Dropdown "Todos os status":
- Mostrar todos
- Apenas ativos
- Apenas inativos

### Filtro por Bloqueio
Dropdown "Mostrar Todos":
- Mostrar todos
- Apenas bloqueados
- Apenas desbloqueados

### Aplicar
Clique em "Aplicar Filtros" ou pressione Enter na busca.

---

## ⌨️ Atalhos

| Ação | Como Fazer |
|------|-----------|
| Buscar | Escreva no campo + Enter |
| Próxima página | Clique em "Próxima ▶" |
| Página anterior | Clique em "◀ Anterior" |
| Ver detalhes | Clique em qualquer linha |
| Fechar modal | Clique no X ou fora do modal |
| Atualizar dados | Clique em "Atualizar" (botão superior direito) |
| Sair | Clique em "Sair" (sidebar) |

---

## 🎯 Casos de Uso Comuns

### Encontrar um Usuário Específico
1. Escreva nome/username no campo de busca
2. Pressione Enter
3. Clique nele para ver detalhes completos

### Ver Usuários Bloqueados
1. Dropdown "Mostrar Todos" → Selecione "Apenas Bloqueados"
2. Clique em "Aplicar Filtros"
3. Verá apenas bloqueados

### Monitorar Gastos
1. Ordene por "Total Gasto" (coluna)
2. Veja quem está gastando mais
3. Clique para detalhes

### Encontrar Inativos
1. Dropdown "Todos os status" → Selecione "Apenas Inativos"
2. Clique em "Aplicar Filtros"
3. Verá quem não está ativo

### Checar Bônus
1. Clique em qualquer usuário
2. No modal, veja "Bônus inicial concedido" (verde)
3. Confirma se recebeu R$5 de bônus

---

## ❌ Problemas Comuns

### "Token inválido"
- ✅ Verifique se copiou corretamente de `.env`
- ✅ Não adicione aspas
- ✅ Copie exatamente como está: `3276427420213442`

### "Nenhum usuário aparece"
- ✅ MongoDB pode estar fora do ar
- ✅ Verifique conexão MongoDB em `.env`
- ✅ Clique "Atualizar" para tentar novamente

### Página em branco após login
- ✅ Abra DevTools (F12)
- ✅ Veja aba "Console"
- ✅ Procure por erros vermelhos
- ✅ Se disser CORS, configure proxy

### Filtros não funcionam
- ✅ Reinicie o servidor (npm start)
- ✅ Feche abas do navegador abertas
- ✅ Limpe cache (Ctrl+Shift+Delete)

### "Unable to connect"
- ✅ Servidor não está rodando
- ✅ Rode `npm start` novamente
- ✅ Aguarde "Server iniciado..."

---

## 📱 Mobile

A página funciona em mobile! 📱

- Layout responsivo
- Sidebar no topo
- Botões touch-friendly
- Scroll horizontal disponível

Teste em um celular/tablet acessando o ngrok URL.

---

## 🔐 Segurança

✅ Token não é salvo (apenas memória da sessão)  
✅ Logout limpa tudo completamente  
✅ Página sem índice (noindex, nofollow)  
✅ HTTPS obrigatório em produção  
✅ Bearer token validado a cada requisição  

---

## 💡 Pro Tips

### Dica 1: Abrir em Janela Separada
Se estiver testando o site, abra admin em aba nova:
```
Tab 1: http://localhost:3000/
Tab 2: http://localhost:3000/admin.html
```

### Dica 2: Atualizar Automaticamente
O dashboard não atualiza automaticamente. Para ver dados novos:
- Clique "Atualizar" (botão direito superior)
- Ou recarregue a página (F5)

### Dica 3: Exportar Dados
Selecione o texto da listagem e copie para Excel:
1. Selecione usuários (Ctrl+A em tabela)
2. Copie (Ctrl+C)
3. Cole em Excel

### Dica 4: Monitorar em Tempo Real
- Abra admin em um monitor
- Seu bot/site em outro
- Veja usuários novos aparecerem em tempo real

### Dica 5: Links em Usuários
Clique em cualquer nome de usuário para abrir modal com detalhes completos.

---

## 📈 Métricas Importantes

O dashboard exibe:

| Métrica | O Que Significa |
|---------|-----------------|
| **Total Usuários** | Todos cadastrados desde o início |
| **Ativos Hoje** | Usuários na lista atual (pode variar com filtros) |
| **Total Gasto** | Soma de tudo que todos gastaram |
| **Bloqueados** | Quantos foram bloqueados manualmente |

---

## 🔄 Workflow Recomendado

```
1. Início do dia
   ├─ Abra admin
   ├─ Veja KPIs (stats cards)
   └─ Note Total Gasto / Usuários

2. Monitorar
   ├─ Procure por bloqueados
   ├─ Veja inativos
   └─ Identifique maiores spenders

3. Investigar
   ├─ Clique em usuário suspeito
   ├─ Veja histórico de compras
   └─ Tome ações se necessário

4. Atualizar
   ├─ Clique "Atualizar" periodicamente
   └─ Os dados se mostram em tempo real
```

---

## 🎓 Próximas Features (Roadmap)

- 📊 Gráficos de receita
- 📥 Exportar para CSV
- 🔄 Atualização automática
- 🎯 Ações em massa
- 💰 Editar créditos no dashboard
- 📋 Logs administrativos

---

## 📞 Suporte

Se tiver problemas:

1. Verifique `ADMIN_DASHBOARD.md` (documentação completa)
2. Veja `ADMIN_VISUAL_GUIDE.md` (screenshots/layouts)
3. Abra DevTools (F12) para erros
4. Reinicie servidor se tudo falhar

---

**Versão**: 1.0  
**Status**: ✅ Pronto para Produção  
**Data**: 27 de Abril de 2026  
**Criado**: GitHub Copilot + ViewFlix Team  

🎉 **Aproveite seu novo Admin Dashboard!**

