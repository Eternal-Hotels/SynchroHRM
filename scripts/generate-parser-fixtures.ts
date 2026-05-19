import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PdfReportParser } from "../src/parsers/pdfReportParser.js";
import { ensureDir, writeTextFile } from "../src/utils/files.js";

const parser = new PdfReportParser();
const exampleDir = path.resolve("ExampleData");
const outputDir = path.resolve("tests", "fixtures", "generated");

await ensureDir(outputDir);

const names = (await readdir(exampleDir)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
const output: Record<string, unknown> = {};

for (const name of names) {
  const bytes = await readFile(path.join(exampleDir, name));
  const parsed = await parser.parse(bytes);
  output[name] = {
    reportType: parsed.reportType,
    reportTitle: parsed.reportTitle,
    reportDate: parsed.reportDate,
    rowCount: parsed.rows.length,
    sampleRows: parsed.rows.slice(0, 3)
  };
}

await writeTextFile(path.join(outputDir, "parser-fixtures.json"), `${JSON.stringify(output, null, 2)}\n`);
