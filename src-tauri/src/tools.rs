//! Acha as IAs instaladas e conversa com elas. Nunca passa texto do usuário por um shell.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const OLLAMA: &str = "http://127.0.0.1:11434";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Ai {
    pub id: String,
    pub kind: String, // ollama | claude | gemini | codex
    pub model: Option<String>,
    pub label: String,
    pub images: bool,
    /// Ollama: o modelo sabe "pensar" antes de responder (capacidade `thinking`).
    #[serde(default)]
    pub think: bool,
}

/// Níveis de esforço que cada ferramenta aceita. Vazio = não dá para escolher.
pub fn effort_levels(ai: &Ai) -> &'static [&'static str] {
    match ai.kind.as_str() {
        "claude" => &["low", "medium", "high", "xhigh", "max"],
        "codex" => &["low", "medium", "high", "xhigh"],
        "ollama" if ai.think && ai.model.as_deref().is_some_and(|m| m.starts_with("gpt-oss")) => &["off", "low", "medium", "high"],
        "ollama" if ai.think => &["off", "on"],
        _ => &[],
    }
}

/// Opções do Orbia para uma IA (guardadas em `opcoes.json`, nunca na ferramenta).
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct AiOptions {
    /// Claude: modelo padrão para novas conversas.
    #[serde(default)]
    pub model: Option<String>,
    /// Esforço padrão para novas conversas (ver `effort_levels`).
    #[serde(default)]
    pub effort: Option<String>,
    /// Ollama: instrução de sistema. Claude: instrução extra (`--append-system-prompt`).
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub num_ctx: Option<u32>,
    // Opções avançadas do Ollama (`options` e campos de `/api/chat`). None = padrão do modelo.
    #[serde(default)]
    pub num_predict: Option<i32>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default)]
    pub top_k: Option<u32>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub min_p: Option<f64>,
    #[serde(default)]
    pub repeat_penalty: Option<f64>,
    /// Quanto tempo o modelo fica na memória depois de responder: "0", "30m", "1h", "-1" (sempre).
    #[serde(default)]
    pub keep_alive: Option<String>,
    /// Pede a resposta em JSON (`format: "json"`).
    #[serde(default)]
    pub json: bool,
}

impl AiOptions {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.model.as_deref().is_some_and(|m| !["opus", "sonnet", "haiku"].contains(&m)) {
            self.model = None;
        }
        if self.effort.as_deref().is_some_and(|e| !["low", "medium", "high", "xhigh", "max", "on", "off"].contains(&e)) {
            self.effort = None;
        }
        if self.system.len() > 20_000 {
            return Err("A instrução passou de 20 mil caracteres.".into());
        }
        self.temperature = self.temperature.map(|t| t.clamp(0.0, 2.0));
        self.num_ctx = self.num_ctx.filter(|n| (1024..=262_144).contains(n));
        self.num_predict = self.num_predict.filter(|n| *n == -1 || (1..=131_072).contains(n));
        self.top_k = self.top_k.filter(|n| (1..=1000).contains(n));
        self.top_p = self.top_p.map(|v| v.clamp(0.0, 1.0));
        self.min_p = self.min_p.map(|v| v.clamp(0.0, 1.0));
        self.repeat_penalty = self.repeat_penalty.map(|v| v.clamp(0.0, 3.0));
        self.keep_alive = self.keep_alive.filter(|k| ["0", "5m", "30m", "1h", "-1"].contains(&k.as_str()));
        Ok(self)
    }
}

