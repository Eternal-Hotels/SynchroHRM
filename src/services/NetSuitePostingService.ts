import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/Database.js";
import { REPORT_TITLES } from "../reports.js";
import type { ReportType } from "../types.js";
import { NetSuiteConnectionService, NetSuiteSettingsError } from "./NetSuiteConnectionService.js";

const SUPPORTED_MONETARY_REPORT_TYPES = [
  "all_transaction_rows",
  "best_western_daily_report_rows",
  "closed_folio_balance_rows",
  "direct_bill_aging_rows",
  "tax_report_rows",
  "trial_balance_report_rows"
] as const satisfies readonly ReportType[];

type SupportedMonetaryReportType = (typeof SUPPORTED_MONETARY_REPORT_TYPES)[number];
type PostingPolarity = "debit_positive" | "credit_positive";

interface SupportedAttachmentSummary {
  attachmentId: number;
  attachmentName: string;
  reportType: SupportedMonetaryReportType;
  reportTitle: string;
  reportDate: string | null;
  receivedAt: string;
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
  glCode: string;
  postingPolarity: PostingPolarity;
  rawAmount: string;
  debit: string;
  credit: string;
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
    debitTotal: string;
    creditTotal: string;
    balanceDifference: string;
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
  updatedAt: string;
}

interface MonetaryMappingInput {
  mappingKey: string;
  netsuiteGlCode: string;
  postingPolarity: string;
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
}

