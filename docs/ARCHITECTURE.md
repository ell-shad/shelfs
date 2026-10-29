# Architecture

## Shape

```
┌──────────────────────────── webview (TypeScript, strict) ────────────────────────────┐
│ ui/src/main.ts            boot, wiring, dialogs, event bus                            │
│ ui/src/shelf/             three.js scene: cases, books, textures, camera, interaction  │
│ ui/src/ui/                shell chrome, book card, list view, dialogs                  │
│ ui/src/reader/            Reader panel + PDF (pdf.js) and EPUB adapters                │
│ ui/src/lib/               typed api wrapper, i18n, theme, formatting, fonts             │
└───────────────────────────────────────▲──────────────────────────────────────────────┘
                        typed IPC (tauri-specta)  │  invoke / events
┌───────────────────────────────────────┴──────────────────────────────────────────────┐
│                            Rust core (src-tauri/src)                                  │
│ lib.rs         window, plugins, command registration, custom protocol                 │
│ commands.rs    IPC surface: library, import, reader state, annotations, settings      │
│ db.rs          SQLite, migrations, queries, session tracking                          │
│ library.rs     import pipeline: hash, probe, metadata, cover, colour, dedupe, relink  │
│ formats/       BookFormat trait + pdf.rs (lopdf), epub.rs (zip + roxmltree), sanitize  │
│ covers.rs      dominant colour, JPEG cover storage with size limits                   │
│ layout.rs      shelf packing: books -> slots across cases (pure, unit-tested)          │
│ protocol.rs    bookshelf:// resource handler with path canonicalisation                │
│ state.rs       AppState: db handle, settings cache, EPUB archive cache                │
│ watcher.rs     notify-based missing-file detection                                    │
│ paths.rs       XDG data/cache/config layout                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Data flow: importing a book

1. A path arrives from the picker (`plugin-dialog`), a drop event, a CLI argument,
   a second instance, or a folder expansion.
2. `library::import` hashes the file (blake3), asks the database whether that hash is
   already known, and reports a duplicate instead of inserting it.
3. `formats::probe` picks the handler by extension *and* content sniffing. The
   handler returns metadata, a page estimate (EPUB: text length / 1500), an optional
   cover image and the encrypted/DRM status.
4. `covers` converts the cover to a bounded JPEG, computes the dominant colour and
   clamps it to a legible mid-tone. Book dimensions and spine colour are derived
   deterministically from the hash so the shelf never reshuffles.
5. The row is inserted, `library-changed` is emitted, the frontend reloads the
   snapshot, and the shelf's layout packer places the new book. Rows that were added
   since the last render get the "drop from above" animation.

## Data flow: opening a book

`open_book` marks the book opened, starts a reading session, decodes the stored
locator and returns an `OpenedBook`: the book row, a document URL, and for EPUB the
package (spine, TOC, chapter sizes). The frontend builds a `Reader`, which builds
either the PDF or EPUB adapter; the shelf render loop is paused until the reader
closes.

- **PDF** — `pdf_bytes` returns the file over IPC; pdf.js parses it, then renders
  only the pages near the viewport (each page keeps a canvas and a text layer, and
  pages that scroll away are dropped).
- **EPUB** — `get_chapter` returns one sanitised chapter (relative URLs rewritten to
  the `bookshelf://` base, scripts/frames/objects stripped, publisher CSS kept or
  dropped by preference). The adapter injects it into a sandboxed iframe, paginates
  with CSS columns, and writes the locator back on every scroll/page change.

Progress is saved on close, on chapter change and on a debounce while scrolling, so
a crash loses at most a few seconds of reading.

## Database

`books`, `chapters` (per-chapter text for library-wide search and page estimates),
`bookmarks`, `annotations` (locator + quote anchor + note + colour), `settings`
(single JSON row), `reading_sessions`, `jobs`. Migrations are an ordered list of SQL
strings applied in a transaction and tracked by `PRAGMA user_version`; the upgrade
from a v1 database is tested.

Locators are format-tagged: PDF stores page plus offset; EPUB stores spine index,
href, in-chapter progress and a text-quote anchor. The frontend writes them; Rust
only stores and returns them, so a locator format change is a frontend change.

## Shelf rendering

The scene has one `CaseView` per case (5 boards, 2 sides, back panel, shared
geometry and materials), `InstancedMesh` bodies for the books, and one mesh per
spine with a texture from an LRU atlas/cache (`textures.ts`). Textures are drawn on
canvases only when a book is first visible, disposed when far away, and never
before the bundled fonts have loaded. All motion is exponentially damped with the
prototype's `k = 1 - 0.0009^dt`. The camera fits the wall of cases for the current
aspect ratio; the packer (`layout.rs`) decides which book sits in which case.

## Security posture

- CSP: only `self`, the `bookshelf` scheme and `ipc`; no remote origins, no inline
  scripts, `object-src 'none'`, `frame-ancestors 'none'`.
- No network code anywhere in the app; no telemetry.
- Book files are opened read-only; nothing writes to the user's library paths except
  an explicit file-copy import mode into the app's own directory.
- EPUB chapters are sandboxed iframes with scripts disabled, network blocked, and
  resources limited to the book's own archive (zip-bomb caps: entry count, total
  uncompressed size, ratio, per-entry size).
- Tauri capabilities grant only what the app uses: dialogs, window state, single
  instance, opener for confirmed external links. No shell, no arbitrary fs scope.
- Parsing paths return `Result`; malformed fixtures (truncated PDF, DRM EPUB, zip
  bomb, bad OPF) are covered by tests and never panic.

## Testing

| Layer | What is covered |
|---|---|
| Rust unit | shelf layout packing and wrapping, migration idempotency and upgrade, import pipeline (metadata, cover, colour, dedupe, relink, copy mode), format probes, EPUB chapter sanitising, text anchors, base64, zip safety |
| Frontend unit | anchor resolution, formatting helpers, percent/appearance maths |
| Headless GUI | `scripts/gui-smoke.sh` and `scripts/gui-drive.sh` run the real binary on Xvfb with software GL and screenshot each step (shelf, hover, card, list, EPUB reader) |
| Fixtures | generated on demand by `formats::fixtures` / `bin/make-fixtures` — no copyrighted material in the repo |
