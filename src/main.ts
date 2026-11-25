import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/sora";
import "./style.css";
import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

type Ai = { id: string; kind: string; model: string | null; label: string; images: boolean; think?: boolean };
type Msg = { role: "user" | "assistant"; text: string; images: string[]; error?: boolean; streaming?: boolean };
type Conv = { id: string | null; ai: Ai; messages: Msg[]; busy?: boolean; model?: string | null; effort?: string | null };
type Summary = { id: string; title: string; ai: string; kind: string; updated: number };
type SlashCmd = { name: string; description: string; skill: boolean };
type AiOptions = { model: string | null; effort: string | null; system: string; temperature: number | null; num_ctx: number | null };
type Usage = { label: string; percent: number; resets: string };
type ClaudeInfo = {
  commands: SlashCmd[];
  model: string | null;
  user_skills: { name: string; description: string }[];
  plugins: { id: string; name: string; enabled: boolean; skills: string[] }[];
  mcps: { name: string; status: string; source: string }[];
  usage: Usage[];
};
type OllamaInfo = { family: string; parameters: string; quantization: string; context: number | null; capabilities: string[]; size: number | null };
type Ev = { type: "delta"; text: string } | { type: "error"; text: string } | { type: "done" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Ícones num traço só (24px, stroke 2).
const svg = (d: string, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icon = {
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16),
  refresh: (s = 15) => svg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>', s),
  clip: svg('<path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>', 19),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  stop: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" rx="2.5" fill="currentColor"/></svg>',
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>', 12),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', 15),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>', 14),
  check: svg('<path d="m5 12 5 5 9-10"/>', 14),
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>', 16),
  gear: svg('<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>', 18),
  back: svg('<path d="M15 18l-6-6 6-6"/>', 18),
  command: svg('<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>', 19),
};
// Marca de cada IA no histórico.
const kindIcon: Record<string, string> = {
  ollama: svg('<rect x="6" y="6" width="12" height="12" rx="2.5"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>', 15),
  claude: svg('<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>', 15),
  gemini: svg('<path d="M12 3c.6 4.6 3.4 7.4 9 9-5.6 1.6-8.4 4.4-9 9-.6-4.6-3.4-7.4-9-9 5.6-1.6 8.4-4.4 9-9z"/>', 15),
  codex: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/>', 15),
};
const MODELS: { id: string | null; name: string; desc: string }[] = [
  { id: null, name: "Padrão", desc: "O modelo configurado no seu Claude Code" },
  { id: "opus", name: "Opus", desc: "O mais capaz, para tarefas difíceis e longas" },
  { id: "sonnet", name: "Sonnet", desc: "Equilíbrio entre qualidade e velocidade" },
  { id: "haiku", name: "Haiku", desc: "O mais rápido, para perguntas simples" },
];
// Níveis de esforço que cada ferramenta aceita (igual a `effort_levels` no backend).
function effortLevels(a: Ai | undefined): string[] {
  if (a?.kind === "claude") return ["low", "medium", "high", "xhigh", "max"];
  if (a?.kind === "codex") return ["low", "medium", "high", "xhigh"];
  if (a?.kind === "ollama" && a.think) return a.model?.startsWith("gpt-oss") ? ["off", "low", "medium", "high"] : ["off", "on"];
  return [];
}
const EFFORT: Record<string, [string, string]> = {
  low: ["low", "Responde rápido e gasta pouco do limite. Bom para perguntas simples."],
  medium: ["medium", "Equilíbrio entre rapidez e cuidado."],
  high: ["high", "Pensa mais antes de responder. Bom para código e problemas com várias etapas."],
  xhigh: ["xhigh", "Raciocínio bem mais longo. Mais lento e gasta mais do limite."],
  max: ["max", "O máximo de raciocínio. O mais lento e o que mais gasta."],
  off: ["desligado", "Responde direto, sem a etapa de raciocínio."],
  on: ["ligado", "Pensa antes de responder. Mais lento, respostas mais cuidadosas."],
};

/// Trilho "Mais rápido → Mais inteligente" com os níveis da IA. `null` = padrão da ferramenta.
function effortPicker(a: Ai, value: string | null | undefined): string {
  const levels = effortLevels(a);
  if (!levels.length) return "";
  const v = value ?? null;
  return `<div class="effort" role="radiogroup" aria-label="Esforço">
    <div class="effort-ends"><span>Mais rápido</span><span>Mais inteligente</span></div>
    <div class="effort-track" style="--n:${levels.length}">${levels
      .map((l) => `<button type="button" role="radio" data-effort="${l}" aria-checked="${l === v}"><i></i><span>${EFFORT[l][0]}</span></button>`)
      .join("")}</div>
    <p class="effort-note">${v ? `${esc(EFFORT[v][1])} <button type="button" class="link" data-effort="">Usar o padrão</button>` : "Padrão: a própria ferramenta decide."}</p></div>`;
}

function bindEffort(root: HTMLElement, onPick: (e: string | null) => void) {
  root.querySelectorAll<HTMLButtonElement>("[data-effort]").forEach((b) => (b.onclick = () => onPick(b.dataset.effort || null)));
}
const logo = (cls: string) => `<svg class="logo ${cls}" viewBox="0 0 100 100" aria-hidden="true"><use href="#saturno"/></svg>`;

const KIND: Record<string, string> = { ollama: "Ollama", claude: "Claude Code", gemini: "Gemini CLI", codex: "OpenAI Codex" };
const INSTALL: Record<string, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code",
  gemini: "https://github.com/google-gemini/gemini-cli",
  codex: "https://github.com/openai/codex",
};
const WINDOWS = navigator.userAgent.includes("Windows");

let ais: Ai[] = [];
let scanning = true;
let ollamaInstalled = false;
let summaries: Summary[] = [];
let current: Conv | null = null;
let pending: { data: string }[] = [];
let slashCmds: SlashCmd[] | null = null; // comandos e skills do Claude Code; null enquanto carrega
let claudeModel: string | null = null;
let claudeInfo: ClaudeInfo | null = null;
let usage: Usage[] = [];
let options: Record<string, AiOptions> = {};
let settingsTab: string | null = null; // aba aberta das configurações; null = fechadas
let slashItems: SlashCmd[] = [];
let slashActive = 0;

const els = {
  ais: $("ais"),
  convs: $("convs"),
  convsGroup: $("convs-group"),
  thread: $("thread"),
  scroll: $("scroll"),
  top: $("top"),
  title: $("title"),
  input: $<HTMLTextAreaElement>("input"),
  send: $<HTMLButtonElement>("send"),
  attach: $<HTMLButtonElement>("attach"),
  file: $<HTMLInputElement>("file"),
  attachments: $("attachments"),
  composer: $<HTMLFormElement>("composer"),
  kbd: $("kbd-hint"),
  drop: $("drop"),
  hint: $("ollama-hint"),
  slash: $("slash"),
  panel: $("panel"),
  cmds: $<HTMLButtonElement>("cmds"),
  confirm: $<HTMLDialogElement>("confirm"),
  newBtn: $<HTMLButtonElement>("new"),
};

els.newBtn.innerHTML = `${icon.plus}<span>Nova conversa</span>`;
$("rescan").innerHTML = icon.refresh();
els.attach.innerHTML = icon.clip;
els.cmds.innerHTML = icon.command;

// ---------- tema ----------

function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("orbia.tema", t);
  document.querySelectorAll<HTMLButtonElement>(".theme-card").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.t === t));
  });
}
setTheme(localStorage.getItem("orbia.tema") ?? "roxo");

// ---------- markdown ----------

marked.use({ gfm: true, breaks: true });

function md(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "img", "form", "input"], FORBID_ATTR: ["style"] });
}

