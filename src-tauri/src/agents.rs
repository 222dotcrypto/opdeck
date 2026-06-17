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

// Валиден ли нативный resume-id Claude по ФОРМАТУ (C3, аудит 2026-06-17): только hex+дефис, ≥8
// символов (UUID-подобный sessionId Claude). Отсекает шелл-метасимволы (кавычки/`;`/`$`/…) ДО того,
// как id попадёт в команду — даже если на диске лежит вредоносно названный `.jsonl`-файл.
pub fn is_valid_resume_id(id: &str) -> bool {
    let id = id.trim();
    id.len() >= 8 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// Имя + АРГУМЕНТЫ запуска агента в виде argv-массива (program + args), НЕ шелл-строкой.
// C1/C2/C4/C5/H3/H4/L2 (аудит 2026-06-17): возвращаем Vec<String>, где первый элемент — программа,
// остальные — отдельные аргументы. Сборщик команды (pty.rs) POSIX-экранирует каждый элемент по
// отдельности → шелл-метасимволы внутри resume_id/флагов становятся литералом, не синтаксисом.
// resume=true → восстановление сессии. Для Claude с валидным нативным resume_id — точный
// `--resume <id>` (RFC 0007); без id — фолбэк `--continue` (последняя в папке).
pub fn resolve(
    agent_id: &str,
    custom: &[crate::types::CustomAgent],
    resume: bool,
    resume_id: Option<&str>,
) -> (String, Option<Vec<String>>) {
    for (id, name, command) in BUILTINS {
        if *id == agent_id {
            if command.is_empty() {
                return (name.to_string(), None);
            }
            let argv: Vec<String> = if *id == "claude" {
                // RFC 0003: подключаем Deck-хуки через отдельный --settings (личный
                // ~/.claude/settings.json не трогаем — Claude мёрджит хуки поверх).
                let hooks = crate::hooks::claude_hooks_path().to_string_lossy().to_string();
                let mut v = vec!["claude".to_string()];
                // RFC 0007: точный resume по нативному id; иначе слепой --continue; новая → без флага.
                // resume_id принимаем ТОЛЬКО валидного формата (C3) — иначе считаем, что id нет.
                if resume {
                    match resume_id {
                        Some(rid) if is_valid_resume_id(rid) => {
                            v.push("--resume".to_string());
                            v.push(rid.trim().to_string());
                        }
                        _ => v.push("--continue".to_string()),
                    }
                }
                v.push("--settings".to_string());
                v.push(hooks);
                v
            } else if *id == "codex" {
                // RFC 0003 Фаза C: Deck-хуки статуса через профиль-оверлей `-p deck`
                // ($CODEX_HOME/deck.config.toml поверх базового config.toml — его не трогаем).
                // --dangerously-bypass-hook-trust: доверяем СВОЕМУ хуку (curl на localhost) без
                // интерактивного промта доверия; флаг НЕ ослабляет sandbox/approvals (это другой
                // флаг). resume у Codex — отдельная подкоманда, вне scope статус-хуков.
                vec![
                    "codex".to_string(),
                    "--dangerously-bypass-hook-trust".to_string(),
                    "-p".to_string(),
                    "deck".to_string(),
                ]
            } else {
                vec![command.to_string()]
            };
            return (name.to_string(), Some(argv));
        }
    }
    if let Some(c) = custom.iter().find(|c| c.id == agent_id) {
        // Кастомный агент: пользователь вводит команду строкой (напр. `aider --model gpt-5`).
        // Разбиваем по шелл-правилам (shlex) на argv. Если разбор не удался (несбалансированные
        // кавычки) — берём команду одним токеном (без интерпретации).
        let argv = shlex::split(&c.command).filter(|v| !v.is_empty()).unwrap_or_else(|| vec![c.command.clone()]);
        return (c.name.clone(), Some(argv));
    }
    (agent_id.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // helper: argv → одна строка для удобной проверки наличия флагов в тесте
    fn joined(v: &[String]) -> String {
        v.join(" ")
    }

    #[test]
    fn claude_resume_flag_precise_vs_continue_vs_fresh() {
        // точный resume по нативному id (валидный формат: hex+дефис, ≥8)
        let (_, c) = resolve("claude", &[], true, Some("0b58636d-10fe"));
        let c = c.unwrap();
        // --resume и id — ОТДЕЛЬНЫЕ элементы argv (не одна строка с пробелом)
        let pos = c.iter().position(|x| x == "--resume").expect("есть --resume");
        assert_eq!(c[pos + 1], "0b58636d-10fe");
        assert!(!c.iter().any(|x| x == "--continue"), "{:?}", c);
        // resume без id → слепой --continue (фолбэк)
        let (_, c) = resolve("claude", &[], true, None);
        let c = c.unwrap();
        assert!(c.iter().any(|x| x == "--continue") && !c.iter().any(|x| x == "--resume"), "{:?}", c);
        // пустой id трактуем как нет id → --continue
        let (_, c) = resolve("claude", &[], true, Some(""));
        assert!(c.unwrap().iter().any(|x| x == "--continue"));
        // новая сессия → без resume-флагов
        let (_, c) = resolve("claude", &[], false, None);
        let c = c.unwrap();
        assert!(!c.iter().any(|x| x == "--resume" || x == "--continue"), "{:?}", c);
        assert!(c.iter().any(|x| x == "--settings"), "{:?}", c); // хуки всегда подключены
    }

    // C3: resume_id с шелл-метасимволами невалиден по формату → трактуется как «нет id» → --continue,
    // а опасный id НИКОГДА не попадает в argv.
    #[test]
    fn malicious_resume_id_rejected_by_format() {
        for bad in [
            "id'; rm -rf /; echo '",
            "abc; touch /tmp/pwned",
            "$(whoami)",
            "`id`",
            "a|b",
            "with space",
            "../../etc/passwd",
            "short",   // <8 символов
            "GGGG1234", // не-hex буквы
        ] {
            assert!(!is_valid_resume_id(bad), "должен быть невалиден: {bad:?}");
            let (_, c) = resolve("claude", &[], true, Some(bad));
            let c = c.unwrap();
            assert!(!c.iter().any(|x| x == bad), "опасный id попал в argv: {:?}", c);
            assert!(c.iter().any(|x| x == "--continue"), "ожидался фолбэк --continue: {:?}", c);
        }
        // валидные форматы — проходят
        assert!(is_valid_resume_id("0b58636d-10fe-4a2b-9c3d-1234567890ab"));
        assert!(is_valid_resume_id("abcdef12"));
    }

    // C1/C4: кастомный агент с метасимволами в команде → они становятся ОТДЕЛЬНЫМИ argv-токенами
    // (shlex split), а не интерпретируются. `;`-как-разделитель команд тут невозможен.
    #[test]
    fn custom_agent_command_split_to_argv() {
        let custom = vec![crate::types::CustomAgent {
            id: "x".into(),
            name: "X".into(),
            command: "aider --model gpt-5".into(),
        }];
        let (_, c) = resolve("x", &custom, false, None);
        let c = c.unwrap();
        assert_eq!(c, vec!["aider", "--model", "gpt-5"]);
        let _ = joined(&c);
    }
}
