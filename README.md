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

Banco de dados: **Supabase**. Hospedagem: **Cloudflare** (Workers, arquivos estáticos), publicado automaticamente a partir do GitHub.

---

## Segurança e rastreabilidade

| Recurso | Como funciona |
|---|---|
| **Verificação em 2 etapas (MFA)** | Obrigatória para todos: senha + código de um app autenticador (Google/Microsoft Authenticator). No 1º acesso o app guia a ativação por QR code. O banco recusa qualquer leitura ou gravação sem o 2º fator. Se alguém perder o celular, um administrador remove o fator em *Supabase → Authentication → Users → (usuário)*. |
| **Usuários e papéis** | Dois papéis: **administrador** e **operador** (todos os demais). O administrador cadastra usuários pelo próprio app (*seu nome → Gerenciar usuários*), troca o papel, gera senha temporária, remove a verificação em 2 etapas de quem perdeu o celular e **desativa** quem não deve mais entrar. O banco confere a situação **atual** de cada usuário (não a cópia guardada na sessão): quem é desativado ou rebaixado perde o acesso ou o poder na hora, e desativar, gerar senha temporária ou remover as 2 etapas derruba as sessões abertas da pessoa. Os registros dela continuam. Ninguém altera a própria conta por ali, o sistema nunca fica sem administrador ativo, e toda ação é gravada **antes** de acontecer na tabela `auditoria_usuarios` (sem registro, nada é feito). |
| **Senha temporária** | O usuário novo recebe do administrador uma senha temporária (entregue pessoalmente). No 1º acesso ativa as 2 etapas e cria a própria senha; até lá o banco não libera nenhum dado. |
| **Anexos do paciente** | PDF, JPG ou PNG (até 10 MB; fotos grandes são reduzidas no envio) na área privada `anexos` do Supabase Storage. O app não lê o Storage direto: para abrir, a função `anexos` confere a permissão, registra quem abriu na auditoria e entrega um link de 2 minutos. Nada se apaga: anexo errado é anulado com justificativa por qualquer usuário. **Atenção:** o backup diário cobre só o banco, não os arquivos. |
| **Hospitais e readmissão** | Cada internação (admissão ou readmissão) registra o hospital, escolhido numa lista mantida pelo administrador em *Minha conta → Hospitais* (o banco só aceita hospital da lista e ativo; desativar não apaga o histórico). Readmissão = entrada até 30 dias após a alta anterior, em qualquer hospital; o aviso indica quando foi em outro hospital. |
| **Solicitar acesso** | Na tela de login, quem não tem conta envia nome, e-mail e função. O pedido **não cria conta**: aparece para o administrador em *Gerenciar usuários*, que aprova (cadastro normal, com senha temporária e 2 etapas) ou recusa. A tabela `solicitacoes_acesso` só é acessível pela função `usuarios`, que limita 20 pedidos por hora e 50 pendentes e responde igual exista ou não a conta. |
| **Saída por inatividade** | Após 15 min sem uso a sessão é encerrada (aviso 60 s antes), em todas as abas, e os dados somem da tela. |
| **Autoria** | O banco grava quem cadastrou/alterou cada paciente e quem registrou cada evolução (não pode ser falsificado pelo app). Cada usuário define seu nome clicando nele, no topo da tela. |
| **Nada se apaga** | Evoluções não são excluídas: o autor pode **anular com justificativa**; o registro continua visível, riscado, com quem anulou, quando e por quê. Pacientes também não podem ser excluídos. |
| **Trilha de auditoria** | Toda criação, alteração e anulação fica registrada (campo, valor antigo → novo, quem, quando) na seção *Histórico de alterações* do paciente. Só o banco escreve nessa trilha. |
| **Backup diário criptografado** | GitHub Actions exporta o banco de produção às 03:00, criptografa (AES-256) e guarda por 30 dias. Veja [docs/BACKUP.md](docs/BACKUP.md). |

## Ambientes

| Ambiente | Onde roda | Banco (Supabase) |
|---|---|---|
| **Produção** | só os endereços listados em `PRODUCAO_HOSTS` ([config.js](config.js)): `pacientes.chamados-fractal.workers.dev` | projeto **Pacientes** |
| **Homologação** | qualquer outro endereço: `localhost` e as prévias do Cloudflare (`homologacao-pacientes.…workers.dev`, `<versão>-pacientes.…workers.dev`) | projeto **Pacientes-Homologacao** |
| **Demonstração** | qualquer endereço com `?demo=1` | nenhum (dados só no navegador) |

