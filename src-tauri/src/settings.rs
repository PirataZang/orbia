//! Tela de configurações: o que o Orbia lê e edita na configuração do Claude Code.
//! Comandos oficiais quando existem; arquivos de texto com cópia `.bak` antes de sobrescrever.

use crate::tools;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

#[derive(Serialize, Debug, PartialEq)]
pub struct UserSkill {
    pub name: String,
    pub description: String,
}

#[derive(Serialize, Debug)]
pub struct Plugin {
    pub id: String, // nome@loja
    pub name: String,
    pub enabled: bool,
    pub skills: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct Mcp {
    pub name: String,
    pub status: String,
    pub source: String,
}

fn valid(s: &str, extra: &str) -> Result<(), String> {
    let ok = !s.is_empty()
        && s.len() <= 64
        && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    if ok {
        Ok(())
    } else {
        Err(format!("Nome inválido: “{s}”. Use letras, números e {extra}"))
    }
}

/// Copia o arquivo para `<arquivo>.bak` antes de sobrescrever.
fn write_with_backup(path: &Path, content: &str) -> Result<(), String> {
    if path.is_file() {
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        std::fs::copy(path, bak).map_err(|e| format!("Não consegui fazer a cópia de segurança: {e}"))?;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, content).map_err(|e| format!("Não consegui salvar {}: {e}", path.display()))
}

// ---------- skills ----------

fn skill_file(home: &Path, name: &str) -> Result<PathBuf, String> {
    valid(name, "-_.")?;
    Ok(home.join(".claude").join("skills").join(name).join("SKILL.md"))
}

pub fn user_skills(home: &Path) -> Vec<UserSkill> {
    let mut v: Vec<UserSkill> = std::fs::read_dir(home.join(".claude").join("skills"))
        .map(|rd| rd.flatten().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|e| {
            let md = std::fs::read_to_string(e.path().join("SKILL.md")).ok()?;
            Some(UserSkill { name: e.file_name().to_string_lossy().into(), description: tools::description(&md) })
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

pub fn read_skill(home: &Path, name: &str) -> Result<String, String> {
    std::fs::read_to_string(skill_file(home, name)?).map_err(|_| "Skill não encontrada.".into())
}

pub fn save_skill(home: &Path, name: &str, content: &str) -> Result<(), String> {
    write_with_backup(&skill_file(home, name)?, content)
}

pub fn delete_skill(home: &Path, name: &str) -> Result<(), String> {
    let file = skill_file(home, name)?;
    std::fs::remove_dir_all(file.parent().unwrap()).map_err(|e| format!("Não consegui apagar: {e}"))
}

// ---------- regras ----------

pub fn rules_file(home: &Path) -> PathBuf {
    home.join(".claude").join("CLAUDE.md")
}

pub fn read_rules(home: &Path) -> String {
    std::fs::read_to_string(rules_file(home)).unwrap_or_default()
}

pub fn save_rules(home: &Path, content: &str) -> Result<(), String> {
    write_with_backup(&rules_file(home), content)
}

// ---------- plugins e MCPs (lidos da linha init e dos arquivos do Claude Code) ----------

pub fn plugins(home: &Path, init: &Value) -> Vec<Plugin> {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
    let installed = read(home.join(".claude").join("plugins").join("installed_plugins.json"));
    let settings = read(home.join(".claude").join("settings.json"));
    let skills: Vec<&str> = init["skills"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut v: Vec<Plugin> = installed["plugins"]
        .as_object()
        .map(|o| o.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|id| {
            let name = id.split('@').next().unwrap_or(&id).to_string();
            let prefix = format!("{name}:");
            Plugin {
                enabled: settings["enabledPlugins"][&id] == true,
                skills: skills.iter().filter_map(|s| s.strip_prefix(&prefix).map(String::from)).collect(),
                name,
                id,
            }
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

pub fn mcps(init: &Value) -> Vec<Mcp> {
    init["mcp_servers"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(Mcp {
                        name: m["name"].as_str()?.into(),
                        status: m["status"].as_str().unwrap_or("").into(),
                        source: m["source"].as_str().unwrap_or("").into(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Roda um subcomando do `claude` (lista fixa de argumentos, sem shell) e devolve a saída.
fn claude(args: &[&str]) -> Result<String, String> {
    let bin = tools::find("claude").ok_or("Não achei o comando `claude` neste PC.")?;
    let out = tools::command(&bin).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
    let text = |b: &[u8]| String::from_utf8_lossy(b).trim().to_string();
    if out.status.success() {
        Ok(text(&out.stdout))
    } else {
        let err = text(&out.stderr);
        Err(if err.is_empty() { text(&out.stdout) } else { err })
    }
}

pub fn plugin_toggle(id: &str, enable: bool) -> Result<String, String> {
    valid(id, "-_.@")?;
    claude(&["plugin", if enable { "enable" } else { "disable" }, id])
}

pub fn plugin_install(id: &str) -> Result<String, String> {
    valid(id.trim(), "-_.@")?;
    claude(&["plugin", "install", id.trim()])
}

/// Loja de plugins: repositório do GitHub (`dono/repo`), URL ou pasta.
pub fn marketplace_add(source: &str) -> Result<String, String> {
    let source = source.trim();
    if source.is_empty() || source.len() > 300 || source.starts_with('-') || source.chars().any(char::is_whitespace) {
        return Err("Informe a loja como dono/repositório, uma URL ou uma pasta, sem espaços.".into());
    }
    claude(&["plugin", "marketplace", "add", source])
}

pub fn mcp_add(name: &str, http: bool, target: &str, args: &[String]) -> Result<String, String> {
    valid(name, "-_.")?;
    let target = target.trim();
    if target.is_empty() {
        return Err(if http { "Falta o endereço do MCP." } else { "Falta o comando do MCP." }.into());
    }
    if http && !(target.starts_with("https://") || target.starts_with("http://")) {
        return Err("O endereço precisa começar com https:// ou http://".into());
    }
    let mut a: Vec<&str> = vec!["mcp", "add", "-s", "user"];
    if http {
        a.extend(["--transport", "http", name, target]);
    } else {
        a.extend([name, "--", target]);
        a.extend(args.iter().map(String::as_str));
    }
    claude(&a)
}

pub fn mcp_remove(name: &str) -> Result<String, String> {
    valid(name, "-_.")?;
    claude(&["mcp", "remove", "-s", "user", name])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn skills_and_rules_files() {
        let home = std::env::temp_dir().join(format!("orbia-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);

        save_skill(&home, "minha-skill", "---\ndescription: Primeira\n---\n").unwrap();
        save_skill(&home, "minha-skill", "---\ndescription: Segunda\n---\n").unwrap();
        let bak = std::fs::read_to_string(home.join(".claude/skills/minha-skill/SKILL.md.bak")).unwrap();
        assert!(bak.contains("Primeira"), "a cópia .bak guarda a versão anterior");
        assert_eq!(user_skills(&home), [UserSkill { name: "minha-skill".into(), description: "Segunda".into() }]);
        assert!(read_skill(&home, "minha-skill").unwrap().contains("Segunda"));

        assert!(save_skill(&home, "../fora", "x").is_err(), "nome com caminho é recusado");
        assert!(save_skill(&home, "", "x").is_err());

        delete_skill(&home, "minha-skill").unwrap();
        assert!(user_skills(&home).is_empty());

        assert_eq!(read_rules(&home), "");
        save_rules(&home, "regra 1").unwrap();
        save_rules(&home, "regra 2").unwrap();
        assert_eq!(read_rules(&home), "regra 2");
        assert_eq!(std::fs::read_to_string(home.join(".claude/CLAUDE.md.bak")).unwrap(), "regra 1");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn plugins_and_mcps() {
        let home = std::env::temp_dir().join(format!("orbia-plug-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".claude/plugins")).unwrap();
        std::fs::write(home.join(".claude/plugins/installed_plugins.json"), r#"{"plugins":{"pony@loja":[],"velho@loja":[]}}"#).unwrap();
        std::fs::write(home.join(".claude/settings.json"), r#"{"enabledPlugins":{"pony@loja":true,"velho@loja":false}}"#).unwrap();
        let init = json!({
            "skills": ["pony:a", "pony:b", "solta"],
            "mcp_servers": [{ "name": "obsidian", "status": "connected", "source": "user" }],
        });
        let p = plugins(&home, &init);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(p.len(), 2);
        assert_eq!((p[0].name.as_str(), p[0].enabled, p[0].skills.clone()), ("pony", true, vec!["a".to_string(), "b".into()]));
        assert_eq!((p[1].name.as_str(), p[1].enabled, p[1].skills.len()), ("velho", false, 0));
        let m = mcps(&init);
        assert_eq!((m[0].name.as_str(), m[0].status.as_str(), m[0].source.as_str()), ("obsidian", "connected", "user"));
    }

    #[test]
    fn mcp_validation() {
        assert!(mcp_add("ok", true, "ftp://x", &[]).unwrap_err().contains("https://"));
        assert!(mcp_add("ok", false, "  ", &[]).unwrap_err().contains("comando"));
        assert!(mcp_add("a b", false, "npx", &[]).is_err());
        assert!(plugin_toggle("x; rm -rf", true).is_err());
        assert!(plugin_install("a b").is_err());
        assert!(marketplace_add("--help").is_err());
        assert!(marketplace_add("dono/repo com espaço").is_err());
    }
}
