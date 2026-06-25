const state = {
  dashboard: null,
  latestRun: null,
  currentUser: null,
  currentPage: "overview",
  users: [],
  selectedProperty: null,
  selectedHistoryYear: null,
  selectedHistoryMonth: null,
  selectedHistoryDay: null,
  historyTreeInteracted: false,
  retryingAttachmentId: null,
  propertySaving: false,
  propertyFormStatus: "No pending edits.",
  propertyFormTone: "empty",
  viewerSaving: false,
  viewerDeletingUserId: null,
  userPasswordSavingId: null,
  viewerFormStatus: "No account changes yet.",
  viewerFormTone: "empty",
  approvedSenderPatterns: [],
  approvedSenderSource: "default",
  approvedSenderSaving: false,
  approvedSenderStatus: "No sender allowlist changes yet.",
  approvedSenderTone: "empty",
  netsuiteSettings: null,
  netsuiteSaving: false,
  netsuiteTesting: false,
  netsuiteCatalogExporting: false,
  netsuiteStatus: "No NetSuite connector changes yet.",
  netsuiteTone: "empty",
  netsuitePostingProperties: [],
  netsuitePostingWorkspace: null,
  netsuitePostingStatus: "No NetSuite posting actions yet.",
  netsuitePostingTone: "empty",
  netsuitePostingLoading: false,
  netsuitePostingSaving: false,
  netsuitePostingPreviewing: false,
  netsuitePostingSubmitting: false,
  netsuitePostingSelectedRunId: "",
  activeRunId: null,
  runPollTimeoutId: null,
  runPollToken: 0,
  loading: false
};

const heroStatus = document.getElementById("hero-status");
const heroAccount = document.getElementById("hero-account");
const refreshButton = document.getElementById("refresh-button");
const reparseButton = document.getElementById("reparse-button");
const runButton = document.getElementById("run-button");
const logoutButton = document.getElementById("logout-button");
const pageLinks = Array.from(document.querySelectorAll("[data-page-link]"));
const pageViews = Array.from(document.querySelectorAll("[data-page]"));
const overviewStamp = document.getElementById("overview-stamp");
const overviewGrid = document.getElementById("overview-grid");
const propertyList = document.getElementById("property-list");
const latestRunBadge = document.getElementById("latest-run-badge");
const runSummaryGrid = document.getElementById("run-summary-grid");
const runNotes = document.getElementById("run-notes");
const attachmentList = document.getElementById("attachment-list");
const propertyModal = document.getElementById("property-modal");
const propertyModalClose = document.getElementById("property-modal-close");
const propertyModalTitle = document.getElementById("property-modal-title");
const propertyModalSubhead = document.getElementById("property-modal-subhead");
const propertyModalSummary = document.getElementById("property-modal-summary");
const propertyEditForm = document.getElementById("property-edit-form");
const propertyNameInput = document.getElementById("property-name-input");
const propertySlugInput = document.getElementById("property-slug-input");
const propertySaveButton = document.getElementById("property-save-button");
const propertyFormStatus = document.getElementById("property-form-status");
const propertyHistoryCaption = document.getElementById("property-history-caption");
const propertyHistoryBrowser = document.getElementById("property-history-browser");
const propertyHistorySelection = document.getElementById("property-history-selection");
const propertyModalAttachments = document.getElementById("property-modal-attachments");
const viewerUserForm = document.getElementById("viewer-user-form");
const viewerUsernameInput = document.getElementById("viewer-username-input");
const viewerPasswordInput = document.getElementById("viewer-password-input");
const viewerCreateButton = document.getElementById("viewer-create-button");
const viewerFormStatus = document.getElementById("viewer-form-status");
const viewerUserList = document.getElementById("viewer-user-list");
const approvedSendersForm = document.getElementById("approved-senders-form");
const approvedSendersInput = document.getElementById("approved-senders-input");
const approvedSendersSaveButton = document.getElementById("approved-senders-save-button");
const approvedSendersStatus = document.getElementById("approved-senders-status");
const netsuiteSettingsForm = document.getElementById("netsuite-settings-form");
const netsuiteServiceBaseUrlInput = document.getElementById("netsuite-service-base-url-input");
const netsuiteClientIdInput = document.getElementById("netsuite-client-id-input");
const netsuiteCertificateIdInput = document.getElementById("netsuite-certificate-id-input");
const netsuiteJwtAlgorithmInput = document.getElementById("netsuite-jwt-algorithm-input");
const netsuiteProbeQueryInput = document.getElementById("netsuite-probe-query-input");
const netsuitePrivateKeyInput = document.getElementById("netsuite-private-key-input");
const netsuiteSaveButton = document.getElementById("netsuite-save-button");
const netsuiteTestButton = document.getElementById("netsuite-test-button");
const netsuiteClearKeyButton = document.getElementById("netsuite-clear-key-button");
const netsuiteExportCatalogButton = document.getElementById("netsuite-export-catalog-button");
const netsuiteKeyStatus = document.getElementById("netsuite-key-status");
const netsuiteSettingsStatus = document.getElementById("netsuite-settings-status");
const netsuiteLastTest = document.getElementById("netsuite-last-test");
const netsuiteLastCatalogExport = document.getElementById("netsuite-last-catalog-export");
const netsuiteCatalogDownloadLink = document.getElementById("netsuite-catalog-download-link");
const netsuitePropertyStatus = document.getElementById("netsuite-property-status");
const netsuitePropertyList = document.getElementById("netsuite-property-list");
const netsuiteWorkspaceEmpty = document.getElementById("netsuite-workspace-empty");
const netsuiteWorkspace = document.getElementById("netsuite-workspace");
const netsuiteWorkspaceSummary = document.getElementById("netsuite-workspace-summary");
const netsuitePostingForm = document.getElementById("netsuite-posting-form");
const netsuiteReportTypeSelect = document.getElementById("netsuite-report-type-select");
const netsuiteAttachmentSelect = document.getElementById("netsuite-attachment-select");
const netsuitePostingExternalPrefix = document.getElementById("netsuite-posting-external-prefix");
const netsuitePostingBalancingGl = document.getElementById("netsuite-posting-balancing-gl");
const netsuitePostingMemoTemplate = document.getElementById("netsuite-posting-memo-template");
const netsuitePostingSubsidiaryId = document.getElementById("netsuite-posting-subsidiary-id");
const netsuitePostingCurrencyId = document.getElementById("netsuite-posting-currency-id");
const netsuitePostingLocationId = document.getElementById("netsuite-posting-location-id");
const netsuitePostingDepartmentId = document.getElementById("netsuite-posting-department-id");
const netsuitePostingClassId = document.getElementById("netsuite-posting-class-id");
const netsuitePostingRefreshButton = document.getElementById("netsuite-posting-refresh-button");
const netsuitePostingSaveButton = document.getElementById("netsuite-posting-save-button");
const netsuitePostingPreviewButton = document.getElementById("netsuite-posting-preview-button");
const netsuitePostingSubmitButton = document.getElementById("netsuite-posting-submit-button");
const netsuitePostingStatus = document.getElementById("netsuite-posting-status");
const netsuitePostingMappingSummary = document.getElementById("netsuite-posting-mapping-summary");
const netsuitePostingMappings = document.getElementById("netsuite-posting-mappings");
const netsuitePostingPreview = document.getElementById("netsuite-posting-preview");
const netsuitePostingRuns = document.getElementById("netsuite-posting-runs");
const PAGE_IDS = ["overview", "properties", "netsuite", "users", "settings"];
const propertyEditorAvailable = Boolean(
  propertyEditForm &&
  propertyNameInput &&
  propertySlugInput &&
  propertySaveButton &&
  propertyFormStatus
);
const viewerSettingsAvailable = Boolean(
  viewerUserForm &&
  viewerUsernameInput &&
  viewerPasswordInput &&
  viewerCreateButton &&
  viewerFormStatus &&
  viewerUserList
);
const approvedSenderSettingsAvailable = Boolean(
  approvedSendersForm &&
  approvedSendersInput &&
  approvedSendersSaveButton &&
  approvedSendersStatus
);
const netsuiteSettingsAvailable = Boolean(
  netsuiteSettingsForm &&
  netsuiteServiceBaseUrlInput &&
  netsuiteClientIdInput &&
  netsuiteCertificateIdInput &&
  netsuiteJwtAlgorithmInput &&
  netsuiteProbeQueryInput &&
  netsuitePrivateKeyInput &&
  netsuiteSaveButton &&
  netsuiteTestButton &&
  netsuiteClearKeyButton &&
  netsuiteExportCatalogButton &&
  netsuiteKeyStatus &&
  netsuiteSettingsStatus &&
  netsuiteLastTest &&
  netsuiteLastCatalogExport &&
  netsuiteCatalogDownloadLink
);
const netsuitePostingAvailable = Boolean(
  netsuitePropertyStatus &&
  netsuitePropertyList &&
  netsuiteWorkspaceEmpty &&
  netsuiteWorkspace &&
  netsuiteWorkspaceSummary &&
  netsuitePostingForm &&
  netsuiteReportTypeSelect &&
  netsuiteAttachmentSelect &&
  netsuitePostingExternalPrefix &&
  netsuitePostingBalancingGl &&
  netsuitePostingMemoTemplate &&
  netsuitePostingSubsidiaryId &&
  netsuitePostingCurrencyId &&
  netsuitePostingLocationId &&
  netsuitePostingDepartmentId &&
  netsuitePostingClassId &&
  netsuitePostingRefreshButton &&
  netsuitePostingSaveButton &&
  netsuitePostingPreviewButton &&
  netsuitePostingSubmitButton &&
  netsuitePostingStatus &&
  netsuitePostingMappingSummary &&
  netsuitePostingMappings &&
  netsuitePostingPreview &&
  netsuitePostingRuns
);

for (const link of pageLinks) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setCurrentPage(link.getAttribute("data-page-link"), { updateHash: true });
  });
}

if (refreshButton) {
  refreshButton.addEventListener("click", () => {
    void refreshDashboard("Dashboard refreshed.");
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", () => {
    void logout();
  });
}

if (runButton) {
  runButton.addEventListener("click", () => {
    void triggerRun();
  });
}

if (reparseButton) {
  reparseButton.addEventListener("click", () => {
    void triggerReparse();
  });
}

if (propertyList) {
  propertyList.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-property-slug]") : null;
    if (!target) {
      return;
    }

    const propertySlug = target.getAttribute("data-property-slug");
    if (!propertySlug) {
      return;
    }

    void openPropertyModal(propertySlug);
  });
}

if (viewerUserList) {
  viewerUserList.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-delete-user-id]") : null;
    if (!target) {
      return;
    }

    const userId = Number(target.getAttribute("data-delete-user-id"));
    if (Number.isInteger(userId) && userId > 0) {
      void deleteViewerUser(userId);
    }
  });

  viewerUserList.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) {
      return;
    }

    const userId = Number(form.getAttribute("data-password-user-id"));
    const passwordInput = form.querySelector("input[name='password']");
    const password = passwordInput instanceof HTMLInputElement ? passwordInput.value : "";
    event.preventDefault();

    if (Number.isInteger(userId) && userId > 0) {
      void changeUserPassword(userId, password);
    }
  });
}

if (propertyModal) {
  propertyModal.addEventListener("click", (event) => {
    const retryTarget = event.target instanceof Element ? event.target.closest("[data-retry-attachment-id]") : null;
    if (retryTarget) {
      const attachmentId = Number(retryTarget.getAttribute("data-retry-attachment-id"));
      if (Number.isInteger(attachmentId) && attachmentId > 0) {
        void retryAttachmentParse(attachmentId);
      }
      return;
    }

    const historyTarget = event.target instanceof Element ? event.target.closest("[data-history-level][data-history-key]") : null;
    if (historyTarget) {
      updateHistorySelection(
        historyTarget.getAttribute("data-history-level"),
        historyTarget.getAttribute("data-history-key")
      );
      renderPropertyModal();
      return;
    }

    const target = event.target instanceof Element ? event.target.closest("[data-close-modal='1']") : null;
    if (target) {
      closePropertyModal();
    }
  });
}

if (propertyModalClose) {
  propertyModalClose.addEventListener("click", () => {
    closePropertyModal();
  });
}

if (propertyEditForm) {
  propertyEditForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void savePropertyEdits();
  });
}

if (viewerUserForm) {
  viewerUserForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createViewerUser();
  });
}

if (approvedSendersForm) {
  approvedSendersForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveApprovedSenders();
  });
}

if (netsuiteSettingsForm) {
  netsuiteSettingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveNetSuiteSettings(false);
  });
}

