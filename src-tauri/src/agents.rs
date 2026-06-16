use crate::types::Agent;
use std::process::Command;

// Встроенные агенты: (id, имя, команда). Пустая команда = просто оболочка.
const BUILTINS: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("codex", "Codex", "codex"),
    ("gemini", "Gemini", "gemini"),
    ("qwen", "Qwen", "qwen"),
    ("grok", "Grok", "grok"),
    ("opencode", "opencode", "opencode"),
    ("shell", "Shell", ""),
];

// Проверяем доступность бинарника через login-shell (чтобы был полный PATH).
fn is_available(command: &str) -> bool {
    if command.is_empty() {
        return true; // shell всегда есть
    }
    Command::new("/bin/zsh")
        .args(["-lic", &format!("command -v {}", command)])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn detect_builtins() -> Vec<Agent> {
    BUILTINS
        .iter()
        .map(|(id, name, command)| Agent {
            id: id.to_string(),
            name: name.to_string(),
            command: command.to_string(),
            args: vec![],
            available: is_available(command),
            custom: false,
        })
        .collect()
}

// Имя + командная строка запуска для агента.
// resume=true → восстановление сессии. Для Claude с известным нативным resume_id — точный
// `--resume <id>` (RFC 0007); без id — фолбэк `--continue` (последняя в папке).
pub fn resolve(
    agent_id: &str,
    custom: &[crate::types::CustomAgent],
    resume: bool,
    resume_id: Option<&str>,
) -> (String, Option<String>) {
    for (id, name, command) in BUILTINS {
        if *id == agent_id {
            if command.is_empty() {
                return (name.to_string(), None);
            }
            let cmd = if *id == "claude" {
                // RFC 0003: подключаем Deck-хуки через отдельный --settings (личный
                // ~/.claude/settings.json не трогаем — Claude мёрджит хуки поверх).
                let hooks = crate::hooks::claude_hooks_path().to_string_lossy().to_string();
                // RFC 0007: точный resume по нативному id; иначе слепой --continue; новая → без флага.
                let cont = if resume {
                    match resume_id {
                        Some(rid) if !rid.is_empty() => format!(" --resume {rid}"),
                        _ => " --continue".to_string(),
                    }
                } else {
                    String::new()
                };
                format!("claude{} --settings '{}'", cont, hooks)
            } else if *id == "codex" {
                // RFC 0003 Фаза C: Deck-хуки статуса через профиль-оверлей `-p deck`
                // ($CODEX_HOME/deck.config.toml поверх базового config.toml — его не трогаем).
                // --dangerously-bypass-hook-trust: доверяем СВОЕМУ хуку (curl на localhost) без
                // интерактивного промта доверия; флаг НЕ ослабляет sandbox/approvals (это другой
                // флаг). resume у Codex — отдельная подкоманда, вне scope статус-хуков.
                "codex --dangerously-bypass-hook-trust -p deck".to_string()
            } else {
                command.to_string()
            };
            return (name.to_string(), Some(cmd));
        }
    }
    if let Some(c) = custom.iter().find(|c| c.id == agent_id) {
        return (c.name.clone(), Some(c.command.clone()));
    }
    (agent_id.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_resume_flag_precise_vs_continue_vs_fresh() {
        // точный resume по нативному id
        let (_, c) = resolve("claude", &[], true, Some("abc-123"));
        let c = c.unwrap();
        assert!(c.contains("--resume abc-123"), "{c}");
        assert!(!c.contains("--continue"), "{c}");
        // resume без id → слепой --continue (фолбэк)
        let (_, c) = resolve("claude", &[], true, None);
        let c = c.unwrap();
        assert!(c.contains("--continue") && !c.contains("--resume"), "{c}");
        // пустой id трактуем как нет id → --continue
        let (_, c) = resolve("claude", &[], true, Some(""));
        assert!(c.unwrap().contains("--continue"));
        // новая сессия → без resume-флагов
        let (_, c) = resolve("claude", &[], false, None);
        let c = c.unwrap();
        assert!(!c.contains("--resume") && !c.contains("--continue"), "{c}");
        assert!(c.contains("--settings"), "{c}"); // хуки всегда подключены
    }
}
