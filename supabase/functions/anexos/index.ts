// Função de servidor "anexos": abre um anexo do paciente registrando quem abriu.
//
// O app não tem permissão de leitura no Storage. Para abrir um arquivo:
//   1. a permissão é conferida COM A SESSÃO DO PRÓPRIO USUÁRIO (as regras do
//      banco valem: 2 etapas, usuário ativo, sessão existente);
//   2. o acesso é gravado na trilha de auditoria (ação "acesso"); se não der
//      para gravar, o arquivo não é entregue;
//   3. devolve um link temporário (2 minutos) gerado com a chave de serviço,
//      que existe só aqui no servidor.
//
// Ação (POST, corpo JSON): { acao: "abrir", id, baixar?: boolean }
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const VALIDADE_LINK = 120; // segundos

// só o app oficial e os sites de teste chamam esta função
const PRINCIPAL = 'https://pacientes.chamados-fractal.workers.dev';
const ORIGENS = [
  /^https:\/\/pacientes\.chamados-fractal\.workers\.dev$/,
  /^https:\/\/[a-z0-9-]+-pacientes\.chamados-fractal\.workers\.dev$/, // homologacao e prévias
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];
function cabecalhos(req: Request) {
  const origem = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGENS.some((r) => r.test(origem)) ? origem : PRINCIPAL,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };
}

const URL_SUPABASE = Deno.env.get('SUPABASE_URL')!;
const CHAVE_PUBLICA = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(URL_SUPABASE, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req) => {
  const h = cabecalhos(req);
  const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: h });
  const falha = (erro: string, status = 400) => resposta({ erro }, status);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return falha('Método não permitido.', 405);

  const autorizacao = req.headers.get('Authorization') || '';
  const token = autorizacao.replace(/^Bearer\s+/i, '');
  if (!token) return falha('Sessão não informada.', 401);
  const { data: dc, error: ec } = await admin.auth.getClaims(token);
  // deno-lint-ignore no-explicit-any
  const claims = dc?.claims as any;
  if (ec || !claims?.sub) return falha('Sessão inválida ou expirada. Entre de novo.', 401);
  if (claims.aal !== 'aal2') return falha('Confirme a verificação em 2 etapas e tente de novo.', 403);

  // deno-lint-ignore no-explicit-any
  let corpo: any;
  try { corpo = await req.json(); } catch { return falha('Requisição inválida.'); }
  if (corpo?.acao !== 'abrir') return falha('Ação desconhecida.');
  const id = String(corpo.id || '').toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) return falha('Anexo não informado.');

  try {
    // 1) permissão: consulta com a sessão do usuário (RLS do banco decide)
    const comoUsuario = createClient(URL_SUPABASE, CHAVE_PUBLICA, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: anexo, error: ea } = await comoUsuario.from('anexos')
      .select('id, paciente_id, caminho, nome_arquivo').eq('id', id).maybeSingle();
    if (ea) throw ea;
    if (!anexo) return falha('Anexo não encontrado ou sem permissão de acesso.', 404);

    // 2) trilha: quem abriu, quando (antes de entregar o arquivo)
    const { data: du } = await admin.auth.admin.getUserById(claims.sub);
    const u = du?.user;
    const { error: eaud } = await admin.from('auditoria').insert({
      tabela: 'anexos', registro_id: anexo.id, paciente_id: anexo.paciente_id, acao: 'acesso',
      usuario_id: claims.sub,
      usuario_nome: (u?.user_metadata?.nome || '').trim() || u?.email || null,
      usuario_email: u?.email || null,
      alteracoes: { modo: corpo.baixar ? 'download' : 'visualizacao' },
    });
    if (eaud) {
      console.error('auditoria (acesso):', eaud.message);
      return falha('Não foi possível registrar o acesso na trilha de auditoria; o arquivo não foi aberto. Tente de novo.', 500);
    }

    // 3) link temporário
    const { data: link, error: el } = await admin.storage.from('anexos')
      .createSignedUrl(anexo.caminho, VALIDADE_LINK, corpo.baixar ? { download: anexo.nome_arquivo } : undefined);
    if (el || !link?.signedUrl) throw el || new Error('link não gerado');
    return resposta({ url: link.signedUrl, validade: VALIDADE_LINK });
  } catch (e) {
    console.error('abrir anexo', e);
    return falha('Não foi possível abrir o anexo. Tente de novo em instantes.', 500);
  }
});
