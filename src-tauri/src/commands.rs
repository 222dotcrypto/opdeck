use crate::agents;
use crate::fsops;
use crate::gitops;
use crate::pty::PtyManager;
use crate::state::StateStore;
use crate::types::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn gen_id() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{:x}-{:x}", n, c)
}
fn rand_suffix() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", n & 0xffffff)
}

// ── Состояние ──
#[tauri::command]
pub fn state_get(store: State<'_, Mutex<StateStore>>) -> PersistState {
    store.lock().unwrap().data.clone()
}

#[tauri::command]
pub fn state_save(store: State<'_, Mutex<StateStore>>, mut state: PersistState) -> bool {
    let mut s = store.lock().unwrap();
    // RFC 0007 / H9 (аудит 2026-06-17): backend-owned поля сессии (resume_id + transcript_path)
    // пишутся хуком — фронт их не знает и при full-replace стейта затёр бы. Сохраняем существующее
    // значение, если входящее пусто (паттерн guard против full-replace, как favorites/blacklist
    // в useful-v4). Любое НОВОЕ backend-owned поле сессии добавлять в этот же цикл, иначе будет
    // молча теряться на каждом persist фронта.
    for incoming in state.sessions.iter_mut() {
        if let Some(old) = s.data.sessions.iter().find(|x| x.id == incoming.id) {
            if incoming.resume_id.is_none() {
                incoming.resume_id = old.resume_id.clone();
            }
            if incoming.transcript_path.is_none() {
                incoming.transcript_path = old.transcript_path.clone();
            }
        }
    }
    s.data = state;
    // обновляем разрешённые корни предпросмотра = папки воркспейсов
    set_allowed_roots(s.data.workspaces.iter().map(|w| w.folder.clone()).collect());
    s.save();
    true
}

// ── Агенты ──
#[tauri::command]
pub fn agents_list(store: State<'_, Mutex<StateStore>>) -> Vec<Agent> {
    let mut list = agents::detect_builtins();
    let custom = store.lock().unwrap().data.custom_agents.clone();
    for c in custom {
        list.push(Agent {
            id: c.id,
            name: c.name,
            command: c.command,
            args: vec![],
            available: true,
            custom: true,
        });
    }
    list
}

// ── Файлы ──
#[tauri::command]
pub fn fs_read_dir(dir: String) -> Vec<FsEntry> {
    fsops::read_dir(&dir)
}
#[tauri::command]
pub fn fs_read_file(path: String) -> String {
    fsops::read_file(&path)
}
// Файл как data-URL (base64) — для картинок в превью: вебвью так грузит локальные файлы надёжно.
#[tauri::command]
pub fn fs_read_file_data_url(path: String) -> Option<String> {
    use base64::Engine;
    let meta = std::fs::metadata(&path).ok()?;
    if meta.len() > 10_000_000 {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}
// Сохранить картинку (base64) во временный файл и вернуть путь. Нужно для вставки
// картинки в терминал: агенты (Claude Code и др.) принимают изображение ПО ПУТИ к файлу.
#[tauri::command]
pub fn save_image_bytes(b64: String, ext: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("пустая картинка".into());
    }
    let dir = dirs::cache_dir()
        .map(|p| p.join("Deck").join("pasted"))
        .ok_or("нет каталога кэша")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe_ext = if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        "png".to_string()
    };
    let path = dir.join(format!("paste-{ts}.{safe_ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// Реальные пути файлов/папок из буфера обмена macOS (cmd+c в Finder).
// Браузерный буфер в WKWebView НЕ отдаёт путь (а для папки File вообще null),
// поэтому достаём через osascript: «the clipboard as furl» → POSIX path.
// Скриншот в буфере = только байты (furl нет) → вернётся пусто, дальше сработает
// сохранение во временный файл (save_image_bytes).
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    let script = "set out to \"\"\n\
        try\n\
        set theItems to (the clipboard as «class furl»)\n\
        set out to POSIX path of theItems\n\
        end try\n\
        return out";
    // абсолютный путь: у собранного .app PATH может быть урезанным
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output();
    match output {
        Ok(o) => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                Vec::new()
            } else {
                vec![s]
            }
        }
        Err(_) => Vec::new(),
    }
}