A escolha é automática pelo endereço ([config.js](config.js)); endereço desconhecido nunca usa o banco de produção. Ao ganhar um domínio próprio, inclua-o em `PRODUCAO_HOSTS` e nas origens da função `usuarios`. Em homologação aparece uma faixa vermelha no topo. **Toda mudança é testada em homologação antes de ir para produção.** Na homologação, `?inatividade=1` encurta a saída automática para 1 minuto, para teste.

### Rodar no computador

```bash
python -m http.server 5510 --directory controle-pacientes
```

Acesse http://localhost:5510 (homologação) ou http://localhost:5510/?demo=1 (demonstração).

## Banco de dados

As alterações do banco ficam versionadas em `supabase/`:

- **Banco novo:** rode `schema.sql` e depois, em ordem, `migracao-05-anulacao-auditoria.sql`, `migracao-06-mfa-obrigatorio.sql`, `migracao-07-anulacao-por-politica.sql`, `migracao-08-internacoes-eventos.sql`, `migracao-09-gestao-usuarios.sql` `migracao-10-anexos.sql` e `migracao-11-hospitais.sql`.
- **Banco existente:** rode, em ordem, só as migrações que ainda não foram aplicadas.
- **Função de servidor `usuarios`** ([supabase/functions/usuarios](supabase/functions/usuarios/index.ts)): publicada em cada projeto Supabase (*Edge Functions*), com *Verify JWT* **desligado** (a própria função confere a sessão, o papel de administrador e as 2 etapas). Ela usa a chave de serviço que o Supabase já fornece ao servidor; essa chave nunca vai para o app.
- **Função de servidor `anexos`** ([supabase/functions/anexos](supabase/functions/anexos/index.ts)): também com *Verify JWT* **desligado**. Confere a permissão com a sessão do próprio usuário, grava o acesso na auditoria e só então gera o link temporário do arquivo.

Configurações que ficam no painel do Supabase (fazer nos **dois** projetos):

1. **Authentication → Sign In / Providers:** desligar *Allow new users to sign up* (só entra quem for cadastrado).
2. **Authentication → Providers → Email:** senha mínima de **10 caracteres**, exigindo letras maiúsculas, minúsculas, números e símbolos.
3. **Primeiro administrador:** em *SQL Editor*, `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"papel":"admin"}' where email = 'EMAIL_DO_ADMIN';`. Os demais usuários são cadastrados pelo próprio app. Um usuário por pessoa; nunca compartilhar contas.

> As chaves em `config.js` são *publicáveis*: quem protege os dados são as regras de segurança (RLS) do banco. **Nunca** coloque a chave `service_role`/`secret` no app.

## Publicação

O Cloudflare publica sozinho a cada envio ao GitHub ([wrangler.jsonc](wrangler.jsonc)): a branch `main` vai para produção (`pacientes.chamados-fractal.workers.dev`); as outras branches, como `homologacao`, geram prévias que usam o banco de homologação. Os cabeçalhos de segurança ficam em [_headers](_headers) e o que não deve ser publicado (scripts do banco, documentação) fica em [.assetsignore](.assetsignore).

Configuração no Cloudflare (*Compute → Workers & Pages → Create application → Import a repository*): repositório `pacientes`, *Project name* **`pacientes`** (igual ao `name` do `wrangler.jsonc`), *Build command* **vazio**, *Deploy command* `npx wrangler deploy`.

## Usar no celular como aplicativo

- **Android (Chrome):** menu ⋮ → **Adicionar à tela inicial**;
- **iPhone (Safari):** Compartilhar → **Adicionar à Tela de Início**.

## Observações

- **Projeto pausado:** no plano gratuito, o Supabase pausa projetos sem uso por 7 dias. O fluxo [`manter-ativo.yml`](.github/workflows/manter-ativo.yml) faz uma consulta leve por dia nos dois projetos para evitar isso (se falhar, o GitHub avisa por e-mail). Se ainda assim pausar, clique em *Restore* no painel. Os dados não se perdem.
- **GitHub desliga agendamentos** de repositórios sem nenhum commit por 60 dias: se isso acontecer, reative em *Actions → Manter Supabase ativo → Enable workflow*.
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
| `supabase/` | Esquema do banco, migrações versionadas e a função de servidor `usuarios` |
| `.github/workflows/backup-diario.yml` | Backup diário criptografado |
| `.github/workflows/manter-ativo.yml` | Consulta diária que evita a pausa do Supabase gratuito |
| `docs/BACKUP.md` | Como configurar, baixar e restaurar backups |
| `wrangler.jsonc` / `.assetsignore` | Publicação no Cloudflare e o que fica de fora |
| `_headers` | Cabeçalhos de segurança (Cloudflare) |
| `manifest.webmanifest`, `icon.svg` | Permite instalar na tela inicial |
