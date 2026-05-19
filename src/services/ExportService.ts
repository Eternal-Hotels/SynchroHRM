import path from "node:path";
import { REPORT_TYPES } from "../types.js";
import type { AppDatabase } from "../db/Database.js";
import type { ExportFileInfo, ReportType } from "../types.js";
import { REPORT_COLUMN_MAP } from "../reports.js";
import { toCsv } from "../utils/csv.js";
import { formatRunStamp } from "../utils/dates.js";
import { ensureDir, writeTextFile } from "../utils/files.js";
import { ensurePropertyRef } from "../utils/properties.js";

export class ExportService {
  private readonly exportDir: string;

  constructor(
    private readonly database: AppDatabase,
    dataDir: string
  ) {
    this.exportDir = path.join(dataDir, "exports");
  }

  async exportRun(runId: number, runStartedAt = new Date()): Promise<ExportFileInfo[]> {
    await ensureDir(this.exportDir);
    const stamp = formatRunStamp(runStartedAt);
    const outputs: ExportFileInfo[] = [];
    const properties = this.database.getPropertySummaries().map((row) => ensurePropertyRef({
      propertyName: (row.property_name as string | null | undefined) ?? null,
      propertySlug: (row.property_slug as string | null | undefined) ?? null
    }));

    for (const reportType of REPORT_TYPES) {
      const runRows = this.database.getExportRows(reportType, { runId });
      const allRows = this.database.getExportRows(reportType);
      const reportDir = path.join(this.exportDir, reportType);
      await ensureDir(reportDir);

      const csvPath = path.join(reportDir, `${stamp}.csv`);
      const latestPath = path.join(reportDir, "latest.csv");
      await writeTextFile(csvPath, toCsv(runRows, REPORT_COLUMN_MAP[reportType]));
      await writeTextFile(latestPath, toCsv(allRows, REPORT_COLUMN_MAP[reportType]));
      this.database.recordExport(runId, reportType, runRows.length, csvPath, latestPath, {
        propertyName: null,
        propertySlug: null
      });

      outputs.push({
        reportType,
        propertyName: null,
        propertySlug: null,
        csvPath,
        latestPath,
        rowCount: runRows.length
      });

      for (const property of properties) {
        const propertyRunRows = this.database.getExportRows(reportType, { runId, propertySlug: property.propertySlug });
        const propertyAllRows = this.database.getExportRows(reportType, { propertySlug: property.propertySlug });
        const propertyDir = path.join(this.exportDir, "properties", property.propertySlug, reportType);
        await ensureDir(propertyDir);

        const propertyCsvPath = path.join(propertyDir, `${stamp}.csv`);
        const propertyLatestPath = path.join(propertyDir, "latest.csv");
        await writeTextFile(propertyCsvPath, toCsv(propertyRunRows, REPORT_COLUMN_MAP[reportType]));
        await writeTextFile(propertyLatestPath, toCsv(propertyAllRows, REPORT_COLUMN_MAP[reportType]));
        this.database.recordExport(runId, reportType, propertyRunRows.length, propertyCsvPath, propertyLatestPath, property);

        outputs.push({
          reportType,
          propertyName: property.propertyName,
          propertySlug: property.propertySlug,
          csvPath: propertyCsvPath,
          latestPath: propertyLatestPath,
          rowCount: propertyRunRows.length
        });
      }
    }

    return outputs;
  }

  getLatestExport(reportType: ReportType, propertySlug?: string | null): Record<string, unknown> | null {
    return this.database.getLatestExport(reportType, propertySlug);
  }

  async refreshLatestExports(propertySlug?: string | null): Promise<void> {
    await ensureDir(this.exportDir);

    for (const reportType of REPORT_TYPES) {
      const globalLatest = this.database.getLatestExport(reportType);
      if (globalLatest && typeof globalLatest.latest_path === "string") {
        await writeTextFile(
          globalLatest.latest_path,
          toCsv(this.database.getExportRows(reportType), REPORT_COLUMN_MAP[reportType])
        );
      }

      if (!propertySlug) {
        continue;
      }

      const propertyLatest = this.database.getLatestExport(reportType, propertySlug);
      if (propertyLatest && typeof propertyLatest.latest_path === "string") {
        await writeTextFile(
          propertyLatest.latest_path,
          toCsv(this.database.getExportRows(reportType, { propertySlug }), REPORT_COLUMN_MAP[reportType])
        );
      }
    }
  }
}