// ── Контроль доступа к файлам предпросмотра (deck-preview) ──
// Разрешённые корни = папки воркспейсов + cwd сессий. Чтение через deck-preview
// ограничено этими корнями (защита от чтения произвольных путей вроде ~/.ssh).
// Fail-open: пустой список (ещё не заполнен) → разрешаем, чтобы не сломать превью.
static ALLOWED_ROOTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn set_allowed_roots(roots: Vec<String>) {
    *ALLOWED_ROOTS.lock().unwrap() = roots.into_iter().filter(|r| !r.is_empty()).collect();
}
pub fn add_allowed_root(root: &str) {
    if root.is_empty() {
        return;
    }
    let mut r = ALLOWED_ROOTS.lock().unwrap();
    if !r.iter().any(|x| x == root) {
        r.push(root.to_string());
    }
}
fn canon(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string())
}
pub fn path_allowed(path: &str) -> bool {
    let roots = ALLOWED_ROOTS.lock().unwrap();
    if roots.is_empty() {
        return true; // fail-open: список ещё не заполнен — не ломаем превью
    }
    let p = canon(path);
    roots.iter().any(|r| {
        let rc = canon(r);
        p == rc || p.starts_with(&format!("{}/", rc.trim_end_matches('/')))
    })
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "jsx" | "ts" | "tsx" => "application/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

// Резолв клика по пути из вывода терминала: прямой путь от cwd; если файла нет —
// ищем по имени в папке воркспейса (агент часто печатает голое имя без подпапки).
// H7 (аудит 2026-06-17): cwd ОБЯЗАН быть внутри разрешённых корней (папки воркспейсов + cwd
// сессий). Иначе вернуть исходную ссылку как есть — НЕ запускаем рекурсивный поиск по чужим
// деревьям (напр. cwd="/etc" + reference="passwd"). path_allowed fail-open пока roots пуст.
#[tauri::command]
pub fn fs_resolve(cwd: String, reference: String) -> String {
    if !path_allowed(&cwd) {
        return reference;
    }
    let clean = reference.trim_start_matches("./");
    let abs = if clean.starts_with('/') {
        clean.to_string()
    } else {
        format!("{}/{}", cwd.trim_end_matches('/'), clean)
    };
    if std::path::Path::new(&abs).exists() {
        return abs;
    }
    let name = std::path::Path::new(clean)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if !name.is_empty() {
        if let Some(found) = find_by_name(std::path::Path::new(&cwd), name, 0) {
            return found;
        }
    }
    abs
}

fn find_by_name(dir: &std::path::Path, name: &str, depth: u32) -> Option<String> {
    if depth > 6 {
        return None;
    }
    let mut subdirs = vec![];
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let fname = e.file_name();
        let fname = fname.to_str().unwrap_or("");
        if fname.starts_with('.')
            || matches!(fname, "node_modules" | "target" | "dist" | "dist-web" | "out")
        {
            continue;
        }
        let p = e.path();
        if p.is_file() && fname == name {
            return Some(p.to_string_lossy().to_string());
        }
        if p.is_dir() {
            subdirs.push(p);
        }
    }
    for d in subdirs {
        if let Some(f) = find_by_name(&d, name, depth + 1) {
            return Some(f);
        }
    }
    None
}

#[tauri::command]
pub fn fs_write_file(app: AppHandle, path: String, content: String) -> bool {
    let ok = fsops::write_file(&path, &content);
    if !ok {
        let _ = app.emit("toast", serde_json::json!({ "kind": "error", "text": "Не сохранилось" }));
    }
    ok
}
#[tauri::command]
pub fn fs_rename(path: String, new_name: String) -> OpResult {
    fsops::rename(&path, &new_name)
}
#[tauri::command]
pub fn fs_duplicate(path: String) -> OpResult {
    fsops::duplicate(&path)
}
#[tauri::command]
pub fn fs_trash(path: String) -> OpResult {
    fsops::trash(&path)
}
#[tauri::command]
pub fn fs_reveal(path: String) -> bool {
    fsops::reveal(&path)
}

// ── Git ──
#[tauri::command]
pub fn git_is_repo(folder: String) -> bool {
    gitops::is_repo(&folder)
}
#[tauri::command]
pub fn git_worktrees(folder: String) -> Vec<WorktreeInfo> {
    gitops::list_worktrees(&folder)
}
#[tauri::command]
pub fn git_branch(folder: String) -> Option<String> {
    gitops::current_branch(&folder)
}
// Какие файлы агент тронул в папке (для списка «Изменения»).
// Приоритет git: репо → git status; не-git → снимок-трекер (RFC 0011 A1).
#[tauri::command]
pub fn git_status(folder: String) -> Vec<ChangedFile> {
    if gitops::is_repo(&folder) {
        gitops::status(&folder)
    } else {
        crate::tracker::status(&folder)
    }
}
// Diff «было → стало» по одному файлу (путь относительно папки воркспейса).
// Репо → git show HEAD; не-git → снимок-трекер (RFC 0011 A1).
#[tauri::command]
pub fn git_diff_file(folder: String, path: String) -> DiffPair {
    // H5: гейт против traversal (`../../.ssh/id_rsa`, абсолют, симлинк наружу) на ОБЕ ветки —
    // и git, и не-git (tracker). gitops::diff_file проверяет сам, но tracker::diff — нет,
    // поэтому ставим барьер тут, на IPC-границе, до маршрутизации.
    if let Err(e) = gitops::ensure_safe_rel_path(&folder, &path) {
        return DiffPair {
            old_text: String::new(),
            new_text: format!("⟨отказано⟩ небезопасный путь: {e}"),
            status: "error".to_string(),
        };
    }
    if gitops::is_repo(&folder) {
        gitops::diff_file(&folder, &path)
    } else {
        crate::tracker::diff(&folder, &path)
    }
}
// Папка воркспейса слишком велика для надёжного снимок-diff БЕЗ git? (RFC 0011 A1).
// git-папки идут через git (без снимка/потолка) → всегда false. true → мягкая подсказка в UI
// «открой конкретный проект/репозиторий», вместо молчаливого пустого diff на громадине.
#[tauri::command]
pub fn diff_folder_oversized(folder: String) -> bool {
    if gitops::is_repo(&folder) {
        return false;
    }
    crate::tracker::is_snapshot_oversized(&folder)
}

