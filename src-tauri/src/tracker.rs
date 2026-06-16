// Снимок-трекер папки (RFC 0011, амендмент A1) — список «Изменения» + diff БЕЗ git.
//
// Идея: на старте слежки за не-git папкой делаем СНИМОК («было») — содержимое
// текстовых файлов + размер/время изменения. Дальше список изменений и diff
// считаем СРАВНЕНИЕМ снимка с тем, что на диске сейчас. Это надёжнее накопления
// notify-событий (ничего не теряется) и сразу даёт created/modified/deleted.
//
// Приоритет git: gate в commands.rs зовёт трекер ТОЛЬКО когда папка не под git.

use crate::types::{ChangedFile, DiffPair};
use std::collections::HashMap;
use std::fs::Metadata;
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

// ── Лимиты (защита памяти/скорости на больших папках) ──
const PER_FILE_CONTENT_CAP: u64 = 256 * 1024; // на файл: крупнее не снимаем в «было»
const TOTAL_CONTENT_CAP: usize = 48 * 1024 * 1024; // суммарно на снимок одной папки
const MAX_FILES: usize = 50_000; // потолок числа файлов при обходе
// Порог «папка слишком велика для надёжного снимок-diff без git»: выше него снимок либо
// обрезается по потолку, либо строится дольше, чем юзер успевает править (гонка) → «было»
// совпадает со «стало», diff пустой. Используется ТОЛЬКО для мягкой подсказки в UI.
const SNAPSHOT_WARN_FILES: usize = 20_000;
const MAX_BASELINES: usize = 8; // сколько папок держим снимками одновременно

// Папки-шум (артефакты сборок/окружений/кэши инструментов) — не правятся руками,
// обход их пропускает (иначе их бинарный кэш сыплется в список «Изменения»).
const EXCLUDES: &[&str] = &[
    ".git",
    "node_modules",
    ".deck-worktrees",
    ".pilotry-worktrees",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "dist-web",
    "build",
    "out",
    ".next",
    ".serena", // кэш Serena (LSP-символы, .pkl) — меняется сам, не правки пользователя
    ".idea",
    ".cache",
];

// Пометки, когда «было» недоступно (без git) — показываем в diff вместо паники.
const OLD_UNAVAILABLE: &str =
    "⟨без git⟩ оригинал не сохранён (файл больше 256 КБ или папка слишком большая)";
const CUR_BIG: &str = "⟨без git⟩ файл слишком большой для diff (>256 КБ)";
const CUR_BINARY: &str = "⟨без git⟩ бинарный файл — diff не показывается";

struct FileSnap {
    size: u64,
    mtime_ms: i64,
    // None — бинарь / больше лимита на файл / упёрлись в общий лимит снимка.
    content: Option<String>,
}

struct Baseline {
    files: HashMap<String, FileSnap>,
}

// Снимки по папкам. Один активный воркспейс за раз, но держим несколько папок,
// чтобы переключение туда-сюда не сбрасывало «было».
static BASELINES: Mutex<Option<HashMap<String, Baseline>>> = Mutex::new(None);

fn mtime_ms(meta: &Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Рекурсивный обход файлов папки (без следования по симлинкам — защита от циклов).
// Для каждого ФАЙЛА зовёт visit(абсолютный путь, путь-относительно-root, метаданные).
fn walk_files(
    root: &Path,
    dir: &Path,
    count: &mut usize,
    max: usize,
    visit: &mut dyn FnMut(&Path, String, &Metadata),
) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if *count >= max {
            return;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue; // не идём по симлинкам (циклы) и не снимаем их
        }
        let p = entry.path();
        if ft.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if EXCLUDES.contains(&name.as_ref()) {
                continue;
            }
            // Вложенный git-репозиторий = отдельный проект (свой git-diff при открытии
            // напрямую). Не спускаемся в него, иначе изменения чужих проектов сыплются
            // в список этой папки. `.git` бывает и файлом (worktree/submodule) → `exists`.
            if p.join(".git").exists() {
                continue;
            }
            walk_files(root, &p, count, max, visit);
        } else if ft.is_file() {
            // Системный мусор macOS — не правка пользователя, пропускаем.
            if entry.file_name().to_string_lossy() == ".DS_Store" {
                continue;
            }
            *count += 1;
            if let Ok(rel) = p.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if let Ok(meta) = entry.metadata() {
                    visit(&p, rel, &meta);
                }
            }
        }
    }
}

