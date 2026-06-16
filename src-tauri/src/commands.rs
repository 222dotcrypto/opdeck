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
    // RFC 0007: resume_id — backend-owned (пишется хуком, фронт его не знает). Фронт делает
    // full-replace стейта → затёр бы resume_id. Сохраняем существующий, если входящий пуст
    // (паттерн guard против full-replace, как favorites/blacklist в useful-v4).
    for incoming in state.sessions.iter_mut() {
        if incoming.resume_id.is_none() {
            if let Some(old) = s.data.sessions.iter().find(|x| x.id == incoming.id) {
                incoming.resume_id = old.resume_id.clone();
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
#[tauri::command]
pub fn fs_resolve(cwd: String, reference: String) -> String {
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
#[tauri::command]
pub fn github_status() -> crate::github::GithubStatus {
    crate::github::status()
}
#[tauri::command]
pub fn github_repos() -> Result<Vec<crate::github::GithubRepo>, String> {
    crate::github::repos()
}
#[tauri::command]
pub fn github_clone(repo: String, dest: String) -> Result<String, String> {
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

    let (name, command_line) = agents::resolve(&input.agent_id, &custom, false, None);
    // доп. флаги к команде агента (напр. `claude` + `--model …`)
    let command_line = match input.extra_args.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(a) => command_line.map(|c| format!("{} {}", c, a)),
        None => command_line,
    };
    // RFC 0015: режим доверия CLI (Deck-сессии) — нативный флаг запуска
    let command_line = apply_perm_flags(&input.agent_id, command_line, &settings);

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
        resume_id: None, // заполнится из хука по ходу сессии (RFC 0007)
        created_at: now_ms(),
        alive: true,
        shell: input.shell.clone().filter(|s| !s.is_empty()),
        extra_args: input.extra_args.clone().filter(|s| !s.is_empty()),
    };

    ptm.spawn(&app, &session.id, command_line, &cwd, input.first_prompt.clone(), input.shell.clone())?;
    Ok(session)
}

// RFC 0007: жив ли нативный resume-id Claude (файл транскрипта `~/.claude/projects/*/<id>.jsonl`
// ещё существует). Папку-hash не знаем → сканируем все проекты. Пусто/нет → невалиден.
fn claude_resume_valid(id: &str) -> bool {
    if id.is_empty() {
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
    let fname = format!("{id}.jsonl");
    for e in rd.flatten() {
        if e.path().join(&fname).exists() {
            return true;
        }
    }
    false
}

// RFC 0015: дописать нативный флаг «режима доверия» к команде CLI (Deck-сессии). Пусто = не трогаем.
fn apply_perm_flags(agent_id: &str, cmd: Option<String>, settings: &crate::types::Settings) -> Option<String> {
    cmd.map(|c| {
        let mut x = String::new();
        match agent_id {
            "claude" if !settings.claude_permission_mode.trim().is_empty() => {
                x.push_str(&format!(" --permission-mode {}", settings.claude_permission_mode.trim()));
            }
            "codex" => {
                if !settings.codex_approval.trim().is_empty() {
                    x.push_str(&format!(" -a {}", settings.codex_approval.trim()));
                }
                if !settings.codex_sandbox.trim().is_empty() {
                    x.push_str(&format!(" -s {}", settings.codex_sandbox.trim()));
                }
            }
            _ => {}
        }
        format!("{c}{x}")
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
    // RFC 0007: точный resume только если нативный id Claude ещё валиден (файл транскрипта на месте),
    // иначе id опускаем → resolve упадёт в --continue (не в ошибку «No conversation found»).
    let rid = session
        .resume_id
        .as_deref()
        .filter(|id| session.agent_id == "claude" && claude_resume_valid(id));
    let (_name, command_line) = agents::resolve(&session.agent_id, custom, true, rid);
    let command_line = match session.extra_args.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(a) => command_line.map(|c| format!("{} {}", c, a)),
        None => command_line,
    };
    let command_line = apply_perm_flags(&session.agent_id, command_line, settings);
    ptm.spawn(app, &session.id, command_line, &session.cwd, None, session.shell.clone())
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
