// RFC 0003 — приёмник хуков агентов (Фаза A: Claude-пилот; Фаза C: Codex).
// Локальный HTTP-приёмник на 127.0.0.1:<рандом> + токен. Агент на лайфсайкл-события шлёт сюда
// POST с заголовками X-Deck-Session / X-Deck-Token / X-Deck-Event.
// Событие → статус: Stop→ready (но если последнее сообщение Клода кончается вопросом — awaiting,
// жёлтый: читаем transcript_path из stdin хука), Notification/PermissionRequest→awaiting,
// UserPromptSubmit/PreToolUse→working. Корреляция по DECK_SESSION_ID (уже в env каждого PTY).
//
// Хуки внедряем через ОТДЕЛЬНЫЙ файл (личный конфиг агента не трогаем, он мёрджит поверх):
//   Claude — `claude --settings <claude-hooks.json>`;
//   Codex  — `codex -p deck` (оверлей ~/.codex/deck.config.toml поверх базового config.toml).

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

// ВРЕМЕННАЯ диагностика уведомлений (удалить после подтверждения, что приходят).
// Пишет в ~/Library/Logs/Deck-Dev-notify.log.
fn dbg_notify_log(line: &str) {
    dbg_log_to("Library/Logs/Deck-Dev-notify.log", line);
}

fn dbg_log_to(rel: &str, line: &str) {
    if let Some(home) = dirs::home_dir() {
        let p = home.join(rel);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "{ts} {line}");
        }
    }
}

// Экранирование строки для строкового литерала AppleScript ("...").
fn applescript_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

// ── Подавление уведомлений ──
// Не дёргаем уведомлением, если окно в фокусе И активна именно эта сессия (юзер уже тут).
static ACTIVE_SESSION: Mutex<Option<String>> = Mutex::new(None);
static WINDOW_FOCUSED: AtomicBool = AtomicBool::new(true);

pub fn set_active_session(id: Option<String>) {
    *ACTIVE_SESSION.lock().unwrap() = id;
}
pub fn set_window_focused(f: bool) {
    WINDOW_FOCUSED.store(f, Ordering::SeqCst);
}
fn is_suppressed(session_id: &str) -> bool {
    WINDOW_FOCUSED.load(Ordering::SeqCst)
        && ACTIVE_SESSION.lock().unwrap().as_deref() == Some(session_id)
}

// Троттл повторных баннеров «ждёт ответа»: Claude перенапоминает каждые ~60с и цикл
// awaiting↔working плодит дубли. Не чаще одного баннера awaiting на сессию в 3 минуты
// (сам жёлтый статус-цвет ставится всегда, глушим только спам уведомлений).
static AWAIT_NOTIFY: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
fn awaiting_recently_notified(session_id: &str) -> bool {
    let map = AWAIT_NOTIFY.get_or_init(|| Mutex::new(HashMap::new()));
    let mut m = map.lock().unwrap();
    let now = Instant::now();
    if let Some(&last) = m.get(session_id) {
        if now.duration_since(last) < Duration::from_secs(180) {
            return true;
        }
    }
    m.insert(session_id.to_string(), now);
    false
}

