# Parity with the prototype

The brief described the reference prototype (`bookshelf.html`, three.js r128 from a CDN,
`localStorage`, generated spine canvases, Georgia font) as the visual and behavioural
spec. **That file is not in this repository** — it existed only as an attachment in the
task conversation, so there is nothing to diff against here and no pixel comparison was
made. What follows is a line-by-line check of the written spec (§2) against the code, so
the claims are auditable rather than "it looks right". Where the app deliberately differs
it is called out.

Two things the specification could not settle were decided by measurement instead: how a
case is lit and tinted in a modern three.js (r128 → current, colour management on), and
how the camera frames a case at different window shapes. Both are visible in
[screenshots/shelf-light.png](../screenshots/shelf-light.png) (light) and
[screenshots/shelf-dark.png](../screenshots/shelf-dark.png) (dark).

## Geometry

| Spec | Implementation | Where |
|---|---|---|
| 5 boards 8.4 × 0.2 × 1.3 at y = 0, 1.9, 3.8, 5.7, 7.6 | `BOARD_W/BOARD_T/BOARD_D`, loop `shelf * SHELF_SPACING` | `ui/src/shelf/ShelfView.ts` |
| Side panels 0.25 × 7.8 at x = ±4.075 | `SIDE_W`, `CASE_H`, `±(BOARD_W/2 - SIDE_W/2)` | same |
| Back panel 8.4 × 7.8 × 0.08 at z = −0.62, darker | `BACK_Z`, `backMaterial` (own, darker wood texture) | same |
| Procedural wood grain on boards and sides | `makeWoodTexture(false)` / `makeWoodTexture(true)` | `ui/src/shelf/textures.ts` |
| Usable width −3.85 … 3.85 | `USABLE_MIN_X` / `USABLE_MAX_X` | `src-tauri/src/layout.rs` |
| A book rests at `shelfIndex × 1.9 + 0.1` | `SHELF_BASE_Y`, `shelfPosition()` | `layout.rs`, `ShelfView.ts` |
| 0.012 gap, back against the back panel (+0.03) | `BOOK_GAP`, `BOOK_BACK_Z = BACK_Z + 0.04 + 0.03` | same |
| Floor and wall planes behind/under the case | `this.floor`, `this.wall` | `ShelfView.ts` |

## Books

| Spec | Implementation | Where |
|---|---|---|
| `t = clamp(0.14 + pages × 0.00065, 0.16, 0.55)` | `Book::thickness()` — unit-tested | `src-tauri/src/models.rs` (test in `db.rs`) |
| Height 1.15–1.6, depth 0.85–0.98, picked once and persisted | chosen at import, stored in the `books` table | `src-tauri/src/library.rs`, `db.rs` |
| Spine faces +z, golden bands, bold serif title top-to-bottom, italic author at the bottom, contrast-picked text colour, status dot (green/amber/none) | `drawSpineTexture()` | `ui/src/shelf/textures.ts` |
| Spine textures ≈ 300 px per unit | fixed 160 × 640 px tiles, which is 290–400 px/unit for real spine and book sizes | same (`SPINE_TILE_W/H`) |
| Front cover: gradient, double gold frame, wrapped title + author | `drawCoverTexture()` fallback | same |
| Real extracted cover used when present | `coverTexture()` / `TextureLoader` over `bookshelf://cover/<id>` | `ShelfView.ts` |
| Cream page edges on top/bottom/fore-edge | cream `InstancedMesh` bodies | `ShelfView.ts` |

Two deviations, both deliberate:

- **Books are instanced, spines are cached.** Bodies share one `InstancedMesh` per case and
  spine/cover canvases live in an LRU `SpineCache`, so a case costs one instanced draw call
  instead of one mesh per book. This is the fix for prototype limit 3; visually identical
  because every face is still a box of the same proportions.
- **Spine textures are drawn progressively** (8 on first paint, then 12 per frame) instead
  of all at once, which is what keeps a 200-book case interactive. See
  [PERF.md](PERF.md).

## Motion and interaction

| Spec | Implementation | Where |
|---|---|---|
| Hover pulls the book 0.2 forward, tooltip with the title | `targetPull = 0.2`, `onHover` → shell tooltip | `ShelfView.ts`, `ui/src/ui/shell.ts` |
| Click flies to (0, 4.6, 4.2), ≈ −90° yaw + 0.28 tilt; 2× scale, 1.35× portrait | `FOCUS_POS`, detail `targetQuat`, portrait check | `ShelfView.ts` |
| Esc / Done / empty space returns it | `closeDetail()`, `onKeyDown`, `onPointerUp` | same, `ui/src/main.ts` |
| Orbit yaw ±0.8, pitch −0.12 … 0.5 | `targetYaw`/`targetPitch` clamps | `ShelfView.ts` |
| Wheel zoom 0.55× … 1.15× | `targetZoom` clamp | same |
| Camera distance adapts to aspect so the case always fits | `resize()` fits height then width | same |
| Exponential damping `k = 1 − 0.0009^dt` | `DAMP_BASE`, `update()` | same |
| New book drops from above with a random tumble; neighbours slide on removal | per-book `AnimState` with a 2.6-unit drop and Euler tilt | `buildCase()`, `update()` |
| Lighting: hemisphere (0xfff1dc / 0x3a2a1c), warm directional with 2048² soft shadows, warm point light | `HemisphereLight`, `DirectionalLight` (`PCFSoftShadowMap`, 2048), `PointLight(0xffb877)` | `ShelfView.ts` |
| Theme follows the system; light/dark palettes exactly as specified | CSS tokens + `COLORS` in the scene | `ui/src/styles.css`, `ui/src/lib/theme.ts` |
| Reduced motion replaces flights and drops with short fades | `prefersReducedMotion()`, `reducedMotion` short-circuits | `theme.ts`, `ShelfView.ts` |

Intensities are the one numeric departure: the prototype's `0.7` hemisphere and a bare
directional light are three.js r128 values under legacy (gamma-less) colour management.
Moving to a current three.js with `outputColorSpace = SRGBColorSpace` darkens the scene, so
the hemisphere runs at 1.35 and the sun at 2.7 (dark theme 0.75 / 1.5) to land on the same
brightness the prototype had. This is the retune the brief asked for after the r128 → modern
upgrade.

## Things the prototype did, and the app does not

All five prototype limits are addressed, and each one was a deliberate product change:

1. **One case, refuses books when full** → unlimited cases `CASE_PITCH` apart, with the
   `Case 2 / 5` indicator, arrow keys, on-screen arrows, shift-drag and horizontal scroll.
2. **`localStorage`** → SQLite under `$XDG_DATA_HOME` with versioned migrations.
3. **One canvas per book** → instancing plus an LRU texture cache with disposal.
4. **Georgia** → Gelasio (metric-compatible with Georgia, SIL OFL), embedded; every canvas
   texture waits for `document.fonts.load()` first.
5. **three.js r128 from a CDN** → three.js bundled from npm, no network at runtime.

## How to re-check this yourself

```bash
npm run app:build
scripts/gui-drive.sh /tmp/shots /path/to/books   # shelf, hover, detail card, list view
```

The script starts Xvfb with software GL (the "no GPU" path), drives the window with
`xdotool` and leaves numbered screenshots in `/tmp/shots`. The two committed screenshots
were produced the same way, with the theme switched in the library database between runs.
