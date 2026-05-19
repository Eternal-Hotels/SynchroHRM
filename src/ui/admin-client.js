const state = {
  dashboard: null,
  latestRun: null,
  selectedProperty: null,
  propertySaving: false,
  propertyFormStatus: "No pending edits.",
  propertyFormTone: "empty",
  loading: false
};

const heroStatus = document.getElementById("hero-status");
const refreshButton = document.getElementById("refresh-button");
const runButton = document.getElementById("run-button");
const overviewStamp = document.getElementById("overview-stamp");
const overviewGrid = document.getElementById("overview-grid");
const propertyList = document.getElementById("property-list");
const latestRunBadge = document.getElementById("latest-run-badge");
const runSummaryGrid = document.getElementById("run-summary-grid");
const runNotes = document.getElementById("run-notes");
const attachmentList = document.getElementById("attachment-list");
const exportList = document.getElementById("export-list");
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
const propertyModalExports = document.getElementById("property-modal-exports");
const propertyModalAttachments = document.getElementById("property-modal-attachments");

refreshButton.addEventListener("click", () => {
  void refreshDashboard("Dashboard refreshed.");
});

runButton.addEventListener("click", () => {
  void triggerRun();
});

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

propertyModal.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-close-modal='1']") : null;
  if (target) {
    closePropertyModal();
  }
});

propertyModalClose.addEventListener("click", () => {
  closePropertyModal();
});

propertyEditForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void savePropertyEdits();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !propertyModal.classList.contains("hidden")) {
    closePropertyModal();
  }
});

void refreshDashboard("Loading dashboard...");

async function triggerRun() {
  setLoading(true, "Running mailbox sync. This can take a moment if new attachments arrived.");

  try {
    const result = await fetchJson("/api/ingest/run", { method: "POST" });
    const statusLabel = result.status === "completed"
      ? `Mailbox sync completed. Run #${result.runId} finished successfully.`
      : `Mailbox sync finished with failures. Run #${result.runId}.`;

    await refreshDashboard(statusLabel);
  } catch (error) {
    renderError(error);
  } finally {
    setLoading(false);
  }
}

async function refreshDashboard(statusMessage) {
  setLoading(true, statusMessage);

  try {
    state.dashboard = await fetchJson("/api/dashboard");

    if (state.dashboard.latestRun && Number.isInteger(state.dashboard.latestRun.id)) {
      state.latestRun = await fetchJson("/api/runs/latest");
    } else {
      state.latestRun = null;
    }

    if (state.selectedProperty && state.selectedProperty.property && state.selectedProperty.property.property_slug) {
      state.selectedProperty = await fetchJson(`/api/properties/${encodeURIComponent(state.selectedProperty.property.property_slug)}`);
      showPropertyModal();
    }

    render();
  } catch (error) {
    renderError(error);
  } finally {
    setLoading(false);
  }
}

