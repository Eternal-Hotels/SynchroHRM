import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AuthService } from "../src/auth/AuthService.js";
import { AppDatabase } from "../src/db/Database.js";
import { createApp } from "../src/http/createApp.js";
import { PdfReportParser, UnsupportedReportError } from "../src/parsers/pdfReportParser.js";
import { extractPdfText } from "../src/pdf/PdfTextExtractor.js";
import { ExampleDataAttachmentSource } from "../src/sources/ExampleDataAttachmentSource.js";
import { GraphAttachmentSource } from "../src/sources/GraphAttachmentSource.js";
import expectations from "../tests/fixtures/parser-expectations.json" with { type: "json" };
import { IngestionService } from "../src/services/IngestionService.js";
import { buildLatestExportDownloadName, buildParsedCsvDownloadName } from "../src/utils/downloads.js";
import { derivePropertyRefFromAttachmentName } from "../src/utils/properties.js";
const parser = new PdfReportParser();
await run("sample PDFs parse into expected report types and row counts", async () => {
    for (const [fileName, expected] of Object.entries(expectations)) {
        const bytes = await readFile(path.resolve("ExampleData", fileName));
        const parsed = await parser.parse(bytes);
        assert.equal(parsed.reportType, expected.reportType, `${fileName} reportType`);
        assert.equal(parsed.rows.length, expected.rowCount, `${fileName} rowCount`);
        assert.deepEqual(parsed.rows[0], { ...parsed.rows[0], ...expected.firstRow }, `${fileName} first row partial match`);
    }
});
await run("reservation continuation lines are folded into notes", async () => {
    const bytes = await readFile(path.resolve("ExampleData", "Reservations Made Yesterday.PDF"));
    const parsed = await parser.parse(bytes);
    const target = parsed.rows.find((row) => row.guest_name === "bilardello,david");
    assert.ok(target);
    assert.match(String(target.company_group_note), /Sonesta Travel Pass/i);
    assert.match(String(target.company_group_note), /Member Rate/i);
});
await run("unsupported valid PDFs are rejected explicitly", async () => {
    const bytes = createMinimalPdf("Unknown Report");
    await assert.rejects(() => parser.parse(bytes), UnsupportedReportError);
});
await run("office 365 MFA PDFs remain unsupported because they are not property reports", async () => {
    const fixturePath = path.resolve("storage", "raw", "office-365-multi-factor-authentication", "2025-08-25", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAAAALuZAAA__Office_365_Multi_Factor_Authentication.pdf");
    if (!(await pathExists(fixturePath))) {
        return;
    }
    const analysis = await parser.analyze(await readFile(fixturePath));
    assert.equal(analysis.reportTitle, "Regarding the Enablement of Office 365 2 Factor Authentication");
    assert.equal(analysis.propertyName, null);
    assert.equal(analysis.propertySlug, null);
    assert.equal(analysis.reportDate, null);
    assert.equal(analysis.parsedReport, null);
    assert.ok(analysis.error instanceof UnsupportedReportError);
});
await run("corrupted PDFs fail parsing", async () => {
    await assert.rejects(() => parser.parse(Buffer.from("not-a-pdf")));
});
await run("pdf extraction does not emit standard font warnings for sample reports", async () => {
    const bytes = await readFile(path.resolve("ExampleData", "History and Forecast June.PDF"));
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const warnings = [];
    const captureWarning = (...args) => {
        const line = args.map((value) => String(value)).join(" ");
        if (line.startsWith("Warning:")) {
            warnings.push(line);
        }
    };
    console.log = (...args) => {
        captureWarning(...args);
    };
    console.warn = (...args) => {
        captureWarning(...args);
    };
    try {
        const document = await extractPdfText(bytes);
        assert.ok(document.lines.length > 0);
    }
    finally {
        console.log = originalConsoleLog;
        console.warn = originalConsoleWarn;
    }
    assert.deepEqual(warnings, []);
});
await run("graph source resets stale delta tokens and filters supported attachments", async () => {
    const requests = [];
    const responses = [
        mockResponse(200, { access_token: "token-1", expires_in: 3600 }),
        mockResponse(410, { error: { message: "Sync state expired" } }),
        mockResponse(200, {
            value: [
                {
                    id: "message-1",
                    subject: "Daily reports",
                    internetMessageId: "<message-1@test>",
                    receivedDateTime: "2026-05-19T12:00:00Z",
                    hasAttachments: true
                }
            ],
            "@odata.deltaLink": "delta-2"
        }),
        mockResponse(200, {
            value: [
                {
                    id: "attachment-pdf",
                    name: "sales.pdf",
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    contentType: "application/pdf",
                    contentBytes: Buffer.from("pdf-bytes").toString("base64")
                },
                {
                    id: "attachment-inline",
                    name: "inline.png",
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    isInline: true,
                    contentType: "image/png",
                    contentBytes: Buffer.from("png").toString("base64")
                },
                {
                    id: "attachment-text",
                    name: "notes.txt",
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    contentType: "text/plain",
                    contentBytes: Buffer.from("notes").toString("base64")
                }
            ]
        })
    ];
    const fetchImpl = async (input) => {
        requests.push(String(input));
        const next = responses.shift();
        assert.ok(next, `Unexpected request: ${String(input)}`);
        return next;
    };
    const source = new GraphAttachmentSource(mockConfig(), fetchImpl);
    const result = await source.pullAttachments("stale-delta");
    assert.equal(result.deltaWasReset, true);
    assert.equal(result.nextDeltaToken, "delta-2");
    assert.equal(result.messagesSeen, 1);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].attachmentName, "sales.pdf");
    assert.equal(requests.filter((url) => url.includes("/oauth2/v2.0/token")).length, 1);
});
await run("manual sync ignores the saved delta token and performs a full inbox rescan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-manual-rescan-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    try {
        database.setState("graph.delta.inbox", "existing-delta-token");
        const pdfBytes = await readFile(path.resolve("ExampleData", "History and Forecast June.PDF"));
        const seenDeltaTokens = [];
        const source = {
            async pullAttachments(deltaToken) {
                seenDeltaTokens.push(deltaToken);
                return {
                    attachments: [
                        {
                            sourceMailbox: "auditor@eternalhotels.com",
                            message: {
                                graphMessageId: "manual-backfill-message-1",
                                internetMessageId: "<manual-backfill-message-1@test>",
                                subject: "Backfill message",
                                senderEmail: "auditor@eternalhotels.com",
                                receivedAt: "2026-05-26T15:15:00Z",
                                webLink: null
                            },
                            attachmentId: "manual-backfill-attachment-1",
                            attachmentName: "History and Forecast June.PDF",
                            contentType: "application/pdf",
                            bytes: pdfBytes
                        }
                    ],
                    nextDeltaToken: "delta-after-manual-rescan",
                    deltaWasReset: false,
                    messagesSeen: 1
                };
            }
        };
        const service = new IngestionService(database, source, dataDir);
        const result = await service.run("manual");
        assert.deepEqual(seenDeltaTokens, [null]);
        assert.equal(result.summary.messagesSeen, 1);
        assert.equal(result.summary.attachmentsSeen, 1);
        assert.equal(result.summary.attachmentsParsed, 1);
        assert.ok(result.summary.notes.some((note) => note.includes("ignored the saved Microsoft Graph delta token")));
        assert.equal(database.getState("graph.delta.inbox"), "delta-after-manual-rescan");
    }
    finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
