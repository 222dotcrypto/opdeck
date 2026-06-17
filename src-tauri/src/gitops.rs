use crate::types::{ChangedFile, DiffPair, MergeResult, WorktreeInfo};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

fn git(folder: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(folder)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// То же, но БЕЗ trim — отдаёт байты stdout как есть. Нужно для получения
// СОДЕРЖИМОГО файла (`git show HEAD:путь`): trim() срезал бы финальный перевод
// строки у «было», а «стало» с диска его сохраняет → фантомная «изменённая»
// последняя строка в diff даже когда правок там нет. Для парсинга порцелейна
// (status/worktree) trim удобен и остаётся в git(); для контента — только git_raw.
fn git_raw(folder: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(folder)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

// H5 (аудит 2026-06-17): валидатор относительного пути для чтения файла внутри репо.
// `rel_path` приходит из IPC (фронт) → нельзя доверять: `../../.ssh/id_rsa` через
// `git show HEAD:<путь>` или `folder.join(rel)` прочитал бы файл ВНЕ репозитория.
// Гейт: пусто/абсолютный/«..»/«~» — отказ; затем канонизируем `folder.join(rel)` и
// требуем, чтобы результат остался ВНУТРИ канонического `folder`. Симлинк, указывающий
// наружу, канонизация разворачивает → выпадает за пределы → отказ. Возвращает Ok(())
// только если путь безопасен.
pub fn ensure_safe_rel_path(folder: &str, rel_path: &str) -> Result<(), String> {
    let rel = rel_path.trim();
    if rel.is_empty() {
        return Err("пустой путь".into());
    }
    let p = Path::new(rel);
    // абсолютный путь или начинается с '/' (или '\\' на всякий) — наружу из репо
    if p.is_absolute() || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(format!("абсолютный путь запрещён: {rel}"));
    }
    // '~' раскрылся бы в $HOME — не относительный путь репо
    if rel.starts_with('~') {
        return Err(format!("путь с '~' запрещён: {rel}"));
    }
    // любой компонент пути == ".." (или родитель/корень) — выход за пределы дерева
    use std::path::Component;
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                return Err(format!("выход за пределы дерева ('..') запрещён: {rel}"))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("корневой/абсолютный компонент запрещён: {rel}"))
            }
            _ => {}
        }
    }
    // Структурно безопасен. Если оба пути существуют — подтверждаем канонизацией, что
    // итог реально внутри репо (ловит симлинк наружу). Если целевого файла ещё нет
    // (новый/удалённый) — канонизация цели невозможна; структурной проверки выше
    // (нет '..'/абсолюта) уже достаточно, не блокируем легитимный diff нового файла.
    let base = match std::fs::canonicalize(folder) {
        Ok(b) => b,
        Err(_) => return Ok(()), // папки нет — пусть дальше упадёт штатно, не наша забота
    };
    let joined = Path::new(folder).join(rel);
    if let Ok(canon) = std::fs::canonicalize(&joined) {
        if !canon.starts_with(&base) {
            return Err(format!("путь выходит за пределы репозитория: {rel}"));
        }
    }
    Ok(())
}

pub fn is_repo(folder: &str) -> bool {
    git(folder, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s == "true")
        .unwrap_or(false)
}

pub fn repo_root(folder: &str) -> Option<String> {
    git(folder, &["rev-parse", "--show-toplevel"]).ok()
}

pub fn current_branch(folder: &str) -> Option<String> {
    git(folder, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()
}

// Инициализировать git в папке и сделать первый коммит (с локальной личностью, чтобы
// не падать без глобального git config). Нужно, чтобы «своя ветка» на не-git папке
// стала НАСТОЯЩЕЙ git-веткой (worktree требует хотя бы один коммит).
// add -A уважает .gitignore проекта (если он есть).
pub fn init_and_commit(folder: &str) -> Result<(), String> {
    git(folder, &["init"])?;
    git(folder, &["add", "-A"])?;
    git(
        folder,
        &[
            "-c",
            "user.email=deck@local",
            "-c",
            "user.name=Deck",
            "commit",
            "-m",
            "deck: начальный коммит",
        ],
    )?;
    Ok(())
}

// Создаёт worktree (отдельную рабочую копию) на свежей ветке.
// Возвращает (путь, ветка).
pub fn create_worktree(folder: &str, label: &str, rand: &str) -> Result<(String, String), String> {
    let root = repo_root(folder).ok_or("Папка не является git-репозиторием")?;
    let safe: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(24)
        .collect();
    let safe = if safe.is_empty() { "agent".to_string() } else { safe };
    let branch = format!("deck/{}-{}", safe, rand);
    let root_path = Path::new(&root);
    let base = root_path.file_name().and_then(|s| s.to_str()).unwrap_or("repo");
    // worktree всегда в ~/.deck-worktrees (см. fsops::worktrees_root). Раньше клали
    // в родителя проекта, и если проект = ~/ (родитель `/Users`, владелец root),
    // git падал с «could not create leading directories … Permission denied».
    let wt_dir = crate::fsops::worktrees_root().join(format!("{}-{}-{}", base, safe, rand));
    let wt_str = wt_dir.to_string_lossy().to_string();

    git(&root, &["worktree", "add", "-b", &branch, &wt_str])?;
    Ok((wt_str, branch))
}

// RFC 0012 (watchdog): убрать «свою ветку»/копию с диска. Если задан исходный репозиторий —
// `git worktree remove --force` + `prune` (корректно отвяжет git-worktree). Папку удаляем ТОЛЬКО
// если она под `~/.deck-worktrees` (safety: не снести случайно чужой путь). Для не-git копии
// (repo=None) — просто удаление папки под тем же гардом.
pub fn remove_worktree(repo: Option<&str>, wt_path: &str) -> Result<(), String> {
    if let Some(repo) = repo {
        if let Some(root) = repo_root(repo) {
            let _ = git(&root, &["worktree", "remove", "--force", wt_path]);
            let _ = git(&root, &["worktree", "prune"]);
        }
    }
    let p = Path::new(wt_path);
    let guard = crate::fsops::worktrees_root();
    if p.starts_with(&guard) && p.exists() {
        std::fs::remove_dir_all(p).map_err(|e| format!("не удалить папку ветки: {e}"))?;
    } else if !p.starts_with(&guard) {
        return Err("путь вне ~/.deck-worktrees — удаление запрещено".into());
    }
    Ok(())
}

pub fn list_worktrees(folder: &str) -> Vec<WorktreeInfo> {
    let root = match repo_root(folder) {
        Some(r) => r,
        None => return vec![],
    };
    let out = match git(&root, &["worktree", "list", "--porcelain"]) {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let mut res = vec![];
    let mut cur_path: Option<String> = None;
    let mut cur_branch: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = Some(b.replace("refs/heads/", ""));
        } else if line.trim().is_empty() {
            if let Some(p) = cur_path.take() {
                res.push(WorktreeInfo {
                    path: p,
                    branch: cur_branch.take().unwrap_or_else(|| "(detached)".to_string()),
                });
            }
            cur_branch = None;
        }
    }
    if let Some(p) = cur_path.take() {
        res.push(WorktreeInfo {
            path: p,
            branch: cur_branch.unwrap_or_else(|| "(detached)".to_string()),
        });
    }
    res
}

