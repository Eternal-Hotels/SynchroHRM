import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppDatabase } from "../db/Database.js";
import { COMMON_EXPORT_COLUMNS, REPORT_COLUMN_MAP, REPORT_TITLES } from "../reports.js";
import { REPORT_TYPES, type ReportType } from "../types.js";
import { generateDeterministicStatisticalAccountNumber } from "../netsuite/statisticalAccountNumber.js";
import { NetSuiteConnectionService, NetSuiteSettingsError } from "./NetSuiteConnectionService.js";

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
] as const;
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
] as const;
const CONTEXT_FIELD_LIMIT = 4;

type SupportedMonetaryReportType = (typeof SUPPORTED_NETSUITE_REPORT_TYPES)[number];
type PostingPolarity = "debit_positive" | "credit_positive";

interface SupportedAttachmentSummary {
  attachmentId: number;
  attachmentName: string;
  reportType: SupportedMonetaryReportType;
  reportTitle: string;
  reportDate: string | null;
  receivedAt: string;
}

interface SupportedReportTypeSummary {
  reportType: SupportedMonetaryReportType;
  reportTitle: string;
  attachmentCount: number;
}

interface DiscoveredMonetaryItem {
  mappingKey: string;
  reportType: SupportedMonetaryReportType;
  reportTitle: string;
  groupLabel: string;
  itemLabel: string;
  amountField: string;
  amountFieldLabel: string;
  defaultPostingPolarity: PostingPolarity;
  amount: number;
}

interface PostingPreviewLine {
  mappingKey: string;
  groupLabel: string;
  itemLabel: string;
  amountField: string;
  amountFieldLabel: string;
  amountValue: number;
  rawAmount: string;
  statisticalAccountNumber: string;
  statisticalAccountName: string;
  statisticalAccountExternalId: string;
  netsuiteAccountId: string;
  accountSyncStatus: string;
}

interface PostingPreviewValidation {
  level: "error" | "warning";
  code: string;
  message: string;
  mappingKey: string;
}

interface PostingPreviewPayload {
  propertySlug: string;
  propertyName: string;
  reportType: SupportedMonetaryReportType;
  reportTitle: string;
  attachmentId: number;
  attachmentName: string;
  reportDate: string | null;
  receivedAt: string;
  accountingDate: string;
  externalId: string;
  memo: string;
  defaults: PostingDefaults;
  summary: {
    lineCount: number;
    nonZeroLineCount: number;
    missingAccountCount: number;
    postable: boolean;
  };
  validations: PostingPreviewValidation[];
  lines: PostingPreviewLine[];
}

interface PostingDefaults {
  balancingGlCode: string;
  externalIdPrefix: string;
  memoTemplate: string;
  subsidiaryId: string;
  currencyId: string;
  locationId: string;
  departmentId: string;
  classId: string;
  unitsTypeId: string;
  unitId: string;
  updatedAt: string;
}

interface MonetaryMappingInput {
  mappingKey: string;
}

interface PostingDefaultsInput {
  balancingGlCode?: string;
  externalIdPrefix?: string;
  memoTemplate?: string;
  subsidiaryId?: string;
  currencyId?: string;
  locationId?: string;
  departmentId?: string;
  classId?: string;
  unitsTypeId?: string;
  unitId?: string;
}

interface MonetaryWorkspacePayload {
  property: Record<string, unknown>;
  availableReportTypes: SupportedReportTypeSummary[];
  supportedAttachments: SupportedAttachmentSummary[];
  selectedAttachment: SupportedAttachmentSummary | null;
  selectedReportType: SupportedMonetaryReportType | null;
  discoverySummary: {
    supportedReportTypeCount: number;
    attachmentCount: number;
    discoveredItemCount: number;
  };
  mappings: Array<Record<string, unknown>>;
  defaults: PostingDefaults;
  runs: Array<Record<string, unknown>>;
}

interface StatisticalAccountAssignment {
  mappingKey: string;
  groupLabel: string;
  itemLabel: string;
  amountField: string;
  amountFieldLabel: string;
  currentAmount: string;
  currentAmountValue: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAttachmentId: number | null;
  lastAttachmentName: string;
  updatedAt: string;
  accountNumber: string;
  accountName: string;
  externalId: string;
  netsuiteAccountId: string;
  accountSyncStatus: string;
  lastSyncedAt: string;
  lastSyncError: string;
}

export class NetSuitePostingError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "NetSuitePostingError";
  }
}

export class NetSuitePostingService {
  constructor(
    private readonly database: AppDatabase,
    private readonly connectionService: NetSuiteConnectionService
  ) {}

  listProperties(): Array<Record<string, unknown>> {
    const summaries = this.database.listNetSuitePostingPropertySummaries([...SUPPORTED_NETSUITE_REPORT_TYPES]);
    return summaries.map((entry) => ({
      ...entry,
      supportedReportTypes: buildSupportedReportTypeSummaries(
        this.listSupportedAttachments(String(entry.property_slug || ""))
      )
    }));
  }

