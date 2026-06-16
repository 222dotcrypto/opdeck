// Интеграция с GitHub через уже настроенный у пользователя `gh` (GitHub CLI).
// Свой OAuth не делаем — переиспользуем `gh auth`. Команды зовём через login-shell
// (`zsh -lc`), чтобы был полный PATH (gh в /opt/homebrew/bin, git и т.д.) и БЕЗ `-i`,
// иначе интерактивный .zshrc (neofetch) засорит вывод/JSON.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub installed: bool,
    pub authed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepo {
    pub name_with_owner: String,
    pub description: String,
    pub private: bool,
}

// Выполнить команду в login-shell (полный PATH, без интерактива → без neofetch).
fn sh(cmd: &str) -> Result<String, String> {
    let out = Command::new("/bin/zsh")
        .args(["-lc", cmd])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        Err(if err.trim().is_empty() {
            "команда завершилась с ошибкой".into()
        } else {
            err
        })
    }
}

// Экранирование аргумента для шелла (защита от инъекций в пользовательском вводе).
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn status() -> GithubStatus {
    let installed = sh("command -v gh")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if !installed {
        return GithubStatus { installed: false, authed: false, user: None };
    }
    match sh("gh api user --jq .login") {
        Ok(login) if !login.trim().is_empty() => GithubStatus {
            installed: true,
            authed: true,
            user: Some(login.trim().to_string()),
        },
        _ => GithubStatus { installed: true, authed: false, user: None },
    }
}

pub fn repos() -> Result<Vec<GithubRepo>, String> {
    let out = sh("gh repo list --limit 200 --json nameWithOwner,description,visibility")?;
    let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
    let arr = v.as_array().ok_or("ожидался JSON-массив репозиториев")?;
    Ok(arr
        .iter()
        .map(|r| GithubRepo {
            name_with_owner: r["nameWithOwner"].as_str().unwrap_or("").to_string(),
            description: r["description"].as_str().unwrap_or("").to_string(),
            private: r["visibility"].as_str().unwrap_or("") == "PRIVATE",
        })
        .filter(|r| !r.name_with_owner.is_empty())
        .collect())
}

// Клон репозитория в <dest_parent>/<имя-репо>. Возвращает путь склонированной папки.
pub fn clone(repo: &str, dest_parent: &str) -> Result<String, String> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err("не указан репозиторий".into());
    }
    // имя папки = последний сегмент без .git (работает для owner/name и для URL)
    let name = repo
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(repo)
        .trim_end_matches(".git");
    if name.is_empty() {
        return Err("не удалось определить имя репозитория".into());
    }
    let parent = if dest_parent.trim().is_empty() {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".into())
    } else {
        dest_parent.trim().to_string()
    };
    let target = format!("{}/{}", parent.trim_end_matches('/'), name);
    if std::path::Path::new(&target).exists() {
        return Err(format!("папка уже существует: {target}"));
    }
    // аргументы экранированы → инъекция через repo/target невозможна
    sh(&format!("gh repo clone {} {}", shq(repo), shq(&target)))?;
    Ok(target)
}