// Какие файлы агент тронул в папке (несохранённая работа против HEAD).
// `git status --porcelain=v1`: первые 2 символа = код XY (X — индекс/staged,
// Y — рабочая копия), дальше пробел и путь. Не-git папка / ошибка → vec![]
// (fail-soft, без паники — данные внешние, никаких unwrap на них).
pub fn status(folder: &str) -> Vec<ChangedFile> {
    // core.quotepath=false — иначе не-ASCII (кириллица/эмодзи) имена приходят в кавычках с
    // octal-escape («\320\277…»), путь не совпадает с деревом → нет подсветки/вкладки Diff,
    // и в merge-модалке/патче — битый путь. С false — реальный UTF-8 путь.
    let out = match git(folder, &["-c", "core.quotepath=false", "status", "--porcelain=v1"]) {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let mut res = vec![];
    for line in out.lines() {
        // строка короче «XY путь» — пропускаем (битая)
        if line.len() < 4 {
            continue;
        }
        let code: Vec<char> = line.chars().take(2).collect();
        let x = code[0];
        let y = code[1];
        // остаток после кода и одного пробела = путь
        let rest = &line[3..];
        // переименование: «старое -> новое» — берём правую часть (новый путь)
        let path = match rest.split(" -> ").last() {
            Some(p) => p.trim().to_string(),
            None => rest.trim().to_string(),
        };
        if path.is_empty() {
            continue;
        }
        // классификация статуса по коду XY
        let status = if x == '?' && y == '?' {
            "untracked"
        } else if x == 'A' || y == 'A' {
            "added"
        } else if x == 'D' || y == 'D' {
            "deleted"
        } else if x == 'R' || y == 'R' {
            "renamed"
        } else {
            "modified"
        };
        // staged = в индексе есть изменение (X не пустой и не «не отслежен»)
        let staged = x != ' ' && x != '?';
        res.push(ChangedFile {
            path,
            status: status.to_string(),
            staged,
        });
    }
    res
}

// Пара «было → стало» для Monaco DiffEditor по одному файлу (путь относительно
// корня репо/папки). old_text = версия из HEAD (пусто, если файла там нет —
// новый файл). new_text = текущее содержимое с диска (пусто, если удалён).
// status — из status() для этого пути (иначе «modified»).
pub fn diff_file(folder: &str, rel_path: &str) -> DiffPair {
    // H5: путь из IPC — сперва гейт против traversal (`../../.ssh/id_rsa`, абсолют, симлинк
    // наружу). Небезопасный путь → не читаем ничего, отдаём пометку в diff (функция возвращает
    // DiffPair, не Result; UI покажет текст вместо тихого чтения чужого файла).
    if let Err(e) = ensure_safe_rel_path(folder, rel_path) {
        return DiffPair {
            old_text: String::new(),
            new_text: format!("⟨отказано⟩ небезопасный путь: {e}"),
            status: "error".to_string(),
        };
    }
    // git_raw (без trim!): сохраняем точные байты версии из HEAD, иначе срезанный
    // хвостовой \n даёт фантомную «изменённую» последнюю строку против диска.
    let old_text = git_raw(folder, &["show", &format!("HEAD:{}", rel_path)]).unwrap_or_default();
    let new_path = Path::new(folder).join(rel_path);
    let new_text = std::fs::read_to_string(&new_path).unwrap_or_default();
    let status = status(folder)
        .into_iter()
        .find(|f| f.path == rel_path)
        .map(|f| f.status)
        .unwrap_or_else(|| "modified".to_string());
    DiffPair {
        old_text,
        new_text,
        status,
    }
}

// ========================= RFC 0013 — merge-back =========================
// Перенос несохранённой работы агента из ветки (worktree) в основное дерево (clone_of).
// Все команды зафиксированы эмпирическим прогоном реального git (см. PLAN 0013 / сессия).
// Гейты безопасности: target всегда clone_of (≠ worktree), apply ТОЛЬКО после merge_check
// (пусто) и merge_backup. Подключение к IPC/UI — Фаза 2.

// git с захватом кода выхода + stdout + stderr (для `diff --no-index`, который возвращает
// код 1 при наличии различий, и для apply, где нужен и код, и stderr).
#[allow(dead_code)]
fn git_capture(folder: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(folder)
        .output()
        .map_err(|e| e.to_string())?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

// git apply: патч подаётся в stdin (без временных файлов). Возвращает (успех, stderr).
#[allow(dead_code)]
fn git_apply_stdin(folder: &str, args: &[&str], patch: &str) -> Result<(bool, String), String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        let mut stdin = child.stdin.take().ok_or("нет stdin у git apply")?;
        stdin.write_all(patch.as_bytes()).map_err(|e| e.to_string())?;
    } // stdin закрывается здесь → git видит EOF
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

// Валидатор цели записи: основное дерево — настоящий git-репозиторий, существует, и его
// корень совпадает с переданным путём (НЕ путать с корнем worktree). Инвариант 2.
#[allow(dead_code)]
pub fn valid_main_target(clone_of: &str) -> bool {
    if clone_of.is_empty() || !Path::new(clone_of).exists() {
        return false;
    }
    if !is_repo(clone_of) {
        return false;
    }
    // корень репо совпадает с переданным путём
    match repo_root(clone_of) {
        Some(root) if same_path(&root, clone_of) => {}
        _ => return false,
    }
    // НЕ linked-worktree: у основного дерева git-common-dir == git-dir; у worktree различаются
    // (общий .git vs .git/worktrees/<id>). Писать merge-back можно только в основное.
    match (
        git(clone_of, &["rev-parse", "--git-common-dir"]),
        git(clone_of, &["rev-parse", "--git-dir"]),
    ) {
        (Ok(common), Ok(gitdir)) => same_path_in(clone_of, &common, &gitdir),
        _ => false,
    }
}

#[allow(dead_code)]
fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

// Сравнить два пути, которые git выдал относительно base (могут быть относительными «.git»
// или абсолютными). Канонизируем оба относительно base.
#[allow(dead_code)]
fn same_path_in(base: &str, a: &str, b: &str) -> bool {
    let resolve = |p: &str| -> Option<std::path::PathBuf> {
        let pb = Path::new(p);
        let full = if pb.is_absolute() {
            pb.to_path_buf()
        } else {
            Path::new(base).join(pb)
        };
        std::fs::canonicalize(&full).ok().or(Some(full))
    };
    resolve(a) == resolve(b)
}

// Собрать единый патч из несохранённой работы агента по выбранным путям (целыми файлами).
// tracked-правки → `diff HEAD`; новый (untracked) файл → `diff --no-index /dev/null`.
// (Выбор отдельных ханков — Фаза 3, здесь всегда целый файл.)
#[allow(dead_code)]
pub fn build_merge_patch(worktree: &str, paths: &[String]) -> Result<String, String> {
    let mut patch = String::new();
    for rel in paths {
        // защита от выхода за пределы дерева: абсолютные/«..» пути не переносим
        if rel.is_empty() || Path::new(rel).is_absolute() || rel.split('/').any(|s| s == "..") {
            return Err(format!("небезопасный путь для переноса: {rel}"));
        }
        // симлинк пока НЕ переносим (может указывать на произвольный путь вне дерева —
        // состязательная проверка, HIGH). Удалённый файл symlink_metadata не найдёт →
        // unwrap_or(false), и он пойдёт обычным deleted-патчем (видно статусом + откат).
        if Path::new(worktree)
            .join(rel)
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err(format!("симлинк пока не переносится (укажет наружу): {rel}"));
        }
        // `core.quotepath=false` — пути с не-ASCII именами без octal-экранирования (иначе
        // patch_added_paths/parse_conflict_files не распознают путь → орфаны при откате).
        let (_ok, tracked, _err) =
            git_capture(worktree, &["-c", "core.quotepath=false", "diff", "HEAD", "--", rel])?;
        if !tracked.trim().is_empty() {
            patch.push_str(&tracked);
            if !patch.ends_with('\n') {
                patch.push('\n');
            }
            continue;
        }
        // пусто → возможно новый файл (untracked)
        let (_ok2, added, _err2) =
            git_capture(worktree, &["-c", "core.quotepath=false", "diff", "--no-index", "/dev/null", rel])?;
        if !added.trim().is_empty() {
            patch.push_str(&added);
            if !patch.ends_with('\n') {
                patch.push('\n');
            }
        }
    }
    Ok(patch)
}

