// Живое дерево файлов (Путь A — наблюдатель ядра).
// Следим за открытой папкой воркспейса: при создании/удалении/переименовании файла
// (в т.ч. когда агент САМ создал файл, или ты бросил файл в папку) шлём в интерфейс
// событие `fs:changed` — и дерево обновляется само, без ручного перечитывания.
// Всплеск изменений коалесцируется (дебаунс 300мс), чтобы не дёргать дерево по 100 раз.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// Текущий наблюдатель живёт здесь. Замена (смена папки) роняет старый → его поток-дебаунсер
// получает ошибку канала и выходит. Один активный наблюдатель за раз (активная папка).
static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);
// За какой папкой следим сейчас — чтобы повторный вызов на ту же папку был холостым.
static WATCHED: Mutex<Option<String>> = Mutex::new(None);

// Начать следить за папкой (рекурсивно). Повторный вызов на ту же папку — без эффекта.
#[tauri::command]
pub fn fs_watch(app: AppHandle, path: String) {
    {
        let cur = WATCHED.lock().unwrap();
        if cur.as_deref() == Some(path.as_str()) {
            return;
        }
    }
    start(app, path);
}

// Перестать следить (напр. закрыли папку воркспейса).
#[tauri::command]
pub fn fs_unwatch() {
    *WATCHER.lock().unwrap() = None;
    *WATCHED.lock().unwrap() = None;
    crate::tracker::clear_all(); // освобождаем снимки папок (RFC 0011 A1)
}

fn start(app: AppHandle, path: String) {
    let (tx, rx) = channel::<()>();
    let mut watcher: RecommendedWatcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                // только реальные изменения содержимого папки (создание/изменение/удаление)
                if matches!(ev.kind, EventKind::Access(_) | EventKind::Other) {
                    return;
                }
                // шум сборок/гита (node_modules, .git) — игнор, чтобы не дёргать дерево зря
                let noisy = !ev.paths.is_empty()
                    && ev.paths.iter().all(|p| {
                        let s = p.to_string_lossy();
                        s.contains("/.git/") || s.contains("/node_modules/")
                    });
                if noisy {
                    return;
                }
                let _ = tx.send(());
            }
        }) {
            Ok(w) => w,
            Err(_) => return,
        };
    if watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .is_err()
    {
        return;
    }
    *WATCHER.lock().unwrap() = Some(watcher);
    *WATCHED.lock().unwrap() = Some(path.clone());

    // RFC 0011 A1: для не-git папки заранее строим снимок «было» (фоновым потоком,
    // чтобы не блокировать вызов слежки). git-папка → снимок не нужен (работает git).
    {
        let bpath = path.clone();
        std::thread::spawn(move || {
            if crate::gitops::is_repo(&bpath) {
                crate::tracker::drop_baseline(&bpath);
            } else {
                crate::tracker::prime(&bpath);
            }
        });
    }

    // Дебаунс: ждём первое событие, затем копим всплеск (тишина 300мс) → один сигнал в интерфейс.
    std::thread::spawn(move || loop {
        if rx.recv().is_err() {
            break; // наблюдатель уничтожен (сменили/закрыли папку) → выходим
        }
        loop {
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(_) => continue, // ещё изменения — продолжаем копить
                Err(RecvTimeoutError::Timeout) => break, // тишина → пора слать
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let _ = app.emit("fs:changed", json!({ "root": path }));
    });
}
