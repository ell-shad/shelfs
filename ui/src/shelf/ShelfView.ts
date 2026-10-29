import * as THREE from "three";
import type { Book, LibrarySnapshot } from "../lib/api";
import type { ShelfSlot } from "../bindings";
import { clamp } from "../lib/format";
import { coverTexture, makeWoodTexture, SpineCache, textureFromCanvas, drawSpineTexture } from "./textures";

export const CASE_PITCH = 9.2;
export const SHELF_SPACING = 1.9;
export const SHELF_BASE_Y = 0.1;
const BOARD_W = 8.4;
const BOARD_T = 0.2;
const BOARD_D = 1.3;
const SIDE_W = 0.25;
const CASE_H = 7.8;
const BACK_Z = -0.62;
const BOOK_BACK_Z = BACK_Z + 0.04 + 0.03;
const FOV = 42;
const DAMP_BASE = 0.0009;
/** Spine textures drawn per frame; see pumpSpines. */
const SPINES_PER_FRAME = 12;
const FOCUS_POS = new THREE.Vector3(0, 4.55, 3.55);

const COLORS = {
  light: {
    wall: 0xc5cfc3,
    floor: 0x8a7458,
    ceiling: 0xd7ded2,
    cream: 0xefe6d2,
  },
  dark: {
    wall: 0x1b2530,
    floor: 0x3a3029,
    ceiling: 0x22303c,
    cream: 0xe6dbc4,
  },
};

export interface ShelfCallbacks {
  onSelect(bookId: number | null): void;
  onHover(bookId: number | null, x: number, y: number): void;
  onReorder(bookId: number, targetIndex: number): void;
  onDrag(bookId: number, targetIndex: number, x: number, y: number): void;
  onCaseChange(caseIndex: number, caseCount: number): void;
  onRead(bookId: number): void;
  onSlowFrame(averageFrameMs: number): void;
}

interface AnimState {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  quat: THREE.Quaternion;
  targetQuat: THREE.Quaternion;
  pull: number;
  targetPull: number;
}

interface CaseBook {
  book: Book;
  slot: ShelfSlot;
  index: number;
  spine: THREE.Mesh | null;
}

interface CaseView {
  index: number;
  group: THREE.Group;
  bodies: THREE.InstancedMesh;
  items: CaseBook[];
  spinesBuilt: boolean;
  /** How many of `items` already have a spine mesh; the rest are drawn in later frames. */
  spineCursor: number;
}

interface DetailState {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  quat: THREE.Quaternion;
  targetQuat: THREE.Quaternion;
  scale: number;
  targetScale: number;
  closing: boolean;
}