interface MonetaryWorkspacePayload {
  property: Record<string, unknown>;
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

interface ReportDefinition {
  reportType: SupportedMonetaryReportType;
  discover(rows: Array<Record<string, unknown>>, attachment: SupportedAttachmentSummary): DiscoveredMonetaryItem[];
}

const REPORT_DEFINITIONS: Record<SupportedMonetaryReportType, ReportDefinition> = {
  all_transaction_rows: {
    reportType: "all_transaction_rows",
    discover(rows, attachment) {
      return aggregateMonetaryItems(rows, (row) => {
        const amount = parseAmount(row.amount);
        if (amount === null) {
          return null;
        }

        const transactionCode = normalizeWhitespace(row.transaction_code);
        const transactionDescription = normalizeWhitespace(row.transaction_description);
        if (!transactionCode && !transactionDescription) {
          return null;
        }

        const section = normalizeWhitespace(row.section) || "Transactions";
        const transactionType = normalizeWhitespace(row.transaction_type);
        const chargeType = normalizeWhitespace(row.charge_type);
        const groupLabel = [section, transactionType, chargeType].filter(Boolean).join(" / ");
        const itemLabel = [transactionCode, transactionDescription].filter(Boolean).join(" ");

        return {
          mappingKey: buildMappingKey(attachment.reportType, "amount", [
            section,
            transactionType,
            chargeType,
            transactionCode,
            transactionDescription
          ]),
          groupLabel,
          itemLabel: itemLabel || "Transaction",
          amountField: "amount",
          amountFieldLabel: "Amount",
          defaultPostingPolarity: inferTransactionPolarity(transactionType, transactionDescription, chargeType),
          amount
        };
      }, attachment);
    }
  },
  best_western_daily_report_rows: {
    reportType: "best_western_daily_report_rows",
    discover(rows, attachment) {
      return aggregateMonetaryItems(rows, (row) => {
        const postingCode = normalizeWhitespace(row.posting_code);
        const postingDescription = normalizeWhitespace(row.posting_description);
        if (!postingCode && !postingDescription) {
          return null;
        }

        const amount = parseAmount(row.today_value);
        if (amount === null) {
          return null;
        }

        const section = normalizeWhitespace(row.section) || "Daily Report";
        const subsection = normalizeWhitespace(row.subsection);
        const groupName = normalizeWhitespace(row.group_name);
        const metricName = normalizeWhitespace(row.metric_name);
        const itemLabel = [postingCode, postingDescription || metricName].filter(Boolean).join(" ");

        return {
          mappingKey: buildMappingKey(attachment.reportType, "today_value", [
            section,
            subsection,
            groupName,
            postingCode,
            postingDescription,
            metricName
          ]),
          groupLabel: [section, subsection, groupName].filter(Boolean).join(" / ") || section,
          itemLabel: itemLabel || "Posting Row",
          amountField: "today_value",
          amountFieldLabel: "Today Value",
          defaultPostingPolarity: inferSectionPolarity(section, "credit_positive"),
          amount
        };
      }, attachment);
    }
  },
  closed_folio_balance_rows: {
    reportType: "closed_folio_balance_rows",
    discover(rows, attachment) {
      const items: DiscoveredMonetaryItem[] = [];
      items.push(...aggregateMonetaryItems(rows, (row) => {
        const amount = parseAmount(row.net_change);
        if (amount === null) {
          return null;
        }

        const section = normalizeWhitespace(row.section) || "Closed Folio Balances";
        const summaryLabel = normalizeWhitespace(row.summary_label);
        const guestName = normalizeWhitespace(row.guest_name);
        const companyName = normalizeWhitespace(row.company_name);
        const rowKind = normalizeWhitespace(row.row_kind);
        const itemLabel = summaryLabel || guestName || companyName;
        if (!itemLabel) {
          return null;
        }

        return {
          mappingKey: buildMappingKey(attachment.reportType, "net_change", [
            section,
            rowKind,
            summaryLabel,
            guestName,
            companyName
          ]),
          groupLabel: section,
          itemLabel,
          amountField: "net_change",
          amountFieldLabel: "Net Change",
          defaultPostingPolarity: "debit_positive",
          amount
        };
      }, attachment));
      items.push(...aggregateMonetaryItems(rows, (row) => {
        const amount = parseAmount(row.metric_value);
        if (amount === null) {
          return null;
        }

        const section = normalizeWhitespace(row.section) || "Closed Folio Balances";
        const summaryLabel = normalizeWhitespace(row.summary_label);
        if (!summaryLabel) {
          return null;
        }

        return {
          mappingKey: buildMappingKey(attachment.reportType, "metric_value", [section, summaryLabel]),
          groupLabel: section,
          itemLabel: summaryLabel,
          amountField: "metric_value",
          amountFieldLabel: "Metric Value",
          defaultPostingPolarity: "debit_positive",
          amount
        };
      }, attachment));
      return items.sort(compareDiscoveredItems);
    }
  },
  direct_bill_aging_rows: {
    reportType: "direct_bill_aging_rows",
    discover(rows, attachment) {
      return aggregateMonetaryItems(rows, (row) => {
        const amount = parseAmount(row.total_amount);
        if (amount === null) {
          return null;
        }

        const section = normalizeWhitespace(row.section) || "Direct Bill Aging";
        const companyCode = normalizeWhitespace(row.company_code);
        const companyName = normalizeWhitespace(row.company_name);
        if (!companyCode && !companyName) {
          return null;
        }

        return {
          mappingKey: buildMappingKey(attachment.reportType, "total_amount", [section, companyCode, companyName]),
          groupLabel: section,
          itemLabel: [companyCode, companyName].filter(Boolean).join(" "),
          amountField: "total_amount",
          amountFieldLabel: "Total Amount",
          defaultPostingPolarity: "debit_positive",
          amount
        };
      }, attachment);
    }
  },
  tax_report_rows: {
    reportType: "tax_report_rows",
    discover(rows, attachment) {
      return aggregateMonetaryItems(rows, (row) => {
        const amount = parseAmount(row.payable_tax);
        if (amount === null) {
          return null;
        }

        const taxName = normalizeWhitespace(row.tax_name);
        if (!taxName) {
          return null;
        }

        const section = normalizeWhitespace(row.section) || "Tax Report";
        return {
          mappingKey: buildMappingKey(attachment.reportType, "payable_tax", [section, taxName]),
          groupLabel: section,
          itemLabel: taxName,
          amountField: "payable_tax",
          amountFieldLabel: "Payable Tax",
          defaultPostingPolarity: "credit_positive",
          amount
        };
      }, attachment);
    }
  },
  trial_balance_report_rows: {
    reportType: "trial_balance_report_rows",
    discover(rows, attachment) {
      return aggregateMonetaryItems(rows, (row) => {
        const amount = parseAmount(row.net_change);
        if (amount === null) {
          return null;
        }

        const accountType = normalizeWhitespace(row.account_type);
        const accountName = normalizeWhitespace(row.account_name);
        const transactionCode = normalizeWhitespace(row.transaction_code);
        const rowKind = normalizeWhitespace(row.row_kind);
        if (rowKind && rowKind !== "detail") {
          return null;
        }
        if (!accountName && !transactionCode) {
          return null;
        }

        return {
          mappingKey: buildMappingKey(attachment.reportType, "net_change", [accountType, transactionCode, accountName]),
          groupLabel: accountType || "Trial Balance",
          itemLabel: [transactionCode, accountName].filter(Boolean).join(" "),
          amountField: "net_change",
          amountFieldLabel: "Net Change",
          defaultPostingPolarity: inferTrialBalancePolarity(accountType),
          amount
        };
      }, attachment);
    }
  }
};

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
    const summaries = this.database.listNetSuitePostingPropertySummaries([...SUPPORTED_MONETARY_REPORT_TYPES]);
    return summaries.map((entry) => ({
      ...entry,
      supportedReportTypes: [...SUPPORTED_MONETARY_REPORT_TYPES]
    }));
  }

  getWorkspace(propertySlug: string, attachmentId?: number | null): MonetaryWorkspacePayload {
    const property = this.database.getPropertySummary(propertySlug);
    if (!property) {
      throw new NetSuitePostingError(`Property ${propertySlug} was not found.`, 404);
    }

    const supportedAttachments = this.listSupportedAttachments(propertySlug);
    const selectedAttachment = this.selectAttachment(supportedAttachments, attachmentId ?? null);
    if (!selectedAttachment) {
      return {
        property,
        supportedAttachments,
        selectedAttachment: null,
        selectedReportType: null,
        discoverySummary: {
          supportedReportTypeCount: SUPPORTED_MONETARY_REPORT_TYPES.length,
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
      supportedAttachments,
      selectedAttachment,
      selectedReportType: selectedAttachment.reportType,
      discoverySummary: {
        supportedReportTypeCount: SUPPORTED_MONETARY_REPORT_TYPES.length,
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
      throw new NetSuitePostingError("Only a balanced preview can be submitted to NetSuite.");
    }

    const uniqueGlCodes = Array.from(new Set(
      preview.lines
        .map((line) => normalizeWhitespace(line.glCode))
        .filter(Boolean)
    ));
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
    attachmentId: number | null
  ): SupportedAttachmentSummary | null {
    if (attachmentId && Number.isInteger(attachmentId)) {
      const matched = attachments.find((attachment) => attachment.attachmentId === attachmentId);
      if (matched) {
        return matched;
      }
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
      throw new NetSuitePostingError(`Supported monetary attachment ${attachmentId} was not found for ${propertySlug}.`, 404);
    }

    return attachment;
  }

  private discoverItemsForAttachment(attachment: SupportedAttachmentSummary): DiscoveredMonetaryItem[] {
    const rows = this.database.getAttachmentExportRows(attachment.reportType, attachment.attachmentId);
    const definition = REPORT_DEFINITIONS[attachment.reportType];
    return definition.discover(rows, attachment).sort(compareDiscoveredItems);
  }

  private persistSetup(
    propertySlug: string,
    attachment: SupportedAttachmentSummary,
    discovered: DiscoveredMonetaryItem[],
    mappings: MonetaryMappingInput[],
    defaults: PostingDefaultsInput
  ): void {
    const now = new Date().toISOString();
    const mappingUpdates = new Map(
      mappings.map((entry) => [
        normalizeWhitespace(entry.mappingKey),
        {
          netsuiteGlCode: normalizeWhitespace(entry.netsuiteGlCode),
          postingPolarity: normalizePostingPolarity(entry.postingPolarity)
        }
      ])
    );
    const existingByKey = new Map(
      this.database
        .getNetSuiteMonetaryMappings(propertySlug, attachment.reportType)
        .map((entry) => [String(entry.mapping_key || ""), entry])
    );

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
        message: `Missing NetSuite GL code for ${String(mapping.itemLabel || "this monetary item")}.`,
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
  if (balanceDifference !== 0) {
    const balancingGlCode = normalizeWhitespace(defaults.balancingGlCode);
    if (balancingGlCode) {
      const balancingPolarity: PostingPolarity = balanceDifference > 0 ? "credit_positive" : "debit_positive";
      const balancingLine = buildPostingLine({
        mappingKey: "balancing_gl_code",
        groupLabel: "Balancing",
        itemLabel: "Balancing Line",
        amountField: "balancing_gl_code",
        amountFieldLabel: "Balancing GL Code",
        glCode: balancingGlCode,
        postingPolarity: balancingPolarity
      }, Math.abs(balanceDifference));
      lines.push(balancingLine);
      debitTotal += parseAmount(balancingLine.debit) ?? 0;
      creditTotal += parseAmount(balancingLine.credit) ?? 0;
      balanceDifference = roundMoney(debitTotal - creditTotal);
    } else {
      validations.push({
        level: "error",
        code: "missing_balancing_gl_code",
        message: `Preview needs a balancing GL code because it is off by ${formatMoney(balanceDifference)}.`,
        mappingKey: "balancing_gl_code"
      });
    }
  }

  if (lines.length === 0) {
    validations.push({
      level: "warning",
      code: "no_posting_lines",
      message: "No non-zero monetary rows were available for this attachment.",
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
      postable: validations.every((validation) => validation.level !== "error") && balanceDifference === 0
    },
    validations,
    lines
  };
}

function buildJournalEntryRecord(
  preview: PostingPreviewPayload,
  accountIdByNumber: Record<string, string>
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    externalId: preview.externalId,
    tranDate: preview.accountingDate,
    memo: preview.memo,
    line: {
      items: preview.lines.map((line) => {
        const payload: Record<string, unknown> = {
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

function aggregateMonetaryItems(
  rows: Array<Record<string, unknown>>,
  buildCandidate: (row: Record<string, unknown>) => Omit<DiscoveredMonetaryItem, "reportType" | "reportTitle"> | null,
  attachment: SupportedAttachmentSummary
): DiscoveredMonetaryItem[] {
  const byKey = new Map<string, DiscoveredMonetaryItem>();
  for (const row of rows) {
    const candidate = buildCandidate(row);
    if (!candidate) {
      continue;
    }

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

  return Array.from(byKey.values()).sort(compareDiscoveredItems);
}

function buildPostingLine(
  baseLine: Omit<PostingPreviewLine, "rawAmount" | "debit" | "credit">,
  amount: number
): PostingPreviewLine {
  const roundedAmount = roundMoney(amount);
  const normalizedPolarity = baseLine.postingPolarity === "credit_positive" ? "credit_positive" : "debit_positive";
  let debit = 0;
  let credit = 0;

  if (normalizedPolarity === "credit_positive") {
    if (roundedAmount >= 0) {
      credit = roundedAmount;
    } else {
      debit = Math.abs(roundedAmount);
    }
  } else if (roundedAmount >= 0) {
    debit = roundedAmount;
  } else {
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
    .replace(/[,$]/g, "")
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

function normalizeMappingPart(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return roundMoney(value).toFixed(2);
}

function normalizeSupportedReportType(value: unknown): SupportedMonetaryReportType | null {
  return SUPPORTED_MONETARY_REPORT_TYPES.includes(value as SupportedMonetaryReportType)
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

function inferTransactionPolarity(
  transactionType: string,
  transactionDescription: string,
  chargeType: string
): PostingPolarity {
  const text = [transactionType, transactionDescription, chargeType].join(" ").toLowerCase();
  if (/(payment|refund|reversal|deposit|credit card|cash|check|advance)/.test(text)) {
    return "debit_positive";
  }
  return "credit_positive";
}

function inferTrialBalancePolarity(accountType: string): PostingPolarity {
  const normalized = accountType.toLowerCase();
  if (/(asset|expense|receivable)/.test(normalized)) {
    return "debit_positive";
  }
  return "credit_positive";
}

function inferSectionPolarity(section: string, fallback: PostingPolarity): PostingPolarity {
  const normalized = section.toLowerCase();
  if (/(expense|paid out|refund|receivable|balance)/.test(normalized)) {
    return "debit_positive";
  }
  if (/(revenue|tax|sales|deposit)/.test(normalized)) {
    return "credit_positive";
  }
  return fallback;
}

function compareDiscoveredItems(left: DiscoveredMonetaryItem, right: DiscoveredMonetaryItem): number {
  return [
    left.groupLabel.localeCompare(right.groupLabel, undefined, { numeric: true, sensitivity: "base" }),
    left.itemLabel.localeCompare(right.itemLabel, undefined, { numeric: true, sensitivity: "base" }),
    left.amountFieldLabel.localeCompare(right.amountFieldLabel, undefined, { numeric: true, sensitivity: "base" }),
    left.mappingKey.localeCompare(right.mappingKey, undefined, { numeric: true, sensitivity: "base" })
  ].find((value) => value !== 0) ?? 0;
}

export { SUPPORTED_MONETARY_REPORT_TYPES };
