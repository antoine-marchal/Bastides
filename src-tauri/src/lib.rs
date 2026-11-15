//! Native side of Bastides: save storage and the optional WebSocket relay.
//! All game rules live in the TypeScript engine; Rust exposes a handful of validated commands.

pub mod network;
pub mod storage;

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
struct Net(Mutex<Option<network::Server>>);

fn saves_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|d| d.join("saves")).map_err(|e| format!("Dossier de donnÃ©es indisponible : {e}"))
}

#[tauri::command]
fn save_list(app: AppHandle) -> Result<Vec<String>, String> {
    storage::list(&saves_dir(&app)?)
}

#[tauri::command]
fn save_read(app: AppHandle, name: String) -> Result<String, String> {
    storage::read(&saves_dir(&app)?, &name)
}

#[tauri::command]
fn save_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    storage::write(&saves_dir(&app)?, &name, &text)
}

#[tauri::command]
fn save_delete(app: AppHandle, name: String) -> Result<(), String> {
    storage::delete(&saves_dir(&app)?, &name)
}

#[derive(Serialize)]
struct NetInfo {
    port: u16,
    addresses: Vec<String>,
}

#[cfg(target_os = "android")]
struct AndroidLan(tauri::plugin::PluginHandle<tauri::Wry>);

#[tauri::command]
async fn net_prepare(_app: AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct LanInfo {
            addresses: Vec<String>,
        }
        return _app.state::<AndroidLan>().0
            .run_mobile_plugin_async::<LanInfo>("prepare", ())
            .await
            .map(|info| info.addresses)
            .map_err(|err| err.to_string());
    }
    #[cfg(not(target_os = "android"))]
    Ok(Vec::new())
}

#[tauri::command]
async fn net_start(app: AppHandle, net: State<'_, Net>, port: u16) -> Result<NetInfo, String> {
    if port < 1024 {
        return Err("Choisissez un port entre 1024 et 65535.".into());
    }
    let mut guard = net.0.lock().await;
    if let Some(old) = guard.take() {
        old.stop();
    }
    let handle = app.clone();
    let server = network::Server::start(port, Arc::new(move |event| { let _ = handle.emit("net-event", event); })).await?;
    let info = NetInfo { port: server.port, addresses: network::local_addresses() };
    *guard = Some(server);
    Ok(info)
}

#[tauri::command]
async fn net_send(net: State<'_, Net>, conn: u32, text: String) -> Result<(), String> {
    match net.0.lock().await.as_ref() {
        Some(server) => server.send(conn, text),
        None => Err("Aucun salon ouvert.".into()),
    }
}

#[tauri::command]
async fn net_close(net: State<'_, Net>, conn: u32) -> Result<(), String> {
    if let Some(server) = net.0.lock().await.as_ref() {
        server.close(conn);
    }
    Ok(())
}

#[tauri::command]
async fn net_stop(net: State<'_, Net>) -> Result<(), String> {
    if let Some(server) = net.0.lock().await.take() {
        server.stop();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri::plugin::Builder::<_, ()>::new("lan")
        .setup(|app, api| {
            app.manage(AndroidLan(api.register_android_plugin("fr.bastides.app", "LanPlugin")?));
            Ok(())
        })
        .build());
    builder
        .manage(Net::default())
        .invoke_handler(tauri::generate_handler![save_list, save_read, save_write, save_delete, net_prepare, net_start, net_send, net_close, net_stop])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Bastides");
}
