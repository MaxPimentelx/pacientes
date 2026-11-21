// Ambientes do app. As chaves abaixo são PUBLICÁVEIS (podem ficar no código):
// quem protege os dados são as regras de segurança (RLS) de cada banco.
//
//  - producao:    SOMENTE os endereços listados em PRODUCAO_HOSTS
//  - homologacao: qualquer outro endereço (localhost, sites de teste do
//                 Cloudflare Pages "homologacao.controle-pacientes.pages.dev",
//                 prévias "<código>.controle-pacientes.pages.dev", etc.)
//
// Endereço desconhecido NUNCA usa o banco de produção: para um endereço
// novo virar produção (ex.: domínio próprio), inclua-o em PRODUCAO_HOSTS.
//
// Para rodar SEM banco (modo demonstração, dados só no navegador),
// abra o app com ?demo=1 no endereço.
(function () {
  const AMBIENTES = {
    producao: {
      SUPABASE_URL: 'https://vxpovguooglhesvpmoka.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_ONlCJR-5m_sWd89vbP1POQ_KtQSwEMe'
    },
    homologacao: {
      SUPABASE_URL: 'https://gqpspuywkjmycfsooncu.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_rEl11zyovMlYFpHwPBVSRA_lgfppGHY'
    }
  };

  const PRODUCAO_HOSTS = [
    'controle-pacientes.pages.dev',   // Cloudflare Pages (branch main)
    'timely-cannoli-9571b6.netlify.app' // Netlify antigo (até ser desligado)
  ];

  const host = location.hostname;
  const ehTeste = !PRODUCAO_HOSTS.includes(host);

  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    window.APP_CONFIG = { AMBIENTE: 'demonstracao', SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };
  } else {
    const nome = ehTeste ? 'homologacao' : 'producao';
    window.APP_CONFIG = {
      AMBIENTE: nome,
      ...AMBIENTES[nome],
      // minutos sem uso até sair sozinho; só em homologação dá para encurtar
      // para teste com ?inatividade=1 no endereço
      INATIVIDADE_MIN: (ehTeste && Number(params.get('inatividade'))) || 15
    };
  }
})();
