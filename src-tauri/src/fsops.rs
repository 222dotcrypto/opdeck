use crate::types::{FsEntry, OpResult};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn read_dir(dir: &str) -> Vec<FsEntry> {
    let mut entries: Vec<FsEntry> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                !n.starts_with(".git")
            })
            .map(|e| {
                let p = e.path();
                FsEntry {
                    name: e.file_name().to_string_lossy().to_string(),
                    path: p.to_string_lossy().to_string(),
                    is_dir: p.is_dir(),
                }
            })
            .collect(),
        Err(_) => vec![],
    };
    // папки сверху, потом по имени
    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });
    entries
}

pub fn read_file(path: &str) -> String {
    match fs::metadata(path) {
        Ok(m) if m.len() > 2_000_000 => "// файл слишком большой для предпросмотра".to_string(),
        Ok(_) => fs::read_to_string(path).unwrap_or_else(|e| format!("// не удалось открыть файл: {e}")),
        Err(e) => format!("// не удалось открыть файл: {e}"),
    }
}

pub fn write_file(path: &str, content: &str) -> bool {
    fs::write(path, content).is_ok()
}

pub fn rename(path: &str, new_name: &str) -> OpResult {
    let p = Path::new(path);
    let parent = match p.parent() {
        Some(par) => par,
        None => return err("нет родительской папки"),
    };
    let next = parent.join(new_name);
    if next.exists() {
        return err("Файл с таким именем уже есть");
    }
    match fs::rename(p, &next) {
        Ok(_) => ok(Some(next.to_string_lossy().to_string())),
        Err(e) => err(&e.to_string()),
    }
}

pub fn duplicate(path: &str) -> OpResult {
    let p = Path::new(path);
    let parent = match p.parent() {
        Some(par) => par,
        None => return err("нет родительской папки"),
    };
    let is_dir = p.is_dir();
    let ext = if is_dir { "".to_string() } else {
        p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default()
    };
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());

    let mut next: PathBuf = parent.join(format!("{} копия{}", stem, ext));
    let mut n = 2;
    while next.exists() {
        next = parent.join(format!("{} копия {}{}", stem, n, ext));
        n += 1;
    }

    let result = if is_dir {
        Command::new("cp")
            .args(["-R", path, &next.to_string_lossy()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        fs::copy(p, &next).is_ok()
    };

    if result {
        ok(Some(next.to_string_lossy().to_string()))
    } else {
        err("не удалось скопировать")
    }
}

pub fn trash(path: &str) -> OpResult {
    match trash::delete(path) {
        Ok(_) => ok(None),
        Err(e) => err(&e.to_string()),
    }
}

// Корень для «своих веток»/копий: всегда домашняя папка пользователя — `~/.deck-worktrees`.
// Раньше клали рядом с проектом (`<родитель>/.deck-worktrees`), но если проект = сам ~/
// (или другой каталог с несписываемым родителем, напр. `/Users`, владелец root),
// запись падала с «Permission denied». Дом всегда доступен на запись. Имена уникальны
// (`<base>-<label>-<rand>`) → коллизий между проектами нет даже в одной плоской папке.
pub fn worktrees_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".deck-worktrees")
}

// Простая локальная копия папки (для параллельной работы без git).
// Кладём в ~/.deck-worktrees/<base>-<label>-<rand> (см. worktrees_root).
pub fn create_copy(folder: &str, label: &str, rand: &str) -> Result<String, String> {
    let p = Path::new(folder);
    let base = p.file_name().and_then(|s| s.to_str()).unwrap_or("dir");
    let safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(20)
        .collect();
    let dest = worktrees_root().join(format!("{}-{}-{}", base, safe, rand));
    if let Some(par) = dest.parent() {
        fs::create_dir_all(par).map_err(|e| e.to_string())?;
    }
    let status = Command::new("cp")
        .args(["-R", folder, &dest.to_string_lossy()])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(dest.to_string_lossy().to_string())
    } else {
        Err("копирование папки не удалось".into())
    }
}

// RFC 0012: суммарный размер папки в байтах (рекурсивно, по файлам). Симлинки не разворачиваем
// (is_dir у симлинка = false → пропускаем). Для пустой/несуществующей — 0.
pub fn dir_size(path: &str) -> u64 {
    fn walk(p: &Path) -> u64 {
        let mut total = 0u64;
        let rd = match fs::read_dir(p) {
            Ok(r) => r,
            Err(_) => return 0,
        };
        for e in rd.flatten() {
            match e.file_type() {
                Ok(ft) if ft.is_dir() => total += walk(&e.path()),
                Ok(ft) if ft.is_file() => total += e.metadata().map(|m| m.len()).unwrap_or(0),
                _ => {}
            }
        }
        total
    }
    walk(Path::new(path))
}

pub fn reveal(path: &str) -> bool {
    Command::new("open")
        .args(["-R", path])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn ok(path: Option<String>) -> OpResult {
    OpResult { ok: true, path, error: None }
}
fn err(msg: &str) -> OpResult {
    OpResult { ok: false, path: None, error: Some(msg.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Регресс-замок бага «Permission denied» (worktree в /Users/.deck-worktrees):
    // корень worktree всегда под домашней папкой, НЕ под родителем проекта.
    #[test]
    fn worktrees_root_is_under_home_not_project_parent() {
        let root = worktrees_root();
        assert!(root.is_absolute(), "путь должен быть абсолютным");
        assert!(root.ends_with(".deck-worktrees"), "хвост = .deck-worktrees");
        if let Some(home) = dirs::home_dir() {
            assert!(root.starts_with(&home), "worktree-корень внутри ~/, не в /Users");
            assert_ne!(root.parent(), Some(std::path::Path::new("/Users")));
        }
    }
}
