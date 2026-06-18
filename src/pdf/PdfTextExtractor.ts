import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfLine {
  pageNumber: number;
  y: number;
  items: PdfWord[];
  text: string;
}

export interface PdfDocumentText {
  pageCount: number;
  lines: PdfLine[];
}

const require = createRequire(import.meta.url);
const standardFontDataUrl = resolveStandardFontDataUrl();

export async function extractPdfText(bytes: Buffer): Promise<PdfDocumentText> {
  const document = await getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
    disableStream: true,
    disableAutoFetch: true,
    standardFontDataUrl,
    verbosity: VerbosityLevel.ERRORS
  } as never).promise;

  const lines: PdfLine[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();

    const words: PdfWord[] = [];
    for (const item of textContent.items) {
      if (!("str" in item)) {
        continue;
      }

      const text = item.str?.trim();
      if (!text) {
        continue;
      }

      words.push({
        text,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height
      });
    }

    const grouped = groupWordsIntoLines(pageNumber, words);
    lines.push(...grouped);
  }

  return {
    pageCount: document.numPages,
    lines
  };
}

function resolveStandardFontDataUrl(): string {
  const packageRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const directoryUrl = pathToFileURL(resolve(packageRoot, "standard_fonts")).href;
  return directoryUrl.endsWith("/") ? directoryUrl : `${directoryUrl}/`;
}

function groupWordsIntoLines(pageNumber: number, words: PdfWord[]): PdfLine[] {
  const sorted = [...words].sort((left, right) => right.y - left.y || left.x - right.x);
  const buckets: Array<{ y: number; items: PdfWord[] }> = [];

  for (const word of sorted) {
    const bucket = buckets.find((candidate) => Math.abs(candidate.y - word.y) <= 2.2);
    if (bucket) {
      bucket.items.push(word);
      bucket.y = Math.max(bucket.y, word.y);
    } else {
      buckets.push({ y: word.y, items: [word] });
    }
  }

  return buckets
    .map((bucket) => {
      const items = bucket.items.sort((left, right) => left.x - right.x);
      return {
        pageNumber,
        y: bucket.y,
        items,
        text: itemsToText(items)
      };
    })
    .sort((left, right) => left.pageNumber - right.pageNumber || right.y - left.y);
}

function itemsToText(items: PdfWord[]): string {
  let result = "";
  let previous: PdfWord | null = null;

  for (const item of items) {
    if (!previous) {
      result += item.text;
      previous = item;
      continue;
    }

    const previousRight = previous.x + previous.width;
    const gap = item.x - previousRight;
    const averageCharWidth = previous.text.length > 0 ? previous.width / previous.text.length : 1;
    const needsSpace = gap > Math.max(1.5, averageCharWidth * 0.7);
    result += needsSpace ? ` ${item.text}` : item.text;
    previous = item;
  }

  return result.replace(/\s+/g, " ").trim();
}
