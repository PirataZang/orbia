mod tools;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tools::{Ai, Msg, Out, Running};

#[derive(Serialize, Deserialize, Clone)]
struct Conversation {
    id: String,
    title: String,
    ai: Ai,
    session: Option<String>,
    messages: Vec<Msg>,
    updated: u64,
}

#[derive(Serialize)]
struct Summary {
    id: String,
    title: String,
    ai: String,
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
fn list_conversations(app: AppHandle) -> Result<Vec<Summary>, String> {
    let dir = data_dir(&app)?.join("conversas");
    let mut v: Vec<Summary> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<Conversation>(&std::fs::read(e.path()).ok()?).ok())
        .map(|c| Summary { id: c.id, title: c.title, ai: c.ai.label, updated: c.updated })
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
    on_event: Channel<Ev>,
) -> Result<String, String> {
    let mut conv = match &conv_id {
        Some(id) => read_conv(&app, id)?,
        None => {
            let id = format!("{:x}", now());
            let title: String = text.lines().next().unwrap_or("").chars().take(48).collect();
            let title = if title.trim().is_empty() { "Imagem".into() } else { title };
            Conversation { id, title, ai, session: None, messages: vec![], updated: 0 }
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
    let history = conv.messages.clone();
    conv.messages.push(Msg { role: "user".into(), text: text.clone(), images: names.clone(), error: false });
    conv.updated = now() as u64;
    write_conv(&app, &conv)?;

    let running = Arc::new(Running::default());
    runs.0.lock().unwrap().insert(id.clone(), running.clone());
    std::thread::spawn(move || {
        let mut reply = String::new();
        let mut error: Option<String> = None;
        let mut session = conv.session.clone();
        tools::run(&conv.ai, &dir, &history, &text, &names, session.clone().as_deref(), &running, &mut |o| match o {
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
        .invoke_handler(tauri::generate_handler![scan, list_conversations, load_conversation, delete_conversation, stop, send])
        .run(tauri::generate_context!())
        .expect("erro ao abrir o Orbia");
}