function decorateCode(root: HTMLElement) {
  root.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    let lang = code?.className.match(/language-([\w+-]+)/)?.[1] ?? "";
    if (code) {
      // O highlight.js escapa o texto; o resultado só tem <span class="hljs-…">.
      const text = code.textContent ?? "";
      if (hljs.getLanguage(lang)) code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      else if (text.length < 20000) {
        const r = hljs.highlightAuto(text);
        if (r.language && r.relevance > 4) {
          code.innerHTML = r.value;
          lang ||= r.language;
        }
      }
    }
    lang ||= "código";
    const wrap = document.createElement("div");
    wrap.className = "code";
    wrap.innerHTML = `<div class="code-head"><span>${esc(lang)}</span><button type="button" class="copy">${icon.copy}<span>Copiar</span></button></div>`;
    pre.replaceWith(wrap);
    wrap.append(pre);
  });
}

// ---------- barra lateral ----------

function aiSub(a: Ai) {
  return a.kind === "ollama" && a.images ? "Ollama · aceita imagens" : KIND[a.kind];
}

function renderSide() {
  els.newBtn.hidden = !current;
  if (scanning) {
    els.ais.innerHTML = `<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton short"></li>`;
  } else if (!ais.length) {
    els.ais.innerHTML = `<li class="empty-row">Nenhuma encontrada.</li>`;
  } else {
    els.ais.innerHTML = ais
      .map(
        (a, i) => `<li><button type="button" class="ai" data-i="${i}" aria-current="${current?.ai.id === a.id}">
          <span class="dot"></span><span class="ai-text"><span class="name">${esc(a.label)}</span><span class="meta">${esc(aiSub(a))}</span></span>
        </button></li>`,
      )
      .join("");
    els.ais.querySelectorAll<HTMLButtonElement>(".ai").forEach((b) => (b.onclick = () => pickAi(ais[+b.dataset.i!])));
  }
  const noModels = !scanning && ollamaInstalled && ais.length > 0 && !ais.some((a) => a.kind === "ollama");
  els.hint.hidden = !noModels;
  if (noModels) els.hint.innerHTML = `O Ollama está instalado, mas sem modelos. Baixe um com <code>ollama pull llama3.2</code>`;

  els.convsGroup.hidden = !scanning && !ais.length && !summaries.length;
  els.convs.innerHTML = summaries.length
    ? summaries
        .map(
          (s, i) => `<li class="conv"><button type="button" class="conv-item" data-i="${i}" aria-current="${current?.id === s.id}" title="Conversa com ${esc(s.ai)}">
            <span class="conv-ai" aria-label="${esc(s.ai)}">${kindIcon[s.kind] ?? ""}</span><span class="name">${esc(s.title)}</span><span class="when">${when(s.updated)}</span></button>
            <button type="button" class="icon-btn small del" data-i="${i}" aria-label="Apagar conversa" title="Apagar conversa">${icon.trash}</button></li>`,
        )
        .join("")
    : `<li class="empty-row">Nenhuma ainda. Elas aparecem aqui.</li>`;
  els.convs.querySelectorAll<HTMLButtonElement>(".conv-item").forEach((b) => (b.onclick = () => openConv(summaries[+b.dataset.i!].id)));
  els.convs.querySelectorAll<HTMLButtonElement>(".del").forEach((b) => (b.onclick = () => deleteConv(summaries[+b.dataset.i!])));
}

function when(ms: number) {
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 864e5);
  if (diff <= 0) return "hoje";
  if (diff === 1) return "ontem";
  if (diff < 7) return d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
  return d.toLocaleDateString("pt-BR", { day: "numeric", month: "short" }).replace(".", "");
}

// ---------- área principal ----------

function renderTop() {
  els.top.classList.toggle("bare", !current && !settingsTab);
  $("gear").classList.toggle("on", !!settingsTab);
  if (settingsTab) {
    els.title.innerHTML = `<button type="button" class="icon-btn back" id="back" aria-label="Voltar para a conversa" title="Voltar">${icon.back}</button>
      <strong>Configurações</strong><span class="pill">${current ? `${esc(current.ai.label)} · ${esc(KIND[current.ai.kind])}` : "Orbia"}</span>`;
    $("back").onclick = closeSettings;
    return;
  }
  els.title.innerHTML = current
    ? `<strong>${esc(current.ai.label)}</strong><span class="pill">${esc(KIND[current.ai.kind])} · ${
        [current.model ? MODELS.find((m) => m.id === current!.model)?.name ?? current.model : "", current.effort ? `esforço ${EFFORT[current.effort]?.[0] ?? current.effort}` : ""]
          .filter(Boolean)
          .join(" · ") || (current.ai.kind === "ollama" ? "roda no seu PC" : "usa sua conta")
      }</span>`
    : "";
}

function msgEl(m: Msg): HTMLElement {
  const el = document.createElement("article");
  el.className = `msg ${m.role}${m.error ? " error" : ""}`;
  if (m.images.length) {
    const g = document.createElement("div");
    g.className = "imgs";
    for (const src of m.images) {
      const img = new Image();
      img.src = src;
      img.alt = "Imagem anexada";
      g.append(img);
    }
    el.append(g);
  }
  const body = document.createElement("div");
  body.className = "body";
  fillBody(body, m);
  if (m.text || m.role === "assistant") el.append(body);
  return el;
}

function fillBody(body: HTMLElement, m: Msg) {
  if (m.error) {
    body.innerHTML = `<div class="err-head">${icon.alert}<span>A ferramenta devolveu um erro</span></div><pre class="err-text"></pre>`;
    body.querySelector(".err-text")!.textContent = m.text;
  } else if (m.role === "user") {
    body.textContent = m.text;
  } else {
    body.innerHTML = md(m.text);
    decorateCode(body);
    if (m.streaming) {
      const tail = m.text ? `<span class="caret"></span>` : `<span class="thinking"><i></i><i></i><i></i></span>`;
      (body.lastElementChild && body.lastElementChild.tagName === "P" ? body.lastElementChild : body).insertAdjacentHTML("beforeend", tail);
    }
  }
}

function renderThread() {
  const t = els.thread;
  t.innerHTML = "";
  t.className = "thread";
  els.composer.hidden = !current || !!settingsTab;
  if (settingsTab) {
    t.className = "thread settings-wrap";
    t.append(settingsView());
    return;
  }
  if (!current) {
    t.append(scanning ? scanState() : ais.length ? pickerState() : emptyState());
    return;
  }
  if (!current.messages.length) {
    const hello = document.createElement("div");
    hello.className = "hello";
    hello.innerHTML = `${logo("hero")}<h1>${esc(current.ai.label)}</h1><p>${esc(KIND[current.ai.kind])}. ${
      current.ai.images ? "Escreva uma mensagem ou anexe uma imagem para começar." : "Escreva uma mensagem para começar."
    }</p>`;
    t.append(hello);
  }
  for (const m of current.messages) t.append(msgEl(m));
  els.kbd.textContent = `Enter envia · Shift+Enter quebra a linha${
    current.ai.kind === "ollama" ? " · tudo roda no seu computador" : current.ai.kind === "claude" ? " · / mostra as skills" : ""
  }`;
  updateComposer();
  els.scroll.scrollTop = els.scroll.scrollHeight;
}

function scanState(): HTMLElement {
  const d = document.createElement("div");
  d.className = "center";
  d.innerHTML = `${logo("hero spin")}<h1>Procurando IAs no seu PC…</h1><p>Ollama, Claude Code, Gemini CLI e Codex.</p>`;
  return d;
}

function pickerState(): HTMLElement {
  const d = document.createElement("div");
  d.className = "center picker";
  const allLocal = ais.every((a) => a.kind === "ollama");
  const n = ais.length;
  const missing = ["claude", "gemini", "codex"].filter((k) => !ais.some((a) => a.kind === k));
  d.innerHTML = `<div class="picker-head">${logo("hero")}
      <h1>Com qual IA você quer conversar?</h1>
      <p>${n === 1 ? "Encontramos 1" : `Encontramos ${n}`} no seu computador.${allLocal ? " Nada sai daqui." : ""}</p></div>
    <div class="cards">${ais
      .map((a, i) => {
        const tags = [a.images ? "aceita imagens" : "", a.kind === "ollama" ? "local" : "sua conta"].filter(Boolean);
        return `<button type="button" class="card" data-i="${i}">
          <span class="card-head"><span class="letter">${esc(a.label[0].toUpperCase())}</span>
          <span class="ai-text"><span class="name">${esc(a.label)}</span><span class="meta">${esc(KIND[a.kind])}</span></span></span>
          <span class="tags">${tags.map((t) => `<span>${t}</span>`).join("")}</span></button>`;
      })
      .join("")}</div>
    ${
      missing.length
        ? `<p class="missing">${missing.map((k) => `<a href="${INSTALL[k]}">${KIND[k].replace("OpenAI ", "")}</a>`).join(", ")} ${
            missing.length === 1 ? "não foi encontrado." : "não foram encontrados."
          } O link mostra como instalar.</p>`
        : ""
    }`;
  d.querySelectorAll<HTMLButtonElement>(".card").forEach((b) => (b.onclick = () => pickAi(ais[+b.dataset.i!])));
  return d;
}