#[derive(Serialize)]
pub struct Scan {
    pub ais: Vec<Ai>,
    pub ollama_installed: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Msg {
    pub role: String, // user | assistant
    pub text: String,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub error: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thinking: String,
}

/// Processo em andamento; `stop()` o interrompe.
#[derive(Default)]
pub struct Running {
    pub stop: AtomicBool,
    pub child: Mutex<Option<Child>>,
}

impl Running {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

pub enum Out {
    Text(String),
    /// Raciocínio do modelo antes da resposta (Ollama com `think`, Claude com thinking).
    Thinking(String),
    Session(String),
    Error(String),
}

// ---------- localizar binários ----------

fn search_dirs() -> &'static Vec<PathBuf> {
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DIRS.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
        if cfg!(windows) {
            if let Some(l) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
                dirs.push(l.join("Programs").join("Ollama"));
            }
            if let Some(a) = std::env::var_os("APPDATA").map(PathBuf::from) {
                dirs.push(a.join("npm"));
            }
            if let Some(h) = &home {
                dirs.push(h.join(".local").join("bin"));
            }
        } else {
            // Um AppImage aberto pelo menu não herda o PATH do .bashrc.
            if let Ok(o) = Command::new("bash").args(["-lc", "echo $PATH"]).stdin(Stdio::null()).output() {
                let s = String::from_utf8_lossy(&o.stdout);
                if let Some(line) = s.lines().last() {
                    dirs.extend(std::env::split_paths(line));
                }
            }
            if let Some(h) = &home {
                for d in [".local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", ".cargo/bin"] {
                    dirs.push(h.join(d));
                }
                if let Ok(rd) = std::fs::read_dir(h.join(".nvm/versions/node")) {
                    let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
                    v.sort();
                    v.reverse(); // versão mais nova primeiro
                    dirs.extend(v);
                }
            }
            dirs.push("/usr/local/bin".into());
            dirs.push("/opt/homebrew/bin".into());
        }
        let mut seen = std::collections::HashSet::new();
        dirs.retain(|d| seen.insert(d.clone()));
        dirs
    })
}

pub fn find(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd"] } else { &[""] };
    search_dirs()
        .iter()
        .flat_map(|d| exts.iter().map(move |e| d.join(format!("{name}{e}"))))
        .find(|p| p.is_file())
}