await run("hampton la grande report bundle parses into supported families", async () => {
    const fixtureDir = path.resolve("storage", "raw", "hampton-inn-and-suites-by-hilton-la-grande-or", "2026-05-19");
    if (!(await pathExists(fixtureDir))) {
        return;
    }
    const files = await readdir(fixtureDir);
    const expectedFamilies = [
        ["advance-deposit-activity", "advance_deposit_activity_rows"],
        ["booked-reservations", "booked_reservations_rows"],
        ["direct-bill-aging", "direct_bill_aging_rows"],
        ["direct-bill-ledger", "direct_bill_ledger_rows"],
        ["final-audit", "final_audit_metric_rows"],
        ["high-balance-reports", "high_balance_report_rows"],
        ["hotel-statistics", "hotel_statistics_metric_rows"],
        ["maintenance-summary", "maintenance_summary_rows"],
        ["occupancy", "occupancy_forecast_rows"],
        ["rate-override", "rate_override_rows"],
        ["tax-report", "tax_report_rows"]
    ];
    for (const [needle, reportType] of expectedFamilies) {
        const fileName = files.find((name) => name.includes(needle));
        assert.ok(fileName, `fixture present for ${needle}`);
        const parsed = await parser.parse(await readFile(path.join(fixtureDir, fileName)));
        assert.equal(parsed.reportType, reportType, `${needle} reportType`);
        assert.equal(parsed.propertySlug, "hampton-inn-and-suites-by-hilton-la-grande-or", `${needle} propertySlug`);
        assert.ok(parsed.rows.length > 0, `${needle} has parsed rows`);
    }
});
await run("holiday inn pendleton standalone operational reports parse as supported", async () => {
    const fixtureDir = path.resolve("storage", "raw", "unassigned-property", "2026-05-20");
    if (!(await pathExists(fixtureDir))) {
        return;
    }
    const files = await readdir(fixtureDir);
    const operationalReportSuffixes = [
        "authorized-payments.pdf",
        "breakfast-and-packages.pdf",
        "departures-list.pdf",
        "house-account-balances.pdf",
        "maintenance-activity.pdf",
        "no-show.pdf",
        "room-count-summary.pdf"
    ];
    for (const suffix of operationalReportSuffixes) {
        const fileName = files.find((name) => name.includes("Holiday_Inn_ExpressPendleton") && name.endsWith(suffix));
        assert.ok(fileName, `fixture present for ${suffix}`);
        const parsed = await parser.parse(await readFile(path.join(fixtureDir, fileName)));
        assert.equal(parsed.reportType, "all_night_audit_report_rows", `${suffix} reportType`);
    }
});
await run("previously unsupported holiday and ellensburg report families now parse into dedicated exports", async () => {
    const fixtures = [
        {
            path: path.resolve("storage", "raw", "holiday-inn-express-pendleton-adjustment-activity", "2026-05-26", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC4yLZnAAA__May_26_2026-PDTOR-Holiday_Inn_ExpressPendleton-adjustment-activity.pdf"),
            reportType: "adjustment_refund_activity_rows",
            reportDate: "2026-05-25",
            minRows: 8,
            probe: (rows) => {
                assert.deepEqual(rows[0], {
                    ...rows[0],
                    section: "Adjustments",
                    transaction_scope: "Reservation",
                    charge_type: "Pet- Policy",
                    subject_name: "PETERMAN WENDY",
                    transferred_charge: "35.00"
                });
            }
        },
        {
            path: path.resolve("storage", "raw", "holiday-inn-express-pendleton", "2026-05-26", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC4yLZnAAA__May_26_2026-PDTOR-Holiday_Inn_ExpressPendleton-all-transactions.pdf"),
            reportType: "all_transaction_rows",
            reportDate: "2026-05-25",
            minRows: 300,
            probe: (rows) => {
                assert.deepEqual(rows[0], {
                    ...rows[0],
                    section: "Reservations",
                    confirmation_no: "21234203",
                    guest_name: "KHAMPHIL AVONG PAT",
                    transaction_code: "FPCC",
                    amount: "-172.63"
                });
            }
        },
        {
            path: path.resolve("storage", "raw", "holiday-inn-express-pendleton-closed-folios-balance", "2026-05-26", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC4yLZnAAA__May_26_2026-PDTOR-Holiday_Inn_ExpressPendleton-closed-folios-balance.pdf"),
            reportType: "closed_folio_balance_rows",
            reportDate: "2026-05-25",
            minRows: 10,
            probe: (rows) => {
                assert.deepEqual(rows[0], {
                    ...rows[0],
                    guest_name: "PETERSON KENDAL",
                    reservation_status: "CHECKED_OUT",
                    opening_balance: "283.58",
                    ending_balance: "283.58"
                });
            }
        },
        {
            path: path.resolve("storage", "raw", "holiday-inn-express-pendleton-in-house-guest-folio-balances", "2026-05-26", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC4yLZnAAA__May_26_2026-PDTOR-Holiday_Inn_ExpressPendleton-in-house-guest-folio-balances.pdf"),
            reportType: "in_house_guest_folio_balance_rows",
            reportDate: "2026-05-25",
            minRows: 50,
            probe: (rows) => {
                assert.deepEqual(rows[0], {
                    ...rows[0],
                    room_number: "206",
                    guest_name: "STEFANSKI DUSTIN",
                    payment_method: "CREDIT CARD",
                    opening_balance: "3708.38"
                });
            }
        },
        {
            path: path.resolve("storage", "raw", "holiday-inn-express-pendleton-trial-balance-report", "2026-05-26", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC4yLZnAAA__May_26_2026-PDTOR-Holiday_Inn_ExpressPendleton-trial-balance-report.pdf"),
            reportType: "trial_balance_report_rows",
            reportDate: "2026-05-25",
            minRows: 40,
            probe: (rows) => {
                assert.deepEqual(rows[0], {
                    ...rows[0],
                    account_type: "ASSET",
                    account_name: "Loyalty Reward Manual Adjustment",
                    transaction_code: "9282",
                    closing_balance: "0.00"
                });
            }
        },
        {
            path: path.resolve("storage", "raw", "holiday-inn-express-ellensburg-rate-report", "2026-05-20", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC0FPF1AAA__May_19_2026-ELNWA-Holiday_Inn_ExpressEllensburg-rate-report.pdf"),
            reportType: "rate_report_rows",
            reportDate: "2026-05-19",
            minRows: 18,
            probe: (rows) => {
                assert.deepEqual(rows[0], {
                    ...rows[0],
                    room_number: "122",
                    guest_name: "VILKOTS KI ANTON",
                    reservation_status: "IN HOUSE",
                    room_rate: "132.05"
                });
            }
        },
        {
            path: path.resolve("storage", "raw", "holiday-inn-express-ellensburg-reservations", "2026-05-20", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC0FPF1AAA__May_19_2026-ELNWA-Holiday_Inn_ExpressEllensburg-reservations.pdf"),
            reportType: "reservation_listing_rows",
            reportDate: "2026-05-18",
            minRows: 150,
            probe: (rows) => {
                const noShowRow = rows.find((row) => row.section === "No Show");
                assert.deepEqual(rows[0], {
                    ...rows[0],
                    section: "Reservations",
                    market_segment_code: "P",
                    confirmation_no: "81102975",
                    group_code: "IZLZOX"
                });
                assert.ok(noShowRow);
            }
        }
    ];
    for (const fixture of fixtures) {
        if (!(await pathExists(fixture.path))) {
            return;
        }
        const parsed = await parser.parse(await readFile(fixture.path));
        assert.equal(parsed.reportType, fixture.reportType);
        assert.equal(parsed.reportDate, fixture.reportDate);
        assert.ok(parsed.rows.length >= fixture.minRows, `${fixture.reportType} row count`);
        fixture.probe(parsed.rows);
    }
});
await run("attachment-name fallback strips Ellensburg report suffixes before slugging", async () => {
    assert.deepEqual(derivePropertyRefFromAttachmentName("May 19, 2026-ELNWA-Holiday Inn ExpressEllensburg-occupancy.pdf"), {
        propertyName: "Holiday Inn Express Ellensburg",
        propertySlug: "holiday-inn-express-ellensburg"
    });
    assert.deepEqual(derivePropertyRefFromAttachmentName("May 19, 2026-ELNWA-Holiday Inn ExpressEllensburg-rate-report.pdf"), {
        propertyName: "Holiday Inn Express Ellensburg",
        propertySlug: "holiday-inn-express-ellensburg"
    });
    assert.deepEqual(derivePropertyRefFromAttachmentName("May 19, 2026-ELNWA-Holiday Inn ExpressEllensburg-reservations.pdf"), {
        propertyName: "Holiday Inn Express Ellensburg",
        propertySlug: "holiday-inn-express-ellensburg"
    });
    assert.deepEqual(derivePropertyRefFromAttachmentName("May 26, 2026-PDTOR-Holiday Inn ExpressPendleton-adjustment-activity.pdf"), {
        propertyName: "Holiday Inn Express Pendleton",
        propertySlug: "holiday-inn-express-pendleton"
    });
    assert.deepEqual(derivePropertyRefFromAttachmentName("May 26, 2026-PDTOR-Holiday Inn ExpressPendleton-closed-folios-balance.pdf"), {
        propertyName: "Holiday Inn Express Pendleton",
        propertySlug: "holiday-inn-express-pendleton"
    });
    assert.deepEqual(derivePropertyRefFromAttachmentName("May 26, 2026-PDTOR-Holiday Inn ExpressPendleton-in-house-guest-folio-balances.pdf"), {
        propertyName: "Holiday Inn Express Pendleton",
        propertySlug: "holiday-inn-express-pendleton"
    });
    assert.deepEqual(derivePropertyRefFromAttachmentName("May 26, 2026-PDTOR-Holiday Inn ExpressPendleton-trial-balance-report.pdf"), {
        propertyName: "Holiday Inn Express Pendleton",
        propertySlug: "holiday-inn-express-pendleton"
    });
});
await run("best western daily report parses into franchise-specific rows", async () => {
    const fixturePath = path.resolve("storage", "raw", "bw-plus-dayton-hotel-and-suites-06-01-2025-02-21-lupe-accounting", "2026-05-20", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC0FPFxAAA__DailyReport.pdf");
    if (!(await pathExists(fixturePath))) {
        return;
    }
    const parsed = await parser.parse(await readFile(fixturePath));
    assert.equal(parsed.reportType, "best_western_daily_report_rows");
    assert.equal(parsed.propertySlug, "bw-plus-dayton-hotel-and-suites");
    assert.equal(parsed.reportDate, "2025-05-31");
    assert.ok(parsed.rows.length > 40);
    const recapRow = parsed.rows.find((row) => row.section === "Statistical Recap" && row.metric_name === "Occupied");
    assert.ok(recapRow);
    assert.equal(recapRow.today_value, "23");
    const detailRow = parsed.rows.find((row) => row.posting_code === "MC");
    assert.ok(detailRow);
    assert.equal(detailRow.group_name, "GL CREDIT CARDS REV");
    assert.equal(detailRow.posting_description, "PAYMENT MASTERCARD");
});
await run("comfort kennewick daily packet parses into structured audit bundle rows", async () => {
    const fixturePath = path.resolve("storage", "raw", "comfort-inn-wa701", "2026-05-26", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC4yLZkAAA__All_Night_Audit_Reports_WA701_COMFORT_KENNEWICK_DAILY_PDF_FOR_NETSUITE_2026-05-25.pdf");
    if (!(await pathExists(fixturePath))) {
        return;
    }
    const parsed = await parser.parse(await readFile(fixturePath));
    assert.equal(parsed.reportType, "choice_audit_packet_rows");
    assert.equal(parsed.reportTitle, "Daily Audit Packet");
    assert.equal(parsed.propertySlug, "comfort-inn-wa701");
    assert.equal(parsed.reportDate, "2026-05-25");
    assert.ok(parsed.rows.length > 600);
    assert.deepEqual(parsed.rows[0], {
        ...parsed.rows[0],
        page_number: "1",
        report_name: "A/R Aging",
        row_kind: "detail"
    });
    const taxExemptSection = parsed.rows.find((row) => row.report_name === "Tax Exempt Report" && row.section === "Tax Exempt Revenue Summary - By Tax:");
    assert.ok(taxExemptSection);
});
await run("sleep inn pasco daily packet also parses into structured audit bundle rows", async () => {
    const fixturePath = path.resolve("storage", "raw", "sleep-inn-wa102", "2026-05-26", "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC4yLZeAAA__All_Night_Audit_Reports_WA102_SLEEP_INN_PASCO_DAILY_REPORTS_PDF_FOR_NETSUITE_2026-05-25.pdf");
    if (!(await pathExists(fixturePath))) {
        return;
    }
    const parsed = await parser.parse(await readFile(fixturePath));
    assert.equal(parsed.reportType, "choice_audit_packet_rows");
    assert.equal(parsed.reportTitle, "Daily Audit Packet");
    assert.equal(parsed.propertySlug, "sleep-inn-wa102");
    assert.equal(parsed.reportDate, "2026-05-25");
    assert.ok(parsed.rows.length > 500);
    assert.deepEqual(parsed.rows[0], {
        ...parsed.rows[0],
        page_number: "1",
        report_name: "A/R Aging",
        row_kind: "detail"
    });
    const lastRow = parsed.rows.at(-1);
    assert.deepEqual(lastRow, {
        ...lastRow,
        page_number: "24",
        report_name: "Tax Exempt Report",
        section: "Tax Exempt Revenue Summary - By Tax:"
    });
});
await run("download filename helpers include property slugs and visible dates", async () => {
    assert.equal(buildParsedCsvDownloadName({
        propertySlug: "eternal-pasco-test-hotel",
        reportDate: "2026-05-19",
        attachmentName: "History and Forecast June.PDF"
    }), "eternal-pasco-test-hotel_2026-05-19_History_and_Forecast_June.csv");
    assert.equal(buildParsedCsvDownloadName({
        propertySlug: null,
        reportDate: null,
        receivedAt: "2026-05-20T13:45:00Z",
        attachmentName: "Daily Report.pdf"
    }), "unassigned-property_2026-05-20_Daily_Report.csv");
    assert.equal(buildLatestExportDownloadName({
        propertySlug: "eternal-pasco-test-hotel",
        reportType: "history_forecast_rows",
        createdAt: "2026-05-20T14:15:16Z"
    }), "eternal-pasco-test-hotel_history-forecast-rows_2026-05-20_14-15-16.csv");
});
await run("auth login flow requires authorization confirmation and splits admin and viewer routes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-auth-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    const authService = new AuthService(database);
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
    const app = createApp(mockConfig(), database, service, authService);
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        const unauthenticatedRoot = await fetch(`${baseUrl}/`, { redirect: "manual" });
        assert.equal(unauthenticatedRoot.status, 302);
        assert.equal(unauthenticatedRoot.headers.get("location"), "/login");
        const unauthorizedLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: buildLoginRequestBody("admin", "ehSynchroAdmin2021!", false)
        });
        assert.equal(unauthorizedLogin.status, 400);
        const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: buildLoginRequestBody("admin", "ehSynchroAdmin2021!")
        });
        assert.equal(adminLogin.status, 200);
        const adminCookie = extractCookie(adminLogin.headers.get("set-cookie"));
        assert.ok(adminCookie);
        const adminDashboard = await fetchJsonAbsolute(`${baseUrl}/api/dashboard`, adminCookie);
        assert.equal(adminDashboard.currentUser.username, "admin");
        assert.equal(adminDashboard.currentUser.role, "admin");
        const adminRoot = await fetch(`${baseUrl}/`, {
            headers: {
                cookie: adminCookie
            },
            redirect: "manual"
        });
        assert.equal(adminRoot.status, 302);
        assert.equal(adminRoot.headers.get("location"), "/admin");
        const createViewer = await fetch(`${baseUrl}/api/users`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                cookie: adminCookie
            },
            body: JSON.stringify({
                username: "viewer.ops",
                password: "viewerPass123"
            })
        });
        assert.equal(createViewer.status, 201);
        const viewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: buildLoginRequestBody("viewer.ops", "viewerPass123")
        });
        assert.equal(viewerLogin.status, 200);
        const viewerCookie = extractCookie(viewerLogin.headers.get("set-cookie"));
        assert.ok(viewerCookie);
        const viewerDashboard = await fetchJsonAbsolute(`${baseUrl}/api/dashboard`, viewerCookie);
        assert.equal(viewerDashboard.currentUser.username, "viewer.ops");
        assert.equal(viewerDashboard.currentUser.role, "viewer");
        const viewerSettings = await fetch(`${baseUrl}/api/users`, {
            headers: {
                cookie: viewerCookie
            }
        });
        assert.equal(viewerSettings.status, 403);
        const viewerRun = await fetch(`${baseUrl}/api/ingest/run`, {
            method: "POST",
            headers: {
                cookie: viewerCookie
            }
        });
        assert.equal(viewerRun.status, 403);
        const viewerRoot = await fetch(`${baseUrl}/`, {
            headers: {
                cookie: viewerCookie
            },
            redirect: "manual"
        });
        assert.equal(viewerRoot.status, 302);
        assert.equal(viewerRoot.headers.get("location"), "/viewer");
        const viewerAdmin = await fetch(`${baseUrl}/admin`, {
            headers: {
                cookie: viewerCookie
            },
            redirect: "manual"
        });
        assert.equal(viewerAdmin.status, 302);
        assert.equal(viewerAdmin.headers.get("location"), "/viewer");
        const adminViewer = await fetch(`${baseUrl}/viewer`, {
            headers: {
                cookie: adminCookie
            },
            redirect: "manual"
        });
        assert.equal(adminViewer.status, 302);
        assert.equal(adminViewer.headers.get("location"), "/admin");
        const viewerHome = await fetch(`${baseUrl}/viewer`, {
            headers: {
                cookie: viewerCookie
            }
        });
        assert.equal(viewerHome.status, 200);
        assert.match(await viewerHome.text(), /Synchro HRM Viewer/);
        const loginRedirect = await fetch(`${baseUrl}/login`, {
            headers: {
                cookie: viewerCookie
            },
            redirect: "manual"
        });
        assert.equal(loginRedirect.status, 302);
        assert.equal(loginRedirect.headers.get("location"), "/viewer");
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
await run("legacy admin default is upgraded to the new seeded password", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-admin-migrate-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    try {
        database.createUser("admin", buildPasswordHash("ehSynchroAdmin"), "admin");
        const authService = new AuthService(database);
        assert.equal(authService.getSessionUser(null), null);
        assert.throws(() => authService.login("admin", "ehSynchroAdmin"), /Invalid username or password/i);
        const login = authService.login("admin", "ehSynchroAdmin2021!");
        assert.equal(login.user.username, "admin");
        assert.equal(login.user.role, "admin");
    }
    finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
await run("admins can change user passwords from the settings API", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-passwords-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    const authService = new AuthService(database);
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
    const app = createApp(mockConfig(), database, service, authService);
    const server = await listen(app);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                authorizedUserConfirmed: true,
                username: "admin",
                password: "ehSynchroAdmin2021!"
            })
        });
        assert.equal(adminLogin.status, 200);
        const adminCookie = extractCookie(adminLogin.headers.get("set-cookie"));
        assert.ok(adminCookie);
        const createViewer = await fetch(`${baseUrl}/api/users`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                cookie: adminCookie
            },
            body: JSON.stringify({
                authorizedUserConfirmed: true,
                username: "viewer.ops",
                password: "viewerPass123"
            })
        });
        assert.equal(createViewer.status, 201);
        const usersPayload = await fetchJsonAbsolute(`${baseUrl}/api/users`, adminCookie);
        const viewerUser = Array.isArray(usersPayload.users)
            ? usersPayload.users.find((user) => user.username === "viewer.ops") ?? null
            : null;
        const adminUser = Array.isArray(usersPayload.users)
            ? usersPayload.users.find((user) => user.username === "admin") ?? null
            : null;
        assert.ok(viewerUser);
        assert.ok(adminUser);
        const viewerPasswordUpdate = await fetch(`${baseUrl}/api/users/${encodeURIComponent(String(viewerUser.id))}/password`, {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                cookie: adminCookie
            },
            body: JSON.stringify({
                password: "viewerPass456!"
            })
        });
        assert.equal(viewerPasswordUpdate.status, 200);
        const oldViewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                authorizedUserConfirmed: true,
                username: "viewer.ops",
                password: "viewerPass123"
            })
        });
        assert.equal(oldViewerLogin.status, 401);
        const newViewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                authorizedUserConfirmed: true,
                username: "viewer.ops",
                password: "viewerPass456!"
            })
        });
        assert.equal(newViewerLogin.status, 200);
        const adminPasswordUpdate = await fetch(`${baseUrl}/api/users/${encodeURIComponent(String(adminUser.id))}/password`, {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                cookie: adminCookie
            },
            body: JSON.stringify({
                password: "AdminRotate2026!"
            })
        });
        assert.equal(adminPasswordUpdate.status, 200);
        const oldAdminLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                authorizedUserConfirmed: true,
                username: "admin",
                password: "ehSynchroAdmin2021!"
            })
        });
        assert.equal(oldAdminLogin.status, 401);
        const newAdminLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify({
                authorizedUserConfirmed: true,
                username: "admin",
                password: "AdminRotate2026!"
            })
        });
        assert.equal(newAdminLogin.status, 200);
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
await run("downloaded csv responses use property-aware filenames", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-downloads-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    try {
        const source = new ExampleDataAttachmentSource(path.resolve("ExampleData"));
        const service = new IngestionService(database, source, dataDir);
        const runResult = await service.run("test");
        const authService = new AuthService(database);
        const app = createApp(mockConfig(), database, service, authService);
        const server = await listen(app);
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        try {
            const login = await fetch(`${baseUrl}/api/auth/login`, {
                method: "POST",
                headers: {
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    authorizedUserConfirmed: true,
                    username: "admin",
                    password: "ehSynchroAdmin2021!"
                })
            });
            assert.equal(login.status, 200);
            const adminCookie = extractCookie(login.headers.get("set-cookie"));
            assert.ok(adminCookie);
            const propertySlug = "red-lion-hotel-pasco-airport-and-conference-center";
            const propertyAttachments = database.getPropertyAttachments(propertySlug);
            const parsedAttachment = propertyAttachments.find((attachment) => attachment.status === "parsed" && attachment.report_type === "history_forecast_rows");
            assert.ok(parsedAttachment);
            const parsedCsvResponse = await fetch(`${baseUrl}/api/attachments/${encodeURIComponent(String(parsedAttachment.id))}/parsed-csv`, {
                headers: {
                    cookie: adminCookie
                }
            });
            assert.equal(parsedCsvResponse.status, 200);
            assert.equal(parsedCsvResponse.headers.get("content-disposition"), `attachment; filename="${buildParsedCsvDownloadName({
                propertySlug: typeof parsedAttachment.property_slug === "string" ? parsedAttachment.property_slug : null,
                reportDate: typeof parsedAttachment.report_date === "string" ? parsedAttachment.report_date : null,
                receivedAt: typeof parsedAttachment.received_at === "string" ? parsedAttachment.received_at : null,
                attachmentName: typeof parsedAttachment.attachment_name === "string" ? parsedAttachment.attachment_name : null,
                reportType: typeof parsedAttachment.report_type === "string" ? parsedAttachment.report_type : null
            })}"`);
            const latestExport = service.getLatestExport("history_forecast_rows", propertySlug);
            assert.ok(latestExport);
            const latestDownloadResponse = await fetch(`${baseUrl}/api/properties/${encodeURIComponent(propertySlug)}/exports/history_forecast_rows/latest?download=1`, {
                headers: {
                    cookie: adminCookie
                }
            });
            assert.equal(latestDownloadResponse.status, 200);
            assert.equal(latestDownloadResponse.headers.get("content-disposition"), `attachment; filename="${buildLatestExportDownloadName({
                propertySlug,
                reportType: "history_forecast_rows",
                createdAt: typeof latestExport.created_at === "string" ? latestExport.created_at : null
            })}"`);
        }
        finally {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    }
    finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
await run("example data ingests end to end into sqlite and csv exports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-e2e-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    try {
        const source = new ExampleDataAttachmentSource(path.resolve("ExampleData"));
        const service = new IngestionService(database, source, dataDir);
        const firstRun = await service.run("test");
        assert.equal(firstRun.status, "completed");
        assert.equal(firstRun.summary.attachmentsSeen, 12);
        assert.equal(firstRun.summary.attachmentsArchived, 12);
        assert.equal(firstRun.summary.attachmentsParsed, 11);
        assert.equal(firstRun.summary.attachmentsDeferred, 1);
        assert.equal(firstRun.summary.attachmentsFailed, 0);
        const historyExport = firstRun.exports.find((entry) => (entry.reportType === "history_forecast_rows"
            && entry.propertySlug === "red-lion-hotel-pasco-airport-and-conference-center"));
        assert.ok(historyExport);
        assert.equal(historyExport.rowCount, 61);
        const latestCsv = await readFile(historyExport.latestPath, "utf8");
        assert.match(latestCsv, /business_date,section,day_of_week/);
        const runRecord = database.getRun(firstRun.runId);
        assert.ok(runRecord);
        const attachments = runRecord.attachments;
        assert.equal(attachments.length, 12);
        assert.ok(attachments.some((attachment) => attachment.status === "deferred"));
        const parsedAttachment = attachments.find((attachment) => attachment.status === "parsed" && attachment.report_type === "history_forecast_rows");
        assert.ok(parsedAttachment);
        const attachmentRows = database.getAttachmentExportRows("history_forecast_rows", parsedAttachment.id);
        assert.ok(attachmentRows.length > 0);
        const secondRun = await service.run("test");
        assert.equal(secondRun.status, "completed");
        assert.equal(secondRun.summary.attachmentsSeen, 0);
    }
    finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
await run("unsupported-only quarantine entries do not create tracked properties", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-properties-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    try {
        const runId = database.createRun("test");
        database.upsertMessage({
            graphMessageId: "message-supported",
            internetMessageId: "<message-supported@test>",
            subject: "Supported property",
            senderEmail: "auditor@eternalhotels.com",
            receivedAt: "2026-05-20T12:00:00Z",
            webLink: null
        });
        const supportedId = database.insertAttachment({
            graphMessageId: "message-supported",
            graphAttachmentId: "attachment-supported",
            ingestRunId: runId,
            internetMessageId: "<message-supported@test>",
            sourceMailbox: "auditor@eternalhotels.com",
            receivedAt: "2026-05-20T12:00:00Z",
            attachmentName: "History and Forecast June.PDF",
            propertyName: "Red Lion Hotel Pasco Airport & Conference Center",
            propertySlug: "red-lion-hotel-pasco-airport-and-conference-center",
            extension: ".pdf",
            contentType: "application/pdf",
            archivedPath: path.join(dataDir, "raw", "supported.pdf"),
            status: "archived"
        });
        database.updateAttachment(supportedId, {
            status: "parsed",
            propertyName: "Red Lion Hotel Pasco Airport & Conference Center",
            propertySlug: "red-lion-hotel-pasco-airport-and-conference-center",
            reportType: "history_forecast_rows",
            reportTitle: "History and Forecast",
            reportDate: "2026-05-19"
        });
        database.upsertMessage({
            graphMessageId: "message-unsupported",
            internetMessageId: "<message-unsupported@test>",
            subject: "Unsupported property",
            senderEmail: "auditor@eternalhotels.com",
            receivedAt: "2026-05-20T13:00:00Z",
            webLink: null
        });
        const unsupportedId = database.insertAttachment({
            graphMessageId: "message-unsupported",
            graphAttachmentId: "attachment-unsupported",
            ingestRunId: runId,
            internetMessageId: "<message-unsupported@test>",
            sourceMailbox: "auditor@eternalhotels.com",
            receivedAt: "2026-05-20T13:00:00Z",
            attachmentName: "Unknown Bundle.PDF",
            propertyName: "Ghost Property",
            propertySlug: "ghost-property",
            extension: ".pdf",
            contentType: "application/pdf",
            archivedPath: path.join(dataDir, "raw", "unsupported.pdf"),
            status: "archived"
        });
        database.updateAttachment(unsupportedId, {
            status: "unsupported",
            propertyName: "Ghost Property",
            propertySlug: "ghost-property",
            reportTitle: "Unknown Bundle",
            parseError: "The PDF title does not match any known report family."
        });
        const summaries = database.getPropertySummaries();
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0].property_slug, "red-lion-hotel-pasco-airport-and-conference-center");
        assert.equal(database.getPropertySummary("ghost-property"), null);
    }
    finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