function cmdBox(cmd: string) {
  return `<div class="cmd"><code>${esc(cmd)}</code><button type="button" class="copy plain">Copiar</button></div>`;
}

function emptyState(): HTMLElement {
  const d = document.createElement("div");
  d.className = "onboard";
  const install = ollamaInstalled
    ? ""
    : WINDOWS
      ? `<li><span class="num">1</span><div><span class="step">Instale o Ollama</span><span class="note">Baixe o instalador em <a href="https://ollama.com/download">ollama.com/download</a> e abra.</span></div></li>`
      : `<li><span class="num">1</span><div><span class="step">Instale o Ollama</span>${cmdBox("curl -fsSL https://ollama.com/install.sh | sh")}<span class="note">No Windows: baixe o instalador em ollama.com/download.</span></div></li>`;
  d.innerHTML = `<div class="onboard-head">${logo("hero empty")}
      <h1>Nenhuma IA no seu computador ainda</h1>
      <p>${
        ollamaInstalled
          ? "O Ollama está instalado, mas ainda não tem nenhum modelo. Baixe um e ele aparece aqui."
          : "O Orbia conversa com as IAs que já estão instaladas. O jeito mais rápido de ter uma é o Ollama, que roda modelos aqui mesmo, sem internet depois do download."
      }</p></div>
    <ol class="steps">${install}
      <li><span class="num">${ollamaInstalled ? 1 : 2}</span><div><span class="step">Baixe um modelo (uns 2 GB)</span>${cmdBox("ollama pull llama3.2")}</div></li>
    </ol>
    <div class="onboard-foot"><button type="button" class="btn" id="again">${icon.refresh(16)}<span>Procurar de novo</span></button>
      <span>Também funciona com Claude Code, Gemini CLI e Codex.</span></div>`;
  d.querySelector<HTMLButtonElement>("#again")!.onclick = rescan;
  return d;
}

function updateComposer() {
  const busy = !!current?.busy;
  els.send.innerHTML = busy ? `${icon.stop}<span>Parar</span>` : icon.up;
  els.send.setAttribute("aria-label", busy ? "Parar" : "Enviar");
  els.send.classList.toggle("stop", busy);
  els.send.disabled = !busy && !els.input.value.trim() && !pending.length;
  els.cmds.hidden = !(current?.ai.kind === "claude" || effortLevels(current?.ai).length);
  const canImg = !!current?.ai.images;
  els.attach.disabled = !canImg;
  els.attach.title = canImg ? "Anexar imagem" : `${current?.ai.label ?? "Esta IA"} não aceita imagens`;
  els.attachments.innerHTML = "";
  pending.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    const img = new Image();
    img.src = p.data;
    img.alt = "Anexo";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", "Remover anexo");
    rm.innerHTML = icon.x;
    rm.onclick = () => {
      pending.splice(i, 1);
      updateComposer();
    };
    d.append(img, rm);
    els.attachments.append(d);
  });
}

function renderAll() {
  closeSlash();
  closePanel();
  renderSide();
  renderTop();
  renderThread();
}

// ---------- ações ----------

async function rescan() {
  scanning = true;
  renderSide();
  if (!current) renderThread();
  const r = await invoke<{ ais: Ai[]; ollama_installed: boolean }>("scan");
  ais = r.ais;
  ollamaInstalled = r.ollama_installed;
  scanning = false;
  renderAll();
  if (ais.some((a) => a.kind === "claude")) {
    slashCmds = null;
    loadClaudeInfo();
  }
}

/// Lista de skills, plugins e MCPs do Claude Code (roda `/cost` local; leva alguns segundos).
async function loadClaudeInfo() {
  const r = await invoke<ClaudeInfo>("commands");
  claudeInfo = r;
  slashCmds = r.commands;
  claudeModel = r.model;
  usage = r.usage;
  renderUsage();
  updateSlash();
  if (settingsTab && current?.ai.kind === "claude") renderThread();
}

async function loadSummaries() {
  summaries = await invoke<Summary[]>("list_conversations");
  renderSide();
}

function pickAi(a: Ai) {
  const model = options[a.id]?.model ?? null;
  const effort = options[a.id]?.effort ?? null;
  if (current && !current.id && !current.busy) Object.assign(current, { ai: a, model, effort });
  else current = { id: null, ai: a, messages: [], model, effort };
  if (!a.images) pending = [];
  // Com as configurações abertas, trocar de IA mostra as configurações da nova IA.
  if (settingsTab && !tabsFor(a).some(([id]) => id === settingsTab)) settingsTab = "geral";
  renderAll();
  if (!settingsTab) els.input.focus();
}

async function openConv(id: string) {
  if (current?.id === id) return;
  const c = await invoke<Conv>("load_conversation", { id });
  current = { id: c.id, ai: c.ai, messages: c.messages, model: c.model, effort: c.effort };
  pending = [];
  settingsTab = null;
  renderAll();
}

function ask(text: string, title = "Apagar esta conversa?", okLabel = "Apagar conversa"): Promise<boolean> {
  $("confirm-title").textContent = title;
  els.confirm.querySelector<HTMLButtonElement>(".btn-danger")!.textContent = okLabel;
  $("confirm-text").textContent = text;
  els.confirm.returnValue = "";
  els.confirm.showModal();
  return new Promise((ok) => els.confirm.addEventListener("close", () => ok(els.confirm.returnValue === "ok"), { once: true }));
}
// Clique fora da caixa cancela.
els.confirm.addEventListener("click", (e) => {
  if (e.target === els.confirm) els.confirm.close("cancel");
});

async function deleteConv(s: Summary) {
  if (!(await ask(`“${s.title}” e as imagens anexadas a ela saem do seu computador. Não dá para desfazer.`))) return;
  await invoke("delete_conversation", { id: s.id });
  if (current?.id === s.id) current = null;
  await loadSummaries();
  renderAll();
}

async function send() {
  const conv = current;
  if (!conv) return;
  if (conv.busy) {
    if (conv.id) await invoke("stop", { id: conv.id });
    return;
  }
  const text = els.input.value.trim();
  if (!text && !pending.length) return;
  const images = pending;
  const reply: Msg = { role: "assistant", text: "", images: [], streaming: true };
  conv.messages.push({ role: "user", text, images: images.map((p) => p.data) }, reply);
  conv.busy = true;
  els.input.value = "";
  autosize();
  pending = [];
  renderThread();

  let frame = 0;
  const paint = () => {
    frame = 0;
    if (current !== conv) return;
    const body = els.thread.querySelectorAll<HTMLElement>(".msg.assistant .body");
    const last = body[body.length - 1];
    if (last) fillBody(last, reply);
    if (els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 160) els.scroll.scrollTop = els.scroll.scrollHeight;
  };
  const ch = new Channel<Ev>();
  ch.onmessage = (ev) => {
    if (ev.type === "delta") {
      reply.text += ev.text;
      if (!frame) frame = requestAnimationFrame(paint);
      return;
    }
    if (ev.type === "error") {
      conv.messages.push({ role: "assistant", text: ev.text, images: [], error: true });
    } else {
      reply.streaming = false;
      conv.busy = false;
      if (!reply.text) conv.messages.splice(conv.messages.indexOf(reply), 1);
      loadSummaries();
      if (conv.ai.kind === "claude") loadUsage();
    }
    if (current === conv) renderThread();
  };
  try {
    conv.id = await invoke<string>("send", { convId: conv.id, ai: conv.ai, text, images, model: conv.model ?? null, effort: conv.effort ?? null, onEvent: ch });
    loadSummaries();
  } catch (e) {
    conv.busy = false;
    conv.messages.splice(conv.messages.indexOf(reply), 1);
    conv.messages.push({ role: "assistant", text: String(e), images: [], error: true });
    if (current === conv) renderThread();
  }
}