if (netsuiteTestButton) {
  netsuiteTestButton.addEventListener("click", () => {
    void testNetSuiteConnection();
  });
}

if (netsuiteClearKeyButton) {
  netsuiteClearKeyButton.addEventListener("click", () => {
    void saveNetSuiteSettings(true);
  });
}

if (netsuiteExportCatalogButton) {
  netsuiteExportCatalogButton.addEventListener("click", () => {
    void exportNetSuiteMetadataCatalog();
  });
}

if (netsuitePropertyList) {
  netsuitePropertyList.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-netsuite-property-slug]") : null;
    if (!target) {
      return;
    }

    const propertySlug = target.getAttribute("data-netsuite-property-slug");
    if (propertySlug) {
      void loadNetSuiteWorkspace(propertySlug);
    }
  });
}

if (netsuiteReportTypeSelect) {
  netsuiteReportTypeSelect.addEventListener("change", () => {
    const propertySlug = state.netsuitePostingWorkspace && state.netsuitePostingWorkspace.property
      ? state.netsuitePostingWorkspace.property.property_slug
      : "";
    const reportType = netsuiteReportTypeSelect.value;
    if (propertySlug && reportType) {
      void loadNetSuiteWorkspace(propertySlug, null, reportType);
    }
  });
}

if (netsuiteAttachmentSelect) {
  netsuiteAttachmentSelect.addEventListener("change", () => {
    const propertySlug = state.netsuitePostingWorkspace && state.netsuitePostingWorkspace.property
      ? state.netsuitePostingWorkspace.property.property_slug
      : "";
    const attachmentId = Number(netsuiteAttachmentSelect.value);
    if (propertySlug && Number.isInteger(attachmentId) && attachmentId > 0) {
      void loadNetSuiteWorkspace(
        propertySlug,
        attachmentId,
        netsuiteReportTypeSelect ? netsuiteReportTypeSelect.value : ""
      );
    }
  });
}

if (netsuitePostingForm) {
  netsuitePostingForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveNetSuitePostingSetup();
  });
}

if (netsuitePostingRefreshButton) {
  netsuitePostingRefreshButton.addEventListener("click", () => {
    const propertySlug = state.netsuitePostingWorkspace && state.netsuitePostingWorkspace.property
      ? state.netsuitePostingWorkspace.property.property_slug
      : "";
    const attachmentId = Number(netsuiteAttachmentSelect && netsuiteAttachmentSelect.value);
    const reportType = netsuiteReportTypeSelect ? netsuiteReportTypeSelect.value : "";
    if (propertySlug) {
      void loadNetSuiteWorkspace(
        propertySlug,
        Number.isInteger(attachmentId) && attachmentId > 0 ? attachmentId : null,
        reportType || null
      );
    }
  });
}

if (netsuitePostingPreviewButton) {
  netsuitePostingPreviewButton.addEventListener("click", () => {
    void buildNetSuitePostingPreview();
  });
}

if (netsuitePostingSubmitButton) {
  netsuitePostingSubmitButton.addEventListener("click", () => {
    void submitNetSuitePostingPreview();
  });
}

if (netsuitePostingRuns) {
  netsuitePostingRuns.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-netsuite-run-id]") : null;
    if (!target) {
      return;
    }

    const runId = target.getAttribute("data-netsuite-run-id");
    if (!runId || !state.netsuitePostingWorkspace || !Array.isArray(state.netsuitePostingWorkspace.runs)) {
      return;
    }

    const selected = state.netsuitePostingWorkspace.runs.find((entry) => entry.id === runId) || null;
    if (selected) {
      state.netsuitePostingSelectedRunId = runId;
      renderNetSuitePosting();
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (propertyModal && event.key === "Escape" && !propertyModal.classList.contains("hidden")) {
    closePropertyModal();
  }
});

window.addEventListener("hashchange", () => {
  syncCurrentPageFromHash();
});

syncCurrentPageFromHash();
void refreshDashboard("Loading dashboard...");

async function triggerRun() {
  setLoading(true, "Starting a full mailbox scan. Older Inbox mail can take a while to process.");

  try {
    const result = await fetchJson("/api/ingest/run", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ fullRescan: true })
    });
    await refreshDashboard(`Starting a full mailbox scan. Polling run #${result.runId}.`);
    ensureRunPolling(Number(result.runId));
  } catch (error) {
    const activeRunId = Number(error && error.activeRunId);
    if (Number.isInteger(activeRunId) && activeRunId > 0) {
      await refreshDashboard(`Another ingestion run is already running. Polling run #${activeRunId}.`);
      ensureRunPolling(activeRunId);
      return;
    }

    renderError(error);
  } finally {
    setLoading(false);
  }
}

async function triggerReparse() {
  setLoading(true, "Reparsing archived reports from storage/raw. This rebuilds parsed outputs and CSV staging files.");

  try {
    const result = await fetchJson("/api/ingest/reparse", { method: "POST" });
    await refreshDashboard(`Starting stored report reparse. Polling run #${result.runId}.`);
    ensureRunPolling(Number(result.runId));
  } catch (error) {
    const activeRunId = Number(error && error.activeRunId);
    if (Number.isInteger(activeRunId) && activeRunId > 0) {
      await refreshDashboard(`Another ingestion run is already running. Polling run #${activeRunId}.`);
      ensureRunPolling(activeRunId);
      return;
    }

    renderError(error);
  } finally {
    setLoading(false);
  }
}

async function logout() {
  if (logoutButton) {
    logoutButton.disabled = true;
  }

  try {
    await fetch("/api/auth/logout", {
      method: "POST"
    });
  } finally {
    window.location.href = "/login";
  }
}

async function refreshDashboard(statusMessage) {
  setLoading(true, statusMessage);

  try {
    state.dashboard = await fetchJson("/api/dashboard");
    state.currentUser = state.dashboard.currentUser || null;

    if (isAdmin()) {
      const usersPayload = await fetchJson("/api/users");
      state.users = Array.isArray(usersPayload.users) ? usersPayload.users : [];

      const approvedSendersPayload = await fetchJson("/api/settings/approved-senders");
      state.approvedSenderPatterns = Array.isArray(approvedSendersPayload.patterns)
        ? approvedSendersPayload.patterns
        : [];
      state.approvedSenderSource = approvedSendersPayload.source === "database" ? "database" : "default";

      state.netsuiteSettings = await fetchJson("/api/settings/netsuite");
      const netsuitePropertyPayload = await fetchJson("/api/netsuite/properties");
      state.netsuitePostingProperties = Array.isArray(netsuitePropertyPayload.properties)
        ? netsuitePropertyPayload.properties
        : [];
    } else {
      state.users = [];
      state.approvedSenderPatterns = [];
      state.approvedSenderSource = "default";
      state.netsuiteSettings = null;
      state.netsuitePostingProperties = [];
      state.netsuitePostingWorkspace = null;
      state.netsuitePostingSelectedRunId = "";
    }

    if (state.dashboard.latestRun && Number.isInteger(state.dashboard.latestRun.id)) {
      if (state.dashboard.latestRun.status === "running" && state.dashboard.latestRun.active === true) {
        state.latestRun = await fetchJson(`/api/runs/${encodeURIComponent(String(state.dashboard.latestRun.id))}/progress`);
      } else {
        state.latestRun = await fetchJson(`/api/runs/${encodeURIComponent(String(state.dashboard.latestRun.id))}`);
      }
    } else {
      state.latestRun = null;
    }

    syncRunPollingFromLatestRun();

    if (state.selectedProperty && state.selectedProperty.property && state.selectedProperty.property.property_slug) {
      state.selectedProperty = await fetchJson(`/api/properties/${encodeURIComponent(state.selectedProperty.property.property_slug)}`);
      showPropertyModal();
    }

    if (
      isAdmin()
      && state.netsuitePostingWorkspace
      && state.netsuitePostingWorkspace.property
      && state.netsuitePostingWorkspace.property.property_slug
    ) {
      const selectedAttachmentId = state.netsuitePostingWorkspace.selectedAttachment
        ? Number(state.netsuitePostingWorkspace.selectedAttachment.attachmentId)
        : null;
      const selectedReportType = getNetSuiteSelectedReportType(state.netsuitePostingWorkspace);
      state.netsuitePostingWorkspace = await fetchNetSuiteWorkspace(
        state.netsuitePostingWorkspace.property.property_slug,
        Number.isInteger(selectedAttachmentId) && selectedAttachmentId > 0 ? selectedAttachmentId : null,
        selectedReportType || null
      );
      if (
        !state.netsuitePostingSelectedRunId
        && Array.isArray(state.netsuitePostingWorkspace.runs)
        && state.netsuitePostingWorkspace.runs.length > 0
      ) {
        state.netsuitePostingSelectedRunId = state.netsuitePostingWorkspace.runs[0].id || "";
      }
    }

    if (!isPageAllowed(state.currentPage)) {
      setCurrentPage("overview", { replaceHash: true });
    }

    render();
  } catch (error) {
    if (error && /Authentication required/i.test(String(error.message || error))) {
      window.location.href = "/login";
      return;
    }

    renderError(error);
  } finally {
    setLoading(false);
  }
}

function syncRunPollingFromLatestRun() {
  const runId = state.latestRun && Number.isInteger(state.latestRun.id)
    ? Number(state.latestRun.id)
    : null;
  const shouldPoll = Number.isInteger(runId)
    && runId > 0
    && state.latestRun.status === "running"
    && state.latestRun.active === true;

  if (shouldPoll) {
    ensureRunPolling(runId);
    return;
  }

  stopRunPolling();
}

function ensureRunPolling(runId) {
  if (!Number.isInteger(runId) || runId <= 0) {
    return;
  }

  if (state.activeRunId === runId) {
    syncToolbarButtons();
    return;
  }

  stopRunPolling();
  state.activeRunId = runId;
  state.runPollToken += 1;
  syncToolbarButtons();
  void pollRunStatus(runId, state.runPollToken);
}

function stopRunPolling() {
  state.activeRunId = null;
  if (state.runPollTimeoutId !== null) {
    window.clearTimeout(state.runPollTimeoutId);
    state.runPollTimeoutId = null;
  }
  syncToolbarButtons();
}

function queueRunPoll(runId, runPollToken, delayMs) {
  state.runPollTimeoutId = window.setTimeout(() => {
    state.runPollTimeoutId = null;
    void pollRunStatus(runId, runPollToken);
  }, delayMs);
}

async function pollRunStatus(runId, runPollToken) {
  try {
    const run = await fetchJson(`/api/runs/${encodeURIComponent(String(runId))}/progress`);
    if (runPollToken !== state.runPollToken || state.activeRunId !== runId) {
      return;
    }

    state.latestRun = run;
    if (state.dashboard) {
      state.dashboard.latestRun = {
        ...(state.dashboard.latestRun || {}),
        id: run.id,
        status: run.status,
        active: run.active === true
      };
    }

    if (run.status === "running" && run.active === true) {
      if (heroStatus) {
        heroStatus.textContent = getRunPollingMessage(run, runId);
      }
      renderOverview();
      renderLatestRun();
      queueRunPoll(runId, runPollToken, 3000);
      return;
    }

    stopRunPolling();

    if (run.status === "running") {
      await refreshDashboard(`Run #${runId} is still marked running, but no active worker is attached.`);
      return;
    }

    const statusLabel = run.status === "completed"
      ? getRunCompletionMessage(run, runId)
      : getRunFailureMessage(run, runId);
    await refreshDashboard(statusLabel);
  } catch (_error) {
    if (runPollToken !== state.runPollToken || state.activeRunId !== runId) {
      return;
    }

    if (heroStatus) {
      heroStatus.textContent = `Run #${runId} is still in progress, but status polling hit an error. Retrying shortly.`;
    }
    queueRunPoll(runId, runPollToken, 5000);
  }
}

async function openPropertyModal(propertySlug) {
  state.selectedHistoryYear = null;
  state.selectedHistoryMonth = null;
  state.selectedHistoryDay = null;
  state.historyTreeInteracted = false;
  propertyModalTitle.textContent = "Loading property...";
  propertyModalSubhead.textContent = "Fetching reports and export details.";
  propertyModalSummary.innerHTML = "";
  if (propertyEditorAvailable) {
    propertyNameInput.value = "";
    propertySlugInput.value = "";
  }
  setPropertyFormStatus("Loading property details...", "empty");
  propertyHistoryCaption.textContent = "Loading report history";
  propertyHistoryBrowser.innerHTML = "";
  propertyHistorySelection.className = "history-selection empty";
  propertyHistorySelection.textContent = "Preparing report history...";
  propertyModalAttachments.innerHTML = '<div class="empty">Loading property detail...</div>';
  showPropertyModal();

  try {
    state.selectedProperty = await fetchJson(`/api/properties/${encodeURIComponent(propertySlug)}`);
    renderPropertyModal();
  } catch (error) {
    propertyModalTitle.textContent = "Property unavailable";
    propertyModalSubhead.textContent = error && error.message ? error.message : String(error);
    propertyModalAttachments.innerHTML = '<div class="empty">Property detail could not be loaded.</div>';
    setPropertyFormStatus("Property detail could not be loaded.", "error");
  }
}

