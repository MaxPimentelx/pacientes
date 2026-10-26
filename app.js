(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const MODO_ONLINE = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

  const STATUS = ['Estável', 'Melhorando', 'Piorando', 'Crítico', 'Alta'];
  const STATUS_CLASSE = {
    'Estável': 's-estavel', 'Melhorando': 's-melhorando', 'Piorando': 's-piorando',
    'Crítico': 's-critico', 'Alta': 's-alta'
  };

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
    return lista.slice().sort((x, y) =>
      (y.data || '').localeCompare(x.data || '') || (y.criado_em || '').localeCompare(x.criado_em || ''));
  }

  function resumo(p) {
    const evs = ordenarEvolucoes(p.evolucoes || []);
    return {
      ultima: evs[0] || null,
      ultimaData: evs[0]?.data || null,
      status: evs.find(e => e.status)?.status || null,
      // CID vigente = o da evolução mais recente que tenha CID; senão, o de entrada
      cids: evs.find(e => e.cids?.length)?.cids || p.cids_entrada || [],
      total: evs.length
    };
  }

  // ------------------------------------------------------------------
  // Dados para DRG: classificação dos CIDs secundários e procedimentos
  // ------------------------------------------------------------------
  const ROTULO_TIPO = { comorbidade: 'Comorbidade', complicacao: 'Complicação' };
  const SEXO = { F: 'Feminino', M: 'Masculino' };

  // Secundários da entrada são comorbidades (presentes na admissão)
  const tiposEntrada = p => Object.fromEntries((p.cids_entrada || []).slice(1).map(c => [c, 'comorbidade']));

  // Classificação vigente de cada CID: entrada + evoluções em ordem cronológica
  function tiposAtuais(p, evs) {
    const tipos = tiposEntrada(p);
    for (const e of ordenarEvolucoes(evs).reverse()) Object.assign(tipos, e.cids_tipos || {});
    return tipos;
  }

  // Consolidado da internação inteira, no formato que um agrupador DRG pede
  function consolidadoDrg(p, evs) {
    const asc = ordenarEvolucoes(evs).reverse();
    const principal = resumo({ ...p, evolucoes: evs }).cids[0] || null;
    const comorbidades = new Set(), complicacoes = new Set();
    for (const [c, t] of Object.entries(tiposEntrada(p))) (t === 'complicacao' ? complicacoes : comorbidades).add(c);
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
    return { principal, comorbidades: [...comorbidades], complicacoes: [...complicacoes], procedimentos };
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
  // só quem registrou pode excluir (regra também garantida no banco)
  const podeExcluir = e => !MODO_ONLINE || !e.criado_por || e.criado_por === estado.usuario?.id;

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
        .filter(pr => pr.codigo || pr.descricao)
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
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function msgErro(e) {
    const m = e?.message || String(e);
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Sem conexão com o servidor. Verifique a internet.';
    return m;
  }

  // ------------------------------------------------------------------
  // Acesso a dados: Supabase (on-line) ou navegador (demonstração)
  // ------------------------------------------------------------------
  function backendSupabase() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    return {
      async sessao() {
        const { data } = await sb.auth.getSession();
        const u = data.session?.user;
        return u ? { id: u.id, email: u.email, nome: (u.user_metadata?.nome || '').trim() } : null;
      },
      // nome de exibição usado na autoria dos próximos registros
      async definirNome(nome) { ok(await sb.auth.updateUser({ data: { nome } })); },
      async entrar(email, senha) { ok(await sb.auth.signInWithPassword({ email, password: senha })); },
      async sair() { await sb.auth.signOut(); },
      async listarPacientes() {
        return ok(await sb.from('pacientes').select('*, evolucoes(data, status, descricao, cids, criado_em)').order('nome'));
      },
      async obterPaciente(id) {
        return ok(await sb.from('pacientes').select('*').eq('id', id).maybeSingle());
      },
      async criarPaciente(p) { return ok(await sb.from('pacientes').insert(p).select().single()); },
      async atualizarPaciente(id, p) { return ok(await sb.from('pacientes').update(p).eq('id', id).select().single()); },
      async listarEvolucoes(pid) {
        return ok(await sb.from('evolucoes').select('*').eq('paciente_id', pid)
          .order('data', { ascending: false }).order('criado_em', { ascending: false }));
      },
      async criarEvolucao(e) { return ok(await sb.from('evolucoes').insert(e).select().single()); },
      async excluirEvolucao(id) { ok(await sb.from('evolucoes').delete().eq('id', id)); }
    };
  }

  function backendLocal() {
    const CHAVE = 'controle-pacientes-demo-v1';
    let mem;
    try { mem = JSON.parse(localStorage.getItem(CHAVE)); } catch { mem = null; }
    if (!mem || !Array.isArray(mem.pacientes)) mem = { pacientes: [], evolucoes: [] };
    const gravar = () => { try { localStorage.setItem(CHAVE, JSON.stringify(mem)); } catch { /* sem storage */ } };
    const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const agora = () => new Date().toISOString();
    // no modo demonstração a autoria é simulada (no Supabase é gravada pelo banco)
    const usuarioDemo = { id: 'demo', email: 'demonstracao@local', nome: 'Usuário de demonstração' };
    const criacao = () => ({ criado_em: agora(), criado_por: usuarioDemo.id, criado_por_nome: usuarioDemo.nome, criado_por_email: usuarioDemo.email });

    return {
      async sessao() { return usuarioDemo; },
      async definirNome(nome) { usuarioDemo.nome = nome || 'Usuário de demonstração'; },
      async entrar() {},
      async sair() {},
      async listarPacientes() {
        return mem.pacientes
          .map(p => ({ ...p, evolucoes: mem.evolucoes.filter(e => e.paciente_id === p.id) }))
          .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      },
      async obterPaciente(id) { return mem.pacientes.find(p => p.id === id) || null; },
      async criarPaciente(p) {
        const novo = { ...p, id: novoId(), ...criacao() };
        mem.pacientes.push(novo); gravar(); return novo;
      },
      async atualizarPaciente(id, p) {
        const atual = mem.pacientes.find(x => x.id === id);
        Object.assign(atual, p, {
          atualizado_em: agora(), atualizado_por: usuarioDemo.id,
          atualizado_por_nome: usuarioDemo.nome, atualizado_por_email: usuarioDemo.email
        });
        gravar(); return atual;
      },
      async listarEvolucoes(pid) { return ordenarEvolucoes(mem.evolucoes.filter(e => e.paciente_id === pid)); },
      async criarEvolucao(e) {
        const nova = { ...e, id: novoId(), ...criacao() };
        mem.evolucoes.push(nova); gravar(); return nova;
      },
      async excluirEvolucao(id) { mem.evolucoes = mem.evolucoes.filter(e => e.id !== id); gravar(); }
    };
  }

  // ------------------------------------------------------------------
  // Estado e telas
  // ------------------------------------------------------------------
  let db;
  const estado = { pacientes: [], selecionado: null, busca: '', filtro: '', baixa: 'sem' };
  let seletorEvolucao = null;
  let procedimentosEvolucao = null;
  const pillBaixa = p => `<span class="pill s-baixa">Baixa ${fmtData(p.data_baixa)}</span>`;
  const elDetalhe = $('#detalhe');

  function mostrarLogin() {
    $('#tela-login').hidden = false;
    $('#tela-app').hidden = true;
    $('#user-box').hidden = true;
  }

  async function mostrarApp(sessao) {
    $('#tela-login').hidden = true;
    $('#tela-app').hidden = false;
    estado.usuario = sessao;
    $('#user-box').hidden = false;
    renderUsuario();
    await Promise.all([carregarPacientes(), carregarCid()]);
    rotear();
  }

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
    const f = estado.filtro;
    const b = estado.baixa;
    const itens = estado.pacientes
      .map(p => ({ p, r: resumo(p) }))
      .filter(({ p }) => b === 'todos' || (b === 'com' ? !!p.data_baixa : !p.data_baixa))
      .filter(({ p, r }) => !termo || normalizar(p.nome).includes(termo) || normalizar(p.documento).includes(termo)
        || r.cids.some(c => c.toLowerCase().replace('.', '').startsWith(termo.replace('.', ''))))
      .filter(({ r }) => {
        if (!f) return true;
        if (f === 'sem') return !r.status;
        return r.status === f;
      });

    const total = estado.pacientes.length;
    const semBaixa = estado.pacientes.filter(p => !p.data_baixa).length;
    $('#contagem').textContent =
      `Mostrando ${itens.length} · ${semBaixa} sem baixa · ${total - semBaixa} com baixa · ${total} no total`;

    const ul = $('#lista');
    if (!itens.length) {
      ul.innerHTML = `<li class="vazio">${total ? 'Nenhum paciente encontrado com esse filtro.' : 'Nenhum paciente cadastrado ainda.<br>Toque em “+ Novo paciente” para começar.'}</li>`;
      return;
    }
    ul.innerHTML = itens.map(({ p, r }) => `
      <li>
        <button type="button" class="item ${p.id === estado.selecionado ? 'ativo' : ''} ${p.data_baixa ? 'baixado' : ''}" data-id="${esc(p.id)}">
          <span class="item-linha"><strong>${esc(p.nome)}</strong>${p.data_baixa ? pillBaixa(p) : pill(r.status)}</span>
          <span class="item-meta">Entrada: ${fmtData(p.data_entrada)} · ${p.data_baixa
            ? `${diasEntre(p.data_entrada, p.data_baixa)} dias até a baixa`
            : haQuanto(p.data_entrada)}</span>
          ${r.cids.length ? `<span class="item-meta" title="${esc(descCid(r.cids[0]))}">CID: <b>${esc(r.cids[0])}</b>${r.cids.length > 1 ? ` +${r.cids.length - 1}` : ''} ${esc(descCid(r.cids[0]))}</span>` : ''}
          <span class="item-meta">${r.total ? `Última evolução: ${fmtData(r.ultimaData)} · ${r.total} registro${r.total === 1 ? '' : 's'}` : 'Nenhuma evolução registrada'}</span>
        </button>
      </li>`).join('');
  }

  function renderPlaceholder() {
    elDetalhe.innerHTML = '<p class="placeholder">Selecione um paciente na lista<br>ou cadastre um novo.</p>';
  }

  async function abrirPaciente(id) {
    estado.selecionado = id;
    document.body.classList.add('ver-detalhe');
    renderLista();
    elDetalhe.innerHTML = '<p class="placeholder">Carregando…</p>';
    try {
      const [p, evs] = await Promise.all([db.obterPaciente(id), db.listarEvolucoes(id)]);
      if (estado.selecionado !== id) return; // usuário já trocou de paciente
      if (!p) { elDetalhe.innerHTML = '<p class="placeholder">Paciente não encontrado.</p>'; return; }
      renderDetalhe(p, evs);
    } catch (e) {
      elDetalhe.innerHTML = `<p class="placeholder erro">Erro ao abrir paciente: ${esc(msgErro(e))}</p>`;
    }
  }

  function fecharDetalhe() {
    estado.selecionado = null;
    document.body.classList.remove('ver-detalhe');
    renderLista();
    renderPlaceholder();
  }

  // Mudanças de CID ao longo do tempo (da entrada para a evolução mais recente)
  function mudancasCid(p, evs) {
    const mudancas = new Map();
    let anterior = p.cids_entrada || [];
    for (const e of ordenarEvolucoes(evs).reverse()) {
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

  function renderDetalhe(p, evs) {
    const r = resumo({ ...p, evolucoes: evs });
    const id = idade(p.data_nascimento);
    const tiposVigentes = tiposAtuais(p, evs);

    const mudancas = mudancasCid(p, evs);
    const blocoMudanca = m => !m ? '' : `
      <div class="cid-mudanca"><strong>${m.rotulo}:</strong>
        ${m.add.map(c => `<span class="cid-add" title="${esc(descCid(c))}">+ ${esc(c)}</span>`).join('')}
        ${m.rem.map(c => `<span class="cid-rem" title="${esc(descCid(c))}">${esc(c)}</span>`).join('')}
        ${m.novoPrincipal ? `<span>principal passou a ser <b>${esc(m.novoPrincipal)}</b></span>` : ''}
      </div>`;
    const diasInternado = diasEntre(p.data_entrada, p.data_baixa || hoje());

    const blocoEvolucao = p.data_baixa ? `
      <div class="aviso-baixa">
        <strong>Processo encerrado: baixa em ${fmtData(p.data_baixa)}.</strong><br>
        Para registrar novas evoluções, clique em “Editar dados” e apague a data da baixa.
      </div>` : `
      <form class="card form" id="form-evolucao">
        <h3>Registrar nova evolução</h3>
        <div class="grid-evo">
          <label>Data <input type="date" name="data" required value="${hoje()}"></label>
          <label>Situação
            <select name="status">
              <option value="">— não informar —</option>
              ${STATUS.map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </label>
          <label class="span-all">Como o paciente está / o que mudou *
            <textarea name="descricao" rows="4" required placeholder="Ex.: Sinais vitais estáveis, aceitando bem a dieta, iniciou fisioterapia…"></textarea>
          </label>
          <div class="campo span-all">
            <span class="rotulo">CID vigente nesta data (CID-10)</span>
            <div class="cid-picker" id="cid-evolucao"></div>
            <small class="dica">Já vem com o CID atual. Se o diagnóstico mudou, remova (×) e adicione o novo; o histórico registra a alteração.
              Classifique cada CID secundário: <b>comorbidade</b> (doença que o paciente já tinha) ou <b>complicação</b> (surgiu durante a internação).</small>
          </div>
          <div class="campo span-all">
            <span class="rotulo">Procedimentos realizados nesta data (opcional)</span>
            <div id="proc-evolucao"></div>
            <small class="dica">Código TUSS (convênios) ou SIGTAP (SUS), se souber, e a descrição. Ex.: cirurgias, exames invasivos, hemodiálise, ventilação mecânica.</small>
          </div>
        </div>
        <div class="acoes"><button type="submit" class="btn btn-primary">Salvar evolução</button></div>
      </form>`;

    elDetalhe.innerHTML = `
      <div class="detalhe-topo">
        <button type="button" class="btn btn-ghost btn-sm voltar" data-acao="voltar">← Lista</button>
        <div class="detalhe-botoes">
          <button type="button" class="btn btn-ghost btn-sm" data-acao="imprimir" title="Visualizar e imprimir o relatório deste paciente">Imprimir</button>
          <button type="button" class="btn btn-ghost btn-sm" data-acao="editar">Editar dados</button>
        </div>
      </div>

      <div class="card">
        <dl class="info-grid">
          <div class="span-all info-nome">
            <dt>Paciente</dt>
            <dd><h2>${esc(p.nome)}</h2>${pill(r.status)}${p.data_baixa ? pillBaixa(p) : ''}</dd>
          </div>
          <div><dt>Data de entrada</dt><dd>${fmtData(p.data_entrada)} <span class="item-meta">(${diasInternado >= 0 ? `${diasInternado} dia${diasInternado === 1 ? '' : 's'}${p.data_baixa ? ' até a baixa' : ''}` : 'data futura'})</span></dd></div>
          <div><dt>Data da baixa</dt><dd>${p.data_baixa ? `${fmtData(p.data_baixa)}${p.tipo_alta ? ` · <b>${esc(p.tipo_alta)}</b>` : ''}` : 'Em acompanhamento'}</dd></div>
          <div><dt>Nascimento</dt><dd>${fmtData(p.data_nascimento)}${id !== null ? ` <span class="item-meta">(${id} anos)</span>` : ''}</dd></div>
          <div><dt>Sexo</dt><dd>${SEXO[p.sexo] || '—'}</dd></div>
          <div><dt>Telefone</dt><dd>${p.telefone ? `<a href="tel:${esc(p.telefone.replace(/[^\d+]/g, ''))}">${esc(p.telefone)}</a>` : '—'}</dd></div>
          <div><dt>Documento</dt><dd>${esc(p.documento) || '—'}</dd></div>
          <div class="span-all"><dt>CID atual</dt><dd>${cidLista(r.cids, tiposVigentes)}</dd></div>
          <div class="span-all"><dt>Motivo da entrada</dt><dd class="texto">${esc(p.motivo)}</dd></div>
          <div class="span-all"><dt>CID de entrada</dt><dd>${cidLista(p.cids_entrada, tiposEntrada(p))}</dd></div>
          ${p.observacoes ? `<div class="span-all"><dt>Observações</dt><dd class="texto">${esc(p.observacoes)}</dd></div>` : ''}
        </dl>
        <div class="autoria">
          ${linhaAutoria('Cadastrado por', p.criado_por_nome, p.criado_por_email, p.criado_em)}
          ${p.atualizado_em ? `<br>${linhaAutoria('Última alteração por', p.atualizado_por_nome, p.atualizado_por_email, p.atualizado_em)}` : ''}
        </div>
      </div>

      ${blocoEvolucao}

      <section class="card">
        <h3>Histórico de evolução (${evs.length})</h3>
        <ol class="timeline">
          ${p.data_baixa ? `
            <li class="tl-entrada">
              <div class="tl-topo"><strong>${fmtData(p.data_baixa)}</strong><span class="pill s-baixa">Baixa</span></div>
              <p class="texto">Processo encerrado${p.tipo_alta ? ` · tipo de alta: <b>${esc(p.tipo_alta)}</b>` : ''}.</p>
            </li>` : ''}
          ${evs.map(e => `
            <li>
              <div class="tl-topo">
                <strong>${fmtData(e.data)}</strong>
                ${e.status ? pill(e.status) : ''}
                <span class="item-meta">${haQuanto(e.data)}</span>
                ${podeExcluir(e) ? `<button type="button" class="link-excluir" data-acao="excluir-evo" data-id="${esc(e.id)}">Excluir</button>` : ''}
              </div>
              <div class="tl-autor">${linhaAutoria('Registrado por', e.criado_por_nome, e.criado_por_email, e.criado_em)}</div>
              <p class="texto">${esc(e.descricao)}</p>
              ${e.cids?.length ? `<div class="tl-cids">${cidLista(e.cids, e.cids_tipos)}</div>` : ''}
              ${blocoMudanca(mudancas.get(e.id))}
              ${e.procedimentos?.length ? `
                <div class="tl-proc"><strong>Procedimentos:</strong>
                  <ul>${e.procedimentos.map(pr => `<li>${pr.codigo ? `<b>${esc(pr.codigo)}</b> ` : ''}${esc(pr.descricao)}</li>`).join('')}</ul>
                </div>` : ''}
            </li>`).join('')}
          <li class="tl-entrada">
            <div class="tl-topo"><strong>${fmtData(p.data_entrada)}</strong><span class="pill s-nenhum">Entrada</span></div>
            <div class="tl-autor">${linhaAutoria('Cadastrado por', p.criado_por_nome, p.criado_por_email, p.criado_em)}</div>
            <p class="texto">${esc(p.motivo)}</p>
            ${p.cids_entrada?.length ? `<div class="tl-cids">${cidLista(p.cids_entrada, tiposEntrada(p))}</div>` : ''}
          </li>
        </ol>
      </section>`;

    const raizCidEvo = $('#cid-evolucao', elDetalhe);
    seletorEvolucao = raizCidEvo
      ? montarSeletorCid(raizCidEvo, r.cids, { classificar: true, tiposIniciais: tiposVigentes })
      : null;
    const raizProc = $('#proc-evolucao', elDetalhe);
    procedimentosEvolucao = raizProc ? montarProcedimentos(raizProc) : null;

    elDetalhe._paciente = p;
    elDetalhe._evolucoes = evs;
    elDetalhe.scrollTop = 0;
    if (window.matchMedia('(max-width: 799px)').matches) window.scrollTo(0, 0);
  }

  // Navegação pelo endereço (#p/<id>) — faz o botão "voltar" do celular funcionar
  function rotear() {
    const m = location.hash.match(/^#p\/(.+)$/);
    if (m) abrirPaciente(decodeURIComponent(m[1]));
    else fecharDetalhe();
  }
  const irPara = id => { location.hash = id ? 'p/' + encodeURIComponent(id) : ''; };

  // ------------------------------------------------------------------
  // Cadastro / edição de paciente
  // ------------------------------------------------------------------
  const dlg = $('#dlg-paciente');
  const formPac = $('#form-paciente');
  let editandoId = null;
  const seletorEntrada = montarSeletorCid($('#cid-entrada'));

  // "Tipo de alta" só aparece (e é obrigatório) quando há data da baixa
  function atualizarCampoTipoAlta() {
    const temBaixa = !!formPac.elements.data_baixa.value;
    $('#campo-tipo-alta').hidden = !temBaixa;
    formPac.elements.tipo_alta.required = temBaixa;
  }
  formPac.elements.data_baixa.addEventListener('input', atualizarCampoTipoAlta);

  function abrirDialogo(p) {
    editandoId = p ? p.id : null;
    $('#dlg-titulo').textContent = p ? 'Editar dados do paciente' : 'Novo paciente';
    formPac.reset();
    $('#dlg-erro').hidden = true;
    const dados = p || { data_entrada: hoje() };
    for (const campo of ['nome', 'data_nascimento', 'sexo', 'telefone', 'documento', 'data_entrada', 'data_baixa', 'tipo_alta', 'motivo', 'observacoes']) {
      formPac.elements[campo].value = dados[campo] || '';
    }
    atualizarCampoTipoAlta();
    seletorEntrada.definir(dados.cids_entrada);
    dlg.showModal();
    formPac.elements.nome.focus();
  }

  formPac.addEventListener('submit', async ev => {
    ev.preventDefault();
    const fd = new FormData(formPac);
    const dados = {};
    for (const [k, v] of fd.entries()) dados[k] = vazioParaNull(v);
    dados.cids_entrada = seletorEntrada.valores();
    if (!dados.data_baixa) dados.tipo_alta = null;
    const erro = dados.data_baixa && dados.data_baixa < dados.data_entrada
      ? 'A data da baixa não pode ser anterior à data de entrada.'
      : dados.data_baixa && !dados.tipo_alta ? 'Informe o tipo de alta.' : null;
    if (erro) {
      $('#dlg-erro').textContent = erro;
      $('#dlg-erro').hidden = false;
      return;
    }
    const botao = formPac.querySelector('[type=submit]');
    botao.disabled = true;
    try {
      if (editandoId) {
        await db.atualizarPaciente(editandoId, dados);
        dlg.close();
        toast('Dados atualizados.');
        await carregarPacientes();
        abrirPaciente(editandoId);
      } else {
        const novo = await db.criarPaciente(dados);
        dlg.close();
        toast('Paciente cadastrado.');
        await carregarPacientes();
        irPara(novo.id);
      }
    } catch (e) {
      $('#dlg-erro').textContent = 'Não foi possível salvar: ' + msgErro(e);
      $('#dlg-erro').hidden = false;
    } finally {
      botao.disabled = false;
    }
  });

  $('#btn-cancelar').addEventListener('click', () => dlg.close());
  $('#btn-novo').addEventListener('click', () => abrirDialogo(null));

  // ------------------------------------------------------------------
  // Eventos da lista e do detalhe
  // ------------------------------------------------------------------
  $('#lista').addEventListener('click', ev => {
    const item = ev.target.closest('.item');
    if (item) irPara(item.dataset.id);
  });
  $('#busca').addEventListener('input', ev => { estado.busca = ev.target.value; renderLista(); });
  $('#filtro-status').addEventListener('change', ev => { estado.filtro = ev.target.value; renderLista(); });
  document.querySelectorAll('input[name=filtro-baixa]').forEach(r =>
    r.addEventListener('change', ev => { estado.baixa = ev.target.value; renderLista(); }));

  // ------------------------------------------------------------------
  // Relatórios: lista de pacientes sem baixa (A4 paisagem) e
  // relatório individual do paciente (A4 retrato)
  // ------------------------------------------------------------------
  const emitidoEm = () =>
    `${fmtData(hoje())} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  const corta = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

  function htmlRelatorioLista() {
    const linhas = estado.pacientes
      .filter(p => !p.data_baixa)
      .map(p => ({ p, r: resumo(p) }))
      .sort((a, b) => a.p.nome.localeCompare(b.p.nome, 'pt-BR'));

    const porStatus = {};
    for (const { r } of linhas) { const s = r.status || 'Sem evolução'; porStatus[s] = (porStatus[s] || 0) + 1; }
    const resumoTxt = Object.entries(porStatus).map(([s, n]) => `${s}: ${n}`).join(' · ');

    const html = `
      <div class="rel-cabecalho">
        <h1>Pacientes sem baixa</h1>
        <p>Emitido em ${emitidoEm()}<br>Total: ${linhas.length} paciente${linhas.length === 1 ? '' : 's'}</p>
      </div>
      ${linhas.length ? `
      <p class="rel-resumo"><strong>Por situação:</strong> ${esc(resumoTxt)}</p>
      <table class="rel-tabela">
        <thead>
          <tr>
            <th>#</th><th>Paciente</th><th>Entrada</th><th>Dias</th>
            <th>Motivo da entrada</th><th>CID atual</th><th>Situação</th><th>Última evolução</th>
          </tr>
        </thead>
        <tbody>
          ${linhas.map(({ p, r }, i) => `
            <tr>
              <td class="num">${i + 1}</td>
              <td>${esc(p.nome)}${p.documento ? `<div class="sub">${esc(p.documento)}</div>` : ''}</td>
              <td class="nowrap">${fmtData(p.data_entrada)}</td>
              <td class="num">${Math.max(0, diasEntre(p.data_entrada))}</td>
              <td>${esc(corta(p.motivo, 160))}</td>
              <td class="cid">${r.cids.length
                ? `<b>${esc(r.cids[0])}</b> ${esc(corta(descCid(r.cids[0]), 70))}${r.cids.length > 1 ? `<div class="sub">+ ${esc(r.cids.slice(1).join(', '))}</div>` : ''}`
                : '—'}</td>
              <td class="status">${esc(r.status || 'Sem evolução')}</td>
              <td>${r.ultima
                ? `<span class="nowrap"><strong>${fmtData(r.ultima.data)}</strong></span> ${esc(corta(r.ultima.descricao, 220))}`
                : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<p>Não há pacientes sem baixa no momento.</p>'}
      <p class="rel-rodape">Controle de Pacientes</p>`;
    return { html, total: linhas.length };
  }

  function htmlRelatorioPaciente(p, evs) {
    const r = resumo({ ...p, evolucoes: evs });
    const asc = ordenarEvolucoes(evs).reverse(); // ordem cronológica
    const mudancas = mudancasCid(p, evs);
    const anos = idade(p.data_nascimento);
    const dias = diasEntre(p.data_entrada, p.data_baixa || hoje());
    const tiposVig = tiposAtuais(p, evs);
    const drg = consolidadoDrg(p, evs);
    const anosNaEntrada = idade(p.data_nascimento, p.data_entrada);
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
        <p>Emitido em ${emitidoEm()}<br>${p.data_baixa ? `Processo encerrado em ${fmtData(p.data_baixa)}` : 'Em acompanhamento'}</p>
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
        <tr>
          <th>Data de entrada</th><td>${fmtData(p.data_entrada)}</td>
          <th>Data da baixa</th><td>${p.data_baixa ? fmtData(p.data_baixa) : 'Em acompanhamento'}</td>
        </tr>
        <tr>
          <th>Situação atual</th><td><b>${esc(r.status || 'Sem evolução')}</b></td>
          <th>Tipo de alta</th><td>${p.tipo_alta ? `<b>${esc(p.tipo_alta)}</b>` : '—'}</td>
        </tr>
        <tr><th>Motivo da entrada</th><td colspan="3" class="texto">${esc(p.motivo)}</td></tr>
        <tr><th>CID de entrada</th><td colspan="3">${listaCids(p.cids_entrada, tiposEntrada(p))}</td></tr>
        <tr><th>CID atual</th><td colspan="3">${listaCids(r.cids, tiposVig)}</td></tr>
        ${p.observacoes ? `<tr><th>Observações</th><td colspan="3" class="texto">${esc(p.observacoes)}</td></tr>` : ''}
        <tr><th>Cadastrado por</th><td colspan="3">${esc(autor(p.criado_por_nome, p.criado_por_email))}${p.criado_em ? ` em ${fmtDataHora(p.criado_em)}` : ''}</td></tr>
        ${p.atualizado_em ? `<tr><th>Última alteração</th><td colspan="3">${esc(autor(p.atualizado_por_nome, p.atualizado_por_email))} em ${fmtDataHora(p.atualizado_em)}</td></tr>` : ''}
      </table>

      <h2 class="rel-secao">Resumo para codificação (DRG)</h2>
      <table class="rel-ficha">
        <tr>
          <th>Idade na entrada</th><td>${anosNaEntrada !== null ? `${anosNaEntrada} anos` : '—'}</td>
          <th>Sexo</th><td>${SEXO[p.sexo] || '—'}</td>
        </tr>
        <tr>
          <th>Permanência</th><td>${Math.max(0, dias)} dia${dias === 1 ? '' : 's'}${p.data_baixa ? '' : ' (até hoje, em aberto)'}</td>
          <th>Tipo de alta</th><td>${p.tipo_alta ? esc(p.tipo_alta) : 'Em acompanhamento'}</td>
        </tr>
        <tr><th>Diagnóstico principal</th><td colspan="3">${drg.principal ? listaSimples([drg.principal]) : '—'}</td></tr>
        <tr><th>Comorbidades</th><td colspan="3">${listaSimples(drg.comorbidades)}</td></tr>
        <tr><th>Complicações</th><td colspan="3">${listaSimples(drg.complicacoes)}</td></tr>
        <tr><th>Procedimentos</th><td colspan="3">${drg.procedimentos.length
          ? drg.procedimentos.map(pr => `<div>${fmtData(pr.data)} · ${esc(textoProcedimento(pr))}</div>`).join('')
          : 'Nenhum registrado'}</td></tr>
      </table>
      <p class="sub">Consolidado de toda a internação: complicações registradas em qualquer evolução permanecem listadas mesmo se resolvidas depois.
        O agrupamento DRG (grupo e peso) é feito pelo software agrupador.</p>

      <h2 class="rel-secao">Histórico de evolução (${evs.length} registro${evs.length === 1 ? '' : 's'})</h2>
      ${asc.length ? `
      <table class="rel-tabela">
        <thead><tr><th>Data</th><th>Situação</th><th>CID</th><th>Evolução</th><th>Registrado por</th></tr></thead>
        <tbody>
          ${asc.map(e => {
            const m = mudancas.get(e.id);
            return `
            <tr>
              <td class="nowrap">${fmtData(e.data)}</td>
              <td class="status">${esc(e.status || '—')}</td>
              <td class="cid">${e.cids?.length ? e.cids.map((c, i) => `<div><b>${esc(c)}</b>${
                  i > 0 && e.cids_tipos?.[c] ? ` <span class="sub">${e.cids_tipos[c] === 'complicacao' ? 'complic.' : 'comorb.'}</span>` : ''}</div>`).join('') : '—'}
                ${m && m.rotulo === 'Diagnóstico alterado' ? `<div class="sub"><i>${m.rotulo}</i>${m.rem.length ? `<br>saiu: ${esc(m.rem.join(', '))}` : ''}${m.add.length ? `<br>entrou: ${esc(m.add.join(', '))}` : ''}${m.novoPrincipal ? `<br>novo principal: ${esc(m.novoPrincipal)}` : ''}</div>` : ''}</td>
              <td><div class="texto">${esc(e.descricao)}</div>${e.procedimentos?.length
                ? `<div class="sub"><b>Procedimentos:</b> ${e.procedimentos.map(pr => esc(textoProcedimento(pr))).join('; ')}</div>` : ''}</td>
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
        titulo: 'Pré-visualização: pacientes sem baixa',
        info: `${total} paciente${total === 1 ? '' : 's'}`
      });
    } finally {
      botao.disabled = false;
    }
  });

  function previewPaciente() {
    const p = elDetalhe._paciente, evs = elDetalhe._evolucoes || [];
    if (!p) return;
    abrirPreview({
      html: htmlRelatorioPaciente(p, evs), orientacao: 'retrato',
      titulo: 'Pré-visualização: relatório do paciente',
      info: `${p.nome} · ${evs.length} evoluç${evs.length === 1 ? 'ão' : 'ões'}`
    });
  }

  $('#btn-preview-imprimir').addEventListener('click', () => window.print());
  $('#btn-preview-fechar').addEventListener('click', () => dlgPreview.close());
  window.addEventListener('resize', () => { if (dlgPreview.open) ajustarZoomPreview(); });

  // Ctrl+P fora da pré-visualização: relatório do paciente aberto, ou a lista
  window.addEventListener('beforeprint', () => {
    if (dlgPreview.open) return; // já preparado pela pré-visualização
    if (estado.selecionado && elDetalhe._paciente?.id === estado.selecionado) {
      prepararImpressao(htmlRelatorioPaciente(elDetalhe._paciente, elDetalhe._evolucoes || []), 'retrato');
    } else {
      prepararImpressao(htmlRelatorioLista().html, 'paisagem');
    }
  });

  elDetalhe.addEventListener('click', async ev => {
    const alvo = ev.target.closest('[data-acao]');
    if (!alvo) return;
    const acao = alvo.dataset.acao;
    if (acao === 'voltar') irPara(null);
    else if (acao === 'editar') abrirDialogo(elDetalhe._paciente);
    else if (acao === 'imprimir') previewPaciente();
    else if (acao === 'excluir-evo') {
      if (!confirm('Excluir este registro de evolução? Esta ação não pode ser desfeita.')) return;
      try {
        await db.excluirEvolucao(alvo.dataset.id);
        toast('Registro excluído.');
        await carregarPacientes();
        abrirPaciente(estado.selecionado);
      } catch (e) { toast('Erro ao excluir: ' + msgErro(e)); }
    }
  });

  elDetalhe.addEventListener('submit', async ev => {
    if (ev.target.id !== 'form-evolucao') return;
    ev.preventDefault();
    const form = ev.target;
    const fd = new FormData(form);
    const botao = form.querySelector('[type=submit]');
    botao.disabled = true;
    try {
      await db.criarEvolucao({
        paciente_id: estado.selecionado,
        data: fd.get('data'),
        status: vazioParaNull(fd.get('status')),
        descricao: fd.get('descricao').trim(),
        cids: seletorEvolucao ? seletorEvolucao.valores() : [],
        cids_tipos: seletorEvolucao ? seletorEvolucao.tipos() : {},
        procedimentos: procedimentosEvolucao ? procedimentosEvolucao.valores() : []
      });
      toast('Evolução registrada.');
      await carregarPacientes();
      await abrirPaciente(estado.selecionado);
    } catch (e) {
      toast('Erro ao salvar evolução: ' + msgErro(e));
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
      await mostrarApp(await db.sessao());
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
    $('#btn-meu-nome').title = `${u.email || ''} — clique para ${u.nome ? 'alterar' : 'definir'} seu nome nos registros`;
    $('#btn-sair').hidden = !MODO_ONLINE;
  }

  $('#btn-meu-nome').addEventListener('click', async () => {
    const atual = estado.usuario?.nome || '';
    const nome = prompt('Seu nome como aparecerá nos cadastros e evoluções (ex.: Dra. Ana Souza – CRM 12345):', atual);
    if (nome === null) return;
    try {
      await db.definirNome(nome.trim());
      estado.usuario.nome = nome.trim();
      renderUsuario();
      toast(nome.trim() ? 'Nome atualizado. Vale para os próximos registros.' : 'Nome removido; será usado o e-mail.');
    } catch (e) { toast('Erro ao salvar o nome: ' + msgErro(e)); }
  });

  $('#btn-sair').addEventListener('click', async () => {
    await db.sair();
    estado.pacientes = [];
    irPara(null);
    mostrarLogin();
  });

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
    const s = await db.sessao();
    if (s) await mostrarApp(s); else mostrarLogin();
  })();
})();
