export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function systemTheme(): ResolvedTheme {
  return darkQuery.matches ? "dark" : "light";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function watchSystemTheme(callback: () => void): () => void {
  const listener = () => callback();
  darkQuery.addEventListener("change", listener);
  return () => darkQuery.removeEventListener("change", listener);
}

export type ReaderThemeId = "system" | "light" | "sepia" | "dark" | "black";
/** Alias used by the reader; matches the Rust `ReaderTheme`. */
export type ReaderTheme = ReaderThemeId;

export interface ReaderPalette {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
  rule: string;
  chrome: string;
  dark: boolean;
}

const READER_PALETTES: Record<Exclude<ReaderThemeId, "system">, Omit<ReaderPalette, "dark">> = {
  light: { bg: "#fbfaf6", ink: "#1d1a14", muted: "#6b6459", accent: "#8a5a2b", rule: "#ded7c8", chrome: "#f4f1e8" },
  sepia: { bg: "#f4ecd8", ink: "#453a2a", muted: "#7d6d55", accent: "#8b5e34", rule: "#dccfb4", chrome: "#eee3cb" },
  dark: { bg: "#1b1f24", ink: "#e7e3da", muted: "#a39d92", accent: "#d3ad5c", rule: "#333a42", chrome: "#22272e" },
  black: { bg: "#000000", ink: "#d8d4cc", muted: "#948f86", accent: "#c9a45a", rule: "#262626", chrome: "#0b0b0c" },
};

/** Reading surfaces, independent of the shelf theme. */
export function readerPalette(theme: ReaderThemeId, system: ResolvedTheme): ReaderPalette {
  const id = theme === "system" ? system : theme;
  const palette = READER_PALETTES[id] ?? READER_PALETTES.light;
  return { ...palette, dark: id === "dark" || id === "black" };
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function watchReducedMotion(callback: (reduced: boolean) => void): () => void {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  const listener = () => callback(query.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