// Построить снимок папки (IO без удержания мьютекса).
fn build_baseline(folder: &str) -> Baseline {
    let root = Path::new(folder);
    let mut files: HashMap<String, FileSnap> = HashMap::new();
    let mut total: usize = 0;
    let mut count: usize = 0;
    {
        let mut visit = |abs: &Path, rel: String, meta: &Metadata| {
            let size = meta.len();
            let mtime = mtime_ms(meta);
            let content = if size > PER_FILE_CONTENT_CAP {
                None // слишком большой файл — содержимое не снимаем
            } else if total >= TOTAL_CONTENT_CAP {
                None // упёрлись в общий лимит снимка
            } else {
                match std::fs::read(abs) {
                    Ok(bytes) => match String::from_utf8(bytes) {
                        Ok(s) => {
                            total += s.len();
                            Some(s)
                        }
                        Err(_) => None, // невалидный UTF-8 → считаем бинарём
                    },
                    Err(_) => None,
                }
            };
            files.insert(
                rel,
                FileSnap {
                    size,
                    mtime_ms: mtime,
                    content,
                },
            );
        };
        walk_files(root, root, &mut count, MAX_FILES, &mut visit);
    }
    Baseline { files }
}

// Гарантировать снимок для папки (строим один раз; IO без удержания мьютекса).
fn ensure_baseline(folder: &str) {
    {
        let g = BASELINES.lock().unwrap();
        if let Some(m) = g.as_ref() {
            if m.contains_key(folder) {
                return;
            }
        }
    }
    let b = build_baseline(folder);
    let mut g = BASELINES.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    if m.contains_key(folder) {
        return; // другой поток успел построить
    }
    if m.len() >= MAX_BASELINES {
        m.clear(); // простой потолок памяти
    }
    m.insert(folder.to_string(), b);
}

// Построить снимок заранее (зовётся фоновым потоком из fswatch для не-git папки).
pub fn prime(folder: &str) {
    ensure_baseline(folder);
}

// Забыть снимок одной папки (папка оказалась git — снимок не нужен).
pub fn drop_baseline(folder: &str) {
    let mut g = BASELINES.lock().unwrap();
    if let Some(m) = g.as_mut() {
        m.remove(folder);
    }
}

// Забыть все снимки (перестали следить — освобождаем память).
pub fn clear_all() {
    *BASELINES.lock().unwrap() = None;
}

// Достигает ли число файлов папки порога `cap` (с ранним выходом — не обходим всю громадину).
fn folder_file_count_reaches(folder: &str, cap: usize) -> bool {
    let root = Path::new(folder);
    let mut count: usize = 0;
    {
        let mut visit = |_abs: &Path, _rel: String, _meta: &Metadata| {};
        walk_files(root, root, &mut count, cap, &mut visit);
    }
    count >= cap
}

// Папка слишком велика для надёжного снимок-diff БЕЗ git? (мягкая подсказка в UI).
// На такой громадине снимок «было» обрезается/строится с гонкой → «было»==«стало», diff пуст.
pub fn is_snapshot_oversized(folder: &str) -> bool {
    folder_file_count_reaches(folder, SNAPSHOT_WARN_FILES)
}

// Размер совпал, а mtime отличается — файл правда изменён? mtime меняется и БЕЗ правки
// текста (touch, пересохранение тем же содержимым, синк облака) → иначе нетронутый файл
// сыплется в список «Изменения» ложняком. Сверяем СОДЕРЖИМОЕ «было» (из снимка) с диском.
// Возвращает true, если содержимое реально отличается ИЛИ сверить нечем
// (бинарь / файл больше лимита в снимке / не читается сейчас) → консервативно «изменён».
fn content_changed_since_baseline(folder: &str, rel: &str, abs: &Path) -> bool {
    // «было» из снимка — короткое удержание мьютекса (клонируем только нужный текст).
    let base_text = {
        let g = BASELINES.lock().unwrap();
        match g
            .as_ref()
            .and_then(|m| m.get(folder))
            .and_then(|b| b.files.get(rel))
        {
            Some(snap) => match &snap.content {
                Some(c) => c.clone(),
                None => return true, // в снимке бинарь/больше лимита → сверить нечем → modified
            },
            None => return true, // в снимке нет (теоретически) → консервативно modified
        }
    };
    // «стало» — читаем файл с диска как текст. Не читается / не UTF-8 → сверить нельзя → modified.
    match std::fs::read(abs) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(cur) => cur != base_text, // равно → ложняк mtime (не показываем); иначе modified
            Err(_) => true,
        },
        Err(_) => true,
    }
}

