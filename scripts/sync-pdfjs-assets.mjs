// pdf.js needs its character maps and the 14 standard fonts as static files.
// They live in node_modules, so copy them into public/ before dev and build;
// the app then serves them from its own origin and never touches the network.

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "node_modules", "pdfjs-dist");
const target = join(root, "ui", "public", "pdfjs");

if (!existsSync(source)) {
  console.warn("pdfjs-dist is not installed; skipping pdf.js assets.");
  process.exit(0);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const dir of ["cmaps", "standard_fonts"]) {
  await cp(join(source, dir), join(target, dir), { recursive: true });
}
console.log(`pdf.js assets copied to ${target}`);
