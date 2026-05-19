// Rebuild per-property and global latest.csv files for every report type using the
// current (COALESCE-aware) export logic, and refresh export_history.row_count so the
// admin UI shows the true cumulative row counts. Use after a parser or export-logic
// upgrade made earlier latest.csv writes stale.
import path from "node:path";
import { AppDatabase } from "../src/db/Database.js";
import { ExportService } from "../src/services/ExportService.js";
import { loadConfig } from "../src/config.js";
import { REPORT_TYPES } from "../src/types.js";
import { REPORT_COLUMN_MAP } from "../src/reports.js";
import { toCsv } from "../src/utils/csv.js";
import { writeTextFile } from "../src/utils/files.js";
import { UNASSIGNED_PROPERTY_SLUG } from "../src/utils/properties.js";

const config = await loadConfig();
const database = new AppDatabase(path.join(config.dataDir, "synchro-ingestion.sqlite"));
database.initialize();
const exportService = new ExportService(database, config.dataDir);

// Refresh the global latest.csv files first.
await exportService.refreshLatestExports();

// Then refresh each property's latest.csv files and patch the export_history row counts.
const summaries = database.getPropertySummaries();
for (const summary of summaries) {
  const propertySlug = String(summary.property_slug);
  await exportService.refreshLatestExports(propertySlug);

  for (const reportType of REPORT_TYPES) {
    const rows = database.getExportRows(reportType, { propertySlug });
    const latest = database.getLatestExport(reportType, propertySlug) as { id?: number; latest_path?: string } | null;
    if (latest && typeof latest.id === "number") {
      database.updateExportRowCount(latest.id, rows.length);
    }
    if (latest && typeof latest.latest_path === "string") {
      await writeTextFile(latest.latest_path, toCsv(rows, REPORT_COLUMN_MAP[reportType]));
    }
  }
}

// Same for global (property_slug IS NULL in export_history).
for (const reportType of REPORT_TYPES) {
  const rows = database.getExportRows(reportType);
  const latest = database.getLatestExport(reportType) as { id?: number; latest_path?: string } | null;
  if (latest && typeof latest.id === "number") {
    database.updateExportRowCount(latest.id, rows.length);
  }
  if (latest && typeof latest.latest_path === "string") {
    await writeTextFile(latest.latest_path, toCsv(rows, REPORT_COLUMN_MAP[reportType]));
  }
}

console.log("Rebuilt latest.csv files and synced export_history.row_count for", summaries.length, "properties.");