async function openPropertyModal(propertySlug) {
  propertyModalTitle.textContent = "Loading property...";
  propertyModalSubhead.textContent = "Fetching reports and export details.";
  propertyModalSummary.innerHTML = "";
  propertyNameInput.value = "";
  propertySlugInput.value = "";
  setPropertyFormStatus("Loading property details...", "empty");
  propertyModalExports.innerHTML = "";
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
  if (!state.selectedProperty || !state.selectedProperty.property) {
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
  propertyModal.classList.add("hidden");
  propertyModal.setAttribute("aria-hidden", "true");
}

function showPropertyModal() {
  propertyModal.classList.remove("hidden");
  propertyModal.setAttribute("aria-hidden", "false");
}

function render() {
  renderOverview();
  renderProperties();
  renderLatestRun();
  renderExports();
  renderPropertyModal();
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
  latestRunBadge.className = `badge ${state.latestRun.status === "completed" ? "success" : "danger"}`;

  const summaryCards = [
    ["Messages Seen", state.latestRun.messages_seen],
    ["Attachments Seen", state.latestRun.attachments_seen],
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
  } else {
    runNotes.className = "notes-block empty";
    runNotes.textContent = "No warnings or notes were recorded for the latest run.";
  }

  const attachments = Array.isArray(state.latestRun.attachments) ? state.latestRun.attachments : [];
  if (attachments.length === 0) {
    attachmentList.innerHTML = '<div class="empty">No attachment records were captured for the latest run.</div>';
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

function renderExports() {
  if (!state.dashboard) {
    exportList.innerHTML = "";
    return;
  }

  exportList.innerHTML = state.dashboard.reports.map((report) => {
    const latest = report.latestExport;
    const downloadHref = latest ? `/api/exports/${encodeURIComponent(report.reportType)}/latest?download=1` : "";

    return `
      <article class="export-card">
        <div class="export-top">
          <div>
            <strong>${escapeHtml(report.title)}</strong>
            <div class="export-meta">
              <span><code>${escapeHtml(report.reportType)}</code></span>
              <span>${latest ? `Latest rows: ${escapeHtml(String(latest.row_count))}` : "No CSV generated yet"}</span>
              <span>${latest ? `Updated: ${escapeHtml(formatDateTime(latest.created_at))}` : "Run a sync to generate the first export."}</span>
            </div>
          </div>
          ${latest ? `<span class="status-chip parsed">ready</span>` : `<span class="status-chip deferred">pending</span>`}
        </div>
        <div class="toolbar-row">
          ${latest ? `<a class="export-link" href="${downloadHref}">Download Latest CSV</a>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

function renderPropertyModal() {
  if (!state.selectedProperty || !state.selectedProperty.property) {
    return;
  }

  const property = state.selectedProperty.property;
  propertyModalTitle.textContent = property.property_name || "Unassigned Property";
  propertyModalSubhead.textContent = `Viewing reports archived under ${property.property_slug || "unassigned-property"}.`;
  propertyNameInput.value = property.property_name || "";
  propertySlugInput.value = property.property_slug || "";
  syncPropertyFormControls();
  propertyFormStatus.textContent = state.propertyFormStatus;
  propertyFormStatus.className = `form-status ${state.propertyFormTone}`;

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

  const reports = Array.isArray(state.selectedProperty.reports) ? state.selectedProperty.reports : [];
  propertyModalExports.innerHTML = reports.map((report) => {
    const latest = report.latestExport;
    const href = latest
      ? `/api/properties/${encodeURIComponent(property.property_slug)}/exports/${encodeURIComponent(report.reportType)}/latest?download=1`
      : "";

    return `
      <article class="export-card">
        <div class="export-top">
          <div>
            <strong>${escapeHtml(report.title)}</strong>
            <div class="export-meta">
              <span><code>${escapeHtml(report.reportType)}</code></span>
              <span>Attachments: ${escapeHtml(String(report.attachmentCount || 0))}</span>
              <span>${latest ? `Rows: ${escapeHtml(String(latest.row_count))}` : "No property CSV yet"}</span>
            </div>
          </div>
          ${latest ? `<span class="status-chip parsed">ready</span>` : `<span class="status-chip deferred">pending</span>`}
        </div>
        <div class="toolbar-row">
          ${latest ? `<a class="export-link" href="${href}">Download Property CSV</a>` : ""}
        </div>
      </article>
    `;
  }).join("");

  const attachments = Array.isArray(state.selectedProperty.attachments) ? state.selectedProperty.attachments : [];
  if (attachments.length === 0) {
    propertyModalAttachments.innerHTML = '<div class="empty">No reports have been archived under this property yet.</div>';
    return;
  }

  propertyModalAttachments.innerHTML = attachments.map((attachment) => `
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
        ${attachment.archived_path ? `<span>Archived at: <code>${escapeHtml(attachment.archived_path)}</code></span>` : ""}
        ${attachment.parsed_json_path ? `<span>Parsed JSON: <code>${escapeHtml(attachment.parsed_json_path)}</code></span>` : ""}
        ${attachment.quarantine_path ? `<span>Quarantine: <code>${escapeHtml(attachment.quarantine_path)}</code></span>` : ""}
        ${attachment.parse_error ? `<span>Parser note: ${escapeHtml(attachment.parse_error)}</span>` : ""}
      </div>
    </article>
  `).join("");
}

function setLoading(isLoading, message) {
  state.loading = isLoading;
  runButton.disabled = isLoading;
  refreshButton.disabled = isLoading;
  if (message) {
    heroStatus.textContent = message;
  }
}

function setPropertyFormStatus(message, tone) {
  state.propertyFormStatus = message;
  state.propertyFormTone = tone;
  propertyFormStatus.textContent = message;
  propertyFormStatus.className = `form-status ${tone}`;
}

function syncPropertyFormControls() {
  propertySaveButton.disabled = state.propertySaving || !state.selectedProperty;
  propertyNameInput.disabled = state.propertySaving || !state.selectedProperty;
  propertySlugInput.disabled = state.propertySaving || !state.selectedProperty;
}

function renderError(error) {
  const message = error && error.message ? error.message : String(error);
  heroStatus.textContent = `Request failed: ${message}`;
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
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
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
