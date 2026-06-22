import path from "node:path";
import { REPORT_TYPES } from "../types.js";
import { REPORT_EXPORT_COLUMN_MAP } from "../reports.js";
import { toCsv } from "../utils/csv.js";
import { formatRunStamp } from "../utils/dates.js";
import { ensureDir, writeTextFile } from "../utils/files.js";
import { ensurePropertyRef } from "../utils/properties.js";
export class ExportService {
    database;
    exportDir;
    constructor(database, dataDir) {
        this.database = database;
        this.exportDir = path.join(dataDir, "exports");
    }
    async exportRun(runId, runStartedAt = new Date()) {
        await ensureDir(this.exportDir);
        const stamp = formatRunStamp(runStartedAt);
        const outputs = [];
        const properties = this.database.getPropertySummaries().map((row) => ensurePropertyRef({
            propertyName: row.property_name ?? null,
            propertySlug: row.property_slug ?? null
        }));
        for (const reportType of REPORT_TYPES) {
            for (const property of properties) {
                const propertyRunRows = this.database.getExportRows(reportType, { runId, propertySlug: property.propertySlug });
                const propertyAllRows = this.database.getExportRows(reportType, { propertySlug: property.propertySlug });
                const propertyDir = path.join(this.exportDir, "properties", property.propertySlug, reportType);
                await ensureDir(propertyDir);
                const propertyCsvPath = path.join(propertyDir, `${stamp}.csv`);
                const propertyLatestPath = path.join(propertyDir, "latest.csv");
                await writeTextFile(propertyCsvPath, toCsv(propertyRunRows, REPORT_EXPORT_COLUMN_MAP[reportType]));
                await writeTextFile(propertyLatestPath, toCsv(propertyAllRows, REPORT_EXPORT_COLUMN_MAP[reportType]));
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
    getLatestExport(reportType, propertySlug) {
        return this.database.getLatestExport(reportType, propertySlug);
    }
    async refreshLatestExports(propertySlug) {
        await ensureDir(this.exportDir);
        const properties = propertySlug
            ? [ensurePropertyRef({ propertyName: null, propertySlug })]
            : this.database.getPropertySummaries().map((row) => ensurePropertyRef({
                propertyName: row.property_name ?? null,
                propertySlug: row.property_slug ?? null
            }));
        for (const reportType of REPORT_TYPES) {
            for (const property of properties) {
                const propertyLatest = this.database.getLatestExport(reportType, property.propertySlug);
                if (!propertyLatest || typeof propertyLatest.latest_path !== "string") {
                    continue;
                }
                await writeTextFile(propertyLatest.latest_path, toCsv(this.database.getExportRows(reportType, { propertySlug: property.propertySlug }), REPORT_EXPORT_COLUMN_MAP[reportType]));
            }
        }
    }
}