async function savePropertyEdits() {
  if (!isAdmin() || !propertyEditorAvailable || !state.selectedProperty || !state.selectedProperty.property) {
    return;
  }

  const currentSlug = state.selectedProperty.property.property_slug;
  const propertyName = propertyNameInput.value.trim();
  const propertySlug = propertySlugInput.value.trim();

  state.propertySaving = true;
  syncPropertyFormControls();
  setPropertyFormStatus("Saving property changes...", "empty");

  try {
    state.selectedProperty = await fetchJson(`/api/properties/${encodeURIComponent(currentSlug)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        propertyName,
        propertySlug
      })
    });

    setPropertyFormStatus("Property details saved.", "success");
    await refreshDashboard(`Property ${state.selectedProperty.property.property_name} updated.`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setPropertyFormStatus(message, "error");
  } finally {
    state.propertySaving = false;
    syncPropertyFormControls();
  }
}

function closePropertyModal() {
  if (!propertyModal) {
    return;
  }

  propertyModal.classList.add("hidden");
  propertyModal.setAttribute("aria-hidden", "true");
}

function showPropertyModal() {
  if (!propertyModal) {
    return;
  }

  propertyModal.classList.remove("hidden");
  propertyModal.setAttribute("aria-hidden", "false");
}

function render() {
  renderNavigation();
  renderAccount();
  renderOverview();
  renderProperties();
  renderNetSuitePosting();
  renderLatestRun();
  renderSettings();
  renderPropertyModal();
}

function renderNavigation() {
  for (const link of pageLinks) {
    const page = normalizePage(link.getAttribute("data-page-link"));
    const allowed = isPageAllowed(page);
    const isActive = page === state.currentPage;
    link.hidden = !allowed;
    link.classList.toggle("active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }

  for (const view of pageViews) {
    const page = normalizePage(view.getAttribute("data-page"));
    const isActive = isPageAllowed(page) && page === state.currentPage;
    view.classList.toggle("is-active", isActive);
    view.hidden = !isActive;
  }
}

function renderAccount() {
  if (!heroAccount) {
    return;
  }

  if (!state.currentUser) {
    heroAccount.textContent = "Not signed in";
    return;
  }

  heroAccount.textContent = `Signed in as ${state.currentUser.username} | full console access`;
}

function renderOverview() {
  if (!state.dashboard) {
    overviewStamp.textContent = "Waiting for data";
    overviewGrid.innerHTML = "";
    return;
  }

  overviewStamp.textContent = `Server time ${formatDateTime(state.dashboard.serverTime)}`;

  const cards = [
    ["Mailbox User", state.dashboard.mailboxUser],
    ["Mail Folder", state.dashboard.mailFolder],
    ["Poll Schedule", state.dashboard.pollCron],
    ["Data Directory", state.dashboard.dataDir],
    ["Tracked Properties", Array.isArray(state.dashboard.properties) ? state.dashboard.properties.length : 0],
    ["Latest Run", state.dashboard.latestRun ? `#${state.dashboard.latestRun.id}` : "None yet"],
    ["Latest Run Status", state.dashboard.latestRun ? state.dashboard.latestRun.status : "Idle"]
  ];

  overviewGrid.innerHTML = cards.map(([label, value]) => `
    <article class="stat-card">
      <strong>${escapeHtml(label)}</strong>
      <div class="stat-value">${escapeHtml(String(value))}</div>
    </article>
  `).join("");
}

function renderProperties() {
  if (!state.dashboard || !Array.isArray(state.dashboard.properties) || state.dashboard.properties.length === 0) {
    propertyList.innerHTML = '<div class="empty">No property assignments have been recorded yet. Run a sync once reports arrive.</div>';
    return;
  }

  propertyList.innerHTML = state.dashboard.properties.map((property) => `
    <article class="property-card">
      <div class="property-kicker">Property Folder</div>
      <strong>${escapeHtml(property.property_name || "Unassigned Property")}</strong>
      <div class="attachment-meta">
        <span><code>${escapeHtml(property.property_slug || "unassigned-property")}</code></span>
        <span>Attachments: ${escapeHtml(String(property.attachment_count || 0))}</span>
        <span>Parsed: ${escapeHtml(String(property.parsed_count || 0))}</span>
        <span>Deferred: ${escapeHtml(String(property.deferred_count || 0))}</span>
        <span>Failed: ${escapeHtml(String(property.failed_count || 0))}</span>
        <span>Latest received: ${escapeHtml(formatDateTime(property.last_received_at))}</span>
      </div>
      <div class="toolbar-row">
        <button class="secondary" type="button" data-property-slug="${escapeHtml(property.property_slug)}">View Reports</button>
      </div>
    </article>
  `).join("");
}

function getNetSuitePropertyReportTypes(property) {
  return normalizeNetSuiteReportTypeSummaries(property && property.supportedReportTypes);
}

function getNetSuiteWorkspaceReportTypes(workspace) {
  const summaries = normalizeNetSuiteReportTypeSummaries(workspace && workspace.availableReportTypes);
  if (summaries.length > 0) {
    return summaries;
  }

  return normalizeNetSuiteReportTypeSummariesFromAttachments(
    workspace && Array.isArray(workspace.supportedAttachments) ? workspace.supportedAttachments : []
  );
}

function getNetSuiteSelectedReportType(workspace) {
  if (workspace && typeof workspace.selectedReportType === "string" && workspace.selectedReportType) {
    return workspace.selectedReportType;
  }

  return workspace && workspace.selectedAttachment && typeof workspace.selectedAttachment.reportType === "string"
    ? workspace.selectedAttachment.reportType
    : "";
}

function getNetSuiteFilteredAttachments(workspace, reportType) {
  const attachments = workspace && Array.isArray(workspace.supportedAttachments) ? workspace.supportedAttachments : [];
  if (!reportType) {
    return attachments;
  }

  const filtered = attachments.filter((attachment) => attachment && attachment.reportType === reportType);
  return filtered.length > 0 ? filtered : attachments;
}

function renderNetSuitePosting() {
  if (!netsuitePostingAvailable) {
    return;
  }

  syncNetSuitePostingControls();
  if (!state.currentUser) {
    netsuitePropertyStatus.textContent = "Sign in to use the NetSuite posting workspace.";
    netsuitePropertyStatus.className = "form-status empty";
    netsuitePropertyList.innerHTML = '<div class="empty">Sign in to use the NetSuite posting workspace.</div>';
    netsuiteWorkspace.hidden = true;
    netsuiteWorkspaceEmpty.hidden = false;
    netsuiteWorkspaceEmpty.textContent = "Sign in to use the NetSuite posting workspace.";
    return;
  }

  const properties = Array.isArray(state.netsuitePostingProperties) ? state.netsuitePostingProperties : [];
  netsuitePropertyStatus.textContent = state.netsuitePostingLoading
    ? "Loading NetSuite posting workspace..."
    : (
      properties.length > 0
        ? `${properties.length} properties currently have parsed report families available for statistical GL work.`
        : "No parsed report families are available yet."
    );
  netsuitePropertyStatus.className = `form-status ${properties.length > 0 ? "success" : "empty"}`;

  if (properties.length === 0) {
    netsuitePropertyList.innerHTML = '<div class="empty">Run a sync or reparse once hotel reports are available.</div>';
  } else {
    const selectedSlug = state.netsuitePostingWorkspace && state.netsuitePostingWorkspace.property
      ? state.netsuitePostingWorkspace.property.property_slug
      : "";
    netsuitePropertyList.innerHTML = properties.map((property) => {
      const supportedReportTypes = getNetSuitePropertyReportTypes(property);
      const reportTypeSummary = supportedReportTypes
        .map((entry) => `${entry.reportTitle} (${entry.attachmentCount})`)
        .join(", ");

      return `
        <article class="attachment-card${property.property_slug === selectedSlug ? " is-selected" : ""}">
          <div class="attachment-top">
            <div>
              <strong>${escapeHtml(property.property_name || "Unassigned Property")}</strong>
              <div class="attachment-meta">
                <span><code>${escapeHtml(property.property_slug || "unassigned-property")}</code></span>
                <span>Supported attachments: ${escapeHtml(String(property.attachment_count || 0))}</span>
                <span>Source types: ${escapeHtml(String(supportedReportTypes.length))}</span>
                <span>Latest received: ${escapeHtml(formatDateTime(property.last_received_at))}</span>
                ${reportTypeSummary ? `<span>${escapeHtml(reportTypeSummary)}</span>` : ""}
              </div>
            </div>
          </div>
          <div class="toolbar-row">
            <button class="secondary" type="button" data-netsuite-property-slug="${escapeHtml(property.property_slug || "")}">Open Workspace</button>
          </div>
        </article>
      `;
    }).join("");
  }

  if (!state.netsuitePostingWorkspace || !state.netsuitePostingWorkspace.property) {
    netsuiteWorkspace.hidden = true;
    netsuiteWorkspaceEmpty.hidden = false;
    netsuiteWorkspaceEmpty.textContent = "Select a property to load its NetSuite posting workspace.";
    netsuiteWorkspaceSummary.innerHTML = "";
    netsuitePostingMappings.innerHTML = "";
    netsuitePostingPreview.innerHTML = "";
    netsuitePostingRuns.innerHTML = "";
    return;
  }

  const workspace = state.netsuitePostingWorkspace;
  const property = workspace.property;
  const selectedAttachment = workspace.selectedAttachment || null;
  const selectedReportType = getNetSuiteSelectedReportType(workspace);
  const reportTypeOptions = getNetSuiteWorkspaceReportTypes(workspace);
  const filteredAttachments = getNetSuiteFilteredAttachments(workspace, selectedReportType);
  netsuiteWorkspace.hidden = false;
  netsuiteWorkspaceEmpty.hidden = true;

  const summaryCards = [
    ["Property", property.property_name || property.property_slug || "Property"],
    ["Source Types", reportTypeOptions.length],
    ["Selected Type", selectedAttachment ? (selectedAttachment.reportTitle || selectedAttachment.reportType) : "None selected"],
    ["Available Reports", filteredAttachments.length],
    ["Selected Attachment", selectedAttachment ? selectedAttachment.attachmentName : "None selected"],
    ["Report Date", selectedAttachment && selectedAttachment.reportDate ? selectedAttachment.reportDate : "Not detected"],
    ["Received", selectedAttachment ? formatDateTime(selectedAttachment.receivedAt) : "Unknown"],
    ["Discovered Categories", workspace.discoverySummary ? workspace.discoverySummary.discoveredItemCount : 0]
  ];

  netsuiteWorkspaceSummary.innerHTML = summaryCards.map(([label, value]) => `
    <article class="metric-card">
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <div class="metric-label">${escapeHtml(label)}</div>
    </article>
  `).join("");

  renderNetSuiteReportTypeOptions(workspace);
  renderNetSuiteAttachmentOptions(workspace);
  renderNetSuitePostingDefaults(workspace.defaults);
  setNetSuitePostingStatus(state.netsuitePostingStatus, state.netsuitePostingTone);
  renderNetSuitePostingMappings(workspace.mappings || []);
  renderNetSuitePostingPreview(workspace.runs || []);
  renderNetSuitePostingRuns(workspace.runs || []);
}

function normalizeNetSuiteReportTypeSummaries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const reportType = typeof entry.reportType === "string" ? entry.reportType : "";
      if (!reportType) {
        return null;
      }

      return {
        reportType,
        reportTitle: typeof entry.reportTitle === "string" && entry.reportTitle
          ? entry.reportTitle
          : reportType,
        attachmentCount: Number(entry.attachmentCount) > 0 ? Number(entry.attachmentCount) : 0
      };
    })
    .filter(Boolean);
}