// ── RFC 0013: merge-back (перенос правок агента в основное дерево) ──
// Перенести выбранные файлы из ветки агента (worktree = session.cwd) в основное дерево
// (clone_of = session.cloneOf). Вся безопасность — ВНУТРИ gitops::merge_transfer (валидация
// цели, сухой прогон → конфликт без записи, резервная точка, авто-откат при сбое). Возвращает
// MergeResult { ok / conflicts / backupSha }.
#[tauri::command]
pub fn merge_apply_files(worktree: String, clone_of: String, paths: Vec<String>) -> MergeResult {
    gitops::merge_transfer(&clone_of, &worktree, &paths)
}

// Откатить перенос к точке backup_sha (вернуть основное дерево в состояние ДО переноса).
#[tauri::command]
pub fn merge_undo(clone_of: String, backup_sha: String) -> OpResult {
    match gitops::merge_undo(&clone_of, &backup_sha) {
        Ok(()) => OpResult { ok: true, path: None, error: None },
        Err(e) => OpResult { ok: false, path: None, error: Some(e) },
    }
}

// ── GitHub (через gh CLI) ──
// ВАЖНО: команды ASYNC. `gh` ходит в сеть (gh api user / gh repo list) через блокирующий
// `Command::output()`. Синхронная (`pub fn`) Tauri-команда крутится на ГЛАВНОМ потоке и морозит
// отрисовку WebView на всё время сетевого вызова (~1.5-4с) — из-за этого окно нового воркспейса
// открывалось с задержкой (его useEffect зовёт github_status/repos при монтаже). `async fn` Tauri
// уводит с главного потока → окно рисуется сразу, репозитории догружаются в фоне.
#[tauri::command]
pub async fn github_status() -> crate::github::GithubStatus {
    crate::github::status()
}
#[tauri::command]
pub async fn github_repos() -> Result<Vec<crate::github::GithubRepo>, String> {
    crate::github::repos()
}
#[tauri::command]
pub async fn github_clone(repo: String, dest: String) -> Result<String, String> {
    crate::github::clone(&repo, &dest)
}