// Сухой прогон: ляжет ли патч на основное дерево? Возвращает список конфликтных файлов
// (пусто = ляжет чисто). ОСНОВНОЕ ДЕРЕВО НЕ ТРОГАЕТ (`--check`). Гейт записи (инвариант 5).
#[allow(dead_code)]
pub fn merge_check(clone_of: &str, patch: &str) -> Result<Vec<String>, String> {
    if patch.trim().is_empty() {
        return Ok(vec![]);
    }
    // БЕЗ --3way! `apply --check --3way` даёт ЛОЖНОЕ «чисто» (exit=0 «Applied with conflicts»)
    // на застейдженном конфликте → реальный apply записал бы маркеры <<<<<<< в файл. Plain
    // `apply --check` строго all-or-nothing: любой неточный контекст → отказ, основное не тронуто.
    let (ok, stderr) = git_apply_stdin(clone_of, &["apply", "--check", "--whitespace=nowarn"], patch)?;
    if ok {
        Ok(vec![])
    } else {
        Ok(parse_conflict_files(&stderr))
    }
}

// Имена конфликтных файлов из stderr git apply (строки вида `error: <файл>: ...`).
#[allow(dead_code)]
fn parse_conflict_files(stderr: &str) -> Vec<String> {
    let mut files: Vec<String> = vec![];
    let mut push = |f: String| {
        let f = f.trim().to_string();
        if !f.is_empty() && !files.contains(&f) {
            files.push(f);
        }
    };
    for line in stderr.lines() {
        let rest = match line.strip_prefix("error: ") {
            Some(r) => r,
            None => continue,
        };
        // «patch failed: <файл>:<строка>»
        if let Some(r) = rest.strip_prefix("patch failed: ") {
            if let Some(idx) = r.rfind(':') {
                push(r[..idx].to_string());
            }
            continue;
        }
        // «<файл>: already exists in working directory» — новый файл агента уже есть в main
        if rest.contains(": already exists in working directory") {
            if let Some(idx) = rest.find(": ") {
                push(format!("{} (уже есть в main)", &rest[..idx]));
            }
            continue;
        }
        // «cannot apply binary patch to '<файл>' without full index line» (бинарь без --binary)
        if rest.starts_with("cannot apply binary patch") {
            if let (Some(a), Some(b)) = (rest.find('\''), rest.rfind('\'')) {
                if b > a {
                    push(rest[a + 1..b].to_string());
                }
            }
            continue;
        }
        // «<файл>: patch does not apply» / «<файл>: does not match index»
        if let Some(idx) = rest.find(": ") {
            push(rest[..idx].to_string());
        }
    }
    if files.is_empty() {
        files.push("(основное дерево разошлось)".to_string());
    }
    files
}

