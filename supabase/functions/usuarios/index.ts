// Função de servidor "usuarios": cadastro e manutenção de usuários pelo app.
//
// Usa a chave de serviço do Supabase, que existe apenas aqui no servidor
// (variável SUPABASE_SERVICE_ROLE_KEY, fornecida pelo próprio Supabase) e
// nunca vai para o navegador. Toda chamada exige sessão com a verificação em
// 2 etapas confirmada (aal2) e usuário não desativado.
//
// Ações (POST, corpo JSON { acao, ... }):
//   sem conta:         solicitar_acesso {nome, email, funcao, mensagem?}
//                      (única ação sem sessão; não cria conta, só registra o pedido)
//   qualquer usuário:  definir_minha_senha {senha}  (troca da senha temporária)
//   administradores:   listar (usuários + pedidos pendentes)
//                      criar {email, nome, papel, solicitacao_id?} | recusar_solicitacao {solicitacao_id}
//                      papel {id, papel} | desativar {id} | reativar {id}
//                      senha_temporaria {id} | remover_2_etapas {id}
import { createClient } from 'npm:@supabase/supabase-js@2.117.3';

const PAPEIS = ['admin', 'operador'];
const DESATIVADO = '876000h'; // ~100 anos

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

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Usuario = any;

const papelDe = (u: Usuario) => (u?.app_metadata?.papel === 'admin' ? 'admin' : 'operador');
const ativo = (u: Usuario) => !u?.banned_until || new Date(u.banned_until) <= new Date();
const adminAtivo = (u: Usuario) => papelDe(u) === 'admin' && ativo(u);

// mesma regra de senha do app e do Supabase
function problemaSenha(s: string): string | null {
  if (s.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s) || !/[^A-Za-z0-9]/.test(s)) {
    return 'Use letras maiúsculas e minúsculas, números e símbolos.';
  }
  return null;
}

// senha temporária que já atende à regra
function senhaTemporaria(): string {
  const grupos = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*?-+'];
  const todos = grupos.join('');
  const sorteio = (n: number) => {
    const v = new Uint32Array(1);
    crypto.getRandomValues(v);
    return v[0] % n;
  };
  const letras = grupos.map((g) => g[sorteio(g.length)]);
  while (letras.length < 14) letras.push(todos[sorteio(todos.length)]);
  for (let i = letras.length - 1; i > 0; i--) { // embaralha
    const j = sorteio(i + 1);
    [letras[i], letras[j]] = [letras[j], letras[i]];
  }
  return letras.join('');
}

function resumo(u: Usuario) {
  return {
    id: u.id,
    email: u.email,
    nome: (u.user_metadata?.nome || '').trim(),
    papel: papelDe(u),
    ativo: ativo(u),
    criado_em: u.created_at,
    ultimo_acesso: u.last_sign_in_at || null,
    tem_2_etapas: (u.factors || []).some((f: Usuario) => f.status === 'verified'),
    trocar_senha: u.app_metadata?.trocar_senha === true,
  };
}

async function listarTodos(): Promise<Usuario[]> {
  const lista: Usuario[] = [];
  for (let pagina = 1; pagina <= 20; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: pagina, perPage: 200 });
    if (error) throw error;
    lista.push(...data.users);
    if (data.users.length < 200) break;
  }
  return lista;
}