// Список изменённых файлов БЕЗ git — сравнение текущего состояния со снимком.
pub fn status(folder: &str) -> Vec<ChangedFile> {
    ensure_baseline(folder);
    // снимаем метаданные базы под мьютексом и сразу отпускаем (обход — без блокировки)
    let base_meta: HashMap<String, (u64, i64)> = {
        let g = BASELINES.lock().unwrap();
        match g.as_ref().and_then(|m| m.get(folder)) {
            Some(b) => b
                .files
                .iter()
                .map(|(k, v)| (k.clone(), (v.size, v.mtime_ms)))
                .collect(),
            None => return vec![],
        }
    };
    let root = Path::new(folder);
    let mut cur: HashMap<String, (u64, i64)> = HashMap::new();
    let mut count: usize = 0;
    {
        let mut visit = |_abs: &Path, rel: String, meta: &Metadata| {
            cur.insert(rel, (meta.len(), mtime_ms(meta)));
        };
        walk_files(root, root, &mut count, MAX_FILES, &mut visit);
    }
    let mut res: Vec<ChangedFile> = vec![];
    for (rel, (sz, mt)) in &cur {
        match base_meta.get(rel) {
            None => res.push(ChangedFile {
                path: rel.clone(),
                status: "added".into(),
                staged: false,
            }),
            Some((bsz, bmt)) => {
                let changed = if sz != bsz {
                    true // размер другой → точно изменён (содержимое не сверяем — и так ясно)
                } else if mt != bmt {
                    // размер тот же, время другое → ложняк mtime возможен: сверяем содержимое
                    content_changed_since_baseline(folder, rel, &root.join(rel))
                } else {
                    false // размер и время совпали → не изменён
                };
                if changed {
                    res.push(ChangedFile {
                        path: rel.clone(),
                        status: "modified".into(),
                        staged: false,
                    });
                }
            }
        }
    }
    for rel in base_meta.keys() {
        if !cur.contains_key(rel) {
            res.push(ChangedFile {
                path: rel.clone(),
                status: "deleted".into(),
                staged: false,
            });
        }
    }
    res.sort_by(|a, b| a.path.cmp(&b.path));
    res
}

// Текущее содержимое файла для правой колонки diff (с лимитом и пометками).
fn read_current_capped(path: &Path) -> String {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return String::new(), // нет файла → пусто (удалён)
    };
    if meta.len() > PER_FILE_CONTENT_CAP {
        return CUR_BIG.to_string();
    }
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).unwrap_or_else(|_| CUR_BINARY.to_string()),
        Err(_) => String::new(),
    }
}

