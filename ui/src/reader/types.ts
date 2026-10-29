import type { Annotation, Locator, Settings } from "../lib/api";
import type { TocEntry } from "../bindings";
import type { ReaderTheme } from "../lib/theme";

export type PanelKind = "toc" | "thumbs" | "bookmarks" | "notes" | "search" | "appearance";

export interface SearchHit {
  id: string;
  label: string;
  excerpt: string;
  locator: Locator;
  query?: string;
}

export interface SelectionPayload {
  locator: Locator;
  quote: string;
  anchorRect: { x: number; y: number };
}

export interface AdapterCallbacks {
  onProgress(locator: Locator, progress: number): void;
  onSelection(payload: SelectionPayload): void;
  onToc(entries: TocEntry[]): void;
  onPageCount(count: number): void;
  onNotice(message: string): void;
  onError(message: string): void;
  onLink(url: string): void;
  onImage(src: string, alt: string): void;
  onPasswordRequest(reason: string): Promise<string | null>;
  onHistory?(depth: number): void;
}

export interface ReaderAdapter {
  readonly kind: "pdf" | "epub";
  mount(stage: HTMLElement): Promise<void>;
  destroy(): void;

  next(): void;
  prev(): void;
  goTo(locator: Locator | null): Promise<void>;
  locator(): Locator;
  progress(): number;
  goToFraction(fraction: number): void;
  statusText(): string;
  heading(): string;
  minutesLeft(): number;
  toc(): TocEntry[];

  search(query: string): Promise<SearchHit[]>;
  revealSearch(hit: SearchHit): Promise<void>;

  setPrefs(settings: Settings): Promise<void>;
  applyTheme(theme: ReaderTheme): void;
  setAnnotations(annotations: Annotation[]): void;
  refreshAnnotations(): void;

  downloadThumbnail?(page: number, width: number): Promise<string | null>;
  renderPanel?(container: HTMLElement, kind: PanelKind): boolean;

  zoomIn?(): void;
  zoomOut?(): void;
  rotate?(): void;
  toggleNight?(): void;
  fitTo?(mode: "width" | "page" | "actual"): void;
  zoomLabel?(): string;
  clearSelection?(): void;
  flushProgress?(): void;
  goBack?(): void;
}
