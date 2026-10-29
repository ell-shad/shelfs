# Performance

Measured on the development machine (Ubuntu 24.04, AMD Radeon GPU present), **under
`xvfb-run` with `LIBGL_ALWAYS_SOFTWARE=1`** — that is, llvmpipe software rasterisation,
the worst case the app must still work in. Xvfb has no GPU access, so these are *not*
GPU-accelerated numbers; a hardware run on this machine was not measured (see
"Unverified" below).

## How to reproduce

```bash
cargo run --manifest-path src-tauri/Cargo.toml --features dev-tools \
  --bin make-fixtures -- /tmp/books 200 20        # 220 synthetic books
npm run app:build                                  # production binary
scripts/perf-measure.sh /tmp/books /tmp/perf      # cold start, screenshots
```

`scripts/perf-measure.sh` reports two numbers per run: `window_mapped_ms` (process
launch until X sees the window) and `core_started_ms` (until the Rust core logs
"Bookshelf started"). Frame rate was measured during development with a temporary
on-screen probe compiled into `ShelfView`; the probe was removed afterwards, so the
numbers below are recorded rather than reproducible from a clean checkout.

## Results

| Scenario | Result |
|---|---|
| Cold start, empty library — window mapped | **190 ms** |
| Cold start, 220 books — window mapped | **188–198 ms** (3 runs) |
| Cold start, 220 books — Rust core ready | **194–206 ms** |
| 220 books — shelf fully populated and rendering | **≈ 7 s** |
| 220 books — steady-state frame time (after spine textures settle) | **18.7–25.3 ms avg, p95 30–37 ms → 40–53 fps** |
| Importing 220 books (200 PDFs + 20 EPUBs) from a folder on first launch | ≈ 90 s (background, with progress UI) |

## Against the quality bar

- **Cold start under 2 s to an interactive shelf with 200 books** — *not met in this
  environment.* The window is up in ~200 ms and the core is ready in ~200 ms, but
  populating 220 books takes ≈ 7 s under software rasterisation. This is measured on
  llvmpipe, not the GPU the target assumes.
- **60 fps shelf with 1,000 books** — *not measured.* The 220-book case settles at
  40–53 fps on llvmpipe. A GPU run, and a 1,000-book library, were not measured here.
- **Bounded memory while reading large files** — met by design: PDF pages are
  virtualised (only pages near the viewport keep a canvas and text layer, and pages
  that scroll away are dropped), EPUB loads one chapter at a time, and shelf textures
  are held in an LRU cache with disposal for off-screen cases.

## What was optimised, and why

The first version of the shelf drew every book's spine texture in a single frame when
a case came into view. Drawing a canvas texture costs a few milliseconds each, so a
200-book case froze the shelf for several seconds before the first frame appeared.
Spine textures are now drawn progressively — a handful on the first frame (enough to
be readable immediately) and a small slice per frame afterwards
(`SPINES_PER_FRAME` in `ui/src/shelf/ShelfView.ts`). That took the 220-book first
paint from ≈ 8.2 s to ≈ 7.0 s and, more importantly, made the shelf interactive while
the rest of the spines finish drawing, without changing steady-state frame rate.

The remaining cost is dominated by canvas text rendering for spines and by llvmpipe's
software rasterisation of a shadow-mapped scene. The app detects poor frame times at
run time and offers performance mode (shadows off, lower pixel ratio), which is the
escape hatch for machines in this situation.

## Packaging and binary sizes

| Artifact | Size |
|---|---|
| `Bookshelf_0.1.0_amd64.deb` | 19.8 MiB |
| `Bookshelf_0.1.0_amd64.AppImage` | 97.8 MiB |

## Test throughput

- 61 Rust tests in ≈ 4.3 s
- 13 frontend (vitest) tests in ≈ 0.25 s
- `cargo clippy --all-targets --features dev-tools -- -D warnings` clean
- `cargo fmt --check` clean