function normalizeNetSuiteReportTypeSummariesFromAttachments(attachments) {
  const summaryByType = new Map();

  for (const attachment of attachments) {
    const reportType = attachment && typeof attachment.reportType === "string" ? attachment.reportType : "";
    if (!reportType) {
      continue;
    }

    const existing = summaryByType.get(reportType);
    if (existing) {
      existing.attachmentCount += 1;
      continue;
    }

    summaryByType.set(reportType, {
      reportType,
      reportTitle: typeof attachment.reportTitle === "string" && attachment.reportTitle
        ? attachment.reportTitle
        : reportType,
      attachmentCount: 1
    });
  }

  return Array.from(summaryByType.values()).sort((left, right) => {
    const titleComparison = String(left.reportTitle || "").localeCompare(String(right.reportTitle || ""));
    if (titleComparison !== 0) {
      return titleComparison;
    }
    return String(left.reportType || "").localeCompare(String(right.reportType || ""));
  });
}

function renderLatestRun() {
  if (!state.latestRun) {
    latestRunBadge.textContent = "No runs yet";
    latestRunBadge.className = "badge";
    runSummaryGrid.innerHTML = "";
    runNotes.className = "notes-block empty";
    runNotes.textContent = "No runs have been recorded yet. Use Run Inbox Sync to trigger the first pass.";
    attachmentList.innerHTML = "";
    return;
  }

  latestRunBadge.textContent = `Run #${state.latestRun.id} ${state.latestRun.status}`;
  latestRunBadge.className = `badge ${getRunTone(state.latestRun.status)}`;

  const summaryCards = [
    ["Run Type", getRunDisplayName(state.latestRun)],
    ["Messages Seen", state.latestRun.messages_seen],
    ["Attachments Seen", state.latestRun.attachments_seen],
    ["Approved", state.latestRun.attachments_approved],
    ["Not Approved", state.latestRun.attachments_not_approved],
    ["Archived", state.latestRun.attachments_archived],
    ["Parsed", state.latestRun.attachments_parsed],
    ["Deferred", state.latestRun.attachments_deferred],
    ["Failed", state.latestRun.attachments_failed]
  ];

  runSummaryGrid.innerHTML = summaryCards.map(([label, value]) => `
    <article class="metric-card">
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <div class="metric-label">${escapeHtml(label)}</div>
    </article>
  `).join("");

  const notes = Array.isArray(state.latestRun.notes) ? state.latestRun.notes : [];
  if (notes.length > 0) {
    runNotes.className = "notes-block";
    runNotes.innerHTML = `<strong>Run notes</strong><ul class="note-list">${notes.map((note) => `<li>${escapeHtml(String(note))}</li>`).join("")}</ul>`;
  } else if (state.latestRun.status === "running") {
    runNotes.className = "notes-block empty";
    runNotes.textContent = getRunPendingNotesMessage(state.latestRun);
  } else {
    runNotes.className = "notes-block empty";
    runNotes.textContent = "No warnings or notes were recorded for the latest run.";
  }

  const attachments = Array.isArray(state.latestRun.attachments) ? state.latestRun.attachments : [];
  if (attachments.length === 0) {
    attachmentList.innerHTML = state.latestRun.status === "running"
      ? `<div class="empty">${escapeHtml(getRunPendingAttachmentMessage(state.latestRun))}</div>`
      : '<div class="empty">No attachment records were captured for the latest run.</div>';
    return;
  }

  attachmentList.innerHTML = attachments.map((attachment) => `
    <article class="attachment-card">
      <div class="attachment-top">
        <div>
          <strong>${escapeHtml(attachment.attachment_name || "Unnamed attachment")}</strong>
          <div class="attachment-meta">
            <span>${escapeHtml(attachment.report_title || attachment.report_type || "No detected report yet")}</span>
            <span>${escapeHtml(attachment.property_name || "Unassigned Property")}</span>
            <span>${escapeHtml(attachment.graph_message_id || "")}</span>
          </div>
        </div>
        <span class="status-chip ${slugify(attachment.status)}">${escapeHtml(attachment.status || "unknown")}</span>
      </div>
      <div class="attachment-meta">
        ${attachment.report_date ? `<span>Report date: ${escapeHtml(attachment.report_date)}</span>` : ""}
        ${attachment.archived_path ? `<span>Folder: <code>${escapeHtml(attachment.archived_path)}</code></span>` : ""}
        ${attachment.parsed_json_path ? `<span>Parsed JSON: <code>${escapeHtml(attachment.parsed_json_path)}</code></span>` : ""}
        ${attachment.parse_error ? `<span>Parser note: ${escapeHtml(attachment.parse_error)}</span>` : ""}
      </div>
    </article>
  `).join("");
}

function renderSettings() {
  if (!viewerSettingsAvailable && !approvedSenderSettingsAvailable && !netsuiteSettingsAvailable) {
    return;
  }

  if (!state.currentUser) {
    return;
  }

  syncViewerFormControls();
  syncApprovedSenderFormControls();
  syncNetSuiteFormControls();

  if (approvedSenderSettingsAvailable) {
    approvedSendersStatus.textContent = state.approvedSenderStatus;
    approvedSendersStatus.className = `form-status ${state.approvedSenderTone}`;
    if (document.activeElement !== approvedSendersInput && !state.approvedSenderSaving) {
      approvedSendersInput.value = state.approvedSenderPatterns.join("\n");
    }
  }

  renderNetSuiteSettings();

  if (!viewerSettingsAvailable) {
    return;
  }

  viewerFormStatus.textContent = state.viewerFormStatus;
  viewerFormStatus.className = `form-status ${state.viewerFormTone}`;

  if (!Array.isArray(state.users) || state.users.length === 0) {
    viewerUserList.innerHTML = '<div class="empty">No users have been recorded yet.</div>';
    return;
  }

  viewerUserList.innerHTML = state.users.map((user) => {
    const canChangePassword = canManageUserPassword(Number(user.id));

    return `
      <article class="attachment-card">
        <div class="attachment-top">
          <div>
            <strong>${escapeHtml(user.username)}</strong>
            <div class="attachment-meta">
              <span>Access: Full console</span>
              <span>Created: ${escapeHtml(formatDateTime(user.createdAt))}</span>
            </div>
          </div>
          <span class="status-chip ${user.role === "admin" ? "completed" : ""}">${escapeHtml(user.role === "admin" ? "Primary admin" : "Full access")}</span>
        </div>
        ${canChangePassword ? `
          <form class="user-password-form" data-password-user-id="${escapeHtml(String(user.id))}">
            <label class="form-field">
              <span>Set new password</span>
              <input
                name="password"
                type="password"
                placeholder="At least 8 characters"
                autocomplete="new-password"
                minlength="8"
                ${Number(user.id) === state.userPasswordSavingId ? "disabled" : ""}
                required
              >
            </label>
            <div class="toolbar-row">
              <button
                class="secondary"
                type="submit"
                ${Number(user.id) === state.userPasswordSavingId ? "disabled" : ""}
              >${Number(user.id) === state.userPasswordSavingId ? "Saving..." : "Change Password"}</button>
              ${user.role === "viewer" ? `
                <button
                  class="secondary"
                  type="button"
                  data-delete-user-id="${escapeHtml(String(user.id))}"
                  ${Number(user.id) === state.viewerDeletingUserId ? "disabled" : ""}
                >${Number(user.id) === state.viewerDeletingUserId ? "Removing..." : "Remove User"}</button>
              ` : '<span class="badge">Primary safety account</span>'}
            </div>
          </form>
        ` : `
          <div class="user-password-form">
            <div class="form-help">Only this user or the primary admin can change this password.</div>
            <div class="toolbar-row">
              ${user.role === "viewer" ? `
                <button
                  class="secondary"
                  type="button"
                  data-delete-user-id="${escapeHtml(String(user.id))}"
                  ${Number(user.id) === state.viewerDeletingUserId ? "disabled" : ""}
                >${Number(user.id) === state.viewerDeletingUserId ? "Removing..." : "Remove User"}</button>
              ` : '<span class="badge">Primary safety account</span>'}
            </div>
          </div>
        `}
      </article>
    `;
  }).join("");
}

function renderNetSuiteReportTypeOptions(workspace) {
  if (!netsuiteReportTypeSelect) {
    return;
  }

  const reportTypes = getNetSuiteWorkspaceReportTypes(workspace);
  const selectedReportType = getNetSuiteSelectedReportType(workspace);
  if (reportTypes.length === 0) {
    netsuiteReportTypeSelect.innerHTML = '<option value="">No source report types available</option>';
    return;
  }

  netsuiteReportTypeSelect.innerHTML = reportTypes.map((entry) => `
    <option value="${escapeHtml(entry.reportType)}" ${entry.reportType === selectedReportType ? "selected" : ""}>
      ${escapeHtml(`${entry.reportTitle} (${entry.attachmentCount} ${entry.attachmentCount === 1 ? "report" : "reports"})`)}
    </option>
  `).join("");
}

function renderNetSuiteAttachmentOptions(workspace) {
  if (!netsuiteAttachmentSelect) {
    return;
  }

  const selectedReportType = getNetSuiteSelectedReportType(workspace);
  const attachments = getNetSuiteFilteredAttachments(workspace, selectedReportType);
  const selectedAttachmentId = workspace.selectedAttachment ? Number(workspace.selectedAttachment.attachmentId) : 0;
  if (attachments.length === 0) {
    netsuiteAttachmentSelect.innerHTML = '<option value="">No source attachments available for this report type</option>';
    return;
  }

  netsuiteAttachmentSelect.innerHTML = attachments.map((attachment) => `
    <option value="${escapeHtml(String(attachment.attachmentId))}" ${attachment.attachmentId === selectedAttachmentId ? "selected" : ""}>
      ${escapeHtml([
        attachment.reportTitle || attachment.reportType,
        attachment.reportDate || "no report date",
        formatDateTime(attachment.receivedAt)
      ].join(" | "))}
    </option>
  `).join("");
}

function renderNetSuitePostingDefaults(defaults) {
  if (!netsuitePostingAvailable || !defaults) {
    return;
  }

  if (document.activeElement !== netsuitePostingExternalPrefix && !state.netsuitePostingSaving) {
    netsuitePostingExternalPrefix.value = defaults.externalIdPrefix || "";
  }
  if (document.activeElement !== netsuitePostingBalancingGl && !state.netsuitePostingSaving) {
    netsuitePostingBalancingGl.value = defaults.balancingGlCode || "";
  }
  if (document.activeElement !== netsuitePostingMemoTemplate && !state.netsuitePostingSaving) {
    netsuitePostingMemoTemplate.value = defaults.memoTemplate || "";
  }
  if (document.activeElement !== netsuitePostingSubsidiaryId && !state.netsuitePostingSaving) {
    netsuitePostingSubsidiaryId.value = defaults.subsidiaryId || "";
  }
  if (document.activeElement !== netsuitePostingCurrencyId && !state.netsuitePostingSaving) {
    netsuitePostingCurrencyId.value = defaults.currencyId || "";
  }
  if (document.activeElement !== netsuitePostingLocationId && !state.netsuitePostingSaving) {
    netsuitePostingLocationId.value = defaults.locationId || "";
  }
  if (document.activeElement !== netsuitePostingDepartmentId && !state.netsuitePostingSaving) {
    netsuitePostingDepartmentId.value = defaults.departmentId || "";
  }
  if (document.activeElement !== netsuitePostingClassId && !state.netsuitePostingSaving) {
    netsuitePostingClassId.value = defaults.classId || "";
  }
}