// ── Сессии ──
#[tauri::command]
pub fn session_create(
    app: AppHandle,
    store: State<'_, Mutex<StateStore>>,
    ptm: State<'_, PtyManager>,
    input: CreateSessionInput,
) -> Result<Session, String> {
    let (custom, ws_folder, settings) = {
        let s = store.lock().unwrap();
        let folder = s
            .data
            .workspaces
            .iter()
            .find(|w| w.id == input.workspace_id)
            .map(|w| w.folder.clone());
        (s.data.custom_agents.clone(), folder, s.data.settings.clone())
    };

    // Пустая строка папки = «папки нет» → стартуем в домашней папке.
    let mut cwd = input
        .cwd
        .clone()
        .filter(|s| !s.is_empty())
        .or(ws_folder.filter(|s| !s.is_empty()))
        .unwrap_or_else(|| dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/".into()));

    let (name, command_argv) = agents::resolve(&input.agent_id, &custom, false, None);
    // доп. флаги к команде агента (напр. `claude` + `--model …`). C1/C5: extra_args разбираем в
    // ОТДЕЛЬНЫЕ argv-токены (без интерпретации шеллом); недопустимые метасимволы — отклоняем.
    let command_argv = match append_extra_args(command_argv, input.extra_args.as_deref()) {
        Ok(v) => v,
        Err(e) => {
            let _ = app.emit("toast", serde_json::json!({ "kind": "error", "text": e }));
            return Err(e);
        }
    };
    // RFC 0015 / H3/H4/L2: режим доверия CLI — нативные флаги ОТДЕЛЬНЫМИ argv-токенами + whitelist.
    let command_argv = apply_perm_flags(&input.agent_id, command_argv, &settings);

    let mut clone_of: Option<String> = None;
    let mut branch: Option<String> = None;
    if input.clone {
        // RFC 0012 (watchdog): мягкий лимит числа активных «своих веток» — предупреждаем, но создаём.
        let (cnt, lim) = {
            let s = store.lock().unwrap();
            (
                s.data.sessions.iter().filter(|x| x.clone_of.is_some() && x.alive).count() as u32,
                s.data.settings.worktree_limit,
            )
        };
        if lim > 0 && cnt >= lim {
            let _ = app.emit(
                "toast",
                serde_json::json!({ "kind": "warn", "text": format!("Уже {cnt} своих веток (лимит {lim}) — не забудь убрать лишние, чтобы не копить на диске") }),
            );
        }
        if gitops::is_repo(&cwd) {
            // git-репозиторий → worktree (своя ветка, можно слить обратно)
            match gitops::create_worktree(&cwd, &name, &rand_suffix()) {
                Ok((path, br)) => {
                    clone_of = Some(cwd.clone());
                    cwd = path;
                    branch = Some(br);
                }
                Err(e) => {
                    let _ = app.emit("toast", serde_json::json!({ "kind": "error", "text": format!("Своя ветка не создалась: {e}") }));
                }
            }
        } else {
            // не git → инициализируем git и делаем НАСТОЯЩУЮ ветку (worktree).
            // Если git init/commit не вышел (напр. пустая папка) — откат к локальной копии.
            let suffix = rand_suffix();
            match gitops::init_and_commit(&cwd)
                .and_then(|_| gitops::create_worktree(&cwd, &name, &suffix))
            {
                Ok((path, br)) => {
                    clone_of = Some(cwd.clone());
                    cwd = path;
                    branch = Some(br);
                    let _ = app.emit("toast", serde_json::json!({ "kind": "info", "text": "Папка не была под git — сделал git init + свою ветку" }));
                }
                Err(_) => match fsops::create_copy(&cwd, &name, &rand_suffix()) {
                    Ok(path) => {
                        clone_of = Some(cwd.clone());
                        cwd = path;
                        let _ = app.emit("toast", serde_json::json!({ "kind": "info", "text": "git init не вышел — сделал локальную копию (слияние вручную)" }));
                    }
                    Err(e) => {
                        let _ = app.emit("toast", serde_json::json!({ "kind": "error", "text": format!("Копия не создалась: {e}") }));
                    }
                },
            }
        }
    }

    // разрешаем предпросмотр файлов внутри папки сессии (в т.ч. worktree/копии)
    add_allowed_root(&cwd);

    let title = input.title.clone().unwrap_or_else(|| match &input.first_prompt {
        Some(p) => p.chars().take(32).collect(),
        None => name.clone(),
    });

    let session = Session {
        id: gen_id(),
        workspace_id: input.workspace_id.clone(),
        agent_id: input.agent_id.clone(),
        title,
        cwd: cwd.clone(),
        clone_of,
        branch,
        // создаётся серой (idle) — отслеживание начнётся с первого промта пользователя (см. pty.rs)
        status: "idle".to_string(),
        first_prompt: input.first_prompt.clone(),
        resume_id: None,        // заполнится из хука по ходу сессии (RFC 0007)
        transcript_path: None,  // заполнится из хука вместе с resume_id (C3)
        created_at: now_ms(),
        alive: true,
        shell: input.shell.clone().filter(|s| !s.is_empty()),
        extra_args: input.extra_args.clone().filter(|s| !s.is_empty()),
    };

    ptm.spawn(&app, &session.id, command_argv, &cwd, input.first_prompt.clone(), input.shell.clone())?;
    Ok(session)
}

// C1/C5 (аудит 2026-06-17): шелл-метасимволы, которые отвергаем в extra_args. Даже при argv-запуске
// (где они стали бы литералом) такие символы в «доп. флагах» — почти всегда ошибка/попытка инъекции,
// поэтому явно режем с понятной ошибкой, а не пропускаем как имя файла.
fn has_shell_metachars(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\n' | '\r' | ';' | '|' | '&' | '$' | '`' | '(' | ')' | '<' | '>'))
}

// C1/C5: разобрать extra_args в ОТДЕЛЬНЫЕ argv-токены и дописать к команде агента. Пусто → команда
// без изменений. Метасимволы → ошибка (не запускаем). Если команды нет (shell) — extra_args
// игнорируем (некуда дописывать). Возвращаем Err с текстом для тоста.
fn append_extra_args(
    argv: Option<Vec<String>>,
    extra: Option<&str>,
) -> Result<Option<Vec<String>>, String> {
    let extra = match extra.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(e) => e,
        None => return Ok(argv),
    };
    if has_shell_metachars(extra) {
        return Err("Доп. аргументы содержат недопустимые символы (; | & $ ` ( ) < > перенос строки) — убери их".to_string());
    }
    // shlex учитывает кавычки: `--system-prompt "be brief"` → 2 токена. Несбалансированные
    // кавычки → None → ошибка (иначе тихо склеили бы неверно).
    let extra_tokens = shlex::split(extra)
        .ok_or_else(|| "Доп. аргументы: незакрытая кавычка".to_string())?;
    Ok(match argv {
        Some(mut v) => {
            v.extend(extra_tokens);
            Some(v)
        }
        None => None, // shell без команды — дописывать некуда
    })
}

