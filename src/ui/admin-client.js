const state = {
  dashboard: null,
  latestRun: null,
  selectedProperty: null,
  selectedHistoryYear: null,
  selectedHistoryMonth: null,
  selectedHistoryDay: null,
  historyTreeInteracted: false,
  retryingAttachmentId: null,
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
  state.selectedHistoryYear = null;
  state.selectedHistoryMonth = null;
  state.selectedHistoryDay = null;
  state.historyTreeInteracted = false;
  propertyModalTitle.textContent = "Loading property...";
  propertyModalSubhead.textContent = "Fetching reports and export details.";
  propertyModalSummary.innerHTML = "";
  propertyNameInput.value = "";
  propertySlugInput.value = "";
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
        ${attachment.id && ["failed", "unsupported"].includes(String(attachment.status || "")) ? `
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