function renderNetSuitePostingMappings(mappings) {
  if (!netsuitePostingMappings || !netsuitePostingMappingSummary) {
    return;
  }

  if (!Array.isArray(mappings) || mappings.length === 0) {
    netsuitePostingMappingSummary.className = "notes-block empty";
    netsuitePostingMappingSummary.textContent = "No grouped statistical categories were discovered for the selected attachment.";
    netsuitePostingMappings.innerHTML = "";
    return;
  }

  const missingCount = mappings.filter((entry) => !(entry.netsuiteGlCode || "").trim()).length;
  netsuitePostingMappingSummary.className = "notes-block";
  netsuitePostingMappingSummary.innerHTML = `
    <strong>${escapeHtml(String(mappings.length))} discovered statistical categories</strong>
    <div class="attachment-meta">
      <span>Missing GL codes: ${escapeHtml(String(missingCount))}</span>
      <span>Mappings are grouped into source categories for the selected report type.</span>
    </div>
  `;

  netsuitePostingMappings.innerHTML = `
    <div class="report-table-wrap">
      <table class="data-table netsuite-posting-table">
        <thead>
          <tr>
            <th>Group</th>
            <th>Category</th>
            <th>Value Field</th>
            <th>Current Value</th>
            <th>GL Code</th>
            <th>Polarity</th>
          </tr>
        </thead>
        <tbody>
          ${mappings.map((mapping) => `
            <tr data-netsuite-mapping-key="${escapeHtml(mapping.mappingKey || "")}">
              <td>${escapeHtml(mapping.groupLabel || "")}</td>
              <td>${escapeHtml(mapping.itemLabel || "")}</td>
              <td>${escapeHtml(mapping.amountFieldLabel || mapping.amountField || "")}</td>
              <td>${escapeHtml(mapping.currentAmount || "0.00")}</td>
              <td>
                <input
                  type="text"
                  class="table-input"
                  value="${escapeHtml(mapping.netsuiteGlCode || "")}"
                  data-netsuite-gl-code="1"
                  placeholder="Account number"
                >
              </td>
              <td>
                <select class="table-input" data-netsuite-posting-polarity="1">
                  <option value="debit_positive" ${mapping.postingPolarity === "debit_positive" ? "selected" : ""}>Debit positive</option>
                  <option value="credit_positive" ${mapping.postingPolarity === "credit_positive" ? "selected" : ""}>Credit positive</option>
                </select>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderNetSuitePostingPreview(runs) {
  if (!netsuitePostingPreview) {
    return;
  }

  const selectedRun = getSelectedNetSuiteRun(runs);
  if (!selectedRun || !selectedRun.previewPayload) {
    netsuitePostingPreview.innerHTML = '<div class="empty">Build a preview to inspect the grouped statistical GL lines.</div>';
    return;
  }

  const preview = selectedRun.previewPayload;
  const validations = Array.isArray(preview.validations) ? preview.validations : [];
  const lines = Array.isArray(preview.lines) ? preview.lines : [];

  netsuitePostingPreview.innerHTML = `
    <section class="report-section">
      <div class="settings-card-head">
        <div>
          <h3>Selected Preview</h3>
          <p class="subhead">${escapeHtml(preview.reportTitle || "Report")} for ${escapeHtml(preview.reportDate || preview.accountingDate || "undated report")}</p>
        </div>
        <div class="badge ${selectedRun.status === "submitted" ? "success" : (selectedRun.status === "failed" ? "danger" : "")}">
          ${escapeHtml(selectedRun.status || "preview")}
        </div>
      </div>
      <div class="attachment-meta">
        <span>External ID: <code>${escapeHtml(preview.externalId || "")}</code></span>
        <span>Memo: ${escapeHtml(preview.memo || "")}</span>
        <span>Positive side: ${escapeHtml(preview.summary ? preview.summary.debitTotal : "0.00")}</span>
        <span>Negative side: ${escapeHtml(preview.summary ? preview.summary.creditTotal : "0.00")}</span>
        <span>Difference: ${escapeHtml(preview.summary ? preview.summary.balanceDifference : "0.00")}</span>
      </div>
      ${validations.length > 0 ? `
        <div class="notes-block">
          <strong>Validations</strong>
          <ul class="note-list">
            ${validations.map((validation) => `
              <li>${escapeHtml(`${validation.level.toUpperCase()}: ${validation.message}`)}</li>
            `).join("")}
          </ul>
        </div>
      ` : '<div class="notes-block success"><strong>No preview validations were raised.</strong></div>'}
      <div class="report-table-wrap">
        <table class="data-table netsuite-posting-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Category</th>
              <th>GL Code</th>
              <th>Value</th>
              <th>Positive</th>
              <th>Negative</th>
            </tr>
          </thead>
          <tbody>
            ${lines.map((line) => `
              <tr>
                <td>${escapeHtml(line.groupLabel || "")}</td>
                <td>${escapeHtml(line.itemLabel || "")}</td>
                <td>${escapeHtml(line.glCode || "")}</td>
                <td>${escapeHtml(line.rawAmount || "0.00")}</td>
                <td>${escapeHtml(line.debit || "0.00")}</td>
                <td>${escapeHtml(line.credit || "0.00")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderNetSuitePostingRuns(runs) {
  if (!netsuitePostingRuns) {
    return;
  }

  if (!Array.isArray(runs) || runs.length === 0) {
    netsuitePostingRuns.innerHTML = '<div class="empty">No saved NetSuite posting previews have been recorded yet.</div>';
    return;
  }

  const selectedRun = getSelectedNetSuiteRun(runs);
  netsuitePostingRuns.innerHTML = `
    <section class="report-section">
      <div class="settings-card-head">
        <div>
          <h3>Saved Preview And Submit History</h3>
          <p class="subhead">Each preview is persisted so we can reload it before deciding whether to post it.</p>
        </div>
      </div>
      <div class="list-grid">
        ${runs.map((run) => `
          <article class="attachment-card${selectedRun && selectedRun.id === run.id ? " is-selected" : ""}">
            <div class="attachment-top">
              <div>
                <strong>${escapeHtml(run.report_title || run.report_type || "Posting run")}</strong>
                <div class="attachment-meta">
                  <span>${escapeHtml(run.report_date || "No report date")}</span>
                  <span>Created: ${escapeHtml(formatDateTime(run.created_at))}</span>
                  <span>By: ${escapeHtml(run.created_by_username || "unknown")}</span>
                </div>
              </div>
              <span class="status-chip ${slugify(run.status || "preview")}">${escapeHtml(run.status || "preview")}</span>
            </div>
            <div class="attachment-meta">
              <span>External ID: <code>${escapeHtml(run.external_id || "")}</code></span>
              ${run.netsuite_response_summary ? `<span>${escapeHtml(run.netsuite_response_summary)}</span>` : ""}
              ${run.error_message ? `<span>${escapeHtml(run.error_message)}</span>` : ""}
            </div>
            <div class="toolbar-row">
              <button class="secondary" type="button" data-netsuite-run-id="${escapeHtml(run.id || "")}">Load Preview</button>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function syncNetSuitePostingControls() {
  if (!netsuitePostingAvailable) {
    return;
  }

  const busy = state.netsuitePostingLoading || state.netsuitePostingSaving || state.netsuitePostingPreviewing || state.netsuitePostingSubmitting || !isAdmin();
  const hasWorkspace = Boolean(state.netsuitePostingWorkspace && state.netsuitePostingWorkspace.selectedAttachment);
  const hasReportTypes = Boolean(state.netsuitePostingWorkspace && getNetSuiteWorkspaceReportTypes(state.netsuitePostingWorkspace).length > 0);
  netsuiteReportTypeSelect.disabled = busy || !hasReportTypes;
  netsuiteAttachmentSelect.disabled = busy || !hasWorkspace;
  netsuitePostingExternalPrefix.disabled = busy || !hasWorkspace;
  netsuitePostingBalancingGl.disabled = true;
  netsuitePostingMemoTemplate.disabled = busy || !hasWorkspace;
  netsuitePostingSubsidiaryId.disabled = busy || !hasWorkspace;
  netsuitePostingCurrencyId.disabled = busy || !hasWorkspace;
  netsuitePostingLocationId.disabled = busy || !hasWorkspace;
  netsuitePostingDepartmentId.disabled = busy || !hasWorkspace;
  netsuitePostingClassId.disabled = busy || !hasWorkspace;
  netsuitePostingRefreshButton.disabled = busy || !hasWorkspace;
  netsuitePostingSaveButton.disabled = busy || !hasWorkspace;
  netsuitePostingPreviewButton.disabled = busy || !hasWorkspace;
  netsuitePostingSubmitButton.disabled = busy || !hasWorkspace || !getSelectedNetSuiteRun(state.netsuitePostingWorkspace ? state.netsuitePostingWorkspace.runs : []);
}

function setNetSuitePostingStatus(message, tone) {
  state.netsuitePostingStatus = message;
  state.netsuitePostingTone = tone;
  if (!netsuitePostingStatus) {
    return;
  }

  netsuitePostingStatus.textContent = message;
  netsuitePostingStatus.className = `form-status ${tone}`;
}

async function loadNetSuiteWorkspace(propertySlug, attachmentId = null, reportType = null) {
  if (!isAdmin() || !netsuitePostingAvailable) {
    return;
  }

  state.netsuitePostingLoading = true;
  setNetSuitePostingStatus("Loading NetSuite posting workspace...", "empty");
  syncNetSuitePostingControls();

  try {
    state.netsuitePostingWorkspace = await fetchNetSuiteWorkspace(propertySlug, attachmentId, reportType);
    state.netsuitePostingSelectedRunId = Array.isArray(state.netsuitePostingWorkspace.runs) && state.netsuitePostingWorkspace.runs.length > 0
      ? state.netsuitePostingWorkspace.runs[0].id || ""
      : "";
    setNetSuitePostingStatus("NetSuite posting workspace loaded.", "success");
    renderNetSuitePosting();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setNetSuitePostingStatus(message, "error");
  } finally {
    state.netsuitePostingLoading = false;
    syncNetSuitePostingControls();
    renderNetSuitePosting();
  }
}

async function saveNetSuitePostingSetup() {
  if (!isAdmin() || !state.netsuitePostingWorkspace || !state.netsuitePostingWorkspace.property) {
    return;
  }

  const propertySlug = state.netsuitePostingWorkspace.property.property_slug;
  const attachmentId = Number(netsuiteAttachmentSelect.value);
  state.netsuitePostingSaving = true;
  setNetSuitePostingStatus("Saving NetSuite posting setup...", "empty");
  syncNetSuitePostingControls();

  try {
    state.netsuitePostingWorkspace = await fetchJson(`/api/netsuite/properties/${encodeURIComponent(propertySlug)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId,
        mappings: collectNetSuitePostingMappings(),
        defaults: collectNetSuitePostingDefaults()
      })
    });
    state.netsuitePostingSelectedRunId = Array.isArray(state.netsuitePostingWorkspace.runs) && state.netsuitePostingWorkspace.runs.length > 0
      ? state.netsuitePostingSelectedRunId || state.netsuitePostingWorkspace.runs[0].id || ""
      : "";
    setNetSuitePostingStatus("NetSuite posting setup saved.", "success");
    renderNetSuitePosting();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setNetSuitePostingStatus(message, "error");
  } finally {
    state.netsuitePostingSaving = false;
    syncNetSuitePostingControls();
  }
}

async function buildNetSuitePostingPreview() {
  if (!isAdmin() || !state.netsuitePostingWorkspace || !state.netsuitePostingWorkspace.property) {
    return;
  }

  const propertySlug = state.netsuitePostingWorkspace.property.property_slug;
  const attachmentId = Number(netsuiteAttachmentSelect.value);
  state.netsuitePostingPreviewing = true;
  setNetSuitePostingStatus("Building the NetSuite posting preview...", "empty");
  syncNetSuitePostingControls();

  try {
    const result = await fetchJson(`/api/netsuite/properties/${encodeURIComponent(propertySlug)}/preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId,
        mappings: collectNetSuitePostingMappings(),
        defaults: collectNetSuitePostingDefaults()
      })
    });
    state.netsuitePostingWorkspace = result.workspace || state.netsuitePostingWorkspace;
    state.netsuitePostingSelectedRunId = result.run && result.run.id
      ? result.run.id
      : (
        Array.isArray(state.netsuitePostingWorkspace.runs) && state.netsuitePostingWorkspace.runs.length > 0
          ? state.netsuitePostingWorkspace.runs[0].id || ""
          : ""
      );
    setNetSuitePostingStatus(
      result.run && result.run.previewPayload && result.run.previewPayload.summary && result.run.previewPayload.summary.postable
        ? "NetSuite statistical preview built. Review the lines and warnings before submitting."
        : "NetSuite preview built. Review the validations before submitting.",
      result.run && result.run.previewPayload && result.run.previewPayload.summary && result.run.previewPayload.summary.postable ? "success" : "empty"
    );
    renderNetSuitePosting();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setNetSuitePostingStatus(message, "error");
  } finally {
    state.netsuitePostingPreviewing = false;
    syncNetSuitePostingControls();
  }
}

async function submitNetSuitePostingPreview() {
  if (!isAdmin() || !state.netsuitePostingWorkspace || !state.netsuitePostingWorkspace.property) {
    return;
  }

  const propertySlug = state.netsuitePostingWorkspace.property.property_slug;
  const selectedRun = getSelectedNetSuiteRun(state.netsuitePostingWorkspace.runs || []);
  if (!selectedRun || !selectedRun.id) {
    setNetSuitePostingStatus("Load or build a saved preview before submitting to NetSuite.", "error");
    return;
  }

  state.netsuitePostingSubmitting = true;
  setNetSuitePostingStatus("Submitting the saved preview to NetSuite...", "empty");
  syncNetSuitePostingControls();

  try {
    const result = await fetchJson(`/api/netsuite/properties/${encodeURIComponent(propertySlug)}/runs/${encodeURIComponent(selectedRun.id)}/submit`, {
      method: "POST"
    });
    if (Array.isArray(state.netsuitePostingWorkspace.runs)) {
      state.netsuitePostingWorkspace.runs = state.netsuitePostingWorkspace.runs.map((run) => run.id === result.run.id ? result.run : run);
    }
    state.netsuitePostingSelectedRunId = result.run.id || state.netsuitePostingSelectedRunId;
    setNetSuitePostingStatus(result.run.netsuite_response_summary || "NetSuite journal submitted.", "success");
    renderNetSuitePosting();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setNetSuitePostingStatus(message, "error");
    try {
      state.netsuitePostingWorkspace = await fetchNetSuiteWorkspace(
        propertySlug,
        Number(netsuiteAttachmentSelect.value),
        netsuiteReportTypeSelect ? netsuiteReportTypeSelect.value : null
      );
      renderNetSuitePosting();
    } catch {
      // Keep the current workspace if the follow-up refresh fails.
    }
  } finally {
    state.netsuitePostingSubmitting = false;
    syncNetSuitePostingControls();
  }
}

async function fetchNetSuiteWorkspace(propertySlug, attachmentId = null, reportType = null) {
  const params = new URLSearchParams();
  if (attachmentId) {
    params.set("attachmentId", String(attachmentId));
  }
  if (reportType) {
    params.set("reportType", reportType);
  }

  const query = params.toString();
  const suffix = query ? `?${query}` : "";
  return fetchJson(`/api/netsuite/properties/${encodeURIComponent(propertySlug)}${suffix}`);
}

function collectNetSuitePostingMappings() {
  if (!netsuitePostingMappings) {
    return [];
  }

  return Array.from(netsuitePostingMappings.querySelectorAll("tr[data-netsuite-mapping-key]")).map((row) => {
    const mappingKey = row.getAttribute("data-netsuite-mapping-key") || "";
    const glInput = row.querySelector("input[data-netsuite-gl-code]");
    const polarityInput = row.querySelector("select[data-netsuite-posting-polarity]");
    return {
      mappingKey,
      netsuiteGlCode: glInput instanceof HTMLInputElement ? glInput.value.trim() : "",
      postingPolarity: polarityInput instanceof HTMLSelectElement ? polarityInput.value : "debit_positive"
    };
  });
}

function collectNetSuitePostingDefaults() {
  return {
    externalIdPrefix: netsuitePostingExternalPrefix ? netsuitePostingExternalPrefix.value.trim() : "",
    balancingGlCode: netsuitePostingBalancingGl ? netsuitePostingBalancingGl.value.trim() : "",
    memoTemplate: netsuitePostingMemoTemplate ? netsuitePostingMemoTemplate.value.trim() : "",
    subsidiaryId: netsuitePostingSubsidiaryId ? netsuitePostingSubsidiaryId.value.trim() : "",
    currencyId: netsuitePostingCurrencyId ? netsuitePostingCurrencyId.value.trim() : "",
    locationId: netsuitePostingLocationId ? netsuitePostingLocationId.value.trim() : "",
    departmentId: netsuitePostingDepartmentId ? netsuitePostingDepartmentId.value.trim() : "",
    classId: netsuitePostingClassId ? netsuitePostingClassId.value.trim() : ""
  };
}

function getSelectedNetSuiteRun(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return null;
  }

  return runs.find((run) => run.id === state.netsuitePostingSelectedRunId) || runs[0];
}

