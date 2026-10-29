//! Bookshelf — a local-first PDF/EPUB library on a 3D bookcase.

pub mod commands;
pub mod covers;
pub mod db;
pub mod error;
pub mod fixtures;
pub mod formats;
pub mod layout;
pub mod library;
pub mod models;
pub mod paths;
pub mod protocol;
pub mod state;
pub mod util;
pub mod watcher;

use std::path::Path;
use std::sync::Arc;

use tauri::{Emitter, Manager};
use tracing_subscriber::EnvFilter;

use crate::paths::AppPaths;
use crate::state::AppState;

fn init_tracing() {
    let filter = EnvFilter::try_from_env("BOOKSHELF_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,bookshelf=debug"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr)
        .try_init();
}

pub fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        // Every i64 crossing IPC is an id, a page count, a byte size or a
        // millisecond timestamp: all far below Number.MAX_SAFE_INTEGER. The
        // exporter maps them to TS `number` instead of forbidding them.
        .dangerously_cast_bigints_to_number()
        // Floats here are geometry, progress and font sizes: never NaN or
        // infinite (validated on the way in), so they can be plain `number`
        // rather than specta's defensive `number | null`.
        .semantic_types(
            specta_typescript::semantic::Configuration::default().enable_lossless_floats(),
        )
        .commands(tauri_specta::collect_commands![
            commands::get_app_info,
            commands::get_library,
            commands::get_settings,
            commands::set_settings,
            commands::reset_library_view,
            commands::check_duplicates,
            commands::import_files,
            commands::save_pdf_cover,
            commands::set_book_pages,
            commands::update_book,
            commands::remove_book,
            commands::move_book,
            commands::relink_book,
            commands::refresh_missing,
            commands::search_library,
            commands::open_book,
            commands::close_book,
            commands::save_progress,
            commands::get_chapter,
            commands::pdf_bytes,
            commands::get_epub_package,
            commands::search_book,
            commands::list_bookmarks,
            commands::add_bookmark,
            commands::remove_bookmark,
            commands::rename_bookmark,
            commands::list_annotations,
            commands::add_annotation,
            commands::update_annotation,
            commands::remove_annotation,
            commands::export_annotations,
            commands::write_export_file,
            commands::backup_library,
            commands::restore_library,
            commands::take_pending_files,
            commands::open_external,
        ])
}

fn startup_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| Path::new(arg).exists())
        .collect()
}

pub fn run() {
    init_tracing();

    let paths = match AppPaths::discover() {
        Ok(paths) => paths,
        Err(err) => {
            eprintln!("Bookshelf cannot start: {err}");
            std::process::exit(1);
        }
    };
    if let Err(err) = paths.ensure() {
        eprintln!("Bookshelf cannot create its data folders: {err}");
        std::process::exit(1);
    }
    let state = match AppState::new(paths) {
        Ok(state) => state,
        Err(err) => {
            eprintln!("Bookshelf cannot open its library: {err}");
            std::process::exit(1);
        }
    };

    let cli_files = startup_files();
    if !cli_files.is_empty() {
        let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.extend(cli_files);
    }

    let specta = specta_builder();
    #[cfg(debug_assertions)]
    {
        if let Err(err) = specta.export(
            specta_typescript::Typescript::default(),
            "../ui/src/bindings.ts",
        ) {
            tracing::warn!(%err, "could not export TypeScript bindings");
        }
    }

    let setup_state = state.clone();
    let builder = tauri::Builder::default()
        // Must be the first plugin: a second launch forwards its files here.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files: Vec<String> = argv
                .iter()
                .skip(1)
                .filter(|arg| !arg.starts_with('-'))
                .filter(|arg| Path::new(arg).exists())
                .cloned()
                .collect();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if files.is_empty() {
                return;
            }
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
                pending.extend(files.clone());
            }
            let _ = app.emit("open-files", files);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(specta.invoke_handler())
        .setup(move |app| {
            specta.mount_events(app);
            if let Err(err) = watcher::start(setup_state.clone(), app.handle().clone()) {
                tracing::warn!(%err, "file watcher could not start");
            }
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                data = %setup_state.paths.data_dir.display(),
                "Bookshelf started"
            );
            Ok(())
        });

    let builder = protocol::register(builder);
    if let Err(err) = builder.run(tauri::generate_context!()) {
        eprintln!("Bookshelf stopped: {err}");
        std::process::exit(1);
    }
}
