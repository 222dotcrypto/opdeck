use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const BUFFER_CAP: usize = 250_000;
// тишина дольше этого → «закончила». Больше 500мс, чтобы пауза агента в середине работы
// (раздумье/вызов инструмента) не считалась завершением (ложные «закончила»).
const IDLE_MS: u64 = 2000;
// RFC 0012 (watchdog): агент активно сыплет вывод, но хвост не меняется дольше этого →
// зацикливание (мягкий сигнал pty:stalled, без авто-kill). Дефолт = Settings.stall_seconds.
const STALL_SECS: u64 = 25;

// Быстрый хеш строки (для детекта «вывод не меняется»).
fn hash_str(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// «Осмысленный» вывод — это реальный текст, а не управляющие последовательности
// (мигание курсора, перерисовка футера). Нужно, чтобы статус не дёргался.
// Вырезаем ANSI-escape и считаем видимые символы.
fn is_meaningful(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut visible = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            // escape-последовательность: пропускаем до буквы-терминатора
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
                    i += 1;
                }
            }
            i += 1;
            continue;
        }
        if b == b'\n' || b == b'\r' || b == b'\t' || (b >= 0x20 && b != 0x7f) {
            // считаем переносы/табы и любой видимый символ (в т.ч. UTF-8 спиннеры)
            if b != b' ' {
                visible += 1;
                if visible > 1 {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

// Одна живая сессия-терминал.
struct Live {
    writer: SharedWriter,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    buffer: Arc<Mutex<String>>,
    status: Arc<Mutex<String>>,
    last_data: Arc<Mutex<Instant>>,
    last_resize: Arc<Mutex<Instant>>,
    running: Arc<AtomicBool>,
    // отслеживание статуса начинается только с ПЕРВОГО промта пользователя
    // (первый ввод в терминал или авто-firstPrompt). До этого сессия серая (idle).
    tracking: Arc<AtomicBool>,
    // RFC 0003: пришёл хук агента → он авторитетнее эвристики (эвристика отступает).
    hook_active: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Live>>,
    // Ввод, пришедший ДО запуска PTY (открытие сессии из «Сводки»/сайдбара + ранний набор).
    // Копим тут и сливаем сразу после spawn — иначе первые символы теряются (writer=None).
    pending_input: Mutex<HashMap<String, String>>,
}

// Похоже ли, что агент ждёт ответа/разрешения (по хвосту вывода). Консервативно —
// только явные приглашения, чтобы не путать с обычным «закончил».
fn looks_awaiting(tail: &str) -> bool {
    // Только ОЧЕНЬ явные приглашения к ответу — чтобы обычный вывод не загорался жёлтым.
    let t = tail.to_lowercase();
    t.contains("(y/n)")
        || t.contains("[y/n]")
        || t.contains("(yes/no)")
        || t.contains("do you want to proceed")
        || t.contains("❯ 1. yes")
}

// Похоже ли, что агент СЕЙЧАС работает, хотя ход формально закончен (хук `Stop`): уступил
// ход фоновой задаче, но она ещё крутится. Сообщение «Waiting for N … workflow to finish»
// держится внизу вывода, пока воркфлоу идёт → это «работает» (синий), а не «готов» (зелёный).
fn looks_working(tail: &str) -> bool {
    tail.to_lowercase().contains("workflow to finish")
}

// Что за CLI запущен ВНУТРИ шелл-сессии: смотрим дочерние процессы шелла и матчим имя
// по командной строке (args надёжнее comm — node-обёртка claude всё равно содержит «claude»).
// Возвращает (agent_id, отображаемое имя) — совпадают с BUILTINS (agents.rs).
fn detect_child_cli(shell_pid: u32) -> Option<(&'static str, &'static str)> {
    const KNOWN: [(&str, &str, &str); 6] = [
        ("claude", "claude", "Claude Code"),
        ("codex", "codex", "Codex"),
        ("gemini", "gemini", "Gemini"),
        ("qwen", "qwen", "Qwen"),
        ("grok", "grok", "Grok"),
        ("opencode", "opencode", "opencode"),
    ];
    let out = std::process::Command::new("/usr/bin/pgrep")
        .arg("-P")
        .arg(shell_pid.to_string())
        .output()
        .ok()?;
    for kid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        if let Ok(a) = std::process::Command::new("/bin/ps")
            .arg("-o")
            .arg("args=")
            .arg("-p")
            .arg(kid)
            .output()
        {
            // Имя бинарника = basename первого токена args, без пути и расширения (.exe),
            // СТРОГО равно имени CLI. Так `vim claude.md` / `cat codex.txt` / `git log claude`
            // не считаются за CLI (ловит только реально запущенный бинарь claude/codex/…).
            let raw = String::from_utf8_lossy(&a.stdout);
            let first = raw.split_whitespace().next().unwrap_or("");
            let bin = first.rsplit('/').next().unwrap_or(first).to_lowercase();
            let stem = bin.split('.').next().unwrap_or(&bin);
            for (needle, agent_id, name) in KNOWN {
                if stem == needle {
                    return Some((agent_id, name));
                }
            }
        }
    }
    None
}

// Меняем статус и шлём событие только при реальном изменении.
fn set_status(app: &AppHandle, id: &str, status: &Arc<Mutex<String>>, next: &str) {
    let mut s = status.lock().unwrap();
    if *s != next {
        *s = next.to_string();
        let _ = app.emit("pty:status", json!({ "sessionId": id, "status": next }));
    }
}

impl PtyManager {
    pub fn is_alive(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }

    pub fn buffer(&self, id: &str) -> String {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|l| l.buffer.lock().unwrap().clone())
            .unwrap_or_default()
    }

    // RFC 0003: статус пришёл от хука агента (авторитетно). Включаем hook_active —
    // эвристические потоки больше не трогают статус этой сессии.
    pub fn apply_hook_status(&self, app: &AppHandle, id: &str, status: &str) {
        let changed: Option<String> = {
            let map = self.sessions.lock().unwrap();
            match map.get(id) {
                // до ПЕРВОГО промта пользователя статус НЕ трогаем (сессия серая):
                // хуки старта Claude (баннер/инициализация) игнорируем, пока юзер не ввёл.
                Some(live) if live.tracking.load(Ordering::SeqCst) => {
                    live.hook_active.store(true, Ordering::SeqCst);
                    // «ready» (ход закончен), но в выводе виден активный фоновый воркфлоу →
                    // это «работает» (синий), а не «готов» (зелёный).
                    let effective = if status == "ready" {
                        let tail: String = {
                            let b = live.buffer.lock().unwrap();
                            let v: Vec<char> = b.chars().rev().take(800).collect();
                            v.into_iter().rev().collect()
                        };
                        if looks_working(&tail) {
                            "working"
                        } else {
                            status
                        }
                    } else {
                        status
                    };
                    let mut s = live.status.lock().unwrap();
                    if *s != effective {
                        *s = effective.to_string();
                        Some(effective.to_string())
                    } else {
                        None
                    }
                }
                _ => None,
            }
        };
        if let Some(eff) = changed {
            let _ = app.emit("pty:status", json!({ "sessionId": id, "status": eff }));
            crate::hooks::notify_status(app, id, &eff);
            self.update_badge(app);
        }
    }

    // Бейдж на иконке дока = число сессий, требующих внимания (ждут ответа / ошибка).
    fn update_badge(&self, app: &AppHandle) {
        let n = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|l| {
                let s = l.status.lock().unwrap();
                *s == "awaiting" || *s == "error"
            })
            .count() as i64;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_badge_count(if n > 0 { Some(n) } else { None });
        }
    }

    // Реальное нажатие клавиши пользователем = его первый промт начался → включаем
    // отслеживание статуса. ВАЖНО: не на любой ввод в PTY — терминал (xterm) сам
    // отвечает на запросы агента (Device Attributes и т.п.) на старте, это НЕ ввод юзера.
    pub fn mark_user_typed(&self, app: &AppHandle, id: &str) {
        // Включаем отслеживание (первый промт начался) И оптимистично красим в синий:
        // пользователь ответил → сразу «работает», не дожидаясь хука агента
        // (UserPromptSubmit/PreToolUse). Хук затем подтвердит/скорректирует. Без этого
        // жёлтый «ждёт» висит до round-trip хука — заметный лаг сразу после ответа.
        // Иерархия мьютексов: sessions → status → last_data (берём строго в этом порядке,
        // как и apply_hook_status/update_badge). update_badge зовём ПОСЛЕ release sessions.
        let became_working = {
            let map = self.sessions.lock().unwrap();
            match map.get(id) {
                Some(live) => {
                    live.tracking.store(true, Ordering::SeqCst);
                    let mut s = live.status.lock().unwrap();
                    // только из «ответных» состояний агента: жёлтый «ждёт» или зелёный
                    // «закончил» → синий «работает». «idle» (серый shell без агента) НЕ трогаем,
                    // чтобы тихая shell-команда не мигала синим; working/error тоже не трогаем.
                    if *s == "awaiting" || *s == "ready" {
                        *s = "working".to_string();
                        // сдвигаем точку отсчёта простоя, чтобы idle-вотчер не сбросил мгновенно
                        *live.last_data.lock().unwrap() = Instant::now();
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if became_working {
            let _ = app.emit("pty:status", json!({ "sessionId": id, "status": "working" }));
            self.update_badge(app);
        }
    }

    pub fn write(&self, id: &str, data: &str) {
        let writer = self.sessions.lock().unwrap().get(id).map(|l| l.writer.clone());
        if let Some(w) = writer {
            let mut w = w.lock().unwrap();
            let _ = w.write_all(data.as_bytes());
            let _ = w.flush();
        } else {
            // PTY ещё не запущен — копим ввод, сольём сразу после spawn
            self.pending_input
                .lock()
                .unwrap()
                .entry(id.to_string())
                .or_default()
                .push_str(data);
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        if let Some(live) = self.sessions.lock().unwrap().get(id) {
            // отметка времени ресайза: перерисовку агента после неё не считаем «работой»
            *live.last_resize.lock().unwrap() = Instant::now();
            let _ = live.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn kill(&self, id: &str) {
        self.pending_input.lock().unwrap().remove(id);
        if let Some(live) = self.sessions.lock().unwrap().remove(id) {
            live.running.store(false, Ordering::SeqCst);
            let _ = live.child.lock().unwrap().kill();
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }

    // Запуск нового PTY. command_line=None → просто оболочка.
    pub fn spawn(
        &self,
        app: &AppHandle,
        session_id: &str,
        command_line: Option<String>,
        cwd: &str,
        first_prompt: Option<String>,
        shell_override: Option<String>,
    ) -> Result<(), String> {
        if self.is_alive(session_id) {
            return Ok(());
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        // оболочка: явный выбор пользователя (zsh/bash/…) или системная по умолчанию
        let shell = shell_override
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()));
        let mut cmd = CommandBuilder::new(&shell);
        match &command_line {
            None => {
                cmd.arg("-l");
            }
            Some(cl) => {
                cmd.arg("-lic");
                cmd.arg(format!("exec {}", cl));
            }
        }
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("DECK_SESSION_ID", session_id);
        // RFC 0003: координаты приёмника хуков (агент шлёт сюда лайфсайкл-события)
        if let Some((port, token)) = crate::hooks::hook_port_token() {
            cmd.env("DECK_HOOK_PORT", port.to_string());
            cmd.env("DECK_HOOK_TOKEN", token);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        // шелл-сессия (split «пустой терминал») — следим, какой CLI в ней запустят
        let is_shell = command_line.is_none();
        let shell_pid = child.process_id();

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer: SharedWriter =
            Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));

        let buffer = Arc::new(Mutex::new(String::new()));
        // стартуем как «idle» (просто открыта, без цвета). «working» — только при реальном
        // потоке вывода, «ready/awaiting» — только ПОСЛЕ работы.
        let status = Arc::new(Mutex::new("idle".to_string()));
        let last_data = Arc::new(Mutex::new(Instant::now()));
        let last_resize = Arc::new(Mutex::new(Instant::now()));
        let running = Arc::new(AtomicBool::new(true));
        let tracking = Arc::new(AtomicBool::new(false));
        let hook_active = Arc::new(AtomicBool::new(false));
        let cli_detected = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(child));

        let live = Live {
            writer: writer.clone(),
            master: pair.master,
            child: child.clone(),
            buffer: buffer.clone(),
            status: status.clone(),
            last_data: last_data.clone(),
            last_resize: last_resize.clone(),
            running: running.clone(),
            tracking: tracking.clone(),
            hook_active: hook_active.clone(),
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), live);
        // слить ввод, накопленный до старта (ранний набор при открытии из «Сводки»)
        if let Some(early) = self.pending_input.lock().unwrap().remove(session_id) {
            if !early.is_empty() {
                if let Ok(mut w) = writer.lock() {
                    let _ = w.write_all(early.as_bytes());
                    let _ = w.flush();
                }
            }
        }
        let _ = app.emit("pty:status", json!({ "sessionId": session_id, "status": "idle" }));

        // ── Поток чтения вывода ──
        {
            let app = app.clone();
            let id = session_id.to_string();
            let buffer = buffer.clone();
            let status = status.clone();
            let last_data = last_data.clone();
            let last_resize = last_resize.clone();
            let running = running.clone();
            let child = child.clone();
            let tracking = tracking.clone();
            let hook_active = hook_active.clone();
            thread::spawn(move || {
                let mut carry: Vec<u8> = Vec::new();
                let mut buf = [0u8; 8192];
                // burst-детекция: «работает» только при серии быстрого вывода (реальный
                // поток ответа). Одиночная перерисовка (фокус, футер TUI) — не работа.
                let mut last_meaningful = Instant::now();
                let mut burst: u32 = 0;
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            carry.extend_from_slice(&buf[..n]);
                            // эмитим только валидную UTF-8 часть, остаток несём дальше
                            let text = match std::str::from_utf8(&carry) {
                                Ok(s) => {
                                    let t = s.to_string();
                                    carry.clear();
                                    t
                                }
                                Err(e) => {
                                    let valid = e.valid_up_to();
                                    let t =
                                        String::from_utf8_lossy(&carry[..valid]).to_string();
                                    carry.drain(..valid);
                                    t
                                }
                            };
                            if text.is_empty() {
                                continue;
                            }
                            {
                                let mut b = buffer.lock().unwrap();
                                b.push_str(&text);
                                if b.len() > BUFFER_CAP {
                                    let mut cut = b.len() - BUFFER_CAP;
                                    while !b.is_char_boundary(cut) {
                                        cut += 1;
                                    }
                                    // удаляем начало на месте (без перевыделения всей строки)
                                    b.drain(..cut);
                                }
                            }
                            // вывод в терминал — всегда
                            let _ = app.emit("pty:data", json!({ "sessionId": id, "data": text }));
                            // статус «работает» — только при серии (≥2) осмысленных порций
                            // подряд (реальный поток). Одиночная перерисовка не считается.
                            if is_meaningful(&text) {
                                let now = Instant::now();
                                // перерисовку сразу после ресайза не считаем работой
                                let after_resize =
                                    now.duration_since(*last_resize.lock().unwrap())
                                        < Duration::from_millis(450);
                                if now.duration_since(last_meaningful) < Duration::from_millis(350) {
                                    burst += 1;
                                } else {
                                    burst = 1;
                                }
                                last_meaningful = now;
                                // «работает» — только ПОСЛЕ первого промта пользователя
                                // (tracking). До этого вывод агента (баннер/приветствие) идёт
                                // в терминал, но рамка остаётся серой (idle).
                                if burst >= 2
                                    && !after_resize
                                    && tracking.load(Ordering::SeqCst)
                                    && !hook_active.load(Ordering::SeqCst)
                                {
                                    *last_data.lock().unwrap() = now;
                                    set_status(&app, &id, &status, "working");
                                }
                            }
                        }
                    }
                }
                // процесс завершился
                running.store(false, Ordering::SeqCst);
                let code = child
                    .lock()
                    .unwrap()
                    .wait()
                    .map(|s| s.exit_code() as i32)
                    .unwrap_or(1);
                let _ = app.emit("pty:exit", json!({ "sessionId": id, "code": code }));
                set_status(&app, &id, &status, if code == 0 { "idle" } else { "error" });
                let mgr = app.state::<PtyManager>();
                mgr.sessions.lock().unwrap().remove(&id);
            });
        }

        // ── Поток отслеживания простоя (серый «ждёт» idle + первый промт) ──
        {
            let app = app.clone();
            let id = session_id.to_string();
            let status = status.clone();
            let last_data = last_data.clone();
            let running = running.clone();
            let first_prompt = first_prompt.clone();
            let writer = writer.clone();
            let buffer = buffer.clone();
            let tracking = tracking.clone();
            let hook_active = hook_active.clone();
            let cli_detected = cli_detected.clone();
            thread::spawn(move || {
                let mut prompt_sent = false;
                // троттл авто-определения CLI в шелле (раз в ~1.5с, чтобы не спамить pgrep/ps)
                let mut last_detect = Instant::now() - Duration::from_secs(2);
                // RFC 0012 watchdog: детект зацикливания (хвост-хеш + момент последнего изменения)
                let mut last_tail_hash: u64 = 0;
                let mut tail_since = Instant::now();
                let mut stalled_emitted = false;
                loop {
                    // Адаптивный сон. Часто (120 мс) просыпаемся ТОЛЬКО когда есть что ловить:
                    //   • эвристический агент сейчас «работает» → ждём перехода в «закончила»;
                    //   • ещё не отправлен авто-первый-промт.
                    // В тишине (статус не «работает» / статусом рулит хук агента) спим по 1 с.
                    // Это убирает ~8 холостых пробуждений/сек на КАЖДУЮ сессию — главную причину
                    // «высокого энергопотребления» в macOS (процессор не мог уйти в App Nap).
                    // Синий цвет «работает» ставит поток-читатель сразу, не этот цикл, поэтому
                    // редкий сон в покое ничего визуально не замедляет.
                    let watch_closely = {
                        let working = *status.lock().unwrap() == "working";
                        let need_prompt = !prompt_sent && first_prompt.is_some();
                        (working && !hook_active.load(Ordering::SeqCst)) || need_prompt
                    };
                    thread::sleep(Duration::from_millis(if watch_closely { 120 } else { 1000 }));
                    if !running.load(Ordering::SeqCst) {
                        break;
                    }
                    // Авто-определение CLI, запущенного в шелл-сессии (split «пустой терминал»):
                    // по дочернему процессу шелла. Раз определили — больше не проверяем.
                    if is_shell
                        && !cli_detected.load(Ordering::SeqCst)
                        && last_detect.elapsed() > Duration::from_millis(1500)
                    {
                        last_detect = Instant::now();
                        if let Some(pid) = shell_pid {
                            if let Some((agent_id, name)) = detect_child_cli(pid) {
                                cli_detected.store(true, Ordering::SeqCst);
                                let _ = app.emit(
                                    "session:cli-detected",
                                    json!({ "sessionId": id, "agentId": agent_id, "name": name }),
                                );
                            }
                        }
                    }
                    // RFC 0012: детект зацикливания. Жива + активно сыплет вывод (last_data свежий),
                    // но хвост буфера не меняется дольше STALL_SECS → агент крутит одно и то же.
                    // Мягкий сигнал (pty:stalled), БЕЗ авто-kill — человек решает (кнопка ↻).
                    {
                        let producing = last_data.lock().unwrap().elapsed() < Duration::from_secs(5);
                        let is_working = *status.lock().unwrap() == "working";
                        if producing && is_working {
                            let tail: String = {
                                let b = buffer.lock().unwrap();
                                let v: Vec<char> = b.chars().rev().take(800).collect();
                                v.into_iter().rev().collect()
                            };
                            let h = hash_str(&tail);
                            if h != last_tail_hash {
                                last_tail_hash = h;
                                tail_since = Instant::now();
                                if stalled_emitted {
                                    stalled_emitted = false;
                                    let _ = app.emit("pty:stalled", json!({ "sessionId": id, "stalled": false }));
                                }
                            } else if !stalled_emitted && tail_since.elapsed() > Duration::from_secs(STALL_SECS) {
                                stalled_emitted = true;
                                let _ = app.emit("pty:stalled", json!({ "sessionId": id, "stalled": true }));
                            }
                        } else if stalled_emitted {
                            // перестал работать/сыпать → снимаем флаг застревания
                            stalled_emitted = false;
                            tail_since = Instant::now();
                            let _ = app.emit("pty:stalled", json!({ "sessionId": id, "stalled": false }));
                        }
                    }
                    let elapsed = last_data.lock().unwrap().elapsed();
                    if elapsed > Duration::from_millis(IDLE_MS) {
                        // Тишина после работы. «ждёт ответа» (awaiting) — только при явном
                        // (y/n)-промте. Иначе СЕРЫЙ «ждёт» (idle), а НЕ зелёный «закончила»:
                        // тишина неотличима от «агент запустил фоновую задачу и ждёт» (ультракод/
                        // воркфлоу) — давало ложное «готово» и мерцание зелёный↔синий. Зелёный
                        // «ready» теперь ставит ТОЛЬКО хук агента (apply_hook_status) — авторитетно.
                        let was_working = { *status.lock().unwrap() == "working" };
                        // если статусом управляет хук агента — эвристика молчит
                        if was_working && !hook_active.load(Ordering::SeqCst) {
                            let tail: String = {
                                let b = buffer.lock().unwrap();
                                let v: Vec<char> = b.chars().rev().take(800).collect();
                                v.into_iter().rev().collect()
                            };
                            let next = if looks_working(&tail) {
                                "working"
                            } else if looks_awaiting(&tail) {
                                "awaiting"
                            } else {
                                "idle"
                            };
                            set_status(&app, &id, &status, next);
                        }
                        if !prompt_sent {
                            if let Some(p) = &first_prompt {
                                // авто-первый-промт = первый промт пользователя → включаем отслеживание
                                tracking.store(true, Ordering::SeqCst);
                                // Текст и Enter — ОТДЕЛЬНЫМИ кусками. codex (и любой TUI с детектором
                                // пакетной вставки paste-burst) принимает пачку «текст+\r», пришедшую
                                // одним write, за вставку → \r становится переносом строки, а не
                                // отправкой (промт виден в поле ввода, но не уходит). Пишем текст,
                                // отпускаем лок и ждём, чтобы бурст-окно закрылось, затем шлём \r
                                // отдельно → codex видит настоящий Enter и отправляет. Для Claude/шелла
                                // \r всё равно = submit → безопасно для всех агентов. Лок НЕ держим во
                                // время сна, иначе на паузу блокировался бы ввод пользователя.
                                {
                                    let mut w = writer.lock().unwrap();
                                    let _ = w.write_all(p.as_bytes());
                                    let _ = w.flush();
                                }
                                thread::sleep(Duration::from_millis(150));
                                {
                                    let mut w = writer.lock().unwrap();
                                    let _ = w.write_all(b"\r");
                                    let _ = w.flush();
                                }
                            }
                            prompt_sent = true;
                        }
                    }
                }
            });
        }

        Ok(())
    }
}
