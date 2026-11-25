import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/sora";
import "./style.css";
import { invoke, Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { marked } from "marked";
import DOMPurify from "dompurify";

type Ai = { id: string; kind: string; model: string | null; label: string; images: boolean };
type Msg = { role: "user" | "assistant"; text: string; images: string[]; error?: boolean; streaming?: boolean };
type Conv = { id: string | null; ai: Ai; messages: Msg[]; busy?: boolean };
type Summary = { id: string; title: string; ai: string; updated: number };
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
};
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
  newBtn: $<HTMLButtonElement>("new"),
};

els.newBtn.innerHTML = `${icon.plus}<span>Nova conversa</span>`;
$("rescan").innerHTML = icon.refresh();
els.attach.innerHTML = icon.clip;

// ---------- tema ----------

function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("orbia.tema", t);
  document.querySelectorAll<HTMLButtonElement>(".themes button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.theme === t));
  });
}
document.querySelectorAll<HTMLButtonElement>(".themes button").forEach((b) => {
  b.onclick = () => setTheme(b.dataset.theme!);
});
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
    const lang = code?.className.match(/language-([\w+-]+)/)?.[1] ?? "código";
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
          (s, i) => `<li class="conv"><button type="button" class="conv-item" data-i="${i}" aria-current="${current?.id === s.id}" title="${esc(s.ai)}">
            <span class="name">${esc(s.title)}</span><span class="when">${when(s.updated)}</span></button>
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
  els.top.classList.toggle("bare", !current);
  els.title.innerHTML = current
    ? `<strong>${esc(current.ai.label)}</strong><span class="pill">${esc(KIND[current.ai.kind])} · ${current.ai.kind === "ollama" ? "roda no seu PC" : "usa sua conta"}</span>`
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
  els.composer.hidden = !current;
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
  els.kbd.textContent = `Enter envia · Shift+Enter quebra a linha${current.ai.kind === "ollama" ? " · tudo roda no seu computador" : ""}`;
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
}

async function loadSummaries() {
  summaries = await invoke<Summary[]>("list_conversations");
  renderSide();
}

function pickAi(a: Ai) {
  if (current && !current.id && !current.busy) current.ai = a;
  else current = { id: null, ai: a, messages: [] };
  if (!a.images) pending = [];
  renderAll();
  els.input.focus();
}

async function openConv(id: string) {
  if (current?.id === id) return;
  const c = await invoke<Conv>("load_conversation", { id });
  current = { id: c.id, ai: c.ai, messages: c.messages };
  pending = [];
  renderAll();
}

async function deleteConv(s: Summary) {
  if (!confirm(`Apagar a conversa "${s.title}"? Não dá para desfazer.`)) return;
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
    }
    if (current === conv) renderThread();
  };
  try {
    conv.id = await invoke<string>("send", { convId: conv.id, ai: conv.ai, text, images, onEvent: ch });
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
els.input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});
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

// ---------- composer ----------

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
}
els.input.addEventListener("input", () => {
  autosize();
  updateComposer();
});
els.input.addEventListener("keydown", (e) => {
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

renderAll();
loadSummaries();
rescan();
