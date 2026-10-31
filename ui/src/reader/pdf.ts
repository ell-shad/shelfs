// PDF renderer built on pdf.js. Pages are virtualised: only pages near the
// viewport keep a canvas and text layer, so a 1,000-page book stays inside a
// bounded memory budget. Selection uses pdf.js's text layer, never an image.

import {
  GlobalWorkerOptions,
  getDocument,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Annotation, Book, Locator, Settings } from "../lib/api";
import { api } from "../lib/api";
import type { TocEntry } from "../bindings";
import { buildTextIndex, locateQueryNear, offsetsToRange } from "./anchor";
import { wrapRange, unwrap } from "./epub";
import type { PageViewport } from "pdfjs-dist";
import type { AdapterCallbacks, PanelKind, ReaderAdapter, SearchHit } from "./types";
import { readerPalette } from "../lib/theme";
import type { ReaderTheme } from "../lib/theme";

GlobalWorkerOptions.workerSrc = workerUrl;

type FitMode = "width" | "page" | "actual" | "custom";

interface PageView {
  page: number;
  el: HTMLElement;
  textLayer: HTMLElement;
  canvas: HTMLCanvasElement;
  task: RenderTask | null;
  pageProxy: PDFPageProxy;
}

interface Slot {
  el: HTMLElement;
  page: number;
}

const MAX_CACHED_THUMBS = 240;
const ACTUAL_SIZE = 96 / 72;

/** The subset of pdf.js annotation data this reader draws. */
interface PdfAnnotationInfo {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: unknown;
  fieldValue?: string | string[];
}

/** The subset of a pdf.js outline entry this reader walks. */
interface PdfOutlineItem {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
}

/** pdf.js types this return as `any[]`; validate before using the numbers. */
function convertPoint(viewport: PageViewport, x: number, y: number): [number, number] {
  const point: unknown[] = viewport.convertToViewportPoint(x, y);
  const first = point[0];
  const second = point[1];
  return [typeof first === "number" ? first : x, typeof second === "number" ? second : y];
}

export class PdfReader implements ReaderAdapter {
  readonly kind = "pdf" as const;

  private readonly book: Book;
  private readonly callbacks: AdapterCallbacks;

  private stage: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private doc: PDFDocumentProxy | null = null;
  private loadingTask: ReturnType<typeof getDocument> | null = null;

  private views = new Map<number, PageView>();
  private slots: Slot[] = [];
  private observer: IntersectionObserver | null = null;
  private renderChain: Promise<void> = Promise.resolve();
  private generation = 0;

  private prefs: Settings["reader"]["pdf"];
  private theme: ReaderTheme;
  private night: boolean;
  private layout: "single" | "continuous" | "spread";
  private fitMode: FitMode;
  private scale = ACTUAL_SIZE;
  private baseSize = { width: 612, height: 792 };
  private rotation = 0;
  private current = 1;
  private numPages = 0;
  private mounted = false;
  private perf = false;

  private annotations: Annotation[] = [];
  private marks = new Map<number, HTMLElement[]>();
  private findMarks: HTMLElement[] = [];
  private outline: TocEntry[] = [];
  private thumbCache = new Map<number, string>();
  private scrollFrame = 0;

  constructor(opts: {
    book: Book;
    settings: Settings;
    callbacks: AdapterCallbacks;
    theme: ReaderTheme;
    performanceMode: boolean;
  }) {
    this.book = opts.book;
    this.callbacks = opts.callbacks;
    this.theme = opts.theme;
    this.prefs = opts.settings.reader.pdf;
    this.layout = opts.settings.reader.pdf.layout;
    this.night = opts.settings.reader.pdf.nightMode;
    this.perf = opts.performanceMode;
    const zoom = opts.settings.reader.pdf.zoom;
    const fit = opts.settings.reader.pdf.fit as FitMode;
    this.fitMode = zoom ? "custom" : ["width", "page", "actual"].includes(fit) ? fit : "page";
    if (this.fitMode === "custom") this.scale = zoom ?? ACTUAL_SIZE;
  }

