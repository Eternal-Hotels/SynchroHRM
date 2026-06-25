# Holiday Inn Express NetSuite Audit

Snapshot date: 2026-06-25

Scope:
- `storage/parsed/holiday-inn-express-ellensburg/*/*.json`
- `storage/parsed/holiday-inn-express-pendleton/*/*.json`
- current NetSuite grouping behavior as implemented in `src/services/NetSuitePostingService.ts`

Reproduce:
```powershell
node .\node_modules\typescript\bin\tsc -p tsconfig.json --outDir .tmp\hie-audit
node .\.tmp\hie-audit\scripts\audit-holiday-inn-express-netsuite.js
```

## Highest-value collapse candidates

| report_type | Ellensburg | Pendleton | recommended collapse |
| --- | --- | --- | --- |
| `direct_bill_aging_rows` | `21 -> 8` | `56 -> 11` | collapse by `section + aging_bucket` instead of `company_name` and `company_code` |
| `in_house_guest_folio_balance_rows` | `285 -> 33` | `296 -> 28` | collapse detail rows by `section + row_kind + summary_label_or_reservation_status_or_payment_method + amount_field` |
| `closed_folio_balance_rows` | `48 -> 23` | `38 -> 33` | collapse detail rows by `section + row_kind + summary_label_or_reservation_status + amount_field` |
| `tax_report_rows` | `131 -> 19` | `117 -> 21` | prefer `Summary` rows and group by `section + tax_name + amount_field` |
| `trial_balance_report_rows` | `187 -> 37` | `192 -> 38` | if NetSuite only needs `net_change`, collapse to `account_name + net_change` |

## Parser and data-shape blockers

`all_transaction_rows`
- The report family already has a custom NetSuite collapse path, but the latest saved parses still have `309` Ellensburg rows and `307` Pendleton rows where `amount` is not numeric.
- Sample shifted rows show merchant or description text landing in `amount`, for example `AMEX`, `MASTER`, `Pet- Policy`, `State Tax`, and `Tourism`.
- Collapse tuning is secondary here. Parser alignment needs to be fixed first or the NetSuite workspace will keep hiding half the report behind the fallback `All Transactions` bucket.

`final_audit_metric_rows`
- The latest files still include `3` visible-title metadata rows per property.
- Current NetSuite discovery explodes into `764` Ellensburg mappings and `796` Pendleton mappings because each metric row carries unnamed `value_1` through `value_10` fields.
- Some Ellensburg `metric_name` values still contain wrapped charge listings and embedded amounts, so this family needs report-aware header naming and wrapped-row cleanup before any useful NetSuite grouping pass.

`hotel_statistics_metric_rows`
- The Pendleton sample is cleaner than Final Audit, but it still becomes `548` mappings because each metric uses unnamed `value_1` through `value_5`.
- This family is a better candidate for a later whitelist once those value columns are labeled.

`direct_bill_aging_rows` and `tax_report_rows`
- Both families still leak title metadata such as `Date:`, `Report run time:`, and `User:` into parsed rows.
- Those rows should be dropped before NetSuite discovery so they do not generate junk categories.

## Practical next order

1. Fix `all_transaction_rows` parser alignment so numeric `amount` stays numeric and `transaction_description` does not drift into the wrong column.
2. Collapse `direct_bill_aging_rows`, `closed_folio_balance_rows`, `in_house_guest_folio_balance_rows`, and `tax_report_rows` with report-specific NetSuite grouping instead of the generic identity builder.
3. Keep `trial_balance_report_rows` only if NetSuite truly needs account-level balances, and narrow it to `net_change` first.
4. Treat `final_audit_metric_rows` and `hotel_statistics_metric_rows` as parser/header work before NetSuite mapping work.
