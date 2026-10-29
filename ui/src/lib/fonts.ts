// Bundled OFL fonts. Nothing is fetched from the network: these files ship in
// the app bundle and are served from the app origin.

const loaded = new Set<string>();

async function loadFace(family: string, file: string, descriptors: FontFaceDescriptors): Promise<void> {
  const key = `${family}:${file}:${descriptors.weight ?? ""}`;
  if (loaded.has(key)) return;
  try {
    const face = new FontFace(family, `url("/fonts/${file}")`, descriptors);
    document.fonts.add(face);
    await face.load();
    loaded.add(key);
  } catch (error) {
    // A missing font must never stop the app; the stack falls back.
    console.warn(`font ${family} failed to load`, error);
  }
}

/** Serif used for spines, covers and shelf titles (Gelasio is Georgia-metric). */
export const SHELF_FONT_STACK =
  '"Gelasio", "Noto Serif SC", "Noto Naskh Arabic", "Noto Serif CJK SC", "DejaVu Serif", Georgia, serif';

export async function loadShelfFonts(): Promise<void> {
  await Promise.all([
    loadFace("Gelasio", "Gelasio-Variable.ttf", { weight: "100 900", style: "normal" }),
  ]);
  // CJK coverage is 11 MB: load it after first paint, then redraw spines.
  const kickoff = () => {
    void loadFace("Noto Serif SC", "NotoSerifSC-Regular.otf", { weight: "400", style: "normal" });
  };
  window.setTimeout(kickoff, 1500);
}

export type ReaderFontId = "literata" | "sourceserif" | "gelasio" | "inter" | "opendyslexic";

export interface ReaderFont {
  id: ReaderFontId;
  label: string;
  stack: string;
  file: string | null;
}

export const READER_FONTS: ReaderFont[] = [
  { id: "literata", label: "Literata", stack: '"Literata", Georgia, serif', file: "Literata-Variable.ttf" },
  {
    id: "sourceserif",
    label: "Source Serif",
    stack: '"Source Serif 4", Georgia, serif',
    file: "SourceSerif4-Variable.ttf",
  },
  { id: "gelasio", label: "Gelasio", stack: '"Gelasio", Georgia, serif', file: "Gelasio-Variable.ttf" },
  { id: "inter", label: "Inter (sans)", stack: '"Inter", system-ui, sans-serif', file: "Inter-Variable.ttf" },
  {
    id: "opendyslexic",
    label: "OpenDyslexic",
    stack: '"OpenDyslexic", "Inter", sans-serif',
    file: "OpenDyslexic-Regular.otf",
  },
];

export function readerFontStack(id: string): string {
  const font = READER_FONTS.find((f) => f.id === id) ?? READER_FONTS[0]!;
  return font.stack;
}

/** Load every reader font; used by the appearance panel. */
export async function loadReaderFonts(): Promise<void> {
  await Promise.all(
    READER_FONTS.map((font) =>
      font.file
        ? loadFace(font.stack.split(",")[0]!.replaceAll('"', ""), font.file, {
            weight: "100 900",
            style: "normal",
          })
        : Promise.resolve(),
    ),
  );
}