// H3/H4/L2: допустимые значения «режима доверия». Whitelist — даже подменённый локально файл
// настроек не протащит произвольную строку (и тем более метасимвол) в argv.
const CLAUDE_PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "bypassPermissions", "plan"];
const CODEX_APPROVALS: &[&str] = &["untrusted", "on-failure", "on-request", "never"];
const CODEX_SANDBOXES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

// RFC 0007 / C3: жив ли нативный resume-id Claude. Сначала проверяем ФОРМАТ (hex+дефис, ≥8) —
// id с метасимволами невалиден сразу. Затем сканируем `~/.claude/projects/*/<id>.jsonl`.
// Папку-hash не знаем → перебор проектов (fallback для старых сессий без сохранённого пути).
fn claude_resume_valid(id: &str) -> bool {
    if !agents::is_valid_resume_id(id) {
        return false;
    }
    let base = match dirs::home_dir() {
        Some(h) => h.join(".claude").join("projects"),
        None => return false,
    };
    let rd = match std::fs::read_dir(&base) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let fname = format!("{}.jsonl", id.trim());
    for e in rd.flatten() {
        if e.path().join(&fname).exists() {
            return true;
        }
    }
    false
}

// C3: путь транскрипта (если сохранён хуком) существует и читается ПРЯМО СЕЙЧАС. Имя файла должно
// совпадать с resume_id (защита от рассинхрона/подмены: путь указывает на этот, а не чужой файл).
fn transcript_path_usable(path: &str, resume_id: &str) -> bool {
    if !agents::is_valid_resume_id(resume_id) {
        return false;
    }
    let p = std::path::Path::new(path);
    let stem_ok = p.file_stem().and_then(|s| s.to_str()) == Some(resume_id.trim());
    // ре-проверка перед запуском: файл на месте И открывается на чтение (не TOCTOU-only existence).
    stem_ok && std::fs::File::open(p).is_ok()
}

// C3: можно ли точно восстановить Claude по сохранённому resume_id. Быстрый путь — сохранённый
// transcript_path (без скана всех проектов); fallback — скан по resume_id (старые сессии без пути).
fn claude_resume_usable(session: &Session) -> bool {
    if session.agent_id != "claude" {
        return false;
    }
    let rid = match session.resume_id.as_deref() {
        Some(r) => r,
        None => return false,
    };
    if let Some(tp) = session.transcript_path.as_deref() {
        if transcript_path_usable(tp, rid) {
            return true;
        }
    }
    claude_resume_valid(rid)
}

// RFC 0015 / H3/H4/L2: дописать нативный флаг «режима доверия» к argv агента ОТДЕЛЬНЫМИ токенами,
// только если значение из настроек прошло whitelist. Пусто/невалидно = не передаём флаг.
fn apply_perm_flags(
    agent_id: &str,
    argv: Option<Vec<String>>,
    settings: &crate::types::Settings,
) -> Option<Vec<String>> {
    argv.map(|mut v| {
        match agent_id {
            "claude" => {
                let m = settings.claude_permission_mode.trim();
                if CLAUDE_PERMISSION_MODES.contains(&m) {
                    v.push("--permission-mode".to_string());
                    v.push(m.to_string());
                }
            }
            "codex" => {
                let a = settings.codex_approval.trim();
                if CODEX_APPROVALS.contains(&a) {
                    v.push("-a".to_string());
                    v.push(a.to_string());
                }
                let s = settings.codex_sandbox.trim();
                if CODEX_SANDBOXES.contains(&s) {
                    v.push("-s".to_string());
                    v.push(s.to_string());
                }
            }
            _ => {}
        }
        v
    })
}