// ---------- anexos ----------

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function addFiles(files: Iterable<File>) {
  if (!current?.ai.images) return;
  for (const f of files) {
    if (!ACCEPTED.includes(f.type)) continue;
    const r = new FileReader();
    r.onload = () => {
      pending.push({ data: r.result as string });
      updateComposer();
    };
    r.readAsDataURL(f);
  }
}

els.attach.onclick = () => els.file.click();
els.file.onchange = () => {
  addFiles(els.file.files ?? []);
  els.file.value = "";
};
// Colar imagem (print, imagem copiada de outro app) vira anexo, igual a escolher o arquivo.
document.addEventListener("paste", async (e) => {
  if (!current || els.composer.hidden) return;
  const dt = e.clipboardData;
  const files = [...(dt?.items ?? [])]
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
  const hasImage = files.length > 0 || !!dt?.types.some((t) => t.startsWith("image/") || t === "Files");
  const hasText = !!dt?.types.includes("text/plain") && !!dt.getData("text/plain");
  if (!hasImage && hasText) return; // texto comum: deixa o navegador colar
  if (!current.ai.images) {
    if (hasImage) flash(`${current.ai.label} não aceita imagens`);
    return;
  }
  e.preventDefault();
  if (files.length) return addFiles(files);
  // O WebKitGTK nem sempre entrega a imagem no evento; o backend lê a área de transferência do sistema.
  const data = await invoke<string | null>("clipboard_image");
  if (data) {
    pending.push({ data });
    updateComposer();
    els.input.focus();
  } else if (hasImage) flash("Não consegui ler a imagem copiada");
});

function flash(text: string) {
  els.kbd.textContent = text;
  els.kbd.classList.add("warn");
  setTimeout(() => {
    els.kbd.classList.remove("warn");
    if (current) renderThread();
  }, 2400);
}
let dragDepth = 0;
const main = document.querySelector<HTMLElement>(".main")!;
main.addEventListener("dragenter", (e) => {
  if (!current?.ai.images || !e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  els.drop.hidden = false;
});
main.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    els.drop.hidden = true;
  }
});
main.addEventListener("dragover", (e) => e.preventDefault());
main.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.hidden = true;
  addFiles(e.dataTransfer?.files ?? []);
});

// ---------- menu de comandos com / ----------

function updateSlash() {
  const m = current?.ai.kind === "claude" ? els.input.value.match(/^\/(\S*)$/) : null;
  if (!m) return closeSlash();
  const q = m[1].toLowerCase();
  if (slashCmds) {
    const rank = (c: SlashCmd) => {
      const n = c.name.toLowerCase();
      const short = n.includes(":") ? n.split(":")[1] : n;
      return n.startsWith(q) || short.startsWith(q) ? 0 : n.includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : 3;
    };
    slashItems = slashCmds.filter((c) => c.skill).map((c) => ({ c, r: rank(c) })).filter((x) => x.r < 3).sort((a, b) => a.r - b.r).map((x) => x.c);
    if (!slashItems.length) return closeSlash();
    slashActive = Math.min(slashActive, slashItems.length - 1);
  }
  els.slash.innerHTML = slashCmds
    ? slashItems
        .map((c, i) => {
          const [ns, name] = c.name.includes(":") ? [c.name.split(":")[0] + ":", c.name.split(":")[1]] : ["", c.name];
          return `<div class="slash-item" role="option" id="slash-${i}" data-i="${i}" aria-selected="${i === slashActive}">
            <span class="slash-name">/${ns ? `<span class="ns">${esc(ns)}</span>` : ""}${esc(name)}</span>
            <span class="slash-desc">${esc(c.description)}</span></div>`;
        })
        .join("")
    : `<div class="slash-loading">Carregando as skills do Claude Code…</div>`;
  els.slash.hidden = false;
  els.input.setAttribute("aria-expanded", "true");
  els.input.setAttribute("aria-activedescendant", slashCmds ? `slash-${slashActive}` : "");
  els.slash.querySelector(`#slash-${slashActive}`)?.scrollIntoView({ block: "nearest" });
}

function closeSlash() {
  els.slash.hidden = true;
  slashItems = [];
  slashActive = 0;
  els.input.setAttribute("aria-expanded", "false");
  els.input.removeAttribute("aria-activedescendant");
}

function pickSlash(i: number) {
  const c = slashItems[i];
  if (!c) return;
  els.input.value = `/${c.name} `;
  closeSlash();
  autosize();
  updateComposer();
  els.input.focus();
}

els.slash.addEventListener("mousedown", (e) => e.preventDefault()); // não tira o foco do campo
els.slash.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>(".slash-item");
  if (item) pickSlash(+item.dataset.i!);
});
els.input.addEventListener("blur", closeSlash);

// ---------- configurações ----------

const THEMES: [string, string][] = [
  ["roxo", "Roxo"],
  ["azul", "Azul"],
  ["branco", "Branco"],
  ["preto", "Preto"],
];
let editing: { name: string; isNew: boolean; content: string } | null = null;

function tabsFor(a: Ai | undefined): [string, string][] {
  if (a?.kind === "claude") return [["geral", "Geral"], ["skills", "Skills"], ["plugins", "Plugins"], ["mcps", "MCPs"], ["regras", "Regras"]];
  if (a?.kind === "ollama") return [["geral", "Geral"], ["modelo", "Modelo"]];
  return [["geral", "Geral"]];
}

function openSettings() {
  settingsTab = "geral";
  editing = null;
  renderAll();
}

function closeSettings() {
  settingsTab = null;
  editing = null;
  renderAll();
}

function opts(): AiOptions {
  return { model: null, effort: null, system: "", temperature: null, num_ctx: null, ...(current ? options[current.ai.id] : {}) };
}

async function saveDefaultEffort(e: string | null) {
  await saveOpts({ effort: e });
  if (current && !current.id) current.effort = e;
  renderTop();
}

async function saveOpts(patch: Partial<AiOptions>) {
  if (!current) return;
  options[current.ai.id] = await invoke<AiOptions>("set_options", { aiId: current.ai.id, options: { ...opts(), ...patch } });
}

/// Mostra o resultado de uma ação ao lado do botão.
function status(el: Element | null, text: string, kind: "ok" | "err" | "" = "") {
  if (!el) return;
  el.textContent = text;
  el.className = `s-status ${kind}`;
}