// Пара «было → стало» БЕЗ git: «было» из снимка, «стало» с диска сейчас.
pub fn diff(folder: &str, rel: &str) -> DiffPair {
    ensure_baseline(folder);
    let (old_text, existed_in_base) = {
        let g = BASELINES.lock().unwrap();
        match g.as_ref().and_then(|m| m.get(folder)) {
            Some(b) => match b.files.get(rel) {
                Some(snap) => match &snap.content {
                    Some(c) => (c.clone(), true),
                    None => (OLD_UNAVAILABLE.to_string(), true),
                },
                None => (String::new(), false), // не было в базе → новый файл
            },
            None => (String::new(), false),
        }
    };
    let cur_path = Path::new(folder).join(rel);
    let exists_now = cur_path.is_file();
    let new_text = if exists_now {
        read_current_capped(&cur_path)
    } else {
        String::new()
    };
    let status = if !existed_in_base && exists_now {
        "added"
    } else if existed_in_base && !exists_now {
        "deleted"
    } else {
        "modified"
    };
    DiffPair {
        old_text,
        new_text,
        status: status.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Все тесты делят ОДИН глобальный снимок (static BASELINES). Гоняем их по одному,
    // иначе clear_all из соседнего теста сносит базу прямо под нами (флака). Из
    // «отравленного» мьютекса восстанавливаемся, чтобы паника одного теста не топила остальные.
    fn test_guard() -> std::sync::MutexGuard<'static, ()> {
        static G: Mutex<()> = Mutex::new(());
        G.lock().unwrap_or_else(|e| e.into_inner())
    }

    // Реальная проверка исключений (НЕ мок): создаём временную папку с .serena и .DS_Store,
    // строим снимок, меняем всё — в «Изменениях» должен быть только обычный файл.
    #[test]
    fn excludes_skip_serena_and_dsstore() {
        let _g = test_guard();
        let dir = std::env::temp_dir().join(format!("deck_tracker_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".serena/cache/python")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join(".serena/cache/python/x.pkl"), b"cache-old").unwrap();
        fs::write(dir.join(".DS_Store"), b"macos-junk").unwrap();
        fs::write(dir.join("src/a.txt"), b"hello").unwrap();
        let folder = dir.to_string_lossy().to_string();

        prime(&folder); // снимок «было»

        // меняем обычный файл (другой размер → точно «modified») и трогаем исключённые
        fs::write(dir.join("src/a.txt"), b"hello world").unwrap();
        fs::write(dir.join(".serena/cache/python/x.pkl"), b"cache-new-changed").unwrap();
        fs::write(dir.join(".serena/cache/python/y.pkl"), b"cache-added").unwrap();
        fs::write(dir.join(".DS_Store"), b"junk-changed").unwrap();

        let changes = status(&folder);
        let paths: Vec<String> = changes.iter().map(|c| c.path.clone()).collect();

        assert!(
            paths.iter().any(|p| p == "src/a.txt"),
            "обычный файл должен попасть в изменения, получили: {:?}",
            paths
        );
        assert!(
            !paths.iter().any(|p| p.contains(".serena")),
            ".serena обязан быть исключён, получили: {:?}",
            paths
        );
        assert!(
            !paths.iter().any(|p| p.contains("DS_Store")),
            ".DS_Store обязан быть исключён, получили: {:?}",
            paths
        );

        clear_all();
        let _ = fs::remove_dir_all(&dir);
    }

    // Реальная проверка фикса ложняка по mtime (НЕ мок): берём снимок, потом
    // ПЕРЕСОХРАНЯЕМ файл теми же байтами (mtime сменится, текст — нет) — файл НЕ должен
    // попасть в «Изменения». Затем реально правим текст — обязан показаться как modified.
    #[test]
    fn mtime_change_without_content_is_not_modified() {
        let _g = test_guard();
        let dir = std::env::temp_dir().join(format!("deck_tracker_mtime_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("note.txt"), b"same content").unwrap();
        let folder = dir.to_string_lossy().to_string();

        prime(&folder); // снимок «было»

        // Сдвигаем mtime гарантированно в другую миллисекунду, текст оставляем тем же.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("note.txt"), b"same content").unwrap();

        let changes = status(&folder);
        assert!(
            changes.is_empty(),
            "файл с новым mtime, но тем же содержимым НЕ должен попадать в изменения, получили: {:?}",
            changes.iter().map(|c| c.path.clone()).collect::<Vec<_>>()
        );

        // Настоящая правка текста (другой размер тоже) — обязана показаться.
        fs::write(dir.join("note.txt"), b"different content now").unwrap();
        let changes2 = status(&folder);
        assert!(
            changes2
                .iter()
                .any(|c| c.path == "note.txt" && c.status == "modified"),
            "правка текста обязана показаться как modified, получили: {:?}",
            changes2
        );

        clear_all();
        let _ = fs::remove_dir_all(&dir);
    }

    // Ранний выход счётчика файлов (основа подсказки «папка слишком большая»):
    // 5 файлов → порог 3 достигнут (oversized), порог 10 — нет.
    #[test]
    fn folder_file_count_early_exit() {
        let _g = test_guard();
        let dir = std::env::temp_dir().join(format!("deck_tracker_count_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let folder = dir.to_string_lossy().to_string();

        assert!(
            folder_file_count_reaches(&folder, 3),
            "5 файлов должны достигать порога 3"
        );
        assert!(
            !folder_file_count_reaches(&folder, 10),
            "5 файлов НЕ должны достигать порога 10"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    // Вложенный git-репозиторий (свой проект) НЕ попадает в изменения не-git папки:
    // его файлы — забота его git, не этой папки. Пропускается по маркеру `.git`.
    #[test]
    fn nested_git_repo_is_skipped() {
        let _g = test_guard();
        let dir = std::env::temp_dir().join(format!("deck_tracker_nested_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        // вложенный «репозиторий» subproj с маркером .git и файлом внутри
        fs::create_dir_all(dir.join("subproj/.git")).unwrap();
        fs::create_dir_all(dir.join("subproj/src")).unwrap();
        fs::write(dir.join("subproj/.git/HEAD"), b"ref: refs/heads/main").unwrap();
        fs::write(dir.join("subproj/src/inner.txt"), b"inner-old").unwrap();
        // свободный файл прямо в папке
        fs::write(dir.join("loose.txt"), b"loose-old").unwrap();
        let folder = dir.to_string_lossy().to_string();

        prime(&folder);

        fs::write(dir.join("subproj/src/inner.txt"), b"inner-changed!!").unwrap();
        fs::write(dir.join("loose.txt"), b"loose-changed!!").unwrap();

        let changes = status(&folder);
        let paths: Vec<String> = changes.iter().map(|c| c.path.clone()).collect();
        assert!(
            paths.iter().any(|p| p == "loose.txt"),
            "свободный файл папки должен быть в изменениях: {:?}",
            paths
        );
        assert!(
            !paths.iter().any(|p| p.contains("subproj")),
            "вложенный git-репозиторий обязан быть пропущен: {:?}",
            paths
        );

        clear_all();
        let _ = fs::remove_dir_all(&dir);
    }
}