// Общий спавн при восстановлении/рестарте сессии (RFC 0007 resume + сохранённые флаги/оболочка
// + RFC 0015 режим доверия).
fn spawn_for_resume(
    app: &AppHandle,
    ptm: &PtyManager,
    custom: &[crate::types::CustomAgent],
    settings: &crate::types::Settings,
    session: &Session,
) -> bool {
    // RFC 0007 / C3: точный resume только если нативный id Claude ещё валиден И файл транскрипта
    // читается прямо сейчас (ре-проверка перед запуском, не только existence). Иначе id опускаем →
    // resolve упадёт в --continue (не в ошибку «No conversation found»).
    let rid = session
        .resume_id
        .as_deref()
        .filter(|_| claude_resume_usable(session));
    let (_name, command_argv) = agents::resolve(&session.agent_id, custom, true, rid);
    // C1/C5: extra_args сохранённой сессии тоже разбираем безопасно; метасимволы → откат к команде
    // без них (на восстановлении не валим запуск из-за подпорченного стейта — просто стартуем чисто).
    let command_argv = append_extra_args(command_argv.clone(), session.extra_args.as_deref())
        .unwrap_or(command_argv);
    let command_argv = apply_perm_flags(&session.agent_id, command_argv, settings);
    ptm.spawn(app, &session.id, command_argv, &session.cwd, None, session.shell.clone())
        .is_ok()
}

#[tauri::command]
pub fn session_start(
    app: AppHandle,
    store: State<'_, Mutex<StateStore>>,
    ptm: State<'_, PtyManager>,
    session: Session,
) -> bool {
    let (custom, settings) = {
        let s = store.lock().unwrap();
        (s.data.custom_agents.clone(), s.data.settings.clone())
    };
    spawn_for_resume(&app, &ptm, &custom, &settings, &session)
}

// RFC 0012 (watchdog): рестарт зависшей сессии в один клик — убить (если жив) + поднять заново
// тем же resume-путём. Если процесса нет (уже мёртв) — kill это no-op, просто стартуем.
#[tauri::command]
pub fn restart_session(
    app: AppHandle,
    store: State<'_, Mutex<StateStore>>,
    ptm: State<'_, PtyManager>,
    session: Session,
) -> bool {
    ptm.kill(&session.id);
    let (custom, settings) = {
        let s = store.lock().unwrap();
        (s.data.custom_agents.clone(), s.data.settings.clone())
    };
    spawn_for_resume(&app, &ptm, &custom, &settings, &session)
}

// RFC 0012: «убить всё» — гасит все живые PTY (kill_all уже есть) + помечает сессии alive=false.
#[tauri::command]
pub fn kill_all_sessions(store: State<'_, Mutex<StateStore>>, ptm: State<'_, PtyManager>) {
    ptm.kill_all();
    let mut s = store.lock().unwrap();
    for sess in s.data.sessions.iter_mut() {
        sess.alive = false;
    }
    s.save();
}

// RFC 0012: статистика «своих веток» (worktree) — число активных + лимит + занятое место на диске.
#[tauri::command]
pub fn worktree_stats(store: State<'_, Mutex<StateStore>>) -> serde_json::Value {
    let (count, limit, warn_gb) = {
        let s = store.lock().unwrap();
        let count = s.data.sessions.iter().filter(|x| x.clone_of.is_some() && x.alive).count() as u32;
        (count, s.data.settings.worktree_limit, s.data.settings.worktree_disk_warn_gb)
    };
    let disk = crate::fsops::dir_size(&crate::fsops::worktrees_root().to_string_lossy());
    serde_json::json!({
        "count": count,
        "limit": limit,
        "overLimit": count >= limit && limit > 0,
        "diskBytes": disk,
        "diskWarnGb": warn_gb,
        "diskWarn": warn_gb > 0 && disk as f64 > (warn_gb as f64) * 1_000_000_000.0,
    })
}

// RFC 0012: убрать «свою ветку» с диска (git worktree remove --force + prune; для не-git копии —
// удалить папку). repo = исходный репозиторий (Session.clone_of); path = папка ветки/копии.
#[tauri::command]
pub fn remove_worktree(path: String, repo: Option<String>) -> OpResult {
    match gitops::remove_worktree(repo.as_deref(), &path) {
        Ok(()) => OpResult { ok: true, path: Some(path), error: None },
        Err(e) => OpResult { ok: false, path: None, error: Some(e) },
    }
}

// RFC 0014 Фаза 2: команда тестов проекта (метка, программа, аргументы) — по файлам в папке.
fn detect_test_command(cwd: &str) -> Option<(String, String)> {
    let p = std::path::Path::new(cwd);
    let pkg = p.join("package.json");
    if pkg.exists() {
        if let Ok(text) = std::fs::read_to_string(&pkg) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v.get("scripts").and_then(|s| s.get("test")).and_then(|t| t.as_str()).is_some() {
                    return Some(("npm test".into(), "npm test --silent".into()));
                }
            }
        }
    }
    if p.join("Cargo.toml").exists() {
        return Some(("cargo test".into(), "cargo test".into()));
    }
    for mk in ["Makefile", "makefile"] {
        if let Ok(text) = std::fs::read_to_string(p.join(mk)) {
            if text.lines().any(|l| l.starts_with("test:")) {
                return Some(("make test".into(), "make test".into()));
            }
        }
    }
    None
}