// Точка отката ДО записи: коммит-снимок текущего (грязного + untracked) состояния основного
// дерева, затем `reset --mixed` — грязь возвращается в рабочую копию, а коммит остаётся
// «висячим» (sha для отката). Всегда `--allow-empty` (чистое дерево → пустой снимок).
// Инвариант 4. Требует ≥1 коммита в основном (клон-сессия это гарантирует).
#[allow(dead_code)]
pub fn merge_backup(clone_of: &str) -> Result<String, String> {
    if !valid_main_target(clone_of) {
        return Err("основное дерево невалидно (не корень репозитория)".into());
    }
    // unborn HEAD (репо без коммитов): merge-back недоступен, и reset HEAD~1 порвался бы,
    // оставив работу пользователя в фантомном коммите. Отказываемся явно.
    if git(clone_of, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() {
        return Err("основное дерево без коммитов — перенос недоступен".into());
    }
    git(clone_of, &["add", "-A"])?;
    git(
        clone_of,
        &[
            "-c",
            "user.email=deck@local",
            "-c",
            "user.name=Deck",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--no-verify",
            "--allow-empty",
            "-m",
            "deck: точка отката перед переносом",
        ],
    )?;
    let sha = git(clone_of, &["rev-parse", "HEAD"])?;
    // вернуть грязь в рабочую копию; коммит снять с ветки (остаётся висячим по sha)
    git(clone_of, &["reset", "--mixed", "HEAD~1"])?;
    Ok(sha)
}

// РЕАЛЬНАЯ запись патча в основное дерево. Вызывать ТОЛЬКО после merge_check (пусто) и
// merge_backup. assert: цель ≠ источник (инвариант 1).
#[allow(dead_code)]
pub fn merge_apply(clone_of: &str, worktree: &str, patch: &str) -> Result<(), String> {
    if !valid_main_target(clone_of) {
        return Err("основное дерево невалидно (не корень репозитория)".into());
    }
    if same_path(clone_of, worktree) {
        return Err("цель записи совпадает с источником — запись запрещена".into());
    }
    if patch.trim().is_empty() {
        return Err("пустой патч".into());
    }
    // БЕЗ --3way (см. merge_check): plain apply строго all-or-nothing — либо весь патч лёг,
    // либо ни байта (никаких конфликт-маркеров в файлах пользователя).
    let (ok, stderr) = git_apply_stdin(clone_of, &["apply", "--whitespace=nowarn"], patch)?;
    if ok {
        Ok(())
    } else {
        Err(format!("apply не удался: {}", stderr.trim()))
    }
}

// Откат переноса к точке backup_sha. Возвращает основное дерево в состояние ДО переноса:
// tracked — через reset на снимок + HEAD назад на оригинал; новые файлы переноса
// (added_paths) удаляются ЯВНО (reset --hard их как untracked не убирает — проверено).
// Инвариант 11.
#[allow(dead_code)]
pub fn merge_undo(clone_of: &str, backup_sha: &str) -> Result<(), String> {
    if !valid_main_target(clone_of) {
        return Err("основное дерево невалидно для отката".into());
    }
    // родитель снимка вычисляем ДО любого деструктивного reset (атомарность): нет родителя
    // (корневой коммит) → отказ, ничего не трогаем.
    let parent = git(clone_of, &["rev-parse", "--verify", "--quiet", &format!("{backup_sha}^")])
        .map_err(|_| "у точки отката нет родителя — откат невозможен".to_string())?;
    // 1) восстановить tracked + вернуть untracked пользователя (они в снимке как tracked)
    git(clone_of, &["reset", "--hard", backup_sha])?;
    // 2) новые файлы переноса = то, что осталось untracked после восстановления снимка
    //    (untracked пользователя снимок вернул как tracked → их тут НЕ будет → не удалим)
    // core.quotepath=false — иначе юникод-пути выводятся в кавычках с octal-escape и
    // remove_file по такому пути промахнётся (орфан останется).
    let leftover = git(
        clone_of,
        &["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"],
    )
    .unwrap_or_default();
    // 3) HEAD назад на оригинал (снимок остаётся висячим по sha)
    git(clone_of, &["reset", "--mixed", &parent])?;
    for rel in leftover.lines() {
        let rel = rel.trim();
        if !rel.is_empty() {
            let _ = std::fs::remove_file(Path::new(clone_of).join(rel)); // best-effort
        }
    }
    // снять защитный ref (откат завершён — снимок больше не нужен)
    let _ = git(clone_of, &["update-ref", "-d", &format!("refs/deck/backup/{backup_sha}")]);
    Ok(())
}

// M3 (аудит 2026-06-17): advisory-lock на репозиторий-цель. Между merge_check «чисто» и
// merge_apply другой параллельный перенос в ТУ ЖЕ цель мог бы изменить дерево → apply упал бы
// частично. Сериализуем переносы по канонизированному пути `clone_of`: один Mutex на цель,
// держим его на весь backup→apply. Минимальный scope — лочим только в merge_transfer (единая
// точка записи), без вложенных захватов (нет дедлока). Реестр Mutex'ов растёт по числу разных
// целей (их единицы — воркспейсы), не чистим.
fn merge_lock_for(clone_of: &str) -> std::sync::Arc<Mutex<()>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>>> = OnceLock::new();
    // ключ = канонический путь (разные строки на один путь не разъедут блокировку)
    let key = std::fs::canonicalize(clone_of)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| clone_of.to_string());
    let reg = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = reg.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key)
        .or_insert_with(|| std::sync::Arc::new(Mutex::new(())))
        .clone()
}