  async mount(stage: HTMLElement): Promise<void> {
    this.stage = stage;
    this.mounted = true;
    this.scroller = document.createElement("div");
    this.scroller.className = "pdf-scroll";
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute("role", "region");
    this.scroller.setAttribute("aria-label", this.book.title || "PDF");
    stage.appendChild(this.scroller);

    let data: Uint8Array;
    try {
      data = await api.pdfBytes(this.book.id);
    } catch (error) {
      this.callbacks.onError(`Could not read this PDF: ${message(error)}`);
      return;
    }
    if (!this.mounted) return;
    const loadingTask = getDocument({
      data,
      enableXfa: false,
      disableAutoFetch: false,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
    });
    this.loadingTask = loadingTask;
    loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
      const prompt = reason === 1 ? "need-to-decrypt-pdf" : "incorrect-password";
      void this.callbacks.onPasswordRequest(prompt).then((password) => {
        if (password) updatePassword(password);
        else void loadingTask.destroy();
      });
    };
    try {
      this.doc = await loadingTask.promise;
    } catch (error) {
      this.callbacks.onError(
        error instanceof Error && error.name === "PasswordException"
          ? "This PDF is password protected."
          : `Could not open this PDF: ${message(error)}`,
      );
      return;
    }
    if (!this.mounted) return;
    this.numPages = this.doc.numPages;
    this.callbacks.onPageCount(this.numPages);
    this.outline = await this.buildOutline();
    this.callbacks.onToc(this.outline);
    await this.rebuild(1);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    this.scroller.addEventListener("mouseup", () => this.reportSelection());
  }

  destroy(): void {
    this.mounted = false;
    this.generation += 1;
    this.observer?.disconnect();
    this.views.forEach((view) => {
      view.task?.cancel();
      view.el.remove();
    });
    this.views.clear();
    void this.loadingTask?.destroy();
    this.scroller?.remove();
  }

  // ------------------------------------------------------------ navigation

  next(): void {
    if (this.layout === "continuous") {
      this.scroller?.scrollBy({ top: this.viewportHeight() * 0.9, behavior: "smooth" });
      return;
    }
    this.setCurrent(this.current + (this.layout === "spread" ? 2 : 1));
  }

  prev(): void {
    if (this.layout === "continuous") {
      this.scroller?.scrollBy({ top: -this.viewportHeight() * 0.9, behavior: "smooth" });
      return;
    }
    this.setCurrent(this.current - (this.layout === "spread" ? 2 : 1));
  }

  async goTo(locator: Locator | null): Promise<void> {
    if (!locator || locator.kind !== "pdf") {
      await this.rebuild(1);
      return;
    }
    this.setCurrent(locator.page);
  }

  locator(): Locator {
    const offset = this.layout === "continuous" ? this.withinPage() : 0;
    return { kind: "pdf", page: this.current, offset };
  }

  progress(): number {
    if (!this.numPages) return 0;
    const within = this.layout === "continuous" ? this.withinPage() : 0;
    return Math.min(1, (this.current - 1 + within) / this.numPages);
  }

  goToFraction(fraction: number): void {
    if (!this.numPages) return;
    const page = Math.max(1, Math.min(this.numPages, Math.round(fraction * (this.numPages - 1)) + 1));
    this.setCurrent(page);
  }

  statusText(): string {
    return this.numPages ? `${this.current} / ${this.numPages}` : "";
  }

  heading(): string {
    return `Page ${this.current}`;
  }

  minutesLeft(): number {
    const remaining = Math.max(0, this.numPages - this.current);
    return Math.max(1, Math.round(remaining * 1.1));
  }

  toc(): TocEntry[] {
    return this.outline;
  }

  // -------------------------------------------------------------- searching

  async search(query: string): Promise<SearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle || !this.doc) return [];
    const hits: SearchHit[] = [];
    for (let page = 1; page <= this.numPages && hits.length < 300; page += 1) {
      const pageProxy = await this.doc.getPage(page);
      const content = await pageProxy.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ");
      const lower = text.toLowerCase();
      let from = 0;
      let perPage = 0;
      while (perPage < 5) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        hits.push({
          id: `p${page}:${at}`,
          label: `Page ${page}`,
          excerpt: text.slice(Math.max(0, at - 48), Math.min(text.length, at + needle.length + 64)),
          locator: { kind: "pdf", page, offset: at / Math.max(1, text.length) },
          query,
        });
        from = at + needle.length;
        perPage += 1;
      }
    }
    return hits;
  }

  async revealSearch(hit: SearchHit): Promise<void> {
    if (hit.locator.kind !== "pdf") return;
    this.setCurrent(hit.locator.page);
    const page = hit.locator.page;
    await this.renderQueueFlush();
    const target = this.views.get(page);
    if (!target) return;
    this.clearFind();
    const index = buildTextIndex(target.textLayer);
    const approximate = Math.round((hit.locator.offset ?? 0) * index.text.length);
    const found = locateQueryNear(index.text, hit.query ?? "", approximate);
    if (!found) {
      target.el.classList.add("pdf-flash");
      window.setTimeout(() => target.el.classList.remove("pdf-flash"), 900);
      return;
    }
    const range = offsetsToRange(index, found.start, found.end);
    if (!range) return;
    this.findMarks = wrapRange(range, "bs-find bs-find-current");
    this.findMarks[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private clearFind(): void {
    for (const mark of this.findMarks) unwrap(mark);
    this.findMarks = [];
  }

  // ------------------------------------------------------------------ prefs

  async setPrefs(settings: Settings): Promise<void> {
    const next = settings.reader.pdf;
    const previous = this.prefs;
    this.prefs = next;
    const layoutChanged = previous.layout !== next.layout;
    const nightChanged = previous.nightMode !== next.nightMode;
    const fitChanged = previous.fit !== next.fit || previous.zoom !== next.zoom;
    this.night = next.nightMode;
    if (layoutChanged) this.layout = next.layout;
    if (fitChanged) {
      const zoom = next.zoom;
      const fit = next.fit as FitMode;
      this.fitMode = zoom ? "custom" : ["width", "page", "actual"].includes(fit) ? fit : "page";
      if (this.fitMode === "custom") this.scale = zoom ?? ACTUAL_SIZE;
    }
    if (layoutChanged || fitChanged) {
      // Rebuilt pages pick up the night class themselves (see renderPage), so
      // an appearance change can no longer switch night mode off.
      await this.rebuild(this.current);
    } else {
      this.applyThemeClass();
      if (nightChanged) this.repaintVisible();
    }
  }

  applyTheme(theme: ReaderTheme): void {
    this.theme = theme;
    this.applyThemeClass();
  }

  setAnnotations(annotations: Annotation[]): void {
    this.annotations = annotations;
    this.repaintVisible();
  }

  refreshAnnotations(): void {
    this.repaintVisible();
  }

  // ----------------------------------------------------------------- zooming

  zoomIn(): void {
    this.fitMode = "custom";
    this.scale = Math.min(6, this.scale * 1.2);
    void this.rebuild(this.current);
  }

  zoomOut(): void {
    this.fitMode = "custom";
    this.scale = Math.max(0.2, this.scale / 1.2);
    void this.rebuild(this.current);
  }

  fitTo(mode: "width" | "page" | "actual"): void {
    this.fitMode = mode;
    void this.rebuild(this.current);
  }

  rotate(): void {
    this.rotation = (this.rotation + 90) % 360;
    void this.rebuild(this.current);
  }

  toggleNight(): void {
    this.night = !this.night;
    this.applyThemeClass();
    this.repaintVisible();
  }

  zoomLabel(): string {
    return `${Math.round((this.scale / ACTUAL_SIZE) * 100)}%`;
  }

  // -------------------------------------------------------------- thumbnails

  async downloadThumbnail(page: number, width: number): Promise<string | null> {
    const cached = this.thumbCache.get(page);
    if (cached) return cached;
    if (!this.doc) return null;
    try {
      const proxy = await this.doc.getPage(page);
      const base = proxy.getViewport({ scale: 1, rotation: this.rotation });
      const scale = width / base.width;
      const viewport = proxy.getViewport({ scale, rotation: this.rotation });
      const canvas = document.createElement("canvas");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      const context = canvas.getContext("2d");
      if (!context) return null;
      await proxy.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: [dpr, 0, 0, dpr, 0, 0],
        intent: "display",
        background: "#ffffff",
      }).promise;
      const url = canvas.toDataURL("image/jpeg", 0.7);
      this.thumbCache.set(page, url);
      if (this.thumbCache.size > MAX_CACHED_THUMBS) {
        const oldest = this.thumbCache.keys().next().value;
        if (oldest !== undefined) this.thumbCache.delete(oldest);
      }
      return url;
    } catch {
      return null;
    }
  }

  renderPanel(container: HTMLElement, kind: PanelKind): boolean {
    if (kind !== "thumbs") return false;
    container.replaceChildren();
    container.classList.add("thumb-grid");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const button = entry.target as HTMLElement;
          const page = Number(button.dataset.page);
          observer.unobserve(button);
          void this.downloadThumbnail(page, 148).then((url) => {
            if (url && button.isConnected) {
              const img = document.createElement("img");
              img.src = url;
              img.alt = "";
              img.decoding = "async";
              button.querySelector("span")?.replaceWith(img);
            }
          });
        }
      },
      { root: container, rootMargin: "300px 0px" },
    );
    for (let page = 1; page <= this.numPages; page += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumb";
      button.dataset.page = String(page);
      if (page === this.current) button.classList.add("active");
      const placeholder = document.createElement("span");
      placeholder.className = "thumb-placeholder";
      placeholder.textContent = String(page);
      button.appendChild(placeholder);
      button.setAttribute("aria-label", `Page ${page}`);
      button.addEventListener("click", () => this.setCurrent(page));
      container.appendChild(button);
      observer.observe(button);
    }
    return true;
  }

  // --------------------------------------------------------------- rendering

  private viewportHeight(): number {
    return this.scroller?.clientHeight || this.stage?.clientHeight || 600;
  }

  private async rebuild(page: number): Promise<void> {
    if (!this.doc || !this.scroller) return;
    const generation = ++this.generation;
    this.observer?.disconnect();
    this.clearViews();
    this.scroller.replaceChildren();
    this.scroller.dataset.layout = this.layout;
    this.marks.clear();
    this.findMarks = [];

    const first = await this.doc.getPage(1);
    if (generation !== this.generation) return;
    const base = first.getViewport({ scale: 1, rotation: this.rotation });
    this.baseSize = { width: base.width, height: base.height };
    this.scale = this.computeScale();
    this.applyThemeClass();
    this.current = Math.max(1, Math.min(this.numPages, page));

    if (this.layout === "continuous") {
      this.buildSlots();
      const slot = this.slots[this.current - 1];
      if (slot) {
        this.scroller.scrollTop = slot.el.offsetTop - 8;
        void this.renderPage(this.current);
      }
    } else {
      await this.renderSpread(this.current);
    }
    this.emitProgress();
  }

  private computeScale(): number {
    const stage = this.stage;
    const padding = this.layout === "continuous" ? 40 : 48;
    const width = Math.max(220, (stage?.clientWidth ?? 800) - padding * 2);
    const height = Math.max(220, (stage?.clientHeight ?? 800) - padding);
    const pages = this.layout === "spread" ? 2 : 1;
    const usable = width / pages - (pages > 1 ? 8 : 0);
    const swap = this.rotation % 180 === 0 ? this.baseSize : { width: this.baseSize.height, height: this.baseSize.width };
    if (this.fitMode === "width") return usable / swap.width;
    if (this.fitMode === "page") return Math.min(usable / swap.width, height / swap.height);
    if (this.fitMode === "actual") return ACTUAL_SIZE;
    return Math.max(0.2, Math.min(6, this.scale));
  }

  private buildSlots(): void {
    if (!this.scroller) return;
    this.slots = [];
    const ratio = this.baseSize.height / this.baseSize.width;
    const width = this.baseSize.width * this.scale;
    const height = this.baseSize.height * this.scale;
    for (let page = 1; page <= this.numPages; page += 1) {
      const slot = document.createElement("div");
      slot.className = "pdf-slot";
      slot.dataset.page = String(page);
      slot.style.width = `${width}px`;
      slot.style.height = `${height}px`;
      slot.style.setProperty("--page-ratio", String(ratio));
      this.scroller.appendChild(slot);
      this.slots.push({ el: slot, page });
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) void this.renderPage(page);
          else if (Math.abs(page - this.current) > 2) this.destroyPage(page);
        }
      },
      { root: this.scroller, rootMargin: "800px 0px 800px 0px" },
    );
    for (const slot of this.slots) this.observer.observe(slot.el);
  }

  private async renderSpread(page: number): Promise<void> {
    if (!this.scroller) return;
    this.current = Math.max(1, Math.min(this.numPages, page));
    if (this.layout === "spread" && this.current % 2 === 0 && this.current > 1) this.current -= 1;
    this.clearViews();
    const holder = document.createElement("div");
    holder.className = `pdf-holder ${this.layout}`;
    this.scroller.appendChild(holder);
    const count = this.layout === "spread" && this.current < this.numPages ? 2 : 1;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < count; i += 1) {
      const target = this.current + i;
      tasks.push(this.renderPage(target, holder, true));
    }
    holder.querySelector(".pdf-slot")?.classList.add("current");
    await Promise.all(tasks);
    this.emitProgress();
  }

  private renderPage(page: number, container?: HTMLElement, single = false): Promise<void> {
    const run = async () => {
      if (!this.doc || !this.mounted) return;
      if (this.views.has(page)) return;
      const holder =
        container ?? this.slots[page - 1]?.el ?? (this.scroller);
      if (!holder) return;
      let proxy: PDFPageProxy;
      try {
        proxy = await this.doc.getPage(page);
      } catch {
        return;
      }
      if (!this.mounted) return;
      const viewport = proxy.getViewport({ scale: this.scale, rotation: this.rotation });
      const dpr = Math.min(window.devicePixelRatio || 1, this.perf ? 1.5 : 2);
      const el = document.createElement("div");
      el.className = "pdf-page";
      // Pages are rebuilt whenever the layout, zoom or rotation changes; night
      // mode has to be applied to the new element too, otherwise changing any
      // appearance setting silently turned it off.
      el.classList.toggle("night", this.night);
      el.dataset.page = String(page);
      el.style.width = `${viewport.width}px`;
      el.style.height = `${viewport.height}px`;
      el.style.setProperty("--total-scale-factor", String(this.scale));
      el.style.setProperty("--scale-round-x", "1px");
      el.style.setProperty("--scale-round-y", "1px");
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      el.appendChild(canvas);
      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      el.appendChild(textLayer);
      const links = document.createElement("div");
      links.className = "pdf-links";
      el.appendChild(links);
      holder.appendChild(el);
      if (single) holder.classList.add("pdf-holder");

      const view: PageView = { page, el, textLayer, canvas, task: null, pageProxy: proxy };
      this.views.set(page, view);
      try {
        const task = proxy.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [dpr, 0, 0, dpr, 0, 0],
          intent: "display",
          background: "#ffffff",
        });
        view.task = task;
        await task.promise;
      } catch (error) {
        if (error instanceof Error && error.name === "RenderingCancelledException") return;
        el.classList.add("pdf-broken");
        el.textContent = "This page could not be rendered.";
        return;
      }
      if (!this.mounted || !el.isConnected) return;
      try {
        const textLayerTask = new TextLayer({
          textContentSource: proxy.streamTextContent(),
          container: textLayer,
          viewport,
        });
        await textLayerTask.render();
      } catch {
        // A missing text layer only costs selection; the page still reads.
      }
      if (!this.mounted) return;
      await this.renderLinks(proxy, viewport, links);
      this.paintHighlights(page);
      if (single) el.classList.add("current");
    };
    this.renderChain = this.renderChain.then(run, run);
    return this.renderChain;
  }

  private async renderLinks(
    proxy: PDFPageProxy,
    viewport: PageViewport,
    layer: HTMLElement,
  ): Promise<void> {
    let annotations: PdfAnnotationInfo[];
    try {
      const raw: unknown = await proxy.getAnnotations({ intent: "display" });
      annotations = Array.isArray(raw) ? (raw as PdfAnnotationInfo[]) : [];
    } catch {
      return;
    }
    for (const annotation of annotations) {
      const rect = annotation.rect;
      if (!rect || rect.length < 4) continue;
      const [r0, r1, r2, r3] = rect;
      if (r0 === undefined || r1 === undefined || r2 === undefined || r3 === undefined) continue;
      const [ax, ay] = convertPoint(viewport, r0, r1);
      const [bx, by] = convertPoint(viewport, r2, r3);
      const left = Math.min(ax, bx);
      const top = Math.min(ay, by);
      const width = Math.abs(bx - ax);
      const height = Math.abs(by - ay);
      if (width < 1 || height < 1) continue;
      if (annotation.subtype === "Link") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pdf-link";
        button.style.left = `${left}px`;
        button.style.top = `${top}px`;
        button.style.width = `${width}px`;
        button.style.height = `${height}px`;
        const url = annotation.url;
        const dest = annotation.dest;
        button.setAttribute("aria-label", url ? `Link: ${url}` : "Internal link");
        button.addEventListener("click", () => {
          if (url) {
            this.callbacks.onLink(url);
          } else if (dest) {
            void this.resolveDestination(dest).then((page) => {
              if (page) this.setCurrent(page);
            });
          }
        });
        layer.appendChild(button);
      } else if (annotation.subtype === "Widget") {
        const field = document.createElement("div");
        field.className = "pdf-widget";
        field.style.left = `${left}px`;
        field.style.top = `${top}px`;
        field.style.width = `${width}px`;
        field.style.height = `${height}px`;
        const value = annotation.fieldValue;
        field.textContent = Array.isArray(value) ? value.join(", ") : value ?? "";
        field.title = "Form field (read-only)";
        layer.appendChild(field);
      }
    }
  }

  private async resolveDestination(dest: unknown): Promise<number | null> {
    if (!this.doc) return null;
    try {
      const resolved = typeof dest === "string" ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(resolved) || resolved.length === 0) return null;
      const ref: unknown = resolved[0];
      if (typeof ref === "number") return Math.max(1, ref + 1);
      const index = await this.doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
      return index + 1;
    } catch {
      return null;
    }
  }

  private clearViews(): void {
    for (const view of this.views.values()) {
      view.task?.cancel();
      view.el.remove();
    }
    this.views.clear();
  }

  private destroyPage(page: number): void {
    const view = this.views.get(page);
    if (!view) return;
    view.task?.cancel();
    view.el.remove();
    this.views.delete(page);
  }

  private repaintVisible(): void {
    for (const page of this.views.keys()) this.paintHighlights(page);
  }

  private paintHighlights(page: number): void {
    const view = this.views.get(page);
    if (!view) return;
    const existing = this.marks.get(page);
    if (existing) for (const mark of existing) unwrap(mark);
    this.marks.set(page, []);
    if (!this.annotations.length) return;
    const index = buildTextIndex(view.textLayer);
    if (!index.text) return;
    const marks: HTMLElement[] = [];
    for (const annotation of this.annotations) {
      if (annotation.locator.kind !== "pdf" || annotation.locator.page !== page) continue;
      const quote = annotation.quote.trim();
      if (!quote) continue;
      const at = index.text.indexOf(quote);
      if (at < 0) continue;
      const range = offsetsToRange(index, at, at + quote.length);
      if (!range) continue;
      const spans = wrapRange(range, `bs-hl hl-${annotation.color}`);
      for (const span of spans) {
        span.dataset.annotationId = String(annotation.id);
        span.title = annotation.note || annotation.quote;
      }
      marks.push(...spans);
    }
    this.marks.set(page, marks);
  }

  // ------------------------------------------------------------- scrolling

  private onScroll(): void {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      if (!this.scroller) return;
      const middle = this.scroller.scrollTop + this.scroller.clientHeight * 0.4;
      let current = this.current;
      for (const slot of this.slots) {
        if (slot.el.offsetTop <= middle) current = slot.page;
        else break;
      }
      if (current !== this.current) {
        this.current = current;
        this.emitProgress();
      } else {
        this.emitProgress();
      }
    });
  }

  private withinPage(): number {
    const slot = this.slots[this.current - 1];
    if (!slot || !this.scroller) return 0;
    const height = slot.el.offsetHeight || 1;
    return Math.max(0, Math.min(0.999, (this.scroller.scrollTop - slot.el.offsetTop) / height));
  }

  private setCurrent(page: number): void {
    const target = Math.max(1, Math.min(this.numPages, page));
    if (this.layout === "continuous") {
      const slot = this.slots[target - 1];
      if (slot && this.scroller) {
        this.scroller.scrollTo({ top: slot.el.offsetTop - 8, behavior: "smooth" });
        this.current = target;
        this.emitProgress();
      }
      return;
    }
    if (target === this.current && this.views.size) return;
    void this.renderSpread(target);
  }

  private reportSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const anchorNode = range.startContainer;
    const element = (anchorNode.nodeType === Node.ELEMENT_NODE
      ? (anchorNode as Element)
      : anchorNode.parentElement);
    const pageEl = element?.closest(".pdf-page") as HTMLElement | null;
    if (!pageEl) return;
    const page = Number(pageEl.dataset.page);
    const quote = range.toString().trim();
    if (!quote) return;
    const pageRect = pageEl.getBoundingClientRect();
    const rect = range.getBoundingClientRect();
    const offset = Math.max(0, Math.min(1, (rect.top - pageRect.top) / pageRect.height));
    this.callbacks.onSelection({
      locator: { kind: "pdf", page, offset },
      quote: quote.slice(0, 2000),
      anchorRect: { x: rect.left, y: rect.bottom },
    });
  }

  // ------------------------------------------------------------------ theme

  private applyThemeClass(): void {
    for (const view of this.views.values()) {
      view.el.classList.toggle("night", this.night);
    }
    if (this.stage) this.stage.dataset.theme = this.theme;
  }

  private emitProgress(): void {
    this.callbacks.onProgress(this.locator(), this.progress());
    if (this.stage) {
      const palette = readerPalette(this.theme, matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      this.stage.style.setProperty("--pdf-bg", palette.bg);
    }
  }

  private renderQueueFlush(): Promise<void> {
    return this.renderChain;
  }

  clearSelection(): void {
    window.getSelection()?.removeAllRanges();
  }

  private async buildOutline(): Promise<TocEntry[]> {
    if (!this.doc) return [];
    let outline: PdfOutlineItem[] | null;
    try {
      const raw: unknown = await this.doc.getOutline();
      outline = Array.isArray(raw) ? (raw as PdfOutlineItem[]) : null;
    } catch {
      return [];
    }
    if (!outline) return [];
    const entries: TocEntry[] = [];
    const walk = async (items: PdfOutlineItem[], level: number): Promise<void> => {
      for (const item of items) {
        if (entries.length >= 400) return;
        const page = item.dest ? await this.resolveDestination(item.dest) : null;
        entries.push({ label: item.title || "Untitled", href: null, page, level });
        if (item.items?.length) await walk(item.items, level + 1);
      }
    };
    await walk(outline, 0);
    return entries;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
