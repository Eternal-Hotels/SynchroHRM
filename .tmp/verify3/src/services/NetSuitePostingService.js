import { randomUUID } from "node:crypto";
import { COMMON_EXPORT_COLUMNS, REPORT_COLUMN_MAP, REPORT_TITLES } from "../reports.js";
import { REPORT_TYPES } from "../types.js";
import { NetSuiteSettingsError } from "./NetSuiteConnectionService.js";
const SUPPORTED_NETSUITE_REPORT_TYPES = REPORT_TYPES;
const GROUP_CONTEXT_FIELDS = [
    "report_name",
    "section",
    "subsection",
    "group_name",
    "account_type",
    "period",
    "maintenance_type",
    "transaction_scope",
    "transaction_type",
    "charge_type",
    "day_of_week"
];
const ITEM_CONTEXT_FIELDS = [
    "metric_name",
    "summary_label",
    "business_date",
    "date_value",
    "booking_date",
    "made_on_date",
    "arrival_date",
    "departure_date",
    "check_in_date",
    "check_out_date",
    "stay_date",
    "due_date",
    "post_date",
    "company_name",
    "company_code",
    "guest_name",
    "guest_or_group_name",
    "group_code",
    "payment_method",
    "room_type",
    "rate_plan",
    "rate_plan_name",
    "reason",
    "tax_name",
    "posting_code",
    "posting_description",
    "transaction_code",
    "transaction_description",
    "line_text"
];
const CONTEXT_FIELD_LIMIT = 4;
export class NetSuitePostingError extends Error {
    statusCode;
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
        this.name = "NetSuitePostingError";
    }
}
export class NetSuitePostingService {
    database;
    connectionService;
    constructor(database, connectionService) {
        this.database = database;
        this.connectionService = connectionService;
    }
    listProperties() {
        const summaries = this.database.listNetSuitePostingPropertySummaries([...SUPPORTED_NETSUITE_REPORT_TYPES]);
        return summaries.map((entry) => ({
            ...entry,
            supportedReportTypes: buildSupportedReportTypeSummaries(this.listSupportedAttachments(String(entry.property_slug || "")))
        }));
    }
    getWorkspace(propertySlug, attachmentId, requestedReportType) {
        const property = this.database.getPropertySummary(propertySlug);
        if (!property) {
            throw new NetSuitePostingError(`Property ${propertySlug} was not found.`, 404);
        }
        const supportedAttachments = this.listSupportedAttachments(propertySlug);
        const availableReportTypes = buildSupportedReportTypeSummaries(supportedAttachments);
        const selectedAttachment = this.selectAttachment(supportedAttachments, attachmentId ?? null, requestedReportType ?? null);
        if (!selectedAttachment) {
            return {
                property,
                availableReportTypes,
                supportedAttachments,
                selectedAttachment: null,
                selectedReportType: null,
                discoverySummary: {
                    supportedReportTypeCount: availableReportTypes.length,
                    attachmentCount: supportedAttachments.length,
                    discoveredItemCount: 0
                },
                mappings: [],
                defaults: emptyPostingDefaults(),
                runs: []
            };
        }
        const discovered = this.discoverItemsForAttachment(selectedAttachment);
        const savedMappings = this.database.getNetSuiteMonetaryMappings(propertySlug, selectedAttachment.reportType);
        const mappings = mergeMappings(discovered, savedMappings);
        const defaults = normalizePostingDefaults(this.database.getNetSuitePostingDefaults(propertySlug, selectedAttachment.reportType));
        const runs = this.database
            .listNetSuitePostingRuns(propertySlug, selectedAttachment.reportType)
            .map((row) => normalizePostingRun(row));
        return {
            property,
            availableReportTypes,
            supportedAttachments,
            selectedAttachment,
            selectedReportType: selectedAttachment.reportType,
            discoverySummary: {
                supportedReportTypeCount: availableReportTypes.length,
                attachmentCount: supportedAttachments.length,
                discoveredItemCount: discovered.length
            },
            mappings,
            defaults,
            runs
        };
    }
    saveSetup(propertySlug, attachmentId, mappings, defaults) {
        const attachment = this.requireAttachment(propertySlug, attachmentId);
        const discovered = this.discoverItemsForAttachment(attachment);
        this.persistSetup(propertySlug, attachment, discovered, mappings, defaults);
        return this.getWorkspace(propertySlug, attachmentId);
    }
    buildPreview(propertySlug, attachmentId, createdByUsername, mappings, defaults) {
        const attachment = this.requireAttachment(propertySlug, attachmentId);
        const discovered = this.discoverItemsForAttachment(attachment);
        this.persistSetup(propertySlug, attachment, discovered, mappings, defaults);
        const workspace = this.getWorkspace(propertySlug, attachmentId);
        const preview = buildPostingPreview(workspace.property, attachment, workspace.mappings, workspace.defaults);
        const runId = randomUUID();
        this.database.insertNetSuitePostingRun({
            id: runId,
            propertySlug,
            propertyName: typeof workspace.property.property_name === "string" ? workspace.property.property_name : null,
            reportType: attachment.reportType,
            reportTitle: attachment.reportTitle,
            attachmentRecordId: attachment.attachmentId,
            attachmentName: attachment.attachmentName,
            reportDate: attachment.reportDate,
            status: "preview",
            externalId: preview.externalId,
            previewPayload: preview,
            netsuiteResponseSummary: "",
            netsuiteResponsePayload: null,
            errorMessage: "",
            createdByUsername: createdByUsername.trim(),
            submittedAt: null
        });
        return {
            run: normalizePostingRun(this.database.getNetSuitePostingRun(runId)),
            workspace: this.getWorkspace(propertySlug, attachmentId)
        };
    }
    async submitRun(propertySlug, runId) {
        const run = this.database.getNetSuitePostingRun(runId);
        if (!run || String(run.property_slug || "") !== propertySlug) {
            throw new NetSuitePostingError(`NetSuite posting run ${runId} was not found for ${propertySlug}.`, 404);
        }
        const preview = normalizePreviewPayload(run.preview_payload);
        if (!preview) {
            throw new NetSuitePostingError("The saved NetSuite posting preview could not be loaded.", 500);
        }
        if (preview.summary.postable !== true) {
            throw new NetSuitePostingError("Only a preview without blocking validation errors can be submitted to NetSuite.");
        }
        const uniqueGlCodes = Array.from(new Set(preview.lines
            .map((line) => normalizeWhitespace(line.glCode))
            .filter(Boolean)));
        const accountIdByNumber = await this.connectionService.resolveGlAccountIds(uniqueGlCodes);
        const missingCodes = uniqueGlCodes.filter((code) => !accountIdByNumber[code]);
        if (missingCodes.length > 0) {
            const message = `NetSuite could not resolve these account numbers: ${missingCodes.join(", ")}.`;
            this.database.updateNetSuitePostingRun(runId, {
                status: "failed",
                netsuiteResponseSummary: message,
                errorMessage: message
            });
            throw new NetSuitePostingError(message);
        }
        const journalRecord = buildJournalEntryRecord(preview, accountIdByNumber);
        try {
            const result = await this.connectionService.createJournalEntry(journalRecord);
            const responseSummary = result.journalEntry.tranId
                ? `Submitted to NetSuite as ${result.journalEntry.tranId}.`
                : (result.journalEntry.id
                    ? `Submitted to NetSuite as journal ${result.journalEntry.id}.`
                    : "Submitted to NetSuite.");
            this.database.updateNetSuitePostingRun(runId, {
                status: "submitted",
                netsuiteResponseSummary: responseSummary,
                netsuiteResponsePayload: result.raw,
                errorMessage: "",
                submittedAt: new Date().toISOString()
            });
            return normalizePostingRun(this.database.getNetSuitePostingRun(runId));
        }
        catch (error) {
            const message = error instanceof NetSuiteSettingsError
                ? error.message
                : (error instanceof Error ? error.message : String(error));
            this.database.updateNetSuitePostingRun(runId, {
                status: "failed",
                netsuiteResponseSummary: message,
                errorMessage: message
            });
            throw new NetSuitePostingError(message);
        }
    }
    listSupportedAttachments(propertySlug) {
        return this.database.getPropertyAttachments(propertySlug)
            .filter((attachment) => attachment.status === "parsed")
            .map((attachment) => {
            const reportType = normalizeSupportedReportType(attachment.report_type);
            if (!reportType) {
                return null;
            }
            return {
                attachmentId: Number(attachment.id),
                attachmentName: String(attachment.attachment_name || ""),
                reportType,
                reportTitle: String(attachment.report_title || REPORT_TITLES[reportType]),
                reportDate: typeof attachment.report_date === "string" && attachment.report_date.trim().length > 0
                    ? attachment.report_date
                    : null,
                receivedAt: String(attachment.received_at || "")
            };
        })
            .filter((attachment) => attachment !== null)
            .sort((left, right) => {
            if (left.receivedAt !== right.receivedAt) {
                return right.receivedAt.localeCompare(left.receivedAt);
            }
            return right.attachmentId - left.attachmentId;
        });
    }
    selectAttachment(attachments, attachmentId, requestedReportType) {
        if (attachmentId && Number.isInteger(attachmentId)) {
            const matched = attachments.find((attachment) => attachment.attachmentId === attachmentId);
            if (matched) {
                return matched;
            }
        }
        const normalizedReportType = normalizeSupportedReportType(requestedReportType);
        if (normalizedReportType) {
            return attachments.find((attachment) => attachment.reportType === normalizedReportType) ?? attachments[0] ?? null;
        }
        return attachments[0] ?? null;
    }
    requireAttachment(propertySlug, attachmentId) {
        if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
            throw new NetSuitePostingError("attachmentId must be a positive integer.");
        }
        const attachment = this.listSupportedAttachments(propertySlug)
            .find((entry) => entry.attachmentId === attachmentId);
        if (!attachment) {
            throw new NetSuitePostingError(`Supported parsed attachment ${attachmentId} was not found for ${propertySlug}.`, 404);
        }
        return attachment;
    }
    discoverItemsForAttachment(attachment) {
        const rows = this.database.getAttachmentExportRows(attachment.reportType, attachment.attachmentId);
        return discoverAllPostingItems(rows, attachment);
    }
    persistSetup(propertySlug, attachment, discovered, mappings, defaults) {
        const now = new Date().toISOString();
        const mappingUpdates = new Map(mappings.map((entry) => [
            normalizeWhitespace(entry.mappingKey),
            {
                netsuiteGlCode: normalizeWhitespace(entry.netsuiteGlCode),
                postingPolarity: normalizePostingPolarity(entry.postingPolarity)
            }
        ]));
        const existingByKey = new Map(this.database
            .getNetSuiteMonetaryMappings(propertySlug, attachment.reportType)
            .map((entry) => [String(entry.mapping_key || ""), entry]));
        this.database.upsertNetSuiteMonetaryMappings(discovered.map((item) => {
            const existing = existingByKey.get(item.mappingKey) ?? null;
            const update = mappingUpdates.get(item.mappingKey) ?? null;
            return {
                propertySlug,
                reportType: attachment.reportType,
                mappingKey: item.mappingKey,
                groupLabel: item.groupLabel,
                itemLabel: item.itemLabel,
                amountField: item.amountField,
                amountFieldLabel: item.amountFieldLabel,
                defaultPostingPolarity: item.defaultPostingPolarity,
                postingPolarity: update?.postingPolarity
                    ?? normalizePostingPolarity(existing?.posting_polarity)
                    ?? item.defaultPostingPolarity,
                netsuiteGlCode: update?.netsuiteGlCode ?? normalizeWhitespace(existing?.netsuite_gl_code),
                firstSeenAt: typeof existing?.first_seen_at === "string" && existing.first_seen_at
                    ? existing.first_seen_at
                    : now,
                lastSeenAt: now,
                lastAttachmentId: attachment.attachmentId,
                lastAttachmentName: attachment.attachmentName,
                updatedAt: now
            };
        }));
        const currentDefaults = normalizePostingDefaults(this.database.getNetSuitePostingDefaults(propertySlug, attachment.reportType));
        this.database.saveNetSuitePostingDefaults({
            propertySlug,
            reportType: attachment.reportType,
            balancingGlCode: pickPostedDefault(defaults, "balancingGlCode", currentDefaults.balancingGlCode),
            externalIdPrefix: pickPostedDefault(defaults, "externalIdPrefix", currentDefaults.externalIdPrefix),
            memoTemplate: pickPostedDefault(defaults, "memoTemplate", currentDefaults.memoTemplate),
            subsidiaryId: pickPostedDefault(defaults, "subsidiaryId", currentDefaults.subsidiaryId),
            currencyId: pickPostedDefault(defaults, "currencyId", currentDefaults.currencyId),
            locationId: pickPostedDefault(defaults, "locationId", currentDefaults.locationId),
            departmentId: pickPostedDefault(defaults, "departmentId", currentDefaults.departmentId),
            classId: pickPostedDefault(defaults, "classId", currentDefaults.classId),
            updatedAt: now
        });
    }
}
function mergeMappings(discovered, savedMappings) {
    const savedByKey = new Map(savedMappings.map((entry) => [String(entry.mapping_key || ""), entry]));
    return discovered.map((item) => {
        const saved = savedByKey.get(item.mappingKey) ?? null;
        const postingPolarity = normalizePostingPolarity(saved?.posting_polarity) ?? item.defaultPostingPolarity;
        return {
            mappingKey: item.mappingKey,
            reportType: item.reportType,
            reportTitle: item.reportTitle,
            groupLabel: item.groupLabel,
            itemLabel: item.itemLabel,
            amountField: item.amountField,
            amountFieldLabel: item.amountFieldLabel,
            defaultPostingPolarity: item.defaultPostingPolarity,
            postingPolarity,
            netsuiteGlCode: normalizeWhitespace(saved?.netsuite_gl_code),
            currentAmount: formatMoney(item.amount),
            currentAmountValue: item.amount,
            firstSeenAt: typeof saved?.first_seen_at === "string" ? saved.first_seen_at : "",
            lastSeenAt: typeof saved?.last_seen_at === "string" ? saved.last_seen_at : "",
            lastAttachmentId: typeof saved?.last_attachment_id === "number" ? saved.last_attachment_id : null,
            lastAttachmentName: typeof saved?.last_attachment_name === "string" ? saved.last_attachment_name : "",
            updatedAt: typeof saved?.updated_at === "string" ? saved.updated_at : ""
        };
    });
}
function normalizePostingDefaults(value) {
    return {
        balancingGlCode: normalizeWhitespace(value?.balancing_gl_code),
        externalIdPrefix: normalizeWhitespace(value?.external_id_prefix),
        memoTemplate: normalizeWhitespace(value?.memo_template),
        subsidiaryId: normalizeWhitespace(value?.subsidiary_id),
        currencyId: normalizeWhitespace(value?.currency_id),
        locationId: normalizeWhitespace(value?.location_id),
        departmentId: normalizeWhitespace(value?.department_id),
        classId: normalizeWhitespace(value?.class_id),
        updatedAt: typeof value?.updated_at === "string" ? value.updated_at : ""
    };
}
function emptyPostingDefaults() {
    return {
        balancingGlCode: "",
        externalIdPrefix: "",
        memoTemplate: "",
        subsidiaryId: "",
        currencyId: "",
        locationId: "",
        departmentId: "",
        classId: "",
        updatedAt: ""
    };
}
function normalizePostingRun(run) {
    if (!run) {
        return {};
    }
    return {
        ...run,
        previewPayload: normalizePreviewPayload(run.preview_payload),
        netsuiteResponsePayload: parseJsonRecord(run.netsuite_response_payload)
    };
}
function normalizePreviewPayload(value) {
    const parsed = parseJsonRecord(value);
    if (!parsed) {
        return null;
    }
    return parsed;
}
function buildPostingPreview(property, attachment, mappings, defaults) {
    const validations = [];
    const lines = [];
    let debitTotal = 0;
    let creditTotal = 0;
    for (const mapping of mappings) {
        const amount = typeof mapping.currentAmountValue === "number" ? mapping.currentAmountValue : parseAmount(mapping.currentAmount) ?? 0;
        if (roundMoney(amount) === 0) {
            continue;
        }
        const glCode = normalizeWhitespace(mapping.netsuiteGlCode);
        const postingPolarity = normalizePostingPolarity(mapping.postingPolarity) ?? normalizePostingPolarity(mapping.defaultPostingPolarity) ?? "debit_positive";
        if (!glCode) {
            validations.push({
                level: "error",
                code: "missing_gl_code",
                message: `Missing NetSuite GL code for ${String(mapping.itemLabel || "this report line")}.`,
                mappingKey: String(mapping.mappingKey || "")
            });
            continue;
        }
        const line = buildPostingLine({
            mappingKey: String(mapping.mappingKey || ""),
            groupLabel: String(mapping.groupLabel || ""),
            itemLabel: String(mapping.itemLabel || ""),
            amountField: String(mapping.amountField || ""),
            amountFieldLabel: String(mapping.amountFieldLabel || ""),
            glCode,
            postingPolarity
        }, amount);
        lines.push(line);
        debitTotal += parseAmount(line.debit) ?? 0;
        creditTotal += parseAmount(line.credit) ?? 0;
    }
    let balanceDifference = roundMoney(debitTotal - creditTotal);
    if (lines.length === 0) {
        validations.push({
            level: "warning",
            code: "no_posting_lines",
            message: "No non-zero statistical values were available for this attachment.",
            mappingKey: ""
        });
    }
    if (balanceDifference !== 0) {
        validations.push({
            level: "warning",
            code: "unbalanced_preview",
            message: `Preview does not balance and balancing is currently disabled. Difference: ${formatMoney(balanceDifference)}.`,
            mappingKey: ""
        });
    }
    const propertySlug = String(property.property_slug || "");
    const propertyName = String(property.property_name || propertySlug || "Property");
    const reportDate = attachment.reportDate ?? "";
    const accountingDate = reportDate || attachment.receivedAt.slice(0, 10);
    const externalId = buildExternalId(propertySlug, attachment.reportType, accountingDate, attachment.attachmentId, defaults.externalIdPrefix);
    const memo = renderMemoTemplate(defaults.memoTemplate, {
        propertyName,
        propertySlug,
        reportType: attachment.reportType,
        reportTitle: attachment.reportTitle,
        reportDate: accountingDate,
        attachmentName: attachment.attachmentName
    });
    return {
        propertySlug,
        propertyName,
        reportType: attachment.reportType,
        reportTitle: attachment.reportTitle,
        attachmentId: attachment.attachmentId,
        attachmentName: attachment.attachmentName,
        reportDate: attachment.reportDate,
        receivedAt: attachment.receivedAt,
        accountingDate,
        externalId,
        memo,
        defaults,
        summary: {
            lineCount: lines.length,
            debitTotal: formatMoney(debitTotal),
            creditTotal: formatMoney(creditTotal),
            balanceDifference: formatMoney(balanceDifference),
            postable: validations.every((validation) => validation.level !== "error")
        },
        validations,
        lines
    };
}
function buildJournalEntryRecord(preview, accountIdByNumber) {
    const record = {
        externalId: preview.externalId,
        tranDate: preview.accountingDate,
        memo: preview.memo,
        line: {
            items: preview.lines.map((line) => {
                const payload = {
                    account: {
                        id: accountIdByNumber[line.glCode]
                    },
                    memo: [line.groupLabel, line.itemLabel].filter(Boolean).join(": ")
                };
                const debit = parseAmount(line.debit) ?? 0;
                const credit = parseAmount(line.credit) ?? 0;
                if (debit !== 0) {
                    payload.debit = debit;
                }
                if (credit !== 0) {
                    payload.credit = credit;
                }
                return payload;
            })
        }
    };
    if (preview.defaults.subsidiaryId) {
        record.subsidiary = { id: preview.defaults.subsidiaryId };
    }
    if (preview.defaults.currencyId) {
        record.currency = { id: preview.defaults.currencyId };
    }
    if (preview.defaults.locationId) {
        record.location = { id: preview.defaults.locationId };
    }
    if (preview.defaults.departmentId) {
        record.department = { id: preview.defaults.departmentId };
    }
    if (preview.defaults.classId) {
        record.class = { id: preview.defaults.classId };
    }
    return record;
}
function discoverAllPostingItems(rows, attachment) {
    if (attachment.reportType === "credit_card_transaction_rows") {
        return discoverCreditCardTransactionItems(rows, attachment);
    }
    if (attachment.reportType === "operator_transaction_rows") {
        return discoverOperatorTransactionItems(rows, attachment);
    }
    if (attachment.reportType === "daily_transaction_log_rows") {
        return discoverDailyTransactionLogItems(rows, attachment);
    }
    if (attachment.reportType === "all_transaction_rows") {
        return discoverAllTransactionItems(rows, attachment);
    }
    if (attachment.reportType === "room_tax_listing_rows") {
        return discoverRoomTaxListingItems(rows, attachment);
    }
    if (attachment.reportType === "best_western_daily_report_rows") {
        return discoverBestWesternDailyReportItems(rows, attachment);
    }
    return discoverGenericPostingItems(rows, attachment);
}
function discoverGenericPostingItems(rows, attachment) {
    const byKey = new Map();
    for (const row of rows) {
        for (const candidate of buildPostingItemCandidates(row, attachment)) {
            const existing = byKey.get(candidate.mappingKey);
            if (existing) {
                existing.amount = roundMoney(existing.amount + candidate.amount);
                continue;
            }
            byKey.set(candidate.mappingKey, {
                ...candidate,
                reportType: attachment.reportType,
                reportTitle: attachment.reportTitle,
                amount: roundMoney(candidate.amount)
            });
        }
    }
    return Array.from(byKey.values()).sort(compareDiscoveredItems);
}
function discoverCreditCardTransactionItems(rows, attachment) {
    if (rows.length === 0) {
        return [];
    }
    let netAmount = 0;
    for (const row of rows) {
        netAmount += parseAmount(row.charge_amount) ?? 0;
        netAmount -= parseAmount(row.credit_amount) ?? 0;
    }
    return [{
            mappingKey: buildMappingKey(attachment.reportType, "net_amount", ["credit_card_transactions"]),
            reportType: attachment.reportType,
            reportTitle: attachment.reportTitle,
            groupLabel: attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "Credit Card Transactions",
            itemLabel: "All Cards",
            amountField: "net_amount",
            amountFieldLabel: "Net Amount",
            defaultPostingPolarity: "credit_positive",
            amount: roundMoney(netAmount)
        }];
}
function discoverOperatorTransactionItems(rows, attachment) {
    const byKey = new Map();
    for (const row of rows) {
        const groupLabel = attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "Operator Transactions";
        const itemLabel = buildOperatorTransactionCategoryLabel(row, attachment);
        const amount = roundMoney((parseAmount(row.amount) ?? 0)
            + (parseAmount(row.adjustment_amount) ?? 0));
        const mappingKey = buildMappingKey(attachment.reportType, "ledger_total", [itemLabel]);
        const existing = byKey.get(mappingKey);
        if (existing) {
            existing.amount = roundMoney(existing.amount + amount);
            continue;
        }
        byKey.set(mappingKey, {
            mappingKey,
            reportType: attachment.reportType,
            reportTitle: attachment.reportTitle,
            groupLabel,
            itemLabel,
            amountField: "ledger_total",
            amountFieldLabel: "Ledger Total",
            defaultPostingPolarity: inferMetricPolarity("ledger_total", groupLabel, itemLabel),
            amount
        });
    }
    return Array.from(byKey.values()).sort(compareDiscoveredItems);
}
function discoverDailyTransactionLogItems(rows, attachment) {
    const byKey = new Map();
    for (const row of rows) {
        const groupLabel = attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "Daily Transaction Log";
        const itemLabel = buildDailyTransactionLogCategoryLabel(row, attachment);
        const amount = roundMoney((parseAmount(row.posted_amount) ?? 0)
            + (parseAmount(row.adjusted_amount) ?? 0));
        const mappingKey = buildMappingKey(attachment.reportType, "ledger_total", [itemLabel]);
        const existing = byKey.get(mappingKey);
        if (existing) {
            existing.amount = roundMoney(existing.amount + amount);
            continue;
        }
        byKey.set(mappingKey, {
            mappingKey,
            reportType: attachment.reportType,
            reportTitle: attachment.reportTitle,
            groupLabel,
            itemLabel,
            amountField: "ledger_total",
            amountFieldLabel: "Ledger Total",
            defaultPostingPolarity: inferMetricPolarity("ledger_total", groupLabel, itemLabel),
            amount
        });
    }
    return Array.from(byKey.values()).sort(compareDiscoveredItems);
}
function discoverAllTransactionItems(rows, attachment) {
    const byKey = new Map();
    for (const row of rows) {
        const groupLabel = attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "All Transactions";
        const itemLabel = buildAllTransactionCategoryLabel(row, attachment);
        const amount = roundMoney(parseAmount(row.amount) ?? 0);
        const mappingKey = buildMappingKey(attachment.reportType, "amount", [itemLabel]);
        const existing = byKey.get(mappingKey);
        if (existing) {
            existing.amount = roundMoney(existing.amount + amount);
            continue;
        }
        byKey.set(mappingKey, {
            mappingKey,
            reportType: attachment.reportType,
            reportTitle: attachment.reportTitle,
            groupLabel,
            itemLabel,
            amountField: "amount",
            amountFieldLabel: "Amount",
            defaultPostingPolarity: inferMetricPolarity("amount", groupLabel, itemLabel),
            amount
        });
    }
    return Array.from(byKey.values()).sort(compareDiscoveredItems);
}
function discoverRoomTaxListingItems(rows, attachment) {
    const byKey = new Map();
    for (const row of rows) {
        const chargeType = normalizeWhitespace(row.charge_type) || "Uncategorized";
        const groupLabel = `Charge Type: ${chargeType}`;
        for (const [amountField, amountFieldLabel] of [
            ["rate_amount", "Rate Amount"],
            ["tax_amount", "Tax Amount"]
        ]) {
            const amount = parseAmount(row[amountField]);
            if (amount === null) {
                continue;
            }
            const mappingKey = buildMappingKey(attachment.reportType, amountField, [groupLabel]);
            const existing = byKey.get(mappingKey);
            if (existing) {
                existing.amount = roundMoney(existing.amount + amount);
                continue;
            }
            byKey.set(mappingKey, {
                mappingKey,
                reportType: attachment.reportType,
                reportTitle: attachment.reportTitle,
                groupLabel,
                itemLabel: "All Listed Rooms",
                amountField,
                amountFieldLabel,
                defaultPostingPolarity: inferMetricPolarity(amountField, groupLabel, amountFieldLabel),
                amount: roundMoney(amount)
            });
        }
    }
    return Array.from(byKey.values()).sort(compareDiscoveredItems);
}
function buildOperatorTransactionCategoryLabel(row, attachment) {
    const description = normalizeWhitespace(row.transaction_description)
        .replace(/\s+\d{1,4}-[A-Za-z]$/g, "")
        .replace(/\s+\d{1,4}$/g, "")
        .trim();
    return description
        || normalizeWhitespace(row.transaction_code)
        || attachment.reportTitle
        || "Operator Transactions";
}
function buildAllTransactionCategoryLabel(row, attachment) {
    const transactionType = normalizeWhitespace(row.transaction_type);
    const chargeType = normalizeWhitespace(row.charge_type);
    if (transactionType === "CHARGE" && chargeType) {
        return `${humanizeCategoryValue(chargeType)} Charge`;
    }
    if (transactionType === "TAX" && chargeType) {
        return `${humanizeCategoryValue(chargeType)} Tax`;
    }
    if (transactionType && chargeType) {
        return `${humanizeCategoryValue(chargeType)} ${humanizeCategoryValue(transactionType)}`;
    }
    if (transactionType) {
        return humanizeCategoryValue(transactionType);
    }
    if (chargeType) {
        return humanizeCategoryValue(chargeType);
    }
    const description = normalizeWhitespace(row.transaction_description)
        .replace(/\s+\d{1,4}-[A-Za-z]$/g, "")
        .replace(/\s+\d{1,4}$/g, "")
        .trim();
    return description
        || normalizeWhitespace(row.transaction_code)
        || attachment.reportTitle
        || "All Transactions";
}
function humanizeCategoryValue(value) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) {
        return "";
    }
    return normalized
        .toLowerCase()
        .replace(/\b(ar|gl|db|adr|ooo)\b/g, (match) => match.toUpperCase())
        .replace(/\b\w/g, (match) => match.toUpperCase());
}
function buildDailyTransactionLogCategoryLabel(row, attachment) {
    const description = normalizeWhitespace(row.transaction_description)
        .replace(/\s+\d{1,4}-[A-Za-z]$/g, "")
        .replace(/\s+\d{1,4}$/g, "")
        .trim();
    return description
        || normalizeWhitespace(row.transaction_code)
        || attachment.reportTitle
        || "Daily Transaction Log";
}
function discoverBestWesternDailyReportItems(rows, attachment) {
    const byKey = new Map();
    for (const row of rows) {
        const amount = parseAmount(row.today_value);
        if (amount === null) {
            continue;
        }
        const groupLabel = buildBestWesternDailyGroupLabel(row, attachment);
        const itemLabel = buildBestWesternDailyCategoryLabel(row, attachment);
        const mappingKey = buildMappingKey(attachment.reportType, "today_value", [groupLabel, itemLabel]);
        const existing = byKey.get(mappingKey);
        if (existing) {
            existing.amount = roundMoney(existing.amount + amount);
            continue;
        }
        byKey.set(mappingKey, {
            mappingKey,
            reportType: attachment.reportType,
            reportTitle: attachment.reportTitle,
            groupLabel,
            itemLabel,
            amountField: "today_value",
            amountFieldLabel: "Today Value",
            defaultPostingPolarity: inferMetricPolarity("today_value", groupLabel, itemLabel),
            amount: roundMoney(amount)
        });
    }
    return Array.from(byKey.values()).sort(compareDiscoveredItems);
}
function buildBestWesternDailyGroupLabel(row, attachment) {
    const parts = [
        normalizeWhitespace(row.section),
        normalizeWhitespace(row.subsection)
    ].filter(Boolean);
    if (parts.length > 0) {
        return parts.join(" / ");
    }
    return attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "Daily Report";
}
function buildBestWesternDailyCategoryLabel(row, attachment) {
    const category = [
        normalizeWhitespace(row.group_name),
        normalizeWhitespace(row.metric_name),
        normalizeWhitespace(row.posting_description),
        normalizeWhitespace(row.posting_code)
    ].find(Boolean);
    return category || attachment.attachmentName || attachment.reportTitle || "Daily Report Category";
}
function buildPostingItemCandidates(row, attachment) {
    const groupLabel = buildPostingGroupLabel(row, attachment);
    const itemLabel = buildPostingItemLabel(row, attachment);
    const identityParts = buildPostingIdentityParts(row, attachment);
    return REPORT_COLUMN_MAP[attachment.reportType]
        .filter((field) => !COMMON_EXPORT_COLUMNS.includes(field))
        .filter((field) => shouldTreatAsMetricField(field))
        .map((field) => {
        const amount = parseAmount(row[field]);
        if (amount === null) {
            return null;
        }
        return {
            mappingKey: buildMappingKey(attachment.reportType, field, identityParts),
            groupLabel,
            itemLabel,
            amountField: field,
            amountFieldLabel: humanizeFieldLabel(field),
            defaultPostingPolarity: inferMetricPolarity(field, groupLabel, itemLabel),
            amount
        };
    })
        .filter((candidate) => candidate !== null);
}
function buildPostingGroupLabel(row, attachment) {
    const prioritized = pickContextValues(row, GROUP_CONTEXT_FIELDS, 3);
    if (prioritized.length > 0) {
        return prioritized.join(" / ");
    }
    return attachment.reportTitle || REPORT_TITLES[attachment.reportType] || humanizeFieldLabel(attachment.reportType);
}
function buildPostingItemLabel(row, attachment) {
    const prioritized = pickContextValues(row, ITEM_CONTEXT_FIELDS, CONTEXT_FIELD_LIMIT);
    if (prioritized.length > 0) {
        return prioritized.join(" / ");
    }
    const fallback = Object.entries(row)
        .filter(([field]) => !COMMON_EXPORT_COLUMNS.includes(field))
        .filter(([field]) => !shouldTreatAsMetricField(field))
        .map(([field, value]) => formatContextValue(field, value))
        .filter(Boolean)
        .slice(0, CONTEXT_FIELD_LIMIT);
    if (fallback.length > 0) {
        return fallback.join(" / ");
    }
    return attachment.attachmentName || attachment.reportTitle || "Report Row";
}
function buildPostingIdentityParts(row, attachment) {
    const parts = Object.entries(row)
        .filter(([field]) => !COMMON_EXPORT_COLUMNS.includes(field))
        .map(([field, value]) => {
        if (shouldTreatAsMetricField(field)) {
            return "";
        }
        return formatContextValue(field, value);
    })
        .filter(Boolean);
    return parts.length > 0 ? parts : [attachment.reportTitle || attachment.attachmentName || attachment.reportType];
}
function pickContextValues(row, preferredFields, limit) {
    const values = [];
    const seen = new Set();
    for (const field of preferredFields) {
        const formatted = formatContextValue(field, row[field]);
        if (!formatted || seen.has(formatted)) {
            continue;
        }
        values.push(formatted);
        seen.add(formatted);
        if (values.length >= limit) {
            return values;
        }
    }
    return values;
}
function formatContextValue(field, value) {
    const text = normalizeWhitespace(value);
    if (!text) {
        return "";
    }
    if (COMMON_EXPORT_COLUMNS.includes(field)) {
        return "";
    }
    if (["section", "subsection", "group_name", "report_name", "metric_name", "summary_label"].includes(field)) {
        return text;
    }
    return `${humanizeFieldLabel(field)}: ${text}`;
}
function shouldTreatAsMetricField(field) {
    if (COMMON_EXPORT_COLUMNS.includes(field)) {
        return false;
    }
    if (["section", "subsection", "group_name", "report_name", "metric_name", "summary_label", "row_kind", "line_text", "note"].includes(field)) {
        return false;
    }
    if (/_date$|_time$|_name$|_code$|_type$|_status$|_method$|_plan$|_flag$|_user$|_by$/.test(field)) {
        return false;
    }
    if (/(^|_)(id|no|number|fragment)$/.test(field)) {
        return false;
    }
    return true;
}
function buildPostingLine(baseLine, amount) {
    const roundedAmount = roundMoney(amount);
    const normalizedPolarity = baseLine.postingPolarity === "credit_positive" ? "credit_positive" : "debit_positive";
    let debit = 0;
    let credit = 0;
    if (normalizedPolarity === "credit_positive") {
        if (roundedAmount >= 0) {
            credit = roundedAmount;
        }
        else {
            debit = Math.abs(roundedAmount);
        }
    }
    else if (roundedAmount >= 0) {
        debit = roundedAmount;
    }
    else {
        credit = Math.abs(roundedAmount);
    }
    return {
        ...baseLine,
        postingPolarity: normalizedPolarity,
        rawAmount: formatMoney(roundedAmount),
        debit: formatMoney(debit),
        credit: formatMoney(credit)
    };
}
function parseJsonRecord(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return null;
    }
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
function buildMappingKey(reportType, amountField, parts) {
    return [
        reportType,
        amountField,
        ...parts.map((part) => normalizeMappingPart(part)).filter(Boolean)
    ].join(":");
}
function buildExternalId(propertySlug, reportType, accountingDate, attachmentId, prefix) {
    const normalizedPrefix = sanitizeExternalIdPart(prefix) || sanitizeExternalIdPart(propertySlug) || "synchrohrm";
    const normalizedDate = sanitizeExternalIdPart(accountingDate.replace(/-/g, "")) || `attachment${attachmentId}`;
    const normalizedReportType = sanitizeExternalIdPart(reportType) || "report";
    return `${normalizedPrefix}-${normalizedReportType}-${normalizedDate}`;
}
function renderMemoTemplate(template, context) {
    const source = normalizeWhitespace(template) || "Synchro HRM {propertyName} {reportTitle} {reportDate}";
    return source.replace(/\{(propertyName|propertySlug|reportType|reportTitle|reportDate|attachmentName)\}/g, (_match, token) => {
        switch (token) {
            case "propertyName":
                return context.propertyName;
            case "propertySlug":
                return context.propertySlug;
            case "reportType":
                return context.reportType;
            case "reportTitle":
                return context.reportTitle;
            case "reportDate":
                return context.reportDate;
            case "attachmentName":
                return context.attachmentName;
            default:
                return "";
        }
    }).trim();
}
function sanitizeExternalIdPart(value) {
    return normalizeWhitespace(value)
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function parseAmount(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? roundMoney(value) : null;
    }
    const raw = normalizeWhitespace(value);
    if (!raw) {
        return null;
    }
    const negative = raw.startsWith("(") && raw.endsWith(")");
    const cleaned = raw
        .replace(/[$,%]/g, "")
        .replace(/[()]/g, "")
        .replace(/^\+/, "");
    if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
        return null;
    }
    const amount = Number(cleaned);
    if (!Number.isFinite(amount)) {
        return null;
    }
    return roundMoney(negative ? -Math.abs(amount) : amount);
}
function pickPostedDefault(defaults, key, fallback) {
    return Object.prototype.hasOwnProperty.call(defaults, key)
        ? normalizeWhitespace(defaults[key])
        : fallback;
}
function normalizeWhitespace(value) {
    return typeof value === "string"
        ? value.replace(/\s+/g, " ").trim()
        : (value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim());
}
function normalizeMappingPart(value) {
    return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function roundMoney(value) {
    return Math.round(value * 100) / 100;
}
function formatMoney(value) {
    return roundMoney(value).toFixed(2);
}
function buildSupportedReportTypeSummaries(attachments) {
    const summaryByType = new Map();
    for (const attachment of attachments) {
        const existing = summaryByType.get(attachment.reportType);
        if (existing) {
            existing.attachmentCount += 1;
            continue;
        }
        summaryByType.set(attachment.reportType, {
            reportType: attachment.reportType,
            reportTitle: attachment.reportTitle || REPORT_TITLES[attachment.reportType],
            attachmentCount: 1
        });
    }
    return Array.from(summaryByType.values()).sort((left, right) => {
        const titleComparison = left.reportTitle.localeCompare(right.reportTitle);
        if (titleComparison !== 0) {
            return titleComparison;
        }
        return left.reportType.localeCompare(right.reportType);
    });
}
function normalizeSupportedReportType(value) {
    return SUPPORTED_NETSUITE_REPORT_TYPES.includes(value)
        ? value
        : null;
}
function normalizePostingPolarity(value) {
    const normalized = normalizeWhitespace(value).toLowerCase().replace(/\s+/g, "_");
    if (normalized === "debit_positive" || normalized === "credit_positive") {
        return normalized;
    }
    return null;
}
function humanizeFieldLabel(field) {
    return field
        .replace(/_/g, " ")
        .replace(/\bpct\b/gi, "Pct")
        .replace(/\badr\b/g, "ADR")
        .replace(/\booo\b/gi, "OOO")
        .replace(/\bytd\b/gi, "YTD")
        .replace(/\bmtd\b/gi, "MTD")
        .replace(/\bdb\b/gi, "DB")
        .replace(/\b(ar|gl)\b/gi, (match) => match.toUpperCase())
        .replace(/\b\w/g, (match) => match.toUpperCase());
}
function inferMetricPolarity(field, groupLabel, itemLabel) {
    const text = [field, groupLabel, itemLabel].join(" ").toLowerCase();
    if (/(revenue|sales|tax|credit|deposit|payable|closing balance|ending balance|refund \$|discount \$)/.test(text)) {
        return "credit_positive";
    }
    return "debit_positive";
}
function compareDiscoveredItems(left, right) {
    return [
        left.groupLabel.localeCompare(right.groupLabel, undefined, { numeric: true, sensitivity: "base" }),
        left.itemLabel.localeCompare(right.itemLabel, undefined, { numeric: true, sensitivity: "base" }),
        left.amountFieldLabel.localeCompare(right.amountFieldLabel, undefined, { numeric: true, sensitivity: "base" }),
        left.mappingKey.localeCompare(right.mappingKey, undefined, { numeric: true, sensitivity: "base" })
    ].find((value) => value !== 0) ?? 0;
}
export { SUPPORTED_NETSUITE_REPORT_TYPES };
