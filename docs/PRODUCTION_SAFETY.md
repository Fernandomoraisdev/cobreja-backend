# Peguei & Paguei - Base de seguranca para producao

Este documento define o fluxo minimo para vender e evoluir o sistema sem colocar os dados dos clientes em risco.

## Endpoints internos

Todos os endpoints abaixo exigem JWT de Super Admin.

- `GET /api/super-admin/operations/health`
  - Valida conexao com PostgreSQL.
  - Retorna contagens principais de contas, usuarios, clientes, dividas, pagamentos, Pix e suporte.
  - Informa se variaveis essenciais existem, sem revelar valores.

- `GET /api/super-admin/operations/health?accountId=ID`
  - Faz o mesmo diagnostico limitado a uma empresa.

- `GET /api/super-admin/operations/backup`
  - Gera backup logico JSON global.
  - Mantem hashes de senha para permitir restauracao completa de login.
  - Mascara credenciais do Mercado Pago.
  - Registra auditoria da exportacao.
  - Salva o snapshot no historico de backups.

- `GET /api/super-admin/operations/backup?accountId=ID`
  - Gera backup logico JSON apenas de uma empresa.

- `GET /api/super-admin/operations/backups`
  - Lista o historico de snapshots salvos.

- `GET /api/super-admin/operations/backups/:id/download`
  - Baixa um snapshot salvo no historico.

- `POST /api/super-admin/operations/backups/:id/restore`
  - Restaura um snapshot salvo.
  - Antes da restauracao, cria automaticamente um snapshot `PRE_RESTORE`.

- `POST /api/super-admin/operations/restore`
  - Restaura um backup JSON enviado pelo Super Admin.
  - Antes da restauracao, cria automaticamente um snapshot `PRE_RESTORE`.

## Backups automaticos

- Ao iniciar em producao, o backend roda `scripts/deploy-start.js`.
- O script aplica migrations, cria um snapshot `PRE_DEPLOY` e depois inicia o servidor.
- Com `AUTO_BACKUP_ENABLED` diferente de `false`, o servidor cria um snapshot `AUTOMATIC_DAILY` por dia.
- O historico automatico mantem os ultimos 30 snapshots diarios.
- Os snapshots ficam no proprio PostgreSQL. Isso protege contra erros de operacao e exclusoes logicas, mas nao substitui backup externo do provedor do banco.

## Checklist antes de cada deploy

1. Confirmar que o snapshot `PRE_DEPLOY` foi criado no historico de backups.
2. Validar que a migracao Prisma nao apaga coluna, tabela ou dados em producao.
3. Rodar validacoes locais do backend.
4. Rodar builds do Flutter quando houver alteracao no frontend: web, Android e Windows.
5. Publicar backend primeiro quando a mudanca de API for retrocompativel.
6. Publicar frontend depois que o backend estiver saudavel.
7. Abrir o sistema como Super Admin, Admin e Cliente.
8. Conferir login, cadastro, listagem de clientes, criacao de divida, Pix e painel principal.

## Regras para migrations

- Preferir mudancas aditivas: criar campo novo, popular, trocar uso no codigo e so remover depois.
- Nunca renomear/remover coluna com dados sem backup e roteiro de rollback.
- Evitar migracao manual diretamente no banco de producao.
- Toda mudanca de pagamento, assinatura, conta, cliente ou divida precisa de auditoria ou log rastreavel.
- Exclusoes de clientes, dividas e pagamentos devem ser logicas por padrao. Exclusao definitiva so deve existir em fluxo separado e confirmado.

## Rollback

1. Se o erro for somente codigo, reverter para o deploy anterior no Railway.
2. Se o erro afetar dados, pausar operacoes de escrita e restaurar backup do PostgreSQL.
3. Se houver pagamento Pix envolvido, preservar `PaymentIntent`, `WebhookLog` e `AuditLog` antes de qualquer restauracao manual.
4. Registrar o incidente em auditoria ou documento interno.

## Caminho para piloto pago

Para iniciar vendas com risco controlado, a versao piloto precisa ter:

- Backup e health check disponiveis para Super Admin.
- Rotas protegidas por role e accountId.
- Cadastro de Admin/Cliente sem duplicidade indevida.
- Pix com idempotencia.
- Planos SaaS ativos, mesmo que a cobranca da assinatura ainda comece manual.
- Tela de suporte funcional para contato rapido.
- Processo claro de onboarding, suporte e cancelamento.
