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
fn command(bin: &Path) -> Command {
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
        let vision = ureq::post(&format!("{OLLAMA}/api/show"))
            .timeout(Duration::from_secs(3))
            .send_string(&json!({ "model": name }).to_string())
            .ok()
            .and_then(|r| r.into_string().ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v["capabilities"].as_array().cloned())
            .is_some_and(|c| c.iter().any(|x| x == "vision"));
        ais.push(Ai {
            id: format!("ollama:{name}"),
            kind: "ollama".into(),
            model: Some(name.into()),
            label: name.trim_end_matches(":latest").into(),
            images: vision,
        });
    }
    for (kind, label) in [("claude", "Claude"), ("gemini", "Gemini"), ("codex", "Codex")] {
        if find(kind).is_some() {
            ais.push(Ai { id: kind.into(), kind: kind.into(), model: None, label: label.into(), images: true });
        }
    }
    Scan { ais, ollama_installed: ollama_bin.is_some() || tags.is_some() }
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
    running: &Running,
    out: &mut dyn FnMut(Out),
) {
    if ai.kind == "ollama" {
        return ollama(ai, workdir, history, text, images, running, out);
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
                Some("content_block_delta") => out.extend(s("/event/delta/text").map(Out::Text)),
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

fn ollama(ai: &Ai, workdir: &Path, history: &[Msg], text: &str, images: &[String], running: &Running, out: &mut dyn FnMut(Out)) {
    let b64 = |names: &[String]| -> Vec<String> {
        names
            .iter()
            .filter_map(|n| std::fs::read(workdir.join(n)).ok())
            .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
            .collect()
    };
    let mut messages: Vec<Value> = history
        .iter()
        .filter(|m| !m.error)
        .map(|m| json!({ "role": m.role, "content": m.text, "images": b64(&m.images) }))
        .collect();
    messages.push(json!({ "role": "user", "content": text, "images": b64(images) }));
    let body = json!({ "model": ai.model, "messages": messages, "stream": true }).to_string();
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
        if let Some(t) = v["message"]["content"].as_str() {
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
    fn history_prompt() {
        let h = vec![Msg { role: "user".into(), text: "a".into(), ..Default::default() }];
        assert!(with_history(&h, "b").ends_with("Nova mensagem do usuário:\nb"));
        assert_eq!(with_history(&[], "b"), "b");
        assert_eq!(tail("ãéí", 2), "í");
    }
}