await run("failed pdf attachments can be retried into parsed reports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-retry-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    try {
        const runId = database.createRun("test");
        const fileName = "History and Forecast June.PDF";
        const archiveBytes = await readFile(path.resolve("ExampleData", fileName));
        const archivedPath = path.join(dataDir, "raw", "red-lion-hotel-pasco-airport-and-conference-center", "2026-05-19", "message-1_History_and_Forecast_June.PDF");
        await mkdir(path.dirname(archivedPath), { recursive: true });
        await writeFile(archivedPath, archiveBytes);
        database.upsertMessage({
            graphMessageId: "message-1",
            internetMessageId: "<message-1@test>",
            subject: "Daily report retry",
            senderEmail: "auditor@eternalhotels.com",
            receivedAt: "2026-05-19T12:00:00Z",
            webLink: null
        });
        const attachmentId = database.insertAttachment({
            graphMessageId: "message-1",
            graphAttachmentId: "attachment-1",
            ingestRunId: runId,
            internetMessageId: "<message-1@test>",
            sourceMailbox: "auditor@eternalhotels.com",
            receivedAt: "2026-05-19T12:00:00Z",
            attachmentName: fileName,
            propertyName: "Red Lion Hotel Pasco Airport and Conference Center",
            propertySlug: "red-lion-hotel-pasco-airport-and-conference-center",
            extension: ".pdf",
            contentType: "application/pdf",
            archivedPath,
            status: "archived"
        });
        database.updateAttachment(attachmentId, {
            status: "failed",
            propertyName: "Red Lion Hotel Pasco Airport and Conference Center",
            propertySlug: "red-lion-hotel-pasco-airport-and-conference-center",
            reportTitle: "History and Forecast",
            reportDate: "2026-05-17",
            parseError: "Previous parser failure"
        });
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
        const result = await service.retryAttachmentParse(attachmentId);
        assert.equal(result.succeeded, true);
        const updated = database.getAttachmentById(attachmentId);
        assert.ok(updated);
        assert.equal(updated.status, "parsed");
        assert.equal(updated.report_type, "history_forecast_rows");
        assert.equal(updated.report_title, "History and Forecast");
        assert.equal(updated.report_date, "2026-05-19");
        assert.equal(updated.parse_error, null);
        assert.ok(typeof updated.parsed_json_path === "string");
        const rows = database.getExportRows("history_forecast_rows", {
            propertySlug: "red-lion-hotel-pasco-airport-and-conference-center"
        });
        assert.ok(rows.length > 0);
    }
    finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});