// Pedido de acesso de quem ainda não tem conta. Resposta sempre igual, exista
// ou não a conta/pedido (não revela quais e-mails estão cadastrados).
const LIMITE_PEDIDOS_HORA = 20;   // no sistema todo
const LIMITE_PENDENTES = 50;      // fila máxima aguardando o administrador
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function solicitarAcesso(corpo: Usuario): Promise<{ erro?: string }> {
  if (String(corpo.site || '')) return {}; // campo-armadilha preenchido: robô
  const nome = String(corpo.nome || '').trim().replace(/\s+/g, ' ');
  const email = String(corpo.email || '').trim().toLowerCase();
  const funcao = String(corpo.funcao || '').trim().replace(/\s+/g, ' ');
  const mensagem = String(corpo.mensagem || '').trim() || null;
  if (nome.length < 2 || nome.length > 80) return { erro: 'Informe o seu nome completo.' };
  if (!EMAIL_OK.test(email) || email.length > 254) return { erro: 'Informe um e-mail válido.' };
  if (funcao.length < 2 || funcao.length > 80) return { erro: 'Informe a sua função (ex.: Enfermeira – UTI).' };
  if (mensagem && mensagem.length > 300) return { erro: 'A mensagem pode ter no máximo 300 caracteres.' };

  const umaHora = new Date(Date.now() - 3600_000).toISOString();
  const [{ count: naHora, error: e1 }, { count: pendentes, error: e2 }] = await Promise.all([
    admin.from('solicitacoes_acesso').select('id', { count: 'exact', head: true }).gte('criado_em', umaHora),
    admin.from('solicitacoes_acesso').select('id', { count: 'exact', head: true }).eq('situacao', 'pendente'),
  ]);
  if (e1 || e2) throw e1 || e2;
  if ((naHora ?? 0) >= LIMITE_PEDIDOS_HORA || (pendentes ?? 0) >= LIMITE_PENDENTES) {
    return { erro: 'Não foi possível receber o pedido agora. Tente mais tarde ou fale diretamente com o administrador.' };
  }

  // já tem conta: não registra (o administrador não precisa decidir nada)
  if ((await listarTodos()).some((u) => (u.email || '').toLowerCase() === email)) return {};

  const { error } = await admin.from('solicitacoes_acesso').insert({ nome, email, funcao, mensagem });
  if (error && error.code !== '23505') throw error; // 23505: já há pedido pendente deste e-mail
  return {};
}

async function listarPendentes() {
  const { data, error } = await admin.from('solicitacoes_acesso')
    .select('id, criado_em, nome, email, funcao, mensagem')
    .eq('situacao', 'pendente').order('criado_em');
  if (error) throw error;
  return data || [];
}

async function encerrarSessoes(id: string) {
  const { error } = await admin.rpc('encerrar_sessoes', { p_usuario: id });
  if (error) throw error;
}