/// Script JS que um shim `.cmd` do npm chama (`"%dp0%\node_modules\...\cli.js"`).
fn cmd_shim_script(cmd: &str) -> Option<String> {
    for marker in ["%dp0%\\", "%~dp0\\"] {
        for (i, _) in cmd.match_indices(marker) {
            let rest = &cmd[i + marker.len()..];
            let end = rest.find('"').unwrap_or(rest.len());
            let s = &rest[..end];
            if s.ends_with(".js") || s.ends_with(".mjs") || s.ends_with(".cjs") {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Comando pronto para rodar o binário, sem shell. No Windows, `.cmd` vira `node <script>`.
pub fn command(bin: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = if bin.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
        let dir = bin.parent().unwrap_or(Path::new("."));
        let script = std::fs::read_to_string(bin).ok().and_then(|s| cmd_shim_script(&s));
        let node = [dir.join("node.exe")].into_iter().find(|p| p.is_file()).or_else(|| find("node"));
        match (script, node) {
            (Some(s), Some(n)) => {
                let mut c = Command::new(n);
                c.arg(dir.join(s.replace('\\', std::path::MAIN_SEPARATOR_STR)));
                c
            }
            _ => Command::new(bin), // sem script reconhecível: tenta direto
        }
    } else {
        Command::new(bin)
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// ---------- varredura ----------

fn http_get(path: &str) -> Option<Value> {
    let r = ureq::get(&format!("{OLLAMA}{path}")).timeout(Duration::from_secs(2)).call().ok()?;
    serde_json::from_str(&r.into_string().ok()?).ok()
}

pub fn scan() -> Scan {
    let mut ais = Vec::new();
    let ollama_bin = find("ollama");
    let mut tags = http_get("/api/tags");
    if tags.is_none() {
        if let Some(bin) = &ollama_bin {
            let _ = command(bin)
                .arg("serve")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            for _ in 0..16 {
                std::thread::sleep(Duration::from_millis(500));
                tags = http_get("/api/tags");
                if tags.is_some() {
                    break;
                }
            }
        }
    }
    let models = tags.as_ref().and_then(|t| t["models"].as_array().cloned()).unwrap_or_default();
    for m in &models {
        let Some(name) = m["name"].as_str() else { continue };
        let caps = ureq::post(&format!("{OLLAMA}/api/show"))
            .timeout(Duration::from_secs(3))
            .send_string(&json!({ "model": name }).to_string())
            .ok()
            .and_then(|r| r.into_string().ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["capabilities"].as_array().cloned())
            .unwrap_or_default();
        let has = |c: &str| caps.iter().any(|x| x == c);
        ais.push(Ai {
            id: format!("ollama:{name}"),
            kind: "ollama".into(),
            model: Some(name.into()),
            label: name.trim_end_matches(":latest").into(),
            images: has("vision"),
            think: has("thinking"),
        });
    }
    for (kind, label) in [("claude", "Claude"), ("gemini", "Gemini"), ("codex", "Codex")] {
        if find(kind).is_some() {
            ais.push(Ai { id: kind.into(), kind: kind.into(), model: None, label: label.into(), images: true, think: false });
        }
    }
    Scan { ais, ollama_installed: ollama_bin.is_some() || tags.is_some() }
}

// ---------- área de transferência ----------

/// Imagem copiada (print, imagem de outro app) como data URL PNG. O WebKitGTK nem sempre
/// entrega a imagem no evento de colar, então a tela pede aqui.
pub fn clipboard_png() -> Option<String> {
    let img = arboard::Clipboard::new().ok()?.get_image().ok()?;
    let mut buf = Vec::new();
    let mut enc = png::Encoder::new(&mut buf, img.width as u32, img.height as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().ok()?.write_image_data(&img.bytes).ok()?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

// ---------- comandos com / do Claude Code ----------

#[derive(Serialize, Debug)]
pub struct SlashCmd {
    pub name: String,
    pub description: String,
    pub skill: bool,
}

/// Uma linha de uso do plano, como o `/cost` mostra: "Current session: 51% used · resets Nov 25, 6pm (…)".
#[derive(Serialize, Debug, PartialEq)]
pub struct Usage {
    pub label: String,
    pub percent: u32,
    pub resets: String,
}

pub fn parse_usage(text: &str) -> Vec<Usage> {
    text.lines()
        .filter_map(|l| {
            let (label, rest) = l.trim().split_once(':')?;
            let (pct, rest) = rest.split_once("% used")?;
            let resets = rest.split_once("resets ").map(|(_, r)| r.split(" (").next().unwrap_or(r).trim().to_string()).unwrap_or_default();
            Some(Usage { label: label.trim().into(), percent: pct.trim().parse().ok()?, resets })
        })
        .collect()
}

#[derive(Serialize, Debug, Default)]
pub struct ClaudeInfo {
    pub commands: Vec<SlashCmd>,
    /// Modelo configurado no Claude Code (`~/.claude/settings.json` ou o padrão da conta).
    pub model: Option<String>,
    pub user_skills: Vec<crate::settings::UserSkill>,
    pub plugins: Vec<crate::settings::Plugin>,
    pub mcps: Vec<crate::settings::Mcp>,
    pub usage: Vec<Usage>,
}

/// Pede ao Claude Code a lista de comandos e skills. Manda `/cost`, que roda local e não gasta nada;
/// a lista vem na linha `init` do stream.
/// Roda `/cost` no Claude Code (local, não gasta nada). Devolve a linha `init` e o texto do resultado.
fn claude_cost(workdir: &Path) -> (Option<Value>, String) {
    let Some(bin) = find("claude") else { return (None, String::new()) };
    let Ok(mut child) = command(&bin)
        .args(["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return (None, String::new());
    };
    if let Some(mut i) = child.stdin.take() {
        let _ = i.write_all(b"/cost");
    }
    let (mut init, mut result) = (None, String::new());
    for v in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok).filter_map(|l| serde_json::from_str::<Value>(&l).ok()) {
        if v["subtype"] == "init" {
            init = Some(v);
        } else if v["type"] == "result" {
            result = v["result"].as_str().unwrap_or("").to_string();
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    (init, result)
}

pub fn claude_usage(workdir: &Path) -> Vec<Usage> {
    parse_usage(&claude_cost(workdir).1)
}

pub fn claude_commands(workdir: &Path) -> ClaudeInfo {
    let (init, result) = claude_cost(workdir);
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    init.map(|v| ClaudeInfo {
        commands: slash_list(&v, &home),
        model: v["model"].as_str().map(String::from),
        user_skills: crate::settings::user_skills(&home),
        plugins: crate::settings::plugins(&home, &v),
        mcps: crate::settings::mcps(&v),
        usage: parse_usage(&result),
    })
    .unwrap_or_default()
}

/// Skills e comandos de plugin, com a descrição do próprio arquivo. Dos comandos internos,
/// só os que fazem sentido fora do terminal.
fn slash_list(init: &Value, home: &Path) -> Vec<SlashCmd> {
    const BUILTIN: [(&str, &str); 3] = [
        ("compact", "Resume a conversa até aqui para liberar espaço no contexto"),
        ("context", "Mostra quanto do contexto da conversa já está em uso"),
        ("usage", "Mostra o uso do seu plano"),
    ];
    let strs = |k: &str| -> Vec<String> {
        init[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
    };
    let skills = strs("skills");
    let terminal = strs("terminal_slash_commands");
    let plugins: std::collections::HashMap<&str, PathBuf> = init["plugins"]
        .as_array()
        .map(|a| a.iter().filter_map(|p| Some((p["name"].as_str()?, PathBuf::from(p["path"].as_str()?)))).collect())
        .unwrap_or_default();
    strs("slash_commands")
        .into_iter()
        .filter(|n| !terminal.contains(n) && !n.starts_with('_'))
        .filter_map(|name| {
            let files = match name.split_once(':') {
                Some((p, s)) => plugins
                    .get(p)
                    .map(|d| vec![d.join("skills").join(s).join("SKILL.md"), d.join("commands").join(format!("{s}.md"))])
                    .unwrap_or_default(),
                None => vec![
                    home.join(".claude").join("skills").join(&name).join("SKILL.md"),
                    home.join(".claude").join("commands").join(format!("{name}.md")),
                ],
            };
            let found = files.iter().find_map(|f| std::fs::read_to_string(f).ok()).map(|s| description(&s));
            let builtin = BUILTIN.iter().find(|(b, _)| *b == name).map(|(_, d)| d.to_string());
            let description = found.or(builtin.clone()).unwrap_or_default();
            let skill = skills.contains(&name);
            (skill || !description.is_empty()).then_some(SlashCmd { name, description, skill })
        })
        .collect()
}

/// `description:` do frontmatter YAML, em uma linha ou em bloco (`>` / `|`).
pub fn description(md: &str) -> String {
    let Some((fm, _)) = md.trim_start().strip_prefix("---").and_then(|r| r.split_once("\n---")) else {
        return String::new();
    };
    let mut it = fm.lines();
    while let Some(l) = it.next() {
        if let Some(v) = l.strip_prefix("description:") {
            let v = v.trim();
            let text = if v.is_empty() || v.starts_with(['>', '|']) {
                it.by_ref().take_while(|l| l.starts_with([' ', '\t'])).map(str::trim).collect::<Vec<_>>().join(" ")
            } else {
                v.to_string()
            };
            return text.trim_matches(['"', '\'']).to_string();
        }
    }
    String::new()
}

/// Corpo do `POST /api/chat` com as opções do Orbia para o modelo.
fn ollama_body(ai: &Ai, messages: Vec<Value>, effort: Option<&str>, o: &AiOptions) -> Value {
    let mut options = serde_json::Map::new();
    let mut put = |k: &str, v: Option<Value>| {
        if let Some(v) = v {
            options.insert(k.into(), v);
        }
    };
    put("temperature", o.temperature.map(|v| json!(v)));
    put("num_ctx", o.num_ctx.map(|v| json!(v)));
    put("num_predict", o.num_predict.map(|v| json!(v)));
    put("seed", o.seed.map(|v| json!(v)));
    put("top_k", o.top_k.map(|v| json!(v)));
    put("top_p", o.top_p.map(|v| json!(v)));
    put("min_p", o.min_p.map(|v| json!(v)));
    put("repeat_penalty", o.repeat_penalty.map(|v| json!(v)));
    let mut body = json!({ "model": ai.model, "messages": messages, "stream": true, "options": options });
    match effort {
        Some("off") => body["think"] = json!(false),
        Some("on") => body["think"] = json!(true),
        Some(level) => body["think"] = json!(level),
        None => {}
    }
    if let Some(k) = &o.keep_alive {
        // Números viram segundos ("0" descarrega na hora, "-1" nunca descarrega); o resto é duração.
        body["keep_alive"] = k.parse::<i64>().map(|n| json!(n)).unwrap_or_else(|_| json!(k));
    }
    if o.json {
        body["format"] = json!("json");
    }
    body
}

// ---------- detalhes de um modelo do Ollama ----------

#[derive(Serialize, Default)]
pub struct OllamaInfo {
    pub family: String,
    pub parameters: String,
    pub quantization: String,
    pub context: Option<u64>,
    pub capabilities: Vec<String>,
    pub size: Option<u64>,
}

pub fn ollama_info(model: &str) -> OllamaInfo {
    let show = ureq::post(&format!("{OLLAMA}/api/show"))
        .timeout(Duration::from_secs(4))
        .send_string(&json!({ "model": model }).to_string())
        .ok()
        .and_then(|r| r.into_string().ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let d = &show["details"];
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let size = http_get("/api/tags")
        .and_then(|t| t["models"].as_array()?.iter().find(|m| m["name"] == model)?["size"].as_u64());
    OllamaInfo {
        family: s(&d["family"]),
        parameters: s(&d["parameter_size"]),
        quantization: s(&d["quantization_level"]),
        context: show["model_info"]
            .as_object()
            .and_then(|o| o.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, v)| v.as_u64())),
        capabilities: show["capabilities"].as_array().map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect()).unwrap_or_default(),
        size,
    }
}

// ---------- conversar ----------

/// Roda um turno. `history` não inclui a mensagem nova; `images` já estão em `workdir`.
pub fn run(
    ai: &Ai,
    workdir: &Path,
    history: &[Msg],
    text: &str,
    images: &[String],
    session: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    opts: &AiOptions,
    running: &Running,
    out: &mut dyn FnMut(Out),
) {
    let effort = effort.filter(|e| effort_levels(ai).contains(e));
    if ai.kind == "ollama" {
        return ollama(ai, workdir, history, text, images, effort, opts, running, out);
    }
    let Some(bin) = find(&ai.kind) else {
        return out(Out::Error(format!("Não achei o comando `{}` neste PC. Clique em procurar de novo.", ai.kind)));
    };
    let mut cmd = command(&bin);
    let mut prompt = text.to_string();
    match ai.kind.as_str() {
        "claude" => {
            cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
            if let Some(s) = session {
                cmd.args(["--resume", s]);
            }
            if let Some(m) = model {
                cmd.args(["--model", m]);
            }
            if let Some(e) = effort {
                cmd.args(["--effort", e]);
            }
            if !opts.system.trim().is_empty() {
                cmd.args(["--append-system-prompt", opts.system.trim()]);
            }
            if !images.is_empty() {
                prompt.push_str("\n\nImagens anexadas nesta pasta (leia os arquivos): ");
                prompt.push_str(&images.join(", "));
            }
        }
        "gemini" => {
            cmd.args(["--output-format", "stream-json"]);
            // ponytail: contexto pelas últimas mensagens; trocar por retomada de sessão quando todas as versões tiverem.
            prompt = with_history(history, text);
            for i in images {
                prompt.push_str(&format!(" @{i}"));
            }
        }
        "codex" => {
            cmd.args(["exec", "--json", "--skip-git-repo-check", "-s", "read-only"]);
            for i in images {
                cmd.args(["-i", i]);
            }
            if let Some(e) = effort {
                cmd.args(["-c", &format!("model_reasoning_effort={e}")]);
            }
            if let Some(s) = session {
                cmd.args(["resume", s]);
            }
            cmd.arg("-");
        }
        _ => return out(Out::Error("IA desconhecida.".into())),
    }
    cmd.current_dir(workdir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return out(Out::Error(format!("Não consegui iniciar `{}`: {e}", bin.display()))),
    };
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    *running.child.lock().unwrap() = Some(child);
    if running.stop.load(Ordering::SeqCst) {
        running.stop();
    }
    std::thread::spawn(move || {
        let _ = stdin.write_all(prompt.as_bytes());
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let mut got_text = false;
    let mut failed = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        for o in parse_line(&ai.kind, &line, got_text) {
            match &o {
                Out::Text(t) if !t.is_empty() => got_text = true,
                Out::Error(_) => failed = true,
                _ => {}
            }
            out(o);
        }
    }
    let status = running.child.lock().unwrap().take().and_then(|mut c| c.wait().ok());
    let stderr = err_thread.join().unwrap_or_default();
    if running.stop.load(Ordering::SeqCst) {
        return;
    }
    if !status.is_some_and(|s| s.success()) && !failed {
        let msg = stderr.trim();
        let msg = if msg.is_empty() { "A ferramenta encerrou com erro e não disse o motivo." } else { tail(msg, 3000) };
        out(Out::Error(msg.to_string()));
    } else if !got_text && !failed {
        let msg = stderr.trim();
        if !msg.is_empty() {
            out(Out::Error(tail(msg, 3000).to_string()));
        }
    }
}

fn tail(s: &str, n: usize) -> &str {
    let mut i = s.len().saturating_sub(n);
    while !s.is_char_boundary(i) {
        i += 1;
    }
    &s[i..]
}

fn with_history(history: &[Msg], text: &str) -> String {
    let recent: Vec<&Msg> = history.iter().filter(|m| !m.error).rev().take(10).collect();
    if recent.is_empty() {
        return text.to_string();
    }
    let mut s = String::from("Conversa até agora:\n\n");
    for m in recent.into_iter().rev() {
        let who = if m.role == "user" { "Usuário" } else { "Você" };
        s.push_str(&format!("{who}: {}\n\n", tail(&m.text, 4000)));
    }
    s.push_str(&format!("Nova mensagem do usuário:\n{text}"));
    s
}

/// Traduz uma linha de saída de um CLI em eventos. Linha que não é JSON vira texto.
fn parse_line(kind: &str, line: &str, has_text: bool) -> Vec<Out> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![Out::Text(format!("{line}\n"))];
    };
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_string);
    let sep = |t: String| if has_text { format!("\n\n{t}") } else { t };
    let mut out = vec![];
    match kind {
        "claude" => match s("/type").as_deref() {
            Some("system") if s("/subtype").as_deref() == Some("init") => out.extend(s("/session_id").map(Out::Session)),
            Some("stream_event") => match s("/event/type").as_deref() {
                Some("content_block_start") if s("/event/content_block/type").as_deref() == Some("text") && has_text => {
                    out.push(Out::Text("\n\n".into()))
                }
                Some("content_block_delta") => {
                    out.extend(s("/event/delta/text").map(Out::Text));
                    out.extend(s("/event/delta/thinking").map(Out::Thinking));
                }
                _ => {}
            },
            Some("result") => {
                if v["is_error"].as_bool() == Some(true) {
                    out.push(Out::Error(s("/result").unwrap_or_else(|| "Erro no Claude Code.".into())));
                } else if !has_text {
                    out.extend(s("/result").map(Out::Text));
                }
            }
            _ => {}
        },
        "codex" => {
            if let Some(id) = s("/thread_id").or_else(|| s("/msg/session_id")) {
                out.push(Out::Session(id));
            }
            match (s("/type").as_deref(), s("/item/type").as_deref(), s("/msg/type").as_deref()) {
                (Some("item.completed"), Some("agent_message"), _) => out.extend(s("/item/text").map(sep).map(Out::Text)),
                (_, _, Some("agent_message")) => out.extend(s("/msg/message").map(sep).map(Out::Text)),
                (Some("turn.failed"), ..) => out.push(Out::Error(s("/error/message").unwrap_or_else(|| line.into()))),
                (Some("error"), ..) => out.push(Out::Error(s("/message").unwrap_or_else(|| line.into()))),
                (_, _, Some("error")) => out.push(Out::Error(s("/msg/message").unwrap_or_else(|| line.into()))),
                _ => {}
            }
        }
        "gemini" => match s("/type").as_deref() {
            Some("init") => out.extend(s("/session_id").map(Out::Session)),
            Some("message") if s("/role").as_deref() == Some("assistant") => out.extend(s("/content").map(Out::Text)),
            Some("error") => out.push(Out::Error(s("/message").unwrap_or_else(|| line.into()))),
            Some("result") if s("/status").as_deref() == Some("error") => {
                out.push(Out::Error(s("/error/message").unwrap_or_else(|| line.into())))
            }
            _ => {}
        },
        _ => {}
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn ollama(
    ai: &Ai,
    workdir: &Path,
    history: &[Msg],
    text: &str,
    images: &[String],
    effort: Option<&str>,
    opts: &AiOptions,
    running: &Running,
    out: &mut dyn FnMut(Out),
) {
    let b64 = |names: &[String]| -> Vec<String> {
        names
            .iter()
            .filter_map(|n| std::fs::read(workdir.join(n)).ok())
            .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
            .collect()
    };
    let mut messages: Vec<Value> = Vec::new();
    if !opts.system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": opts.system.trim() }));
    }
    messages.extend(history
        .iter()
        .filter(|m| !m.error)
        .map(|m| json!({ "role": m.role, "content": m.text, "images": b64(&m.images) })));
    messages.push(json!({ "role": "user", "content": text, "images": b64(images) }));
    let body = ollama_body(ai, messages, effort, opts).to_string();
    let resp = match ureq::post(&format!("{OLLAMA}/api/chat")).send_string(&body) {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => {
            let s = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&s).ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or(s);
            return out(Out::Error(msg));
        }
        Err(e) => return out(Out::Error(format!("O Ollama não respondeu: {e}"))),
    };
    for line in BufReader::new(resp.into_reader()).lines() {
        if running.stop.load(Ordering::SeqCst) {
            return;
        }
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(e) = v["error"].as_str() {
            return out(Out::Error(e.into()));
        }
        if let Some(t) = v["message"]["thinking"].as_str().filter(|t| !t.is_empty()) {
            out(Out::Thinking(t.into()));
        }
        if let Some(t) = v["message"]["content"].as_str().filter(|t| !t.is_empty()) {
            out(Out::Text(t.into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(o: Vec<Out>) -> Vec<String> {
        o.into_iter()
            .map(|x| match x {
                Out::Text(t) => format!("T:{t}"),
                Out::Session(s) => format!("S:{s}"),
                Out::Thinking(t) => format!("P:{t}"),
                Out::Error(e) => format!("E:{e}"),
            })
            .collect()
    }

    #[test]
    fn claude_lines() {
        assert_eq!(texts(parse_line("claude", r#"{"type":"system","subtype":"init","session_id":"abc"}"#, false)), ["S:abc"]);
        assert_eq!(
            texts(parse_line("claude", r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"oi"}}}"#, false)),
            ["T:oi"]
        );
        assert_eq!(texts(parse_line("claude", r#"{"type":"result","is_error":false,"result":"oi"}"#, true)), Vec::<String>::new());
        assert_eq!(texts(parse_line("claude", r#"{"type":"result","is_error":true,"result":"Not logged in"}"#, false)), ["E:Not logged in"]);
        assert_eq!(texts(parse_line("claude", r#"{"type":"assistant","message":{}}"#, false)), Vec::<String>::new());
        assert_eq!(
            texts(parse_line("claude", r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}"#, false)),
            ["P:hmm"]
        );
    }

    #[test]
    fn codex_and_gemini_lines() {
        assert_eq!(texts(parse_line("codex", r#"{"type":"thread.started","thread_id":"t1"}"#, false)), ["S:t1"]);
        assert_eq!(
            texts(parse_line("codex", r#"{"type":"item.completed","item":{"type":"agent_message","text":"b"}}"#, true)),
            ["T:\n\nb"]
        );
        assert_eq!(texts(parse_line("codex", r#"{"type":"turn.failed","error":{"message":"x"}}"#, false)), ["E:x"]);
        assert_eq!(
            texts(parse_line("gemini", r#"{"type":"message","role":"assistant","content":"ok","delta":true}"#, false)),
            ["T:ok"]
        );
        assert_eq!(texts(parse_line("gemini", "texto puro", false)), ["T:texto puro\n"]);
    }

    #[test]
    fn npm_cmd_shim() {
        let shim = "@ECHO off\r\nSET dp0=%~dp0\r\n\"%_prog%\"  \"%dp0%\\node_modules\\@google\\gemini-cli\\dist\\index.js\" %*\r\n";
        assert_eq!(cmd_shim_script(shim).as_deref(), Some("node_modules\\@google\\gemini-cli\\dist\\index.js"));
        assert_eq!(cmd_shim_script("\"%dp0%\\node.exe\" %*"), None);
    }

    #[test]
    fn slash_commands() {
        assert_eq!(description("---\nname: a\ndescription: Faz X\n---\n# A"), "Faz X");
        assert_eq!(description("---\ndescription: >\n  linha um\n  linha dois\nname: a\n---\n"), "linha um linha dois");
        assert_eq!(description("---\ndescription: \"com aspas\"\n---"), "com aspas");
        assert_eq!(description("# sem frontmatter"), "");

        let dir = std::env::temp_dir().join(format!("orbia-teste-{}", std::process::id()));
        let plug = dir.join("plug");
        std::fs::create_dir_all(dir.join(".claude/skills/minha")).unwrap();
        std::fs::create_dir_all(plug.join("commands")).unwrap();
        std::fs::write(dir.join(".claude/skills/minha/SKILL.md"), "---\ndescription: Minha skill\n---\n").unwrap();
        std::fs::write(plug.join("commands/cmd.md"), "---\ndescription: Do plugin\n---\n").unwrap();
        let init = json!({
            "slash_commands": ["minha", "p:cmd", "compact", "clear", "color", "__interno", "sem-arquivo"],
            "skills": ["minha", "sem-arquivo"],
            "terminal_slash_commands": ["color"],
            "plugins": [{ "name": "p", "path": plug.to_str().unwrap() }],
        });
        let got: Vec<(String, String, bool)> = slash_list(&init, &dir).into_iter().map(|c| (c.name, c.description, c.skill)).collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            got,
            [
                ("minha".into(), "Minha skill".into(), true),
                ("p:cmd".into(), "Do plugin".into(), false),
                ("compact".into(), "Resume a conversa até aqui para liberar espaço no contexto".into(), false),
                ("sem-arquivo".into(), String::new(), true),
            ]
        );
    }

    /// Manual: `cargo test -- --ignored --nocapture` com o Claude Code instalado.
    #[test]
    #[ignore]
    fn claude_real() {
        let dir = std::env::temp_dir();
        let info = claude_commands(&dir);
        println!("modelo: {:?}", info.model);
        println!("uso: {:?}", info.usage);
        let cmds = info.commands;
        for c in &cmds {
            println!("/{} — {}", c.name, c.description.chars().take(70).collect::<String>());
        }
        assert!(!cmds.is_empty());
    }

    /// Manual: copie uma imagem e rode `cargo test clipboard_real -- --ignored`.
    #[test]
    #[ignore]
    fn clipboard_real() {
        let url = clipboard_png().expect("sem imagem na área de transferência");
        let png = base64::engine::general_purpose::STANDARD.decode(url.trim_start_matches("data:image/png;base64,")).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }

    #[test]
    fn usage_and_effort() {
        let text = "You are currently using your subscription\n\nCurrent session: 51% used · resets Nov 25, 6pm (America/Sao_Paulo)\nCurrent week (all models): 19% used · resets Nov 28, 11pm (America/Sao_Paulo)\n\nLast 24h · 211 requests · 9 sessions\n  68%  Start fresh";
        assert_eq!(
            parse_usage(text),
            [
                Usage { label: "Current session".into(), percent: 51, resets: "Nov 25, 6pm".into() },
                Usage { label: "Current week (all models)".into(), percent: 19, resets: "Nov 28, 11pm".into() },
            ]
        );
        assert!(parse_usage("Total cost: $0.12").is_empty());

        let ai = |kind: &str, model: Option<&str>, think: bool| Ai {
            id: "x".into(), kind: kind.into(), model: model.map(String::from), label: "x".into(), images: false, think,
        };
        assert_eq!(effort_levels(&ai("claude", None, false)).len(), 5);
        assert_eq!(effort_levels(&ai("ollama", Some("gpt-oss:20b"), true)), ["off", "low", "medium", "high"]);
        assert_eq!(effort_levels(&ai("ollama", Some("qwen3"), true)), ["off", "on"]);
        assert!(effort_levels(&ai("ollama", Some("llama3.2"), false)).is_empty());
        assert!(effort_levels(&ai("gemini", None, false)).is_empty());
    }

    #[test]
    fn ollama_request() {
        let ai = Ai { id: "o".into(), kind: "ollama".into(), model: Some("qwen3".into()), label: "qwen3".into(), images: false, think: true };
        let plain = ollama_body(&ai, vec![], None, &AiOptions::default());
        assert_eq!(plain["options"], json!({}));
        assert!(plain.get("think").is_none() && plain.get("keep_alive").is_none() && plain.get("format").is_none());

        let o = AiOptions {
            temperature: Some(0.2),
            num_predict: Some(-1),
            seed: Some(42),
            top_k: Some(40),
            top_p: Some(0.9),
            repeat_penalty: Some(1.1),
            keep_alive: Some("-1".into()),
            json: true,
            ..Default::default()
        };
        let b = ollama_body(&ai, vec![], Some("off"), &o);
        assert_eq!(b["think"], json!(false));
        assert_eq!(b["keep_alive"], json!(-1));
        assert_eq!(b["format"], json!("json"));
        assert_eq!(b["options"], json!({ "temperature": 0.2, "num_predict": -1, "seed": 42, "top_k": 40, "top_p": 0.9, "repeat_penalty": 1.1 }));
        assert_eq!(ollama_body(&ai, vec![], Some("high"), &AiOptions { keep_alive: Some("30m".into()), ..Default::default() })["keep_alive"], json!("30m"));
        assert_eq!(ollama_body(&ai, vec![], Some("on"), &AiOptions::default())["think"], json!(true));

        let v = AiOptions { top_k: Some(0), top_p: Some(5.0), keep_alive: Some("99d".into()), num_predict: Some(-7), ..Default::default() }.validate().unwrap();
        assert_eq!((v.top_k, v.top_p, v.keep_alive, v.num_predict), (None, Some(1.0), None, None));
    }

    #[test]
    fn history_prompt() {
        let h = vec![Msg { role: "user".into(), text: "a".into(), ..Default::default() }];
        assert!(with_history(&h, "b").ends_with("Nova mensagem do usuário:\nb"));
        assert_eq!(with_history(&[], "b"), "b");
        assert_eq!(tail("ãéí", 2), "í");
    }
}