export class ShelfView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private container: HTMLElement;
  private callbacks: ShelfCallbacks;

  private books: Book[] = [];
  private slots = new Map<number, ShelfSlot>();
  private bookIndex = new Map<number, number>();
  private caseCount = 1;
  private cases = new Map<number, CaseView>();
  private states = new Map<number, AnimState>();
  private knownIds = new Set<number>();
  private newIds = new Set<number>();

  private spineCache = new SpineCache(220);
  private caseIndicator = 0;
  private bodyGeometry = new THREE.BoxGeometry(1, 1, 1);
  private spineGeometry = new THREE.PlaneGeometry(1, 1);
  private creamMaterial: THREE.MeshStandardMaterial;
  private woodTexture = makeWoodTexture(false);
  private darkWoodTexture = makeWoodTexture(true);
  private boardMaterial: THREE.MeshStandardMaterial;
  private backMaterial: THREE.MeshStandardMaterial;
  private floor: THREE.Mesh;
  private wall: THREE.Mesh;
  private hemisphere: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private lamp: THREE.PointLight;

  private yaw = 0;
  private targetYaw = 0;
  private pitch = 0.14;
  private targetPitch = 0.14;
  private zoom = 1;
  private targetZoom = 1;
  private caseFloat = 0;
  private caseTarget = 0;
  private baseDistance = 13;
  private cameraTargetY = 3.85;

  private selectedId: number | null = null;
  private hiddenIds = new Set<number>();
  /** Ids matching the current search; `null` means no search dimming. */
  private searchIds: Set<number> | null = null;
  private hoverId: number | null = null;
  private detail: THREE.Group | null = null;
  private detailState: DetailState | null = null;
  private detailBook: Book | null = null;
  private detailCoverTexture: THREE.Texture | null = null;

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDown: { x: number; y: number; bookId: number | null; shift: boolean } | null = null;
  private orbiting = false;
  private panning = false;
  private dragging = false;
  private dragMoved = false;

  private paused = false;
  private raf = 0;
  private performanceMode = false;
  private reducedMotion = false;
  private theme: "light" | "dark" = "light";
  private resizeObserver: ResizeObserver;
  private dummy = new THREE.Object3D();
  private frameSamples: number[] = [];
  private slowReported = false;
  private lastPointerEvent = 0;
  /** Where the pointer last resolved to a book, so a click on that same spot
   * still selects it even though the hover pull has shifted the spine a few
   * pixels sideways since the ray was cast. */
  private hoverPoint: { x: number; y: number; id: number } | null = null;
  private destroyed = false;

  constructor(container: HTMLElement, callbacks: ShelfCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      alpha: false,
    });
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.renderer.domElement.tabIndex = -1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
    this.scene.background = new THREE.Color(COLORS.light.wall);
    this.scene.fog = new THREE.Fog(COLORS.light.wall, 30, 70);

    this.hemisphere = new THREE.HemisphereLight(0xfff1dc, 0x3a2a1c, 1.35);
    this.scene.add(this.hemisphere);

    this.sun = new THREE.DirectionalLight(0xffd8a6, 2.7);
    this.sun.position.set(5.5, 11, 8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -9;
    this.sun.shadow.camera.right = 9;
    this.sun.shadow.camera.top = 11;
    this.sun.shadow.camera.bottom = -4;
    this.sun.shadow.camera.near = 0.5;
    this.sun.shadow.camera.far = 40;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.lamp = new THREE.PointLight(0xffb877, 18, 30, 2);
    this.lamp.position.set(-3.4, 6.2, 3.2);
    this.scene.add(this.lamp);

    this.creamMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.light.cream,
      roughness: 0.88,
      metalness: 0,
    });
    this.boardMaterial = new THREE.MeshStandardMaterial({
      map: this.woodTexture,
      roughness: 0.72,
      metalness: 0,
    });
    this.backMaterial = new THREE.MeshStandardMaterial({
      map: this.darkWoodTexture,
      roughness: 0.9,
      metalness: 0,
    });

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 90),
      new THREE.MeshStandardMaterial({ color: COLORS.light.floor, roughness: 0.95 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.set(0, -0.14, 12);
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.wall = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 90),
      new THREE.MeshStandardMaterial({ color: COLORS.light.wall, roughness: 1 }),
    );
    this.wall.position.set(0, 20, -1.4);
    this.wall.receiveShadow = true;
    this.scene.add(this.wall);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("pointerup", this.onPointerUp);
    dom.addEventListener("pointercancel", this.onPointerUp);
    dom.addEventListener("pointerleave", this.onPointerLeave);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());

    this.loop();
  }

  // ------------------------------------------------------------- data

  setData(snapshot: LibrarySnapshot, options: { reducedMotion: boolean }): void {
    this.reducedMotion = options.reducedMotion;
    const previous = new Set(this.knownIds);
    this.books = snapshot.books.slice();
    this.bookIndex.clear();
    this.slots.clear();
    this.books.forEach((book, index) => this.bookIndex.set(book.id, index));
    for (const slot of snapshot.layout.slots) this.slots.set(slot.bookId, slot);
    this.caseCount = Math.max(1, snapshot.layout.caseCount);

    this.newIds.clear();
    for (const book of this.books) {
      if (!previous.has(book.id)) this.newIds.add(book.id);
    }
    this.knownIds = new Set(this.books.map((b) => b.id));

    if (this.selectedId !== null && !this.bookIndex.has(this.selectedId)) {
      this.closeDetail(true);
      this.selectedId = null;
    }
    this.caseTarget = clamp(this.caseTarget, 0, this.caseCount - 1);
    this.caseFloat = clamp(this.caseFloat, 0, this.caseCount - 1);
    this.rebuildCases();
    this.resumeSelection();
    this.syncSpines();
    this.callbacks.onCaseChange(Math.round(this.caseFloat), this.caseCount);
  }

  private rebuildCases(): void {
    for (const view of this.cases.values()) {
      this.scene.remove(view.group);
      this.disposeGroup(view.group);
    }
    this.cases.clear();

    const byCase = new Map<number, CaseBook[]>();
    for (const slot of this.slots.values()) {
      const book = this.books[this.bookIndex.get(slot.bookId) ?? -1];
      if (!book) continue;
      const list = byCase.get(slot.caseIndex) ?? [];
      list.push({ book, slot, index: list.length, spine: null });
      byCase.set(slot.caseIndex, list);
    }
    for (let i = 0; i < this.caseCount; i++) {
      this.cases.set(i, this.buildCase(i, byCase.get(i) ?? []));
    }
    this.applyThemeColors();
    this.applySearchDim();
  }

  private buildCase(index: number, items: CaseBook[]): CaseView {
    const group = new THREE.Group();
    group.position.x = index * CASE_PITCH;

    const addBox = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      material: THREE.Material,
      shadow = true,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    for (let shelf = 0; shelf < 5; shelf++) {
      addBox(BOARD_W, BOARD_T, BOARD_D, 0, shelf * SHELF_SPACING, 0, this.boardMaterial);
    }
    addBox(SIDE_W, CASE_H, BOARD_D, -(BOARD_W / 2 - SIDE_W / 2), CASE_H / 2, 0, this.boardMaterial);
    addBox(SIDE_W, CASE_H, BOARD_D, BOARD_W / 2 - SIDE_W / 2, CASE_H / 2, 0, this.boardMaterial);
    addBox(BOARD_W, CASE_H, 0.08, 0, CASE_H / 2, BACK_Z, this.backMaterial, false);

    const bodies = new THREE.InstancedMesh(this.bodyGeometry, this.creamMaterial, Math.max(1, items.length));
    bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    bodies.count = items.length;
    bodies.frustumCulled = true;
    group.add(bodies);

    const view: CaseView = { index, group, bodies, items, spinesBuilt: false, spineCursor: 0 };
    this.scene.add(group);

    for (const item of items) {
      const existing = this.states.get(item.book.id);
      const target = this.shelfPosition(item);
      if (!existing) {
        const isNew = this.newIds.has(item.book.id);
        const start = target.clone();
        if (isNew && !this.reducedMotion) start.y += 2.6;
        this.states.set(item.book.id, {
          pos: start,
          target,
          quat:
            isNew && !this.reducedMotion
              ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0.5, 0.4))
              : new THREE.Quaternion(),
          targetQuat: new THREE.Quaternion(),
          pull: 0,
          targetPull: 0,
        });
      } else {
        existing.target.copy(target);
        if (!this.reducedMotion) {
          existing.targetQuat.identity();
        } else {
          existing.quat.identity();
        }
      }
    }
    return view;
  }

  private shelfPosition(item: CaseBook): THREE.Vector3 {
    const { slot } = item;
    return new THREE.Vector3(
      slot.x + slot.thickness / 2,
      slot.shelfIndex * SHELF_SPACING + SHELF_BASE_Y + slot.height / 2,
      BOOK_BACK_Z + slot.depth / 2,
    );
  }

  private spinePosition(item: CaseBook): THREE.Vector3 {
    const { slot } = item;
    return new THREE.Vector3(
      slot.x + slot.thickness / 2,
      slot.shelfIndex * SHELF_SPACING + SHELF_BASE_Y + slot.height / 2,
      BOOK_BACK_Z + slot.depth + 0.002,
    );
  }

  private syncSpines(): void {
    const current = Math.round(this.caseFloat);
    for (const [index, view] of this.cases) {
      const inRange = Math.abs(index - current) <= 1;
      if (inRange && !view.spinesBuilt) {
        this.buildSpines(view);
      } else if (!inRange && view.spinesBuilt) {
        this.disposeSpines(view);
      }
    }
    this.updateCaseIndicator();
  }

  private buildSpines(view: CaseView): void {
    view.spinesBuilt = true;
    view.spineCursor = 0;
    // Spine textures are drawn on canvases, which costs a few milliseconds
    // each. Drawing all of a shelf's spines inside one frame is what made a
    // 200-book library freeze the shelf for several seconds, so the first few
    // are drawn now (enough to read on the first paint) and the rest are
    // spread over the next frames by pumpSpines.
    this.pumpSpines(view, Math.min(8, view.items.length));
  }

  private pumpSpines(view: CaseView, budget: number): void {
    const end = Math.min(view.items.length, view.spineCursor + budget);
    for (let i = view.spineCursor; i < end; i += 1) {
      const item = view.items[i];
      if (!item) continue;
      const material = new THREE.MeshStandardMaterial({
        map: this.spineCache.get(item.book),
        roughness: 0.82,
        metalness: 0.02,
      });
      const mesh = new THREE.Mesh(this.spineGeometry, material);
      mesh.userData.bookId = item.book.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = true;
      view.group.add(mesh);
      item.spine = mesh;
    }
    view.spineCursor = end;
  }

  private disposeSpines(view: CaseView): void {
    for (const item of view.items) {
      if (!item.spine) continue;
      view.group.remove(item.spine);
      (item.spine.material as THREE.MeshStandardMaterial).dispose();
      item.spine = null;
    }
    view.spinesBuilt = false;
    view.spineCursor = 0;
  }

  private resumeSelection(): void {
    if (this.selectedId === null) return;
    if (!this.bookIndex.has(this.selectedId)) {
      this.closeDetail(true);
      return;
    }
    this.rebuildDetail(this.selectedId);
  }

  // -------------------------------------------------------------- theme

  setTheme(theme: "light" | "dark"): void {
    this.theme = theme;
    this.applyThemeColors();
  }

  private applyThemeColors(): void {
    const palette = COLORS[this.theme];
    (this.scene.background as THREE.Color).setHex(palette.wall);
    (this.scene.fog as THREE.Fog).color.setHex(palette.wall);
    (this.floor.material as THREE.MeshStandardMaterial).color.setHex(palette.floor);
    (this.wall.material as THREE.MeshStandardMaterial).color.setHex(palette.wall);
    this.creamMaterial.color.setHex(palette.cream);
    this.hemisphere.color.setHex(this.theme === "dark" ? 0xffd9a8 : 0xfff1dc);
    this.hemisphere.groundColor.setHex(this.theme === "dark" ? 0x1a120c : 0x3a2a1c);
    this.hemisphere.intensity = this.theme === "dark" ? 0.75 : 1.35;
    this.sun.intensity = this.theme === "dark" ? 1.5 : 2.7;
    this.lamp.intensity = this.theme === "dark" ? 26 : 18;
    this.boardMaterial.color.setHex(this.theme === "dark" ? 0x9b8a78 : 0xffffff);
    this.backMaterial.color.setHex(this.theme === "dark" ? 0x8a7c6c : 0xffffff);
  }

  setPerformanceMode(enabled: boolean): void {
    this.performanceMode = enabled;
    this.renderer.shadowMap.enabled = !enabled;
    this.sun.castShadow = !enabled;
    this.renderer.setPixelRatio(
      enabled ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    for (const view of this.cases.values()) {
      view.bodies.castShadow = !enabled;
      for (const item of view.items) if (item.spine) item.spine.castShadow = !enabled;
    }
    this.resize();
  }

  // ----------------------------------------------------------- camera

  resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const aspect = width / height;
    const vHalf = Math.tan((FOV * Math.PI) / 360);
    const needHeight = 5.1 / vHalf;
    const needWidth = 5.4 / (vHalf * Math.max(0.35, aspect));
    this.baseDistance = Math.max(needHeight, needWidth) * 1.04;
    this.updateCamera(0, true);
  }

  private updateCamera(dt: number, instant = false): void {
    const k = instant ? 1 : 1 - Math.pow(DAMP_BASE, dt);
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    this.zoom += (this.targetZoom - this.zoom) * k;
    this.caseFloat += (this.caseTarget - this.caseFloat) * k;
    const targetX = this.caseFloat * CASE_PITCH;
    const distance = this.baseDistance / this.zoom;
    const cosPitch = Math.cos(this.pitch);
    const x = targetX + Math.sin(this.yaw) * cosPitch * distance;
    const y = this.cameraTargetY + Math.sin(this.pitch) * distance;
    const z = Math.cos(this.yaw) * cosPitch * distance;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(targetX, this.cameraTargetY, 0);

    this.sun.position.set(targetX + 5.5, 11, 8);
    this.sun.target.position.set(targetX, 3.2, 0);
    this.sun.target.updateMatrixWorld();
    this.lamp.position.set(targetX - 3.4, 6.4, 3.4);
    this.floor.position.x = targetX;
    this.wall.position.x = targetX;
    const rounded = Math.round(this.caseFloat);
    if (rounded !== this.caseIndicator) {
      this.caseIndicator = rounded;
      this.callbacks.onCaseChange(rounded, this.caseCount);
      this.syncSpines();
    }
  }

  private updateCaseIndicator(): void {
    const rounded = Math.round(this.caseFloat);
    if (rounded !== this.caseIndicator) this.caseIndicator = rounded;
    this.callbacks.onCaseChange(rounded, this.caseCount);
  }

  goToCase(index: number): void {
    this.caseTarget = clamp(index, 0, this.caseCount - 1);
  }

  nextCase(): void {
    this.goToCase(Math.round(this.caseTarget) + 1);
  }

  prevCase(): void {
    this.goToCase(Math.round(this.caseTarget) - 1);
  }

  getCaseCount(): number {
    return this.caseCount;
  }

  // ---------------------------------------------------------- selection

  select(bookId: number | null, focus = false): void {
    if (bookId === null) {
      this.closeDetail();
      return;
    }
    const book = this.books[this.bookIndex.get(bookId) ?? -1];
    const slot = this.slots.get(bookId);
    if (!book || !slot) return;
    this.selectedId = bookId;
    if (focus) {
      this.caseTarget = slot.caseIndex;
    }
    this.rebuildDetail(bookId);
    this.callbacks.onSelect(bookId);
  }

  private rebuildDetail(bookId: number): void {
    const book = this.books[this.bookIndex.get(bookId) ?? -1];
    const slot = this.slots.get(bookId);
    if (!book || !slot) return;
    this.clearDetail();
    this.detailBook = book;
    const group = new THREE.Group();
    const t = slot.thickness;
    const h = slot.height;
    const d = slot.depth;

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(t, h, d),
      new THREE.MeshStandardMaterial({
        color: COLORS[this.theme].cream,
        roughness: 0.9,
      }),
    );
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const spineMat = new THREE.MeshStandardMaterial({
      map: textureFromCanvas(drawSpineTexture(book)),
      roughness: 0.8,
    });
    const spine = new THREE.Mesh(new THREE.PlaneGeometry(t, h), spineMat);
    spine.position.z = d / 2 + 0.001;
    spine.castShadow = true;
    group.add(spine);

    const coverMat = new THREE.MeshStandardMaterial({
      map: coverTexture(book),
      roughness: 0.85,
    });
    this.detailCoverTexture = coverMat.map;
    const cover = new THREE.Mesh(new THREE.PlaneGeometry(d, h), coverMat);
    cover.rotation.y = Math.PI / 2;
    cover.position.x = t / 2 + 0.002;
    cover.castShadow = true;
    group.add(cover);

    const backMat = new THREE.MeshStandardMaterial({
      color: 0xe4d8c0,
      roughness: 0.95,
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(d, h), backMat);
    back.rotation.y = -Math.PI / 2;
    back.position.x = -t / 2 - 0.002;
    group.add(back);

    const caseX = slot.caseIndex * CASE_PITCH;
    const basePos = this.shelfPosition({ book, slot, index: 0, spine: null });
    basePos.x += caseX;
    group.position.copy(basePos);
    this.scene.add(group);
    this.detail = group;
    this.clearHidden();

    const portrait = window.innerHeight > window.innerWidth * 1.15;
    const targetScale = portrait ? 1.35 : 2;
    const targetQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.04, -Math.PI / 2 + 0.22, 0.05),
    );
    this.detailState = {
      pos: basePos.clone(),
      target: new THREE.Vector3(caseX + FOCUS_POS.x, FOCUS_POS.y, FOCUS_POS.z),
      quat: new THREE.Quaternion(),
      targetQuat,
      scale: 1,
      targetScale,
      closing: false,
    };

    // Swap the generated cover for the real one once it decodes.
    if (book.coverUrl) {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin("anonymous");
      loader.load(
        book.coverUrl,
        (texture) => {
          if (this.detailBook?.id !== book.id) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 4;
          coverMat.map = texture;
          coverMat.needsUpdate = true;
          this.detailCoverTexture = texture;
        },
        undefined,
        () => {
          /* keep the generated cover */
        },
      );
    }

    // Restore from the shelf when the reader closes back onto an open card.
    if (this.reducedMotion) {
      this.detail.position.copy(this.detailState.target);
      this.detail.quaternion.copy(targetQuat);
      this.detail.scale.setScalar(targetScale);
      this.detailState.pos.copy(this.detailState.target);
      this.detailState.quat.copy(targetQuat);
      this.detailState.scale = targetScale;
    }
    this.hiddenIds.add(bookId);
    const hiddenSlot = this.slots.get(bookId);
    if (!hiddenSlot) return;
    const view = this.cases.get(hiddenSlot.caseIndex);
    const item = view?.items.find((i) => i.book.id === bookId);
    if (item?.spine) item.spine.visible = false;
  }

  private clearHidden(): void {
    for (const id of this.hiddenIds) {
      const slot = this.slots.get(id);
      if (!slot) continue;
      const view = this.cases.get(slot.caseIndex);
      const item = view?.items.find((i) => i.book.id === id);
      if (item?.spine) item.spine.visible = true;
    }
    this.hiddenIds.clear();
  }

  private closeDetail(instant = false): void {
    if (!this.detail || !this.detailState) {
      this.selectedId = null;
      return;
    }
    if (instant || this.reducedMotion) {
      this.selectedId = null;
      this.clearDetail();
      this.callbacks.onSelect(null);
      return;
    }
    const slot = this.selectedId !== null ? this.slots.get(this.selectedId) : undefined;
    if (slot) {
      const base = this.shelfPosition({
        book: this.detailBook!,
        slot,
        index: 0,
        spine: null,
      });
      base.x += slot.caseIndex * CASE_PITCH;
      this.detailState.target.copy(base);
      this.detailState.targetQuat.identity();
      this.detailState.targetScale = 1;
    }
    this.detailState.closing = true;
    this.selectedId = null;
    this.callbacks.onSelect(null);
  }

  private clearDetail(): void {
    if (this.detail) {
      this.scene.remove(this.detail);
      this.disposeGroup(this.detail);
      this.detail = null;
    }
    this.detailState = null;
    this.detailBook = null;
    this.detailCoverTexture = null;
    this.clearHidden();
  }

  getSelectedId(): number | null {
    return this.selectedId;
  }

  // --------------------------------------------------------- interaction

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    // Pointer capture keeps a drag alive outside the canvas. Some WebKitGTK
    // builds reject it for non-active pointers; that must not abort selection.
    try {
      this.renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
    const hit = this.pick(event.clientX, event.clientY) ?? this.hoverFallback(event);
    this.pointerDown = {
      x: event.clientX,
      y: event.clientY,
      bookId: hit,
      shift: event.shiftKey,
    };
    this.dragMoved = false;
    this.dragging = false;
    if (hit === null && event.shiftKey) {
      this.panning = true;
    } else if (hit === null) {
      this.orbiting = true;
    }
    this.renderer.domElement.style.cursor = hit !== null ? "pointer" : "grabbing";
  };

  private onPointerMove = (event: PointerEvent): void => {
    const down = this.pointerDown;
    if (down) {
      const dx = event.clientX - down.x;
      const dy = event.clientY - down.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 8) this.dragMoved = true;

      if (down.bookId !== null && this.dragMoved) {
        this.dragging = true;
        const targetIndex = this.indexAtScreenX(event.clientX);
        this.callbacks.onDrag(down.bookId, targetIndex, event.clientX, event.clientY);
      } else if (this.panning) {
        this.caseTarget = clamp(
          this.caseTarget - (event.movementX / this.container.clientWidth) * 1.4,
          0,
          this.caseCount - 1,
        );
        this.caseFloat = clamp(this.caseFloat, 0, this.caseCount - 1);
      } else if (this.orbiting) {
        this.targetYaw = clamp(this.targetYaw - event.movementX * 0.0042, -0.8, 0.8);
        this.targetPitch = clamp(this.targetPitch + event.movementY * 0.0032, -0.12, 0.5);
      }
      return;
    }
    // Hover: thumbnails pull out slightly and the shell shows a tooltip.
    const now = performance.now();
    if (now - this.lastPointerEvent < 35) return;
    this.lastPointerEvent = now;
    const hitId = this.pick(event.clientX, event.clientY);
    if (hitId !== this.hoverId) {
      if (this.hoverId !== null) {
        const state = this.states.get(this.hoverId);
        if (state) state.targetPull = 0;
      }
      this.hoverId = hitId;
      if (hitId !== null) {
        const state = this.states.get(hitId);
        if (state) state.targetPull = 0.2;
      }
      this.renderer.domElement.style.cursor = hitId !== null ? "pointer" : "grab";
    }
    this.hoverPoint =
      hitId === null ? null : { x: event.clientX, y: event.clientY, id: hitId };
    this.callbacks.onHover(hitId, event.clientX, event.clientY);
  };

  /** The book the pointer was over a moment ago, if it has not moved since. */
  private hoverFallback(event: PointerEvent): number | null {
    const hovered = this.hoverPoint;
    if (!hovered) return null;
    const still = Math.hypot(event.clientX - hovered.x, event.clientY - hovered.y) <= 4;
    return still ? hovered.id : null;
  }

  private onPointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    this.orbiting = false;
    this.panning = false;
    this.renderer.domElement.style.cursor = "grab";
    if (!down) return;
    if (this.dragging && down.bookId !== null) {
      this.dragging = false;
      const target = this.indexAtScreenX(event.clientX);
      this.callbacks.onReorder(down.bookId, target);
      return;
    }
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8;
    if (!moved) {
      if (down.bookId !== null) {
        this.select(down.bookId);
      } else if (this.selectedId !== null) {
        this.closeDetail();
      }
    }
  };

  private onPointerLeave = (): void => {
    if (this.hoverId !== null) {
      const state = this.states.get(this.hoverId);
      if (state) state.targetPull = 0;
      this.hoverId = null;
    }
    this.callbacks.onHover(null, 0, 0);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2) {
      this.caseTarget = clamp(
        this.caseTarget + event.deltaX * 0.0022,
        0,
        this.caseCount - 1,
      );
      return;
    }
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    this.targetZoom = clamp(this.targetZoom - delta * 0.0006, 0.55, 1.15);
  };

  /** Pick a visible book under the pointer (instance id for bodies, mesh for spines). */
  private pick(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets: THREE.Object3D[] = [];
    for (const view of this.cases.values()) {
      if (!view.spinesBuilt) continue;
      for (const item of view.items) {
        if (item.spine?.visible) targets.push(item.spine);
      }
    }
    const hits = this.raycaster.intersectObjects(targets, false);
    const first = hits[0];
    if (!first) return null;
    const id: unknown = first.object.userData.bookId;
    return typeof id === "number" ? id : null;
  }

  /** Insertion index in display order from a screen x position. */
  private indexAtScreenX(clientX: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = new THREE.Vector3();
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const view of this.cases.values()) {
      if (!view.spinesBuilt) continue;
      for (const item of view.items) {
        const state = this.states.get(item.book.id);
        if (!state) continue;
        project.copy(state.pos);
        project.x += view.index * CASE_PITCH;
        project.project(this.camera);
        const screenX = rect.left + ((project.x + 1) / 2) * rect.width;
        const distance = Math.abs(screenX - clientX);
        if (distance < bestDistance) {
          bestDistance = distance;
          const index = this.bookIndex.get(item.book.id) ?? 0;
          bestIndex = screenX > clientX ? index : index + 1;
        }
      }
    }
    return bestIndex;
  }

  focusBook(bookId: number): void {
    this.select(bookId, true);
  }

  panToBook(bookId: number): void {
    const slot = this.slots.get(bookId);
    if (slot) this.caseTarget = slot.caseIndex;
  }

  /**
   * Search dimming: books outside `ids` keep their place but lose their light,
   * so matches stand out. `null` restores full lighting.
   */
  setSearchMatch(ids: Set<number> | null): void {
    this.searchIds = ids;
    this.applySearchDim();
  }

  private applySearchDim(): void {
    const white = new THREE.Color(1, 1, 1);
    const dim = new THREE.Color(0.34, 0.34, 0.36);
    for (const view of this.cases.values()) {
      view.items.forEach((item, index) => {
        const muted = this.searchIds !== null && !this.searchIds.has(item.book.id);
        view.bodies.setColorAt(index, muted ? dim : white);
        if (item.spine) {
          const material = item.spine.material as THREE.MeshStandardMaterial;
          material.color.setScalar(muted ? 0.45 : 1);
        }
      });
      if (view.bodies.instanceColor) view.bodies.instanceColor.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ animation

  private update(dt: number): void {
    const k = 1 - Math.pow(DAMP_BASE, Math.min(dt, 0.1));
    this.updateCamera(dt);
    // Finish drawing this frame's slice of the remaining spine textures.
    for (const view of this.cases.values()) {
      if (view.spinesBuilt && view.spineCursor < view.items.length) {
        this.pumpSpines(view, SPINES_PER_FRAME);
      }
    }

    const current = Math.round(this.caseFloat);
    for (const [caseIndex, view] of this.cases) {
      const animate = Math.abs(caseIndex - current) <= 1;
      for (const item of view.items) {
        const state = this.states.get(item.book.id);
        if (!state) continue;
        if (animate) {
          state.pos.lerp(state.target, k);
          state.quat.slerp(state.targetQuat, k);
        } else {
          state.pos.copy(state.target);
          state.quat.copy(state.targetQuat);
        }
        state.pull += (state.targetPull - state.pull) * k;
        const hidden = this.hiddenIds.has(item.book.id);
        this.dummy.position.copy(state.pos);
        this.dummy.position.z += state.pull;
        this.dummy.quaternion.copy(state.quat);
        this.dummy.scale.set(
          hidden ? 0 : item.slot.thickness,
          hidden ? 0 : item.slot.height,
          hidden ? 0 : item.slot.depth,
        );
        this.dummy.updateMatrix();
        view.bodies.setMatrixAt(item.index, this.dummy.matrix);

        if (item.spine) {
          const spine = this.spinePosition(item);
          const shift = state.pos.clone().sub(state.target);
          spine.add(shift);
          spine.z += state.pull;
          item.spine.position.copy(spine);
          item.spine.quaternion.copy(state.quat);
          item.spine.scale.set(item.slot.thickness, item.slot.height, 1);
          item.spine.visible = !hidden;
        }
      }
      view.bodies.instanceMatrix.needsUpdate = true;
    }

    if (this.detail && this.detailState) {
      const d = this.detailState;
      d.pos.lerp(d.target, k);
      d.quat.slerp(d.targetQuat, k);
      d.scale += (d.targetScale - d.scale) * k;
      this.detail.position.copy(d.pos);
      this.detail.quaternion.copy(d.quat);
      this.detail.scale.setScalar(d.scale);
      if (d.closing && d.pos.distanceTo(d.target) < 0.015) {
        this.clearDetail();
      }
    }
  }

  private loop = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const frameStart = performance.now();
    this.update(dt);
    this.renderer.render(this.scene, this.camera);
    const frameMs = performance.now() - frameStart;
    this.sampleFrame(frameMs);
  };

  private sampleFrame(frameMs: number): void {
    if (this.slowReported || this.performanceMode) return;
    this.frameSamples.push(frameMs);
    if (this.frameSamples.length > 240) this.frameSamples.shift();
    if (this.frameSamples.length < 120) return;
    const avg = this.frameSamples.reduce((a, b) => a + b, 0) / this.frameSamples.length;
    if (avg > 24) {
      this.slowReported = true;
      this.callbacks.onSlowFrame(avg);
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      this.clock.getDelta();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  // --------------------------------------------------------------- misc

  /** Dispose per-case/per-detail geometry and materials, but never the
   *  shared wood textures, shared geometries or textures owned by SpineCache. */
  private disposeGroup(group: THREE.Object3D): void {
    group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      const map = material.map;
      if (
        map &&
        map !== this.woodTexture &&
        map !== this.darkWoodTexture &&
        map === this.detailCoverTexture
      ) {
        map.dispose();
      }
      if (mesh.geometry !== this.bodyGeometry && mesh.geometry !== this.spineGeometry) {
        mesh.geometry.dispose();
      }
      if (material !== this.creamMaterial && material !== this.boardMaterial && material !== this.backMaterial) {
        material.dispose();
      }
    });
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener("pointerdown", this.onPointerDown);
    dom.removeEventListener("pointermove", this.onPointerMove);
    dom.removeEventListener("pointerup", this.onPointerUp);
    dom.removeEventListener("pointercancel", this.onPointerUp);
    dom.removeEventListener("pointerleave", this.onPointerLeave);
    dom.removeEventListener("wheel", this.onWheel);
    this.clearDetail();
    for (const view of this.cases.values()) {
      this.scene.remove(view.group);
      this.disposeGroup(view.group);
    }
    this.cases.clear();
    this.spineCache.dispose();
    this.woodTexture.dispose();
    this.darkWoodTexture.dispose();
    this.bodyGeometry.dispose();
    this.spineGeometry.dispose();
    this.creamMaterial.dispose();
    this.boardMaterial.dispose();
    this.backMaterial.dispose();
    (this.floor.material as THREE.Material).dispose();
    (this.floor.geometry).dispose();
    (this.wall.material as THREE.Material).dispose();
    (this.wall.geometry).dispose();
    this.renderer.dispose();
    dom.remove();
  }
}
