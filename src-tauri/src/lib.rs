use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf, process::Command, thread, time::Duration};

#[derive(Debug, Deserialize)]
struct LlmMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmRequest {
    provider: String,
    endpoint: String,
    model: String,
    api_key: String,
    temperature: f32,
    system_prompt: String,
    messages: Vec<LlmMessage>,
}

#[derive(Debug, Serialize)]
struct LlmResponse {
    content: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    current_version: String,
    latest_version: String,
    update_available: bool,
    release_url: String,
    release_name: String,
    published_at: String,
    installer_file_name: Option<String>,
    installer_size: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInstall {
    version: String,
    installer_path: String,
    installer_file_name: String,
}

#[tauri::command]
fn default_board_path(name: String) -> Result<String, String> {
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| "Could not resolve the user home directory".to_string())?;

    let safe_name = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            _ => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    let file_name = if safe_name.is_empty() {
        "Untitled Board".to_string()
    } else {
        safe_name
    };

    let path = PathBuf::from(home)
        .join("Documents")
        .join("Tldraw Boards")
        .join(format!("{file_name}.tldr.json"));

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn write_board_file(path: String, payload: serde_json::Value) -> Result<(), String> {
    let target = PathBuf::from(path);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let json = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(target, json).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_board_file(path: String) -> Result<serde_json::Value, String> {
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_board_file(path: String) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn normalize_version(version: &str) -> Vec<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split(['.', '-'])
        .take(3)
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .chain(std::iter::repeat(0))
        .take(3)
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    normalize_version(latest) > normalize_version(current)
}

async fn fetch_latest_release() -> Result<GithubRelease, String> {
    let client = reqwest::Client::new();
    let release = client
        .get("https://api.github.com/repos/arvirotechsolutions/Tldraw/releases/latest")
        .header("User-Agent", "Tldraw update checker")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = release.status();
    let body = release.text().await.map_err(|error| error.to_string())?;

    if !status.is_success() {
        return Err(format!("GitHub returned {status}: {body}"));
    }

    serde_json::from_str::<GithubRelease>(&body).map_err(|error| error.to_string())
}

fn installer_asset_score(name: &str) -> Option<i32> {
    let lower_name = name.to_lowercase();

    if lower_name.ends_with(".sig")
        || lower_name.ends_with(".sha256")
        || lower_name.ends_with(".blockmap")
        || lower_name.ends_with(".json")
    {
        return None;
    }

    let mut score = if cfg!(target_os = "windows") {
        if lower_name.ends_with(".msi") {
            100
        } else if lower_name.ends_with(".exe") {
            90
        } else {
            return None;
        }
    } else if cfg!(target_os = "macos") {
        if lower_name.ends_with(".dmg") {
            100
        } else {
            return None;
        }
    } else if cfg!(target_os = "linux") {
        if lower_name.ends_with(".appimage") {
            100
        } else if lower_name.ends_with(".deb") {
            90
        } else if lower_name.ends_with(".rpm") {
            80
        } else {
            return None;
        }
    } else {
        return None;
    };

    if lower_name.contains("x64")
        || lower_name.contains("x86_64")
        || lower_name.contains("amd64")
        || lower_name.contains("win64")
    {
        score += 10;
    }

    Some(score)
}

fn select_installer_asset(release: &GithubRelease) -> Option<&GithubAsset> {
    release
        .assets
        .iter()
        .filter_map(|asset| installer_asset_score(&asset.name).map(|score| (score, asset)))
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset)
}

fn safe_download_file_name(name: &str) -> String {
    let safe_name = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            _ => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if safe_name.is_empty() {
        "Tldraw-installer".to_string()
    } else {
        safe_name
    }
}

fn launch_installer(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("msi"))
        {
            Command::new("msiexec")
                .arg("/i")
                .arg(path)
                .spawn()
                .map_err(|error| error.to_string())?;
        } else {
            Command::new(path)
                .spawn()
                .map_err(|error| error.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
async fn check_for_updates() -> Result<UpdateCheck, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let release = fetch_latest_release().await?;
    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let installer_asset =
        select_installer_asset(&release).map(|asset| (asset.name.clone(), asset.size));

    Ok(UpdateCheck {
        update_available: is_newer_version(&latest_version, &current_version),
        release_name: release
            .name
            .unwrap_or_else(|| format!("Tldraw {}", release.tag_name)),
        release_url: release.html_url,
        published_at: release.published_at.unwrap_or_default(),
        installer_file_name: installer_asset
            .as_ref()
            .map(|(asset_name, _)| asset_name.clone()),
        installer_size: installer_asset.map(|(_, asset_size)| asset_size),
        latest_version,
        current_version,
    })
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<UpdateInstall, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let release = fetch_latest_release().await?;
    let latest_version = release.tag_name.trim_start_matches('v').to_string();

    if !is_newer_version(&latest_version, &current_version) {
        return Err("Tldraw is already up to date".to_string());
    }

    let installer_asset = select_installer_asset(&release)
        .ok_or_else(|| "No installer asset was found for this platform".to_string())?;
    let file_name = safe_download_file_name(&installer_asset.name);
    let target_dir = env::temp_dir().join("Tldraw-Updater");
    fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
    let installer_path = target_dir.join(&file_name);

    let client = reqwest::Client::new();
    let response = client
        .get(&installer_asset.browser_download_url)
        .header("User-Agent", "Tldraw update installer")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Installer download returned {status}: {body}"));
    }

    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    fs::write(&installer_path, bytes).map_err(|error| error.to_string())?;
    launch_installer(&installer_path)?;

    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(750));
        app_handle.exit(0);
    });

    Ok(UpdateInstall {
        version: latest_version,
        installer_path: installer_path.to_string_lossy().to_string(),
        installer_file_name: file_name,
    })
}