function settingsView(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings";
  const tabs = tabsFor(current?.ai);
  wrap.innerHTML = `<nav class="tabs" role="tablist" aria-label="Seções">${tabs
    .map(([id, name]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${id === settingsTab}">${name}</button>`)
    .join("")}</nav><div class="tab-body" role="tabpanel"></div>`;
  wrap.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        settingsTab = b.dataset.tab!;
        editing = null;
        renderThread();
      }),
  );
  const body = wrap.querySelector<HTMLElement>(".tab-body")!;
  const render: Record<string, (b: HTMLElement) => unknown> = { geral: tabGeral, skills: tabSkills, plugins: tabSkills, mcps: tabMcps, regras: tabRegras, modelo: tabModelo };
  render[settingsTab ?? "geral"]?.(body);
  return wrap;
}

function tabGeral(body: HTMLElement) {
  const a = current?.ai;
  const o = opts();
  body.innerHTML = `<section class="s-card"><h3>Tema</h3><p class="p-help">Vale para o app todo.</p>
    <div class="theme-grid" role="radiogroup" aria-label="Tema">${THEMES.map(
      ([id, name]) => `<button type="button" role="radio" class="theme-card" data-t="${id}" aria-checked="${document.documentElement.dataset.theme === id}">
        <span class="theme-swatch t-${id}"><i></i><i></i><i></i></span><span>${name}</span></button>`,
    ).join("")}</div></section>
    ${
      a?.kind === "claude"
        ? `<section class="s-card"><h3>Modelo padrão</h3><p class="p-help">Usado nas conversas novas com o Claude. Em cada conversa dá para trocar pelo botão ⌘ ao lado do clipe.</p>
        <div class="models">${MODELS.map(
          (m) => `<button type="button" class="model" data-model="${m.id ?? ""}" aria-pressed="${m.id === o.model}">
            <span class="p-name">${m.name}</span><span class="p-desc">${m.id ? m.desc : esc(claudeModel ? `${m.desc}: ${claudeModel}` : m.desc)}</span></button>`,
        ).join("")}</div></section>
      <section class="s-card"><h3>Esforço padrão</h3><p class="p-help">Quanto o Claude pensa antes de responder, nas conversas novas. Em cada conversa dá para trocar pelo botão ⌘.</p>
        <div id="def-effort">${effortPicker(a, o.effort)}</div></section>
      <section class="s-card"><h3>Instrução extra</h3><p class="p-help">O Orbia acrescenta este texto às instruções do Claude, só nas conversas feitas aqui. Para valer também no terminal, use a aba Regras.</p>
        <textarea class="s-text" id="opt-system" rows="4" placeholder="Ex.: Responda sempre em português, de forma curta."></textarea>
        <div class="s-row"><button type="button" class="btn-sm primary" id="save-system">Salvar</button><span class="s-status"></span></div></section>`
        : ""
    }
    ${
      a?.kind === "codex"
        ? `<section class="s-card"><h3>Esforço padrão</h3><p class="p-help">Quanto o Codex pensa antes de responder, nas conversas novas.</p><div id="def-effort">${effortPicker(a, o.effort)}</div></section>`
        : ""
    }
    ${
      a && (a.kind === "gemini" || a.kind === "codex")
        ? `<section class="s-card"><h3>${esc(KIND[a.kind])}</h3><p class="p-help">Skills, MCPs e regras do ${esc(KIND[a.kind])} ainda não aparecem aqui. Por enquanto, eles ficam em <code>${
            a.kind === "gemini" ? "~/.gemini/settings.json" : "~/.codex/config.toml"
          }</code>.</p></section>`
        : ""
    }`;
  body.querySelectorAll<HTMLButtonElement>(".theme-card").forEach((b) => (b.onclick = () => setTheme(b.dataset.t!)));
  body.querySelectorAll<HTMLButtonElement>(".model").forEach(
    (b) =>
      (b.onclick = async () => {
        await saveOpts({ model: b.dataset.model || null });
        if (current && !current.id) current.model = options[current.ai.id].model;
        renderAll();
      }),
  );
  const def = body.querySelector<HTMLElement>("#def-effort");
  if (def) bindEffort(def, (e) => saveDefaultEffort(e).then(() => renderThread()));
  const sys = body.querySelector<HTMLTextAreaElement>("#opt-system");
  if (sys) {
    sys.value = o.system;
    body.querySelector<HTMLButtonElement>("#save-system")!.onclick = async (e) => {
      const st = (e.currentTarget as HTMLElement).nextElementSibling;
      try {
        await saveOpts({ system: sys.value });
        status(st, "Salvo. Vale a partir da próxima mensagem.", "ok");
      } catch (err) {
        status(st, String(err), "err");
      }
    };
  }
}

async function tabModelo(body: HTMLElement) {
  const a = current!.ai;
  const o = opts();
  body.innerHTML = `<section class="s-card"><h3>${esc(a.label)}</h3><div class="facts" id="facts"><span class="muted">Lendo os detalhes do modelo…</span></div></section>
    ${
      effortLevels(a).length
        ? `<section class="s-card"><h3>Raciocínio padrão</h3><p class="p-help">Este modelo sabe pensar antes de responder. Vale para as conversas novas; em cada conversa dá para trocar pelo botão ⌘.</p><div id="def-effort">${effortPicker(a, o.effort)}</div></section>`
        : ""
    }
    <section class="s-card"><h3>Instrução de sistema</h3><p class="p-help">Vai no começo de toda conversa com este modelo, como uma regra de comportamento.</p>
      <textarea class="s-text" id="opt-system" rows="4" placeholder="Ex.: Você é um assistente que responde em português, em poucas linhas."></textarea>
      <div class="s-row"><button type="button" class="btn-sm primary" id="save-system">Salvar</button><span class="s-status"></span></div></section>
    <section class="s-card"><h3>Criatividade (temperatura)</h3><p class="p-help">Mais baixo: respostas mais previsíveis. Mais alto: mais variadas.</p>
      <div class="s-row"><input type="range" id="opt-temp" min="0" max="2" step="0.1" aria-label="Temperatura"><output id="temp-out"></output>
      <button type="button" class="btn-sm" id="temp-reset">Usar o padrão do modelo</button></div></section>
    <section class="s-card"><h3>Memória da conversa (contexto)</h3><p class="p-help">Quanto texto o modelo consegue considerar de uma vez. Mais contexto usa mais memória RAM.</p>
      <select class="s-select" id="opt-ctx" aria-label="Tamanho do contexto"></select><span class="s-status" id="ctx-status"></span></section>`;
  const def = body.querySelector<HTMLElement>("#def-effort");
  if (def) bindEffort(def, (e) => saveDefaultEffort(e).then(() => renderThread()));
  const sys = body.querySelector<HTMLTextAreaElement>("#opt-system")!;
  sys.value = o.system;
  body.querySelector<HTMLButtonElement>("#save-system")!.onclick = async (e) => {
    const st = (e.currentTarget as HTMLElement).nextElementSibling;
    await saveOpts({ system: sys.value }).then(() => status(st, "Salvo. Vale a partir da próxima mensagem.", "ok"), (err) => status(st, String(err), "err"));
  };
  const temp = body.querySelector<HTMLInputElement>("#opt-temp")!;
  const out = body.querySelector<HTMLOutputElement>("#temp-out")!;
  const showTemp = (t: number | null) => {
    temp.value = String(t ?? 0.8);
    out.textContent = t == null ? "padrão do modelo" : t.toFixed(1);
  };
  showTemp(o.temperature);
  temp.oninput = () => (out.textContent = Number(temp.value).toFixed(1));
  temp.onchange = () => saveOpts({ temperature: Number(temp.value) });
  body.querySelector<HTMLButtonElement>("#temp-reset")!.onclick = () => saveOpts({ temperature: null }).then(() => showTemp(null));

  const info = await invoke<OllamaInfo>("ollama_info", { model: a.model });
  if (settingsTab !== "modelo" || current?.ai.id !== a.id) return;
  const gb = (n: number) => `${(n / 1e9).toFixed(1).replace(".", ",")} GB`;
  const facts: [string, string][] = [
    ["Família", info.family],
    ["Parâmetros", info.parameters],
    ["Quantização", info.quantization],
    ["Tamanho no disco", info.size ? gb(info.size) : ""],
    ["Contexto máximo", info.context ? info.context.toLocaleString("pt-BR") : ""],
    ["Capacidades", info.capabilities.map((c) => ({ completion: "texto", vision: "imagens", tools: "ferramentas", thinking: "raciocínio", embedding: "embeddings" })[c] ?? c).join(", ")],
  ];
  body.querySelector("#facts")!.innerHTML = facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><span>${k}</span><strong>${esc(v)}</strong></div>`)
    .join("");
  const ctx = body.querySelector<HTMLSelectElement>("#opt-ctx")!;
  const sizes = [2048, 4096, 8192, 16384, 32768, 65536, 131072].filter((n) => !info.context || n <= info.context);
  ctx.innerHTML = `<option value="">Padrão do modelo</option>${sizes.map((n) => `<option value="${n}">${n.toLocaleString("pt-BR")} tokens</option>`).join("")}`;
  ctx.value = o.num_ctx ? String(o.num_ctx) : "";
  ctx.onchange = () =>
    saveOpts({ num_ctx: ctx.value ? Number(ctx.value) : null }).then(
      () => status(body.querySelector("#ctx-status"), "Salvo.", "ok"),
      (err) => status(body.querySelector("#ctx-status"), String(err), "err"),
    );
}

