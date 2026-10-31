# Backup e restauração

## Como funciona

O fluxo [`.github/workflows/backup-diario.yml`](../.github/workflows/backup-diario.yml) roda todo dia às 03:00 (Brasília) e:

1. exporta o banco de **produção**: estrutura e dados do app (`app.dump`) e os usuários (`usuarios.dump`);
2. compacta e **criptografa com AES-256** usando a senha `BACKUP_SENHA`;
3. guarda o arquivo `backup-pacientes-AAAAMMDD-HHMM.tar.gz.gpg` na aba **Actions** do GitHub por **30 dias**.

Sem a `BACKUP_SENHA` o arquivo é inútil. **Guarde a senha num cofre de senhas, fora do GitHub.** Se ela for perdida, os backups não podem ser abertos.

## Configuração (uma vez)

Em **GitHub → repositório → Settings → Secrets and variables → Actions → New repository secret**:

| Segredo | Valor |
|---|---|
| `SUPABASE_DB_URL_PRODUCAO` | Supabase (projeto **Pacientes**) → botão **Connect** → **Session pooler** → copie a URI e troque `[YOUR-PASSWORD]` pela senha do banco |
| `BACKUP_SENHA` | Uma senha longa (16+ caracteres), gerada no seu cofre de senhas |

Depois, em **Actions → Backup diário do banco → Run workflow**, rode uma vez para testar.

## Baixar e abrir um backup

1. **Actions** → execução desejada → seção **Artifacts** → baixe o arquivo.
2. Descriptografe e descompacte (Linux/macOS/Git Bash):

```bash
gpg --decrypt backup-pacientes-AAAAMMDD-HHMM.tar.gz.gpg > backup.tar.gz
tar -xzf backup.tar.gz
```

## Restaurar (num projeto Supabase novo ou de homologação)

> Teste a restauração periodicamente na **homologação**: backup que nunca foi restaurado não é backup confiável.

Com a URI do banco de destino em `DESTINO`:

```bash
# 1) usuários primeiro (a autoria dos registros aponta para eles)
pg_restore --data-only -d "$DESTINO" usuarios.dump
# 2) estrutura + dados do app
pg_restore --no-owner --no-privileges --clean --if-exists -d "$DESTINO" app.dump
```

Confira os totais com o arquivo `contagem.txt` do backup.