// RFC 0014 Фаза 2: прогон тестов из пульта. Не блокирует UI — отдельный поток, результат событием
// `test:result`. Login-shell (`zsh -lic`) для полного PATH (npm/cargo из nvm/rustup/homebrew —
// у .app урезанный PATH). Вывод обрезаем хвостом (тесты бывают шумные).
#[tauri::command]
pub fn run_tests(app: AppHandle, cwd: String) {
    std::thread::spawn(move || {
        let (label, cmd) = match detect_test_command(&cwd) {
            Some(t) => t,
            None => {
                let _ = app.emit(
                    "test:result",
                    serde_json::json!({ "cwd": cwd, "running": false, "ok": false,
                        "error": "не нашёл команду тестов (package.json scripts.test / Cargo.toml / Makefile test:)" }),
                );
                return;
            }
        };
        let _ = app.emit("test:result", serde_json::json!({ "cwd": cwd, "running": true, "command": label }));
        let out = std::process::Command::new("/bin/zsh")
            .args(["-lic", &cmd])
            .current_dir(&cwd)
            .output();
        match out {
            Ok(o) => {
                let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
                s.push_str(&String::from_utf8_lossy(&o.stderr));
                let tail: String = {
                    let v: Vec<char> = s.chars().rev().take(8000).collect();
                    v.into_iter().rev().collect()
                };
                let _ = app.emit(
                    "test:result",
                    serde_json::json!({ "cwd": cwd, "running": false, "ok": o.status.success(),
                        "code": o.status.code().unwrap_or(-1), "command": label, "output": tail }),
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "test:result",
                    serde_json::json!({ "cwd": cwd, "running": false, "ok": false, "command": label, "error": e.to_string() }),
                );
            }
        }
    });
}

#[tauri::command]
pub fn session_is_alive(ptm: State<'_, PtyManager>, id: String) -> bool {
    ptm.is_alive(&id)
}

// Активная (в фокусе) сессия — для подавления уведомлений, когда юзер уже в этом окне.
#[tauri::command]
pub fn session_set_active(id: Option<String>) {
    crate::hooks::set_active_session(id);
}

// Пользователь реально нажал клавишу/отправил ответ в сессии → включаем отслеживание
// и мгновенно красим в синий «работает» (не ждём хук агента).
#[tauri::command]
pub fn session_user_typed(app: AppHandle, ptm: State<'_, PtyManager>, id: String) {
    ptm.mark_user_typed(&app, &id);
}

// ── PTY ──
#[tauri::command]
pub fn pty_write(ptm: State<'_, PtyManager>, session_id: String, data: String) {
    ptm.write(&session_id, &data);
}
#[tauri::command]
pub fn pty_resize(ptm: State<'_, PtyManager>, session_id: String, cols: u16, rows: u16) {
    ptm.resize(&session_id, cols, rows);
}
#[tauri::command]
pub fn pty_kill(ptm: State<'_, PtyManager>, session_id: String) {
    ptm.kill(&session_id);
}
#[tauri::command]
pub fn pty_buffer(ptm: State<'_, PtyManager>, session_id: String) -> String {
    ptm.buffer(&session_id)
}