function needInfo(body: HTMLElement): boolean {
  if (claudeInfo) return true;
  body.innerHTML = `<section class="s-card"><p class="p-help">Lendo a configuração do Claude Code…</p></section>`;
  return false;
}

function chips(list: string[], max = 10) {
  const shown = list.slice(0, max).map((n) => `<span class="chip">${esc(n)}</span>`).join("");
  return shown + (list.length > max ? `<span class="chip more">+${list.length - max}</span>` : "");
}

function tabSkills(body: HTMLElement) {
  if (editing) return skillEditor(body);
  if (!needInfo(body)) return;
  const info = claudeInfo!;
  const mine = new Set(info.user_skills.map((s) => s.name));
  const builtin = info.commands.filter((c) => c.skill && !c.name.includes(":") && !mine.has(c.name)).map((c) => c.name);
  const pluginsTab = settingsTab === "plugins";
  body.innerHTML = `<div class="s-toolbar"><input type="search" class="s-input" id="skill-q" placeholder="${pluginsTab ? "Procurar plugin…" : "Procurar skill…"}" aria-label="Procurar">
      ${pluginsTab ? "" : `<button type="button" class="btn-sm primary" id="new-skill">Nova skill</button>`}</div>
${pluginsTab ? `
    <section class="s-card"><h3>Instalar plugin</h3><p class="p-help">Plugins trazem skills, comandos e MCPs prontos. Eles vêm de lojas: adicione a loja uma vez e depois instale os plugins dela.</p>
      <div class="s-form">
        <label class="s-label" for="mk-src">Loja</label><div class="s-inline"><input class="s-input" id="mk-src" placeholder="dono/repositório do GitHub, URL ou pasta" autocomplete="off" spellcheck="false"><button type="button" class="btn-sm" id="mk-add">Adicionar loja</button></div>
        <label class="s-label" for="pl-id">Plugin</label><div class="s-inline"><input class="s-input" id="pl-id" placeholder="nome@loja" autocomplete="off" spellcheck="false"><button type="button" class="btn-sm primary" id="pl-install">Instalar</button></div>
      </div><div class="s-row"><span class="s-status" id="pl-status"></span></div></section>
    <section class="s-card"><h3>Plugins <span class="count">${info.plugins.length}</span></h3>
      <p class="p-help">Desativar um plugin tira as skills, comandos e MCPs dele, no terminal e aqui.</p>
      <div class="s-list">${info.plugins
        .map(
          (p) => `<div class="s-item" data-q="${esc((p.name + " " + p.skills.join(" ")).toLowerCase())}"><div class="s-main"><span class="p-name">${esc(p.name)} <span class="faint">${esc(p.id.split("@")[1] ?? "")}</span></span>
            <span class="chips">${p.enabled ? chips(p.skills) || `<span class="p-desc">Sem skills</span>` : `<span class="p-desc">Desativado</span>`}</span></div>
            <div class="s-actions"><span class="s-status"></span><button type="button" class="switch" role="switch" aria-checked="${p.enabled}" aria-label="${p.enabled ? "Desativar" : "Ativar"} ${esc(p.name)}" data-plugin="${esc(p.id)}"><i></i></button></div></div>`,
        )
        .join("")}</div></section>
` : `
    <section class="s-card"><h3>Suas skills <span class="count">${info.user_skills.length}</span></h3>
      <p class="p-help">Ficam em <code>~/.claude/skills</code> e valem no terminal e aqui. O Orbia guarda uma cópia .bak antes de salvar.</p>
      <div class="s-list">${
        info.user_skills
          .map(
            (s) => `<div class="s-item" data-q="${esc((s.name + " " + s.description).toLowerCase())}"><div class="s-main"><span class="p-name">/${esc(s.name)}</span><span class="p-desc">${esc(s.description)}</span></div>
            <div class="s-actions"><button type="button" class="btn-sm" data-edit="${esc(s.name)}">Editar</button><button type="button" class="btn-sm danger" data-del="${esc(s.name)}">Apagar</button></div></div>`,
          )
          .join("") || `<p class="p-help">Nenhuma ainda.</p>`
      }</div></section>
    ${
      builtin.length
        ? `<section class="s-card"><h3>Do Claude Code <span class="count">${builtin.length}</span></h3><p class="p-help">Vêm com o próprio Claude Code e não dá para editar.</p><div class="chips">${chips(builtin, 60)}</div></section>`
        : ""
    }`}`;
  const plStatus = body.querySelector("#pl-status");
  const run = async (btn: HTMLButtonElement, busy: string, call: () => Promise<unknown>, done: string) => {
    btn.disabled = true;
    status(plStatus, busy);
    try {
      await call();
      status(plStatus, done, "ok");
      loadClaudeInfo();
    } catch (err) {
      status(plStatus, String(err), "err");
    }
    btn.disabled = false;
  };
  const mkAdd = body.querySelector<HTMLButtonElement>("#mk-add");
  if (mkAdd) mkAdd.onclick = (e) => {
    const source = body.querySelector<HTMLInputElement>("#mk-src")!.value;
    run(e.currentTarget as HTMLButtonElement, "Adicionando a loja…", () => invoke("marketplace_add", { source }), "Loja adicionada. Agora instale um plugin dela.");
  };
  const plInstall = body.querySelector<HTMLButtonElement>("#pl-install");
  if (plInstall) plInstall.onclick = (e) => {
    const id = body.querySelector<HTMLInputElement>("#pl-id")!.value;
    run(e.currentTarget as HTMLButtonElement, "Instalando…", () => invoke("plugin_install", { id }), "Plugin instalado. Recarregando a lista…");
  };
  const q = body.querySelector<HTMLInputElement>("#skill-q")!;
  q.oninput = () =>
    body.querySelectorAll<HTMLElement>(".s-item").forEach((el) => (el.hidden = !el.dataset.q!.includes(q.value.toLowerCase().trim())));
  const newSkill = body.querySelector<HTMLButtonElement>("#new-skill");
  if (newSkill) newSkill.onclick = () => {
    editing = { name: "", isNew: true, content: "---\nname: nome-da-skill\ndescription: Quando o Claude deve usar esta skill, em uma frase.\n---\n\n# Nome da skill\n\nO que o Claude deve fazer, passo a passo.\n" };
    renderThread();
  };
  body.querySelectorAll<HTMLButtonElement>("[data-edit]").forEach(
    (b) =>
      (b.onclick = async () => {
        const name = b.dataset.edit!;
        editing = { name, isNew: false, content: await invoke<string>("read_skill", { name }) };
        renderThread();
      }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-del]").forEach(
    (b) =>
      (b.onclick = async () => {
        const name = b.dataset.del!;
        if (!(await ask(`A pasta ~/.claude/skills/${name} e tudo o que está nela saem do seu computador. Ela some do terminal também. Não dá para desfazer.`, `Apagar a skill /${name}?`, "Apagar skill"))) return;
        try {
          await invoke("delete_skill", { name });
          claudeInfo!.user_skills = claudeInfo!.user_skills.filter((s) => s.name !== name);
          renderThread();
          loadClaudeInfo();
        } catch (err) {
          flash(String(err));
        }
      }),
  );
  body.querySelectorAll<HTMLButtonElement>("[data-plugin]").forEach(
    (b) =>
      (b.onclick = async () => {
        const enable = b.getAttribute("aria-checked") !== "true";
        const st = b.previousElementSibling;
        b.disabled = true;
        status(st, enable ? "Ativando…" : "Desativando…");
        try {
          await invoke("plugin_toggle", { id: b.dataset.plugin, enable });
          status(st, "Recarregando…");
          await loadClaudeInfo();
        } catch (err) {
          b.disabled = false;
          status(st, String(err), "err");
        }
      }),
  );
}

