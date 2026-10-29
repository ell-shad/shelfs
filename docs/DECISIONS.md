# Decisions

One paragraph per decision: what we chose, why, and what it costs. Dates are the
milestone the decision was made in.

## Stack: Tauri 2 + Rust core + TypeScript/three.js frontend (M1)

three.js reproduces the prototype's look and motion exactly, and a webview gives us
pdf.js's text layer and a real CSS/HTML renderer for EPUB — the two hardest parts
of a reader. All logic (library, database, import, metadata, covers, EPUB parsing,
search indexing, settings, file watching, single instance, CLI) lives in Rust;
TypeScript owns rendering and UI state only. Cost: two languages, an IPC boundary,
and a WebKitGTK runtime dependency (`.deb` depends on `libwebkit2gtk-4.1-0`).

## Typed IPC with tauri-specta (M1)

Commands and data types are exported from Rust to `ui/src/bindings.ts`, so a
changed field breaks the frontend build instead of drifting silently. Cost: the
generated file must be re-exported (`cargo run --bin export-bindings`) and CI can
fail on a stale binding.

## Pages render in pdf.js, never in Rust (M1)

Rendering in Rust would mean shipping pdfium or MuPDF and their licence/packaging
obligations. pdf.js is Apache-2.0, bundled locally (worker and `standard_fonts`
copied into `ui/public/pdfjs` by `scripts/sync-pdfjs-assets.mjs`), runs with
`isEvalSupported: false` and no scripting. Cost: PDF rasterisation quality and
speed are pdf.js's, not a native library's.

## PDFs reach pdf.js over IPC, not over `bookshelf://` (M4)

pdf.js loads a document from a worker, and WebKitGTK does not route a worker's
`fetch` to the app's custom URI scheme: `getDocument({ url })` failed with
`Load failed` in every run, while the same URL works for main-thread subresources.
`pdf_bytes` therefore returns the file base64-encoded over IPC and pdf.js is given
`data`. Cost: one copy of the PDF in memory while it is open (a 20 MB book costs
~20 MB of `Uint8Array` plus the base64 string during transfer), and no HTTP range
requests. Page rendering is still virtualised, so memory stays bounded by the
window, not by the page count. The `bookshelf://pdf/<id>` route is kept because it
is useful to the main-thread path and to future native viewers.

## EPUB: Rust parser, sandboxed webview renderer (M5)

The container, OPF, spine, manifest, NCX/nav, cover and a plain-text projection of
every chapter are read in Rust (`formats/epub.rs`), with zip-bomb limits (entry
count, uncompressed size, compression ratio, per-entry cap) and DRM refusal. The
webview renders one chapter at a time inside a sandboxed iframe (`sandbox="allow-same-origin"`,
no scripts, CSP `default-src 'none'`, no `connect-src`) — the app's own renderer
rather than epub.js, so appearance controls, highlights and search anchors are
ours. Cost: fixed-layout EPUB and vertical writing are best effort only.

## Progress and annotations are anchored, not offset-based (M6)

A highlight stores a text-quote anchor (prefix, exact quote, suffix) in addition to
offsets, and resolves it by searching near the stored position. A font change,
column change or re-flow therefore keeps highlights and the reading position on the
right sentence. Cost: a little more bookkeeping and re-anchoring work on render.

## Fonts are bundled, and canvas textures wait for them (M1/M3)

Gelasio (metric-compatible with Georgia, the prototype's font), Literata, Source
Serif 4, Inter and OpenDyslexic ship in `ui/public/fonts` under SIL OFL 1.1. Spine
and cover textures are drawn only after `document.fonts.load`, and the family list
ends with CJK/Arabic serif fallbacks so Unicode titles never render as boxes.
Cost: ~3 MB of fonts in the package.

## Spine colour comes from the cover, lifted to mid-tone (M2)

The dominant colour is converted to HSL and clamped to 0.29–0.57 lightness with a
minimum saturation, so dark covers stay legible and washed-out covers stay
readable with cream or black text chosen for contrast. The prototype palette is the
fallback when there is no cover. Cost: a cover with a strong but tiny accent can
lose that accent.

## SQLite with versioned migrations, WAL, in the data directory (M2)

`rusqlite` with `bundled` SQLite (no system dependency, same version everywhere),
migrations as a list of SQL strings applied in order inside a transaction and
tracked with `user_version`; a v1 database upgrades in place and is tested. WAL for
concurrent reads while an import is running. Cost: bundled SQLite adds build time.

## Assets are served only for registered books (M1/M5)

`bookshelf://` canonicalises every path (no `..`, no absolute paths, no NUL) before
lookup, so a hostile EPUB cannot read outside its own archive; it also refuses
books that are not in the database. Cost: a book must be imported before its cover
or chapters are readable — which is what we want.

## Listing a folder is not a library import wizard (M3)

`bookshelf ~/Books` imports every PDF/EPUB found recursively and reports per-file
failures instead of stopping. Duplicates are reported, never silently skipped;
importing again is safe. Cost: importing a huge tree takes a while, but it runs in
the background with progress.

## Performance mode instead of a hard GPU requirement (M3)

When the renderer reports sustained frames over ~24 ms the app offers performance
mode (shadows off, lower pixel ratio) and remembers the answer; software rendering
(llvmpipe, no GPU) still works. `prefers-reduced-motion` replaces flights and drops
with fades. Cost: two visual configurations to keep working.

## Licence: MIT (M7)

The brief allowed MIT OR Apache-2.0. A single MIT licence keeps `LICENSE`,
`Cargo.toml` and `package.json` consistent without shipping an incomplete copy of
the Apache text; every dependency is permissive (MIT, Apache-2.0, BSD, OFL), so
nothing forces a different choice. Cost: no explicit patent grant that Apache-2.0
provides — flip to dual licensing if that matters for distribution.