function renderPropertyModal() {
  if (!state.selectedProperty || !state.selectedProperty.property) {
    return;
  }

  const property = state.selectedProperty.property;
  propertyModalTitle.textContent = property.property_name || "Unassigned Property";
  propertyModalSubhead.textContent = `Viewing reports archived under ${property.property_slug || "unassigned-property"}.`;
  if (propertyEditorAvailable) {
    propertyNameInput.value = property.property_name || "";
    propertySlugInput.value = property.property_slug || "";
    syncPropertyFormControls();
    propertyFormStatus.textContent = state.propertyFormStatus;
    propertyFormStatus.className = `form-status ${state.propertyFormTone}`;
  }

  const summaryCards = [
    ["Attachments", property.attachment_count],
    ["Parsed", property.parsed_count],
    ["Deferred", property.deferred_count],
    ["Failed", property.failed_count],
    ["Last Received", formatDateTime(property.last_received_at)]
  ];

  propertyModalSummary.innerHTML = summaryCards.map(([label, value]) => `
    <article class="metric-card">
      <div class="metric-value">${escapeHtml(String(value))}</div>
      <div class="metric-label">${escapeHtml(label)}</div>
    </article>
  `).join("");

  const attachments = Array.isArray(state.selectedProperty.attachments) ? state.selectedProperty.attachments : [];
  if (attachments.length === 0) {
    propertyHistoryCaption.textContent = "No report history yet";
    propertyHistoryBrowser.innerHTML = '<div class="empty">No dated report history has been recorded for this property yet.</div>';
    propertyHistorySelection.className = "history-selection empty";
    propertyHistorySelection.textContent = "Run a sync after reports arrive to populate the daily report explorer.";
    propertyModalAttachments.innerHTML = '<div class="empty">No reports have been archived under this property yet.</div>';
    return;
  }

  const history = buildAttachmentHistory(attachments);
  syncHistorySelection(history);
  const selection = getSelectedHistorySelection(history);

  propertyHistoryCaption.textContent = buildHistoryCaption(history);
  propertyHistoryBrowser.innerHTML = renderHistoryBrowser(history, selection);

  if (!selection.day) {
    propertyHistorySelection.className = "history-selection empty";
    propertyHistorySelection.textContent = "Select a day to review the archived reports.";
    propertyModalAttachments.innerHTML = '<div class="empty">No report day is selected.</div>';
    return;
  }

  propertyHistorySelection.className = "history-selection";
  propertyHistorySelection.innerHTML = `
    <div class="history-selection-top">
      <strong>${escapeHtml(formatHistoryHeading(selection.day.key))}</strong>
      <span class="status-chip parsed">${escapeHtml(`${selection.day.attachments.length} reports`)}</span>
    </div>
    <div class="attachment-meta">
      <span>${escapeHtml(selection.year.label)}</span>
      <span>${escapeHtml(selection.month.label)}</span>
      <span>Parsed: ${escapeHtml(String(selection.day.attachments.filter((attachment) => attachment.status === "parsed").length))}</span>
      <span>Deferred/Failed: ${escapeHtml(String(selection.day.attachments.filter((attachment) => attachment.status !== "parsed").length))}</span>
    </div>
  `;

  propertyModalAttachments.innerHTML = selection.day.attachments.map((attachment) => `
    <article class="attachment-card">
      <div class="attachment-top">
        <div>
          <strong>${escapeHtml(attachment.attachment_name || "Unnamed attachment")}</strong>
          <div class="attachment-meta">
            <span>${escapeHtml(attachment.report_title || attachment.report_type || "Deferred attachment")}</span>
            <span>Received: ${escapeHtml(formatDateTime(attachment.received_at))}</span>
          </div>
        </div>
        <span class="status-chip ${slugify(attachment.status)}">${escapeHtml(attachment.status || "unknown")}</span>
      </div>
      <div class="attachment-meta">
        ${attachment.report_date ? `<span>Report date: ${escapeHtml(attachment.report_date)}</span>` : ""}
        ${attachment.quarantine_path ? `<span>Quarantine: <code>${escapeHtml(attachment.quarantine_path)}</code></span>` : ""}
        ${attachment.parse_error ? `<span>Parser note: ${escapeHtml(attachment.parse_error)}</span>` : ""}
      </div>
      <div class="toolbar-row">
        ${attachment.id ? `<a class="export-link" href="/api/attachments/${encodeURIComponent(String(attachment.id))}/file" target="_blank" rel="noreferrer">Open Archived Report</a>` : ""}
        ${attachment.id && attachment.status === "parsed" ? `<a class="export-link" href="/api/attachments/${encodeURIComponent(String(attachment.id))}/parsed-csv">Download Parsed CSV</a>` : ""}
        ${isAdmin() && attachment.id && ["failed", "unsupported"].includes(String(attachment.status || "")) ? `
          <button
            class="secondary"
            type="button"
            data-retry-attachment-id="${escapeHtml(String(attachment.id))}"
            ${Number(attachment.id) === state.retryingAttachmentId ? "disabled" : ""}
          >${Number(attachment.id) === state.retryingAttachmentId ? "Retrying Parse..." : "Retry Parse"}</button>
        ` : ""}
      </div>
    </article>
  `).join("");
}

function setLoading(isLoading, message) {
  state.loading = isLoading;
  syncToolbarButtons();
  if (message && heroStatus) {
    heroStatus.textContent = message;
  }
}

function syncToolbarButtons() {
  const runBusy = state.loading || isRunPolling();
  if (runButton) {
    runButton.disabled = runBusy;
  }
  if (reparseButton) {
    reparseButton.disabled = runBusy;
  }
  if (refreshButton) {
    refreshButton.disabled = state.loading;
  }
}

function isRunPolling() {
  return Number.isInteger(state.activeRunId) && state.activeRunId > 0;
}

function setPropertyFormStatus(message, tone) {
  state.propertyFormStatus = message;
  state.propertyFormTone = tone;
  if (!propertyEditorAvailable) {
    return;
  }

  propertyFormStatus.textContent = message;
  propertyFormStatus.className = `form-status ${tone}`;
}

function syncPropertyFormControls() {
  if (!propertyEditorAvailable) {
    return;
  }

  propertySaveButton.disabled = state.propertySaving || !state.selectedProperty;
  propertyNameInput.disabled = state.propertySaving || !state.selectedProperty;
  propertySlugInput.disabled = state.propertySaving || !state.selectedProperty;
}

function setViewerFormStatus(message, tone) {
  state.viewerFormStatus = message;
  state.viewerFormTone = tone;
  if (!viewerSettingsAvailable) {
    return;
  }

  viewerFormStatus.textContent = message;
  viewerFormStatus.className = `form-status ${tone}`;
}

function setApprovedSenderStatus(message, tone) {
  state.approvedSenderStatus = message;
  state.approvedSenderTone = tone;
  if (!approvedSendersStatus) {
    return;
  }

  approvedSendersStatus.textContent = message;
  approvedSendersStatus.className = `form-status ${tone}`;
}

function syncViewerFormControls() {
  if (!viewerSettingsAvailable) {
    return;
  }

  const disabled = state.viewerSaving || !state.currentUser;
  viewerCreateButton.disabled = disabled;
  viewerUsernameInput.disabled = disabled;
  viewerPasswordInput.disabled = disabled;
}

function syncApprovedSenderFormControls() {
  if (!approvedSendersSaveButton || !approvedSendersInput) {
    return;
  }

  const disabled = state.approvedSenderSaving || !isAdmin();
  approvedSendersSaveButton.disabled = disabled;
  approvedSendersInput.disabled = disabled;
}

function setNetSuiteStatus(message, tone) {
  state.netsuiteStatus = message;
  state.netsuiteTone = tone;
  if (!netsuiteSettingsStatus) {
    return;
  }

  netsuiteSettingsStatus.textContent = message;
  netsuiteSettingsStatus.className = `form-status ${tone}`;
}

function syncNetSuiteFormControls() {
  if (!netsuiteSettingsAvailable) {
    return;
  }

  const settings = state.netsuiteSettings || null;
  const unavailable = !settings || settings.masterKeyConfigured === false;
  const busy = state.netsuiteSaving || state.netsuiteTesting || state.netsuiteCatalogExporting || !isAdmin() || unavailable;

  netsuiteServiceBaseUrlInput.disabled = busy;
  netsuiteClientIdInput.disabled = busy;
  netsuiteCertificateIdInput.disabled = busy;
  netsuiteJwtAlgorithmInput.disabled = busy;
  netsuiteProbeQueryInput.disabled = busy;
  netsuitePrivateKeyInput.disabled = busy;
  netsuiteSaveButton.disabled = busy;
  netsuiteTestButton.disabled = busy || !settings || !settings.hasPrivateKey;
  netsuiteClearKeyButton.disabled = busy || !settings || !settings.hasPrivateKey;
  netsuiteExportCatalogButton.disabled = busy || !settings || !settings.hasPrivateKey;
}