Deno.serve(async (req) => {
  const h = cabecalhos(req);
  const resposta = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: h });
  const falha = (erro: string, status = 400) => resposta({ erro }, status);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return falha('Método não permitido.', 405);

  let corpo: Usuario;
  try { corpo = await req.json(); } catch { return falha('Requisição inválida.'); }
  const acao = String(corpo?.acao || '');

  // --- única ação sem sessão: pedido de acesso ---
  if (acao === 'solicitar_acesso') {
    try {
      const r = await solicitarAcesso(corpo);
      return r.erro ? falha(r.erro) : resposta({ ok: true });
    } catch (e) {
      console.error('solicitar_acesso', e);
      return falha('Não foi possível enviar o pedido. Tente de novo em instantes.', 500);
    }
  }

  // --- quem está chamando? ---
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return falha('Sessão não informada.', 401);
  const { data: dc, error: ec } = await admin.auth.getClaims(token);
  const claims = dc?.claims as Usuario;
  if (ec || !claims?.sub) return falha('Sessão inválida ou expirada. Entre de novo.', 401);
  if (claims.aal !== 'aal2') return falha('Confirme a verificação em 2 etapas e tente de novo.', 403);

  // situação ATUAL (o token pode ter até 1 h)
  const { data: du, error: eu } = await admin.auth.admin.getUserById(claims.sub);
  const eu_mesmo = du?.user;
  if (eu || !eu_mesmo || !ativo(eu_mesmo)) return falha('Usuário desativado.', 403);

  // Trilha: a linha é gravada ANTES da ação; se não der para registrar, nada é feito.
  const iniciar = async (alvo: { id?: string | null; email?: string | null }, acaoLog: string, detalhes: Record<string, unknown> = {}) => {
    const { data, error } = await admin.from('auditoria_usuarios').insert({
      admin_id: eu_mesmo.id, admin_email: eu_mesmo.email,
      alvo_id: alvo.id ?? null, alvo_email: alvo.email ?? null,
      acao: acaoLog, detalhes,
    }).select('id').single();
    if (error) throw new Error('auditoria: ' + error.message);
    const id = data.id;
    return async (situacao: 'concluida' | 'falhou' | 'desfeita', extra: Record<string, unknown> = {}, alvoId?: string) => {
      const { error: e2 } = await admin.from('auditoria_usuarios')
        .update({ situacao, detalhes: { ...detalhes, ...extra }, ...(alvoId ? { alvo_id: alvoId } : {}) }).eq('id', id);
      if (e2) console.error('auditoria_usuarios (fechamento):', e2.message);
    };
  };

  try {
    // --- troca da senha temporária pelo próprio usuário (qualquer papel) ---
    if (acao === 'definir_minha_senha') {
      if (eu_mesmo.app_metadata?.trocar_senha !== true) return falha('Não há senha temporária a trocar. Use "Alterar senha" em Minha conta.');
      const senha = String(corpo.senha || '');
      const problema = problemaSenha(senha);
      if (problema) return falha(problema);
      const fechar = await iniciar(eu_mesmo, 'troca_senha_temporaria');
      const { error } = await admin.auth.admin.updateUserById(eu_mesmo.id, {
        password: senha,
        app_metadata: { trocar_senha: false },
      });
      if (error) {
        await fechar('falhou', { motivo: error.message });
        if (/should be different/i.test(error.message)) return falha('A nova senha deve ser diferente da senha temporária.');
        if (/weak|password/i.test(error.message)) return falha('Senha fraca: use no mínimo 10 caracteres, com maiúsculas, minúsculas, números e símbolos.');
        throw error;
      }
      await fechar('concluida');
      return resposta({ ok: true });
    }

    // --- daqui em diante, só administradores ---
    if (papelDe(eu_mesmo) !== 'admin') return falha('Somente administradores podem gerenciar usuários.', 403);

    if (acao === 'listar') {
      const [lista, solicitacoes] = await Promise.all([listarTodos(), listarPendentes()]);
      return resposta({ usuarios: lista.map(resumo), solicitacoes });
    }

    if (acao === 'recusar_solicitacao') {
      const sid = String(corpo.solicitacao_id || '').toLowerCase();
      if (!/^[0-9a-f-]{36}$/.test(sid)) return falha('Pedido não informado.');
      const { data: sol } = await admin.from('solicitacoes_acesso').select('id, email, nome, situacao').eq('id', sid).maybeSingle();
      if (!sol || sol.situacao !== 'pendente') return falha('Este pedido já foi decidido ou não existe mais.', 409);
      const fechar = await iniciar({ email: sol.email }, 'recusa_solicitacao', { solicitacao_id: sid, nome: sol.nome });
      const { data: atual, error } = await admin.from('solicitacoes_acesso')
        .update({ situacao: 'recusada', decidido_em: new Date().toISOString(), decidido_por: eu_mesmo.id, decidido_por_email: eu_mesmo.email })
        .eq('id', sid).eq('situacao', 'pendente').select('id');
      if (error) { await fechar('falhou', { motivo: error.message }); throw error; }
      if (!atual?.length) { await fechar('falhou', { motivo: 'já decidido' }); return falha('Este pedido já foi decidido por outro administrador.', 409); }
      await fechar('concluida');
      return resposta({ ok: true });
    }

    if (acao === 'criar') {
      const email = String(corpo.email || '').trim().toLowerCase();
      const nome = String(corpo.nome || '').trim().slice(0, 80);
      const papel = PAPEIS.includes(corpo.papel) ? corpo.papel : 'operador';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return falha('Informe um e-mail válido.');
      if (!nome) return falha('Informe o nome do usuário.');
      // aprovação de um pedido de acesso (opcional)
      const sid = String(corpo.solicitacao_id || '').toLowerCase();
      if (sid && !/^[0-9a-f-]{36}$/.test(sid)) return falha('Pedido inválido.');
      const fechar = await iniciar({ email }, 'cadastro', { papel, nome, ...(sid ? { solicitacao_id: sid } : {}) });
      const senha = senhaTemporaria();
      const { data, error } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true,
        user_metadata: { nome },
        app_metadata: { papel, trocar_senha: true },
      });
      if (error) {
        await fechar('falhou', { motivo: error.message });
        if (/already|registered|exists/i.test(error.message)) return falha('Já existe um usuário com este e-mail.');
        throw error;
      }
      if (sid) {
        const { error: es } = await admin.from('solicitacoes_acesso')
          .update({ situacao: 'aprovada', decidido_em: new Date().toISOString(), decidido_por: eu_mesmo.id,
                    decidido_por_email: eu_mesmo.email, usuario_id: data.user.id })
          .eq('id', sid).eq('situacao', 'pendente');
        if (es) console.error('solicitacao (aprovação):', es.message);
      }
      await fechar('concluida', {}, data.user.id);
      return resposta({ usuario: resumo(data.user), senha_temporaria: senha });
    }

    // --- ações sobre um usuário existente ---
    const idPedido = String(corpo.id || '').toLowerCase();
    if (!/^[0-9a-f-]{36}$/.test(idPedido)) return falha('Usuário não informado.');
    const { data: da, error: ea } = await admin.auth.admin.getUserById(idPedido);
    if (ea || !da?.user) return falha('Usuário não encontrado.', 404);
    const alvo = da.user;
    // compara o usuário encontrado, não o texto enviado
    if (alvo.id === eu_mesmo.id) {
      return falha('Você não pode alterar a sua própria conta por aqui. Peça a outro administrador.');
    }
    const id = alvo.id;

    // Depois de rebaixar ou desativar um administrador: se o sistema ficou sem
    // nenhum administrador ativo (ex.: dois se rebaixando ao mesmo tempo), desfaz.
    const garantirUmAdmin = async (desfazer: () => Promise<unknown>, fechar: (s: 'desfeita') => Promise<void>) => {
      if (!adminAtivo(alvo)) return null;
      const restantes = (await listarTodos()).filter(adminAtivo).length;
      if (restantes > 0) return null;
      await desfazer();
      await fechar('desfeita');
      return falha('Operação desfeita: o sistema ficaria sem nenhum administrador ativo.', 409);
    };

    if (acao === 'papel') {
      const papel = corpo.papel;
      if (!PAPEIS.includes(papel)) return falha('Papel inválido.');
      const antes = papelDe(alvo);
      if (antes === papel) return resposta({ usuario: resumo(alvo) });
      const fechar = await iniciar(alvo, 'papel', { de: antes, para: papel });
      const { data, error } = await admin.auth.admin.updateUserById(id, { app_metadata: { papel } });
      if (error) { await fechar('falhou', { motivo: error.message }); throw error; }
      if (papel === 'operador') {
        const desfeito = await garantirUmAdmin(
          () => admin.auth.admin.updateUserById(id, { app_metadata: { papel: 'admin' } }), fechar);
        if (desfeito) return desfeito;
      }
      await fechar('concluida');
      return resposta({ usuario: resumo(data.user) });
    }

    if (acao === 'desativar' || acao === 'reativar') {
      const fechar = await iniciar(alvo, acao === 'desativar' ? 'desativacao' : 'reativacao');
      const { data, error } = await admin.auth.admin.updateUserById(id, {
        ban_duration: acao === 'desativar' ? DESATIVADO : 'none',
      });
      if (error) { await fechar('falhou', { motivo: error.message }); throw error; }
      if (acao === 'desativar') {
        const desfeito = await garantirUmAdmin(
          () => admin.auth.admin.updateUserById(id, { ban_duration: 'none' }), fechar);
        if (desfeito) return desfeito;
        await encerrarSessoes(id);
      }
      await fechar('concluida');
      return resposta({ usuario: resumo(data.user) });
    }

    if (acao === 'senha_temporaria') {
      const fechar = await iniciar(alvo, 'senha_temporaria');
      const senha = senhaTemporaria();
      const { data, error } = await admin.auth.admin.updateUserById(id, {
        password: senha,
        app_metadata: { trocar_senha: true },
      });
      if (error) { await fechar('falhou', { motivo: error.message }); throw error; }
      await encerrarSessoes(id);
      await fechar('concluida');
      return resposta({ usuario: resumo(data.user), senha_temporaria: senha });
    }

    if (acao === 'remover_2_etapas') {
      const { data: lf, error: el } = await admin.auth.admin.mfa.listFactors({ userId: id });
      if (el) throw el;
      const fechar = await iniciar(alvo, 'remocao_2_etapas', { fatores: (lf?.factors || []).length });
      for (const f of lf?.factors || []) {
        const { error } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: id });
        if (error) { await fechar('falhou', { motivo: error.message }); throw error; }
      }
      await encerrarSessoes(id);
      await fechar('concluida');
      const { data } = await admin.auth.admin.getUserById(id);
      return resposta({ usuario: resumo(data?.user || alvo) });
    }

    return falha('Ação desconhecida.');
  } catch (e) {
    console.error(acao, e);
    const msg = e instanceof Error && e.message.startsWith('auditoria:')
      ? 'Não foi possível registrar a ação na trilha de auditoria; nada foi alterado. Tente de novo em instantes.'
      : 'Não foi possível concluir a operação. Tente de novo em instantes.';
    return falha(msg, 500);
  }
});