function skillEditor(body: HTMLElement) {
  const e = editing!;
  body.innerHTML = `<section class="s-card editor"><h3>${e.isNew ? "Nova skill" : `Editar /${esc(e.name)}`}</h3>
    ${
      e.isNew
        ? `<label class="s-label" for="skill-name">Nome</label><input class="s-input" id="skill-name" placeholder="minha-skill" autocomplete="off" spellcheck="false">
           <p class="p-help">Letras minúsculas, números e hífen. Vira o comando /nome.</p>`
        : `<p class="p-help"><code>~/.claude/skills/${esc(e.name)}/SKILL.md</code></p>`
    }
    <textarea class="s-code" id="skill-body" rows="18" spellcheck="false" aria-label="Conteúdo da skill"></textarea>
    <div class="s-row"><button type="button" class="btn-sm" id="skill-cancel">Cancelar</button><button type="button" class="btn-sm primary" id="skill-save">Salvar</button><span class="s-status"></span></div></section>`;
  const ta = body.querySelector<HTMLTextAreaElement>("#skill-body")!;
  ta.value = e.content;
  const nameIn = body.querySelector<HTMLInputElement>("#skill-name");
  if (nameIn) {
    nameIn.oninput = () => {
      nameIn.value = nameIn.value.toLowerCase().replace(/\s+/g, "-");
      ta.value = ta.value.replace(/^name: .*$/m, `name: ${nameIn.value || "nome-da-skill"}`);
    };
    nameIn.focus();
  }
  body.querySelector<HTMLButtonElement>("#skill-cancel")!.onclick = () => {
    editing = null;
    renderThread();
  };
  body.querySelector<HTMLButtonElement>("#skill-save")!.onclick = async (ev) => {
    const st = (ev.currentTarget as HTMLElement).nextElementSibling;
    const name = nameIn ? nameIn.value.trim() : e.name;
    try {
      await invoke("save_skill", { name, content: ta.value });
      editing = null;
      if (claudeInfo && !claudeInfo.user_skills.some((s) => s.name === name)) claudeInfo.user_skills.push({ name, description: "" });
      renderThread();
      loadClaudeInfo();
    } catch (err) {
      status(st, String(err), "err");
    }
  };
}

const MCP_STATUS: Record<string, [string, string]> = {
  connected: ["Conectado", "ok"],
  "needs-auth": ["Precisa entrar", "warn"],
  failed: ["Falhou", "err"],
  pending: ["Conectando", "warn"],
  disabled: ["Desativado", ""],
};

function tabMcps(body: HTMLElement) {
  if (!needInfo(body)) return;
  const src = (m: { name: string; source: string }) =>
    m.source === "user" ? "Seu" : m.source === "plugin" ? `Plugin ${m.name.split(":")[1] ?? ""}` : m.source === "claudeai" ? "Conta claude.ai" : m.source === "project" ? "Projeto" : m.source;
  const label = (m: { name: string }) => m.name.replace(/^plugin:[^:]+:/, "").replace(/^claude\.ai /, "");
  body.innerHTML = `<section class="s-card"><h3>MCPs <span class="count">${claudeInfo!.mcps.length}</span></h3>
      <p class="p-help">Programas e serviços que o Claude pode usar. Os de plugins mudam junto com o plugin; os da conta claude.ai se configuram no site. “Precisa entrar” se resolve com <code>/mcp</code> no terminal do Claude Code.</p>
      <div class="s-list">${claudeInfo!.mcps
        .map((m) => {
          const [st, cls] = MCP_STATUS[m.status] ?? [m.status, ""];
          return `<div class="s-item"><div class="s-main"><span class="p-name">${esc(label(m))}</span><span class="p-desc">${esc(src(m))}</span></div>
            <div class="s-actions"><span class="badge ${cls}"><i></i>${st}</span>${
              m.source === "user" ? `<button type="button" class="btn-sm danger" data-rm="${esc(m.name)}">Remover</button>` : ""
            }</div></div>`;
        })
        .join("")}</div></section>
    <section class="s-card"><h3>Adicionar MCP</h3><p class="p-help">Fica disponível em todas as conversas com o Claude, no terminal e aqui.</p>
      <div class="s-form">
        <label class="s-label" for="mcp-name">Nome</label><input class="s-input" id="mcp-name" placeholder="github" autocomplete="off" spellcheck="false">
        <span class="s-label">Tipo</span><div class="seg" role="radiogroup" aria-label="Tipo de MCP">
          <button type="button" role="radio" data-kind="stdio" aria-checked="true">Programa no PC</button><button type="button" role="radio" data-kind="http" aria-checked="false">Endereço na internet</button></div>
        <label class="s-label" for="mcp-target" id="mcp-target-label">Comando</label><input class="s-input" id="mcp-target" placeholder="npx" autocomplete="off" spellcheck="false">
        <label class="s-label" for="mcp-args" id="mcp-args-label">Argumentos</label><input class="s-input" id="mcp-args" placeholder="-y @modelcontextprotocol/server-filesystem /home/voce/Documentos" autocomplete="off" spellcheck="false">
      </div>
      <div class="s-row"><button type="button" class="btn-sm primary" id="mcp-add">Adicionar</button><span class="s-status"></span></div></section>`;
  let http = false;
  const seg = body.querySelectorAll<HTMLButtonElement>(".seg button");
  seg.forEach(
    (b) =>
      (b.onclick = () => {
        http = b.dataset.kind === "http";
        seg.forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        $("mcp-target-label").textContent = http ? "Endereço" : "Comando";
        body.querySelector<HTMLInputElement>("#mcp-target")!.placeholder = http ? "https://exemplo.com/mcp" : "npx";
        $("mcp-args-label").hidden = http;
        body.querySelector<HTMLInputElement>("#mcp-args")!.hidden = http;
      }),
  );
  body.querySelector<HTMLButtonElement>("#mcp-add")!.onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const st = btn.nextElementSibling;
    const val = (id: string) => body.querySelector<HTMLInputElement>(id)!.value.trim();
    const args = [...val("#mcp-args").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    btn.disabled = true;
    status(st, "Adicionando…");
    try {
      await invoke("mcp_add", { name: val("#mcp-name"), http, target: val("#mcp-target"), args: http ? [] : args });
      status(st, "Adicionado. Recarregando a lista…", "ok");
      await loadClaudeInfo();
    } catch (err) {
      btn.disabled = false;
      status(st, String(err), "err");
    }
  };
  body.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach(
    (b) =>
      (b.onclick = async () => {
        const name = b.dataset.rm!;
        if (!(await ask(`O Claude deixa de usar o MCP “${name}”, no terminal e aqui. Para voltar, é preciso adicionar de novo.`, `Remover o MCP ${name}?`, "Remover MCP"))) return;
        b.disabled = true;
        try {
          await invoke("mcp_remove", { name });
          await loadClaudeInfo();
        } catch (err) {
          b.disabled = false;
          flash(String(err));
        }
      }),
  );
}

async function tabRegras(body: HTMLElement) {
  body.innerHTML = `<section class="s-card"><h3>Regras do Claude</h3><p class="p-help" id="rules-path">Lendo…</p>
    <textarea class="s-code" id="rules" rows="18" spellcheck="false" aria-label="Regras" placeholder="Ex.: Sempre responda em português. Prefira exemplos curtos."></textarea>
    <div class="s-row"><button type="button" class="btn-sm primary" id="rules-save">Salvar</button><span class="s-status"></span></div></section>`;
  const r = await invoke<{ path: string; content: string }>("claude_rules");
  const path = body.querySelector("#rules-path");
  if (!path) return;
  path.innerHTML = `Instruções que o Claude Code segue em todas as conversas, no terminal e aqui. Ficam em <code>${esc(r.path)}</code>. O Orbia guarda uma cópia .bak antes de salvar.`;
  const ta = body.querySelector<HTMLTextAreaElement>("#rules")!;
  ta.value = r.content;
  body.querySelector<HTMLButtonElement>("#rules-save")!.onclick = async (ev) => {
    const st = (ev.currentTarget as HTMLElement).nextElementSibling;
    await invoke("save_claude_rules", { content: ta.value }).then(
      () => status(st, "Salvo. Vale a partir da próxima mensagem.", "ok"),
      (err) => status(st, String(err), "err"),
    );
  };
}