// Уведомление по ХУК-событию (надёжно). Эвристика уведомления НЕ шлёт — поэтому нет спама.
// awaiting/error — всегда (требуют внимания); ready — по настройке notify_on_done.
// «Закончил» (ready) НЕ подавляем фокусом: пользователь хочет видеть завершение, даже
// глядя в окно Deck (RFC 0003 §Подавление — уточнение: гасим фокусом только awaiting/error).
pub fn notify_status(app: &tauri::AppHandle, session_id: &str, status: &str) {
    let heading = match status {
        "awaiting" => "🟡 Агент ждёт ответа",
        "error" => "🔴 Агент упал",
        "ready" => "🟢 Агент закончил",
        _ => return,
    };
    dbg_notify_log(&format!("enter session={session_id} status={status}"));
    if status != "ready" && is_suppressed(session_id) {
        dbg_notify_log("→ suppressed (фокус+активная, не-ready)");
        return;
    }
    let (notify_on_done, sound_on, sess_title) = {
        let store = app.state::<Mutex<crate::state::StateStore>>();
        let s = store.lock().unwrap();
        let t = s
            .data
            .sessions
            .iter()
            .find(|x| x.id == session_id)
            .map(|x| x.title.clone())
            .unwrap_or_default();
        (s.data.settings.notify_on_done, s.data.settings.sound_on_done, t)
    };
    if status == "ready" && !notify_on_done {
        dbg_notify_log("→ skip ready: notify_on_done=false");
        return;
    }
    // антиспам: повторные «ждёт ответа» по той же сессии глушим (статус-цвет не трогаем)
    if status == "awaiting" && awaiting_recently_notified(session_id) {
        dbg_notify_log("→ skip awaiting: throttled (<3мин)");
        return;
    }
    let body = if sess_title.is_empty() { "сессия".to_string() } else { sess_title };

    // Иконка баннера = иконка приложения (наш логотип Deck). Предпочитаем terminal-notifier
    // с `-sender <bundle-id>`: баннер берёт иконку самого Deck (а не Script Editor, как у
    // голого `osascript display notification`), и клик по нему активирует приложение.
    // Если terminal-notifier не установлен — откат на osascript (баннер придёт, но иконка
    // будет дефолтная). macOS не доставляет уведомления tauri-plugin от ad-hoc-подписи —
    // поэтому через внешний процесс, а не нативный плагин.
    let bundle_id = app.config().identifier.clone();
    let posted = if let Some(tn) = find_terminal_notifier() {
        let mut c = std::process::Command::new(tn);
        c.arg("-title")
            .arg(heading)
            .arg("-message")
            .arg(&body)
            .arg("-sender")
            .arg(&bundle_id);
        if sound_on {
            c.arg("-sound").arg("Ping");
        }
        let ok = c.spawn().is_ok();
        dbg_notify_log(&format!(
            "→ terminal-notifier status={status} sender={bundle_id} spawned={ok}"
        ));
        ok
    } else {
        false
    };
    if !posted {
        let mut script = format!(
            "display notification {} with title {}",
            applescript_quote(&body),
            applescript_quote(heading)
        );
        if sound_on {
            script.push_str(" sound name \"Ping\"");
        }
        let spawned = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .is_ok();
        dbg_notify_log(&format!("→ osascript(fallback) status={status} spawned={spawned}"));
    }
}

