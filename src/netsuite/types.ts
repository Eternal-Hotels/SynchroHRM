export const NETSUITE_JWT_ALGORITHMS = [
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512"
] as const;

export type NetSuiteJwtAlgorithm = (typeof NETSUITE_JWT_ALGORITHMS)[number];

export interface NetSuiteConnectionSettings {
  serviceBaseUrl: string;
  clientId: string;
  certificateId: string;
  jwtAlgorithm: NetSuiteJwtAlgorithm;
  probeQuery: string;
}

export interface NetSuiteConnectionUpdateInput extends NetSuiteConnectionSettings {
  privateKeyPem?: string | null;
  clearPrivateKey?: boolean;
}

export interface NetSuiteConnectionTestResult {
  status: "success" | "error";
  checkedAt: string;
  durationMs: number;
  httpStatus: number | null;
  count: number | null;
  totalResults: number | null;
  columnNames: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

export interface NetSuiteCatalogExportResult {
  status: "success" | "error";
  checkedAt: string;
  durationMs: number;
  httpStatus: number | null;
  rowCount: number | null;
  schemaFileCount: number | null;
  fileName: string | null;
  latestPath: string | null;
  schemaDirectory: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface NetSuiteJournalEntryResponse {
  id: string;
  tranId: string;
  location: string;
}

export interface NetSuiteJournalEntryResult {
  httpStatus: number;
  journalEntry: NetSuiteJournalEntryResponse;
  raw: Record<string, unknown> | null;
}

export interface NetSuiteConnectionView extends NetSuiteConnectionSettings {
  hasPrivateKey: boolean;
  maskedClientId: string | null;
  maskedCertificateId: string | null;
  lastTest: NetSuiteConnectionTestResult | null;
  lastCatalogExport: NetSuiteCatalogExportResult | null;
  masterKeyConfigured: boolean;
  availabilityError: string | null;
}
