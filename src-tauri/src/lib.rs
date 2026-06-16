mod agents;
mod commands;
mod fsops;
mod fswatch;
mod github;
mod gitops;
mod hooks;
mod pty;
mod state;
mod tracker;
mod types;
mod usage;

use commands::*;
use fswatch::{fs_unwatch, fs_watch};
use pty::PtyManager;
use state::StateStore;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        // Свой протокол для предпросмотра локального HTML: deck-preview://localhost/<реальный путь>.
        // В отличие от asset:// (кодирует весь путь как один %2F-кусок и ломает относительные
        // ссылки), здесь слэши настоящие → соседние css/js/jsx прототипа резолвятся.
        .register_uri_scheme_protocol("deck-preview", |_ctx, request| {
            let raw = request.uri().path().to_string();
            let path = urlencoding::decode(&raw)
                .map(|c| c.into_owned())
                .unwrap_or(raw);
            // защита от чтения произвольных путей: только внутри папок воркспейсов
            if !commands::path_allowed(&path) {
                return tauri::http::Response::builder()
                    .status(403)
                    .body(Vec::new())
                    .unwrap();
            }
            match std::fs::read(&path) {
                Ok(bytes) => tauri::http::Response::builder()
                    .header(tauri::http::header::CONTENT_TYPE, commands::mime_for(&path))
                    .header(tauri::http::header::CACHE_CONTROL, "no-store")
                    .body(bytes)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(|app| {
            // RFC 0003: приёмник хуков агентов + Deck-хуки статуса Claude (--settings),
            // Codex (-p deck оверлей) и Grok (глобальные ~/.grok/hooks/, Claude-формат)
            crate::hooks::start_receiver(app.handle().clone());
            crate::hooks::write_claude_hooks_file();
            crate::hooks::write_codex_hooks_file();
            crate::hooks::write_grok_hooks_file();
            // уведомления: запрос разрешения + слежение за фокусом окна (для подавления)
            {
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().request_permission();
            }
            if let Some(w) = app.get_webview_window("main") {
                let win = w.clone();
                w.on_window_event(move |e| match e {
                    tauri::WindowEvent::Focused(f) => {
                        crate::hooks::set_window_focused(*f);
                    }
                    // RFC 0007 (1A): крестик НЕ выключает Deck, а ПРЯЧЕТ окно — агенты (PTY)
                    // продолжают работать в фоне. Полный выход (агенты гаснут) — только ⌘Q /
                    // меню приложения → RunEvent::ExitRequested. Возврат окна — клик по иконке
                    // в доке (RunEvent::Reopen уже показывает окно).
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = win.hide();
                        crate::hooks::set_window_focused(false);
                    }
                    _ => {}
                });
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .manage({
            // посев разрешённых корней предпросмотра из сохранённых воркспейсов
            let store = StateStore::load();
            commands::set_allowed_roots(
                store.data.workspaces.iter().map(|w| w.folder.clone()).collect(),
            );
            Mutex::new(store)
        })
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            state_get,
            state_save,
            agents_list,
            fs_read_dir,
            fs_read_file,
            fs_read_file_data_url,
            fs_resolve,
            fs_watch,
            fs_unwatch,
            save_image_bytes,
            clipboard_file_paths,
            fs_write_file,
            fs_rename,
            fs_duplicate,
            fs_trash,
            fs_reveal,
            git_is_repo,
            git_worktrees,
            git_branch,
            git_status,
            git_diff_file,
            diff_folder_oversized,
            merge_apply_files,
            merge_undo,
            github_status,
            github_repos,
            github_clone,
            session_create,
            session_start,
            session_is_alive,
            session_set_active,
            session_user_typed,
            pty_write,
            pty_resize,
            pty_kill,
            pty_buffer,
            usage_snapshot,
            restart_session,
            kill_all_sessions,
            worktree_stats,
            remove_worktree,
            run_tests
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => {
            handle.state::<PtyManager>().kill_all();
        }
        // клик по иконке в доке / уведомлению → показать и сфокусировать окно
        tauri::RunEvent::Reopen { .. } => {
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        _ => {}
    });
}