// Путь к terminal-notifier (Homebrew arm64/intel или из PATH). None → не установлен.
fn find_terminal_notifier() -> Option<String> {
    for p in [
        "/opt/homebrew/bin/terminal-notifier",
        "/usr/local/bin/terminal-notifier",
    ] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    std::process::Command::new("/usr/bin/which")
        .arg("terminal-notifier")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

static HOOK_INFO: OnceLock<(u16, String)> = OnceLock::new();

pub fn hook_port_token() -> Option<(u16, String)> {
    HOOK_INFO.get().cloned()
}

fn rand_token() -> String {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", n, n.rotate_left(17))
}

// Путь к Deck-файлу хуков Claude (вне ~/.claude — не трогаем личный конфиг).
pub fn claude_hooks_path() -> std::path::PathBuf {
    let base = dirs::config_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    base.join("Deck").join("claude-hooks.json")
}

// Папка с файлами приёмника (hook-port / hook-token) — общая для всех агентов Deck.
fn hook_io_dir() -> std::path::PathBuf {
    claude_hooks_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
}

// ── Перехват статусстроки Claude (для виджета лимитов, RFC 0004) ──────────────────
// Claude Code отдаёт команде statusLine на stdin JSON с .rate_limits (настоящий % квоты аккаунта,
// тот же, что в терминале). Deck подставляет через --settings свою обёртку: она кладёт этот JSON
// в файл (виджет читает оттуда настоящий %) и пробрасывает тот же ввод в личную статусстрому
// пользователя — её вид не меняется.

// Файл со снимком JSON статусстроки (с .rate_limits). Читает usage.rs::claude_rate_limits.
pub fn claude_statusline_capture_path() -> std::path::PathBuf {
    hook_io_dir().join("claude-statusline.json")
}

// Скрипт-обёртка статусстроки, который Deck подставляет в --settings.
pub fn claude_statusline_wrapper_path() -> std::path::PathBuf {
    hook_io_dir().join("cli-statusline.sh")
}

// Команда личной статусстроки пользователя (~/.claude/settings.json .statusLine.command), чтобы
// обёртка пробросила в неё ввод и вид не изменился. None — своей статусстроки нет.
fn read_user_statusline_command() -> Option<String> {
    let p = dirs::home_dir()?.join(".claude").join("settings.json");
    let text = std::fs::read_to_string(p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("statusLine")?
        .get("command")?
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
}

// Записать обёртку статусстроки (идемпотентно, +x): снимает stdin в файл Deck и пробрасывает тот
// же ввод в личную статусстрому (here-string). Без своей статусстроки — печатает имя модели.
pub fn write_claude_statusline_wrapper() -> std::path::PathBuf {
    let path = claude_statusline_wrapper_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let capture = claude_statusline_capture_path();
    let chain = match read_user_statusline_command() {
        // тот же stdin (мы прочитали его в $input) уходит в личную статусстрому через here-string
        Some(cmd) => format!("{cmd} <<< \"$input\"\n"),
        None => "echo Claude\n".to_string(),
    };
    let script = format!(
        "#!/bin/bash\n\
         # Deck (RFC 0004): авто-генерируется — НЕ редактировать. Снимает rate_limits Claude для\n\
         # виджета лимитов и пробрасывает ввод в твою статусстрому (её вид не меняется).\n\
         input=$(cat)\n\
         printf '%s' \"$input\" > '{cap}' 2>/dev/null\n\
         {chain}",
        cap = capture.display(),
    );
    let _ = std::fs::write(&path, script);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    path
}

// curl-команда хука для события. Хук читает адрес приёмника (порт+токен) из ФАЙЛОВ в момент
// срабатывания, а НЕ из env: env фиксируется при запуске сессии и теряется при рестарте Deck
// (порт случайный per-launch) → старые сессии «сиротеют». Файлы Deck перезаписывает на каждом
// запуске → канал переживает рестарт. DECK_SESSION_ID берём из env (стабилен).
// Команда одинаковая для Claude (JSON settings) и Codex (TOML config) — приёмник и заголовки
// те же, поэтому один маппинг событий в start_receiver покрывает обоих.
fn hook_curl_cmd(event: &str) -> String {
    let dir = hook_io_dir();
    let port_file = dir.join("hook-port");
    let token_file = dir.join("hook-token");
    format!(
        "P=\"$(cat '{port}' 2>/dev/null)\"; T=\"$(cat '{token}' 2>/dev/null)\"; \
         [ -n \"$P\" ] && curl -s -o /dev/null -m 2 -X POST \"http://127.0.0.1:$P/h\" \
         -H \"X-Deck-Token: $T\" \
         -H \"X-Deck-Session: ${{DECK_SESSION_ID}}\" \
         -H \"X-Deck-Event: {event}\" 2>/dev/null || true",
        port = port_file.display(),
        token = token_file.display(),
    )
}

// Команда хука Claude, которая ВДОБАВОК к обычному POST читает stdin (JSON хука содержит
// `transcript_path`) и шлёт путь транскрипта заголовком X-Deck-Transcript. Зачем по событию:
//   • Stop — приёмник читает ПОСЛЕДНЕЕ сообщение Клода: кончается вопросом → «ждёт ответа» (жёлтый),
//     иначе «готов» (зелёный) — баг «иногда не жёлтый на вопрос».
//   • UserPromptSubmit (рано) + Stop — приёмник достаёт из имени файла транскрипта нативный
//     resume-id Claude и сохраняет в сессию (RFC 0007), чтобы при старте поднять `--resume <id>`.
// Путь шлём как есть (без base64): значение заголовка с '/' и пробелами допустимо; пусто → no-op.
fn hook_curl_cmd_claude_transcript(event: &str) -> String {
    let dir = hook_io_dir();
    let port_file = dir.join("hook-port");
    let token_file = dir.join("hook-token");
    let sed = "sed -n 's/.*\"transcript_path\": *\"\\([^\"]*\\)\".*/\\1/p'";
    format!(
        "D=\"$(cat)\"; TP=\"$(printf '%s' \"$D\" | {sed} | head -n1)\"; \
         P=\"$(cat '{port}' 2>/dev/null)\"; T=\"$(cat '{token}' 2>/dev/null)\"; \
         [ -n \"$P\" ] && curl -s -o /dev/null -m 3 -X POST \"http://127.0.0.1:$P/h\" \
         -H \"X-Deck-Token: $T\" -H \"X-Deck-Session: ${{DECK_SESSION_ID}}\" \
         -H \"X-Deck-Event: {event}\" -H \"X-Deck-Transcript: $TP\" 2>/dev/null || true",
        sed = sed,
        event = event,
        port = port_file.display(),
        token = token_file.display(),
    )
}

// Нативный resume-id Claude из пути транскрипта = имя файла без `.jsonl` (== поле sessionId).
fn resume_id_from_transcript(transcript_path: &str) -> Option<String> {
    let p = transcript_path.trim();
    if p.is_empty() {
        return None;
    }
    std::path::Path::new(p)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

// Сохранить resume-id в сессию Deck (RFC 0007). Пишем на диск только если изменилось (id стабилен
// → одна запись на сессию). session_id здесь — DECK_SESSION_ID (наш id), не нативный.
fn persist_resume_id(app: &tauri::AppHandle, deck_session_id: &str, transcript_path: &str) {
    let rid = match resume_id_from_transcript(transcript_path) {
        Some(r) => r,
        None => return,
    };
    let store = app.state::<Mutex<crate::state::StateStore>>();
    let mut s = store.lock().unwrap();
    let mut changed = false;
    if let Some(sess) = s.data.sessions.iter_mut().find(|x| x.id == deck_session_id) {
        if sess.resume_id.as_deref() != Some(rid.as_str()) {
            sess.resume_id = Some(rid);
            changed = true;
        }
    }
    if changed {
        s.save();
    }
}

// Кончается ли текст вопросом (последний непробельный символ = '?').
fn ends_with_question(s: &str) -> bool {
    s.trim_end().chars().last() == Some('?')
}

// Прочитать последнее текстовое сообщение ассистента из Claude-транскрипта (JSONL) и определить,
// вопрос ли это. Пусто/нет файла/не вопрос → false (тогда Stop = «готов», зелёный).
fn claude_stop_is_question(transcript_path: &str) -> bool {
    let p = transcript_path.trim();
    if p.is_empty() {
        return false;
    }
    let text = match std::fs::read_to_string(p) {
        Ok(t) => t,
        Err(_) => return false,
    };
    for line in text.lines().rev() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let content = match v.get("message").and_then(|m| m.get("content")) {
            Some(c) => c,
            None => continue,
        };
        let mut buf = String::new();
        if let Some(arr) = content.as_array() {
            for b in arr {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(s) = b.get("text").and_then(|t| t.as_str()) {
                        buf.push_str(s);
                    }
                }
            }
        } else if let Some(s) = content.as_str() {
            buf.push_str(s);
        }
        let trimmed = buf.trim();
        if !trimmed.is_empty() {
            return ends_with_question(trimmed); // нашли последнее текстовое сообщение — решаем по нему
        }
    }
    false
}

// Документ хуков статуса в Claude-формате: {"hooks": {СОБЫТИЕ: [{hooks:[{type:command,command}]}]}}.
// Один и тот же формат принимают Claude (через `claude --settings <файл>`) и Grok (глобальные
// хуки `~/.grok/hooks/*.json`, Claude-совместимы). События: Stop→ready, Notification→awaiting,
// UserPromptSubmit/PreToolUse→working — все есть у обоих агентов, приёмник (start_receiver)
// мапит их одинаково. Без matcher: Grok у lifecycle-событий (Stop/UserPromptSubmit) matcher
// запрещает, а у PreToolUse/Notification пустой = «всё подходит».
fn claude_format_hooks_doc() -> serde_json::Value {
    let entry = |cmd: String| -> serde_json::Value {
        serde_json::json!([{ "hooks": [{ "type": "command", "command": cmd }] }])
    };
    serde_json::json!({
        "hooks": {
            // Stop + UserPromptSubmit тащат transcript_path: Stop — вопрос(жёлтый)/готов(зелёный);
            // оба — захват resume-id (RFC 0007). UserPromptSubmit рано → resume-id ловится с первого промта.
            "Stop": entry(hook_curl_cmd_claude_transcript("Stop")),
            "Notification": entry(hook_curl_cmd("Notification")),
            "UserPromptSubmit": entry(hook_curl_cmd_claude_transcript("UserPromptSubmit")),
            "PreToolUse": entry(hook_curl_cmd("PreToolUse")),
        }
    })
}

// Записать Deck-файл хуков Claude (идемпотентно), подключается через `claude --settings <файл>`.
pub fn write_claude_hooks_file() -> std::path::PathBuf {
    let wrapper = write_claude_statusline_wrapper(); // обёртка статусстроки (перехват rate_limits)
    let path = claude_hooks_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // К хукам добавляем statusLine = наша обёртка (только в Claude-файл; в Grok-файл не идёт).
    let mut doc = claude_format_hooks_doc();
    if let Some(obj) = doc.as_object_mut() {
        obj.insert(
            "statusLine".into(),
            serde_json::json!({ "type": "command", "command": wrapper.to_string_lossy(), "padding": 0 }),
        );
    }
    let _ = std::fs::write(&path, serde_json::to_vec_pretty(&doc).unwrap_or_default());
    path
}

// Путь к Deck-файлу хуков Grok: $GROK_HOME/hooks/deck-status.json (по умолчанию ~/.grok).
// Grok дискаверит ГЛОБАЛЬНЫЕ хуки из `~/.grok/hooks/*.json` и считает их ВСЕГДА доверенными
// (проектные хуки требуют trust — нам не нужно). Своё имя файла (deck-status.json) → НЕ клоббер
// чужих глобальных хуков пользователя; флаг запуска не нужен (grok сам подхватывает).
pub fn grok_hooks_path() -> std::path::PathBuf {
    let grok_home = std::env::var_os("GROK_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".grok")))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/.grok"));
    grok_home.join("hooks").join("deck-status.json")
}

