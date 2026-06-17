use serde::{Deserialize, Serialize};

// Все структуры сериализуются в camelCase, чтобы совпадать с типами фронтенда.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub custom: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetPanel {
    pub agent_id: String,
    #[serde(default)]
    pub clone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePreset {
    pub id: String,
    pub name: String,
    pub layout: String,
    #[serde(default)]
    pub panels: Vec<PresetPanel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    pub title: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    // RFC 0007: нативный resume-id агента (Claude = sessionId = имя файла транскрипта). Захватывается
    // из хука по ходу сессии; при восстановлении на старте → точный `claude --resume <id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_id: Option<String>,
    // C3 (аудит 2026-06-17): полный путь к файлу транскрипта Claude, захваченный из хука вместе с
    // resume_id. backend-owned (как resume_id). Хранение пути убирает TOCTOU-скан всех проектов:
    // при восстановлении проверяем, что именно ЭТОТ файл на месте и читается, прямо перед запуском.
    // Старые сессии без пути → fallback на скан по resume_id (claude_resume_valid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub alive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_args: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub folder: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    pub layout: String,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_cols: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_true")]
    pub sound_on_done: bool,
    #[serde(default = "default_true")]
    pub notify_on_done: bool,
    #[serde(default = "default_shell")]
    pub default_shell: String,
    // RFC 0012 (watchdog): мягкий лимит числа «своих веток», порог предупреждения по диску (ГБ),
    // порог детекта зацикливания (сек активного повтора вывода).
    #[serde(default = "default_worktree_limit")]
    pub worktree_limit: u32,
    #[serde(default = "default_disk_warn_gb")]
    pub worktree_disk_warn_gb: u32,
    #[serde(default = "default_stall_seconds")]
    pub stall_seconds: u32,
    // RFC 0015: «режим доверия» CLI для Deck-сессий — подставляется нативным флагом запуска.
    // Пусто = не передаём флаг (нативный дефолт CLI). Claude: --permission-mode; Codex: -a/-s.
    #[serde(default)]
    pub claude_permission_mode: String,
    #[serde(default)]
    pub codex_approval: String,
    #[serde(default)]
    pub codex_sandbox: String,
}

fn default_true() -> bool {
    true
}
fn default_shell() -> String {
    "/bin/zsh".to_string()
}
fn default_worktree_limit() -> u32 {
    10
}
fn default_disk_warn_gb() -> u32 {
    5
}
fn default_stall_seconds() -> u32 {
    25
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            sound_on_done: true,
            notify_on_done: true,
            default_shell: default_shell(),
            worktree_limit: default_worktree_limit(),
            worktree_disk_warn_gb: default_disk_warn_gb(),
            stall_seconds: default_stall_seconds(),
            claude_permission_mode: String::new(),
            codex_approval: String::new(),
            codex_sandbox: String::new(),
        }
    }
}

// RFC 0016 — задача беклога. Копится в пульте, кнопкой «В работу» уезжает первым
// промтом в новую сессию агента. Скрины храним путями к файлам (см. save_image_bytes),
// а не base64, чтобы не раздувать стейт. kind: bug|idea|feature; status: draft|sent|done.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklogTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub kind: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    pub status: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistState {
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub sessions: Vec<Session>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub custom_agents: Vec<CustomAgent>,
    #[serde(default)]
    pub presets: Vec<WorkspacePreset>,
    // RFC 0016 — беклог задач (frontend-owned, как остальной стейт).
    #[serde(default)]
    pub tasks: Vec<BacklogTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionInput {
    pub workspace_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub clone: bool,
    #[serde(default)]
    pub first_prompt: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub extra_args: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

// Тронутый агентом файл (для списка «Изменения»). status:
// modified/added/deleted/renamed/untracked. staged — есть ли в индексе git.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

// Пара текстов «было → стало» для Monaco DiffEditor (поля станут oldText/newText).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPair {
    pub old_text: String,
    pub new_text: String,
    pub status: String,
}

// RFC 0013 — кандидат на перенос (merge-back) из ветки агента в основное дерево.
// whole_only = переносится только целиком (удаление/переименование/бинарь/большой/новый),
// без выбора отдельных кусков-ханков. (Подключается в Фазе 2 — IPC.)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCandidate {
    pub path: String,
    pub status: String,
    pub whole_only: bool,
}

// RFC 0013 — результат проверки/применения переноса. conflicts непустой ⇒ применять
// нельзя, основное дерево не тронуто. backup_sha — точка отката (есть только после apply).
// (Подключается в Фазе 2 — IPC.)
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub ok: bool,
    pub applied_files: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_sha: Option<String>,
    pub conflicts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