// ЕДИНАЯ транзакционная точка переноса (все гейты ВНУТРИ — обойти нельзя): валидация цели →
// построение патча → сухой прогон (конфликт → основное НЕ тронуто) → резервная точка (+ref от
// gc) → применение (сбой → немедленный авто-откат). Возвращает MergeResult. Это рекомендованный
// состязательной проверкой способ закрыть #1/#3/#7 (apply невозможно вызвать в обход гейтов).
#[allow(dead_code)]
pub fn merge_transfer(clone_of: &str, worktree: &str, paths: &[String]) -> MergeResult {
    // M3: захватываем advisory-lock цели на весь перенос (backup→apply сериализованы).
    // Держим guard до конца функции — параллельный merge в ту же цель ждёт здесь.
    let lock = merge_lock_for(clone_of);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let fail = |msg: String| MergeResult {
        ok: false,
        applied_files: 0,
        backup_sha: None,
        conflicts: vec![],
        error: Some(msg),
    };
    if !valid_main_target(clone_of) {
        return fail("основное дерево невалидно (не корень репозитория)".into());
    }
    if same_path(clone_of, worktree) {
        return fail("цель совпадает с источником".into());
    }
    let patch = match build_merge_patch(worktree, paths) {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    if patch.trim().is_empty() {
        return fail("нечего переносить".into());
    }
    let conflicts = match merge_check(clone_of, &patch) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    if !conflicts.is_empty() {
        // основное дерево не тронуто
        return MergeResult {
            ok: false,
            applied_files: 0,
            backup_sha: None,
            conflicts,
            error: None,
        };
    }
    let backup_sha = match merge_backup(clone_of) {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    // защитить backup-коммит от git gc до отката/сброса
    let _ = git(
        clone_of,
        &["update-ref", &format!("refs/deck/backup/{backup_sha}"), &backup_sha],
    );
    match merge_apply(clone_of, worktree, &patch) {
        Ok(()) => MergeResult {
            ok: true,
            applied_files: paths.len() as u32,
            backup_sha: Some(backup_sha),
            conflicts: vec![],
            error: None,
        },
        Err(e) => {
            // авто-откат (само-защита от частичного состояния)
            let _ = merge_undo(clone_of, &backup_sha);
            fail(format!("перенос отменён, откат выполнен: {e}"))
        }
    }
}

// Пути новых файлов в патче (блоки с `new file mode`) — нужны для отката (merge_undo).
#[allow(dead_code)]
pub fn patch_added_paths(patch: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut is_new = false;
    let mut cur: Option<String> = None;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            if is_new {
                if let Some(p) = cur.take() {
                    out.push(p);
                }
            }
            is_new = false;
            cur = None;
        } else if line.starts_with("new file mode") {
            is_new = true;
        } else if let Some(p) = line.strip_prefix("+++ b/") {
            cur = Some(p.trim().to_string());
        }
    }
    if is_new {
        if let Some(p) = cur {
            out.push(p);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn run_git(dir: &std::path::Path, args: &[&str]) {
        let st = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git запустился");
        assert!(st.status.success(), "git {:?} упал: {}", args, String::from_utf8_lossy(&st.stderr));
    }

    // Регресс-замок фантома хвостового \n: «было» из HEAD должно сохранять
    // финальный перевод строки (никакого trim), а diff = ровно реальная правка.
    #[test]
    fn diff_file_preserves_trailing_newline_no_phantom() {
        let dir = std::env::temp_dir().join(format!("deck-gitops-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        run_git(&dir, &["init", "-q"]);
        run_git(&dir, &["config", "user.email", "t@t"]);
        run_git(&dir, &["config", "user.name", "t"]);
        // файл с хвостовым переводом строки
        fs::write(dir.join("f.txt"), "a\nb\nc\n").unwrap();
        run_git(&dir, &["add", "f.txt"]);
        run_git(&dir, &["commit", "-qm", "init"]);
        // правим только среднюю строку, хвостовой \n на месте
        fs::write(dir.join("f.txt"), "a\nB\nc\n").unwrap();

        let pair = diff_file(dir.to_str().unwrap(), "f.txt");
        assert_eq!(pair.old_text, "a\nb\nc\n", "было = точные байты HEAD, с хвостовым \\n");
        assert_eq!(pair.new_text, "a\nB\nc\n", "стало = диск");
        assert!(pair.old_text.ends_with('\n'), "trim не должен срезать финальный \\n");
        assert_eq!(pair.status, "modified");

        let _ = fs::remove_dir_all(&dir);
    }

    // ===================== RFC 0013 merge-back тесты =====================
    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("deck-merge-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    // Основное дерево с коммитом (app.txt/other.txt) + worktree-ветка агента (без правок).
    fn setup_main_wt(root: &std::path::Path) -> (String, String) {
        let main = root.join("main");
        let wt = root.join("wt");
        fs::create_dir_all(&main).unwrap();
        run_git(&main, &["init", "-q"]);
        run_git(&main, &["config", "user.email", "t@t"]);
        run_git(&main, &["config", "user.name", "t"]);
        fs::write(main.join("app.txt"), "line1\nline2\nline3\n").unwrap();
        fs::write(main.join("other.txt"), "shared\n").unwrap();
        run_git(&main, &["add", "-A"]);
        run_git(&main, &["commit", "-qm", "init"]);
        run_git(&main, &["worktree", "add", "-q", "-b", "deck/agent", wt.to_str().unwrap()]);
        (
            main.to_str().unwrap().to_string(),
            wt.to_str().unwrap().to_string(),
        )
    }

    fn rd(p: &str) -> String {
        fs::read_to_string(p).unwrap()
    }

    // Happy path: правки агента ложатся в основное, ГРЯЗЬ основного (своя правка + untracked)
    // сохраняется, новый файл переносится.
    #[test]
    fn merge_happy_applies_and_preserves_main_dirty() {
        let dir = scratch("happy");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/app.txt"), "line1\nAGENT\nline3\n").unwrap();
        fs::write(format!("{wt}/new.txt"), "brand new\n").unwrap();
        // основное дерево грязное: своя правка other.txt + свой untracked mine.txt
        fs::write(format!("{main}/other.txt"), "shared\nMY OWN\n").unwrap();
        fs::write(format!("{main}/mine.txt"), "scratch\n").unwrap();

        let patch = build_merge_patch(&wt, &["app.txt".into(), "new.txt".into()]).unwrap();
        assert!(merge_check(&main, &patch).unwrap().is_empty(), "должно лечь чисто");
        let sha = merge_backup(&main).unwrap();
        assert!(!sha.is_empty(), "бэкап вернул sha");
        merge_apply(&main, &wt, &patch).unwrap();

        assert_eq!(rd(&format!("{main}/app.txt")), "line1\nAGENT\nline3\n", "правка агента применена");
        assert_eq!(rd(&format!("{main}/other.txt")), "shared\nMY OWN\n", "грязь основного сохранена");
        assert_eq!(rd(&format!("{main}/new.txt")), "brand new\n", "новый файл перенёсся");
        assert_eq!(rd(&format!("{main}/mine.txt")), "scratch\n", "untracked основного цел");
        let _ = fs::remove_dir_all(&dir);
    }

    // Конфликт: основное меняет ТУ ЖЕ строку → merge_check отказывает, основное БАЙТ-в-байт цело.
    #[test]
    fn merge_check_refuses_conflict_main_untouched() {
        let dir = scratch("conflict");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/app.txt"), "line1\nAGENT\nline3\n").unwrap();
        let patch = build_merge_patch(&wt, &["app.txt".into()]).unwrap();
        // основное меняет ту же строку
        fs::write(format!("{main}/app.txt"), "line1\nMAIN-OWN\nline3\n").unwrap();
        let before = rd(&format!("{main}/app.txt"));

        let conflicts = merge_check(&main, &patch).unwrap();
        assert!(!conflicts.is_empty(), "конфликт должен быть обнаружен");
        assert_eq!(before, rd(&format!("{main}/app.txt")), "основное дерево не тронуто при --check");
        let _ = fs::remove_dir_all(&dir);
    }

    // Валидатор цели: настоящий корень репо — да; не-репо/несуществующий — нет.
    #[test]
    fn valid_main_target_checks_repo_root() {
        let dir = scratch("vmt");
        let (main, _wt) = setup_main_wt(&dir);
        assert!(valid_main_target(&main), "корень репо — валидная цель");
        let nonrepo = dir.join("nope");
        fs::create_dir_all(&nonrepo).unwrap();
        assert!(!valid_main_target(nonrepo.to_str().unwrap()), "не-репо — невалидно");
        assert!(!valid_main_target("/no/such/path/deck-xyz"), "несуществующий — невалидно");
        let _ = fs::remove_dir_all(&dir);
    }

    // Инвариант 1: запись запрещена, если цель == источник.
    #[test]
    fn merge_apply_rejects_target_equals_source() {
        let dir = scratch("samepath");
        let (main, _wt) = setup_main_wt(&dir);
        let err = merge_apply(&main, &main, "diff --git a/x b/x\n+y\n").unwrap_err();
        assert!(err.contains("совпадает"), "должен отказать при target==source: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    // Undo: возвращает основное в состояние ДО переноса и удаляет добавленный новый файл,
    // сохраняя грязь основного.
    #[test]
    fn merge_undo_restores_and_removes_added() {
        let dir = scratch("undo");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/app.txt"), "line1\nAGENT\nline3\n").unwrap();
        fs::write(format!("{wt}/new.txt"), "brand new\n").unwrap();
        fs::write(format!("{main}/other.txt"), "shared\nMY OWN\n").unwrap(); // грязь основного

        let patch = build_merge_patch(&wt, &["app.txt".into(), "new.txt".into()]).unwrap();
        assert_eq!(patch_added_paths(&patch), vec!["new.txt".to_string()], "новый файл найден в патче");
        let sha = merge_backup(&main).unwrap();
        merge_apply(&main, &wt, &patch).unwrap();
        assert!(Path::new(&format!("{main}/new.txt")).exists(), "перенос состоялся");

        merge_undo(&main, &sha).unwrap();
        assert_eq!(rd(&format!("{main}/app.txt")), "line1\nline2\nline3\n", "app откатилась");
        assert!(!Path::new(&format!("{main}/new.txt")).exists(), "новый файл удалён при undo");
        assert_eq!(rd(&format!("{main}/other.txt")), "shared\nMY OWN\n", "грязь основного цела после undo");
        let _ = fs::remove_dir_all(&dir);
    }

    // mustFix #1 (CRITICAL): основное ЗАСТЕЙДЖИЛО (git add) ту же строку. merge_check ОБЯЗАН
    // отказать (раньше --3way давал ложное «чисто»), и в файле НЕ должно быть маркеров <<<<<<<.
    #[test]
    fn merge_check_refuses_staged_conflict_no_markers() {
        let dir = scratch("staged");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/app.txt"), "line1\nAGENT\nline3\n").unwrap();
        let patch = build_merge_patch(&wt, &["app.txt".into()]).unwrap();
        // основное застейджило свою правку той же строки
        fs::write(format!("{main}/app.txt"), "line1\nMAIN-STAGED\nline3\n").unwrap();
        run_git(std::path::Path::new(&main), &["add", "app.txt"]);

        assert!(!merge_check(&main, &patch).unwrap().is_empty(), "staged-конфликт обязан быть пойман");
        // через транзакцию: конфликт → основное не тронуто, маркеров нет
        let res = merge_transfer(&main, &wt, &["app.txt".into()]);
        assert!(!res.ok, "merge_transfer не должен применить конфликт");
        assert!(!res.conflicts.is_empty(), "должны быть конфликтные файлы");
        let content = rd(&format!("{main}/app.txt"));
        assert!(!content.contains("<<<<<<<"), "в файле пользователя НЕТ конфликт-маркеров: {content}");
        assert!(content.contains("MAIN-STAGED"), "правка пользователя цела");
        let _ = fs::remove_dir_all(&dir);
    }

    // mustFix #2: основное дерево без коммитов (unborn HEAD) → merge_backup отказывает,
    // фантомного backup-коммита на ветке НЕ остаётся.
    #[test]
    fn merge_backup_rejects_unborn_head() {
        let dir = scratch("unborn");
        let main = dir.join("main");
        fs::create_dir_all(&main).unwrap();
        run_git(&main, &["init", "-q"]);
        run_git(&main, &["config", "user.email", "t@t"]);
        run_git(&main, &["config", "user.name", "t"]);
        fs::write(main.join("w.txt"), "work\n").unwrap(); // несохранённая работа, без коммита

        let r = merge_backup(main.to_str().unwrap());
        assert!(r.is_err(), "на unborn-HEAD бэкап должен отказать");
        // HEAD по-прежнему unborn (нет фантомного коммита), работа на месте
        assert!(
            git(main.to_str().unwrap(), &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err(),
            "фантомного коммита не появилось"
        );
        assert_eq!(rd(main.join("w.txt").to_str().unwrap()), "work\n", "работа пользователя цела");
        let _ = fs::remove_dir_all(&dir);
    }

    // mustFix #3: linked-worktree НЕ валидная цель записи (git-common-dir ≠ git-dir).
    #[test]
    fn valid_main_target_rejects_worktree() {
        let dir = scratch("vmtwt");
        let (main, wt) = setup_main_wt(&dir);
        assert!(valid_main_target(&main), "основное дерево — валидно");
        assert!(!valid_main_target(&wt), "linked-worktree — НЕ валидная цель");
        // и запись в worktree-как-цель отклоняется
        assert!(!merge_transfer(&wt, &main, &["x".into()]).ok, "merge в worktree-цель отклонён");
        let _ = fs::remove_dir_all(&dir);
    }

    // mustFix #4: undo НЕ удаляет собственный untracked-файл пользователя (только новые файлы
    // переноса). Пользовательский mine.txt существовал ДО переноса → должен пережить undo.
    #[test]
    fn merge_undo_keeps_user_untracked() {
        let dir = scratch("keepuntracked");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/app.txt"), "line1\nAGENT\nline3\n").unwrap();
        fs::write(format!("{main}/mine.txt"), "user scratch\n").unwrap(); // untracked пользователя

        let res = merge_transfer(&main, &wt, &["app.txt".into()]);
        assert!(res.ok, "перенос состоялся: {:?}", res.error);
        let sha = res.backup_sha.clone().unwrap();
        merge_undo(&main, &sha).unwrap();
        assert_eq!(rd(&format!("{main}/mine.txt")), "user scratch\n", "untracked пользователя пережил undo");
        assert_eq!(rd(&format!("{main}/app.txt")), "line1\nline2\nline3\n", "app откатилась");
        let _ = fs::remove_dir_all(&dir);
    }

    // mustFix #7: транзакционная merge_transfer — happy + откат целиком.
    #[test]
    fn merge_transfer_happy_then_undo() {
        let dir = scratch("transfer");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/app.txt"), "line1\nAGENT\nline3\n").unwrap();
        fs::write(format!("{wt}/new.txt"), "brand new\n").unwrap();
        fs::write(format!("{main}/other.txt"), "shared\nMY OWN\n").unwrap();

        let res = merge_transfer(&main, &wt, &["app.txt".into(), "new.txt".into()]);
        assert!(res.ok, "перенос ок: {:?}", res.error);
        assert_eq!(res.applied_files, 2);
        assert!(res.backup_sha.is_some(), "есть точка отката");
        assert_eq!(rd(&format!("{main}/app.txt")), "line1\nAGENT\nline3\n");
        assert_eq!(rd(&format!("{main}/new.txt")), "brand new\n");
        assert_eq!(rd(&format!("{main}/other.txt")), "shared\nMY OWN\n", "грязь основного цела");

        merge_undo(&main, &res.backup_sha.unwrap()).unwrap();
        assert_eq!(rd(&format!("{main}/app.txt")), "line1\nline2\nline3\n", "откат app");
        assert!(!Path::new(&format!("{main}/new.txt")).exists(), "новый файл убран");
        assert_eq!(rd(&format!("{main}/other.txt")), "shared\nMY OWN\n", "грязь цела после undo");
        let _ = fs::remove_dir_all(&dir);
    }

    // Юникод-имя нового файла: core.quotepath=false → patch_added_paths его видит → undo удаляет.
    #[test]
    fn merge_unicode_new_file_undo_removes() {
        let dir = scratch("unicode");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/файл.txt"), "юникод\n").unwrap();
        let patch = build_merge_patch(&wt, &["файл.txt".into()]).unwrap();
        assert_eq!(patch_added_paths(&patch), vec!["файл.txt".to_string()], "юникод-путь распознан");
        let res = merge_transfer(&main, &wt, &["файл.txt".into()]);
        assert!(res.ok, "перенос ок: {:?}", res.error);
        assert!(Path::new(&format!("{main}/файл.txt")).exists(), "файл перенёсся");
        merge_undo(&main, &res.backup_sha.unwrap()).unwrap();
        assert!(!Path::new(&format!("{main}/файл.txt")).exists(), "юникод-файл убран при undo (не орфан)");
        let _ = fs::remove_dir_all(&dir);
    }

    // carry-over: агент создал симлинк → перенос отказывает, основное дерево не тронуто
    // (симлинк может указывать на произвольный путь вне дерева — состязательная проверка HIGH).
    #[test]
    fn merge_refuses_symlink() {
        let dir = scratch("symlink");
        let (main, wt) = setup_main_wt(&dir);
        std::os::unix::fs::symlink("/etc/hosts", format!("{wt}/evil-link")).unwrap();

        let res = merge_transfer(&main, &wt, &["evil-link".into()]);
        assert!(!res.ok, "симлинк не должен переноситься");
        assert!(
            res.error.as_deref().unwrap_or("").contains("симлинк"),
            "ошибка про симлинк: {:?}",
            res.error
        );
        assert!(!Path::new(&format!("{main}/evil-link")).exists(), "симлинк в основное не создан");
        let _ = fs::remove_dir_all(&dir);
    }

    // Новый файл агента, который УЖЕ есть в main (свой untracked) → понятная причина «уже есть»,
    // файл пользователя НЕ затирается (как в живом тесте пользователя с test.txt).
    #[test]
    fn merge_new_file_collision_clear_message() {
        let dir = scratch("collision");
        let (main, wt) = setup_main_wt(&dir);
        fs::write(format!("{wt}/doc.txt"), "AGENT\n").unwrap(); // агент создал новый
        fs::write(format!("{main}/doc.txt"), "MY OWN\n").unwrap(); // в main уже есть свой (untracked)

        let res = merge_transfer(&main, &wt, &["doc.txt".into()]);
        assert!(!res.ok, "коллизия → не применять");
        assert!(
            res.conflicts.iter().any(|c| c.contains("уже есть")),
            "понятная причина «уже есть»: {:?}",
            res.conflicts
        );
        assert_eq!(rd(&format!("{main}/doc.txt")), "MY OWN\n", "файл пользователя не затёрт");
        let _ = fs::remove_dir_all(&dir);
    }

    // H5 (аудит 2026-06-17): diff_file ОБЯЗАН отказывать на traversal-путях, не читая чужой файл.
    // '../x', абсолютный путь, '~' → status="error", старый текст пуст (никакого `git show` наружу).
    #[test]
    fn diff_file_rejects_path_traversal() {
        let dir = scratch("traversal");
        let (main, _wt) = setup_main_wt(&dir);

        for bad in [
            "../app.txt",
            "../../etc/hosts",
            "/etc/hosts",
            "/Users/x/.ssh/id_rsa",
            "sub/../../escape.txt",
            "~/secret",
        ] {
            let pair = diff_file(&main, bad);
            assert_eq!(pair.status, "error", "путь '{bad}' должен быть отклонён");
            assert!(pair.old_text.is_empty(), "для '{bad}' ничего не читаем из HEAD");
            assert!(
                pair.new_text.contains("небезопасный путь"),
                "для '{bad}' ожидали пометку об отказе, получили: {}",
                pair.new_text
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    // Легитимный относительный путь по-прежнему работает (гейт не ломает нормальный diff).
    #[test]
    fn diff_file_allows_safe_relative_path() {
        let dir = scratch("safe-rel");
        let (main, _wt) = setup_main_wt(&dir);
        fs::write(format!("{main}/app.txt"), "line1\nEDIT\nline3\n").unwrap();
        let pair = diff_file(&main, "app.txt");
        assert_ne!(pair.status, "error", "обычный путь не должен блокироваться");
        assert_eq!(pair.old_text, "line1\nline2\nline3\n", "версия из HEAD прочитана");
        assert_eq!(pair.new_text, "line1\nEDIT\nline3\n", "версия с диска прочитана");
        let _ = fs::remove_dir_all(&dir);
    }

    // ensure_safe_rel_path — прямые юнит-кейсы (без git).
    #[test]
    fn ensure_safe_rel_path_unit() {
        let dir = scratch("ensure-safe");
        let d = dir.to_str().unwrap();
        assert!(ensure_safe_rel_path(d, "a/b.txt").is_ok());
        assert!(ensure_safe_rel_path(d, "deep/nested/file.rs").is_ok());
        assert!(ensure_safe_rel_path(d, "").is_err(), "пусто");
        assert!(ensure_safe_rel_path(d, "../x").is_err(), "..");
        assert!(ensure_safe_rel_path(d, "a/../../x").is_err(), "вложенный ..");
        assert!(ensure_safe_rel_path(d, "/abs").is_err(), "абсолют");
        assert!(ensure_safe_rel_path(d, "~/x").is_err(), "тильда");
        let _ = fs::remove_dir_all(&dir);
    }

    // gitops::status отдаёт РЕАЛЬНЫЙ UTF-8 путь для не-ASCII имён (core.quotepath=false),
    // а не octal-кавычки «\320\277…» — иначе ломается подсветка/Diff/перенос (живой баг).
    #[test]
    fn status_returns_real_unicode_path() {
        let dir = scratch("status-unicode");
        let main = dir.join("r");
        fs::create_dir_all(&main).unwrap();
        run_git(&main, &["init", "-q"]);
        fs::write(main.join("проверка.txt"), "x\n").unwrap();
        let files = status(main.to_str().unwrap());
        assert!(
            files.iter().any(|f| f.path == "проверка.txt"),
            "путь должен быть реальный UTF-8: {:?}",
            files.iter().map(|f| f.path.clone()).collect::<Vec<_>>()
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
