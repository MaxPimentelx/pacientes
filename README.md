# Controle de Pacientes

App web (funciona em celular, tablet e computador) para:

- cadastrar o **paciente** (a pessoa) e suas **internações**: um paciente pode ter várias internações, só uma aberta por vez. A **reinternação** em até 30 dias após uma alta é sinalizada;
- **registrar evoluções datadas** dizendo **o que aconteceu** naquele momento: *evolução de rotina*, *mudança de setor/leito*, *intercorrência*, *procedimento/cirurgia* ou *alta/desfecho* (que encerra a internação; anular a alta a reabre);
- acompanhar **onde o paciente está** (setor e leito atuais), a **previsão de alta** e as **pendências** que impedem a alta, com alerta na lista quando a previsão vence;
- listar, buscar e filtrar pacientes por situação, setor e *Sem baixa / Com baixa / Todos*;
- manter a **lista de setores**, editável por administradores (papel `admin` no Supabase Auth);
- **imprimir** a lista de pacientes sem baixa e o relatório individual, com pré-visualização;
- registrar o **CID-10** na entrada e **em cada evolução** (o diagnóstico pode mudar ao longo do tratamento). O histórico mostra quando o CID foi alterado;
- registrar os **dados usados no DRG**: sexo, tipo de alta, CIDs secundários classificados como *comorbidade* ou *complicação* e procedimentos realizados (código TUSS/SIGTAP opcional). O relatório individual traz um **resumo para codificação DRG**.

> A tabela `cid10.json` foi gerada a partir dos arquivos oficiais da CID-10 do **DATASUS** (CID10CSV.zip). A **atribuição do diagnóstico é responsabilidade do médico**; o app apenas registra o código informado.

Banco de dados: **Supabase**. Hospedagem: **Netlify**, publicado automaticamente a partir do GitHub.

---

## Segurança e rastreabilidade

| Recurso | Como funciona |
|---|---|
| **Verificação em 2 etapas (MFA)** | Obrigatória para todos: senha + código de um app autenticador (Google/Microsoft Authenticator). No 1º acesso o app guia a ativação por QR code. O banco recusa qualquer leitura ou gravação sem o 2º fator. Se alguém perder o celular, um administrador remove o fator em *Supabase → Authentication → Users → (usuário)*. |
| **Saída por inatividade** | Após 15 min sem uso a sessão é encerrada (aviso 60 s antes), em todas as abas, e os dados somem da tela. |
| **Autoria** | O banco grava quem cadastrou/alterou cada paciente e quem registrou cada evolução (não pode ser falsificado pelo app). Cada usuário define seu nome clicando nele, no topo da tela. |
| **Nada se apaga** | Evoluções não são excluídas: o autor pode **anular com justificativa**; o registro continua visível, riscado, com quem anulou, quando e por quê. Pacientes também não podem ser excluídos. |
| **Trilha de auditoria** | Toda criação, alteração e anulação fica registrada (campo, valor antigo → novo, quem, quando) na seção *Histórico de alterações* do paciente. Só o banco escreve nessa trilha. |
| **Backup diário criptografado** | GitHub Actions exporta o banco de produção às 03:00, criptografa (AES-256) e guarda por 30 dias. Veja [docs/BACKUP.md](docs/BACKUP.md). |

## Ambientes

| Ambiente | Onde roda | Banco (Supabase) |
|---|---|---|
| **Produção** | site oficial no Netlify | projeto **Pacientes** |
| **Homologação** | `localhost` e sites de teste do Netlify (`homologacao--…`, `deploy-preview-…`) | projeto **Pacientes-Homologacao** |
| **Demonstração** | qualquer endereço com `?demo=1` | nenhum (dados só no navegador) |

A escolha é automática pelo endereço ([config.js](config.js)). Em homologação aparece uma faixa vermelha no topo. **Toda mudança é testada em homologação antes de ir para produção.** Na homologação, `?inatividade=1` encurta a saída automática para 1 minuto, para teste.

### Rodar no computador

```bash
python -m http.server 5510 --directory controle-pacientes
```

Acesse http://localhost:5510 (homologação) ou http://localhost:5510/?demo=1 (demonstração).

## Banco de dados

As alterações do banco ficam versionadas em `supabase/`:

- **Banco novo:** rode `schema.sql` e depois, em ordem, `migracao-05-anulacao-auditoria.sql`, `migracao-06-mfa-obrigatorio.sql`, `migracao-07-anulacao-por-politica.sql` e `migracao-08-internacoes-eventos.sql`.
- **Banco existente:** rode, em ordem, só as migrações que ainda não foram aplicadas.

Configurações que ficam no painel do Supabase (fazer nos **dois** projetos):

1. **Authentication → Sign In / Providers:** desligar *Allow new users to sign up* (só entra quem for cadastrado).
2. **Authentication → Providers → Email:** senha mínima de **10 caracteres**, exigindo letras maiúsculas, minúsculas, números e símbolos.
3. **Authentication → Users → Add user:** criar um usuário por pessoa (marcar *Auto Confirm User*). Nunca compartilhar contas.

> As chaves em `config.js` são *publicáveis*: quem protege os dados são as regras de segurança (RLS) do banco. **Nunca** coloque a chave `service_role`/`secret` no app.

## Publicação

O Netlify publica sozinho a cada envio ao GitHub ([netlify.toml](netlify.toml)): a branch `main` vai para produção e a branch `homologacao` vira o site de testes.

## Usar no celular como aplicativo

- **Android (Chrome):** menu ⋮ → **Adicionar à tela inicial**;
- **iPhone (Safari):** Compartilhar → **Adicionar à Tela de Início**.

## Observações

- **Projeto pausado:** no plano gratuito, o Supabase pausa projetos sem uso por 7 dias. Para reativar, clique em *Restore* no painel. Os dados não se perdem.
- **LGPD:** dados de saúde são dados pessoais *sensíveis*. Restrinja o acesso a quem realmente precisa.
- **Prontuário oficial:** para substituir o prontuário em papel, as normas do CFM exigem certificação SBIS/CFM (NGS2) e assinatura digital ICP-Brasil. Valide com o responsável técnico antes de usar o app como registro oficial.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` | Telas (login, 2 etapas, lista, detalhe, cadastro, anulação, relatórios) |
| `style.css` | Visual responsivo (celular / tablet / desktop, tema claro e escuro) |
| `app.js` | Lógica do app e acesso ao banco |
| `config.js` | Escolha do ambiente e chaves publicáveis do Supabase |
| `cid10.json` | Tabela CID-10 (DATASUS): cerca de 14 mil códigos para a busca |
| `supabase/` | Esquema do banco e migrações versionadas |
| `.github/workflows/backup-diario.yml` | Backup diário criptografado |
| `docs/BACKUP.md` | Como configurar, baixar e restaurar backups |
| `netlify.toml` | Publicação e cabeçalhos de segurança |
| `manifest.webmanifest`, `icon.svg` | Permite instalar na tela inicial |
