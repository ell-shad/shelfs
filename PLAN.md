# Bookshelf — build plan

Target: native Ubuntu desktop app (Tauri 2 + Rust core + TypeScript/three.js frontend).
Reference: the `bookshelf.html` prototype described in the brief (section 2). The prototype file
itself was **not present in the workspace** (it existed only as a chat attachment), so parity was
checked item by item against the numbers in the brief rather than by pixel-diffing the two
renders; [docs/PARITY.md](docs/PARITY.md) records that mapping and what could not be compared.

## Milestones

| # | Milestone | Acceptance |
|---|-----------|-----------|
| 1 | Scaffold and parity | Repo, CI, shelf rendering with static data matching the spec's geometry, lighting and themes in light + dark (screenshots), no CDN |
| 2 | Library backend | SQLite + migrations, import pipeline (hash, metadata, cover, color, dims), typed IPC via tauri-specta, fixture tests |
| 3 | Live shelf | Real data; picker/drag-drop/CLI import, duplicate handling, unlimited cases, sort/filter/search, drag reorder, missing/relink, edit/remove; 1000-book fps measurement |
| 4 | PDF reader | pdf.js pages + text layer, zoom/rotate/layouts, thumbnails, outline, links, night mode, password prompt, virtualization, resume |
| 5 | EPUB reader | EPUB 2/3 parsing in Rust, sandboxed chapters via custom scheme, paginated + scroll, TOC, appearance controls, fonts, images, footnotes |
| 6 | Reader features | Bookmarks, highlights/notes with text-quote anchors, in-book search, themes, shortcuts, status auto-flow, annotation export, transitions |
| 7 | Packaging and polish | .deb + AppImage, .desktop/MIME/AppStream/icons, single instance, accessibility, reduced motion, docs, perf report |

## Non-negotiable rules

- Book files are read-only. All state lives in the app DB/cache.
- No network at runtime; assets bundled. No telemetry.
- Rust owns logic; TypeScript owns rendering/UI. IPC types are generated, never hand-written.
- Every milestone: build, test, run under Xvfb with software GL where needed, commit.

## Verification approach in this environment

- `cargo test` for layout, migrations, formats, zip safety, locators.
- `cargo clippy -- -D warnings`, `cargo fmt --check`, `tsc --noEmit`, ESLint.
- Launch the real binary under `xvfb-run` with `LIBGL_ALWAYS_SOFTWARE=1`, drive it, capture
  screenshots with ImageMagick `import`, and inspect them.
- Performance measured with the in-app perf HUD (frame time) and a timing harness for cold start.