// PLAN 0004 Фаза D: снимок лимитов CLI для верхней панели. Claude — настоящий % из rate_limits
// статусстроки (как в терминале); Codex — токены окна; прочие установленные — «—».
#[tauri::command]
pub fn usage_snapshot() -> Vec<crate::usage::CliReport> {
    crate::usage::usage_report()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Settings;

    // C1/C5: extra_args с метасимволами — отклоняются (инъекция невозможна на входе).
    #[test]
    fn extra_args_reject_shell_metachars() {
        let base = || Some(vec!["claude".to_string()]);
        for bad in [
            "; rm -rf /",
            "--model x; rm -rf /",
            "| cat /etc/passwd",
            "$(whoami)",
            "`id`",
            "--model x && curl evil",
            "--model x\nrm -rf /",
            "--model x > /tmp/out",
        ] {
            assert!(has_shell_metachars(bad), "должен ловиться метасимвол: {bad:?}");
            let r = append_extra_args(base(), Some(bad));
            assert!(r.is_err(), "extra_args должны быть отклонены: {bad:?}");
        }
    }

    // C1: безопасные extra_args становятся ОТДЕЛЬНЫМИ argv-токенами (без интерпретации шеллом).
    // Даже если бы `;` прошёл — он бы стал литералом-токеном, а не разделителем команд.
    #[test]
    fn extra_args_split_into_separate_argv() {
        let argv = append_extra_args(Some(vec!["claude".to_string()]), Some("--model sonnet"))
            .unwrap()
            .unwrap();
        assert_eq!(argv, vec!["claude", "--model", "sonnet"]);
        // кавычки → один токен с пробелом внутри (значение не разрывается)
        let argv = append_extra_args(Some(vec!["claude".to_string()]), Some("--system-prompt \"be brief\""))
            .unwrap()
            .unwrap();
        assert_eq!(argv, vec!["claude", "--system-prompt", "be brief"]);
    }

    // C1/C4 (адверсарно): даже собранный из argv-токенов и POSIX-экранированный shlex::try_join
    // НЕ создаёт инъекцию — `;`/`$()` остаются внутри кавычек как данные. Здесь проверяем, что
    // try_join любых данных снова парсится обратно В ТЕ ЖЕ токены (round-trip = нет инъекции).
    #[test]
    fn argv_join_roundtrip_no_injection() {
        let argv = vec![
            "claude".to_string(),
            "--system-prompt".to_string(),
            "; rm -rf / $(whoami) `id`".to_string(), // данные, не команда
        ];
        let joined = shlex::try_join(argv.iter().map(|s| s.as_str())).unwrap();
        let reparsed = shlex::split(&joined).unwrap();
        assert_eq!(reparsed, argv, "опасные данные не должны расщепляться на команды");
    }

    // H3/H4/L2: значения «режима доверия» проходят только из whitelist; мусор/метасимвол — отброшен.
    #[test]
    fn perm_flags_whitelist_only() {
        let mut st = Settings::default();
        st.claude_permission_mode = "acceptEdits".to_string();
        let argv = apply_perm_flags("claude", Some(vec!["claude".to_string()]), &st).unwrap();
        assert_eq!(argv, vec!["claude", "--permission-mode", "acceptEdits"]);

        // инъекция в настройках → не проходит whitelist → флаг не добавлен
        st.claude_permission_mode = "ask; rm -rf /".to_string();
        let argv = apply_perm_flags("claude", Some(vec!["claude".to_string()]), &st).unwrap();
        assert_eq!(argv, vec!["claude"], "значение вне whitelist не должно попадать в argv");

        // codex -a/-s whitelist
        let mut cx = Settings::default();
        cx.codex_approval = "on-request".to_string();
        cx.codex_sandbox = "workspace-write".to_string();
        let argv = apply_perm_flags("codex", Some(vec!["codex".to_string()]), &cx).unwrap();
        assert_eq!(argv, vec!["codex", "-a", "on-request", "-s", "workspace-write"]);
        cx.codex_sandbox = "$(evil)".to_string();
        let argv = apply_perm_flags("codex", Some(vec!["codex".to_string()]), &cx).unwrap();
        assert!(!argv.iter().any(|x| x == "-s"), "мусорный sandbox не должен попадать: {argv:?}");
    }

    // C3: формат resume_id (через публичную проверку agents) + transcript_path stem-match.
    #[test]
    fn resume_id_format_and_transcript_stem() {
        assert!(crate::agents::is_valid_resume_id("0b58636d-10fe-4a2b-9c3d-1234567890ab"));
        assert!(crate::agents::is_valid_resume_id("abcdef12"));
        assert!(!crate::agents::is_valid_resume_id("short"));
        assert!(!crate::agents::is_valid_resume_id("id'; rm -rf /; '"));
        assert!(!crate::agents::is_valid_resume_id("../../etc/passwd"));
        // несуществующий путь с валидным id → не usable (файл не открывается)
        assert!(!transcript_path_usable("/nonexistent/0b58636d-10fe.jsonl", "0b58636d-10fe"));
        // путь, чьё имя НЕ совпадает с resume_id → не usable (защита от подмены)
        assert!(!transcript_path_usable("/tmp/other.jsonl", "0b58636d-10fe"));
        // невалидный resume_id → не usable независимо от пути
        assert!(!transcript_path_usable("/tmp/x.jsonl", "; rm -rf /"));
    }

    // H7: fs_resolve с cwd вне разрешённых корней возвращает исходную ссылку (не резолвит в чужое).
    #[test]
    fn fs_resolve_rejects_out_of_root_cwd() {
        // Задаём корнем уникальную временную папку.
        let tmp = std::env::temp_dir().join(format!("deck-test-root-{}", now_ms()));
        std::fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().to_string();
        set_allowed_roots(vec![root.clone()]);

        // cwd вне корня (/etc) → возвращаем reference как есть, поиск не запускаем
        let out = fs_resolve("/etc".to_string(), "passwd".to_string());
        assert_eq!(out, "passwd", "out-of-root cwd не должен резолвиться");

        // cwd внутри корня → работает обычный резолв (файла нет → вернётся абсолютный путь-кандидат)
        let out = fs_resolve(root.clone(), "nope.txt".to_string());
        assert!(out.starts_with(&root), "in-root cwd должен резолвиться от cwd: {out}");

        // вернуть fail-open состояние, чтобы не влиять на другие тесты
        set_allowed_roots(vec![]);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