async function run(name, fn) {
    try {
        await fn();
        console.log(`PASS ${name}`);
    }
    catch (error) {
        console.error(`FAIL ${name}`);
        throw error;
    }
}
function createMinimalPdf(title) {
    const stream = `BT\n/F1 24 Tf\n72 72 Td\n(${title}) Tj\nET\n`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ];
    let output = "%PDF-1.4\n";
    const offsets = [0];
    for (let index = 0; index < objects.length; index += 1) {
        offsets.push(Buffer.byteLength(output, "utf8"));
        output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(output, "utf8");
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let index = 1; index < offsets.length; index += 1) {
        output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
    }
    output += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(output, "utf8");
}
function mockConfig() {
    return {
        port: 3000,
        bindHost: "127.0.0.1",
        graphTenantId: "tenant",
        graphClientId: "client",
        graphClientSecret: "secret",
        graphMailboxUser: "auditor@eternalhotels.com",
        graphMailFolder: "Inbox",
        pollCron: "0 * * * *",
        dataDir: "./storage",
        databasePath: "./storage/app.sqlite",
        defaultApprovedSenderPatterns: [],
        secretMasterKey: null
    };
}
function mockResponse(status, payload) {
    const body = JSON.stringify(payload);
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return JSON.parse(body);
        },
        async text() {
            return body;
        }
    };
}
function buildPasswordHash(password) {
    const salt = "0123456789abcdeffedcba9876543210";
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `scrypt:${salt}:${hash}`;
}
function buildLoginRequestBody(username, password, authorizedUserConfirmed = true) {
    return JSON.stringify({
        username,
        password,
        authorizedUserConfirmed
    });
}
async function fetchJsonAbsolute(url, cookie) {
    const response = await fetch(url, {
        headers: cookie ? { cookie } : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
}
function extractCookie(setCookie) {
    return String(setCookie ?? "").split(";")[0] ?? "";
}
function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, () => resolve(server));
    });
}
async function pathExists(target) {
    try {
        await access(target, fsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