fn join_endpoint(endpoint: &str, path: &str) -> String {
    format!(
        "{}/{}",
        endpoint.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn extract_text(value: &Value, provider: &str) -> Result<String, String> {
    let provider = provider.to_lowercase();

    if provider.contains("gemini") {
        return value["candidates"][0]["content"]["parts"]
            .as_array()
            .and_then(|parts| parts.iter().find_map(|part| part["text"].as_str()))
            .map(|text| text.to_string())
            .ok_or_else(|| format!("Gemini response did not include text: {value}"));
    }

    if provider.contains("claude") || provider.contains("anthropic") {
        return value["content"]
            .as_array()
            .and_then(|content| content.iter().find_map(|part| part["text"].as_str()))
            .map(|text| text.to_string())
            .ok_or_else(|| format!("Claude response did not include text: {value}"));
    }

    value["choices"][0]["message"]["content"]
        .as_str()
        .map(|text| text.to_string())
        .ok_or_else(|| format!("OpenAI-compatible response did not include text: {value}"))
}

#[tauri::command]
async fn call_llm(request: LlmRequest) -> Result<LlmResponse, String> {
    if request.endpoint.trim().is_empty() {
        return Err("Endpoint URL is required".to_string());
    }

    if request.model.trim().is_empty() {
        return Err("Model name is required".to_string());
    }

    let provider = request.provider.to_lowercase();
    let client = reqwest::Client::new();

    let response = if provider.contains("gemini") {
        let mut endpoint = request.endpoint.trim().to_string();
        if !endpoint.contains(":generateContent") {
            endpoint = join_endpoint(
                &endpoint,
                &format!("models/{}:generateContent", request.model.trim()),
            );
        }
        if !request.api_key.trim().is_empty() && !endpoint.contains("key=") {
            endpoint = format!(
                "{}{}key={}",
                endpoint,
                if endpoint.contains('?') { "&" } else { "?" },
                request.api_key.trim()
            );
        }

        let contents = request
            .messages
            .iter()
            .map(|message| {
                json!({
                    "role": if message.role == "assistant" { "model" } else { "user" },
                    "parts": [{ "text": message.content }]
                })
            })
            .collect::<Vec<_>>();

        client
            .post(endpoint)
            .json(&json!({
                "systemInstruction": { "parts": [{ "text": request.system_prompt }] },
                "contents": contents,
                "generationConfig": { "temperature": request.temperature }
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?
    } else if provider.contains("claude") || provider.contains("anthropic") {
        let endpoint = if request.endpoint.contains("/messages") {
            request.endpoint.trim().to_string()
        } else {
            join_endpoint(&request.endpoint, "messages")
        };

        let messages = request
            .messages
            .iter()
            .map(|message| {
                json!({
                    "role": if message.role == "assistant" { "assistant" } else { "user" },
                    "content": message.content
                })
            })
            .collect::<Vec<_>>();

        client
            .post(endpoint)
            .header("x-api-key", request.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": request.model,
                "max_tokens": 4096,
                "temperature": request.temperature,
                "system": request.system_prompt,
                "messages": messages
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?
    } else {
        let endpoint = if request.endpoint.contains("/chat/completions") {
            request.endpoint.trim().to_string()
        } else {
            join_endpoint(&request.endpoint, "chat/completions")
        };

        let mut messages = vec![json!({ "role": "system", "content": request.system_prompt })];
        messages.extend(request.messages.iter().map(|message| {
            json!({
                "role": if message.role == "assistant" { "assistant" } else { "user" },
                "content": message.content
            })
        }));

        let mut builder = client.post(endpoint);
        if !request.api_key.trim().is_empty() {
            builder = builder.bearer_auth(request.api_key.trim());
        }

        builder
            .json(&json!({
                "model": request.model,
                "temperature": request.temperature,
                "messages": messages
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?
    };

    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;

    if !status.is_success() {
        return Err(format!("Provider returned {status}: {body}"));
    }

    let value = serde_json::from_str::<Value>(&body).map_err(|error| error.to_string())?;
    Ok(LlmResponse {
        content: extract_text(&value, &request.provider)?,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            default_board_path,
            write_board_file,
            read_board_file,
            delete_board_file,
            check_for_updates,
            install_update,
            call_llm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