function renderNetSuiteSettings() {
  if (!netsuiteSettingsAvailable) {
    return;
  }

  const settings = state.netsuiteSettings || {
    serviceBaseUrl: "",
    clientId: "",
    certificateId: "",
    jwtAlgorithm: "PS256",
    probeQuery: "SELECT id FROM Account",
    hasPrivateKey: false,
    lastTest: null,
    lastCatalogExport: null,
    masterKeyConfigured: false,
    availabilityError: "NetSuite settings are unavailable.",
    maskedClientId: null,
    maskedCertificateId: null
  };

  if (document.activeElement !== netsuiteServiceBaseUrlInput && !state.netsuiteSaving) {
    netsuiteServiceBaseUrlInput.value = settings.serviceBaseUrl || "";
  }
  if (document.activeElement !== netsuiteClientIdInput && !state.netsuiteSaving) {
    netsuiteClientIdInput.value = settings.clientId || "";
  }
  if (document.activeElement !== netsuiteCertificateIdInput && !state.netsuiteSaving) {
    netsuiteCertificateIdInput.value = settings.certificateId || "";
  }
  if (document.activeElement !== netsuiteJwtAlgorithmInput && !state.netsuiteSaving) {
    netsuiteJwtAlgorithmInput.value = settings.jwtAlgorithm || "PS256";
  }
  if (document.activeElement !== netsuiteProbeQueryInput && !state.netsuiteSaving) {
    netsuiteProbeQueryInput.value = settings.probeQuery || "SELECT id FROM Account";
  }
  if (!state.netsuiteSaving && !state.netsuiteTesting) {
    netsuitePrivateKeyInput.value = "";
  }

  const keySummary = [];
  if (settings.hasPrivateKey) {
    keySummary.push("An encrypted private key is saved on the server.");
  } else {
    keySummary.push("No private key is saved yet.");
  }
  if (settings.maskedClientId) {
    keySummary.push(`Client ID ${settings.maskedClientId}.`);
  }
  if (settings.maskedCertificateId) {
    keySummary.push(`Certificate ID ${settings.maskedCertificateId}.`);
  }
  if (!settings.masterKeyConfigured && settings.availabilityError) {
    netsuiteKeyStatus.textContent = settings.availabilityError;
    netsuiteKeyStatus.className = "form-status error";
  } else {
    netsuiteKeyStatus.textContent = keySummary.join(" ");
    netsuiteKeyStatus.className = `form-status ${settings.hasPrivateKey ? "success" : "empty"}`;
  }

  netsuiteSettingsStatus.textContent = state.netsuiteStatus;
  netsuiteSettingsStatus.className = `form-status ${state.netsuiteTone}`;
  renderNetSuiteLastTest(settings.lastTest);
  renderNetSuiteCatalogExport(settings.lastCatalogExport);
  syncNetSuiteFormControls();
}

function renderNetSuiteLastTest(lastTest) {
  if (!netsuiteLastTest) {
    return;
  }

  if (!lastTest) {
    netsuiteLastTest.textContent = "No NetSuite proof-of-life checks have been recorded yet.";
    netsuiteLastTest.className = "form-status empty";
    return;
  }

  const summary = [
    `Checked ${formatDateTime(lastTest.checkedAt)}`,
    `Duration ${escapeHtml(String(lastTest.durationMs || 0))} ms`
  ];
  if (lastTest.httpStatus) {
    summary.push(`HTTP ${escapeHtml(String(lastTest.httpStatus))}`);
  }
  if (typeof lastTest.count === "number") {
    summary.push(`Count ${escapeHtml(String(lastTest.count))}`);
  }
  if (typeof lastTest.totalResults === "number") {
    summary.push(`Total ${escapeHtml(String(lastTest.totalResults))}`);
  }

  const detailRows = [];
  if (Array.isArray(lastTest.columnNames) && lastTest.columnNames.length > 0) {
    detailRows.push(`<span>Columns: ${escapeHtml(lastTest.columnNames.join(", "))}</span>`);
  }
  if (lastTest.errorCode) {
    detailRows.push(`<span>Error code: ${escapeHtml(lastTest.errorCode)}</span>`);
  }
  if (lastTest.errorMessage) {
    detailRows.push(`<span>${escapeHtml(lastTest.errorMessage)}</span>`);
  }

  netsuiteLastTest.className = `form-status ${lastTest.status === "success" ? "success" : "error"}`;
  netsuiteLastTest.innerHTML = `
    <strong>${lastTest.status === "success" ? "NetSuite connection is live." : "NetSuite connection test failed."}</strong>
    <div class="attachment-meta">
      ${summary.map((item) => `<span>${item}</span>`).join("")}
      ${detailRows.join("")}
    </div>
  `;
}

function renderNetSuiteCatalogExport(lastCatalogExport) {
  if (!netsuiteLastCatalogExport || !netsuiteCatalogDownloadLink) {
    return;
  }

  if (!lastCatalogExport) {
    netsuiteLastCatalogExport.textContent = "No NetSuite metadata catalog exports have been recorded yet.";
    netsuiteLastCatalogExport.className = "form-status empty";
    netsuiteCatalogDownloadLink.hidden = true;
    netsuiteCatalogDownloadLink.download = "";
    return;
  }

  const summary = [
    `Checked ${formatDateTime(lastCatalogExport.checkedAt)}`,
    `Duration ${escapeHtml(String(lastCatalogExport.durationMs || 0))} ms`
  ];
  if (lastCatalogExport.httpStatus) {
    summary.push(`HTTP ${escapeHtml(String(lastCatalogExport.httpStatus))}`);
  }
  if (typeof lastCatalogExport.rowCount === "number") {
    summary.push(`Rows ${escapeHtml(String(lastCatalogExport.rowCount))}`);
  }
  if (typeof lastCatalogExport.schemaFileCount === "number") {
    summary.push(`Schemas ${escapeHtml(String(lastCatalogExport.schemaFileCount))}`);
  }

  const detailRows = [];
  if (lastCatalogExport.fileName) {
    detailRows.push(`<span>Latest CSV: ${escapeHtml(lastCatalogExport.fileName)}</span>`);
  }
  if (lastCatalogExport.schemaDirectory) {
    detailRows.push(`<span>Schema directory: ${escapeHtml(lastCatalogExport.schemaDirectory)}</span>`);
  }
  if (lastCatalogExport.errorCode) {
    detailRows.push(`<span>Error code: ${escapeHtml(lastCatalogExport.errorCode)}</span>`);
  }
  if (lastCatalogExport.errorMessage) {
    detailRows.push(`<span>${escapeHtml(lastCatalogExport.errorMessage)}</span>`);
  }

  netsuiteLastCatalogExport.className = `form-status ${lastCatalogExport.status === "success" ? "success" : "error"}`;
  netsuiteLastCatalogExport.innerHTML = `
    <strong>${lastCatalogExport.status === "success" ? "NetSuite metadata catalog export is ready." : "NetSuite metadata catalog export failed."}</strong>
    <div class="attachment-meta">
      ${summary.map((item) => `<span>${item}</span>`).join("")}
      ${detailRows.join("")}
    </div>
  `;

  const hasDownload = Boolean(lastCatalogExport.fileName);
  netsuiteCatalogDownloadLink.hidden = !hasDownload;
  netsuiteCatalogDownloadLink.download = hasDownload ? lastCatalogExport.fileName : "";
}

async function saveNetSuiteSettings(clearPrivateKey) {
  if (!isAdmin() || !netsuiteSettingsAvailable) {
    return;
  }

  state.netsuiteSaving = true;
  syncNetSuiteFormControls();
  setNetSuiteStatus(clearPrivateKey ? "Clearing saved NetSuite private key..." : "Saving NetSuite connector settings...", "empty");

  try {
    const result = await fetchJson("/api/settings/netsuite", {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        serviceBaseUrl: netsuiteServiceBaseUrlInput.value.trim(),
        clientId: netsuiteClientIdInput.value.trim(),
        certificateId: netsuiteCertificateIdInput.value.trim(),
        jwtAlgorithm: netsuiteJwtAlgorithmInput.value,
        probeQuery: netsuiteProbeQueryInput.value.trim(),
        privateKeyPem: clearPrivateKey ? "" : netsuitePrivateKeyInput.value,
        clearPrivateKey
      })
    });

    state.netsuiteSettings = result;
    netsuitePrivateKeyInput.value = "";
    setNetSuiteStatus(
      clearPrivateKey
        ? "Saved NetSuite settings and cleared the encrypted private key."
        : "NetSuite connector settings saved.",
      "success"
    );
    renderNetSuiteSettings();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setNetSuiteStatus(message, "error");
  } finally {
    state.netsuiteSaving = false;
    syncNetSuiteFormControls();
  }
}

async function testNetSuiteConnection() {
  if (!isAdmin() || !netsuiteSettingsAvailable) {
    return;
  }

  state.netsuiteTesting = true;
  syncNetSuiteFormControls();
  setNetSuiteStatus("Running the NetSuite proof-of-life query...", "empty");

  try {
    const result = await fetchJson("/api/settings/netsuite/test", {
      method: "POST"
    });
    if (state.netsuiteSettings) {
      state.netsuiteSettings.lastTest = result.lastTest || null;
    }
    renderNetSuiteSettings();
    setNetSuiteStatus(
      result.lastTest && result.lastTest.status === "success"
        ? "NetSuite connection test succeeded."
        : "NetSuite connection test completed with an error response.",
      result.lastTest && result.lastTest.status === "success" ? "success" : "error"
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setNetSuiteStatus(message, "error");
  } finally {
    state.netsuiteTesting = false;
    syncNetSuiteFormControls();
  }
}

async function exportNetSuiteMetadataCatalog() {
  if (!isAdmin() || !netsuiteSettingsAvailable) {
    return;
  }

  state.netsuiteCatalogExporting = true;
  syncNetSuiteFormControls();
  setNetSuiteStatus("Exporting the NetSuite metadata catalog and full record schemas...", "empty");

  try {
    const result = await fetchJson("/api/settings/netsuite/debug/metadata-catalog/export", {
      method: "POST"
    });
    if (state.netsuiteSettings) {
      state.netsuiteSettings.lastCatalogExport = result.lastCatalogExport || null;
    }
    renderNetSuiteSettings();
    setNetSuiteStatus(
      result.lastCatalogExport && result.lastCatalogExport.status === "success"
        ? "NetSuite metadata catalog export succeeded."
        : "NetSuite metadata catalog export completed with an error response.",
      result.lastCatalogExport && result.lastCatalogExport.status === "success" ? "success" : "error"
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setNetSuiteStatus(message, "error");
  } finally {
    state.netsuiteCatalogExporting = false;
    syncNetSuiteFormControls();
  }
}

async function saveApprovedSenders() {
  if (!isAdmin() || !approvedSendersInput) {
    return;
  }

  const patterns = approvedSendersInput.value
    .split(/\n/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  state.approvedSenderSaving = true;
  syncApprovedSenderFormControls();
  setApprovedSenderStatus("Saving sender allowlist...", "empty");

  try {
    const result = await fetchJson("/api/settings/approved-senders", {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ patterns })
    });

    state.approvedSenderPatterns = Array.isArray(result.patterns) ? result.patterns : [];
    state.approvedSenderSource = "database";
    approvedSendersInput.value = state.approvedSenderPatterns.join("\n");
    setApprovedSenderStatus(
      state.approvedSenderPatterns.length > 0
        ? `Saved ${state.approvedSenderPatterns.length} approved sender pattern(s).`
        : "Allowlist is now empty. All senders will be accepted.",
      "success"
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setApprovedSenderStatus(message, "error");
  } finally {
    state.approvedSenderSaving = false;
    syncApprovedSenderFormControls();
  }
}

async function createViewerUser() {
  if (!viewerSettingsAvailable || !state.currentUser) {
    return;
  }

  const username = viewerUsernameInput.value.trim();
  const password = viewerPasswordInput.value;

  state.viewerSaving = true;
  syncViewerFormControls();
  setViewerFormStatus("Creating user account...", "empty");

  try {
    await fetchJson("/api/users", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ username, password })
    });

    viewerUserForm.reset();
    setViewerFormStatus(`User ${username} created with full access.`, "success");
    await refreshDashboard(`User ${username} created with full access.`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setViewerFormStatus(message, "error");
  } finally {
    state.viewerSaving = false;
    syncViewerFormControls();
  }
}

async function changeUserPassword(userId, password) {
  if (!canManageUserPassword(userId) || state.userPasswordSavingId === userId) {
    return;
  }

  const targetUser = Array.isArray(state.users)
    ? state.users.find((user) => Number(user.id) === userId) ?? null
    : null;
  const username = targetUser && targetUser.username ? targetUser.username : `user ${userId}`;

  state.userPasswordSavingId = userId;
  setViewerFormStatus(`Updating password for ${username}...`, "empty");
  renderSettings();

  try {
    await fetchJson(`/api/users/${encodeURIComponent(String(userId))}/password`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ password })
    });

    setViewerFormStatus(`Password updated for ${username}.`, "success");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setViewerFormStatus(message, "error");
  } finally {
    state.userPasswordSavingId = null;
    renderSettings();
  }
}

