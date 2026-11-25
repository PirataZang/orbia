mod settings;
mod tools;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tools::{Ai, AiOptions, Msg, Out, Running};

#[derive(Serialize, Deserialize, Clone)]
struct Conversation {
    id: String,
    title: String,
    ai: Ai,
    session: Option<String>,
    /// Modelo escolhido no Orbia para esta conversa (`--model`); None usa o da ferramenta.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    messages: Vec<Msg>,
    updated: u64,
}

#[derive(Serialize)]
struct Summary {
    id: String,
    title: String,
    ai: String,
    kind: String,
    updated: u64,
}

#[derive(Deserialize)]
struct Upload {
    data: String, // data URL
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Ev {
    Delta { text: String },
    Error { text: String },
    Done,
}

#[derive(Default)]
struct Runs(Mutex<HashMap<String, Arc<Running>>>);

fn now() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn check_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 32 && id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err("id inválido".into())
    }
}

fn conv_file(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(data_dir(app)?.join("conversas").join(format!("{id}.json")))
}

/// Pasta vazia onde os CLIs rodam e onde ficam as imagens da conversa.
fn work_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    let d = data_dir(app)?.join("trabalho").join(id);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn read_conv(app: &AppHandle, id: &str) -> Result<Conversation, String> {
    let s = std::fs::read_to_string(conv_file(app, id)?).map_err(|_| "Conversa não encontrada.".to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

fn write_conv(app: &AppHandle, c: &Conversation) -> Result<(), String> {
    let f = conv_file(app, &c.id)?;
    std::fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = f.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(c).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, f).map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan() -> tools::Scan {
    tauri::async_runtime::spawn_blocking(tools::scan).await.unwrap_or(tools::Scan { ais: vec![], ollama_installed: false })
}

#[tauri::command]
async fn commands(app: AppHandle) -> tools::ClaudeInfo {
    let Ok(dir) = data_dir(&app).map(|d| d.join("comandos")) else { return tools::ClaudeInfo::default() };
    let _ = std::fs::create_dir_all(&dir);
    tauri::async_runtime::spawn_blocking(move || tools::claude_commands(&dir)).await.unwrap_or_default()
}

// ---------- opções do Orbia por IA ----------

type Options = HashMap<String, AiOptions>;

fn read_options(app: &AppHandle) -> Options {
    data_dir(app)
        .ok()
        .and_then(|d| std::fs::read(d.join("opcoes.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_options(app: AppHandle) -> Options {
    read_options(&app)
}

#[tauri::command]
fn set_options(app: AppHandle, ai_id: String, options: AiOptions) -> Result<AiOptions, String> {
    if ai_id.is_empty() || ai_id.len() > 200 {
        return Err("IA inválida".into());
    }
    let options = options.validate()?;
    let mut all = read_options(&app);
    all.insert(ai_id, options.clone());
    let dir = data_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("opcoes.json"), serde_json::to_vec_pretty(&all).unwrap()).map_err(|e| e.to_string())?;
    Ok(options)
}

// ---------- configuração das ferramentas ----------

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_info(model: String) -> Result<tools::OllamaInfo, String> {
    blocking(move || tools::ollama_info(&model)).await
}

#[derive(Serialize)]
struct Rules {
    path: String,
    content: String,
}

#[tauri::command]
fn claude_rules() -> Rules {
    let home = settings::home();
    Rules { path: settings::rules_file(&home).display().to_string(), content: settings::read_rules(&home) }
}

#[tauri::command]
fn save_claude_rules(content: String) -> Result<(), String> {
    settings::save_rules(&settings::home(), &content)
}

#[tauri::command]
fn read_skill(name: String) -> Result<String, String> {
    settings::read_skill(&settings::home(), &name)
}

#[tauri::command]
fn save_skill(name: String, content: String) -> Result<(), String> {
    settings::save_skill(&settings::home(), &name, &content)
}

#[tauri::command]
fn delete_skill(name: String) -> Result<(), String> {
    settings::delete_skill(&settings::home(), &name)
}

#[tauri::command]
async fn plugin_toggle(id: String, enable: bool) -> Result<String, String> {
    blocking(move || settings::plugin_toggle(&id, enable)).await?
}

#[tauri::command]
async fn plugin_install(id: String) -> Result<String, String> {
    blocking(move || settings::plugin_install(&id)).await?
}

#[tauri::command]
async fn marketplace_add(source: String) -> Result<String, String> {
    blocking(move || settings::marketplace_add(&source)).await?
}

#[tauri::command]
async fn claude_usage(app: AppHandle) -> Vec<tools::Usage> {
    let Ok(dir) = data_dir(&app).map(|d| d.join("comandos")) else { return vec![] };
    let _ = std::fs::create_dir_all(&dir);
    blocking(move || tools::claude_usage(&dir)).await.unwrap_or_default()
}

#[tauri::command]
async fn mcp_add(name: String, http: bool, target: String, args: Vec<String>) -> Result<String, String> {
    blocking(move || settings::mcp_add(&name, http, &target, &args)).await?
}

#[tauri::command]
async fn mcp_remove(name: String) -> Result<String, String> {
    blocking(move || settings::mcp_remove(&name)).await?
}

#[tauri::command]
async fn clipboard_image() -> Option<String> {
    tauri::async_runtime::spawn_blocking(tools::clipboard_png).await.ok().flatten()
}

#[tauri::command]
fn list_conversations(app: AppHandle) -> Result<Vec<Summary>, String> {
    let dir = data_dir(&app)?.join("conversas");
    let mut v: Vec<Summary> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<Conversation>(&std::fs::read(e.path()).ok()?).ok())
        .map(|c| Summary { id: c.id, title: c.title, kind: c.ai.kind, ai: c.ai.label, updated: c.updated })
        .collect();
    v.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(v)
}

/// Devolve a conversa com as imagens já como data URLs, prontas para a tela.
#[tauri::command]
fn load_conversation(app: AppHandle, id: String) -> Result<Conversation, String> {
    let mut c = read_conv(&app, &id)?;
    let dir = work_dir(&app, &id)?;
    for m in &mut c.messages {
        m.images = m
            .images
            .iter()
            .filter_map(|n| {
                let b = std::fs::read(dir.join(n)).ok()?;
                let ext = n.rsplit('.').next().unwrap_or("png").replace("jpg", "jpeg");
                Some(format!("data:image/{ext};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
            })
            .collect();
    }
    Ok(c)
}

#[tauri::command]
fn delete_conversation(app: AppHandle, id: String) -> Result<(), String> {
    let _ = std::fs::remove_file(conv_file(&app, &id)?);
    let _ = std::fs::remove_dir_all(data_dir(&app)?.join("trabalho").join(&id));
    Ok(())
}

#[tauri::command]
fn stop(runs: State<Runs>, id: String) {
    if let Some(r) = runs.0.lock().unwrap().get(&id) {
        r.stop();
    }
}

/// Salva a mensagem, roda a IA em segundo plano e devolve o id da conversa na hora.
#[tauri::command]
fn send(
    app: AppHandle,
    runs: State<Runs>,
    conv_id: Option<String>,
    ai: Ai,
    text: String,
    images: Vec<Upload>,
    model: Option<String>,
    effort: Option<String>,
    on_event: Channel<Ev>,
) -> Result<String, String> {
    let mut conv = match &conv_id {
        Some(id) => read_conv(&app, id)?,
        None => {
            let id = format!("{:x}", now());
            let title: String = text.lines().next().unwrap_or("").chars().take(48).collect();
            let title = if title.trim().is_empty() { "Imagem".into() } else { title };
            Conversation { id, title, ai, session: None, model: None, effort: None, messages: vec![], updated: 0 }
        }
    };
    let id = conv.id.clone();
    if runs.0.lock().unwrap().contains_key(&id) {
        return Err("Essa conversa ainda está respondendo.".into());
    }
    let dir = work_dir(&app, &id)?;
    let mut names = vec![];
    for (i, up) in images.iter().enumerate() {
        let (head, b64) = up.data.split_once(',').ok_or("imagem inválida")?;
        let ext = match head {
            h if h.starts_with("data:image/png") => "png",
            h if h.starts_with("data:image/jpeg") => "jpg",
            h if h.starts_with("data:image/webp") => "webp",
            h if h.starts_with("data:image/gif") => "gif",
            _ => return Err("Formato de imagem não aceito. Use PNG, JPG, WebP ou GIF.".into()),
        };
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "imagem inválida")?;
        let name = format!("imagem-{}-{}.{ext}", now(), i + 1);
        std::fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
        names.push(name);
    }
    // Só aliases conhecidos chegam ao CLI.
    conv.model = model.filter(|m| ["opus", "sonnet", "haiku"].contains(&m.as_str()));
    conv.effort = effort.filter(|e| tools::effort_levels(&conv.ai).contains(&e.as_str()));
    let history = conv.messages.clone();
    conv.messages.push(Msg { role: "user".into(), text: text.clone(), images: names.clone(), error: false });
    conv.updated = now() as u64;
    write_conv(&app, &conv)?;

    let opts = read_options(&app).remove(&conv.ai.id).unwrap_or_default();
    let running = Arc::new(Running::default());
    runs.0.lock().unwrap().insert(id.clone(), running.clone());
    std::thread::spawn(move || {
        let mut reply = String::new();
        let mut error: Option<String> = None;
        let mut session = conv.session.clone();
        tools::run(&conv.ai, &dir, &history, &text, &names, session.clone().as_deref(), conv.model.as_deref(), conv.effort.as_deref(), &opts, &running, &mut |o| match o {
            Out::Text(t) => {
                reply.push_str(&t);
                let _ = on_event.send(Ev::Delta { text: t });
            }
            Out::Session(s) => session = Some(s),
            Out::Error(e) => {
                let _ = on_event.send(Ev::Error { text: e.clone() });
                error = Some(e);
            }
        });
        conv.session = session;
        if !reply.is_empty() {
            conv.messages.push(Msg { role: "assistant".into(), text: reply, ..Default::default() });
        }
        if let Some(e) = error {
            conv.messages.push(Msg { role: "assistant".into(), text: e, error: true, ..Default::default() });
        }
        conv.updated = now() as u64;
        let _ = write_conv(&app, &conv);
        app.state::<Runs>().0.lock().unwrap().remove(&conv.id);
        let _ = on_event.send(Ev::Done);
    });
    Ok(id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Runs::default())
        .invoke_handler(tauri::generate_handler![
            scan,
            commands,
            clipboard_image,
            get_options,
            set_options,
            ollama_info,
            claude_rules,
            save_claude_rules,
            read_skill,
            save_skill,
            delete_skill,
            plugin_toggle,
            plugin_install,
            marketplace_add,
            claude_usage,
            mcp_add,
            mcp_remove, list_conversations, load_conversation, delete_conversation, stop, send])
        .run(tauri::generate_context!())
        .expect("erro ao abrir o Orbia");
}
