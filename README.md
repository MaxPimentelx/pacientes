# Controle de Pacientes

App web (funciona em celular, tablet e computador) para:

- cadastrar paciente com **data de entrada** e **motivo**;
- listar, buscar e filtrar pacientes pela situação atual;
- abrir um paciente e **registrar evoluções datadas**. Cada atualização vira um novo registro no histórico, sem apagar o anterior;
- informar a **data da baixa** para encerrar o processo e filtrar a lista em *Sem baixa / Com baixa / Todos*;
- **imprimir** a lista de pacientes sem baixa, com situação atual, CID atual e última evolução;
- registrar o **CID-10** na entrada e **em cada evolução** (o diagnóstico pode mudar ao longo do tratamento). O histórico mostra quando o CID foi alterado;
- registrar os **dados usados no DRG**: sexo, tipo de alta, CIDs secundários classificados como *comorbidade* ou *complicação* e procedimentos realizados (código TUSS/SIGTAP opcional). O relatório individual traz um **resumo para codificação DRG**.

> A tabela `cid10.json` foi gerada a partir dos arquivos oficiais da CID-10 do **DATASUS** (CID10CSV.zip). A **atribuição do diagnóstico é responsabilidade do médico**; o app apenas registra o código informado.

Banco de dados: **Supabase** (gratuito). Hospedagem: **Netlify** (gratuito).

---

## 1. Testar agora (modo demonstração)

Abra o `index.html` por um servidor local. Por exemplo:

```bash
python -m http.server 5510 --directory controle-pacientes
```

Depois acesse http://localhost:5510. Sem configuração, os dados ficam só no navegador.

## 2. Criar o banco on-line (Supabase), cerca de 5 min

1. Crie uma conta em https://supabase.com e clique em **New project** (plano Free; região *South America (São Paulo)*).
2. No menu **SQL Editor > New query**, cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**.
   - *Já tinha rodado uma versão anterior do `schema.sql`?* Rode também, em ordem, as migrações que ainda não rodou: `supabase/migracao-01-data-baixa.sql`, `supabase/migracao-02-cid.sql` e `supabase/migracao-03-dados-drg.sql`.
3. Em **Authentication > Sign In / Providers**, **desative "Allow new users to sign up"**. Assim só entra quem você cadastrar.
4. Em **Authentication > Users > Add user > Create new user**, crie um usuário (e-mail e senha) para cada pessoa que vai usar o app. Marque **Auto Confirm User**.
5. Em **Project Settings > API Keys** (ou **Data API**), copie:
   - a **Project URL** (`https://xxxx.supabase.co`);
   - a chave **anon public** (ou **publishable**).
6. Cole os dois valores em `config.js`.

> A chave anon/publishable pode ficar pública, porque quem protege os dados são as regras de segurança (RLS) do `schema.sql`: sem login, nada é lido nem gravado. **Nunca** coloque a chave `service_role`/`secret` no app.

## 3. Publicar (Netlify), cerca de 2 min

1. Acesse https://app.netlify.com/drop e entre com uma conta grátis.
2. **Arraste a pasta `controle-pacientes`** para a página.
3. Você recebe um link `https://nome-aleatorio.netlify.app`. Para trocar o nome, vá em **Site configuration > Change site name**.
4. Para atualizar depois, vá em **Deploys** e arraste a pasta de novo.

Alternativas gratuitas equivalentes: Vercel, Cloudflare Pages ou GitHub Pages.

## 4. Usar no celular como aplicativo

Abra o link no celular:
- **Android (Chrome):** menu ⋮ > **Adicionar à tela inicial**;
- **iPhone (Safari):** Compartilhar > **Adicionar à Tela de Início**.

---

## Observações importantes

- **Projeto pausado:** no plano gratuito, o Supabase pausa projetos sem uso por 7 dias. Para reativar, basta clicar em *Restore* no painel. Os dados não se perdem.
- **LGPD:** dados de saúde são dados pessoais *sensíveis*. Crie logins individuais, use senhas fortes, não compartilhe contas e restrinja o acesso a quem realmente precisa. Para uso clínico formal, avalie também os requisitos do seu conselho profissional (ex.: prontuário eletrônico).
- **Backup:** no Supabase, em **Table Editor**, você pode exportar as tabelas `pacientes` e `evolucoes` para CSV.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` | Telas (login, lista, detalhe, cadastro) |
| `style.css` | Visual responsivo (celular / tablet / desktop, tema claro e escuro) |
| `app.js` | Lógica do app e acesso ao banco |
| `config.js` | URL e chave do Supabase |
| `cid10.json` | Tabela CID-10 (DATASUS): cerca de 14 mil códigos para a busca |
| `supabase/schema.sql` | Criação das tabelas e regras de segurança |
| `manifest.webmanifest`, `icon.svg` | Permite instalar na tela inicial |