// ---------- uso do plano do Claude (rodapé da barra lateral) ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// "Nov 25, 5:59pm" ou "6pm" (horário local) → Date.
function resetDate(text: string): Date | null {
  const m = text.match(/^(?:([A-Za-z]{3})\w*\.? (\d{1,2}),? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  const now = new Date();
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") h += 12;
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : now.getMonth();
  const d = new Date(now.getFullYear(), month, m[2] ? Number(m[2]) : now.getDate(), h, Number(m[4] ?? 0));
  if (!m[1] && d < now) d.setDate(d.getDate() + 1);
  if (d.getTime() < now.getTime() - 864e5) d.setFullYear(d.getFullYear() + 1);
  return d;
}

function left(d: Date | null): string {
  if (!d) return "";
  const min = Math.max(0, Math.round((d.getTime() - Date.now()) / 60000));
  if (min >= 1440) return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
  if (min >= 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min}m`;
}

function renderUsage() {
  const el = $("usage");
  const rows = usage.slice(0, 2);
  el.hidden = !rows.length;
  if (!rows.length) return;
  const name = (u: Usage) => (/session/i.test(u.label) ? "sessão" : /week/i.test(u.label) ? "semana" : u.label);
  const tip = rows
    .map((u) => {
      const d = resetDate(u.resets);
      return `${name(u)[0].toUpperCase() + name(u).slice(1)}: ${u.percent}% usado${d ? `, zera ${d.toLocaleString("pt-BR", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}`;
    })
    .join("\n");
  const main = rows[0];
  el.title = `Uso do seu plano do Claude\n${tip}`;
  el.innerHTML = `<span class="u-icon">${kindIcon.claude}</span>
    <span class="u-bar" role="meter" aria-label="Uso da ${name(main)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${main.percent}"><i style="width:${Math.min(100, main.percent)}%" class="${main.percent >= 90 ? "hot" : ""}"></i></span>
    <span class="u-text">${rows.map((u) => `<span><b>${u.percent}%</b> ${left(resetDate(u.resets))}</span>`).join('<span class="u-sep">·</span>')}</span>
    <button type="button" class="icon-btn small" id="usage-refresh" aria-label="Atualizar o uso" title="Atualizar">${icon.refresh(13)}</button>`;
  $("usage-refresh").onclick = loadUsage;
}

async function loadUsage() {
  if (!ais.some((a) => a.kind === "claude")) return;
  $("usage").classList.add("loading");
  const u = await invoke<Usage[]>("claude_usage");
  $("usage").classList.remove("loading");
  if (u.length) usage = u;
  renderUsage();
}
setInterval(loadUsage, 10 * 60 * 1000);
setInterval(renderUsage, 60 * 1000); // o tempo que falta anda sozinho

// ---------- painel de comandos (ao lado do clipe) ----------

function renderPanel() {
  if (!current) return;
  const a = current.ai;
  const claude = a.kind === "claude";
  const conversa = claude ? (slashCmds ?? []).filter((c) => !c.skill && !c.name.includes(":")) : [];
  const plugins = claude ? (slashCmds ?? []).filter((c) => !c.skill && c.name.includes(":")) : [];
  const cmdRow = (c: SlashCmd) =>
    `<button type="button" class="p-cmd" data-cmd="${esc(c.name)}"><span class="p-name">/${esc(c.name)}</span><span class="p-desc">${esc(c.description)}</span></button>`;
  els.panel.innerHTML = `
    ${
      claude
        ? `<section><h3>Modelo</h3><p class="p-help">Vale para as próximas mensagens desta conversa.</p>
      <div class="models">${MODELS.map(
        (m) => `<button type="button" class="model" data-model="${m.id ?? ""}" aria-pressed="${m.id === (current!.model ?? null)}">
          <span class="p-name">${m.name}</span><span class="p-desc">${m.id ? m.desc : esc(claudeModel ? `${m.desc}: ${claudeModel}` : m.desc)}</span></button>`,
      ).join("")}</div></section>`
        : ""
    }
    ${effortLevels(a).length ? `<section><h3>${a.kind === "ollama" ? "Raciocínio" : "Esforço"}</h3>${effortPicker(a, current.effort)}</section>` : ""}
    ${conversa.length ? `<section><h3>Conversa</h3><p class="p-help">Um clique roda o comando nesta conversa.</p>${conversa.map(cmdRow).join("")}</section>` : ""}
    ${plugins.length ? `<section><h3>Comandos de plugins</h3>${plugins.map(cmdRow).join("")}</section>` : ""}
    ${
      claude
        ? `<section><h3>Plugins e MCPs</h3><div class="p-links">
        <button type="button" class="btn-sm" data-open="plugins">Instalar e gerenciar plugins</button>
        <button type="button" class="btn-sm" data-open="mcps">Gerenciar MCPs</button></div></section>`
        : ""
    }`;
  els.panel.querySelectorAll<HTMLButtonElement>(".model").forEach(
    (b) =>
      (b.onclick = () => {
        current!.model = b.dataset.model || null;
        renderTop();
        renderPanel();
      }),
  );
  bindEffort(els.panel, (e) => {
    current!.effort = e;
    renderTop();
    renderPanel();
  });
  els.panel.querySelectorAll<HTMLButtonElement>(".p-cmd").forEach(
    (b) =>
      (b.onclick = () => {
        if (current?.busy) return flash("Espere a resposta terminar para rodar outro comando");
        closePanel();
        els.input.value = `/${b.dataset.cmd}`;
        send();
      }),
  );
  els.panel.querySelectorAll<HTMLButtonElement>("[data-open]").forEach(
    (b) =>
      (b.onclick = () => {
        settingsTab = b.dataset.open!;
        editing = null;
        renderAll();
      }),
  );
}

function openPanel() {
  closeSlash();
  renderPanel();
  els.panel.hidden = false;
  els.cmds.setAttribute("aria-expanded", "true");
  els.cmds.classList.add("on");
}

function closePanel() {
  els.panel.hidden = true;
  els.cmds.setAttribute("aria-expanded", "false");
  els.cmds.classList.remove("on");
}

els.cmds.onclick = () => (els.panel.hidden ? openPanel() : closePanel());
document.addEventListener("mousedown", (e) => {
  const t = e.target as HTMLElement;
  if (!els.panel.hidden && !els.panel.contains(t) && !els.cmds.contains(t)) closePanel();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.panel.hidden) {
    closePanel();
    els.cmds.focus();
  }
});

// ---------- composer ----------

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
}
els.input.addEventListener("input", () => {
  autosize();
  updateComposer();
  slashActive = 0;
  updateSlash();
});
els.input.addEventListener("keydown", (e) => {
  if (!els.slash.hidden) {
    const n = slashItems.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) slashActive = (slashActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      return updateSlash();
    }
    if ((e.key === "Enter" || e.key === "Tab") && n && !e.shiftKey) {
      e.preventDefault();
      return pickSlash(slashActive);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      return closeSlash();
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!current?.busy) send();
  }
});
els.composer.onsubmit = (e) => {
  e.preventDefault();
  send();
};
els.newBtn.onclick = () => {
  current = null;
  settingsTab = null;
  pending = [];
  renderAll();
};
$("rescan").onclick = rescan;

// Copiar código e comandos; links abrem no navegador, nunca dentro do app.
document.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const copy = target.closest<HTMLButtonElement>(".copy");
  if (copy) {
    const text = copy.closest(".code")?.querySelector("pre")?.textContent ?? copy.closest(".cmd")?.querySelector("code")?.textContent ?? "";
    await navigator.clipboard.writeText(text);
    const plain = copy.classList.contains("plain");
    copy.innerHTML = plain ? "Copiado" : `${icon.check}<span>Copiado</span>`;
    setTimeout(() => (copy.innerHTML = plain ? "Copiar" : `${icon.copy}<span>Copiar</span>`), 1600);
    return;
  }
  const a = target.closest<HTMLAnchorElement>("a[href]");
  if (a) {
    e.preventDefault();
    if (/^https?:\/\//i.test(a.href)) openUrl(a.href);
  }
});

$("gear").innerHTML = icon.gear;
$("gear").onclick = () => (settingsTab ? closeSettings() : openSettings());
invoke<Record<string, AiOptions>>("get_options").then((o) => (options = o));

renderAll();
loadSummaries();
rescan();
