import { t } from "./i18n";

export function pct(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

export function relativeOpened(ms: number | null): string {
  if (!ms) return t("lastOpenedNever");
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return t("lastOpenedToday");
  if (days === 1) return t("lastOpenedDays", { n: 1 });
  return t("lastOpenedDays", { n: days });
}

export function shortDate(ms: number | null): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(ms));
}

export function timeLeft(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes < 60) return t("minutes", { m: Math.max(1, Math.round(minutes)) });
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return t("hoursMinutes", { h, m });
}

/** Pick readable text for a coloured surface. */
export function contrastText(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#241a12" : "#f6ead0";
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const int = Number.parseInt(full, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

export function shade(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (v: number) =>
    Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  return `#${[mix(r), mix(g), mix(b)]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function isRtl(text: string): boolean {
  return /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: number | undefined;
  return ((...args: never[]) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