  getWorkspace(
    propertySlug: string,
    attachmentId?: number | null,
    requestedReportType?: string | null
  ): MonetaryWorkspacePayload {
    const property = this.database.getPropertySummary(propertySlug);
    if (!property) {
      throw new NetSuitePostingError(`Property ${propertySlug} was not found.`, 404);
    }

    const supportedAttachments = this.listSupportedAttachments(propertySlug);
    const availableReportTypes = buildSupportedReportTypeSummaries(supportedAttachments);
    const selectedAttachment = this.selectAttachment(
      supportedAttachments,
      attachmentId ?? null,
      requestedReportType ?? null
    );
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
    const defaults = normalizePostingDefaults(
      this.database.getNetSuitePostingDefaults(propertySlug, selectedAttachment.reportType)
    );
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

  saveSetup(
    propertySlug: string,
    attachmentId: number,
    mappings: MonetaryMappingInput[],
    defaults: PostingDefaultsInput
  ): MonetaryWorkspacePayload {
    const attachment = this.requireAttachment(propertySlug, attachmentId);
    const discovered = this.discoverItemsForAttachment(attachment);
    this.persistSetup(propertySlug, attachment, discovered, mappings, defaults);
    return this.getWorkspace(propertySlug, attachmentId);
  }

  async syncStatisticalAccounts(
    propertySlug: string,
    attachmentId: number,
    mappings: MonetaryMappingInput[],
    defaults: PostingDefaultsInput
  ): Promise<{ workspace: MonetaryWorkspacePayload; sync: Record<string, unknown> }> {
    const attachment = this.requireAttachment(propertySlug, attachmentId);
    const discovered = this.discoverItemsForAttachment(attachment);
    this.persistSetup(propertySlug, attachment, discovered, mappings, defaults);

    const workspace = this.getWorkspace(propertySlug, attachmentId);
    const sync = await syncStatisticalAccountsForWorkspace(
      this.database,
      this.connectionService,
      workspace.property,
      attachment,
      workspace.mappings,
      workspace.defaults
    );

    return {
      workspace: this.getWorkspace(propertySlug, attachmentId),
      sync
    };
  }

  buildPreview(
    propertySlug: string,
    attachmentId: number,
    createdByUsername: string,
    mappings: MonetaryMappingInput[],
    defaults: PostingDefaultsInput
  ): { run: Record<string, unknown>; workspace: MonetaryWorkspacePayload } {
    const attachment = this.requireAttachment(propertySlug, attachmentId);
    const discovered = this.discoverItemsForAttachment(attachment);
    this.persistSetup(propertySlug, attachment, discovered, mappings, defaults);

    const workspace = this.getWorkspace(propertySlug, attachmentId);
    const preview = buildPostingPreview(
      workspace.property,
      attachment,
      workspace.mappings,
      workspace.defaults
    );
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

  async submitRun(propertySlug: string, runId: string): Promise<Record<string, unknown>> {
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
    const missingAccounts = preview.lines
      .filter((line) => !normalizeWhitespace(line.netsuiteAccountId))
      .map((line) => normalizeWhitespace(line.itemLabel) || normalizeWhitespace(line.mappingKey))
      .filter(Boolean);
    if (missingAccounts.length > 0) {
      const message = `Statistical accounts must be synchronized before submit. Missing account IDs for: ${missingAccounts.join(", ")}.`;
      this.database.updateNetSuitePostingRun(runId, {
        status: "failed",
        netsuiteResponseSummary: message,
        errorMessage: message
      });
      throw new NetSuitePostingError(message);
    }

    const journalRecord = buildStatisticalJournalEntryRecord(preview);

    try {
      const result = await this.connectionService.createStatisticalJournalEntry(journalRecord);
      const responseSummary = result.journalEntry.tranId
        ? `Submitted to NetSuite as statistical journal ${result.journalEntry.tranId}.`
        : (result.journalEntry.id
          ? `Submitted to NetSuite as statistical journal ${result.journalEntry.id}.`
          : "Submitted to NetSuite.");
      this.database.updateNetSuitePostingRun(runId, {
        status: "submitted",
        netsuiteResponseSummary: responseSummary,
        netsuiteResponsePayload: result.raw,
        errorMessage: "",
        submittedAt: new Date().toISOString()
      });
      return normalizePostingRun(this.database.getNetSuitePostingRun(runId));
    } catch (error) {
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

  private listSupportedAttachments(propertySlug: string): SupportedAttachmentSummary[] {
    const deduped = new Map<string, Record<string, unknown>>();

    for (const attachment of this.database.getPropertyAttachments(propertySlug)) {
      if (attachment.status !== "parsed") {
        continue;
      }

      const reportType = normalizeSupportedReportType(attachment.report_type);
      if (!reportType) {
        continue;
      }

      const key = buildSupportedAttachmentGroupKey(attachment, reportType);
      const current = deduped.get(key);
      if (!current || prefersSupportedAttachment(attachment, current)) {
        deduped.set(key, attachment);
      }
    }

    return Array.from(deduped.values())
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
        } satisfies SupportedAttachmentSummary;
      })
      .filter((attachment): attachment is SupportedAttachmentSummary => attachment !== null)
      .sort((left, right) => {
        if (left.receivedAt !== right.receivedAt) {
          return right.receivedAt.localeCompare(left.receivedAt);
        }
        return right.attachmentId - left.attachmentId;
      });
  }

  private selectAttachment(
    attachments: SupportedAttachmentSummary[],
    attachmentId: number | null,
    requestedReportType: string | null
  ): SupportedAttachmentSummary | null {
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

  private requireAttachment(propertySlug: string, attachmentId: number): SupportedAttachmentSummary {
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

  private discoverItemsForAttachment(attachment: SupportedAttachmentSummary): DiscoveredMonetaryItem[] {
    const rows = this.database.getAttachmentExportRows(attachment.reportType, attachment.attachmentId);
    return discoverAllPostingItems(rows, attachment);
  }

  private persistSetup(
    propertySlug: string,
    attachment: SupportedAttachmentSummary,
    discovered: DiscoveredMonetaryItem[],
    mappings: MonetaryMappingInput[],
    defaults: PostingDefaultsInput
  ): void {
    const now = new Date().toISOString();
    const existingByKey = new Map(
      this.database
        .getNetSuiteMonetaryMappings(propertySlug, attachment.reportType)
        .map((entry) => [String(entry.mapping_key || ""), entry])
    );

    this.database.upsertNetSuiteMonetaryMappings(discovered.map((item) => {
      const existing = existingByKey.get(item.mappingKey) ?? null;
      return {
        propertySlug,
        reportType: attachment.reportType,
        mappingKey: item.mappingKey,
        groupLabel: item.groupLabel,
        itemLabel: item.itemLabel,
        amountField: item.amountField,
        amountFieldLabel: item.amountFieldLabel,
        defaultPostingPolarity: item.defaultPostingPolarity,
        postingPolarity: normalizePostingPolarity(existing?.posting_polarity) ?? item.defaultPostingPolarity,
        netsuiteGlCode: normalizeWhitespace(existing?.netsuite_gl_code),
        statisticalAccountNumber: normalizeWhitespace(existing?.statistical_account_number),
        statisticalAccountName: normalizeWhitespace(existing?.statistical_account_name),
        statisticalAccountExternalId: normalizeWhitespace(existing?.statistical_account_external_id),
        netsuiteAccountId: normalizeWhitespace(existing?.netsuite_account_id),
        accountSyncStatus: normalizeWhitespace(existing?.account_sync_status),
        lastSyncedAt: normalizeWhitespace(existing?.last_synced_at),
        lastSyncError: normalizeWhitespace(existing?.last_sync_error),
        firstSeenAt: typeof existing?.first_seen_at === "string" && existing.first_seen_at
          ? existing.first_seen_at
          : now,
        lastSeenAt: now,
        lastAttachmentId: attachment.attachmentId,
        lastAttachmentName: attachment.attachmentName,
        updatedAt: now
      };
    }));

    const currentDefaults = normalizePostingDefaults(
      this.database.getNetSuitePostingDefaults(propertySlug, attachment.reportType)
    );
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
      unitsTypeId: pickPostedDefault(defaults, "unitsTypeId", currentDefaults.unitsTypeId),
      unitId: pickPostedDefault(defaults, "unitId", currentDefaults.unitId),
      updatedAt: now
    });
  }
}

function mergeMappings(
  discovered: DiscoveredMonetaryItem[],
  savedMappings: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const savedByKey = new Map(
    savedMappings.map((entry) => [String(entry.mapping_key || ""), entry])
  );

  return discovered.map((item) => {
    const saved = savedByKey.get(item.mappingKey) ?? null;
    return {
      mappingKey: item.mappingKey,
      reportType: item.reportType,
      reportTitle: item.reportTitle,
      groupLabel: item.groupLabel,
      itemLabel: item.itemLabel,
      amountField: item.amountField,
      amountFieldLabel: item.amountFieldLabel,
      defaultPostingPolarity: item.defaultPostingPolarity,
      currentAmount: formatMoney(item.amount),
      currentAmountValue: item.amount,
      statisticalAccountNumber: normalizeWhitespace(saved?.statistical_account_number),
      statisticalAccountName: normalizeWhitespace(saved?.statistical_account_name),
      statisticalAccountExternalId: normalizeWhitespace(saved?.statistical_account_external_id),
      netsuiteAccountId: normalizeWhitespace(saved?.netsuite_account_id),
      accountSyncStatus: normalizeWhitespace(saved?.account_sync_status),
      lastSyncedAt: normalizeWhitespace(saved?.last_synced_at),
      lastSyncError: normalizeWhitespace(saved?.last_sync_error),
      firstSeenAt: typeof saved?.first_seen_at === "string" ? saved.first_seen_at : "",
      lastSeenAt: typeof saved?.last_seen_at === "string" ? saved.last_seen_at : "",
      lastAttachmentId: typeof saved?.last_attachment_id === "number" ? saved.last_attachment_id : null,
      lastAttachmentName: typeof saved?.last_attachment_name === "string" ? saved.last_attachment_name : "",
      updatedAt: typeof saved?.updated_at === "string" ? saved.updated_at : ""
    };
  });
}

function normalizePostingDefaults(value: Record<string, unknown> | null): PostingDefaults {
  return {
    balancingGlCode: normalizeWhitespace(value?.balancing_gl_code),
    externalIdPrefix: normalizeWhitespace(value?.external_id_prefix),
    memoTemplate: normalizeWhitespace(value?.memo_template),
    subsidiaryId: normalizeWhitespace(value?.subsidiary_id),
    currencyId: normalizeWhitespace(value?.currency_id),
    locationId: normalizeWhitespace(value?.location_id),
    departmentId: normalizeWhitespace(value?.department_id),
    classId: normalizeWhitespace(value?.class_id),
    unitsTypeId: normalizeWhitespace(value?.units_type_id),
    unitId: normalizeWhitespace(value?.unit_id),
    updatedAt: typeof value?.updated_at === "string" ? value.updated_at : ""
  };
}

function emptyPostingDefaults(): PostingDefaults {
  return {
    balancingGlCode: "",
    externalIdPrefix: "",
    memoTemplate: "",
    subsidiaryId: "",
    currencyId: "",
    locationId: "",
    departmentId: "",
    classId: "",
    unitsTypeId: "",
    unitId: "",
    updatedAt: ""
  };
}

function normalizePostingRun(run: Record<string, unknown> | null): Record<string, unknown> {
  if (!run) {
    return {};
  }

  return {
    ...run,
    previewPayload: normalizePreviewPayload(run.preview_payload),
    netsuiteResponsePayload: parseJsonRecord(run.netsuite_response_payload)
  };
}

function normalizePreviewPayload(value: unknown): PostingPreviewPayload | null {
  const parsed = parseJsonRecord(value);
  if (!parsed) {
    return null;
  }

  return parsed as unknown as PostingPreviewPayload;
}

function buildPostingPreview(
  property: Record<string, unknown>,
  attachment: SupportedAttachmentSummary,
  mappings: Array<Record<string, unknown>>,
  defaults: PostingDefaults
): PostingPreviewPayload {
  const validations: PostingPreviewValidation[] = [];
  const lines: PostingPreviewLine[] = [];
  let nonZeroLineCount = 0;
  let missingAccountCount = 0;

  for (const mapping of mappings) {
    const amount = typeof mapping.currentAmountValue === "number" ? mapping.currentAmountValue : parseAmount(mapping.currentAmount) ?? 0;
    if (roundMoney(amount) === 0) {
      continue;
    }
    nonZeroLineCount += 1;

    const netsuiteAccountId = normalizeWhitespace(mapping.netsuiteAccountId);
    if (!netsuiteAccountId) {
      validations.push({
        level: "error",
        code: "missing_statistical_account",
        message: `Statistical account sync is still missing for ${String(mapping.itemLabel || "this report line")}.`,
        mappingKey: String(mapping.mappingKey || "")
      });
      missingAccountCount += 1;
    }

    lines.push({
      mappingKey: String(mapping.mappingKey || ""),
      groupLabel: String(mapping.groupLabel || ""),
      itemLabel: String(mapping.itemLabel || ""),
      amountField: String(mapping.amountField || ""),
      amountFieldLabel: String(mapping.amountFieldLabel || ""),
      amountValue: roundMoney(amount),
      rawAmount: formatMoney(amount),
      statisticalAccountNumber: normalizeWhitespace(mapping.statisticalAccountNumber),
      statisticalAccountName: normalizeWhitespace(mapping.statisticalAccountName),
      statisticalAccountExternalId: normalizeWhitespace(mapping.statisticalAccountExternalId),
      netsuiteAccountId,
      accountSyncStatus: normalizeWhitespace(mapping.accountSyncStatus) || (netsuiteAccountId ? "synced" : "pending")
    });
  }

  if (lines.length === 0) {
    validations.push({
      level: "warning",
      code: "no_posting_lines",
      message: "No non-zero statistical values were available for this attachment.",
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
      nonZeroLineCount,
      missingAccountCount,
      postable: validations.every((validation) => validation.level !== "error")
    },
    validations,
    lines
  };
}

function buildStatisticalJournalEntryRecord(preview: PostingPreviewPayload): Record<string, unknown> {
  const record: Record<string, unknown> = {
    externalId: preview.externalId,
    tranDate: preview.accountingDate,
    memo: preview.memo,
    line: {
      items: preview.lines.map((line) => {
        return {
          account: {
            id: line.netsuiteAccountId
          },
          memo: [line.groupLabel, line.itemLabel].filter(Boolean).join(": "),
          debit: roundMoney(line.amountValue)
        };
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

async function syncStatisticalAccountsForWorkspace(
  database: AppDatabase,
  connectionService: NetSuiteConnectionService,
  property: Record<string, unknown>,
  attachment: SupportedAttachmentSummary,
  mappings: Array<Record<string, unknown>>,
  defaults: PostingDefaults
): Promise<Record<string, unknown>> {
  const propertySlug = String(property.property_slug || "");
  const propertyName = String(property.property_name || propertySlug || "Property");
  const assignments = createStatisticalAccountAssignments(propertyName, propertySlug, attachment, mappings);
  const lookup = await connectionService.resolveStatisticalAccounts(
    assignments.map((entry) => entry.accountNumber),
    assignments.map((entry) => entry.externalId)
  );
  const takenNumbers = new Set<string>([
    ...Object.keys(lookup.byAccountNumber),
    ...assignments.map((entry) => entry.accountNumber).filter(Boolean)
  ]);
  const needsCreate = assignments.filter((entry) => !lookup.byExternalId[entry.externalId]);
  const missingDefaults: string[] = [];
  if (needsCreate.length > 0 && !defaults.subsidiaryId) {
    missingDefaults.push("Subsidiary ID");
  }
  if (needsCreate.length > 0 && !defaults.unitsTypeId) {
    missingDefaults.push("Units Type ID");
  }
  if (needsCreate.length > 0 && !defaults.unitId) {
    missingDefaults.push("Default Unit");
  }

  let createdCount = 0;
  let reusedCount = 0;
  let errorCount = 0;
  const persistedAt = new Date().toISOString();

  for (const assignment of assignments) {
    const existingByExternalId = lookup.byExternalId[assignment.externalId];
    if (existingByExternalId) {
      assignment.accountNumber = existingByExternalId.acctNumber || assignment.accountNumber;
      assignment.accountName = existingByExternalId.acctName || assignment.accountName;
      assignment.netsuiteAccountId = existingByExternalId.id;
      assignment.accountSyncStatus = "synced";
      assignment.lastSyncedAt = persistedAt;
      assignment.lastSyncError = "";
      reusedCount += 1;
      takenNumbers.add(assignment.accountNumber);
      continue;
    }

    if (missingDefaults.length > 0) {
      assignment.accountSyncStatus = "error";
      assignment.lastSyncError = `${missingDefaults.join(", ")} must be set before statistical accounts can be synchronized.`;
      errorCount += 1;
      continue;
    }

    while (true) {
      const collision = lookup.byAccountNumber[assignment.accountNumber];
      if (!collision || collision.externalId === assignment.externalId) {
        break;
      }

      takenNumbers.add(assignment.accountNumber);
      assignment.accountNumber = generateDeterministicStatisticalAccountNumber({
        propertySlug,
        reportType: attachment.reportType,
        mappingKey: assignment.mappingKey,
        takenNumbers
      });
    }

    try {
      const created = await connectionService.createStatisticalAccount(
        buildStatisticalAccountRecord(assignment, defaults)
      );
      assignment.accountNumber = created.account.acctNumber || assignment.accountNumber;
      assignment.accountName = created.account.acctName || assignment.accountName;
      assignment.netsuiteAccountId = created.account.id;
      assignment.accountSyncStatus = "synced";
      assignment.lastSyncedAt = persistedAt;
      assignment.lastSyncError = "";
      lookup.byAccountNumber[assignment.accountNumber] = {
        id: created.account.id,
        acctNumber: assignment.accountNumber,
        acctName: assignment.accountName,
        externalId: assignment.externalId
      };
      lookup.byExternalId[assignment.externalId] = lookup.byAccountNumber[assignment.accountNumber];
      takenNumbers.add(assignment.accountNumber);
      createdCount += 1;
    } catch (error) {
      assignment.accountSyncStatus = "error";
      assignment.lastSyncError = error instanceof Error ? error.message : String(error);
      errorCount += 1;
    }
  }

  database.upsertNetSuiteMonetaryMappings(assignments.map((entry) => buildPersistedMappingRecord(
    propertySlug,
    attachment.reportType,
    attachment,
    entry,
    persistedAt
  )));

  const summary = errorCount > 0
    ? `Statistical account sync completed with ${createdCount} created, ${reusedCount} reused, and ${errorCount} error(s).`
    : `Statistical account sync completed with ${createdCount} created and ${reusedCount} reused.`;

  return {
    createdCount,
    reusedCount,
    errorCount,
    message: summary
  };
}

function createStatisticalAccountAssignments(
  propertyName: string,
  propertySlug: string,
  attachment: SupportedAttachmentSummary,
  mappings: Array<Record<string, unknown>>
): StatisticalAccountAssignment[] {
  const takenNumbers = new Set(
    mappings
      .map((entry) => normalizeWhitespace(entry.statisticalAccountNumber))
      .filter(Boolean)
  );

  return mappings.map((mapping) => {
    const mappingKey = String(mapping.mappingKey || "");
    const savedNumber = normalizeWhitespace(mapping.statisticalAccountNumber);
    const accountNumber = savedNumber || generateDeterministicStatisticalAccountNumber({
      propertySlug,
      reportType: attachment.reportType,
      mappingKey,
      takenNumbers
    });
    takenNumbers.add(accountNumber);

    return {
      mappingKey,
      groupLabel: String(mapping.groupLabel || ""),
      itemLabel: String(mapping.itemLabel || ""),
      amountField: String(mapping.amountField || ""),
      amountFieldLabel: String(mapping.amountFieldLabel || ""),
      currentAmount: String(mapping.currentAmount || "0.00"),
      currentAmountValue: typeof mapping.currentAmountValue === "number" ? mapping.currentAmountValue : parseAmount(mapping.currentAmount) ?? 0,
      firstSeenAt: typeof mapping.firstSeenAt === "string" && mapping.firstSeenAt ? mapping.firstSeenAt : "",
      lastSeenAt: typeof mapping.lastSeenAt === "string" && mapping.lastSeenAt ? mapping.lastSeenAt : "",
      lastAttachmentId: typeof mapping.lastAttachmentId === "number" ? mapping.lastAttachmentId : null,
      lastAttachmentName: typeof mapping.lastAttachmentName === "string" ? mapping.lastAttachmentName : "",
      updatedAt: typeof mapping.updatedAt === "string" && mapping.updatedAt ? mapping.updatedAt : "",
      accountNumber,
      accountName: buildStatisticalAccountName(propertyName, attachment, mapping),
      externalId: buildStatisticalAccountExternalId(propertySlug, attachment.reportType, mappingKey),
      netsuiteAccountId: normalizeWhitespace(mapping.netsuiteAccountId),
      accountSyncStatus: normalizeWhitespace(mapping.accountSyncStatus),
      lastSyncedAt: normalizeWhitespace(mapping.lastSyncedAt),
      lastSyncError: normalizeWhitespace(mapping.lastSyncError)
    };
  });
}

function buildPersistedMappingRecord(
  propertySlug: string,
  reportType: SupportedMonetaryReportType,
  attachment: SupportedAttachmentSummary,
  entry: StatisticalAccountAssignment,
  updatedAt: string
){
  return {
    propertySlug,
    reportType,
    mappingKey: entry.mappingKey,
    groupLabel: entry.groupLabel,
    itemLabel: entry.itemLabel,
    amountField: entry.amountField,
    amountFieldLabel: entry.amountFieldLabel,
    defaultPostingPolarity: "debit_positive",
    postingPolarity: "debit_positive",
    netsuiteGlCode: "",
    statisticalAccountNumber: entry.accountNumber,
    statisticalAccountName: entry.accountName,
    statisticalAccountExternalId: entry.externalId,
    netsuiteAccountId: entry.netsuiteAccountId,
    accountSyncStatus: entry.accountSyncStatus,
    lastSyncedAt: entry.lastSyncedAt,
    lastSyncError: entry.lastSyncError,
    firstSeenAt: entry.firstSeenAt || updatedAt,
    lastSeenAt: updatedAt,
    lastAttachmentId: attachment.attachmentId,
    lastAttachmentName: attachment.attachmentName,
    updatedAt
  };
}

function buildStatisticalAccountRecord(
  assignment: StatisticalAccountAssignment,
  defaults: PostingDefaults
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    acctType: { id: "Stat" },
    acctNumber: assignment.accountNumber,
    acctName: assignment.accountName,
    externalId: assignment.externalId,
    unitsType: { id: defaults.unitsTypeId },
    unit: defaults.unitId,
    subsidiary: {
      items: [{ id: defaults.subsidiaryId }]
    }
  };

  if (defaults.locationId) {
    record.location = { id: defaults.locationId };
  }
  if (defaults.departmentId) {
    record.department = { id: defaults.departmentId };
  }
  if (defaults.classId) {
    record.class = { id: defaults.classId };
  }

  return record;
}

function buildStatisticalAccountExternalId(
  propertySlug: string,
  reportType: SupportedMonetaryReportType,
  mappingKey: string
): string {
  return [
    "synchrohrm",
    "statacct",
    sanitizeExternalIdPart(propertySlug) || "property",
    sanitizeExternalIdPart(reportType) || "report",
    sanitizeExternalIdPart(mappingKey) || "mapping"
  ].join(":");
}

function buildStatisticalAccountName(
  propertyName: string,
  attachment: SupportedAttachmentSummary,
  mapping: Record<string, unknown>
): string {
  const parts = [
    propertyName,
    attachment.reportTitle || REPORT_TITLES[attachment.reportType] || attachment.reportType,
    String(mapping.itemLabel || mapping.groupLabel || mapping.mappingKey || "Stat")
  ].map((part) => normalizeWhitespace(part)).filter(Boolean);
  return parts.join(" ").slice(0, 31);
}

function discoverAllPostingItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  if (attachment.reportType === "choice_audit_packet_rows") {
    return discoverChoiceAuditPacketItems(rows, attachment);
  }

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

function discoverGenericPostingItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();

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

function discoverChoiceAuditPacketItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const items = [
    ...discoverChoiceHotelJournalSummaryItems(rows, attachment),
    ...discoverChoiceHotelStatisticsItems(rows, attachment),
    ...discoverChoiceRevenueByRateCodeItems(rows, attachment),
    ...discoverChoiceFinalTransactionCloseoutItems(rows, attachment)
  ];

  return mergeDiscoveredItems(items);
}

function discoverChoiceHotelJournalSummaryItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const items: DiscoveredMonetaryItem[] = [];

  for (const row of rows) {
    if (normalizeWhitespace(row.report_name) !== "Hotel Journal Summary") {
      continue;
    }

    const metric = extractChoiceMetricRow(row, 11);
    if (!metric || /^Today's Total:?$/i.test(metric.label)) {
      continue;
    }

    const amount = metric.values[3] ?? null;
    if (amount === null) {
      continue;
    }

    const itemLabel = buildChoiceCategoryLabel(metric.label, metric.code, attachment);
    items.push({
      mappingKey: buildMappingKey(attachment.reportType, "journal_total", ["hotel_journal_summary", itemLabel]),
      reportType: attachment.reportType,
      reportTitle: attachment.reportTitle,
      groupLabel: "Hotel Journal Summary",
      itemLabel,
      amountField: "journal_total",
      amountFieldLabel: "Journal Total",
      defaultPostingPolarity: inferMetricPolarity("journal_total", "Hotel Journal Summary", itemLabel),
      amount: roundMoney(amount)
    });
  }

  return items;
}

function discoverChoiceHotelStatisticsItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const items: DiscoveredMonetaryItem[] = [];
  let currentSection = "";

  for (const row of rows) {
    if (normalizeWhitespace(row.report_name) !== "Hotel Statistics") {
      continue;
    }

    const sectionName = normalizeWhitespace(row.section) || inferChoiceHotelStatisticsSection(row.line_text);
    if (sectionName) {
      currentSection = sectionName;
    }

    const metric = extractChoiceMetricRow(row, 5);
    if (!metric) {
      continue;
    }

    const amount = metric.values[0] ?? null;
    if (amount === null) {
      continue;
    }

    const groupLabel = currentSection
      ? `Hotel Statistics / ${currentSection}`
      : "Hotel Statistics";
    const itemLabel = metric.label;
    items.push({
      mappingKey: buildMappingKey(attachment.reportType, "current", ["hotel_statistics", groupLabel, itemLabel]),
      reportType: attachment.reportType,
      reportTitle: attachment.reportTitle,
      groupLabel,
      itemLabel,
      amountField: "current",
      amountFieldLabel: "Current",
      defaultPostingPolarity: inferMetricPolarity("current", groupLabel, itemLabel),
      amount: roundMoney(amount)
    });
  }

  return items;
}

function discoverChoiceRevenueByRateCodeItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const items: DiscoveredMonetaryItem[] = [];

  for (const row of rows) {
    if (normalizeWhitespace(row.report_name) !== "Revenue by Rate Code") {
      continue;
    }

    const metric = extractChoiceMetricRow(row, 15);
    if (!metric || /^Total\b/i.test(metric.label)) {
      continue;
    }

    const amount = metric.values[2] ?? null;
    if (amount === null) {
      continue;
    }

    const section = normalizeWhitespace(row.section);
    const groupLabel = section
      ? `Revenue by Rate Code / ${section}`
      : "Revenue by Rate Code";
    const itemLabel = metric.label;
    items.push({
      mappingKey: buildMappingKey(attachment.reportType, "daily_revenue", ["revenue_by_rate_code", groupLabel, itemLabel]),
      reportType: attachment.reportType,
      reportTitle: attachment.reportTitle,
      groupLabel,
      itemLabel,
      amountField: "daily_revenue",
      amountFieldLabel: "Daily Revenue",
      defaultPostingPolarity: inferMetricPolarity("daily_revenue", groupLabel, itemLabel),
      amount: roundMoney(amount)
    });
  }

  return items;
}

function discoverChoiceFinalTransactionCloseoutItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const items: DiscoveredMonetaryItem[] = [];
  let currentSection = "";

  for (const row of rows) {
    if (normalizeWhitespace(row.report_name) !== "Final Transaction Closeout") {
      continue;
    }

    const section = normalizeWhitespace(row.section);
    if (section) {
      currentSection = section;
    }

    if (normalizeWhitespace(row.row_kind) !== "total") {
      continue;
    }

    const metric = extractChoiceMetricRow(row, 6);
    const amount = metric?.values[3] ?? parseAmount(row.value_4);
    if (amount === null) {
      continue;
    }

    const groupLabel = currentSection
      ? `Final Transaction Closeout / ${currentSection}`
      : "Final Transaction Closeout";
    const itemLabel = metric?.label
      || normalizeWhitespace(row.metric_name)
      || normalizeWhitespace(row.line_text)
      || "Section Total";
    items.push({
      mappingKey: buildMappingKey(attachment.reportType, "todays_net", ["final_transaction_closeout", groupLabel, itemLabel]),
      reportType: attachment.reportType,
      reportTitle: attachment.reportTitle,
      groupLabel,
      itemLabel,
      amountField: "todays_net",
      amountFieldLabel: "Today's Net",
      defaultPostingPolarity: inferMetricPolarity("todays_net", groupLabel, itemLabel),
      amount: roundMoney(amount)
    });
  }

  return items;
}

function discoverCreditCardTransactionItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
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

function discoverOperatorTransactionItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();

