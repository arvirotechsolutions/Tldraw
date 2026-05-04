use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};

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

#[tauri::command]
async fn check_for_updates() -> Result<UpdateCheck, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
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

    let release = serde_json::from_str::<GithubRelease>(&body).map_err(|error| error.to_string())?;
    let latest_version = release.tag_name.trim_start_matches('v').to_string();

    Ok(UpdateCheck {
        update_available: is_newer_version(&latest_version, &current_version),
        release_name: release
            .name
            .unwrap_or_else(|| format!("Tldraw {}", release.tag_name)),
        release_url: release.html_url,
        published_at: release.published_at.unwrap_or_default(),
        latest_version,
        current_version,
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
            call_llm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
