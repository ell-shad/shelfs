import { commands } from "../bindings";
import type {
  Annotation_Serialize,
  AppInfo,
  BackupReport,
  Book_Serialize,
  Bookmark_Serialize,
  BookPatch_Deserialize,
  ChapterSearchHit,
  DuplicateHit,
  EpubPackage_Serialize,
  HighlightColor,
  ImportSummary_Serialize,
  LibrarySnapshot_Serialize,
  Locator_Deserialize,
  NewAnnotation_Deserialize,
  OpenedBook_Serialize,
  RestoreReport,
  Settings_Serialize,
  SettingsPatch_Deserialize,
  TextAnchor,
} from "../bindings";

export type { AppInfo, DuplicateHit };
export type Book = Book_Serialize;
export type Locator = Locator_Deserialize;
export type OpenedBook = OpenedBook_Serialize;
export type Settings = Settings_Serialize;
export type SettingsPatch = SettingsPatch_Deserialize;
export type BookPatch = BookPatch_Deserialize;
export type LibrarySnapshot = LibrarySnapshot_Serialize;
export type EpubPackage = EpubPackage_Serialize;
export type ImportSummary = ImportSummary_Serialize;
export type Annotation = Annotation_Serialize;
export type Bookmark = Bookmark_Serialize;
export type NewAnnotation = NewAnnotation_Deserialize;
export type { HighlightColor, TextAnchor };

export interface ImportProgressEvent {
  jobId: string;
  done: number;
  total: number;
  current: string;
  phase: string;
}

export class ApiError extends Error {
  override name = "ApiError";
}

type Envelope<T> = { status: "ok"; data: T } | { status: "error"; error: string };

async function unwrap<T>(promise: Promise<Envelope<T>>): Promise<T> {
  const result = await promise;
  if (result.status === "error") {
    throw new ApiError(typeof result.error === "string" ? result.error : String(result.error));
  }
  return result.data;
}

async function unwrapVoid(promise: Promise<Envelope<null>>): Promise<void> {
  await unwrap(promise);
}

export const api = {
  appInfo: (): Promise<AppInfo> => unwrap(commands.getAppInfo()),
  library: (): Promise<LibrarySnapshot> => unwrap(commands.getLibrary()),
  settings: (): Promise<Settings> => commands.getSettings(),
  setSettings: (patch: SettingsPatch): Promise<Settings> =>
    unwrap(commands.setSettings(patch)),
  resetLibraryView: (): Promise<Settings> => unwrap(commands.resetLibraryView()),

  checkDuplicates: (paths: string[]): Promise<DuplicateHit[]> =>
    unwrap(commands.checkDuplicates(paths)),
  importFiles: (paths: string[], policy: "skip" | "add"): Promise<ImportSummary> =>
    unwrap(commands.importFiles(paths, policy)),

  updateBook: (bookId: number, patch: BookPatch): Promise<Book> =>
    unwrap(commands.updateBook(bookId, patch)),
  removeBook: (bookId: number): Promise<void> => unwrapVoid(commands.removeBook(bookId)),
  moveBook: (bookId: number, targetIndex: number): Promise<void> =>
    unwrapVoid(commands.moveBook(bookId, targetIndex)),
  relinkBook: (bookId: number, path: string): Promise<Book> =>
    unwrap(commands.relinkBook(bookId, path)),
  refreshMissing: (): Promise<number[]> => unwrap(commands.refreshMissing()),
  searchLibrary: (query: string): Promise<number[]> =>
    unwrap(commands.searchLibrary(query)),
  setBookPages: (bookId: number, pages: number): Promise<void> =>
    unwrapVoid(commands.setBookPages(bookId, pages)),
  savePdfCover: (bookId: number, png: number[]): Promise<Book> =>
    unwrap(commands.savePdfCover(bookId, png)),

  openBook: (bookId: number): Promise<OpenedBook> => unwrap(commands.openBook(bookId)),
  closeBook: (bookId: number): Promise<void> => unwrapVoid(commands.closeBook(bookId)),
  saveProgress: (bookId: number, locator: Locator, progress: number): Promise<void> =>
    unwrapVoid(commands.saveProgress(bookId, locator, progress)),
  getChapter: (bookId: number, href: string): Promise<string> =>
    unwrap(commands.getChapter(bookId, href)),
  pdfBytes: async (bookId: number): Promise<Uint8Array> => {
    const encoded = await unwrap(commands.pdfBytes(bookId));
    return base64ToBytes(encoded);
  },
  getEpubPackage: (bookId: number): Promise<EpubPackage> =>
    unwrap(commands.getEpubPackage(bookId)),
  searchBook: (bookId: number, query: string, limit?: number): Promise<ChapterSearchHit[]> =>
    unwrap(commands.searchBook(bookId, query, limit ?? null)),

  listBookmarks: (bookId: number): Promise<Bookmark[]> =>
    unwrap(commands.listBookmarks(bookId)),
  addBookmark: (
    bookId: number,
    locator: Locator,
    label: string | null,
    page: number | null,
  ): Promise<Bookmark> => unwrap(commands.addBookmark(bookId, locator, label, page)),
  removeBookmark: (id: number): Promise<void> => unwrapVoid(commands.removeBookmark(id)),
  renameBookmark: (id: number, label: string): Promise<void> =>
    unwrapVoid(commands.renameBookmark(id, label)),

  listAnnotations: (bookId: number): Promise<Annotation[]> =>
    unwrap(commands.listAnnotations(bookId)),
  addAnnotation: (bookId: number, annotation: NewAnnotation): Promise<Annotation> =>
    unwrap(commands.addAnnotation(bookId, annotation)),
  updateAnnotation: (
    id: number,
    patch: { note?: string; color?: "yellow" | "green" | "blue" | "pink" },
  ): Promise<Annotation> => unwrap(commands.updateAnnotation(id, patch)),
  removeAnnotation: (id: number): Promise<void> => unwrapVoid(commands.removeAnnotation(id)),
  exportAnnotations: (bookId: number, format: "markdown" | "json"): Promise<string> =>
    unwrap(commands.exportAnnotations(bookId, format)),
  writeExportFile: (path: string, contents: string): Promise<void> =>
    unwrapVoid(commands.writeExportFile(path, contents)),

  backupLibrary: (path: string): Promise<BackupReport> =>
    unwrap(commands.backupLibrary(path)),
  restoreLibrary: (path: string): Promise<RestoreReport> =>
    unwrap(commands.restoreLibrary(path)),

  takePendingFiles: (): Promise<string[]> => commands.takePendingFiles(),
  openExternal: (url: string): Promise<void> => unwrapVoid(commands.openExternal(url)),
};

/** Base64 (from the Rust encoder) to bytes, without a dependency. */
function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
