// PDF covers: Rust cannot rasterise pages (deliberately — no pdfium/MuPDF), so
// the webview renders page 1 with pdf.js and sends the PNG bytes back through
// `save_pdf_cover`. Runs once per imported PDF without an embedded cover.

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders page 1 of `url` to PNG bytes, or `null` when it cannot render. */
export async function renderPdfCoverPng(url: string, width = 440): Promise<number[] | null> {
  const loadingTask = getDocument({
    url,
    enableXfa: false,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  });
  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" })
      .promise;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((value) => resolve(value), "image/png"),
    );
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return Array.from(bytes);
  } catch {
    return null;
  } finally {
    void loadingTask.destroy();
  }
}
