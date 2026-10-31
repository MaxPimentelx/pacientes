(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const MODO_ONLINE = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

  // Situação clínica (a alta é um TIPO de registro, não uma situação)
  const STATUS = ['Estável', 'Melhorando', 'Piorando', 'Crítico'];
  const STATUS_CLASSE = {
    'Estável': 's-estavel', 'Melhorando': 's-melhorando', 'Piorando': 's-piorando',
    'Crítico': 's-critico', 'Alta': 's-alta' // "Alta" só em registros antigos
  };

  // O que aconteceu com o paciente naquele momento
  const TIPOS_REGISTRO = {
    rotina: 'Evolução de rotina',
    setor: 'Mudança de setor / leito',
    intercorrencia: 'Intercorrência',
    procedimento: 'Procedimento / cirurgia',
    alta: 'Alta / desfecho'
  };
  const INTERCORRENCIAS = [
    'Queda', 'Piora clínica', 'Reação adversa a medicamento', 'Infecção relacionada à assistência',
    'Lesão por pressão', 'Erro de medicação', 'Outra'
  ];
  const TIPOS_ALTA = [
    ['Curado', 'Curado'], ['Melhorado', 'Melhorado'], ['A pedido', 'A pedido'], ['Evasão', 'Evasão'],
    ['Transferência', 'Transferência (outro hospital)'], ['Óbito', 'Óbito'], ['Outro', 'Outro']
  ];
  const ROTULO_ALTA = Object.fromEntries(TIPOS_ALTA);
  // Barreiras mais comuns para a alta (base para medir diárias evitáveis)
  const PENDENCIAS = [
    'Aguardando exame', 'Aguardando resultado de exame', 'Aguardando parecer/avaliação',
    'Aguardando procedimento/cirurgia', 'Aguardando vaga (UTI, leito ou outro serviço)',
    'Aguardando autorização do convênio', 'Ajuste de medicação/estabilização', 'Questão social/familiar'
  ];
  const SETORES_PADRAO = ['Pronto-socorro', 'Observação', 'Enfermaria', 'Apartamento',
    'Semi-intensiva', 'UTI adulto', 'Centro cirúrgico', 'Hemodinâmica'];
  const DIAS_REINTERNACAO = 30;

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------
  const $ = (sel, el = document) => el.querySelector(sel);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hoje() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }

  function fmtData(iso) {
    if (!iso) return '—';
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  }

  function diasEntre(isoInicio, isoFim = hoje()) {
    const a = Date.UTC(...isoInicio.slice(0, 10).split('-').map((n, i) => i === 1 ? n - 1 : +n));
    const b = Date.UTC(...isoFim.slice(0, 10).split('-').map((n, i) => i === 1 ? n - 1 : +n));
    return Math.round((b - a) / 86400000);
  }

  function haQuanto(iso) {
    if (!iso) return '';
    const d = diasEntre(iso);
    if (d === 0) return 'hoje';
    if (d === 1) return 'ontem';
    if (d < 0) return `em ${-d} dias`;
    return `há ${d} dias`;
  }

  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  function idade(iso, referencia = hoje()) {
    if (!iso) return null;
    const [a, m, d] = iso.split('-').map(Number);
    const [ha, hm, hd] = referencia.slice(0, 10).split('-').map(Number);
    let anos = ha - a;
    if (hm < m || (hm === m && hd < d)) anos--;
    return anos;
  }

  const normalizar = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const vazioParaNull = v => (typeof v === 'string' && v.trim() === '') ? null : (typeof v === 'string' ? v.trim() : v);

  function pill(status) {
    if (!status) return '<span class="pill s-nenhum">Sem evolução</span>';
    return `<span class="pill ${STATUS_CLASSE[status] || 's-nenhum'}">${esc(status)}</span>`;
  }

  function ordenarEvolucoes(lista) {
    return (lista || []).slice().sort((x, y) =>
      (y.data || '').localeCompare(x.data || '') || (y.criado_em || '').localeCompare(x.criado_em || ''));
  }

  // Internações: mais recente primeiro
  function ordenarInternacoes(lista) {
    return (lista || []).slice().sort((x, y) =>
      (y.data_entrada || '').localeCompare(x.data_entrada || '') || (y.criado_em || '').localeCompare(x.criado_em || ''));
  }

  // Evoluções anuladas continuam visíveis, mas não contam para situação, CID nem DRG
  const validas = evs => (evs || []).filter(e => !e.anulada_em);

  // Visão usada pelas telas: dados da PESSOA + uma INTERNAÇÃO (padrão: a mais recente)
  function visao(p, i) {
    i = i || ordenarInternacoes(p.internacoes)[0] || {};
    return {
      ...p,
      internacao: i,
      internacao_id: i.id || null,
      data_entrada: i.data_entrada || null,
      motivo: i.motivo || '',
      cids_entrada: i.cids_entrada || [],
      setor_entrada: i.setor_entrada || null,
      leito_entrada: i.leito_entrada || null,
      previsao_alta_inicial: i.previsao_alta_inicial || null,
      setor_atual: i.setor_atual || null,
      leito_atual: i.leito_atual || null,
      previsao_alta: i.previsao_alta || null,
      pendencias_alta: i.pendencias_alta || [],
      data_baixa: i.data_baixa || null,
      tipo_alta: i.tipo_alta || null,
      evolucoes: i.evolucoes || []
    };
  }

  // Dias de atraso em relação à previsão de alta (só internação aberta)
  function atrasoAlta(v) {
    if (v.data_baixa || !v.previsao_alta) return 0;
    return Math.max(0, diasEntre(v.previsao_alta, hoje()));
  }

  // Reinternação: entrada até 30 dias depois da alta anterior
  function reinternacao(p, i) {
    const anteriores = ordenarInternacoes(p.internacoes)
      .filter(o => o.id !== i.id && o.data_baixa && o.data_baixa <= i.data_entrada);
    const anterior = anteriores[0];
    if (!anterior) return null;
    const dias = diasEntre(anterior.data_baixa, i.data_entrada);
    return dias <= DIAS_REINTERNACAO ? { dias, anterior } : null;
  }

  const textoSetor = (setor, leito) => setor ? `${setor}${leito ? ` · leito ${leito}` : ''}` : (leito ? `Leito ${leito}` : '');

  function resumo(v) {
    const evs = ordenarEvolucoes(validas(v.evolucoes));
    return {
      ultima: evs[0] || null,
      ultimaData: evs[0]?.data || null,
      status: evs.find(e => e.status)?.status || null,
      // CID vigente = o da evolução mais recente que tenha CID; senão, o de entrada
      cids: evs.find(e => e.cids?.length)?.cids || v.cids_entrada || [],
      total: evs.length
    };
  }

  // ------------------------------------------------------------------
  // Dados para DRG: classificação dos CIDs secundários e procedimentos
  // ------------------------------------------------------------------
  const ROTULO_TIPO = { comorbidade: 'Comorbidade', complicacao: 'Complicação' };
  const SEXO = { F: 'Feminino', M: 'Masculino' };

  // Secundários da entrada são comorbidades (presentes na admissão)
  const tiposEntrada = v => Object.fromEntries((v.cids_entrada || []).slice(1).map(c => [c, 'comorbidade']));

  // Classificação vigente de cada CID: entrada + evoluções em ordem cronológica
  function tiposAtuais(v, evs) {
    const tipos = tiposEntrada(v);
    for (const e of ordenarEvolucoes(validas(evs)).reverse()) Object.assign(tipos, e.cids_tipos || {});
    return tipos;
  }

  // Consolidado da internação inteira, no formato que um agrupador DRG pede
  function consolidadoDrg(v, evs) {
    const asc = ordenarEvolucoes(validas(evs)).reverse();
    const principal = resumo({ ...v, evolucoes: evs }).cids[0] || null;
    const comorbidades = new Set(), complicacoes = new Set();
    for (const [c, t] of Object.entries(tiposEntrada(v))) (t === 'complicacao' ? complicacoes : comorbidades).add(c);
    for (const e of asc) {
      (e.cids || []).slice(1).forEach(c => {
        const t = e.cids_tipos?.[c];
        if (t === 'complicacao') complicacoes.add(c); else if (t === 'comorbidade') comorbidades.add(c);
      });
    }
    // complicação prevalece (surgiu na internação); principal não entra nas listas
    complicacoes.forEach(c => comorbidades.delete(c));
    comorbidades.delete(principal); complicacoes.delete(principal);
    const procedimentos = asc.flatMap(e => (e.procedimentos || []).map(pr => ({ ...pr, data: e.data })));
    const intercorrencias = asc.filter(e => e.tipo === 'intercorrencia').map(e => ({ data: e.data, tipo: e.intercorrencia }));
    const setores = asc.filter(e => e.tipo === 'setor').map(e => ({ data: e.data, setor: e.setor, leito: e.leito }));
    return { principal, comorbidades: [...comorbidades], complicacoes: [...complicacoes], procedimentos, intercorrencias, setores };
  }

  // ------------------------------------------------------------------
  // Autoria (quem cadastrou / alterou / registrou)
  // ------------------------------------------------------------------
  function fmtDataHora(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  const autor = (nome, email) => nome || email || 'usuário não identificado';
  const linhaAutoria = (rotulo, nome, email, ts) =>
    `${rotulo} <b title="${esc(email || '')}">${esc(autor(nome, email))}</b>${ts ? ` em ${fmtDataHora(ts)}` : ''}`;
  // só quem registrou pode anular, uma única vez (regra também garantida no banco)
  const podeAnular = e => !e.anulada_em && (!MODO_ONLINE || !e.criado_por || e.criado_por === estado.usuario?.id);

  const textoProcedimento = pr => [pr.codigo, pr.descricao].filter(Boolean).join(' – ');

  // Lista editável de procedimentos (código opcional + descrição)
  function montarProcedimentos(raiz) {
    raiz.innerHTML = `
      <ul class="proc-lista"></ul>
      <button type="button" class="btn btn-ghost btn-sm proc-add">+ Adicionar procedimento</button>`;
    const ul = raiz.querySelector('.proc-lista');
    const novaLinha = () => {
      ul.insertAdjacentHTML('beforeend', `
        <li class="proc-linha">
          <input class="proc-codigo" placeholder="Código (opcional)" aria-label="Código do procedimento" inputmode="numeric">
          <input class="proc-desc" placeholder="Procedimento realizado" aria-label="Descrição do procedimento">
          <button type="button" class="cid-btn cid-remover" aria-label="Remover procedimento">×</button>
        </li>`);
      ul.lastElementChild.querySelector('.proc-desc').focus();
    };
    raiz.querySelector('.proc-add').addEventListener('click', novaLinha);
    ul.addEventListener('click', e => { if (e.target.closest('.cid-remover')) e.target.closest('li').remove(); });
    return {
      valores: () => [...ul.querySelectorAll('li')]
        .map(li => ({ codigo: li.querySelector('.proc-codigo').value.trim(), descricao: li.querySelector('.proc-desc').value.trim() }))
        .filter(pr => pr.codigo || pr.descricao),
      adicionarLinha: novaLinha
    };
  }

  // ------------------------------------------------------------------
  // CID-10 (tabela oficial DATASUS em cid10.json)
  // ------------------------------------------------------------------
  let CID = null;        // Map código -> descrição
  let CID_LISTA = null;  // itens pré-normalizados para busca
  let cidPromessa = null;

  function carregarCid() {
    if (!cidPromessa) {
      cidPromessa = fetch('cid10.json')
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(arr => {
          CID = new Map(arr);
          CID_LISTA = arr.map(([c, d]) => ({ c, d, cn: c.replace('.', '').toLowerCase(), dn: normalizar(d) }));
        })
        .catch(e => { console.warn('Tabela CID indisponível:', e); cidPromessa = null; });
    }
    return cidPromessa;
  }

  const descCid = c => CID?.get(c) || '';
  const CID_FORMATO = /^[A-Z]\d{2}(\.\d{1,2})?$/;

  function buscarCid(q, limite = 40) {
    const t = normalizar(q).trim();
    if (!t || !CID_LISTA) return [];
    const codigo = t.replace(/[.\s]/g, '');
    const pareceCodigo = /^[a-z]\d{0,3}$/.test(codigo);
    const palavras = t.split(/\s+/);
    const res = [];
    for (const it of CID_LISTA) {
      if (pareceCodigo ? it.cn.startsWith(codigo) : palavras.every(p => it.dn.includes(p))) {
        res.push(it);
        if (res.length >= limite) break;
      }
    }
    return res;
  }

  function cidTag(c, principal, tipo) {
    const d = descCid(c);
    return `<span class="cid-tag ${principal ? 'principal' : ''} ${tipo === 'complicacao' ? 'complicacao' : ''}" title="${esc(d)}">` +
      `<b>${esc(c)}</b>${d ? `<span class="cid-desc">${esc(d)}</span>` : ''}` +
      `${!principal && tipo ? `<span class="cid-tipo">${ROTULO_TIPO[tipo]}</span>` : ''}</span>`;
  }
  const cidLista = (cids, tipos = {}) => cids?.length
    ? `<div class="cid-lista">${cids.map((c, i) => cidTag(c, i === 0, tipos[c])).join('')}</div>`
    : '<span class="item-meta">Não informado</span>';

  // Seletor com busca: chips (1º = principal) + sugestões.
  // classificar: secundários ganham "Comorbidade / Complicação" (evoluções);
  // sem classificar, secundários são comorbidades fixas (entrada).
  function montarSeletorCid(raiz, iniciais = [], { classificar = false, tiposIniciais = {}, padraoNovo = 'complicacao' } = {}) {
    let valores = [...iniciais];
    let tipos = { ...tiposIniciais };
    let sugestoes = [], ativo = -1;
    raiz.innerHTML = `
      <ul class="cid-chips"></ul>
      <div class="cid-busca">
        <input type="text" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false"
               aria-label="Buscar CID" placeholder="Buscar por código ou doença (ex.: J18 ou pneumonia)">
        <ul class="cid-sugestoes" role="listbox" hidden></ul>
      </div>`;
    const ulChips = raiz.querySelector('.cid-chips');
    const input = raiz.querySelector('input');
    const ulSug = raiz.querySelector('.cid-sugestoes');

    function renderChips() {
      ulChips.hidden = !valores.length;
      ulChips.innerHTML = valores.map((c, i) => `
        <li class="cid-chip">
          <span><b>${esc(c)}</b> ${esc(descCid(c))}</span>
          ${i === 0 ? '<span class="cid-principal">Principal</span>' : `
            ${classificar
              ? `<select class="cid-tipo-sel ${tipos[c] ? '' : 'pendente'}" data-tipo="${esc(c)}" aria-label="Classificação de ${esc(c)}">
                   ${tipos[c] ? '' : '<option value="" selected>— classificar —</option>'}
                   <option value="comorbidade" ${tipos[c] === 'comorbidade' ? 'selected' : ''}>Comorbidade (prévia)</option>
                   <option value="complicacao" ${tipos[c] === 'complicacao' ? 'selected' : ''}>Complicação (na internação)</option>
                 </select>`
              : '<span class="cid-tipo">Comorbidade</span>'}
            <button type="button" class="cid-btn" data-principal="${i}" title="Tornar diagnóstico principal">↑ Principal</button>`}
          <button type="button" class="cid-btn cid-remover" data-remover="${i}" aria-label="Remover ${esc(c)}">×</button>
        </li>`).join('');
    }

    function fecharSug() { ulSug.hidden = true; input.setAttribute('aria-expanded', 'false'); }
    function renderSug(msg) {
      if (msg) {
        ulSug.innerHTML = `<li class="info">${esc(msg)}</li>`;
      } else if (sugestoes.length) {
        ulSug.innerHTML = sugestoes.map((s, i) =>
          `<li role="option" data-i="${i}" class="${i === ativo ? 'ativo' : ''}" aria-selected="${i === ativo}"><b>${esc(s.c)}</b> ${esc(s.d)}</li>`).join('');
        ulSug.querySelector('.ativo')?.scrollIntoView({ block: 'nearest' });
      } else { fecharSug(); return; }
      ulSug.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function adicionar(c) {
      if (!valores.includes(c)) valores.push(c);
      if (classificar && !tipos[c]) tipos[c] = padraoNovo; // CID novo nesta evolução
      input.value = ''; sugestoes = []; ativo = -1;
      fecharSug(); renderChips(); input.focus();
    }

    input.addEventListener('input', async () => {
      const q = input.value;
      if (!q.trim()) { sugestoes = []; fecharSug(); return; }
      if (!CID_LISTA) { renderSug('Carregando tabela CID…'); await carregarCid(); }
      if (input.value !== q) return; // usuário continuou digitando
      if (!CID_LISTA) { renderSug('Tabela CID indisponível. Digite o código (ex.: J18.9) e tecle Enter.'); return; }
      sugestoes = buscarCid(q);
      ativo = sugestoes.length ? 0 : -1;
      renderSug(sugestoes.length ? null : 'Nenhum CID encontrado.');
    });

    input.addEventListener('keydown', e => {
      const aberto = !ulSug.hidden && sugestoes.length;
      if (e.key === 'ArrowDown' && aberto) { e.preventDefault(); ativo = Math.min(ativo + 1, sugestoes.length - 1); renderSug(); }
      else if (e.key === 'ArrowUp' && aberto) { e.preventDefault(); ativo = Math.max(ativo - 1, 0); renderSug(); }
      else if (e.key === 'Enter') {
        if (!input.value.trim()) return;
        e.preventDefault(); // nunca envia o formulário a partir da busca
        if (aberto && sugestoes[ativo]) adicionar(sugestoes[ativo].c);
        else {
          const cod = input.value.trim().toUpperCase().replace(/^([A-Z]\d{2})(\d{1,2})$/, '$1.$2');
          if (CID_FORMATO.test(cod) && (!CID || CID.has(cod))) adicionar(cod);
        }
      } else if (e.key === 'Escape' && !ulSug.hidden) { e.preventDefault(); fecharSug(); }
    });

    ulSug.addEventListener('mousedown', e => e.preventDefault()); // mantém o foco no campo
    ulSug.addEventListener('click', e => {
      const li = e.target.closest('li[data-i]');
      if (li) adicionar(sugestoes[+li.dataset.i].c);
    });
    input.addEventListener('blur', () => setTimeout(fecharSug, 150));

    ulChips.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.remover) valores.splice(+b.dataset.remover, 1);
      if (b.dataset.principal) valores.unshift(...valores.splice(+b.dataset.principal, 1));
      renderChips();
    });
    ulChips.addEventListener('change', e => {
      const sel = e.target.closest('.cid-tipo-sel');
      if (sel && sel.value) { tipos[sel.dataset.tipo] = sel.value; renderChips(); }
    });

    renderChips();
    if (CID === null) carregarCid().then(renderChips); // completa descrições quando a tabela chegar
    return {
      valores: () => [...valores],
      // classificação só dos secundários atuais (o principal não é classificado)
      tipos: () => Object.fromEntries(valores.slice(1).filter(c => tipos[c]).map(c => [c, tipos[c]])),
      definir(v, t = {}) { valores = [...(v || [])]; tipos = { ...t }; input.value = ''; fecharSug(); renderChips(); }
    };
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function msgErro(e) {
    const m = e?.message || String(e);
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet.';
    if (/should be different/i.test(m)) return 'A nova senha deve ser diferente da senha atual.';
    if (/rate limit|too many/i.test(m)) return 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.';
    if (/weak|password should|characters/i.test(m)) return 'Senha fraca: use no mínimo 10 caracteres, com maiúsculas, minúsculas, números e símbolos.';
    if (/aal2|insufficient_aal|assurance/i.test(m)) return 'Confirme a verificação em 2 etapas e tente de novo.';
    if (/internacoes_uma_aberta|uma internação aberta/i.test(m)) return 'Este paciente já tem uma internação em andamento. Registre a alta antes de abrir outra.';
    if (/setores_nome_key|duplicate key.*setores/i.test(m)) return 'Já existe um setor com esse nome.';
    if (/internacoes_previsao_apos_entrada/i.test(m)) return 'A previsão de alta não pode ser anterior à entrada.';
    return m;
  }

  // Regra de senha (a mesma configurada no Supabase)
  function problemaSenha(senha, confirmacao) {
    if (senha !== confirmacao) return 'As duas senhas digitadas não são iguais.';
    if (senha.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
    if (!/[a-z]/.test(senha) || !/[A-Z]/.test(senha) || !/[0-9]/.test(senha) || !/[^A-Za-z0-9]/.test(senha)) {
      return 'Use letras maiúsculas e minúsculas, números e símbolos.';
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Acesso a dados: Supabase (on-line) ou navegador (demonstração)
  // ------------------------------------------------------------------
  function backendSupabase() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    // chegada pelo link de "esqueci minha senha": o evento ocorre na inicialização do cliente
    let chegouPorRecuperacao = /(^|[#&?])type=recovery(&|$)/.test(location.hash + '&' + location.search.slice(1));
    sb.auth.onAuthStateChange(evento => { if (evento === 'PASSWORD_RECOVERY') chegouPorRecuperacao = true; });
    return {
      veioDeRecuperacaoDeSenha: () => chegouPorRecuperacao,
      concluiuRecuperacaoDeSenha() { chegouPorRecuperacao = false; },
      async enviarLinkRecuperacao(email) {
        // volta para o mesmo endereço do app (precisa estar liberado em Auth > URL Configuration)
        ok(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
      },
      async alterarSenha(senha) { ok(await sb.auth.updateUser({ password: senha })); },
      async sessao() {
        const { data } = await sb.auth.getSession();
        const u = data.session?.user;
        return u ? {
          id: u.id, email: u.email,
          nome: (u.user_metadata?.nome || '').trim(),
          papel: u.app_metadata?.papel || null
        } : null;
      },
      // nome de exibição usado na autoria dos próximos registros
      async definirNome(nome) { ok(await sb.auth.updateUser({ data: { nome } })); },
      async entrar(email, senha) { ok(await sb.auth.signInWithPassword({ email, password: senha })); },
      async sair() { await sb.auth.signOut(); },
      // avisa quando a sessão termina em outra aba
      aoEncerrarSessao(cb) { sb.auth.onAuthStateChange(evento => { if (evento === 'SIGNED_OUT') cb(); }); },

      // --- Verificação em 2 etapas (TOTP) ---
      async nivelMfa() {
        const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
        if (error) throw error;
        return { atual: data.currentLevel, proximo: data.nextLevel };
      },
      async fatorMfa() {
        const { data, error } = await sb.auth.mfa.listFactors();
        if (error) throw error;
        return data.totp?.[0] || null; // só fatores já verificados
      },
      async verificarMfa(factorId, code) { ok(await sb.auth.mfa.challengeAndVerify({ factorId, code })); },
      async iniciarCadastroMfa() {
        // descarta tentativas de cadastro abandonadas antes de criar uma nova
        const { data: lista } = await sb.auth.mfa.listFactors();
        for (const f of (lista?.all || []).filter(f => f.status !== 'verified')) {
          await sb.auth.mfa.unenroll({ factorId: f.id });
        }
        const { data, error } = await sb.auth.mfa.enroll({
          factorType: 'totp', issuer: 'Controle de Pacientes',
          friendlyName: 'Autenticador ' + new Date().toISOString().slice(0, 19)
        });
        if (error) throw error;
        return { factorId: data.id, qr: data.totp.qr_code, segredo: data.totp.secret };
      },

      // --- Pacientes, internações e evoluções ---
      async listarPacientes() {
        return ok(await sb.from('pacientes')
          .select(`id, nome, data_nascimento, sexo, telefone, documento, observacoes, criado_em,
            internacoes(id, data_entrada, motivo, cids_entrada, setor_atual, leito_atual, previsao_alta,
              pendencias_alta, data_baixa, tipo_alta, criado_em,
              evolucoes(data, status, descricao, cids, criado_em, anulada_em, tipo))`)
          .order('nome'));
      },
      async obterPaciente(id) {
        return ok(await sb.from('pacientes').select('*, internacoes(*)').eq('id', id).maybeSingle());
      },
      // pessoa + primeira internação numa única transação (função no banco)
      async cadastrarPaciente(pessoa, internacao) {
        return ok(await sb.rpc('cadastrar_paciente', { p_paciente: pessoa, p_internacao: internacao }));
      },
      async atualizarPaciente(id, p) { return ok(await sb.from('pacientes').update(p).eq('id', id).select().single()); },
      async criarInternacao(i) { return ok(await sb.from('internacoes').insert(i).select().single()); },
      async atualizarInternacao(id, i) { return ok(await sb.from('internacoes').update(i).eq('id', id).select().single()); },
      async listarEvolucoes(internacaoId) {
        return ok(await sb.from('evolucoes').select('*').eq('internacao_id', internacaoId)
          .order('data', { ascending: false }).order('criado_em', { ascending: false }));
      },
      async criarEvolucao(e) { return ok(await sb.from('evolucoes').insert(e).select().single()); },
      // registro clínico não se apaga: o banco só aceita ANULAR (só o autor, com justificativa)
      async anularEvolucao(id, motivo) {
        const linhas = ok(await sb.from('evolucoes').update({ motivo_anulacao: motivo }).eq('id', id).select('id'));
        if (!linhas?.length) throw new Error('Somente quem registrou a evolução pode anulá-la (ou ela já foi anulada).');
      },
      async listarAuditoria(pid) {
        return ok(await sb.from('auditoria').select('*').eq('paciente_id', pid)
          .order('ocorrido_em', { ascending: false }).limit(300));
      },

      // --- Setores (edição só por administradores; regra no banco) ---
      async listarSetores() { return ok(await sb.from('setores').select('*').order('ordem').order('nome')); },
      async salvarSetor(s) {
        if (s.id) return ok(await sb.from('setores').update({ nome: s.nome, ativo: s.ativo, ordem: s.ordem }).eq('id', s.id).select().single());
        return ok(await sb.from('setores').insert({ nome: s.nome, ordem: s.ordem ?? 100 }).select().single());
      }
    };
  }

  function backendLocal() {
    const CHAVE = 'controle-pacientes-demo-v1';
    let mem;
    try { mem = JSON.parse(localStorage.getItem(CHAVE)); } catch { mem = null; }
    if (!mem || !Array.isArray(mem.pacientes)) mem = { pacientes: [], evolucoes: [] };
    if (!Array.isArray(mem.auditoria)) mem.auditoria = [];
    const gravar = () => { try { localStorage.setItem(CHAVE, JSON.stringify(mem)); } catch { /* sem storage */ } };
    const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const agora = () => new Date().toISOString();
    // no modo demonstração a autoria é simulada (no Supabase é gravada pelo banco)
    const usuarioDemo = { id: 'demo', email: 'demonstracao@local', nome: 'Usuário de demonstração', papel: 'admin' };
    const criacao = () => ({ criado_em: agora(), criado_por: usuarioDemo.id, criado_por_nome: usuarioDemo.nome, criado_por_email: usuarioDemo.email });
    const alteracao = () => ({ atualizado_em: agora(), atualizado_por: usuarioDemo.id, atualizado_por_nome: usuarioDemo.nome, atualizado_por_email: usuarioDemo.email });

    // trilha de auditoria simulada (no Supabase quem grava é o banco)
    const IGNORAR = /^(id|paciente_id|internacao_id|evolucoes|internacoes|criado_.*|atualizado_.*|anulada_por.*|setor_atual|leito_atual|previsao_alta|pendencias_alta|data_baixa|tipo_alta)$/;
    function auditar(tabela, registro, pacienteId, acao, antes) {
      const alteracoes = {};
      for (const [k, v] of Object.entries(registro)) {
        if (IGNORAR.test(k) && !(tabela === 'evolucoes' && /^(previsao_alta|pendencias_alta|tipo_alta)$/.test(k) && antes)) continue;
        if (antes) {
          if (JSON.stringify(antes[k] ?? null) !== JSON.stringify(v ?? null)) alteracoes[k] = { de: antes[k] ?? null, para: v ?? null };
        } else if (tabela !== 'evolucoes' && v != null && v !== '' && !(Array.isArray(v) && !v.length)) {
          alteracoes[k] = { para: v };
        }
      }
      if (antes && !Object.keys(alteracoes).length) return;
      mem.auditoria.push({
        id: novoId(), ocorrido_em: agora(), tabela, registro_id: registro.id, paciente_id: pacienteId, acao,
        usuario_id: usuarioDemo.id, usuario_nome: usuarioDemo.nome, usuario_email: usuarioDemo.email, alteracoes
      });
    }

    // mesma regra do banco: situação da internação calculada pelas evoluções válidas
    function derivar(i) {
      const evs = ordenarEvolucoes(validas(mem.evolucoes.filter(e => e.internacao_id === i.id)));
      const alta = evs.find(e => e.tipo === 'alta');
      const setor = evs.find(e => e.tipo === 'setor');
      const prev = evs.find(e => e.previsao_alta);
      const pend = evs.find(e => Array.isArray(e.pendencias_alta));
      if (!alta && i.data_baixa && mem.internacoes.some(o => o.paciente_id === i.paciente_id && o.id !== i.id && !o.data_baixa)) {
        throw new Error('Não é possível desfazer esta alta: o paciente já tem outra internação aberta.');
      }
      Object.assign(i, {
        data_baixa: alta?.data || null, tipo_alta: alta?.tipo_alta || null,
        setor_atual: setor ? setor.setor : (i.setor_entrada || null),
        leito_atual: setor ? setor.leito : (i.leito_entrada || null),
        previsao_alta: prev ? prev.previsao_alta : (i.previsao_alta_inicial || null),
        pendencias_alta: pend ? pend.pendencias_alta : []
      });
    }

    // dados antigos do modo demonstração (paciente = internação) → internações
    if (!Array.isArray(mem.internacoes)) {
      mem.internacoes = [];
      for (const p of mem.pacientes) {
        const i = {
          id: novoId(), paciente_id: p.id, data_entrada: p.data_entrada || hoje(), motivo: p.motivo || '(não informado)',
          cids_entrada: p.cids_entrada || [], setor_entrada: null, leito_entrada: null, previsao_alta_inicial: null,
          criado_em: p.criado_em, criado_por: p.criado_por, criado_por_nome: p.criado_por_nome, criado_por_email: p.criado_por_email
        };
        mem.internacoes.push(i);
        mem.evolucoes.filter(e => e.paciente_id === p.id).forEach(e => { e.internacao_id = i.id; e.tipo = e.tipo || 'rotina'; });
        if (p.data_baixa) {
          mem.evolucoes.push({
            id: novoId(), internacao_id: i.id, paciente_id: p.id, data: p.data_baixa, tipo: 'alta', tipo_alta: p.tipo_alta || 'Outro',
            descricao: 'Alta registrada no cadastro antes da reorganização em internações (registro migrado automaticamente).',
            criado_em: p.atualizado_em || p.criado_em || agora(), criado_por: p.atualizado_por || p.criado_por,
            criado_por_nome: p.atualizado_por_nome || p.criado_por_nome, criado_por_email: p.atualizado_por_email || p.criado_por_email
          });
        }
        for (const k of ['data_entrada', 'motivo', 'cids_entrada', 'data_baixa', 'tipo_alta']) delete p[k];
      }
      mem.internacoes.forEach(derivar);
      gravar();
    }
    if (!Array.isArray(mem.setores)) {
      mem.setores = SETORES_PADRAO.map((nome, n) => ({ id: novoId(), nome, ordem: (n + 1) * 10, ativo: true }));
      gravar();
    }

    const comInternacoes = (p, comEvolucoes) => ({
      ...p,
      internacoes: mem.internacoes.filter(i => i.paciente_id === p.id).map(i => comEvolucoes
        ? { ...i, evolucoes: mem.evolucoes.filter(e => e.internacao_id === i.id) }
        : { ...i })
    });
    const PESSOA = ['nome', 'data_nascimento', 'sexo', 'telefone', 'documento', 'observacoes'];
    const ENTRADA = ['data_entrada', 'motivo', 'cids_entrada', 'setor_entrada', 'leito_entrada', 'previsao_alta_inicial'];
    const pegar = (obj, campos) => Object.fromEntries(campos.filter(c => c in obj).map(c => [c, obj[c]]));

    function abrirInternacao(dados) {
      if (mem.internacoes.some(o => o.paciente_id === dados.paciente_id && !o.data_baixa)) {
        throw new Error('Este paciente já tem uma internação em andamento. Registre a alta antes de abrir outra.');
      }
      if (dados.previsao_alta_inicial && dados.previsao_alta_inicial < dados.data_entrada) {
        throw new Error('A previsão de alta não pode ser anterior à entrada.');
      }
      const i = { id: novoId(), paciente_id: dados.paciente_id, ...pegar(dados, ENTRADA), ...criacao() };
      mem.internacoes.push(i);
      derivar(i);
      auditar('internacoes', i, i.paciente_id, 'cadastro');
      return i;
    }

    return {
      async sessao() { return usuarioDemo; },
      async definirNome(nome) { usuarioDemo.nome = nome || 'Usuário de demonstração'; },
      async entrar() {},
      async sair() {},
      async listarPacientes() {
        return mem.pacientes.map(p => comInternacoes(p, true)).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      },
      async obterPaciente(id) {
        const p = mem.pacientes.find(x => x.id === id);
        return p ? comInternacoes(p, false) : null;
      },
      async cadastrarPaciente(pessoa, internacao) {
        const p = { id: novoId(), ...pegar(pessoa, PESSOA), ...criacao() };
        mem.pacientes.push(p);
        auditar('pacientes', p, p.id, 'cadastro');
        abrirInternacao({ ...internacao, paciente_id: p.id });
        gravar();
        return p.id;
      },
      async atualizarPaciente(id, dados) {
        const atual = mem.pacientes.find(x => x.id === id);
        const novos = pegar(dados, PESSOA);
        auditar('pacientes', { ...atual, ...novos }, id, 'alteracao', { ...atual });
        Object.assign(atual, novos, alteracao());
        gravar(); return atual;
      },
      async criarInternacao(dados) { const i = abrirInternacao(dados); gravar(); return i; },
      async atualizarInternacao(id, dados) {
        const i = mem.internacoes.find(x => x.id === id);
        const novos = pegar(dados, ENTRADA);
        if ((novos.previsao_alta_inicial || null) && novos.previsao_alta_inicial < (novos.data_entrada || i.data_entrada)) {
          throw new Error('A previsão de alta não pode ser anterior à entrada.');
        }
        auditar('internacoes', { ...i, ...novos }, i.paciente_id, 'alteracao', { ...i });
        Object.assign(i, novos, alteracao());
        derivar(i);
        gravar(); return i;
      },
      async listarEvolucoes(internacaoId) { return ordenarEvolucoes(mem.evolucoes.filter(e => e.internacao_id === internacaoId)); },
      async criarEvolucao(e) {
        const i = mem.internacoes.find(x => x.id === e.internacao_id);
        if (!i) throw new Error('Internação não encontrada.');
        if (i.data_baixa) throw new Error(`Esta internação já foi encerrada (alta em ${fmtData(i.data_baixa)}). Para registrar, abra uma nova internação.`);
        if (e.data < i.data_entrada) throw new Error(`A data da evolução não pode ser anterior à entrada (${fmtData(i.data_entrada)}).`);
        if (e.data > hoje()) throw new Error('A data da evolução não pode ser futura.');
        if (e.previsao_alta && e.previsao_alta < i.data_entrada) throw new Error('A previsão de alta não pode ser anterior à entrada.');
        const nova = { ...e, paciente_id: i.paciente_id, id: novoId(), ...criacao() };
        mem.evolucoes.push(nova);
        derivar(i);
        auditar('evolucoes', nova, nova.paciente_id, 'cadastro');
        gravar(); return nova;
      },
      async anularEvolucao(id, motivo) {
        const ev = mem.evolucoes.find(e => e.id === id);
        if (!ev) throw new Error('Evolução não encontrada.');
        if (ev.anulada_em) throw new Error('Esta evolução já foi anulada.');
        if ((motivo || '').trim().length < 10) throw new Error('Informe a justificativa da anulação (mínimo de 10 caracteres).');
        const antes = { ...ev };
        Object.assign(ev, {
          anulada_em: agora(), anulada_por: usuarioDemo.id, anulada_por_nome: usuarioDemo.nome,
          anulada_por_email: usuarioDemo.email, motivo_anulacao: motivo.trim()
        });
        try {
          derivar(mem.internacoes.find(x => x.id === ev.internacao_id));
        } catch (err) {
          Object.assign(ev, antes); // desfaz, como o banco faria
          throw err;
        }
        auditar('evolucoes', ev, ev.paciente_id, 'anulacao', antes);
        gravar();
      },
      async listarAuditoria(pid) {
        return mem.auditoria.filter(a => a.paciente_id === pid)
          .sort((a, b) => b.ocorrido_em.localeCompare(a.ocorrido_em));
      },
      async listarSetores() {
        return mem.setores.slice().sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR'));
      },
      async salvarSetor(s) {
        const nome = (s.nome || '').trim();
        if (mem.setores.some(x => x.id !== s.id && normalizar(x.nome) === normalizar(nome))) throw new Error('Já existe um setor com esse nome.');
        if (s.id) { const x = mem.setores.find(y => y.id === s.id); Object.assign(x, { nome, ativo: s.ativo }); gravar(); return x; }
        const novo = { id: novoId(), nome, ordem: s.ordem ?? 100, ativo: true };
        mem.setores.push(novo); gravar(); return novo;
      }
    };
  }

  // ------------------------------------------------------------------
  // Estado e telas
  // ------------------------------------------------------------------
  let db;
  const estado = {
    pacientes: [], setores: [], selecionado: null, internacaoSel: null,
    busca: '', filtro: '', filtroSetor: '', baixa: 'sem'
  };
  let seletorEvolucao = null;
  let procedimentosEvolucao = null;
  const pillBaixa = v => `<span class="pill s-baixa">Alta ${fmtData(v.data_baixa)}</span>`;
  const elDetalhe = $('#detalhe');

  // etapa: 'senha' | 'esqueci' | 'mfa-codigo' | 'mfa-cadastro' | 'nova-senha'
  const FORMS_ACESSO = {
    'senha': '#form-login', 'esqueci': '#form-esqueci', 'mfa-codigo': '#form-mfa-codigo',
    'mfa-cadastro': '#form-mfa-cadastro', 'nova-senha': '#form-nova-senha'
  };
  function mostrarLogin(mensagem, etapa = 'senha') {
    pararVigiaInatividade();
    $('#tela-login').hidden = false;
    $('#tela-app').hidden = true;
    $('#user-box').hidden = true;
    for (const [nome, sel] of Object.entries(FORMS_ACESSO)) $(sel).hidden = nome !== etapa;
    $('#btn-esqueci').hidden = !MODO_ONLINE;
    $('#login-info').textContent = mensagem || '';
    $('#login-info').hidden = !mensagem;
    document.querySelectorAll('#tela-login .erro, #tela-login .sucesso').forEach(e => { e.hidden = true; });
    const primeiroCampo = $(FORMS_ACESSO[etapa])?.querySelector('input');
    if (primeiroCampo && etapa !== 'senha') primeiroCampo.focus();
  }

  // Depois das 2 etapas: quem veio do link de recuperação cria a senha nova antes de entrar
  async function aposSegundaEtapa() {
    if (MODO_ONLINE && db.veioDeRecuperacaoDeSenha()) return mostrarLogin(null, 'nova-senha');
    return mostrarApp(await db.sessao());
  }

  async function mostrarApp(sessao) {
    $('#tela-login').hidden = true;
    $('#tela-app').hidden = false;
    estado.usuario = sessao;
    $('#user-box').hidden = false;
    renderUsuario();
    iniciarVigiaInatividade();
    await Promise.all([carregarPacientes(), carregarCid(), carregarSetores()]);
    rotear();
  }

  // ------------------------------------------------------------------
  // Acesso: senha → 2ª etapa obrigatória (código do app autenticador)
  // ------------------------------------------------------------------
  let fatorPendente = null;

  async function concluirAcesso() {
    if (!MODO_ONLINE) return mostrarApp(await db.sessao());
    const nivel = await db.nivelMfa();
    if (nivel.atual === 'aal2') return aposSegundaEtapa();
    if (nivel.proximo === 'aal2') {           // já tem autenticador: pede o código
      fatorPendente = (await db.fatorMfa())?.id;
      mostrarLogin(null, 'mfa-codigo');
      $('#form-mfa-codigo').elements.codigo.focus();
      return;
    }
    // ainda não tem autenticador: cadastro obrigatório
    const cad = await db.iniciarCadastroMfa();
    fatorPendente = cad.factorId;
    $('#mfa-qr').src = cad.qr.startsWith('data:') ? cad.qr : 'data:image/svg+xml;utf8,' + encodeURIComponent(cad.qr);
    $('#mfa-segredo').textContent = cad.segredo;
    mostrarLogin(null, 'mfa-cadastro');
  }

  for (const id of ['#form-mfa-codigo', '#form-mfa-cadastro']) {
    const form = $(id);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const erro = form.querySelector('.erro');
      const botao = form.querySelector('[type=submit]');
      erro.hidden = true;
      botao.disabled = true;
      try {
        await db.verificarMfa(fatorPendente, form.elements.codigo.value.trim());
        form.reset();
        await aposSegundaEtapa();
      } catch (e) {
        erro.textContent = /invalid|expired|código/i.test(e?.message || '')
          ? 'Código inválido ou expirado. Confira o app autenticador e tente de novo.'
          : msgErro(e);
        erro.hidden = false;
      } finally {
        botao.disabled = false;
      }
    });
    form.querySelector('[data-acao=cancelar-mfa]').addEventListener('click', () => encerrarSessao());
  }

  // ------------------------------------------------------------------
  // Esqueci minha senha / nova senha
  // ------------------------------------------------------------------
  $('#btn-esqueci').addEventListener('click', () => {
    const email = $('#form-login').elements.email.value.trim();
    mostrarLogin(null, 'esqueci');
    if (email) $('#form-esqueci').elements.email.value = email;
  });
  $('#form-esqueci [data-acao=voltar-login]').addEventListener('click', () => mostrarLogin());

  $('#form-esqueci').addEventListener('submit', async ev => {
    ev.preventDefault();
    const form = ev.target;
    const erro = form.querySelector('.erro');
    const sucesso = form.querySelector('.sucesso');
    const botao = form.querySelector('[type=submit]');
    erro.hidden = sucesso.hidden = true;
    botao.disabled = true;
    try {
      await db.enviarLinkRecuperacao(form.elements.email.value.trim());
      // mesma mensagem exista ou não a conta: não revela quais e-mails estão cadastrados
      sucesso.textContent = 'Se este e-mail estiver cadastrado, você receberá em instantes um link para criar uma nova senha. Confira também a caixa de spam.';
      sucesso.hidden = false;
    } catch (e) {
      erro.textContent = msgErro(e);
      erro.hidden = false;
    } finally {
      botao.disabled = false;
    }
  });

  $('#form-nova-senha').addEventListener('submit', async ev => {
    ev.preventDefault();
    const form = ev.target;
    const erro = form.querySelector('.erro');
    const botao = form.querySelector('[type=submit]');
    const problema = problemaSenha(form.elements.senha.value, form.elements.confirmacao.value);
    erro.hidden = true;
    if (problema) { erro.textContent = problema; erro.hidden = false; return; }
    botao.disabled = true;
    try {
      await db.alterarSenha(form.elements.senha.value);
      db.concluiuRecuperacaoDeSenha();
      form.reset();
      history.replaceState(null, '', location.pathname); // remove o token do endereço
      await mostrarApp(await db.sessao());
      toast('Senha alterada com sucesso.');
    } catch (e) {
      erro.textContent = msgErro(e);
      erro.hidden = false;
    } finally {
      botao.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Minha conta: nome de exibição, senha e (admin) setores
  // ------------------------------------------------------------------
  const dlgConta = $('#dlg-conta');
  const ehAdmin = () => estado.usuario?.papel === 'admin';

  function abrirConta() {
    const u = estado.usuario || {};
    $('#conta-email').textContent = `${u.email || ''}${ehAdmin() ? ' · administrador' : ''}`;
    $('#form-nome').elements.nome.value = u.nome || '';
    $('#form-alterar-senha').reset();
    $('#form-alterar-senha').hidden = !MODO_ONLINE;
    $('#sec-setores').hidden = !ehAdmin();
    if (ehAdmin()) renderSetoresAdmin();
    dlgConta.querySelectorAll('.erro').forEach(e => { e.hidden = true; });
    dlgConta.showModal();
  }
  $('#btn-conta-fechar').addEventListener('click', () => dlgConta.close());

  $('#form-nome').addEventListener('submit', async ev => {
    ev.preventDefault();
    const form = ev.target;
    const erro = form.querySelector('.erro');
    const nome = form.elements.nome.value.trim();
    erro.hidden = true;
    try {
      await db.definirNome(nome);
      estado.usuario.nome = nome;
      renderUsuario();
      toast(nome ? 'Nome atualizado. Vale para os próximos registros.' : 'Nome removido; será usado o e-mail.');
    } catch (e) {
      erro.textContent = 'Erro ao salvar o nome: ' + msgErro(e);
      erro.hidden = false;
    }
  });

  $('#form-alterar-senha').addEventListener('submit', async ev => {
    ev.preventDefault();
    const form = ev.target;
    const erro = form.querySelector('.erro');
    const botao = form.querySelector('[type=submit]');
    const problema = problemaSenha(form.elements.senha.value, form.elements.confirmacao.value);
    erro.hidden = true;
    if (problema) { erro.textContent = problema; erro.hidden = false; return; }
    botao.disabled = true;
    try {
      await db.alterarSenha(form.elements.senha.value);
      form.reset();
      dlgConta.close();
      toast('Senha alterada com sucesso.');
    } catch (e) {
      erro.textContent = msgErro(e);
      erro.hidden = false;
    } finally {
      botao.disabled = false;
    }
  });

  // --- Setores ---
  async function carregarSetores() {
    try {
      estado.setores = await db.listarSetores();
    } catch (e) {
      console.warn('Setores indisponíveis:', e);
      estado.setores = SETORES_PADRAO.map(nome => ({ nome, ativo: true }));
    }
    preencherFiltroSetor();
  }

  const setoresAtivos = () => estado.setores.filter(s => s.ativo);

  // opções de setor (inclui o valor atual mesmo se o setor foi desativado)
  function opcoesSetor(selecionado, rotuloVazio = '— não informado —') {
    const nomes = setoresAtivos().map(s => s.nome);
    if (selecionado && !nomes.includes(selecionado)) nomes.push(selecionado);
    return `<option value="">${rotuloVazio}</option>` +
      nomes.map(n => `<option value="${esc(n)}" ${n === selecionado ? 'selected' : ''}>${esc(n)}</option>`).join('');
  }

  function preencherFiltroSetor() {
    const sel = $('#filtro-setor');
    const atual = estado.filtroSetor;
    sel.innerHTML = opcoesSetor(atual, 'Todos os setores');
  }

  function renderSetoresAdmin() {
    $('#setores-lista').innerHTML = estado.setores.map(s => `
      <li data-id="${esc(s.id)}" class="${s.ativo ? '' : 'inativo'}">
        <input value="${esc(s.nome)}" maxlength="60" aria-label="Nome do setor">
        <label class="chk"><input type="checkbox" ${s.ativo ? 'checked' : ''}> ativo</label>
        <button type="button" class="btn btn-ghost btn-sm" data-acao="salvar-setor">Salvar</button>
      </li>`).join('');
  }

  $('#setores-lista').addEventListener('click', async ev => {
    const b = ev.target.closest('[data-acao=salvar-setor]');
    if (!b) return;
    const li = b.closest('li');
    const s = estado.setores.find(x => String(x.id) === li.dataset.id);
    const erro = $('#setores-erro');
    erro.hidden = true;
    try {
      await db.salvarSetor({ ...s, nome: li.querySelector('input:not([type=checkbox])').value.trim(), ativo: li.querySelector('[type=checkbox]').checked });
      await carregarSetores();
      renderSetoresAdmin();
      toast('Setor atualizado.');
    } catch (e) { erro.textContent = msgErro(e); erro.hidden = false; }
  });

  $('#form-setor-novo').addEventListener('submit', async ev => {
    ev.preventDefault();
    const erro = $('#setores-erro');
    erro.hidden = true;
    const nome = ev.target.elements.nome.value.trim();
    try {
      const ordem = Math.max(0, ...estado.setores.map(s => s.ordem || 0)) + 10;
      await db.salvarSetor({ nome, ordem });
      ev.target.reset();
      await carregarSetores();
      renderSetoresAdmin();
      toast('Setor adicionado.');
    } catch (e) { erro.textContent = msgErro(e); erro.hidden = false; }
  });

  // ------------------------------------------------------------------
  // Sessão: saída automática por inatividade (vale para todas as abas)
  // ------------------------------------------------------------------
  const INATIVIDADE_MIN = cfg.INATIVIDADE_MIN || 15;
  const LIMITE_INATIVIDADE_MS = INATIVIDADE_MIN * 60 * 1000;
  const AVISO_INATIVIDADE_MS = 60 * 1000;
  const CHAVE_ATIVIDADE = 'controle-pacientes-ultima-atividade';
  let ultimaAtividadeLocal = Date.now();
  let vigiaInatividade = null;

  function registrarAtividade(forcar) {
    const agora = Date.now();
    if (!forcar && agora - ultimaAtividadeLocal < 5000) return; // no máximo a cada 5 s
    ultimaAtividadeLocal = agora;
    try { localStorage.setItem(CHAVE_ATIVIDADE, String(agora)); } catch { /* sem storage */ }
  }
  function ultimaAtividade() {
    let compartilhada = 0;
    try { compartilhada = Number(localStorage.getItem(CHAVE_ATIVIDADE)) || 0; } catch { /* sem storage */ }
    return Math.max(compartilhada, ultimaAtividadeLocal);
  }
  const sessaoExpiradaPorInatividade = () => {
    let salvo = 0;
    try { salvo = Number(localStorage.getItem(CHAVE_ATIVIDADE)) || 0; } catch { /* sem storage */ }
    return salvo > 0 && Date.now() - salvo >= LIMITE_INATIVIDADE_MS;
  };

  function iniciarVigiaInatividade() {
    if (!MODO_ONLINE) return;
    registrarAtividade(true);
    clearInterval(vigiaInatividade);
    vigiaInatividade = setInterval(() => {
      const restante = LIMITE_INATIVIDADE_MS - (Date.now() - ultimaAtividade());
      const aviso = $('#aviso-inatividade');
      if (restante <= 0) {
        encerrarSessao(`Sua sessão foi encerrada após ${INATIVIDADE_MIN} minutos sem uso. Entre novamente.`);
      } else if (restante <= AVISO_INATIVIDADE_MS) {
        $('#inatividade-segundos').textContent = Math.ceil(restante / 1000);
        aviso.hidden = false;
      } else {
        aviso.hidden = true;
      }
    }, 1000);
  }
  function pararVigiaInatividade() {
    clearInterval(vigiaInatividade);
    vigiaInatividade = null;
    $('#aviso-inatividade').hidden = true;
  }
  for (const tipo of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(tipo, () => { if (vigiaInatividade) registrarAtividade(); }, { passive: true, capture: true });
  }
  $('#btn-continuar-conectado').addEventListener('click', () => {
    registrarAtividade(true);
    $('#aviso-inatividade').hidden = true;
  });

  // Encerra a sessão e apaga da tela todos os dados de pacientes
  let encerrando = false;
  async function encerrarSessao(mensagem) {
    if (encerrando) return;
    encerrando = true;
    pararVigiaInatividade();
    try { await db.sair(); } catch { /* segue limpando a tela */ }
    estado.pacientes = [];
    estado.selecionado = null;
    estado.internacaoSel = null;
    estado.usuario = null;
    $('#lista').innerHTML = '';
    elDetalhe.innerHTML = '';
    $('#impressao').innerHTML = '';
    $('#preview-folha').innerHTML = '';
    document.querySelectorAll('dialog[open]').forEach(d => d.close());
    document.body.classList.remove('ver-detalhe');
    history.replaceState(null, '', location.pathname + location.search);
    mostrarLogin(mensagem);
    encerrando = false;
  }

  // ------------------------------------------------------------------
  // Lista de pacientes
  // ------------------------------------------------------------------
  async function carregarPacientes() {
    try {
      estado.pacientes = await db.listarPacientes();
    } catch (e) {
      toast('Erro ao carregar pacientes: ' + msgErro(e));
      estado.pacientes = [];
    }
    renderLista();
  }

  function renderLista() {
    const termo = normalizar(estado.busca);
    const { filtro: f, filtroSetor: setor, baixa: b } = estado;
    const todos = estado.pacientes.map(p => { const v = visao(p); return { p, v, r: resumo(v) }; });
    const itens = todos
      .filter(({ v }) => b === 'todos' || (b === 'com' ? !!v.data_baixa : !v.data_baixa))
      .filter(({ v }) => !setor || (!v.data_baixa && v.setor_atual === setor))
      .filter(({ v, r }) => !termo || normalizar(v.nome).includes(termo) || normalizar(v.documento).includes(termo)
        || r.cids.some(c => c.toLowerCase().replace('.', '').startsWith(termo.replace('.', ''))))
      .filter(({ v, r }) => {
        if (!f) return true;
        if (f === 'sem') return !r.status;
        if (f === 'atrasada') return atrasoAlta(v) > 0;
        return r.status === f;
      });

    const total = todos.length;
    const internados = todos.filter(({ v }) => !v.data_baixa).length;
    const atrasados = todos.filter(({ v }) => atrasoAlta(v) > 0).length;
    $('#contagem').textContent = `Mostrando ${itens.length} · ${internados} internado${internados === 1 ? '' : 's'}`
      + `${atrasados ? ` · ${atrasados} passou da previsão de alta` : ''} · ${total} no total`;

    const ul = $('#lista');
    if (!itens.length) {
      ul.innerHTML = `<li class="vazio">${total ? 'Nenhum paciente encontrado com esse filtro.' : 'Nenhum paciente cadastrado ainda.<br>Toque em “+ Novo paciente” para começar.'}</li>`;
      return;
    }
    ul.innerHTML = itens.map(({ p, v, r }) => {
      const atraso = atrasoAlta(v);
      const nInt = (p.internacoes || []).length;
      return `
      <li>
        <button type="button" class="item ${p.id === estado.selecionado ? 'ativo' : ''} ${v.data_baixa ? 'baixado' : ''}" data-id="${esc(p.id)}">
          <span class="item-linha"><strong>${esc(v.nome)}</strong>${v.data_baixa ? pillBaixa(v) : pill(r.status)}</span>
          ${!v.data_baixa && (v.setor_atual || v.leito_atual) ? `<span class="item-setor">${esc(textoSetor(v.setor_atual, v.leito_atual))}</span>` : ''}
          <span class="item-meta">Entrada: ${fmtData(v.data_entrada)} · ${v.data_baixa
            ? `${plural(diasEntre(v.data_entrada, v.data_baixa), 'dia', 'dias')} de internação`
            : haQuanto(v.data_entrada)}${nInt > 1 ? ` · ${nInt}ª internação` : ''}</span>
          ${!v.data_baixa && v.previsao_alta ? `<span class="item-meta ${atraso ? 'previsao-atrasada' : ''}">Previsão de alta: ${fmtData(v.previsao_alta)}${atraso ? ` · ${plural(atraso, 'dia', 'dias')} além do previsto` : ''}</span>` : ''}
          ${r.cids.length ? `<span class="item-meta" title="${esc(descCid(r.cids[0]))}">CID: <b>${esc(r.cids[0])}</b>${r.cids.length > 1 ? ` +${r.cids.length - 1}` : ''} ${esc(descCid(r.cids[0]))}</span>` : ''}
          <span class="item-meta">${r.total ? `Última evolução: ${fmtData(r.ultimaData)} · ${plural(r.total, 'registro', 'registros')}` : 'Nenhuma evolução registrada'}</span>
        </button>
      </li>`;
    }).join('');
  }

  function renderPlaceholder() {
    elDetalhe.innerHTML = '<p class="placeholder">Selecione um paciente na lista<br>ou cadastre um novo.</p>';
  }

  // ------------------------------------------------------------------
  // Detalhe: pessoa + internações + evoluções
  // ------------------------------------------------------------------
  async function abrirPaciente(id, internacaoId) {
    estado.selecionado = id;
    document.body.classList.add('ver-detalhe');
    renderLista();
    elDetalhe.innerHTML = '<p class="placeholder">Carregando…</p>';
    try {
      const p = await db.obterPaciente(id);
      if (estado.selecionado !== id) return; // usuário já trocou de paciente
      if (!p) { elDetalhe.innerHTML = '<p class="placeholder">Paciente não encontrado.</p>'; return; }
      const internacoes = ordenarInternacoes(p.internacoes);
      const i = internacoes.find(x => x.id === internacaoId) || internacoes[0];
      if (!i) { elDetalhe.innerHTML = '<p class="placeholder erro">Paciente sem internação registrada.</p>'; return; }
      const evs = await db.listarEvolucoes(i.id);
      if (estado.selecionado !== id) return;
      estado.internacaoSel = i.id;
      renderDetalhe(p, i, evs);
    } catch (e) {
      elDetalhe.innerHTML = `<p class="placeholder erro">Erro ao abrir paciente: ${esc(msgErro(e))}</p>`;
    }
  }

  function fecharDetalhe() {
    estado.selecionado = null;
    estado.internacaoSel = null;
    document.body.classList.remove('ver-detalhe');
    renderLista();
    renderPlaceholder();
  }

  // Mudanças de CID ao longo do tempo (da entrada para a evolução mais recente)
  function mudancasCid(v, evs) {
    const mudancas = new Map();
    let anterior = v.cids_entrada || [];
    for (const e of ordenarEvolucoes(validas(evs)).reverse()) {
      if (!e.cids?.length) continue;
      const add = e.cids.filter(c => !anterior.includes(c));
      const rem = anterior.filter(c => !e.cids.includes(c));
      const novoPrincipal = !add.length && !rem.length && anterior[0] !== e.cids[0] ? e.cids[0] : null;
      if (add.length || rem.length || novoPrincipal) {
        mudancas.set(e.id, { add, rem, novoPrincipal, rotulo: anterior.length ? 'Diagnóstico alterado' : 'CID informado' });
      }
      anterior = e.cids;
    }
    return mudancas;
  }

  // O que mudou em previsão/pendências a cada evolução (mostra só quando muda)
  function mudancasPrevisao(v, evs) {
    const m = new Map();
    let prev = v.previsao_alta_inicial || null;
    let pend = [];
    for (const e of ordenarEvolucoes(validas(evs)).reverse()) {
      const info = {};
      if (e.previsao_alta && e.previsao_alta !== prev) { info.previsao = { de: prev, para: e.previsao_alta }; prev = e.previsao_alta; }
      if (Array.isArray(e.pendencias_alta) && JSON.stringify(e.pendencias_alta) !== JSON.stringify(pend)) {
        info.pendencias = e.pendencias_alta; pend = e.pendencias_alta;
      }
      if (Object.keys(info).length) m.set(e.id, info);
    }
    return m;
  }

  function seloTipo(e) {
    switch (e.tipo) {
      case 'setor': return `<span class="pill t-setor">↪ ${esc(textoSetor(e.setor, e.leito))}</span>`;
      case 'intercorrencia': return `<span class="pill t-intercorrencia">⚠ Intercorrência: ${esc(e.intercorrencia)}</span>`;
      case 'procedimento': return '<span class="pill t-proc">Procedimento / cirurgia</span>';
      case 'alta': return `<span class="pill t-alta">Alta: ${esc(ROTULO_ALTA[e.tipo_alta] || e.tipo_alta)}</span>`;
      default: return '';
    }
  }

  function listaPendencias(lista) {
    return lista?.length
      ? `<ul class="pendencias-lista">${lista.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
      : '<span class="item-meta">Nenhuma</span>';
  }

  function blocoFormEvolucao(v, r) {
    const pendPadrao = v.pendencias_alta.filter(x => PENDENCIAS.includes(x));
    const pendOutras = v.pendencias_alta.filter(x => !PENDENCIAS.includes(x));
    return `
      <form class="card form" id="form-evolucao">
        <h3>Registrar evolução</h3>
        <div class="grid-evo">
          <label>Data <input type="date" name="data" required value="${hoje()}" min="${esc(v.data_entrada)}" max="${hoje()}"></label>
          <label>O que aconteceu
            <select name="tipo">
              ${Object.entries(TIPOS_REGISTRO).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}
            </select>
          </label>
          <label>Situação clínica
            <select name="status">
              <option value="">— não informar —</option>
              ${STATUS.map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </label>

          <div class="span-all cond grid2" data-tipo="setor" hidden>
            <label>Novo setor *
              <select name="setor" class="sel-setor">${opcoesSetor(null, '— selecione —')}</select>
            </label>
            <label>Leito <input name="leito" maxlength="20" placeholder="Ex.: 4B"></label>
            <p class="dica span-all">Setor atual: <b>${esc(textoSetor(v.setor_atual, v.leito_atual) || 'não informado')}</b></p>
          </div>
          <div class="span-all cond" data-tipo="intercorrencia" hidden>
            <label>Tipo de intercorrência *
              <select name="intercorrencia">
                <option value="">— selecione —</option>
                ${INTERCORRENCIAS.map(x => `<option>${esc(x)}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="span-all cond aviso-alta" data-tipo="alta" hidden>
            <label>Tipo de alta / desfecho *
              <select name="tipo_alta">
                <option value="">— selecione —</option>
                ${TIPOS_ALTA.map(([k, t]) => `<option value="${esc(k)}">${esc(t)}</option>`).join('')}
              </select>
            </label>
            <p><b>Ao salvar, a internação será encerrada</b> com a data desta evolução.
              Se for engano, basta anular esta evolução depois: a internação reabre.</p>
          </div>

          <label class="span-all">Como o paciente está / o que aconteceu *
            <textarea name="descricao" rows="4" required placeholder="Ex.: Sinais vitais estáveis, aceitando bem a dieta, iniciou fisioterapia…"></textarea>
          </label>
          <div class="campo span-all">
            <span class="rotulo">CID vigente nesta data (CID-10)</span>
            <div class="cid-picker" id="cid-evolucao"></div>
            <small class="dica">Já vem com o CID atual. Se o diagnóstico mudou, remova (×) e adicione o novo; o histórico registra a alteração.
              Classifique cada CID secundário: <b>comorbidade</b> (doença que o paciente já tinha) ou <b>complicação</b> (surgiu durante a internação).</small>
          </div>
          <div class="campo span-all">
            <span class="rotulo">Procedimentos realizados nesta data <span class="opcional-proc">(opcional)</span></span>
            <div id="proc-evolucao"></div>
            <small class="dica">Código TUSS (convênios) ou SIGTAP (SUS), se souber, e a descrição. Ex.: cirurgias, exames invasivos, hemodiálise, ventilação mecânica.</small>
          </div>

          <fieldset class="span-all previsao-pend" data-nao-alta>
            <legend>Previsão de alta e pendências</legend>
            <div class="grid2">
              <label>Previsão de alta
                <input type="date" name="previsao_alta" value="${esc(v.previsao_alta || '')}" min="${esc(v.data_entrada)}">
              </label>
              <p class="dica">Já vem com a previsão atual. Atualize sempre que mudar: a lista avisa quando a previsão vence.</p>
            </div>
            <span class="rotulo">O que ainda impede a alta?</span>
            <div class="pendencias-opcoes">
              ${PENDENCIAS.map(x => `<label class="chk"><input type="checkbox" name="pendencia" value="${esc(x)}" ${pendPadrao.includes(x) ? 'checked' : ''}> ${esc(x)}</label>`).join('')}
            </div>
            <label>Outra pendência <input name="pendencia_outra" maxlength="120" value="${esc(pendOutras.join('; '))}" placeholder="Descreva, se houver"></label>
          </fieldset>
        </div>
        <p class="erro" id="evo-erro" hidden></p>
        <div class="acoes"><button type="submit" class="btn btn-primary">Salvar evolução</button></div>
      </form>`;
  }

  // mostra os campos do tipo de registro escolhido
  function aplicarTipoRegistro(form) {
    const tipo = form.elements.tipo.value;
    form.querySelectorAll('.cond').forEach(el => { el.hidden = el.dataset.tipo !== tipo; });
    form.querySelector('[data-nao-alta]').hidden = tipo === 'alta';
    form.querySelector('.opcional-proc').textContent = tipo === 'procedimento' ? '(informe ao menos um)' : '(opcional)';
    form.querySelector('[type=submit]').textContent = tipo === 'alta' ? 'Registrar alta e encerrar internação' : 'Salvar evolução';
    form.querySelector('[type=submit]').classList.toggle('btn-perigo', tipo === 'alta');
    if (tipo === 'procedimento' && procedimentosEvolucao && !procedimentosEvolucao.valores().length
        && !form.querySelector('.proc-linha')) procedimentosEvolucao.adicionarLinha();
  }

  function renderDetalhe(p, i, evs) {
    const v = visao(p, { ...i, evolucoes: evs });
    const r = resumo(v);
    const anos = idade(p.data_nascimento);
    const tiposVigentes = tiposAtuais(v, evs);
    const internacoes = ordenarInternacoes(p.internacoes);
    const temAberta = internacoes.some(x => !x.data_baixa);
    const reint = reinternacao(p, i);
    const atraso = atrasoAlta(v);

    const mudancas = mudancasCid(v, evs);
    const mudPrev = mudancasPrevisao(v, evs);
    const blocoMudanca = m => !m ? '' : `
      <div class="cid-mudanca"><strong>${m.rotulo}:</strong>
        ${m.add.map(c => `<span class="cid-add" title="${esc(descCid(c))}">+ ${esc(c)}</span>`).join('')}
        ${m.rem.map(c => `<span class="cid-rem" title="${esc(descCid(c))}">${esc(c)}</span>`).join('')}
        ${m.novoPrincipal ? `<span>principal passou a ser <b>${esc(m.novoPrincipal)}</b></span>` : ''}
      </div>`;
    const blocoPrev = m => !m ? '' : `
      <div class="tl-previsao">
        ${m.previsao ? `<div>Previsão de alta: ${m.previsao.de ? `<s>${fmtData(m.previsao.de)}</s> → ` : ''}<b>${fmtData(m.previsao.para)}</b></div>` : ''}
        ${m.pendencias ? `<div>Pendências: ${m.pendencias.length ? m.pendencias.map(esc).join('; ') : '<b>nenhuma</b>'}</div>` : ''}
      </div>`;
    const diasInternado = diasEntre(v.data_entrada, v.data_baixa || hoje());

    const blocoEvolucao = v.data_baixa ? `
      <div class="aviso-baixa">
        <strong>Internação encerrada: alta em ${fmtData(v.data_baixa)}${v.tipo_alta ? ` (${esc(ROTULO_ALTA[v.tipo_alta] || v.tipo_alta)})` : ''}.</strong><br>
        Alta registrada por engano? Anule a evolução de alta no histórico abaixo: a internação reabre.
        ${!temAberta ? '<br>Se o paciente voltou a internar, abra uma <b>nova internação</b> para manter o histórico separado.' : ''}
      </div>` : blocoFormEvolucao(v, r);

    elDetalhe.innerHTML = `
      <div class="detalhe-topo">
        <button type="button" class="btn btn-ghost btn-sm voltar" data-acao="voltar">← Lista</button>
        <div class="detalhe-botoes">
          <button type="button" class="btn btn-ghost btn-sm" data-acao="imprimir" title="Visualizar e imprimir o relatório desta internação">Imprimir</button>
          <button type="button" class="btn btn-ghost btn-sm" data-acao="editar-pessoa">Editar paciente</button>
        </div>
      </div>

      <div class="card">
        <dl class="info-grid">
          <div class="span-all info-nome">
            <dt>Paciente</dt>
            <dd><h2>${esc(p.nome)}</h2>${pill(r.status)}${v.data_baixa ? pillBaixa(v) : ''}</dd>
          </div>
          <div><dt>Nascimento</dt><dd>${fmtData(p.data_nascimento)}${anos !== null ? ` <span class="item-meta">(${anos} anos)</span>` : ''}</dd></div>
          <div><dt>Sexo</dt><dd>${SEXO[p.sexo] || '—'}</dd></div>
          <div><dt>Telefone</dt><dd>${p.telefone ? `<a href="tel:${esc(p.telefone.replace(/[^\d+]/g, ''))}">${esc(p.telefone)}</a>` : '—'}</dd></div>
          <div><dt>Documento</dt><dd>${esc(p.documento) || '—'}</dd></div>
          ${p.observacoes ? `<div class="span-all"><dt>Observações gerais</dt><dd class="texto">${esc(p.observacoes)}</dd></div>` : ''}
        </dl>
        <div class="autoria">${linhaAutoria('Paciente cadastrado por', p.criado_por_nome, p.criado_por_email, p.criado_em)}</div>
      </div>

      <section class="card internacoes-card">
        <div class="internacoes-topo">
          <h3>Internações (${internacoes.length})</h3>
          ${!temAberta ? '<button type="button" class="btn btn-primary btn-sm" data-acao="nova-internacao">+ Nova internação</button>' : ''}
        </div>
        <div class="internacoes-abas" role="tablist">
          ${internacoes.map(x => `
            <button type="button" role="tab" class="aba-int ${x.id === i.id ? 'ativa' : ''}" data-acao="ver-internacao" data-id="${esc(x.id)}" aria-selected="${x.id === i.id}">
              <b>${x.data_baixa ? `${fmtData(x.data_entrada)} – ${fmtData(x.data_baixa)}` : `Atual · desde ${fmtData(x.data_entrada)}`}</b>
              <span>${x.data_baixa ? esc(ROTULO_ALTA[x.tipo_alta] || x.tipo_alta || 'Alta') : esc(textoSetor(x.setor_atual, x.leito_atual) || 'Em andamento')}</span>
            </button>`).join('')}
        </div>
      </section>

      <div class="card">
        <div class="internacao-cabecalho">
          <h3>Internação de ${fmtData(v.data_entrada)} ${v.data_baixa ? '<span class="pill s-baixa">Encerrada</span>' : '<span class="pill s-melhorando">Em andamento</span>'}</h3>
          <button type="button" class="btn btn-ghost btn-sm" data-acao="editar-internacao">Editar internação</button>
        </div>
        ${reint ? `<p class="aviso-reinternacao">Reinternação: entrada ${plural(reint.dias, 'dia', 'dias')} após a alta de ${fmtData(reint.anterior.data_baixa)} (internação anterior).</p>` : ''}
        <dl class="info-grid">
          <div><dt>Entrada</dt><dd>${fmtData(v.data_entrada)} <span class="item-meta">(${diasInternado >= 0 ? `${plural(diasInternado, 'dia', 'dias')}${v.data_baixa ? ' de internação' : ''}` : 'data futura'})</span></dd></div>
          <div><dt>${v.data_baixa ? 'Último setor' : 'Setor / leito atual'}</dt><dd>${esc(textoSetor(v.setor_atual, v.leito_atual)) || '—'}</dd></div>
          ${v.data_baixa
            ? `<div><dt>Alta</dt><dd>${fmtData(v.data_baixa)} · <b>${esc(ROTULO_ALTA[v.tipo_alta] || v.tipo_alta || '')}</b></dd></div>`
            : `<div><dt>Previsão de alta</dt><dd class="${atraso ? 'previsao-atrasada' : ''}">${v.previsao_alta ? fmtData(v.previsao_alta) : 'Não informada'}${atraso ? ` · <b>${plural(atraso, 'dia', 'dias')} além do previsto</b>` : ''}</dd></div>`}
          ${!v.data_baixa ? `<div class="span-all"><dt>Pendências para a alta</dt><dd>${listaPendencias(v.pendencias_alta)}</dd></div>` : ''}
          <div class="span-all"><dt>CID atual</dt><dd>${cidLista(r.cids, tiposVigentes)}</dd></div>
          <div class="span-all"><dt>Motivo da entrada</dt><dd class="texto">${esc(v.motivo)}</dd></div>
          <div class="span-all"><dt>CID de entrada</dt><dd>${cidLista(v.cids_entrada, tiposEntrada(v))}</dd></div>
        </dl>
        <div class="autoria">
          ${linhaAutoria('Internação aberta por', i.criado_por_nome, i.criado_por_email, i.criado_em)}
          ${i.atualizado_em ? `<br>${linhaAutoria('Última atualização por', i.atualizado_por_nome, i.atualizado_por_email, i.atualizado_em)}` : ''}
        </div>
      </div>

      ${blocoEvolucao}

      <section class="card">
        <h3>Histórico da internação (${validas(evs).length}${evs.length > validas(evs).length ? ` + ${evs.length - validas(evs).length} anulada${evs.length - validas(evs).length === 1 ? '' : 's'}` : ''})</h3>
        <ol class="timeline">
          ${evs.map(e => `
            <li class="${e.anulada_em ? 'anulada' : ''} ${e.tipo && e.tipo !== 'rotina' ? 'tl-' + esc(e.tipo) : ''}">
              <div class="tl-topo">
                <strong>${fmtData(e.data)}</strong>
                ${e.anulada_em ? '<span class="pill s-anulada">Anulada</span>' : ''}
                ${seloTipo(e)}
                ${!e.anulada_em && e.status ? pill(e.status) : ''}
                <span class="item-meta">${haQuanto(e.data)}</span>
                ${podeAnular(e) ? `<button type="button" class="link-excluir" data-acao="anular-evo" data-id="${esc(e.id)}" data-data="${esc(e.data)}">Anular</button>` : ''}
              </div>
              <div class="tl-autor">${linhaAutoria('Registrado por', e.criado_por_nome, e.criado_por_email, e.criado_em)}</div>
              ${e.anulada_em ? `
                <div class="aviso-anulacao">
                  ${linhaAutoria('Anulada por', e.anulada_por_nome, e.anulada_por_email, e.anulada_em)}
                  <br>Justificativa: <span class="texto">${esc(e.motivo_anulacao)}</span>
                </div>` : ''}
              <p class="texto">${esc(e.descricao)}</p>
              ${e.cids?.length ? `<div class="tl-cids">${cidLista(e.cids, e.cids_tipos)}</div>` : ''}
              ${blocoMudanca(mudancas.get(e.id))}
              ${e.procedimentos?.length ? `
                <div class="tl-proc"><strong>Procedimentos:</strong>
                  <ul>${e.procedimentos.map(pr => `<li>${pr.codigo ? `<b>${esc(pr.codigo)}</b> ` : ''}${esc(pr.descricao)}</li>`).join('')}</ul>
                </div>` : ''}
              ${blocoPrev(mudPrev.get(e.id))}
            </li>`).join('')}
          <li class="tl-entrada">
            <div class="tl-topo"><strong>${fmtData(v.data_entrada)}</strong><span class="pill s-nenhum">Entrada</span>
              ${v.setor_entrada || v.leito_entrada ? `<span class="pill t-setor">${esc(textoSetor(v.setor_entrada, v.leito_entrada))}</span>` : ''}</div>
            <div class="tl-autor">${linhaAutoria('Internação aberta por', i.criado_por_nome, i.criado_por_email, i.criado_em)}</div>
            <p class="texto">${esc(v.motivo)}</p>
            ${v.cids_entrada?.length ? `<div class="tl-cids">${cidLista(v.cids_entrada, tiposEntrada(v))}</div>` : ''}
            ${v.previsao_alta_inicial ? `<div class="tl-previsao">Previsão de alta na entrada: <b>${fmtData(v.previsao_alta_inicial)}</b></div>` : ''}
          </li>
        </ol>
      </section>

      <section class="card">
        <details id="historico-alteracoes">
          <summary><h3>Histórico de alterações (auditoria)</h3></summary>
          <div class="auditoria-lista"><p class="item-meta">Carregando…</p></div>
        </details>
      </section>`;

    const raizCidEvo = $('#cid-evolucao', elDetalhe);
    seletorEvolucao = raizCidEvo
      ? montarSeletorCid(raizCidEvo, r.cids, { classificar: true, tiposIniciais: tiposVigentes })
      : null;
    const raizProc = $('#proc-evolucao', elDetalhe);
    procedimentosEvolucao = raizProc ? montarProcedimentos(raizProc) : null;
    const formEvo = $('#form-evolucao', elDetalhe);
    if (formEvo) {
      formEvo.elements.tipo.addEventListener('change', () => aplicarTipoRegistro(formEvo));
      aplicarTipoRegistro(formEvo);
    }

    // trilha de auditoria: carrega só quando a seção é aberta
    const det = $('#historico-alteracoes', elDetalhe);
    det.addEventListener('toggle', () => {
      if (det.open) carregarAuditoria(p.id, evs, internacoes, det.querySelector('.auditoria-lista'));
    });

    elDetalhe._pessoa = p;
    elDetalhe._internacao = i;
    elDetalhe._paciente = v; // visão pessoa + internação (relatório, anulação)
    elDetalhe._evolucoes = evs;
    elDetalhe.scrollTop = 0;
    if (window.matchMedia('(max-width: 799px)').matches) window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------
  // Histórico de alterações (tabela "auditoria", gravada pelo banco)
  // ------------------------------------------------------------------
  const ROTULO_CAMPO = {
    nome: 'Nome', data_nascimento: 'Nascimento', sexo: 'Sexo', telefone: 'Telefone', documento: 'Documento',
    data_entrada: 'Data de entrada', motivo: 'Motivo da entrada', observacoes: 'Observações',
    cids_entrada: 'CID de entrada', data_baixa: 'Data da alta', tipo_alta: 'Tipo de alta',
    setor_entrada: 'Setor de entrada', leito_entrada: 'Leito de entrada', previsao_alta_inicial: 'Previsão de alta (entrada)',
    data: 'Data', status: 'Situação', descricao: 'Evolução', cids: 'CIDs', cids_tipos: 'Classificação dos CIDs',
    procedimentos: 'Procedimentos', anulada_em: 'Anulada em', motivo_anulacao: 'Justificativa da anulação',
    tipo: 'Tipo de registro', setor: 'Setor', leito: 'Leito', intercorrencia: 'Intercorrência',
    previsao_alta: 'Previsão de alta', pendencias_alta: 'Pendências para a alta'
  };

  function fmtValorAuditoria(campo, v) {
    if (v === null || v === undefined || v === '') return '(vazio)';
    if (Array.isArray(v)) {
      if (!v.length) return '(vazio)';
      return typeof v[0] === 'object' ? v.map(textoProcedimento).join('; ') : v.join(', ');
    }
    if (typeof v === 'object') {
      const pares = Object.entries(v).map(([c, t]) => `${c}: ${ROTULO_TIPO[t] || t}`);
      return pares.length ? pares.join(', ') : '(vazio)';
    }
    if (campo === 'sexo') return SEXO[v] || v;
    if (campo === 'tipo') return TIPOS_REGISTRO[v] || v;
    if (campo === 'tipo_alta') return ROTULO_ALTA[v] || v;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtData(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return fmtDataHora(v);
    const t = String(v);
    return t.length > 300 ? t.slice(0, 299) + '…' : t;
  }

  function descricaoAcao(a, evsPorId, intPorId) {
    if (a.tabela === 'pacientes') return a.acao === 'cadastro' ? 'Cadastrou o paciente' : 'Alterou os dados do paciente';
    if (a.tabela === 'internacoes') {
      const i = intPorId.get(a.registro_id);
      const de = i ? ` de ${fmtData(i.data_entrada)}` : '';
      return a.acao === 'cadastro' ? `Abriu a internação${de}` : `Alterou os dados da internação${de}`;
    }
    const ev = evsPorId.get(a.registro_id);
    const de = ev ? ` de ${fmtData(ev.data)}` : '';
    const oQue = ev && ev.tipo === 'alta' ? 'a alta' : 'a evolução';
    return { cadastro: `Registrou ${oQue}`, anulacao: `Anulou ${oQue}`, alteracao: `Alterou ${oQue}` }[a.acao] + de;
  }

  async function carregarAuditoria(pid, evs, internacoes, alvo) {
    try {
      const lista = await db.listarAuditoria(pid);
      const porId = new Map(evs.map(e => [e.id, e]));
      const intPorId = new Map((internacoes || []).map(i => [i.id, i]));
      alvo.innerHTML = !lista.length
        ? '<p class="item-meta">Nenhum registro na trilha de auditoria.</p>'
        : `<ol class="auditoria">${lista.map(a => `
            <li class="aud-${esc(a.acao)}">
              <div class="aud-topo">
                <b>${esc(descricaoAcao(a, porId, intPorId))}</b>
                <span class="item-meta">${fmtDataHora(a.ocorrido_em)} · ${esc(autor(a.usuario_nome, a.usuario_email))}</span>
              </div>
              ${Object.keys(a.alteracoes || {}).length ? `
                <ul class="aud-campos">${Object.entries(a.alteracoes).map(([campo, m]) => `
                  <li><span>${esc(ROTULO_CAMPO[campo] || campo)}:</span>
                    ${'de' in m ? `<s>${esc(fmtValorAuditoria(campo, m.de))}</s> → ` : ''}<b>${esc(fmtValorAuditoria(campo, m.para))}</b></li>`).join('')}
                </ul>` : ''}
            </li>`).join('')}</ol>`;
    } catch (e) {
      alvo.innerHTML = `<p class="erro">Erro ao carregar o histórico: ${esc(msgErro(e))}</p>`;
    }
  }

  // Navegação pelo endereço (#p/<paciente>[/i/<internação>]) — faz o "voltar" do celular funcionar
  function rotear() {
    const m = location.hash.match(/^#p\/([^/]+)(?:\/i\/([^/]+))?$/);
    if (m) abrirPaciente(decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : null);
    else fecharDetalhe();
  }
  const irPara = (id, internacaoId) => {
    location.hash = id ? 'p/' + encodeURIComponent(id) + (internacaoId ? '/i/' + encodeURIComponent(internacaoId) : '') : '';
  };

  // ------------------------------------------------------------------
  // Cadastro / edição: pessoa e internação
  //   modos: 'novo' (pessoa + 1ª internação) | 'pessoa' | 'internacao' | 'nova-internacao'
  // ------------------------------------------------------------------
  const dlg = $('#dlg-paciente');
  const formPac = $('#form-paciente');
  const secPessoa = $('#sec-pessoa');
  const secInternacao = $('#sec-internacao');
  const seletorEntrada = montarSeletorCid($('#cid-entrada'));
  let modoDialogo = null;
  let alvoDialogo = { pessoa: null, internacao: null };

  const CAMPOS_PESSOA = ['nome', 'data_nascimento', 'sexo', 'telefone', 'documento', 'observacoes'];
  const CAMPOS_INTERNACAO = ['data_entrada', 'previsao_alta_inicial', 'setor_entrada', 'leito_entrada', 'motivo'];
  const TITULOS = {
    'novo': 'Novo paciente', 'pessoa': 'Editar dados do paciente',
    'internacao': 'Editar dados da internação', 'nova-internacao': 'Nova internação'
  };

  function abrirDialogo(modo, pessoa = null, internacao = null) {
    modoDialogo = modo;
    alvoDialogo = { pessoa, internacao };
    $('#dlg-titulo').textContent = TITULOS[modo] + (modo === 'nova-internacao' && pessoa ? ` · ${pessoa.nome}` : '');
    formPac.reset();
    $('#dlg-erro').hidden = true;
    const comPessoa = modo === 'novo' || modo === 'pessoa';
    const comInternacao = modo !== 'pessoa';
    // seção oculta fica desabilitada: não valida nem entra no formulário
    secPessoa.hidden = secPessoa.disabled = !comPessoa;
    secInternacao.hidden = secInternacao.disabled = !comInternacao;

    const dadosPessoa = pessoa || {};
    const dadosInt = internacao || { data_entrada: hoje() };
    formPac.querySelectorAll('.sel-setor').forEach(sel => { sel.innerHTML = opcoesSetor(dadosInt.setor_entrada); });
    for (const c of CAMPOS_PESSOA) formPac.elements[c].value = dadosPessoa[c] || '';
    for (const c of CAMPOS_INTERNACAO) formPac.elements[c].value = dadosInt[c] || '';
    seletorEntrada.definir(dadosInt.cids_entrada);
    dlg.showModal();
    (comPessoa ? formPac.elements.nome : formPac.elements.data_entrada).focus();
  }

  const coletar = (fd, campos) => Object.fromEntries(campos.map(c => [c, vazioParaNull(fd.get(c) ?? '')]));

  formPac.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(formPac);
    const pessoa = coletar(fd, CAMPOS_PESSOA);
    const internacao = { ...coletar(fd, CAMPOS_INTERNACAO), cids_entrada: seletorEntrada.valores() };
    const erroEl = $('#dlg-erro');
    if (modoDialogo !== 'pessoa' && internacao.previsao_alta_inicial && internacao.previsao_alta_inicial < internacao.data_entrada) {
      erroEl.textContent = 'A previsão de alta não pode ser anterior à data de entrada.';
      erroEl.hidden = false;
      return;
    }
    if (modoDialogo === 'internacao') {
      const primeira = ordenarEvolucoes(elDetalhe._evolucoes).at(-1);
      if (primeira && internacao.data_entrada > primeira.data) {
        erroEl.textContent = `A entrada não pode ser depois da primeira evolução (${fmtData(primeira.data)}).`;
        erroEl.hidden = false;
        return;
      }
    }
    const botao = formPac.querySelector('[type=submit]');
    botao.disabled = true;
    try {
      const { pessoa: p, internacao: i } = alvoDialogo;
      if (modoDialogo === 'novo') {
        const id = await db.cadastrarPaciente(pessoa, internacao);
        dlg.close();
        toast('Paciente cadastrado e internação aberta.');
        await carregarPacientes();
        irPara(id);
      } else if (modoDialogo === 'pessoa') {
        await db.atualizarPaciente(p.id, pessoa);
        dlg.close();
        toast('Dados do paciente atualizados.');
        await carregarPacientes();
        abrirPaciente(p.id, estado.internacaoSel);
      } else if (modoDialogo === 'internacao') {
        await db.atualizarInternacao(i.id, internacao);
        dlg.close();
        toast('Dados da internação atualizados.');
        await carregarPacientes();
        abrirPaciente(p.id, i.id);
      } else if (modoDialogo === 'nova-internacao') {
        const nova = await db.criarInternacao({ ...internacao, paciente_id: p.id });
        dlg.close();
        toast('Nova internação aberta.');
        await carregarPacientes();
        irPara(p.id, nova.id);
      }
    } catch (e) {
      erroEl.textContent = 'Não foi possível salvar: ' + msgErro(e);
      erroEl.hidden = false;
    } finally {
      botao.disabled = false;
    }
  });

  $('#btn-cancelar').addEventListener('click', () => dlg.close());
  $('#btn-novo').addEventListener('click', () => abrirDialogo('novo'));

  // ------------------------------------------------------------------
  // Eventos da lista e do detalhe
  // ------------------------------------------------------------------
  $('#lista').addEventListener('click', ev => {
    const item = ev.target.closest('.item');
    if (item) irPara(item.dataset.id);
  });
  $('#busca').addEventListener('input', ev => { estado.busca = ev.target.value; renderLista(); });
  $('#filtro-status').addEventListener('change', ev => { estado.filtro = ev.target.value; renderLista(); });
  $('#filtro-setor').addEventListener('change', ev => { estado.filtroSetor = ev.target.value; renderLista(); });
  document.querySelectorAll('input[name=filtro-baixa]').forEach(r =>
    r.addEventListener('change', ev => { estado.baixa = ev.target.value; renderLista(); }));

  // ------------------------------------------------------------------
  // Relatórios: lista de internados (A4 paisagem) e
  // relatório individual da internação (A4 retrato)
  // ------------------------------------------------------------------
  const emitidoEm = () =>
    `${fmtData(hoje())} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  const corta = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

  function htmlRelatorioLista() {
    const linhas = estado.pacientes
      .map(p => { const v = visao(p); return { v, r: resumo(v) }; })
      .filter(({ v }) => !v.data_baixa)
      .sort((a, b) => a.v.nome.localeCompare(b.v.nome, 'pt-BR'));

    const porStatus = {};
    for (const { r } of linhas) { const s = r.status || 'Sem evolução'; porStatus[s] = (porStatus[s] || 0) + 1; }
    const resumoTxt = Object.entries(porStatus).map(([s, n]) => `${s}: ${n}`).join(' · ');
    const atrasados = linhas.filter(({ v }) => atrasoAlta(v) > 0).length;

    const html = `
      <div class="rel-cabecalho">
        <h1>Pacientes internados (sem alta)</h1>
        <p>Emitido em ${emitidoEm()}<br>Total: ${plural(linhas.length, 'paciente', 'pacientes')}</p>
      </div>
      ${linhas.length ? `
      <p class="rel-resumo"><strong>Por situação:</strong> ${esc(resumoTxt)}${atrasados ? ` · <strong>Passaram da previsão de alta:</strong> ${atrasados}` : ''}</p>
      <table class="rel-tabela">
        <thead>
          <tr>
            <th>#</th><th>Paciente</th><th>Setor / leito</th><th>Entrada</th><th>Dias</th><th>Previsão de alta</th>
            <th>Motivo da entrada</th><th>CID atual</th><th>Situação</th><th>Última evolução</th>
          </tr>
        </thead>
        <tbody>
          ${linhas.map(({ v, r }, n) => {
            const atraso = atrasoAlta(v);
            return `
            <tr>
              <td class="num">${n + 1}</td>
              <td>${esc(v.nome)}${v.documento ? `<div class="sub">${esc(v.documento)}</div>` : ''}</td>
              <td>${esc(textoSetor(v.setor_atual, v.leito_atual)) || '—'}</td>
              <td class="nowrap">${fmtData(v.data_entrada)}</td>
              <td class="num">${Math.max(0, diasEntre(v.data_entrada))}</td>
              <td class="nowrap">${v.previsao_alta ? fmtData(v.previsao_alta) : '—'}${atraso ? `<div class="sub"><b>+${atraso} d</b></div>` : ''}
                ${v.pendencias_alta?.length ? `<div class="sub">${esc(corta(v.pendencias_alta.join('; '), 80))}</div>` : ''}</td>
              <td>${esc(corta(v.motivo, 120))}</td>
              <td class="cid">${r.cids.length
                ? `<b>${esc(r.cids[0])}</b> ${esc(corta(descCid(r.cids[0]), 60))}${r.cids.length > 1 ? `<div class="sub">+ ${esc(r.cids.slice(1).join(', '))}</div>` : ''}`
                : '—'}</td>
              <td class="status">${esc(r.status || 'Sem evolução')}</td>
              <td>${r.ultima
                ? `<span class="nowrap"><strong>${fmtData(r.ultima.data)}</strong></span> ${esc(corta(r.ultima.descricao, 160))}`
                : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<p>Não há pacientes internados no momento.</p>'}
      <p class="rel-rodape">Controle de Pacientes</p>`;
    return { html, total: linhas.length };
  }

  function htmlRelatorioPaciente(v, evs, pessoa) {
    const p = pessoa || v;
    const r = resumo({ ...v, evolucoes: evs });
    const asc = ordenarEvolucoes(evs).reverse(); // ordem cronológica
    const mudancas = mudancasCid(v, evs);
    const anos = idade(p.data_nascimento);
    const dias = diasEntre(v.data_entrada, v.data_baixa || hoje());
    const tiposVig = tiposAtuais(v, evs);
    const drg = consolidadoDrg(v, evs);
    const anosNaEntrada = idade(p.data_nascimento, v.data_entrada);
    const internacoes = ordenarInternacoes(p.internacoes);
    const reint = pessoa ? reinternacao(p, v.internacao) : null;
    const atraso = atrasoAlta(v);
    const listaCids = (cids, tipos = {}) => cids?.length
      ? cids.map((c, i) => `<div><b>${esc(c)}</b> ${esc(descCid(c))}${
          i === 0 ? (cids.length > 1 ? ' <i>(principal)</i>' : '') : tipos[c] ? ` <i>(${ROTULO_TIPO[tipos[c]].toLowerCase()})</i>` : ''}</div>`).join('')
      : '—';
    const listaSimples = cods => cods.length
      ? cods.map(c => `<div><b>${esc(c)}</b> ${esc(descCid(c))}</div>`).join('')
      : 'Nenhuma';

    return `
      <div class="rel-cabecalho">
        <h1>Relatório do paciente</h1>
        <p>Emitido em ${emitidoEm()}<br>Internação de ${fmtData(v.data_entrada)} · ${v.data_baixa ? `alta em ${fmtData(v.data_baixa)}` : 'em andamento'}</p>
      </div>

      <table class="rel-ficha">
        <tr><th>Paciente</th><td colspan="3"><b>${esc(p.nome)}</b></td></tr>
        <tr>
          <th>Documento</th><td>${esc(p.documento) || '—'}</td>
          <th>Nascimento</th><td>${fmtData(p.data_nascimento)}${anos !== null ? ` (${anos} anos)` : ''}</td>
        </tr>
        <tr>
          <th>Telefone</th><td>${esc(p.telefone) || '—'}</td>
          <th>Sexo</th><td>${SEXO[p.sexo] || '—'}</td>
        </tr>
        ${p.observacoes ? `<tr><th>Observações gerais</th><td colspan="3" class="texto">${esc(p.observacoes)}</td></tr>` : ''}
      </table>

      <h2 class="rel-secao">Internação</h2>
      <table class="rel-ficha">
        <tr>
          <th>Entrada</th><td>${fmtData(v.data_entrada)}${v.setor_entrada ? `<div class="sub">${esc(textoSetor(v.setor_entrada, v.leito_entrada))}</div>` : ''}</td>
          <th>${v.data_baixa ? 'Alta' : 'Previsão de alta'}</th>
          <td>${v.data_baixa
            ? `${fmtData(v.data_baixa)} · <b>${esc(ROTULO_ALTA[v.tipo_alta] || v.tipo_alta || '')}</b>`
            : `${v.previsao_alta ? fmtData(v.previsao_alta) : 'Não informada'}${atraso ? ` · <b>${plural(atraso, 'dia', 'dias')} além do previsto</b>` : ''}`}</td>
        </tr>
        <tr>
          <th>${v.data_baixa ? 'Último setor' : 'Setor / leito atual'}</th><td>${esc(textoSetor(v.setor_atual, v.leito_atual)) || '—'}</td>
          <th>Situação</th><td><b>${esc(r.status || 'Sem evolução')}</b></td>
        </tr>
        ${!v.data_baixa ? `<tr><th>Pendências para a alta</th><td colspan="3">${v.pendencias_alta?.length ? v.pendencias_alta.map(esc).join('; ') : 'Nenhuma'}</td></tr>` : ''}
        ${reint ? `<tr><th>Reinternação</th><td colspan="3">Entrada ${plural(reint.dias, 'dia', 'dias')} após a alta de ${fmtData(reint.anterior.data_baixa)}</td></tr>` : ''}
        <tr><th>Motivo da entrada</th><td colspan="3" class="texto">${esc(v.motivo)}</td></tr>
        <tr><th>CID de entrada</th><td colspan="3">${listaCids(v.cids_entrada, tiposEntrada(v))}</td></tr>
        <tr><th>CID atual</th><td colspan="3">${listaCids(r.cids, tiposVig)}</td></tr>
        <tr><th>Aberta por</th><td colspan="3">${esc(autor(v.internacao?.criado_por_nome, v.internacao?.criado_por_email))}${v.internacao?.criado_em ? ` em ${fmtDataHora(v.internacao.criado_em)}` : ''}</td></tr>
      </table>

      ${internacoes.length > 1 ? `
      <h2 class="rel-secao">Internações do paciente (${internacoes.length})</h2>
      <table class="rel-tabela">
        <thead><tr><th>Entrada</th><th>Alta</th><th>Dias</th><th>Desfecho</th><th>Motivo</th></tr></thead>
        <tbody>${internacoes.map(x => `
          <tr${x.id === v.internacao_id ? ' class="destaque"' : ''}>
            <td class="nowrap">${fmtData(x.data_entrada)}</td>
            <td class="nowrap">${x.data_baixa ? fmtData(x.data_baixa) : 'em andamento'}</td>
            <td class="num">${diasEntre(x.data_entrada, x.data_baixa || hoje())}</td>
            <td>${esc(ROTULO_ALTA[x.tipo_alta] || x.tipo_alta || '—')}</td>
            <td>${esc(corta(x.motivo, 100))}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : ''}

      <h2 class="rel-secao">Resumo para codificação (DRG)</h2>
      <table class="rel-ficha">
        <tr>
          <th>Idade na entrada</th><td>${anosNaEntrada !== null ? `${anosNaEntrada} anos` : '—'}</td>
          <th>Sexo</th><td>${SEXO[p.sexo] || '—'}</td>
        </tr>
        <tr>
          <th>Permanência</th><td>${plural(Math.max(0, dias), 'dia', 'dias')}${v.data_baixa ? '' : ' (até hoje, em aberto)'}</td>
          <th>Tipo de alta</th><td>${v.tipo_alta ? esc(ROTULO_ALTA[v.tipo_alta] || v.tipo_alta) : 'Em andamento'}</td>
        </tr>
        <tr><th>Diagnóstico principal</th><td colspan="3">${drg.principal ? listaSimples([drg.principal]) : '—'}</td></tr>
        <tr><th>Comorbidades</th><td colspan="3">${listaSimples(drg.comorbidades)}</td></tr>
        <tr><th>Complicações</th><td colspan="3">${listaSimples(drg.complicacoes)}</td></tr>
        <tr><th>Procedimentos</th><td colspan="3">${drg.procedimentos.length
          ? drg.procedimentos.map(pr => `<div>${fmtData(pr.data)} · ${esc(textoProcedimento(pr))}</div>`).join('')
          : 'Nenhum registrado'}</td></tr>
        <tr><th>Intercorrências</th><td colspan="3">${drg.intercorrencias.length
          ? drg.intercorrencias.map(x => `<div>${fmtData(x.data)} · ${esc(x.tipo)}</div>`).join('')
          : 'Nenhuma registrada'}</td></tr>
        <tr><th>Passagens por setor</th><td colspan="3">${[
            v.setor_entrada ? `<div>${fmtData(v.data_entrada)} · ${esc(textoSetor(v.setor_entrada, v.leito_entrada))} (entrada)</div>` : '',
            ...drg.setores.map(s => `<div>${fmtData(s.data)} · ${esc(textoSetor(s.setor, s.leito))}</div>`)
          ].join('') || 'Não informado'}</td></tr>
      </table>
      <p class="sub">Consolidado da internação: complicações registradas em qualquer evolução permanecem listadas mesmo se resolvidas depois.
        O agrupamento DRG (grupo e peso) é feito pelo software agrupador.</p>

      <h2 class="rel-secao">Histórico da internação (${plural(evs.length, 'registro', 'registros')})</h2>
      ${asc.length ? `
      <table class="rel-tabela">
        <thead><tr><th>Data</th><th>Registro</th><th>CID</th><th>Evolução</th><th>Registrado por</th></tr></thead>
        <tbody>
          ${asc.map(e => {
            const m = mudancas.get(e.id);
            const tipoTxt = {
              setor: `Setor: ${textoSetor(e.setor, e.leito)}`, intercorrencia: `Intercorrência: ${e.intercorrencia}`,
              procedimento: 'Procedimento', alta: `ALTA: ${ROTULO_ALTA[e.tipo_alta] || e.tipo_alta}`
            }[e.tipo];
            return `
            <tr>
              <td class="nowrap">${fmtData(e.data)}</td>
              <td class="status">${e.anulada_em ? 'ANULADA' : `${tipoTxt ? `${esc(tipoTxt)}<br>` : ''}${esc(e.status || (tipoTxt ? '' : '—'))}`}</td>
              <td class="cid">${e.cids?.length ? e.cids.map((c, i) => `<div><b>${esc(c)}</b>${
                  i > 0 && e.cids_tipos?.[c] ? ` <span class="sub">${e.cids_tipos[c] === 'complicacao' ? 'complic.' : 'comorb.'}</span>` : ''}</div>`).join('') : '—'}
                ${m && m.rotulo === 'Diagnóstico alterado' ? `<div class="sub"><i>${m.rotulo}</i>${m.rem.length ? `<br>saiu: ${esc(m.rem.join(', '))}` : ''}${m.add.length ? `<br>entrou: ${esc(m.add.join(', '))}` : ''}${m.novoPrincipal ? `<br>novo principal: ${esc(m.novoPrincipal)}` : ''}</div>` : ''}</td>
              <td>${e.anulada_em ? `<div class="sub"><b>Anulada</b> por ${esc(autor(e.anulada_por_nome, e.anulada_por_email))} em ${fmtDataHora(e.anulada_em)}. Justificativa: ${esc(e.motivo_anulacao)}</div>` : ''}
                <div class="texto ${e.anulada_em ? 'riscado' : ''}">${esc(e.descricao)}</div>${e.procedimentos?.length
                ? `<div class="sub"><b>Procedimentos:</b> ${e.procedimentos.map(pr => esc(textoProcedimento(pr))).join('; ')}</div>` : ''}${
                  e.previsao_alta ? `<div class="sub">Previsão de alta: ${fmtData(e.previsao_alta)}${e.pendencias_alta?.length ? ` · pendências: ${esc(e.pendencias_alta.join('; '))}` : ''}</div>` : ''}</td>
              <td class="autor">${esc(autor(e.criado_por_nome, e.criado_por_email))}${e.criado_em ? `<div class="sub">${fmtDataHora(e.criado_em)}</div>` : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<p>Nenhuma evolução registrada.</p>'}

      <div class="rel-assinatura">
        <div><span></span>Responsável pelas informações</div>
        <div><span></span>Data</div>
      </div>
      <p class="rel-rodape">Controle de Pacientes · ${esc(p.nome)}</p>`;
  }

  // Pré-visualização: mesma folha que vai para a impressora
  const dlgPreview = $('#dlg-preview');
  const estiloPagina = document.createElement('style');
  document.head.appendChild(estiloPagina);

  function prepararImpressao(html, orientacao) {
    $('#impressao').innerHTML = html;
    estiloPagina.textContent = `@page { size: A4 ${orientacao === 'retrato' ? 'portrait' : 'landscape'}; margin: 12mm; }`;
  }

  let previewTamanhoReal = false;
  function ajustarZoomPreview() {
    const area = $('#preview-area');
    const folha = $('#preview-folha');
    folha.style.zoom = 1;
    const disponivel = area.clientWidth - 32;
    const escalaAjuste = Math.min(1, disponivel / folha.offsetWidth);
    folha.style.zoom = previewTamanhoReal ? 1 : escalaAjuste;
    const btn = $('#btn-preview-zoom');
    btn.hidden = escalaAjuste >= 0.99; // a folha já cabe inteira: botão desnecessário
    btn.textContent = previewTamanhoReal ? 'Ajustar à tela' : 'Tamanho real';
  }
  $('#btn-preview-zoom').addEventListener('click', () => {
    previewTamanhoReal = !previewTamanhoReal;
    ajustarZoomPreview();
  });

  function abrirPreview({ html, orientacao, titulo, info }) {
    prepararImpressao(html, orientacao);
    const folha = $('#preview-folha');
    folha.innerHTML = html;
    folha.classList.toggle('retrato', orientacao === 'retrato');
    $('#preview-titulo').textContent = titulo;
    $('#preview-info').textContent = `${info} · A4 ${orientacao === 'retrato' ? 'retrato' : 'paisagem'}`;
    dlgPreview.showModal();
    previewTamanhoReal = false;
    ajustarZoomPreview();
    $('#preview-area').scrollTop = 0;
  }

  $('#btn-imprimir').addEventListener('click', async ev => {
    const botao = ev.currentTarget;
    botao.disabled = true;
    try {
      await carregarPacientes(); // garante dados atualizados
      const { html, total } = htmlRelatorioLista();
      abrirPreview({
        html, orientacao: 'paisagem',
        titulo: 'Pré-visualização: pacientes internados',
        info: plural(total, 'paciente', 'pacientes')
      });
    } finally {
      botao.disabled = false;
    }
  });

  function previewPaciente() {
    const v = elDetalhe._paciente, evs = elDetalhe._evolucoes || [];
    if (!v) return;
    abrirPreview({
      html: htmlRelatorioPaciente(v, evs, elDetalhe._pessoa), orientacao: 'retrato',
      titulo: 'Pré-visualização: relatório do paciente',
      info: `${v.nome} · internação de ${fmtData(v.data_entrada)} · ${evs.length} evoluç${evs.length === 1 ? 'ão' : 'ões'}`
    });
  }

  $('#btn-preview-imprimir').addEventListener('click', () => window.print());
  $('#btn-preview-fechar').addEventListener('click', () => dlgPreview.close());
  window.addEventListener('resize', () => { if (dlgPreview.open) ajustarZoomPreview(); });

  // Ctrl+P fora da pré-visualização: relatório do paciente aberto, ou a lista
  window.addEventListener('beforeprint', () => {
    if (dlgPreview.open) return; // já preparado pela pré-visualização
    if (estado.selecionado && elDetalhe._paciente?.id === estado.selecionado) {
      prepararImpressao(htmlRelatorioPaciente(elDetalhe._paciente, elDetalhe._evolucoes || [], elDetalhe._pessoa), 'retrato');
    } else {
      prepararImpressao(htmlRelatorioLista().html, 'paisagem');
    }
  });

  elDetalhe.addEventListener('click', async ev => {
    const alvo = ev.target.closest('[data-acao]');
    if (!alvo) return;
    const acao = alvo.dataset.acao;
    if (acao === 'voltar') irPara(null);
    else if (acao === 'editar-pessoa') abrirDialogo('pessoa', elDetalhe._pessoa);
    else if (acao === 'editar-internacao') abrirDialogo('internacao', elDetalhe._pessoa, elDetalhe._internacao);
    else if (acao === 'nova-internacao') abrirDialogo('nova-internacao', elDetalhe._pessoa);
    else if (acao === 'ver-internacao') irPara(estado.selecionado, alvo.dataset.id);
    else if (acao === 'imprimir') previewPaciente();
    else if (acao === 'anular-evo') abrirAnulacao(alvo.dataset.id, alvo.dataset.data);
  });

  // ------------------------------------------------------------------
  // Anulação de evolução (substitui a exclusão: nada se apaga)
  // ------------------------------------------------------------------
  const dlgAnular = $('#dlg-anular');
  const formAnular = $('#form-anular');
  let anulandoId = null;

  function abrirAnulacao(id, data) {
    anulandoId = id;
    formAnular.reset();
    $('#anular-erro').hidden = true;
    const ev = (elDetalhe._evolucoes || []).find(e => e.id === id);
    $('#anular-info').textContent = `${ev?.tipo === 'alta' ? 'Alta' : 'Evolução'} de ${fmtData(data)} · ${elDetalhe._paciente?.nome || ''}`
      + (ev?.tipo === 'alta' ? ' — ao anular, a internação volta a ficar em andamento.' : '');
    dlgAnular.showModal();
    formAnular.elements.motivo.focus();
  }
  $('#btn-anular-cancelar').addEventListener('click', () => dlgAnular.close());

  formAnular.addEventListener('submit', async ev => {
    ev.preventDefault();
    const motivo = formAnular.elements.motivo.value.trim();
    if (motivo.length < 10) {
      $('#anular-erro').textContent = 'Escreva uma justificativa com pelo menos 10 caracteres.';
      $('#anular-erro').hidden = false;
      return;
    }
    const botao = formAnular.querySelector('[type=submit]');
    botao.disabled = true;
    try {
      await db.anularEvolucao(anulandoId, motivo);
      dlgAnular.close();
      toast('Evolução anulada. O registro continua no histórico.');
      await carregarPacientes();
      abrirPaciente(estado.selecionado, estado.internacaoSel);
    } catch (e) {
      $('#anular-erro').textContent = 'Não foi possível anular: ' + msgErro(e);
      $('#anular-erro').hidden = false;
    } finally {
      botao.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Registrar evolução (com o tipo de registro)
  // ------------------------------------------------------------------
  elDetalhe.addEventListener('submit', async ev => {
    if (ev.target.id !== 'form-evolucao') return;
    ev.preventDefault();
    const form = ev.target;
    const fd = new FormData(form);
    const erro = $('#evo-erro', form);
    const tipo = fd.get('tipo');
    const procedimentos = procedimentosEvolucao ? procedimentosEvolucao.valores() : [];
    const falha = msg => { erro.textContent = msg; erro.hidden = false; erro.scrollIntoView({ block: 'center' }); };
    erro.hidden = true;

    if (tipo === 'setor' && !fd.get('setor')) return falha('Escolha o novo setor.');
    if (tipo === 'intercorrencia' && !fd.get('intercorrencia')) return falha('Escolha o tipo de intercorrência.');
    if (tipo === 'alta' && !fd.get('tipo_alta')) return falha('Escolha o tipo de alta / desfecho.');
    if (tipo === 'procedimento' && !procedimentos.length) return falha('Informe ao menos um procedimento realizado.');

    const outra = (fd.get('pendencia_outra') || '').trim();
    const pendencias = tipo === 'alta' ? null : [...fd.getAll('pendencia'), ...(outra ? [outra] : [])];

    const botao = form.querySelector('[type=submit]');
    botao.disabled = true;
    try {
      await db.criarEvolucao({
        internacao_id: estado.internacaoSel,
        paciente_id: estado.selecionado,
        data: fd.get('data'),
        tipo,
        status: vazioParaNull(fd.get('status')),
        descricao: fd.get('descricao').trim(),
        cids: seletorEvolucao ? seletorEvolucao.valores() : [],
        cids_tipos: seletorEvolucao ? seletorEvolucao.tipos() : {},
        procedimentos,
        setor: tipo === 'setor' ? fd.get('setor') : null,
        leito: tipo === 'setor' ? vazioParaNull(fd.get('leito') || '') : null,
        intercorrencia: tipo === 'intercorrencia' ? fd.get('intercorrencia') : null,
        tipo_alta: tipo === 'alta' ? fd.get('tipo_alta') : null,
        previsao_alta: tipo === 'alta' ? null : (fd.get('previsao_alta') || null),
        pendencias_alta: pendencias
      });
      toast(tipo === 'alta' ? 'Alta registrada. Internação encerrada.' : 'Evolução registrada.');
      await carregarPacientes();
      await abrirPaciente(estado.selecionado, estado.internacaoSel);
    } catch (e) {
      falha('Não foi possível salvar: ' + msgErro(e));
      botao.disabled = false;
    }
  });

  window.addEventListener('hashchange', rotear);

  // ------------------------------------------------------------------
  // Login
  // ------------------------------------------------------------------
  $('#form-login').addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const erro = $('#login-erro');
    const botao = ev.target.querySelector('[type=submit]');
    erro.hidden = true;
    botao.disabled = true;
    try {
      await db.entrar(fd.get('email').trim(), fd.get('senha'));
      ev.target.reset();
      registrarAtividade(true); // nova sessão: zera a contagem de inatividade
      await concluirAcesso();
    } catch (e) {
      erro.textContent = msgErro(e);
      erro.hidden = false;
    } finally {
      botao.disabled = false;
    }
  });

  function renderUsuario() {
    const u = estado.usuario || {};
    $('#user-email').innerHTML = u.nome
      ? esc(u.nome)
      : `${esc(u.email || '')} · <span class="sem-nome">definir nome</span>`;
    $('#btn-meu-nome').title = `${u.email || ''} — minha conta (nome, senha${ehAdmin() ? ', setores' : ''})`;
    $('#btn-sair').hidden = !MODO_ONLINE;
  }

  $('#btn-meu-nome').addEventListener('click', abrirConta);

  $('#btn-sair').addEventListener('click', () => encerrarSessao());

  // ------------------------------------------------------------------
  // Início
  // ------------------------------------------------------------------
  (async function iniciar() {
    if (MODO_ONLINE && !window.supabase) {
      document.body.insertAdjacentHTML('beforeend',
        '<p class="placeholder erro" style="padding:24px">Não foi possível carregar a biblioteca do Supabase. Verifique a conexão e recarregue a página.</p>');
      return;
    }
    db = MODO_ONLINE ? backendSupabase() : backendLocal();
    $('#aviso-demo').hidden = MODO_ONLINE;
    $('#aviso-homologacao').hidden = cfg.AMBIENTE !== 'homologacao';
    if (cfg.AMBIENTE === 'homologacao') document.title = '[HOMOLOGAÇÃO] ' + document.title;
    if (MODO_ONLINE) db.aoEncerrarSessao(() => { if (estado.usuario) encerrarSessao('Sua sessão foi encerrada.'); });
    const s = await db.sessao();
    if (!s) return mostrarLogin();
    // quem chega pelo link de recuperação acabou de se identificar pelo e-mail
    if (MODO_ONLINE && db.veioDeRecuperacaoDeSenha()) registrarAtividade(true);
    if (MODO_ONLINE && sessaoExpiradaPorInatividade()) {
      return encerrarSessao(`Sua sessão foi encerrada após ${INATIVIDADE_MIN} minutos sem uso. Entre novamente.`);
    }
    try {
      await concluirAcesso();
    } catch (e) {
      encerrarSessao('Não foi possível validar o acesso: ' + msgErro(e));
    }
  })();
})();