async function deleteViewerUser(userId) {
  if (!state.currentUser || state.viewerDeletingUserId === userId) {
    return;
  }

  state.viewerDeletingUserId = userId;
  renderSettings();

  try {
    await fetchJson(`/api/users/${encodeURIComponent(String(userId))}`, {
      method: "DELETE"
    });

    setViewerFormStatus("User removed.", "success");
    await refreshDashboard("User removed.");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    setViewerFormStatus(message, "error");
  } finally {
    state.viewerDeletingUserId = null;
    renderSettings();
  }
}

function syncCurrentPageFromHash() {
  const hashPage = normalizePage(window.location.hash.replace(/^#/, ""));
  setCurrentPage(hashPage, { replaceHash: !window.location.hash });
}

function setCurrentPage(page, options = {}) {
  const nextPage = normalizePage(page);
  state.currentPage = nextPage;

  const targetHash = `#${nextPage}`;
  if (options.updateHash && window.location.hash !== targetHash) {
    window.location.hash = targetHash;
  } else if (options.replaceHash && window.location.hash !== targetHash) {
    window.history.replaceState(null, "", targetHash);
  }

  renderNavigation();
}

function normalizePage(page) {
  if (page === "latest-run") {
    return "overview";
  }

  if (page === "scope") {
    return "users";
  }

  return PAGE_IDS.includes(page) ? page : "overview";
}

function isAdmin() {
  // Roles are still stored for bootstrap safety, but the current console grants
  // the same full access to every authenticated user.
  return Boolean(state.currentUser);
}

function isPrimaryAdmin() {
  return Boolean(state.currentUser && state.currentUser.role === "admin");
}

function canManageUserPassword(userId) {
  return Boolean(
    state.currentUser
    && (isPrimaryAdmin() || Number(state.currentUser.id) === Number(userId))
  );
}

function isPageAllowed(page) {
  if (page === "settings" || page === "netsuite") {
    return isAdmin();
  }

  return true;
}

function renderError(error) {
  const message = error && error.message ? error.message : String(error);
  if (heroStatus) {
    heroStatus.textContent = `Request failed: ${message}`;
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(options && options.headers ? options.headers : {})
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    if (payload && typeof payload === "object") {
      Object.assign(error, payload);
    }
    throw error;
  }

  return payload;
}

function getRunDisplayName(run) {
  const triggerSource = run && typeof run.trigger_source === "string" ? run.trigger_source : "";
  if (triggerSource === "reparse") {
    return "Stored Report Reparse";
  }
  if (triggerSource === "scheduled") {
    return "Scheduled Mailbox Scan";
  }
  if (triggerSource === "test") {
    return "Test Run";
  }
  return "Mailbox Scan";
}

function getRunPollingMessage(run, runId) {
  if (run && run.trigger_source === "reparse") {
    return `Stored report reparse is running in the background. Polling run #${runId}.`;
  }
  return `Mailbox scan is running in the background. Polling run #${runId}.`;
}

function getRunCompletionMessage(run, runId) {
  if (run && run.trigger_source === "reparse") {
    return `Stored report reparse completed. Run #${runId} rebuilt the local staging data.`;
  }
  return `Mailbox scan completed. Run #${runId} finished successfully.`;
}

function getRunFailureMessage(run, runId) {
  if (run && run.trigger_source === "reparse") {
    return `Stored report reparse finished with failures. Run #${runId}.`;
  }
  return `Mailbox scan finished with failures. Run #${runId}.`;
}

function getRunPendingNotesMessage(run) {
  if (run && run.trigger_source === "reparse") {
    return "Run is still in progress. Parsed, deferred, and failed counts update live while stored files are reparsed.";
  }
  return "Run is still in progress. Approved, not approved, and deferred counts update live while the mailbox scan is running.";
}

function getRunPendingAttachmentMessage(run) {
  if (run && run.trigger_source === "reparse") {
    return "Attachment details will load after the stored report reparse finishes.";
  }
  return "Attachment details will load after the live mailbox scan finishes.";
}

function getRunTone(status) {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  return "running";
}

function formatDateTime(value) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildAttachmentHistory(attachments) {
  const years = new Map();

  for (const attachment of attachments) {
    const dayKey = getAttachmentHistoryDay(attachment);
    if (!dayKey) {
      continue;
    }

    const yearKey = dayKey.slice(0, 4);
    const monthKey = dayKey.slice(0, 7);
    if (!years.has(yearKey)) {
      years.set(yearKey, {
        key: yearKey,
        label: yearKey,
        months: new Map()
      });
    }

    const yearNode = years.get(yearKey);
    if (!yearNode.months.has(monthKey)) {
      yearNode.months.set(monthKey, {
        key: monthKey,
        label: formatHistoryMonth(monthKey),
        sortKey: monthKey,
        days: new Map()
      });
    }

    const monthNode = yearNode.months.get(monthKey);
    if (!monthNode.days.has(dayKey)) {
      monthNode.days.set(dayKey, {
        key: dayKey,
        label: formatHistoryDay(dayKey),
        attachments: []
      });
    }

    monthNode.days.get(dayKey).attachments.push(attachment);
  }

  return {
    years: Array.from(years.values())
      .sort((left, right) => right.key.localeCompare(left.key))
      .map((yearNode) => ({
        key: yearNode.key,
        label: yearNode.label,
        months: Array.from(yearNode.months.values())
          .sort((left, right) => right.sortKey.localeCompare(left.sortKey))
          .map((monthNode) => ({
            key: monthNode.key,
            label: monthNode.label,
            days: Array.from(monthNode.days.values())
              .sort((left, right) => right.key.localeCompare(left.key))
              .map((dayNode) => ({
                key: dayNode.key,
                label: dayNode.label,
                attachments: dayNode.attachments.sort((left, right) => {
                  const leftTime = new Date(left.received_at || 0).getTime();
                  const rightTime = new Date(right.received_at || 0).getTime();
                  if (leftTime !== rightTime) {
                    return rightTime - leftTime;
                  }
                  return String(right.id || "").localeCompare(String(left.id || ""));
                })
              }))
          }))
      }))
  };
}

function syncHistorySelection(history) {
  if (!history.years.length) {
    state.selectedHistoryYear = null;
    state.selectedHistoryMonth = null;
    state.selectedHistoryDay = null;
    state.historyTreeInteracted = false;
    return;
  }

  const selectedYear = state.selectedHistoryYear
    ? history.years.find((year) => year.key === state.selectedHistoryYear) || history.years[0]
    : (state.historyTreeInteracted ? null : history.years[0]);
  state.selectedHistoryYear = selectedYear ? selectedYear.key : null;

  const selectedMonth = selectedYear
    ? (
      state.selectedHistoryMonth
        ? selectedYear.months.find((month) => month.key === state.selectedHistoryMonth) || selectedYear.months[0] || null
        : (state.historyTreeInteracted ? null : selectedYear.months[0] || null)
    )
    : null;
  state.selectedHistoryMonth = selectedMonth ? selectedMonth.key : null;

  const selectedDay = selectedMonth && (
    state.selectedHistoryDay
      ? selectedMonth.days.find((day) => day.key === state.selectedHistoryDay) || selectedMonth.days[0] || null
      : (state.historyTreeInteracted ? null : selectedMonth.days[0] || null)
  );
  state.selectedHistoryDay = selectedDay ? selectedDay.key : null;
}

function getSelectedHistorySelection(history) {
  const year = history.years.find((entry) => entry.key === state.selectedHistoryYear) || null;
  const month = year ? year.months.find((entry) => entry.key === state.selectedHistoryMonth) || null : null;
  const day = month ? month.days.find((entry) => entry.key === state.selectedHistoryDay) || null : null;
  return { year, month, day };
}

function renderHistoryBrowser(history, selection) {
  const years = history.years.map((year) => {
    const isYearOpen = Boolean(selection.year && selection.year.key === year.key);
    const months = isYearOpen
      ? year.months.map((month) => {
        const isMonthOpen = Boolean(selection.month && selection.month.key === month.key);
        const days = isMonthOpen
          ? month.days.map((day) => renderHistoryNode({
            level: "day",
            key: day.key,
            label: day.label,
            count: day.attachments.length,
            selected: Boolean(selection.day && selection.day.key === day.key),
            expanded: false,
            kind: "item"
          })).join("")
          : "";

        return `
          <div class="history-branch">
            ${renderHistoryNode({
              level: "month",
              key: month.key,
              label: month.label,
              count: month.days.length,
              selected: isMonthOpen,
              expanded: isMonthOpen,
              kind: "branch"
            })}
            ${days ? `<div class="history-children">${days}</div>` : ""}
          </div>
        `;
      }).join("")
      : "";

    return `
      <div class="history-branch">
        ${renderHistoryNode({
          level: "year",
          key: year.key,
          label: year.label,
          count: year.months.reduce((total, month) => total + month.days.length, 0),
          selected: isYearOpen,
          expanded: isYearOpen,
          kind: "branch"
        })}
        ${months ? `<div class="history-children">${months}</div>` : ""}
      </div>
    `;
  }).join("");

  return `
    <div class="history-tree">
      <div class="history-column-head">Historical Reports</div>
      <div class="history-node-list">${years || '<div class="empty">No years yet.</div>'}</div>
    </div>
  `;
}

function renderHistoryNode({ level, key, label, count, selected, expanded, kind }) {
  const marker = kind === "branch" ? (expanded ? "−" : "+") : "";
  return `
    <button
      class="history-node ${kind === "branch" ? "branch-node" : "leaf-node"}${selected ? " selected" : ""}"
      type="button"
      data-history-level="${escapeHtml(level)}"
      data-history-key="${escapeHtml(key)}"
    >
      <span class="history-node-main">
        ${marker ? `<span class="history-node-marker" aria-hidden="true">${escapeHtml(marker)}</span>` : ""}
        <span class="history-node-label">${escapeHtml(label)}</span>
      </span>
      <span class="history-node-count">${escapeHtml(String(count))}</span>
    </button>
  `;
}

function updateHistorySelection(level, key) {
  if (!level || !key) {
    return;
  }

  state.historyTreeInteracted = true;

  if (level === "year") {
    if (state.selectedHistoryYear === key) {
      state.selectedHistoryYear = null;
      state.selectedHistoryMonth = null;
      state.selectedHistoryDay = null;
      return;
    }

    state.selectedHistoryYear = key;
    state.selectedHistoryMonth = null;
    state.selectedHistoryDay = null;
    return;
  }

  if (level === "month") {
    if (state.selectedHistoryMonth === key) {
      state.selectedHistoryMonth = null;
      state.selectedHistoryDay = null;
      return;
    }

    state.selectedHistoryMonth = key;
    state.selectedHistoryDay = null;
    return;
  }

  if (level === "day") {
    state.selectedHistoryDay = key;
  }
}

async function retryAttachmentParse(attachmentId) {
  if (!state.selectedProperty || !state.selectedProperty.property) {
    return;
  }

  if (state.retryingAttachmentId === attachmentId) {
    return;
  }

  state.retryingAttachmentId = attachmentId;
  heroStatus.textContent = `Retrying parse for attachment #${attachmentId}.`;
  renderPropertyModal();

  try {
    const result = await fetchJson(`/api/attachments/${encodeURIComponent(String(attachmentId))}/retry-parse`, {
      method: "POST"
    });

    if (result.propertyPayload) {
      state.selectedProperty = result.propertyPayload;
    }

    await refreshDashboard(result.message || `Attachment #${attachmentId} retry finished.`);
  } catch (error) {
    renderError(error);
  } finally {
    state.retryingAttachmentId = null;
    renderPropertyModal();
  }
}

function buildHistoryCaption(history) {
  const monthCount = history.years.reduce((total, year) => total + year.months.length, 0);
  const dayCount = history.years.reduce(
    (total, year) => total + year.months.reduce((monthTotal, month) => monthTotal + month.days.length, 0),
    0
  );
  return `${history.years.length} years | ${monthCount} months | ${dayCount} days`;
}

function getAttachmentHistoryDay(attachment) {
  return normalizeHistoryDay(attachment.report_date) || normalizeHistoryDay(attachment.received_at);
}

function normalizeHistoryDay(value) {
  if (!value) {
    return null;
  }

  const exactMatch = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (exactMatch) {
    return exactMatch[0];
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function formatHistoryMonth(monthKey) {
  const date = new Date(`${monthKey}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function formatHistoryDay(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function formatHistoryHeading(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}
