import path from "node:path";
import { AppDatabase } from "../src/db/Database.js";
import { IngestionService } from "../src/services/IngestionService.js";
async function main() {
    const options = parseArgs(process.argv.slice(2));
    const dataDir = path.resolve("storage");
    const databasePath = path.join(dataDir, "synchro-ingestion.sqlite");
    const database = await AppDatabase.open(databasePath);
    try {
        const service = new IngestionService(database, {
            async pullAttachments() {
                return {
                    attachments: [],
                    nextDeltaToken: null,
                    deltaWasReset: false,
                    messagesSeen: 0
                };
            }
        }, dataDir);
        const result = await service.repairStoredWorkbookAttachments({
            attachmentNameIncludes: options.attachmentNameIncludes,
            propertySlug: options.propertySlug
        });
        console.log(JSON.stringify({
            runId: result.runId,
            status: result.status,
            summary: result.summary,
            filter: options
        }, null, 2));
    }
    finally {
        database.close();
    }
}
function parseArgs(args) {
    let attachmentNameIncludes = null;
    let propertySlug = null;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--name-contains") {
            attachmentNameIncludes = args[index + 1] ?? null;
            index += 1;
            continue;
        }
        if (arg === "--property-slug") {
            propertySlug = args[index + 1] ?? null;
            index += 1;
        }
    }
    return {
        attachmentNameIncludes,
        propertySlug
    };
}
void main();
