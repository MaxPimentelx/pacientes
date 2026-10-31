// Ambientes do app. As chaves abaixo são PUBLICÁVEIS (podem ficar no código):
// quem protege os dados são as regras de segurança (RLS) de cada banco.
//
//  - producao:    site oficial no Netlify (endereço principal)
//  - homologacao: computador local (localhost) e sites de teste do Netlify
//                 (branch "homologacao--..." e "deploy-preview-...--...")
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

  const host = location.hostname;
  const ehTeste =
    host === 'localhost' || host === '127.0.0.1' || host === '' ||
    /^(homologacao|deploy-preview-\d+)--/.test(host);

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