// Записать Deck-файл хуков Grok (идемпотентно). Тот же Claude-формат и тот же приёмник, что у
// Claude — Grok принимает Claude-совместимый JSON и сам мапит события на свой жизненный цикл
// (Stop=«ход завершён», Notification=«нужно внимание», …). Возвращает None, если ~/.grok нет
// (Grok не установлен) — не создаём папку впустую.
pub fn write_grok_hooks_file() -> Option<std::path::PathBuf> {
    let path = grok_hooks_path();
    let grok_home = path.parent()?.parent()?; // …/.grok/hooks/deck-status.json → …/.grok
    if !grok_home.exists() {
        return None; // Grok не установлен/не инициализирован
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir); // создаём ~/.grok/hooks/, если ещё нет
    }
    let _ = std::fs::write(
        &path,
        serde_json::to_vec_pretty(&claude_format_hooks_doc()).unwrap_or_default(),
    );
    Some(path)
}

// Путь к Deck-оверлею конфига Codex: $CODEX_HOME/deck.config.toml (по умолчанию ~/.codex).
// Codex накладывает его при `codex -p deck` ПОВЕРХ базового config.toml — это отдельный файл,
// базовый (модель + trust-уровни проектов) не трогаем.
pub fn codex_hooks_path() -> std::path::PathBuf {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp/.codex"));
    codex_home.join("deck.config.toml")
}