  for (const row of rows) {
    const groupLabel = attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "Operator Transactions";
    const itemLabel = buildOperatorTransactionCategoryLabel(row, attachment);
    const amount = roundMoney(
      (parseAmount(row.amount) ?? 0)
      + (parseAmount(row.adjustment_amount) ?? 0)
    );
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

function discoverDailyTransactionLogItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();

  for (const row of rows) {
    const groupLabel = attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "Daily Transaction Log";
    const itemLabel = buildDailyTransactionLogCategoryLabel(row, attachment);
    const amount = roundMoney(
      (parseAmount(row.posted_amount) ?? 0)
      + (parseAmount(row.adjusted_amount) ?? 0)
    );
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

function discoverAllTransactionItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();

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

function discoverRoomTaxListingItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();

  for (const row of rows) {
    const chargeType = normalizeWhitespace(row.charge_type) || "Uncategorized";
    const groupLabel = `Charge Type: ${chargeType}`;

    for (const [amountField, amountFieldLabel] of [
      ["rate_amount", "Rate Amount"],
      ["tax_amount", "Tax Amount"]
    ] as const) {
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

function buildOperatorTransactionCategoryLabel(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string {
  const description = normalizeWhitespace(row.transaction_description)
    .replace(/\s+\d{1,4}-[A-Za-z]$/g, "")
    .replace(/\s+\d{1,4}$/g, "")
    .trim();
  return description
    || normalizeWhitespace(row.transaction_code)
    || attachment.reportTitle
    || "Operator Transactions";
}

function buildAllTransactionCategoryLabel(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string {
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

function humanizeCategoryValue(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }

  return normalized
    .toLowerCase()
    .replace(/\b(ar|gl|db|adr|ooo)\b/g, (match) => match.toUpperCase())
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildDailyTransactionLogCategoryLabel(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string {
  const description = normalizeWhitespace(row.transaction_description)
    .replace(/\s+\d{1,4}-[A-Za-z]$/g, "")
    .replace(/\s+\d{1,4}$/g, "")
    .trim();
  return description
    || normalizeWhitespace(row.transaction_code)
    || attachment.reportTitle
    || "Daily Transaction Log";
}

function discoverBestWesternDailyReportItems(
  rows: Array<Record<string, unknown>>,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();

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

function buildBestWesternDailyGroupLabel(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string {
  const parts = [
    normalizeWhitespace(row.section),
    normalizeWhitespace(row.subsection)
  ].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" / ");
  }

  return attachment.reportTitle || REPORT_TITLES[attachment.reportType] || "Daily Report";
}

function buildBestWesternDailyCategoryLabel(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string {
  const category = [
    normalizeWhitespace(row.group_name),
    normalizeWhitespace(row.metric_name),
    normalizeWhitespace(row.posting_description),
    normalizeWhitespace(row.posting_code)
  ].find(Boolean);
  return category || attachment.attachmentName || attachment.reportTitle || "Daily Report Category";
}

function extractChoiceMetricRow(
  row: Record<string, unknown>,
  maxValues: number
): { label: string; code: string; values: Array<number | null> } | null {
  const populatedValues = Array.from({ length: maxValues }, (_, index) => parseAmount(row[`value_${index + 1}`]));
  const hasStructuredValues = populatedValues.some((value) => value !== null);
  if (hasStructuredValues) {
    const labelSource = normalizeWhitespace(row.metric_name)
      || normalizeWhitespace(row.transaction_description)
      || normalizeWhitespace(row.rate_code)
      || normalizeWhitespace(row.line_text);
    if (!labelSource) {
      return null;
    }
    const split = splitChoiceMetricLabel(labelSource);
    return {
      label: split.label,
      code: split.code,
      values: populatedValues
    };
  }

  const parsed = extractChoiceFlexibleMetricText(normalizeWhitespace(row.line_text), maxValues);
  if (!parsed) {
    return null;
  }

  const split = splitChoiceMetricLabel(parsed.label);
  return {
    label: split.label,
    code: split.code,
    values: parsed.values
  };
}

function extractChoiceFlexibleMetricText(
  text: string,
  maxValues: number
): { label: string; values: number[] } | null {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/(\d)\s+%/g, "$1%");
  const tokenPattern = /(^|\s)(\(?-?(?:USD|\$)?\d[\d,]*(?:\.\d+)?\)?-?%?)/g;
  const tokens = Array.from(normalized.matchAll(tokenPattern)).map((match) => ({
    index: (match.index ?? 0) + match[1].length,
    value: match[2]
  }));
  if (tokens.length === 0 || tokens.length > maxValues) {
    return null;
  }

  const label = normalizeWhitespace(normalized.slice(0, tokens[0].index));
  if (!label) {
    return null;
  }

  const values = tokens
    .map((token) => parseAmount(token.value))
    .filter((value): value is number => value !== null);
  return values.length > 0 ? { label, values } : null;
}

function splitChoiceMetricLabel(value: string): { label: string; code: string } {
  const normalized = normalizeWhitespace(value);
  const stripped = normalized.replace(/^Transaction (?:Type|Code):\s*/i, "");
  const match = stripped.match(/^(.*?)(?:\s*\(([A-Za-z0-9/-]+)\))?$/);
  return {
    label: normalizeWhitespace(match?.[1] ?? stripped),
    code: normalizeWhitespace(match?.[2] ?? "")
  };
}

function buildChoiceCategoryLabel(label: string, code: string, attachment: SupportedAttachmentSummary): string {
  return normalizeWhitespace(label)
    || normalizeWhitespace(code)
    || attachment.reportTitle
    || "Daily Audit Packet";
}

function inferChoiceHotelStatisticsSection(value: unknown): string {
  const text = normalizeWhitespace(value);
  if (!text) {
    return "";
  }

  for (const prefix of [
    "Room Statistics",
    "Performance Statistics",
    "Revenue",
    "Guest Statistics"
  ]) {
    if (text.startsWith(prefix)) {
      return prefix;
    }
  }

  return "";
}

function mergeDiscoveredItems(items: DiscoveredMonetaryItem[]): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();

  for (const item of items) {
    const existing = byKey.get(item.mappingKey);
    if (existing) {
      existing.amount = roundMoney(existing.amount + item.amount);
      continue;
    }

    byKey.set(item.mappingKey, {
      ...item,
      amount: roundMoney(item.amount)
    });
  }

  return Array.from(byKey.values()).sort(compareDiscoveredItems);
}

function buildPostingItemCandidates(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): Array<Omit<DiscoveredMonetaryItem, "reportType" | "reportTitle">> {
  const groupLabel = buildPostingGroupLabel(row, attachment);
  const itemLabel = buildPostingItemLabel(row, attachment);
  const identityParts = buildPostingIdentityParts(row, attachment);

  return REPORT_COLUMN_MAP[attachment.reportType]
    .filter((field) => !COMMON_EXPORT_COLUMNS.includes(field as (typeof COMMON_EXPORT_COLUMNS)[number]))
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
      } satisfies Omit<DiscoveredMonetaryItem, "reportType" | "reportTitle">;
    })
    .filter((candidate): candidate is Omit<DiscoveredMonetaryItem, "reportType" | "reportTitle"> => candidate !== null);
}

function buildPostingGroupLabel(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string {
  const prioritized = pickContextValues(row, GROUP_CONTEXT_FIELDS, 3);
  if (prioritized.length > 0) {
    return prioritized.join(" / ");
  }

  return attachment.reportTitle || REPORT_TITLES[attachment.reportType] || humanizeFieldLabel(attachment.reportType);
}

function buildPostingItemLabel(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string {
  const prioritized = pickContextValues(row, ITEM_CONTEXT_FIELDS, CONTEXT_FIELD_LIMIT);
  if (prioritized.length > 0) {
    return prioritized.join(" / ");
  }

  const fallback = Object.entries(row)
    .filter(([field]) => !COMMON_EXPORT_COLUMNS.includes(field as (typeof COMMON_EXPORT_COLUMNS)[number]))
    .filter(([field]) => !shouldTreatAsMetricField(field))
    .map(([field, value]) => formatContextValue(field, value))
    .filter(Boolean)
    .slice(0, CONTEXT_FIELD_LIMIT);

  if (fallback.length > 0) {
    return fallback.join(" / ");
  }

  return attachment.attachmentName || attachment.reportTitle || "Report Row";
}

function buildPostingIdentityParts(
  row: Record<string, unknown>,
  attachment: SupportedAttachmentSummary
): string[] {
  const parts = Object.entries(row)
    .filter(([field]) => !COMMON_EXPORT_COLUMNS.includes(field as (typeof COMMON_EXPORT_COLUMNS)[number]))
    .map(([field, value]) => {
      if (shouldTreatAsMetricField(field)) {
        return "";
      }

      return formatContextValue(field, value);
    })
    .filter(Boolean);

  return parts.length > 0 ? parts : [attachment.reportTitle || attachment.attachmentName || attachment.reportType];
}

function pickContextValues(
  row: Record<string, unknown>,
  preferredFields: readonly string[],
  limit: number
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();

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

function formatContextValue(field: string, value: unknown): string {
  const text = normalizeWhitespace(value);
  if (!text) {
    return "";
  }

  if (COMMON_EXPORT_COLUMNS.includes(field as (typeof COMMON_EXPORT_COLUMNS)[number])) {
    return "";
  }

  if (["section", "subsection", "group_name", "report_name", "metric_name", "summary_label"].includes(field)) {
    return text;
  }

  return `${humanizeFieldLabel(field)}: ${text}`;
}

function shouldTreatAsMetricField(field: string): boolean {
  if (COMMON_EXPORT_COLUMNS.includes(field as (typeof COMMON_EXPORT_COLUMNS)[number])) {
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

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function buildMappingKey(reportType: SupportedMonetaryReportType, amountField: string, parts: string[]): string {
  return [
    reportType,
    amountField,
    ...parts.map((part) => normalizeMappingPart(part)).filter(Boolean)
  ].join(":");
}

function buildExternalId(
  propertySlug: string,
  reportType: SupportedMonetaryReportType,
  accountingDate: string,
  attachmentId: number,
  prefix: string
): string {
  const normalizedPrefix = sanitizeExternalIdPart(prefix) || sanitizeExternalIdPart(propertySlug) || "synchrohrm";
  const normalizedDate = sanitizeExternalIdPart(accountingDate.replace(/-/g, "")) || `attachment${attachmentId}`;
  const normalizedReportType = sanitizeExternalIdPart(reportType) || "report";
  return `${normalizedPrefix}-${normalizedReportType}-${normalizedDate}`;
}

function renderMemoTemplate(
  template: string,
  context: {
    propertyName: string;
    propertySlug: string;
    reportType: string;
    reportTitle: string;
    reportDate: string;
    attachmentName: string;
  }
): string {
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

function sanitizeExternalIdPart(value: string): string {
  return normalizeWhitespace(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseAmount(value: unknown): number | null {
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

function pickPostedDefault(
  defaults: PostingDefaultsInput,
  key: keyof PostingDefaultsInput,
  fallback: string
): string {
  return Object.prototype.hasOwnProperty.call(defaults, key)
    ? normalizeWhitespace(defaults[key])
    : fallback;
}

function normalizeWhitespace(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : (value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim());
}

function buildSupportedAttachmentGroupKey(
  attachment: Record<string, unknown>,
  reportType: SupportedMonetaryReportType
): string {
  const messageId = normalizeWhitespace(attachment.graph_message_id);
  const reportDate = normalizeWhitespace(attachment.report_date);
  const reportTitle = normalizeWhitespace(attachment.report_title || REPORT_TITLES[reportType]);
  const receivedAt = normalizeWhitespace(attachment.received_at);

  return [
    messageId || "__no_message__",
    reportType,
    reportDate || "__no_report_date__",
    reportTitle || "__no_report_title__",
    receivedAt || "__no_received_at__"
  ].join("::");
}

function prefersSupportedAttachment(
  candidate: Record<string, unknown>,
  current: Record<string, unknown>
): boolean {
  const candidateRank = supportedAttachmentRank(candidate);
  const currentRank = supportedAttachmentRank(current);
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank;
  }

  const candidateId = Number(candidate.id);
  const currentId = Number(current.id);
  return candidateId > currentId;
}

function supportedAttachmentRank(attachment: Record<string, unknown>): number {
  const extension = path.extname(String(attachment.attachment_name || "")).toLowerCase();
  switch (extension) {
    case ".xlsx":
    case ".xls":
      return 3;
    case ".csv":
      return 2;
    case ".pdf":
      return 1;
    default:
      return 0;
  }
}

function normalizeMappingPart(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return roundMoney(value).toFixed(2);
}

function buildSupportedReportTypeSummaries(
  attachments: SupportedAttachmentSummary[]
): SupportedReportTypeSummary[] {
  const summaryByType = new Map<SupportedMonetaryReportType, SupportedReportTypeSummary>();

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

function normalizeSupportedReportType(value: unknown): SupportedMonetaryReportType | null {
  return SUPPORTED_NETSUITE_REPORT_TYPES.includes(value as SupportedMonetaryReportType)
    ? value as SupportedMonetaryReportType
    : null;
}

function normalizePostingPolarity(value: unknown): PostingPolarity | null {
  const normalized = normalizeWhitespace(value).toLowerCase().replace(/\s+/g, "_");
  if (normalized === "debit_positive" || normalized === "credit_positive") {
    return normalized;
  }
  return null;
}

function humanizeFieldLabel(field: string): string {
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

function inferMetricPolarity(field: string, groupLabel: string, itemLabel: string): PostingPolarity {
  const text = [field, groupLabel, itemLabel].join(" ").toLowerCase();
  if (/(revenue|sales|tax|credit|deposit|payable|closing balance|ending balance|refund \$|discount \$)/.test(text)) {
    return "credit_positive";
  }
  return "debit_positive";
}

function compareDiscoveredItems(left: DiscoveredMonetaryItem, right: DiscoveredMonetaryItem): number {
  return [
    left.groupLabel.localeCompare(right.groupLabel, undefined, { numeric: true, sensitivity: "base" }),
    left.itemLabel.localeCompare(right.itemLabel, undefined, { numeric: true, sensitivity: "base" }),
    left.amountFieldLabel.localeCompare(right.amountFieldLabel, undefined, { numeric: true, sensitivity: "base" }),
    left.mappingKey.localeCompare(right.mappingKey, undefined, { numeric: true, sensitivity: "base" })
  ].find((value) => value !== 0) ?? 0;
}

export { SUPPORTED_NETSUITE_REPORT_TYPES };