// Записать Deck-оверлей статуса Codex (идемпотентно, НЕ клоббер базового config.toml).
// Codex 0.139: working/awaiting — через хуки (UserPromptSubmit/PreToolUse → working,
// PermissionRequest → awaiting [у Codex это вместо claude-овского Notification]). «Ход завершён»
// (ready/зелёный) у Codex НЕ событие хука — список событий хуков фиксирован и Stop в нём нет;
// для этого отдельный ключ `notify` (Codex зовёт программу на agent-turn-complete). Приёмник и
// заголовки те же, что у Claude — start_receiver один на обоих агентов.
// Запуск — `codex -p deck --dangerously-bypass-hook-trust` (доверяем СВОИМ хукам без интерактивного
// промта доверия; флаг не ослабляет sandbox/approvals — это отдельный флаг).
// Возвращает None, если codex-home ещё нет (Codex не настроен) — не создаём ~/.codex впустую.
pub fn write_codex_hooks_file() -> Option<std::path::PathBuf> {
    let path = codex_hooks_path();
    let dir = path.parent()?;
    if !dir.exists() {
        return None; // Codex не установлен/не инициализирован — оверлей не нужен
    }
    let _ = std::fs::write(&path, codex_overlay_toml());
    Some(path)
}

// Содержимое оверлея статуса Codex (чистая функция — отдельно тестируется).
// Два канала, т.к. у Codex это РАЗНЫЕ механизмы:
//   • working/awaiting — хуки [[hooks.<событие>]] + [[hooks.<событие>.hooks]] (TOML-зеркало
//     claude hooks.json). События хуков Codex фиксированы и «ход завершён» среди них НЕТ.
//   • ready (зелёный) — ключ `notify`: Codex зовёт программу на agent-turn-complete, последним
//     argv передаёт JSON события. Программа шлёт тот же POST Stop → start_receiver мапит в ready.
//     `notify` (top-level) ОБЯЗАН идти ДО [[hooks]] — в TOML простые ключи раньше array-of-tables.
// command/notify-скрипт — TOML-литерал '''…''' (внутри есть и ', и " → литерал безопасен; троек нет).
// matcher (фильтр по инструменту) ставим только на tool-событие PreToolUse, как в доке Codex.
fn codex_overlay_toml() -> String {
    let block = |ev: &str, matcher: Option<&str>, cmd: String| -> String {
        let m = matcher.map(|m| format!("matcher = \"{m}\"\n")).unwrap_or_default();
        format!("\n[[hooks.{ev}]]\n{m}[[hooks.{ev}.hooks]]\ntype = \"command\"\ncommand = '''{cmd}'''\n")
    };
    let mut doc = String::from(
        "# Deck (RFC 0003): авто-генерируемый оверлей статуса для Codex — НЕ редактировать.\n\
         # Накладывается через `codex -p deck` поверх ~/.codex/config.toml (базовый не трогаем).\n",
    );
    // ready (зелёный): notify-программа на завершение хода. bash -lc <скрипт> deck-notify <JSON>:
    // внутри $* содержит JSON события → шлём Stop только на agent-turn-complete. ДО [[hooks]].
    let notify_script = format!(
        "case \"$*\" in *agent-turn-complete*) {} ;; esac",
        hook_curl_cmd("Stop"),
    );
    doc.push_str(&format!(
        "notify = [\"bash\", \"-lc\", '''{notify_script}''', \"deck-notify\"]\n"
    ));
    // working/awaiting: хуки жизненного цикла.
    doc.push_str(&block("UserPromptSubmit", None, hook_curl_cmd("UserPromptSubmit")));
    doc.push_str(&block("PreToolUse", Some(".*"), hook_curl_cmd("PreToolUse")));
    doc.push_str(&block("PermissionRequest", None, hook_curl_cmd("PermissionRequest")));
    doc
}

// Запустить приёмник (идемпотентно). Возвращает (порт, токен).
pub fn start_receiver(app: tauri::AppHandle) -> Option<(u16, String)> {
    if let Some(pt) = HOOK_INFO.get() {
        return Some(pt.clone());
    }
    let server = tiny_http::Server::http("127.0.0.1:0").ok()?;
    let port = server.server_addr().to_ip().map(|a| a.port())?;
    let token = rand_token();
    let info = (port, token.clone());
    let _ = HOOK_INFO.set(info.clone());
    // Адрес приёмника в файлы (хук читает их в момент срабатывания → переживает рестарт Deck).
    if let Some(dir) = claude_hooks_path().parent() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join("hook-port"), port.to_string());
        let _ = std::fs::write(dir.join("hook-token"), &token);
    }

    let tk = token.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let mut sid = String::new();
            let mut tok = String::new();
            let mut ev = String::new();
            let mut transcript = String::new();
            for h in req.headers() {
                let field = h.field.as_str().as_str().to_ascii_lowercase();
                let val = h.value.as_str().to_string();
                match field.as_str() {
                    "x-deck-session" => sid = val,
                    "x-deck-token" => tok = val,
                    "x-deck-event" => ev = val,
                    "x-deck-transcript" => transcript = val,
                    _ => {}
                }
            }
            let _ = req.respond(tiny_http::Response::empty(204));
            if tok != tk || sid.is_empty() {
                continue;
            }
            let status = match ev.as_str() {
                // Stop = конец хода: вопрос в последнем сообщении → «ждёт ответа» (жёлтый),
                // иначе «готов» (зелёный). transcript пуст (Codex/Grok без пути) → зелёный.
                "Stop" => {
                    if claude_stop_is_question(&transcript) { "awaiting" } else { "ready" }
                }
                // Notification — у Claude; PermissionRequest — у Codex (просит разрешение).
                "Notification" | "PermissionRequest" => "awaiting",
                "UserPromptSubmit" | "PreToolUse" => "working",
                _ => continue,
            };
            let ptm = app.state::<crate::pty::PtyManager>();
            ptm.apply_hook_status(&app, &sid, status);
            // RFC 0007: из транскрипта достаём нативный resume-id Claude и сохраняем в сессию.
            if !transcript.is_empty() {
                persist_resume_id(&app, &sid, &transcript);
            }
        }
    });

    Some(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Гард генератора оверлея Codex: working/awaiting через хуки (3 события), ready через notify.
    // Stop НЕ должен быть хуком (Codex его не поддерживает → неизвестное событие сломало бы оверлей).
    // (Валидность самого TOML и приём его Codex'ом проверяются вне юнит-теста — toml-крейта нет.)
    #[test]
    fn codex_overlay_status_channels() {
        let body = codex_overlay_toml();
        // working/awaiting — ровно эти 3 события хуков
        for ev in ["UserPromptSubmit", "PreToolUse", "PermissionRequest"] {
            assert!(body.contains(&format!("[[hooks.{ev}]]")), "нет блока {ev}");
            assert!(body.contains(&format!("[[hooks.{ev}.hooks]]")), "нет hooks-блока {ev}");
            assert!(body.contains(&format!("X-Deck-Event: {ev}")), "нет POST события {ev}");
        }
        // Stop как хук у Codex недопустим
        assert!(!body.contains("[[hooks.Stop]]"), "Stop не событие хука у Codex");
        // ready (зелёный) — через notify на agent-turn-complete, тот же POST Stop в приёмник
        assert!(body.contains("notify = ["), "нет notify-программы");
        assert!(body.contains("agent-turn-complete"), "notify не привязан к завершению хода");
        assert!(body.contains("X-Deck-Event: Stop"), "notify не шлёт Stop→ready");
        // notify (простой ключ) обязан идти ДО array-of-tables [[hooks]] (требование TOML)
        assert!(
            body.find("notify = [").unwrap() < body.find("[[hooks.").unwrap(),
            "notify должен быть до [[hooks]]"
        );
        // matcher — только у tool-события PreToolUse
        assert_eq!(body.matches("matcher = ").count(), 1, "matcher должен быть ровно один");
        assert!(body.contains("[[hooks.PreToolUse]]\nmatcher = \".*\""));
        // корреляция сессии + команды/notify как TOML-литералы
        assert!(body.contains("X-Deck-Session: ${DECK_SESSION_ID}"));
        assert!(body.contains("command = '''"));
        // golden-копия для внешней проверки валидности TOML + приёма Codex'ом
        let _ = std::fs::write(std::env::temp_dir().join("deck-codex-overlay.golden.toml"), &body);
    }

    // Гард общего генератора Claude-формата (Claude + Grok): все 4 статус-события + валидный JSON.
    // Grok дискаверит этот файл из ~/.grok/hooks/ и мапит события сам (Stop=ready и т.д.).
    #[test]
    fn claude_format_hooks_doc_has_status_events() {
        let doc = claude_format_hooks_doc();
        let hooks = doc.get("hooks").expect("нет ключа hooks");
        for ev in ["Stop", "Notification", "UserPromptSubmit", "PreToolUse"] {
            let arr = hooks.get(ev).unwrap_or_else(|| panic!("нет события {ev}"));
            let cmd = arr[0]["hooks"][0]["command"]
                .as_str()
                .unwrap_or_else(|| panic!("нет command у {ev}"));
            assert!(cmd.contains(&format!("X-Deck-Event: {ev}")), "command {ev} не шлёт это событие");
            assert!(cmd.contains("X-Deck-Session: ${DECK_SESSION_ID}"), "нет корреляции сессии у {ev}");
        }
        // сериализуется в валидный JSON (то, что пишем в файл Claude/Grok)
        let s = serde_json::to_string_pretty(&doc).expect("doc не сериализуется в JSON");
        let _ = std::fs::write(std::env::temp_dir().join("deck-claude-grok-hooks.golden.json"), &s);
    }

    // RFC 0007: resume-id = имя файла транскрипта без .jsonl (== sessionId Claude).
    #[test]
    fn resume_id_from_transcript_is_file_stem() {
        assert_eq!(
            resume_id_from_transcript("/Users/x/.claude/projects/-Users-x-proj/0b58636d-10fe.jsonl").as_deref(),
            Some("0b58636d-10fe")
        );
        assert_eq!(resume_id_from_transcript("  "), None);
        assert_eq!(resume_id_from_transcript(""), None);
    }

    // Stop/UserPromptSubmit-команды тащат transcript_path (для жёлтого-вопроса + resume-id).
    #[test]
    fn transcript_cmd_carries_event_and_transcript_header() {
        for ev in ["Stop", "UserPromptSubmit"] {
            let c = hook_curl_cmd_claude_transcript(ev);
            assert!(c.contains(&format!("X-Deck-Event: {ev}")), "{c}");
            assert!(c.contains("X-Deck-Transcript:"), "{c}");
            assert!(c.contains("transcript_path"), "{c}");
        }
    }

    // Путь Grok-хуков — глобальный ~/.grok/hooks/deck-status.json (всегда доверенный, не клоббер чужих).
    #[test]
    fn grok_hooks_path_is_global_deck_file() {
        let p = grok_hooks_path();
        assert!(p.ends_with("hooks/deck-status.json"), "ожидался hooks/deck-status.json: {p:?}");
        assert!(p.to_string_lossy().contains(".grok"), "путь должен быть под .grok: {p:?}");
    }
}
