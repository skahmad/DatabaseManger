const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PREFS_KEY = "forge-dbmanager-prefs";
const THEMES = ["teal", "ocean", "ember", "violet", "slate", "light"];
const DENSITIES = ["comfortable", "compact"];
const ZOOM_LEVELS = [75, 90, 100, 110, 125, 150];
const SQL_EDITOR_ZOOM_LEVELS = [70, 80, 90, 100, 110, 125, 150, 175, 200];
const SQL_EDITOR_BASE_REM = 0.82;

const state = {
  profiles: [],
  selectedProfileId: null,
  pendingProfile: null,
  editingProfileId: null,
  dbTypes: [],
  connected: false,
  session: null,
  tree: {},
  currentSchema: null,
  currentTable: null,
  columns: [],
  result: null,
  page: 1,
  pageSize: 1000,
  contextDb: null,
  contextTarget: null,
  expandedProfileIds: {},
  pendingExpandProfileId: null,
  connectedIds: {},
  activeConnectionId: null,
  detailFocus: { scope: "connection", schema: null, table: null, database: null },
  currentTab: "details",
  importPicked: null,
  /** Last loaded/saved SQL file name for the editor. */
  sqlFileName: null,
  /** Absolute path when loaded/saved via desktop bridge. */
  sqlFilePath: null,
  /** Bumped to invalidate in-flight applyWorkspaceTab / refreshSqlContextUi work. */
  workspaceApplyEpoch: 0,
  /** SQL editor find: current match index among matches. */
  sqlFindIndex: -1,
  /** Output log find: current match index. */
  sqlLogFindIndex: -1,
  sqlLogEntries: [],
  /** Cached schema objects for SQL autocomplete / highlighting. */
  sqlMeta: {
    key: "",
    tables: [],
    views: [],
    columnsByTable: {},
    loading: false,
    ready: false,
  },
  sqlSuggest: {
    open: false,
    items: [],
    index: 0,
    start: 0,
    end: 0,
  },
  /** Workspace tabs: DB/SCH context tab (transient) + closable table tabs. */
  workspaceTabs: [],
  activeWorkspaceTabId: null,
  /** Column names hidden in the Data grid (for current result). */
  hiddenColumns: {},
  /** Per-column filters: { [col]: { op, value } } */
  columnFilters: {},
  /** Column name currently shown in the filter popup. */
  filterPopupColumn: null,
};

const COLUMN_FILTER_OPS = [
  { id: "contains", label: "contains", needsValue: true },
  { id: "not_contains", label: "does not contain", needsValue: true },
  { id: "eq", label: "equals", needsValue: true },
  { id: "neq", label: "not equal", needsValue: true },
  { id: "starts", label: "starts with", needsValue: true },
  { id: "ends", label: "ends with", needsValue: true },
  { id: "gt", label: "greater than", needsValue: true },
  { id: "gte", label: "≥", needsValue: true },
  { id: "lt", label: "less than", needsValue: true },
  { id: "lte", label: "≤", needsValue: true },
  { id: "empty", label: "is empty", needsValue: false },
  { id: "not_empty", label: "is not empty", needsValue: false },
  { id: "null", label: "is null", needsValue: false },
  { id: "not_null", label: "is not null", needsValue: false },
];

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  // Prefer explicit connection from query; also send header for nested/admin calls.
  const q = path.match(/[?&]connectionId=([^&]+)/);
  if (q) {
    headers["X-Connection-Id"] = decodeURIComponent(q[1]);
  } else if (options.connectionId) {
    headers["X-Connection-Id"] = options.connectionId;
  } else if (state.activeConnectionId) {
    headers["X-Connection-Id"] = state.activeConnectionId;
  }
  const { connectionId: _cid, headers: _h, ...rest } = options;
  const res = await fetch(path, {
    headers,
    ...rest,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}

function setStatus(msg) {
  $("#status").textContent = msg;
}

function showError(el, msg) {
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function setConnectedUi(connected) {
  const pill = $("#conn-pill");
  const count = Object.keys(state.connectedIds || {}).length;
  const any = connected || count > 0;
  pill.textContent = any ? (count > 1 ? `${count} connected` : "connected") : "offline";
  pill.classList.toggle("idle", !any);
  if (!any) {
    state.currentSchema = null;
    state.currentTable = null;
  }
  updateRunButton();
  renderProfiles();
}

function updateRunButton() {
  const btn = $("#btn-run");
  if (!btn) return;
  const enabled = !!(state.activeConnectionId || state.connected || Object.keys(state.connectedIds || {}).length);
  btn.disabled = !enabled;
  btn.title = enabled ? "Run SQL (⌘/Ctrl + Enter)" : "Connect to run SQL";
}

/* ── Preferences (view + theme) ──────────────────── */

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePrefs(partial) {
  const next = { ...loadPrefs(), ...partial };
  localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  return next;
}

function normalizeZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  const nearest = ZOOM_LEVELS.reduce((best, z) =>
    Math.abs(z - n) < Math.abs(best - n) ? z : best, ZOOM_LEVELS[0]);
  return nearest;
}

function applyZoom(zoom) {
  const pct = normalizeZoom(zoom);
  const root = document.documentElement;
  root.style.zoom = `${pct}%`;
  root.dataset.zoom = String(pct);
  $$(".pref-zoom").forEach((el) => { el.value = String(pct); });
}

function normalizeSqlEditorZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return SQL_EDITOR_ZOOM_LEVELS.reduce((best, z) =>
    Math.abs(z - n) < Math.abs(best - n) ? z : best, SQL_EDITOR_ZOOM_LEVELS[0]);
}

/** Zoom only the SQL editor text (not the whole app). */
function applySqlEditorZoom(zoom, { persist = true } = {}) {
  const pct = normalizeSqlEditorZoom(zoom);
  const shell = $("#sql-editor-shell");
  const base = document.documentElement.dataset.density === "compact" ? 0.78 : SQL_EDITOR_BASE_REM;
  const fs = base * (pct / 100);
  const fsCss = `${fs.toFixed(3)}rem`;
  if (shell) {
    shell.style.setProperty("--sql-fs", fsCss);
    shell.dataset.editorZoom = String(pct);
  }
  // Direct font-size for JavaFX WebView, which can ignore CSS variables on some nodes.
  ["#sql-editor", "#sql-highlight", "#sql-gutter"].forEach((sel) => {
    const el = $(sel);
    if (el) el.style.fontSize = fsCss;
  });
  const label = $("#sql-zoom-label");
  if (label) label.textContent = `${pct}%`;
  const hint = $("#sql-editor-hint");
  if (hint) {
    const zoomBit = pct === 100 ? "" : ` · text ${pct}%`;
    hint.textContent = `Tab indent · Ctrl+Space suggest · Ctrl+F find · Ctrl± zoom${zoomBit} · ⌘/Ctrl+Enter run`;
  }
  if (persist) savePrefs({ sqlEditorZoom: pct });
  if (typeof refreshSqlEditorUi === "function") refreshSqlEditorUi();
  return pct;
}

function bumpSqlEditorZoom(delta) {
  const current = normalizeSqlEditorZoom(loadPrefs().sqlEditorZoom ?? $("#sql-editor-shell")?.dataset.editorZoom ?? 100);
  let idx = SQL_EDITOR_ZOOM_LEVELS.indexOf(current);
  if (idx < 0) idx = SQL_EDITOR_ZOOM_LEVELS.indexOf(100);
  const nextIdx = Math.min(SQL_EDITOR_ZOOM_LEVELS.length - 1, Math.max(0, idx + delta));
  return applySqlEditorZoom(SQL_EDITOR_ZOOM_LEVELS[nextIdx]);
}

function isSqlPanelActive() {
  return !!$("#panel-sql")?.classList.contains("active");
}

function applyPrefs() {
  const prefs = loadPrefs();
  const theme = THEMES.includes(prefs.theme) ? prefs.theme : "teal";
  const density = DENSITIES.includes(prefs.density) ? prefs.density : "compact";
  const zoom = normalizeZoom(prefs.zoom ?? 100);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = density;
  $$(".pref-theme").forEach((el) => { el.value = theme; });
  $$(".pref-density").forEach((el) => { el.value = density; });
  applyZoom(zoom);
  applySqlEditorZoom(prefs.sqlEditorZoom ?? 100, { persist: false });
  applySidebarWidth(prefs.sidebarWidth);
  applySqlLogLayout();
}

function applySidebarWidth(width) {
  const app = $("#app");
  if (!app) return;
  const n = Number(width);
  const w = Number.isFinite(n) ? Math.min(560, Math.max(180, Math.round(n))) : 280;
  app.style.setProperty("--sidebar-width", `${w}px`);
}

function wireSidebarResize() {
  const handle = $("#sidebar-resizer");
  const app = $("#app");
  if (!handle || !app) return;

  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    const rect = app.getBoundingClientRect();
    applySidebarWidth(e.clientX - rect.left);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("active");
    document.body.classList.remove("resizing-sidebar");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    const raw = getComputedStyle(app).getPropertyValue("--sidebar-width").trim();
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) savePrefs({ sidebarWidth: n });
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    handle.classList.add("active");
    document.body.classList.add("resizing-sidebar");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });

  handle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    applySidebarWidth(280);
    savePrefs({ sidebarWidth: 280 });
  });
}

function wirePrefs() {
  $$(".pref-theme").forEach((el) => {
    el.onchange = () => {
      savePrefs({ theme: el.value });
      applyPrefs();
    };
  });
  $$(".pref-density").forEach((el) => {
    el.onchange = () => {
      savePrefs({ density: el.value });
      applyPrefs();
      applySqlEditorZoom(loadPrefs().sqlEditorZoom ?? 100, { persist: false });
    };
  });
  $$(".pref-zoom").forEach((el) => {
    el.onchange = () => {
      savePrefs({ zoom: normalizeZoom(el.value) });
      applyPrefs();
    };
  });
  applyPrefs();
  wireSidebarResize();
}

/** Native system menu bar (File / Settings) → UI actions. */
window.dbPilotMenu = {
  newConnection: () => openNewConnection(),
  openSql: () => loadSqlFile(),
  saveSql: () => saveSqlFile(),
  setTheme: (theme) => {
    if (!THEMES.includes(theme)) return;
    savePrefs({ theme });
    applyPrefs();
  },
  setZoom: (zoom) => {
    savePrefs({ zoom: normalizeZoom(zoom) });
    applyPrefs();
  },
  setDensity: (density) => {
    if (!DENSITIES.includes(density)) return;
    savePrefs({ density });
    applyPrefs();
    applySqlEditorZoom(loadPrefs().sqlEditorZoom ?? 100, { persist: false });
  },
};

/* ── Profiles / sidebar connection tree ──────────── */

async function loadProfiles() {
  state.profiles = await api("/api/profiles");
  renderProfiles();
}

function fileBaseName(path) {
  if (!path) return "";
  const parts = String(path).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function profileDetail(p) {
  if (p.fileBased || ["SQLITE", "H2_FILE"].includes(p.dbType)) {
    return fileBaseName(p.database) || "file database";
  }
  if (p.useSshTunnel || p.sshTunnel) {
    return `${p.host || "host"} via ${p.sshHost || "SSH"}`;
  }
  return p.host || "host";
}

function isLiveProfile(p) {
  return !!(p && state.connectedIds && state.connectedIds[p.id]);
}

function isExpanded(profileId) {
  return !!(state.expandedProfileIds && state.expandedProfileIds[profileId]);
}

function setExpanded(profileId, on) {
  if (!state.expandedProfileIds) state.expandedProfileIds = {};
  if (on) state.expandedProfileIds[profileId] = true;
  else delete state.expandedProfileIds[profileId];
}

async function syncSessionState() {
  const session = await api("/api/session");
  state.session = session;
  state.activeConnectionId = session.activeId || null;
  state.connectedIds = {};
  for (const s of session.sessions || []) {
    if (s.id) state.connectedIds[s.id] = true;
  }
  // Back-compat if older server shape
  if (session.profile?.id) {
    state.connectedIds[session.profile.id] = true;
    if (!state.activeConnectionId) state.activeConnectionId = session.profile.id;
  }
  state.connected = Object.keys(state.connectedIds).length > 0;
  return session;
}

function renderProfiles() {
  const tree = $("#conn-tree");
  if (!tree) return;
  tree.innerHTML = "";
  if (!state.profiles.length) {
    tree.innerHTML = `<div class="profile-empty">No connections. Click + to add one.</div>`;
    return;
  }

  for (const p of state.profiles) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node conn-node";
    wrap.dataset.profileId = p.id;

    const row = document.createElement("div");
    const live = isLiveProfile(p);
    const expanded = live && isExpanded(p.id);
    row.className = "tree-row conn-row"
      + (p.id === state.selectedProfileId ? " active" : "")
      + (live ? " connected" : "")
      + (p.id === state.activeConnectionId ? " active-session" : "");

    const caret = document.createElement("span");
    caret.className = "tree-caret";
    caret.textContent = expanded ? "▾" : "▸";

    row.appendChild(caret);
    const label = document.createElement("span");
    label.className = "tree-label";
    const liveDot = live
      ? `<span class="conn-live-dot" title="Connected" aria-label="Connected"></span>`
      : "";
    label.innerHTML = `<strong>${escapeHtml(p.name || "Untitled")}${liveDot}</strong>`
      + `<span class="conn-meta">${escapeHtml(profileDetail(p))}</span>`;
    row.appendChild(label);

    const more = document.createElement("button");
    more.type = "button";
    more.className = "tree-more";
    more.title = "Connection actions";
    more.textContent = "⋯";
    more.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = more.getBoundingClientRect();
      showConnContextMenu(rect.left, rect.bottom + 4, p);
    };
    row.appendChild(more);

    const kids = document.createElement("div");
    kids.className = "tree-children conn-children";
    kids.hidden = !expanded;

    row.onclick = async (e) => {
      if (e.target.closest(".tree-more")) return;
      state.selectedProfileId = p.id;
      try {
        await toggleConnectionNode(p);
      } catch (err) {
        showError($("#sidebar-error"), err.message);
      }
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showConnContextMenu(e.clientX, e.clientY, p);
    };

    wrap.append(row, kids);
    tree.appendChild(wrap);

    if (expanded) {
      loadTreeInto(kids, p.id).catch((err) => {
        kids.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
      });
    }
  }
}

async function toggleConnectionNode(profile) {
  showError($("#sidebar-error"), "");

  // Already live: activate + show connection details; toggle expand
  if (isLiveProfile(profile)) {
    await api("/api/session/active", {
      method: "POST",
      body: JSON.stringify({ id: profile.id }),
    });
    state.activeConnectionId = profile.id;
    if (isExpanded(profile.id)) {
      setExpanded(profile.id, false);
    } else {
      setExpanded(profile.id, true);
    }
    renderProfiles();
    await focusHomeDetails({ scope: "connection" });
    return;
  }

  // Not connected yet — ask password / connect without touching others
  state.pendingExpandProfileId = profile.id;
  await accessConnection(profile);
}

/** Open a saved connection — prompts for password unless already live or password is saved. */
async function accessConnection(profile, credentials = null) {
  showError($("#sidebar-error"), "");
  state.selectedProfileId = profile.id;
  renderProfiles();

  if (isLiveProfile(profile)) {
    await api("/api/session/active", {
      method: "POST",
      body: JSON.stringify({ id: profile.id }),
    });
    state.activeConnectionId = profile.id;
    setExpanded(profile.id, true);
    await onConnected({ reused: true });
    return;
  }

  const fileBased = profile.fileBased || ["SQLITE", "H2_FILE"].includes(profile.dbType);
  if (fileBased) {
    setStatus("Connecting…");
    await api("/api/connect/" + encodeURIComponent(profile.id), {
      method: "POST",
      body: "{}",
    });
    await onConnected();
    return;
  }

  // Connect with credentials from the add/edit form, or stored password — skip re-prompt.
  if (credentials || profile.hasPassword) {
    setStatus("Connecting…");
    try {
      await api("/api/connect/" + encodeURIComponent(profile.id), {
        method: "POST",
        body: JSON.stringify(credentials || {}),
      });
      await onConnected();
      return;
    } catch (err) {
      if (credentials) throw err;
      // Stored password failed — fall through to prompt.
    }
  }

  openPasswordModal(profile);
}

async function onConnected() {
  const session = await syncSessionState();
  const expandId = state.pendingExpandProfileId || state.selectedProfileId || session.activeId;
  state.pendingExpandProfileId = null;
  if (expandId) {
    setExpanded(expandId, true);
    state.activeConnectionId = expandId;
  }
  setConnectedUi(true);
  const count = Object.keys(state.connectedIds).length;
  setStatus(count > 1 ? `Connected (${count} sessions)` : "Connected");
  await focusHomeDetails({ scope: "connection" });
  await loadProfiles();
}

async function resetSession() {
  // Full reset used only when no sessions remain
  state.connected = false;
  state.session = null;
  state.connectedIds = {};
  state.activeConnectionId = null;
  state.currentSchema = null;
  state.currentTable = null;
  state.result = null;
  state.page = 1;
  state.expandedProfileIds = {};
  setDetailFocus({ scope: "connection" });
  updateContextMeta("");
  resetWorkspaceTabs();
  setConnectedUi(false);
  updateRunButton();
  refreshDetails().catch(() => {});
}

function closeWorkspaceTabsForConnection(connectionId) {
  if (!connectionId) return;
  const kept = state.workspaceTabs.filter((t) => {
    if (t.kind === "table") return t.connectionId !== connectionId;
    if (t.kind === "context") return t.connectionId !== connectionId;
    return true;
  });
  const removedActive = !kept.some((t) => t.id === state.activeWorkspaceTabId);
  state.workspaceTabs = kept;
  if (!kept.length) {
    showEmptyWorkspace();
    return;
  }
  if (removedActive) {
    state.activeWorkspaceTabId = kept[kept.length - 1].id;
    applyWorkspaceTab(state.activeWorkspaceTabId).catch((e) => console.error(e));
  }
  renderWorkspaceTabs();
}

async function disconnectCurrent(profileId) {
  const id = profileId || state.activeConnectionId || state.selectedProfileId;
  if (!id) return;
  await api("/api/disconnect/" + encodeURIComponent(id), { method: "POST", body: "{}" });
  delete state.connectedIds[id];
  setExpanded(id, false);
  closeWorkspaceTabsForConnection(id);
  if (state.activeConnectionId === id) {
    state.activeConnectionId = Object.keys(state.connectedIds)[0] || null;
  }
  state.connected = Object.keys(state.connectedIds).length > 0;
  if (!state.connected) {
    await resetSession();
  } else {
    await syncSessionState();
    setConnectedUi(true);
  }
  setStatus("Disconnected");
  await loadProfiles();
}

async function deleteConnection(profile) {
  const ok = confirm(`Delete connection “${profile.name || "Untitled"}”?`);
  if (!ok) return;
  try {
    await api("/api/disconnect/" + encodeURIComponent(profile.id), { method: "POST", body: "{}" }).catch(() => {});
  } finally {
    delete state.connectedIds[profile.id];
    setExpanded(profile.id, false);
  }
  await api("/api/profiles/" + encodeURIComponent(profile.id), { method: "DELETE" });
  closeWorkspaceTabsForConnection(profile.id);
  if (state.selectedProfileId === profile.id) state.selectedProfileId = null;
  if (state.activeConnectionId === profile.id) {
    state.activeConnectionId = Object.keys(state.connectedIds)[0] || null;
  }
  showError($("#sidebar-error"), "");
  state.connected = Object.keys(state.connectedIds).length > 0;
  if (!state.connected) {
    await resetSession();
  } else {
    await syncSessionState();
  }
  await loadProfiles();
  setStatus("Connection deleted");
}

/* ── Explorer tree (under a connection) ──────────── */

function withConnectionId(path, connectionId) {
  if (!connectionId) return path;
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}connectionId=${encodeURIComponent(connectionId)}`;
}

async function loadTree() {
  renderProfiles();
}

async function loadTreeInto(container, connectionId) {
  if (!container) return;
  container.innerHTML = `<div class="hint" style="padding:.35rem">Loading…</div>`;
  container.hidden = false;
  try {
    // Use connectionId on the request — do not steal active session from siblings.
    const explorer = await api(withConnectionId("/api/explorer", connectionId));
    container.innerHTML = "";
    const nodes = explorer.nodes || [];
    if (!nodes.length) {
      container.innerHTML = `<div class="profile-empty">No databases/schemas found.</div>`;
      return;
    }
    for (const node of nodes) {
      container.appendChild(renderExplorerNode(node, explorer.layout, connectionId));
    }
  } catch (e) {
    container.innerHTML = `<div class="error-text">${escapeHtml(e.message)}</div>`;
  }
}

function renderExplorerNode(node, layout, connectionId, parentDatabase = null) {
  const kind = node.kind || "database";
  // MySQL: database node name is the DB; PostgreSQL: parent DB for schema children.
  const databaseName = kind === "database"
    ? (node.name || null)
    : (parentDatabase || null);
  const wrap = document.createElement("div");
  wrap.className = "tree-node";

  const row = document.createElement("div");
  row.className = "tree-row";
  const badge = kind === "schema" ? "SCH" : "DB";
  const badgeClass = kind === "schema" ? "vw" : "db";
  row.innerHTML = `<span class="badge ${badgeClass}">${badge}</span><span class="tree-label">${escapeHtml(node.name)}</span>`;

  const more = document.createElement("button");
  more.type = "button";
  more.className = "tree-more";
  more.title = "Actions";
  more.textContent = "⋯";
  more.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = more.getBoundingClientRect();
    state.activeConnectionId = connectionId;
    showDbContextMenu(rect.left, rect.bottom + 4, node.schema || node.name, kind, databaseName);
  };
  row.appendChild(more);

  const kids = document.createElement("div");
  kids.className = "tree-children";
  kids.hidden = true;
  let loaded = false;
  const childSchemas = Array.isArray(node.children) ? node.children : null;

  row.onclick = async (e) => {
    if (e.target.closest(".tree-more")) return;
    if (connectionId) {
      state.activeConnectionId = connectionId;
      await api("/api/session/active", {
        method: "POST",
        body: JSON.stringify({ id: connectionId }),
      }).catch(() => {});
    }
    if (kind === "schema" || (kind === "database" && layout !== "database-schemas")) {
      await focusHomeDetails({
        scope: "schema",
        schema: node.schema || node.name,
        database: databaseName || profileDatabaseName(connectionId),
        connectionId,
      });
    } else if (kind === "database" && layout === "database-schemas") {
      await focusHomeDetails({
        scope: "database",
        database: node.name,
        schema: node.schema || node.name,
        connectionId,
      });
    }

    kids.hidden = !kids.hidden;
    if (kids.hidden || loaded) return;
    loaded = true;
    kids.innerHTML = `<div class="hint" style="padding:.35rem">Loading…</div>`;
    try {
      if (childSchemas) {
        kids.innerHTML = "";
        for (const schemaNode of childSchemas) {
          kids.appendChild(renderExplorerNode(schemaNode, "schema-objects", connectionId, node.name));
        }
        return;
      }
      const schema = node.schema || node.name;
      const dbForObjects = databaseName || profileDatabaseName(connectionId);
      const base = `/api/databases/${encodeURIComponent(schema)}`;
      const [tables, views, procs, funcs] = await Promise.all([
        api(withConnectionId(`${base}/tables`, connectionId)),
        api(withConnectionId(`${base}/views`, connectionId)),
        api(withConnectionId(`${base}/procedures`, connectionId)),
        api(withConnectionId(`${base}/functions`, connectionId)),
      ]);
      kids.innerHTML = "";
      kids.appendChild(folder("Tables", "tbl", schema, tables, "table", connectionId, dbForObjects));
      kids.appendChild(folder("Views", "vw", schema, views, "view", connectionId, dbForObjects));
      kids.appendChild(folder("Procedures", "db", schema, procs, "proc", connectionId, dbForObjects));
      kids.appendChild(folder("Functions", "db", schema, funcs, "func", connectionId, dbForObjects));
    } catch (err) {
      kids.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
      loaded = false;
    }
  };

  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.activeConnectionId = connectionId;
    showDbContextMenu(e.clientX, e.clientY, node.schema || node.name, kind, databaseName);
  };

  wrap.append(row, kids);
  return wrap;
}

function showConnContextMenu(x, y, profile) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextTarget = { type: "connection", profile };
  state.selectedProfileId = profile.id;
  const menu = $("#ctx-menu-conn");
  const live = isLiveProfile(profile);
  menu.querySelector('[data-action="conn-connect"]').hidden = live;
  menu.querySelector('[data-action="conn-disconnect"]').hidden = !live;
  menu.querySelectorAll(".conn-admin, .conn-admin-sep").forEach((el) => {
    el.hidden = !live;
  });
  positionContextMenu(menu, x, y);
}

/* ── Connection modal ────────────────────────────── */

async function loadDbTypes() {
  state.dbTypes = await api("/api/db-types");
  const sel = $("#db-type");
  sel.innerHTML = state.dbTypes.map((t) =>
    `<option value="${t.id}">${t.name}</option>`).join("");
  sel.onchange = () => updateConnFormForType();
  $("#use-ssh-tunnel").onchange = () => updateConnFormForMode();
}

function defaultHierarchyForType(typeId) {
  return ["POSTGRESQL", "H2", "H2_FILE", "SQLSERVER"].includes(typeId) ? "THREE_LAYER" : "TWO_LAYER";
}

function updateConnFormForType() {
  const type = state.dbTypes.find((t) => t.id === $("#db-type").value);
  if (!type) return;
  const form = $("#form-connection");
  if (!state.editingProfileId) {
    form.port.value = type.defaultPort || 0;
  }
  const fileBased = type.fileBased;
  form.querySelector(".host-field").style.display = fileBased ? "none" : "";
  form.querySelector(".port-field").style.display = fileBased ? "none" : "";
  form.querySelector(".db-field").querySelector("input").placeholder =
    fileBased ? "/path/to/database.db" : "database name";

  const sshToggle = $("#use-ssh-tunnel");
  const sshWrap = $("#ssh-toggle-wrap");
  if (fileBased) {
    if (sshToggle) sshToggle.checked = false;
    if (sshWrap) sshWrap.hidden = true;
  } else if (sshWrap) {
    sshWrap.hidden = false;
  }
  updateConnFormForMode();
}

function updateConnFormForMode() {
  const type = state.dbTypes.find((t) => t.id === $("#db-type").value);
  const fileBased = type && type.fileBased;
  const useSsh = !fileBased && $("#use-ssh-tunnel")?.checked;
  $("#ssh-fields").hidden = !useSsh;
}

function setConnTestStatus(msg, isError = false) {
  const el = $("#conn-test-status");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("error-text", !!isError);
}

function openNewConnection() {
  state.editingProfileId = null;
  $("#modal-conn-title").textContent = "New connection";
  $("#btn-submit-conn").textContent = "Save";
  const form = $("#form-connection");
  form.reset();
  form.id.value = "";
  form.dbType.value = "MYSQL";
  form.host.value = "localhost";
  form.port.value = 3306;
  form.username.value = "root";
  form.password.placeholder = "";
  form.useSshTunnel.checked = false;
  form.sshPort.value = 22;
  form.sshPassword.placeholder = "";
  form.sshPassphrase.placeholder = "";
  setConnTestStatus("");
  updateConnFormForType();
  $("#modal-connection").showModal();
}

function openEditConnection(profile) {
  state.editingProfileId = profile.id;
  state.selectedProfileId = profile.id;
  $("#modal-conn-title").textContent = "Edit connection";
  $("#btn-submit-conn").textContent = "Save";
  const form = $("#form-connection");
  form.id.value = profile.id;
  form.name.value = profile.name || "";
  form.dbType.value = profile.dbType || "MYSQL";
  form.host.value = profile.host || "localhost";
  form.port.value = profile.port || 0;
  form.database.value = profile.database || "";
  form.username.value = profile.username || "";
  form.password.value = "";
  form.password.placeholder = profile.hasPassword ? "Leave blank to keep existing" : "";
  form.savePassword.checked = !!profile.savePassword;
  form.useSshTunnel.checked = !!profile.useSshTunnel;
  form.sshHost.value = profile.sshHost || "";
  form.sshPort.value = profile.sshPort || 22;
  form.sshUsername.value = profile.sshUsername || "";
  form.sshPassword.value = "";
  form.sshPassword.placeholder = profile.hasSshPassword ? "Leave blank to keep existing" : "";
  form.sshPrivateKeyPath.value = profile.sshPrivateKeyPath || "";
  form.sshPassphrase.value = "";
  form.sshPassphrase.placeholder = profile.hasSshPassphrase ? "Leave blank to keep existing" : "";
  form.saveSshPassword.checked = !!profile.saveSshPassword;
  setConnTestStatus("");
  updateConnFormForType();
  form.useSshTunnel.checked = !!profile.useSshTunnel;
  updateConnFormForMode();
  $("#modal-connection").showModal();
}

function openPasswordModal(profile) {
  state.pendingProfile = profile;
  $("#password-lead").textContent = `Enter password to open “${profile.name || "Untitled"}”.`;
  const form = $("#form-password");
  form.username.value = profile.username || "";
  form.password.value = "";
  form.password.placeholder = profile.hasPassword ? "Leave blank to use saved password" : "";
  form.savePassword.checked = false;
  const showSsh = !!profile.useSshTunnel;
  $("#password-ssh-fields").hidden = !showSsh;
  if (showSsh) {
    form.sshUsername.value = profile.sshUsername || "";
    form.sshPassword.value = "";
    form.saveSshPassword.checked = false;
  }
  $("#modal-password").showModal();
}

function readConnectionForm(form) {
  const profile = {
    name: form.name.value.trim() || undefined,
    dbType: form.dbType.value,
    connectionMode: defaultHierarchyForType(form.dbType.value),
    host: form.host.value.trim(),
    port: Number(form.port.value) || 0,
    database: form.database.value.trim(),
    username: form.username.value.trim(),
    password: form.password.value,
    savePassword: form.savePassword.checked,
    useSshTunnel: !!form.useSshTunnel?.checked,
    sshHost: form.sshHost.value.trim(),
    sshPort: Number(form.sshPort.value) || 22,
    sshUsername: form.sshUsername.value.trim(),
    sshPassword: form.sshPassword.value,
    sshPrivateKeyPath: form.sshPrivateKeyPath.value.trim(),
    sshPassphrase: form.sshPassphrase.value,
    saveSshPassword: form.saveSshPassword.checked,
  };
  if (form.id.value) profile.id = form.id.value;
  // Engine-enforced hierarchy
  if (["POSTGRESQL", "H2", "H2_FILE"].includes(profile.dbType)) {
    profile.connectionMode = "THREE_LAYER";
  } else if (profile.dbType === "MYSQL" || profile.dbType === "SQLITE") {
    profile.connectionMode = "TWO_LAYER";
  }
  return profile;
}

/* ── Context menus / admin dialogs ───────────────── */

const PROP_LABELS = {
  name: "Name",
  kind: "Type",
  engine: "Engine",
  status: "Status",
  host: "Host",
  port: "Port",
  database: "Database",
  username: "Username",
  connectionMode: "Hierarchy",
  connectionModeLabel: "Hierarchy",
  useSshTunnel: "SSH tunnel enabled",
  sshHost: "SSH host",
  sshPort: "SSH port",
  sshUsername: "SSH username",
  sshPrivateKeyPath: "SSH private key",
  sshTunnel: "SSH tunnel",
  serverProduct: "Server product",
  serverVersion: "Server version",
  driverName: "Driver",
  driverVersion: "Driver version",
  url: "JDBC URL",
  userName: "Connected user",
  tableCount: "Tables",
  viewCount: "Views",
  procedureCount: "Procedures",
  functionCount: "Functions",
  charset: "Character set",
  collation: "Collation",
  sizeMb: "Size (MB)",
  owner: "Owner",
  catalog: "Catalog",
  state: "State",
  recoveryModel: "Recovery model",
  compatibilityLevel: "Compatibility level",
  created: "Created",
  filePath: "File path",
  pageCount: "Page count",
  pageSize: "Page size",
  encoding: "Encoding",
  isDefault: "Default schema",
  liveError: "Live error",
  displayType: "Engine",
  id: "Connection ID",
};

const CTX_MENUS = ["#ctx-menu-conn", "#ctx-menu-db", "#ctx-menu-folder", "#ctx-menu-table", "#ctx-menu-view", "#ctx-menu-wstab"];
let suppressMenuHideUntil = 0;

function hideAllContextMenus() {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextDb = null;
  state.contextTarget = null;
}

function positionContextMenu(menu, x, y) {
  suppressMenuHideUntil = Date.now() + 350;
  menu.hidden = false;
  // Measure after showing so width/height are available
  requestAnimationFrame(() => {
    const pad = 8;
    const maxX = window.innerWidth - menu.offsetWidth - pad;
    const maxY = window.innerHeight - menu.offsetHeight - pad;
    menu.style.left = `${Math.max(pad, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(pad, Math.min(y, maxY))}px`;
  });
}

function showDbContextMenu(x, y, db, kind = "database", database = null) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextDb = db;
  const isSchema = kind === "schema";
  state.contextTarget = {
    type: "db",
    schema: db,
    kind,
    database: database || (!isSchema ? db : profileDatabaseName(state.activeConnectionId)) || null,
  };
  const menu = $("#ctx-menu-db");
  menu.querySelectorAll(".ctx-db-only").forEach((el) => { el.hidden = isSchema; });
  menu.querySelectorAll(".ctx-schema-only").forEach((el) => { el.hidden = !isSchema; });
  positionContextMenu(menu, x, y);
}

function showFolderContextMenu(x, y, schema, kind) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextTarget = { type: "folder", schema, kind };
  const menu = $("#ctx-menu-folder");
  menu.querySelector('[data-action="create-table"]').hidden = kind !== "table";
  menu.querySelector('[data-action="create-view"]').hidden = kind !== "view";
  menu.querySelector('[data-action="import-table"]').hidden = kind !== "table";
  positionContextMenu(menu, x, y);
}

function showTableContextMenu(x, y, schema, table, database = null) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextTarget = {
    type: "table",
    schema,
    table,
    database: database || profileDatabaseName(state.activeConnectionId) || null,
  };
  positionContextMenu($("#ctx-menu-table"), x, y);
}

function showViewContextMenu(x, y, schema, view, database = null) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextTarget = {
    type: "view",
    schema,
    view,
    database: database || profileDatabaseName(state.activeConnectionId) || null,
  };
  positionContextMenu($("#ctx-menu-view"), x, y);
}

async function openDatabaseProperties(db) {
  hideAllContextMenus();
  const title = $("#db-props-title");
  const subtitle = $("#db-props-subtitle");
  const body = $("#db-props-body");
  title.textContent = "Database properties";
  subtitle.textContent = `Loading properties for “${db}”…`;
  body.innerHTML = `<div class="prop-key">Status</div><div class="prop-val">Loading…</div>`;
  $("#modal-db-props").showModal();
  try {
    const props = await api(`/api/databases/${encodeURIComponent(db)}/properties`);
    fillPropertiesModal(props, db);
  } catch (e) {
    subtitle.textContent = db;
    body.innerHTML = `<div class="prop-key">Error</div><div class="prop-val">${escapeHtml(e.message)}</div>`;
  }
}

async function openConnectionProperties(profile) {
  hideAllContextMenus();
  if (!profile?.id) return;
  const title = $("#db-props-title");
  const subtitle = $("#db-props-subtitle");
  const body = $("#db-props-body");
  const label = profile.name || "Connection";
  title.textContent = "Connection properties";
  subtitle.textContent = `Loading properties for “${label}”…`;
  body.innerHTML = `<div class="prop-key">Status</div><div class="prop-val">Loading…</div>`;
  $("#modal-db-props").showModal();
  try {
    const props = await api(`/api/profiles/${encodeURIComponent(profile.id)}/properties`);
    fillPropertiesModal(props, label);
  } catch (e) {
    subtitle.textContent = label;
    body.innerHTML = `<div class="prop-key">Error</div><div class="prop-val">${escapeHtml(e.message)}</div>`;
  }
}

function fillPropertiesModal(props, fallbackName) {
  const title = $("#db-props-title");
  const subtitle = $("#db-props-subtitle");
  const body = $("#db-props-body");
  const kind = props.kind || "Properties";
  title.textContent = `${kind} properties`;
  subtitle.textContent = props.name || fallbackName || "";
  body.innerHTML = "";
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === "") continue;
    if (key === "kind") continue;
    const label = PROP_LABELS[key] || key;
    const keyEl = document.createElement("div");
    keyEl.className = "prop-key";
    keyEl.textContent = label;
    const valEl = document.createElement("div");
    valEl.className = "prop-val";
    valEl.textContent = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    body.append(keyEl, valEl);
  }
  if (!body.children.length) {
    body.innerHTML = `<div class="prop-key">Info</div><div class="prop-val">No properties available.</div>`;
  }
}

function openCreateDatabaseModal() {
  hideAllContextMenus();
  $("#db-admin-title").textContent = "Create database";
  $("#db-admin-mode").value = "create";
  $("#db-admin-original").value = "";
  $("#db-admin-newname-wrap").hidden = true;
  const form = $("#form-db-admin");
  form.reset();
  $("#modal-db-admin").showModal();
}

function openModifyDatabaseModal(name) {
  hideAllContextMenus();
  $("#db-admin-title").textContent = "Modify database";
  $("#db-admin-mode").value = "modify";
  $("#db-admin-original").value = name;
  $("#db-admin-newname-wrap").hidden = false;
  const form = $("#form-db-admin");
  form.name.value = name;
  form.newName.value = "";
  form.charset.value = "";
  form.collation.value = "";
  $("#modal-db-admin").showModal();
}

function openCloneModal(source) {
  hideAllContextMenus();
  const form = $("#form-clone");
  form.source.value = source;
  form.sourceDisplay.value = source;
  form.targetName.value = `${source}_copy`;
  form.includeData.checked = true;
  form.includeViews.checked = true;
  form.includeIndexes.checked = true;
  $("#modal-clone").showModal();
}

function openExportModal({ schema, table = "", scope = "table" }) {
  hideAllContextMenus();
  $("#export-title").textContent = scope === "database" ? "Export database SQL" : `Export ${table}`;
  $("#export-schema").value = schema;
  $("#export-table").value = table;
  $("#export-scope").value = scope;
  const form = $("#form-export");
  form.format.value = scope === "database" ? "sql" : "csv";
  $("#export-include-data-wrap").hidden = scope !== "database";
  form.format.querySelector('option[value="csv"]').disabled = scope === "database";
  form.format.querySelector('option[value="json"]').disabled = scope === "database";
  form.format.querySelector('option[value="xlsx"]').disabled = scope === "database";
  $("#modal-export").showModal();
}

function openImportModal({ schema, table = "", mode = "table" }) {
  hideAllContextMenus();
  state.importPicked = null;
  $("#import-title").textContent = mode === "sql" ? "Import SQL script" : `Import into ${table}`;
  $("#import-schema").value = schema || "";
  $("#import-table").value = table || "";
  $("#import-mode").value = mode;
  const form = $("#form-import");
  form.reset();
  $("#import-schema").value = schema || "";
  $("#import-table").value = table || "";
  $("#import-mode").value = mode;
  $("#import-file-name").textContent = "No file selected";
  $("#import-paste").value = "";
  if (mode === "sql") {
    form.format.value = "sql";
    form.format.disabled = true;
    $("#import-header-wrap").hidden = true;
    $("#import-truncate-wrap").hidden = true;
  } else {
    form.format.disabled = false;
    $("#import-header-wrap").hidden = false;
    $("#import-truncate-wrap").hidden = false;
  }
  $("#modal-import").showModal();
}

function pickImportFileNative() {
  try {
    if (!window.javaApp || typeof window.javaApp.pickImportFile !== "function") {
      alert("Native file picker unavailable. Paste file contents into the text area instead.");
      return;
    }
    const raw = window.javaApp.pickImportFile();
    if (!raw) return;
    const payload = JSON.parse(raw);
    if (payload.error) {
      alert(payload.error);
      return;
    }
    state.importPicked = payload;
    $("#import-file-name").textContent = payload.name || "Selected file";
    $("#import-paste").value = "";
    const name = (payload.name || "").toLowerCase();
    const form = $("#form-import");
    if (name.endsWith(".json")) form.format.value = "json";
    else if (name.endsWith(".sql")) form.format.value = "sql";
    else if (name.endsWith(".xlsx") || name.endsWith(".xls")) form.format.value = "xlsx";
    else if (name.endsWith(".csv") || name.endsWith(".txt")) form.format.value = "csv";
  } catch (e) {
    alert(e.message || "Failed to pick file");
  }
}

function updateSqlFileChip(name = state.sqlFileName) {
  const chip = $("#sql-file-chip");
  if (!chip) return;
  if (name) {
    chip.hidden = false;
    chip.textContent = name;
    chip.title = state.sqlFilePath || name;
  } else {
    chip.hidden = true;
    chip.textContent = "";
    chip.title = "";
  }
}

const SQL_INDENT = "  ";

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set",
  "delete", "create", "alter", "drop", "table", "view", "index", "unique", "primary", "key",
  "foreign", "references", "constraint", "null", "is", "in", "like", "ilike", "between", "exists",
  "join", "inner", "left", "right", "full", "outer", "cross", "on", "using", "as", "distinct",
  "group", "by", "order", "asc", "desc", "having", "limit", "offset", "fetch", "next", "only",
  "union", "all", "except", "intersect", "case", "when", "then", "else", "end", "with",
  "recursive", "returning", "default", "check", "cascade", "restrict", "truncate", "replace",
  "function", "procedure", "trigger", "begin", "commit", "rollback", "transaction", "grant",
  "revoke", "schema", "database", "if", "elsif", "elseif", "loop", "while", "for", "return",
  "returns", "declare", "true", "false", "cast", "over", "partition", "window", "lateral",
  "natural", "some", "any", "of", "to", "add", "column", "rename", "type", "owner", "explain",
  "analyze", "vacuum", "show", "use", "desc", "describe", "do", "language", "plpgsql",
]);

const SQL_FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "coalesce", "nullif", "greatest", "least", "now",
  "current_timestamp", "current_date", "current_time", "date", "time", "timestamp", "extract",
  "date_trunc", "age", "concat", "concat_ws", "substring", "substr", "trim", "ltrim", "rtrim",
  "lower", "upper", "length", "char_length", "replace", "position", "round", "floor", "ceil",
  "abs", "mod", "power", "sqrt", "random", "md5", "uuid_generate_v4", "json_build_object",
  "jsonb_agg", "array_agg", "string_agg", "row_number", "rank", "dense_rank", "lag", "lead",
  "first_value", "last_value", "nvl", "ifnull", "isnull", "convert", "cast", "format",
]);

const SQL_TYPES = new Set([
  "int", "integer", "bigint", "smallint", "tinyint", "serial", "bigserial", "numeric", "decimal",
  "real", "double", "float", "boolean", "bool", "text", "varchar", "char", "character", "bytea",
  "blob", "clob", "json", "jsonb", "uuid", "date", "time", "timestamp", "timestamptz", "interval",
  "array", "enum", "money", "bit", "varbinary", "nvarchar", "ntext", "datetime", "datetime2",
]);

function getSqlEditor() {
  return $("#sql-editor");
}

function getSqlEditorValue() {
  return getSqlEditor()?.value ?? "";
}

/** Set editor text and refresh gutter / highlight / cursor chrome. */
function setSqlEditorValue(text) {
  const editor = getSqlEditor();
  if (!editor) return;
  editor.value = text ?? "";
  refreshSqlEditorUi();
}

function sqlLineColAt(text, index) {
  const safe = Math.max(0, Math.min(index ?? 0, text.length));
  const before = text.slice(0, safe);
  const lines = before.split("\n");
  return { line: lines.length, col: (lines[lines.length - 1] || "").length + 1 };
}

function sqlMetaObjectNames() {
  const meta = state.sqlMeta || {};
  const tables = new Set((meta.tables || []).map((t) => String(t).toLowerCase()));
  const views = new Set((meta.views || []).map((t) => String(t).toLowerCase()));
  const cols = new Set();
  for (const list of Object.values(meta.columnsByTable || {})) {
    for (const c of list || []) cols.add(String(c).toLowerCase());
  }
  for (const c of state.columns || []) {
    if (c?.name) cols.add(String(c.name).toLowerCase());
  }
  return { tables, views, cols };
}

function highlightSql(text) {
  const src = text || "";
  if (!src) return "";
  const { tables, views, cols } = sqlMetaObjectNames();
  let out = "";
  let i = 0;
  const len = src.length;

  const push = (cls, value) => {
    out += `<span class="${cls}">${escapeHtml(value)}</span>`;
  };

  while (i < len) {
    const c = src[i];
    const next = src[i + 1] || "";

    if (c === "-" && next === "-") {
      let j = i + 2;
      while (j < len && src[j] !== "\n") j += 1;
      push("sql-tok-cm", src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < len - 1 && !(src[j] === "*" && src[j + 1] === "/")) j += 1;
      j = Math.min(len, j + 2);
      push("sql-tok-cm", src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < len) {
        if (src[j] === quote) {
          if (src[j + 1] === quote) { j += 2; continue; }
          j += 1;
          break;
        }
        if (src[j] === "\n" && quote === "'") break;
        j += 1;
      }
      push("sql-tok-str", src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "$") {
      // PostgreSQL dollar-quote: $$…$$ or $tag$…$tag$
      const tagMatch = src.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeAt = src.indexOf(tag, i + tag.length);
        const end = closeAt >= 0 ? closeAt + tag.length : len;
        push("sql-tok-str", src.slice(i, end));
        i = end;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < len && /[0-9.]/.test(src[j])) j += 1;
      push("sql-tok-num", src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c) || c === "`" || c === "[") {
      let j = i;
      if (c === "`" || c === "[") {
        const close = c === "`" ? "`" : "]";
        j = i + 1;
        while (j < len && src[j] !== close && src[j] !== "\n") j += 1;
        if (j < len) j += 1;
      } else {
        j = i + 1;
        while (j < len && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      }
      const raw = src.slice(i, j);
      const bare = raw.replace(/^[`"\[]|[`"\]]$/g, "");
      const lower = bare.toLowerCase();
      let cls = "sql-tok-id";
      if (SQL_KEYWORDS.has(lower)) cls = "sql-tok-kw";
      else if (SQL_FUNCTIONS.has(lower)) cls = "sql-tok-fn";
      else if (SQL_TYPES.has(lower)) cls = "sql-tok-type";
      else if (tables.has(lower) || views.has(lower)) cls = "sql-tok-tbl";
      else if (cols.has(lower)) cls = "sql-tok-col";
      push(cls, raw);
      i = j;
      continue;
    }
    if (/[().,;=*/%!<>|&+\-]/.test(c)) {
      let j = i + 1;
      if ((c === "<" || c === ">" || c === "!" || c === "=" || c === "|") && /[=<>|]/.test(next)) j += 1;
      push("sql-tok-op", src.slice(i, j));
      i = j;
      continue;
    }
    // whitespace / other
    let j = i + 1;
    while (j < len && !/[A-Za-z0-9_`"'$\/\-]/.test(src[j]) && !/[().,;=*/%!<>|&+]/.test(src[j])) {
      // stop at potential comment/string starts handled above next loop
      if (src[j] === "-" || src[j] === "/" || src[j] === "'" || src[j] === '"' || src[j] === "$") break;
      if (/[A-Za-z0-9_`]/.test(src[j])) break;
      j += 1;
    }
    out += escapeHtml(src.slice(i, j));
    i = j;
  }
  // Preserve trailing newline height in <pre>
  if (src.endsWith("\n")) out += "\n";
  return out;
}

function renderSqlFindMarkedHtml(text, query, matchCase, currentIndex) {
  const matches = collectSqlFindMatches(text, query, matchCase);
  if (!matches.length) return escapeHtml(text || "");
  let out = "";
  let pos = 0;
  const len = query.length;
  matches.forEach((start, i) => {
    const end = start + len;
    out += escapeHtml(text.slice(pos, start));
    const cls = i === currentIndex ? "sql-find-mark current" : "sql-find-mark";
    out += `<mark class="${cls}">${escapeHtml(text.slice(start, end))}</mark>`;
    pos = end;
  });
  out += escapeHtml(text.slice(pos));
  if (text.endsWith("\n")) out += "\n";
  return out;
}

function refreshSqlHighlight() {
  const editor = getSqlEditor();
  const pre = $("#sql-highlight");
  if (!editor || !pre) return;
  const text = editor.value || "";
  const findOpen = !$("#sql-find-bar")?.hidden;
  const query = findOpen ? ($("#sql-find-input")?.value || "") : "";
  if (findOpen && query) {
    const matchCase = !!$("#sql-find-case")?.checked;
    const idx = Math.max(0, state.sqlFindIndex);
    pre.innerHTML = renderSqlFindMarkedHtml(text, query, matchCase, idx) || " ";
  } else {
    pre.innerHTML = highlightSql(text) || " ";
  }
  pre.scrollTop = editor.scrollTop;
  pre.scrollLeft = editor.scrollLeft;
}

function refreshSqlGutter() {
  const editor = getSqlEditor();
  const gutter = $("#sql-gutter");
  if (!editor || !gutter) return;
  const text = editor.value || "";
  const lineCount = text.length ? text.split("\n").length : 1;
  const { line: activeLine } = sqlLineColAt(text, editor.selectionStart ?? 0);
  const widthDigits = String(Math.max(lineCount, 1)).length;
  gutter.style.minWidth = `${Math.max(2.35, 1.1 + widthDigits * 0.55)}rem`;

  let html = "";
  for (let i = 1; i <= lineCount; i++) {
    html += `<span class="sql-gutter-line${i === activeLine ? " active" : ""}">${i}</span>`;
  }
  gutter.innerHTML = html;
  gutter.scrollTop = editor.scrollTop;
}

function refreshSqlCursorStatus() {
  const editor = getSqlEditor();
  const pos = $("#sql-cursor-pos");
  if (!editor || !pos) return;
  const { line, col } = sqlLineColAt(editor.value || "", editor.selectionStart ?? 0);
  const selLen = Math.abs((editor.selectionEnd ?? 0) - (editor.selectionStart ?? 0));
  pos.textContent = selLen > 0 ? `Ln ${line}, Col ${col} · ${selLen} selected` : `Ln ${line}, Col ${col}`;
}

function refreshSqlEditorUi() {
  refreshSqlHighlight();
  refreshSqlGutter();
  refreshSqlCursorStatus();
}

function syncSqlEditorScroll() {
  const editor = getSqlEditor();
  const gutter = $("#sql-gutter");
  const pre = $("#sql-highlight");
  if (!editor) return;
  if (gutter) gutter.scrollTop = editor.scrollTop;
  if (pre) {
    pre.scrollTop = editor.scrollTop;
    pre.scrollLeft = editor.scrollLeft;
  }
}

function replaceSqlEditorRange(start, end, insert) {
  const editor = getSqlEditor();
  if (!editor) return;
  const value = editor.value;
  editor.value = value.slice(0, start) + insert + value.slice(end);
  const caret = start + insert.length;
  editor.setSelectionRange(caret, caret);
  refreshSqlEditorUi();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function indentSqlSelection(outdent = false) {
  const editor = getSqlEditor();
  if (!editor) return;
  const value = editor.value;
  let start = editor.selectionStart;
  let end = editor.selectionEnd;
  const hasSelection = start !== end;

  if (!hasSelection && !outdent) {
    replaceSqlEditorRange(start, end, SQL_INDENT);
    return;
  }

  while (start > 0 && value[start - 1] !== "\n") start -= 1;
  let endLine = end;
  if (endLine > start && value[endLine - 1] === "\n") endLine -= 1;
  while (endLine < value.length && value[endLine] !== "\n") endLine += 1;

  const block = value.slice(start, endLine);
  const lines = block.split("\n");
  const next = lines.map((line) => {
    if (outdent) {
      if (line.startsWith(SQL_INDENT)) return line.slice(SQL_INDENT.length);
      if (line.startsWith("\t")) return line.slice(1);
      if (line.startsWith(" ")) return line.replace(/^ {1,2}/, "");
      return line;
    }
    return line.length ? SQL_INDENT + line : line;
  }).join("\n");

  editor.value = value.slice(0, start) + next + value.slice(endLine);
  const delta = next.length - block.length;
  editor.setSelectionRange(start, endLine + delta);
  refreshSqlEditorUi();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function toggleSqlLineComment() {
  const editor = getSqlEditor();
  if (!editor) return;
  const value = editor.value;
  let start = editor.selectionStart;
  let end = editor.selectionEnd;
  while (start > 0 && value[start - 1] !== "\n") start -= 1;
  let endLine = end;
  if (endLine > start && value[endLine - 1] === "\n") endLine -= 1;
  while (endLine < value.length && value[endLine] !== "\n") endLine += 1;

  const block = value.slice(start, endLine);
  const lines = block.split("\n");
  const uncomment = lines.every((line) => !line.trim() || /^\s*--/.test(line));
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    if (uncomment) return line.replace(/^(\s*)--\s?/, "$1");
    const m = line.match(/^(\s*)/);
    return `${m ? m[1] : ""}-- ${line.slice(m ? m[1].length : 0)}`;
  }).join("\n");

  editor.value = value.slice(0, start) + next + value.slice(endLine);
  editor.setSelectionRange(start, start + next.length);
  refreshSqlEditorUi();
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function autoIndentSqlOnEnter() {
  const editor = getSqlEditor();
  if (!editor) return;
  const value = editor.value;
  const pos = editor.selectionStart;
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  const prevLine = value.slice(lineStart, pos);
  const indent = (prevLine.match(/^\s*/) || [""])[0];
  const extra = /\(\s*$/.test(prevLine.trimEnd()) || /\b(BEGIN|THEN|ELSE|LOOP)\s*$/i.test(prevLine.trim())
    ? SQL_INDENT
    : "";
  replaceSqlEditorRange(pos, pos, `\n${indent}${extra}`);
}

/* ── SQL schema meta + autocomplete ─────────────── */

function sqlListSchema() {
  const ctx = readSqlContextFromUi();
  const profile = activeProfile();
  if (isThreeLayerProfile(profile)) {
    return ctx.schema || state.currentSchema || "";
  }
  return ctx.database || state.currentSchema || profileDatabaseName(state.activeConnectionId) || "";
}

function sqlMetaCacheKey() {
  return `${state.activeConnectionId || ""}::${sqlListSchema()}`;
}

async function ensureSqlMeta({ force = false } = {}) {
  const cid = state.activeConnectionId;
  const schema = sqlListSchema();
  if (!cid || !schema) return state.sqlMeta;
  const key = `${cid}::${schema}`;
  if (!force && state.sqlMeta.key === key && state.sqlMeta.ready) {
    return state.sqlMeta;
  }
  if (state.sqlMeta.loading && state.sqlMeta.key === key && !force) return state.sqlMeta;

  state.sqlMeta = {
    key,
    tables: state.sqlMeta.key === key ? (state.sqlMeta.tables || []) : [],
    views: state.sqlMeta.key === key ? (state.sqlMeta.views || []) : [],
    columnsByTable: state.sqlMeta.key === key ? (state.sqlMeta.columnsByTable || {}) : {},
    loading: true,
    ready: false,
  };

  try {
    const base = withConnectionId(`/api/databases/${encodeURIComponent(schema)}`, cid);
    const [tables, views] = await Promise.all([
      api(`${base}/tables`).catch(() => []),
      api(`${base}/views`).catch(() => []),
    ]);
    if (sqlMetaCacheKey() !== key) return state.sqlMeta;
    state.sqlMeta.tables = Array.isArray(tables) ? tables : [];
    state.sqlMeta.views = Array.isArray(views) ? views : [];
    if (state.currentTable && state.columns?.length) {
      state.sqlMeta.columnsByTable[state.currentTable] = state.columns.map((c) => c.name).filter(Boolean);
    }
    state.sqlMeta.ready = true;
  } catch (e) {
    console.error(e);
  } finally {
    if (state.sqlMeta.key === key) state.sqlMeta.loading = false;
    refreshSqlHighlight();
  }
  return state.sqlMeta;
}

async function ensureSqlTableColumns(table) {
  if (!table) return [];
  const schema = sqlListSchema();
  const cid = state.activeConnectionId;
  if (!cid || !schema) return [];
  const cached = state.sqlMeta.columnsByTable?.[table];
  if (cached) return cached;
  try {
    const cols = await api(withConnectionId(
      `/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/columns`,
      cid
    ));
    const names = (Array.isArray(cols) ? cols : []).map((c) => c.name || c).filter(Boolean);
    if (!state.sqlMeta.columnsByTable) state.sqlMeta.columnsByTable = {};
    state.sqlMeta.columnsByTable[table] = names;
    refreshSqlHighlight();
    return names;
  } catch {
    return [];
  }
}

function tablesReferencedInSql(sql) {
  const names = new Set();
  const re = /\b(?:from|join|update|into|table)\s+([`"\[]?)([A-Za-z_][\w$]*)\1/gi;
  let m;
  while ((m = re.exec(sql || ""))) {
    names.add(m[2]);
  }
  if (state.currentTable) names.add(state.currentTable);
  return [...names];
}

function closeSqlSuggest() {
  state.sqlSuggest = { open: false, items: [], index: 0, start: 0, end: 0 };
  const box = $("#sql-suggest");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
}

function renderSqlSuggest() {
  const box = $("#sql-suggest");
  const editor = getSqlEditor();
  if (!box || !editor) return;
  const { open, items, index } = state.sqlSuggest;
  if (!open || !items.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = items.map((item, i) => (
    `<button type="button" class="sql-suggest-item${i === index ? " active" : ""}" data-idx="${i}" role="option" aria-selected="${i === index}">`
    + `<span class="sql-suggest-label">${escapeHtml(item.label)}</span>`
    + `<span class="sql-suggest-kind">${escapeHtml(item.kind)}</span>`
    + `</button>`
  )).join("");

  // Position near caret (approximate via line/col).
  const { line, col } = sqlLineColAt(editor.value || "", state.sqlSuggest.start);
  const style = getComputedStyle(editor);
  const lineHeight = parseFloat(style.lineHeight) || 18;
  const padTop = parseFloat(style.paddingTop) || 0;
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const charW = (() => {
    // Rough monospace width from font-size.
    return (parseFloat(style.fontSize) || 13) * 0.62;
  })();
  const gutter = $("#sql-gutter");
  const gutterW = gutter ? gutter.getBoundingClientRect().width : 0;
  const top = padTop + (line * lineHeight) - editor.scrollTop + 4;
  const left = gutterW + padLeft + ((col - 1) * charW) - editor.scrollLeft;
  box.style.top = `${Math.max(8, Math.min(top, editor.clientHeight - 24))}px`;
  box.style.left = `${Math.max(gutterW + 8, Math.min(left, (editor.parentElement?.clientWidth || 300) - 40))}px`;

  const active = box.querySelector(".sql-suggest-item.active");
  active?.scrollIntoView({ block: "nearest" });
}

function acceptSqlSuggest(idx = state.sqlSuggest.index) {
  const editor = getSqlEditor();
  const item = state.sqlSuggest.items[idx];
  if (!editor || !item) return;
  const { start, end } = state.sqlSuggest;
  const insert = item.insert ?? item.label;
  const value = editor.value;
  editor.value = value.slice(0, start) + insert + value.slice(end);
  let caret = start + insert.length;
  // Place caret inside function parens: COUNT()
  if (insert.endsWith("()")) caret -= 1;
  editor.setSelectionRange(caret, caret);
  closeSqlSuggest();
  refreshSqlEditorUi();
  editor.focus();
}

async function updateSqlSuggest({ force = false } = {}) {
  const editor = getSqlEditor();
  if (!editor) return;
  const value = editor.value || "";
  const caret = editor.selectionStart ?? 0;
  if (editor.selectionStart !== editor.selectionEnd && !force) {
    closeSqlSuggest();
    return;
  }

  await ensureSqlMeta();

  // Word / table.column prefix before caret.
  const before = value.slice(0, caret);
  const m = before.match(/(?:([A-Za-z_][\w$]*)\.)?([A-Za-z_][\w$]*)$/);
  if (!m && !force) {
    closeSqlSuggest();
    return;
  }
  const tableRef = m?.[1] || "";
  const prefix = (m?.[2] || "");
  const start = caret - prefix.length - (tableRef ? tableRef.length + 1 : 0);
  const tokenStart = caret - prefix.length;
  const q = prefix.toLowerCase();

  if (!force && !tableRef && prefix.length < 1) {
    closeSqlSuggest();
    return;
  }

  const items = [];
  const pushUnique = (label, kind, insert = label, score = 0) => {
    if (items.some((x) => x.label === label && x.kind === kind)) return;
    items.push({ label, kind, insert, score });
  };

  if (tableRef) {
    // column completion for tableRef.
    const tableName = (state.sqlMeta.tables || []).find((t) => t.toLowerCase() === tableRef.toLowerCase())
      || (state.sqlMeta.views || []).find((t) => t.toLowerCase() === tableRef.toLowerCase())
      || tableRef;
    const cols = await ensureSqlTableColumns(tableName);
    for (const col of cols) {
      if (!q || col.toLowerCase().startsWith(q) || col.toLowerCase().includes(q)) {
        pushUnique(col, "col", col, col.toLowerCase().startsWith(q) ? 2 : 1);
      }
    }
  } else {
    // Prefer tables/views after FROM/JOIN/UPDATE/INTO/TABLE.
    const head = before.slice(0, tokenStart);
    const afterObjectKw = /\b(from|join|update|into|table|references)\s+$/i.test(head);
    const afterSelectish = /\b(select|where|and|or|on|set|by|having|returning)\s+$/i.test(head)
      || /[,(]\s*$/.test(head);

    for (const t of state.sqlMeta.tables || []) {
      if (!q || t.toLowerCase().startsWith(q) || t.toLowerCase().includes(q)) {
        pushUnique(t, "table", t, (afterObjectKw ? 5 : 2) + (t.toLowerCase().startsWith(q) ? 1 : 0));
      }
    }
    for (const t of state.sqlMeta.views || []) {
      if (!q || t.toLowerCase().startsWith(q) || t.toLowerCase().includes(q)) {
        pushUnique(t, "view", t, (afterObjectKw ? 4 : 1) + (t.toLowerCase().startsWith(q) ? 1 : 0));
      }
    }

    // Columns from referenced tables / current table.
    const refs = tablesReferencedInSql(value);
    for (const tbl of refs) {
      const cols = state.sqlMeta.columnsByTable?.[tbl]
        || (tbl === state.currentTable ? (state.columns || []).map((c) => c.name) : null);
      if (!cols) {
        ensureSqlTableColumns(tbl); // warm cache async
        continue;
      }
      for (const col of cols) {
        if (!col) continue;
        if (!q || col.toLowerCase().startsWith(q) || col.toLowerCase().includes(q)) {
          pushUnique(col, "col", col, (afterSelectish ? 4 : 2) + (col.toLowerCase().startsWith(q) ? 1 : 0));
        }
      }
    }

    if (!afterObjectKw) {
      for (const kw of SQL_KEYWORDS) {
        if (q && kw.startsWith(q)) pushUnique(kw.toUpperCase(), "kw", kw.toUpperCase(), 1);
      }
      for (const fn of SQL_FUNCTIONS) {
        if (q && fn.startsWith(q)) pushUnique(`${fn.toUpperCase()}()`, "fn", `${fn.toUpperCase()}()`, 1);
      }
    }
  }

  items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const limited = items.slice(0, 40);
  if (!limited.length) {
    closeSqlSuggest();
    return;
  }

  state.sqlSuggest = {
    open: true,
    items: limited,
    index: 0,
    start: tableRef ? tokenStart : tokenStart,
    end: caret,
  };
  // When completing after table., only replace the column prefix.
  if (tableRef) {
    state.sqlSuggest.start = tokenStart;
  }
  renderSqlSuggest();
}

function handleSqlSuggestKeydown(e) {
  if (!state.sqlSuggest.open) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.sqlSuggest.index = (state.sqlSuggest.index + 1) % state.sqlSuggest.items.length;
    renderSqlSuggest();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    state.sqlSuggest.index = (state.sqlSuggest.index - 1 + state.sqlSuggest.items.length) % state.sqlSuggest.items.length;
    renderSqlSuggest();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    acceptSqlSuggest();
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeSqlSuggest();
    return true;
  }
  return false;
}

function handleSqlEditorKeydown(e) {
  const editor = getSqlEditor();
  if (!editor) return;

  if (handleSqlSuggestKeydown(e)) return;

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) {
    if (e.key === "Tab") {
      e.preventDefault();
      indentSqlSelection(e.shiftKey);
      return;
    }
    if (e.key === "Enter" && !e.altKey) {
      e.preventDefault();
      autoIndentSqlOnEnter();
      return;
    }
    if (e.key === "Escape" && !$("#sql-find-bar")?.hidden) {
      e.preventDefault();
      closeSqlFindBar();
    }
    return;
  }

  // Use e.code — more reliable than e.key in JavaFX WebView.
  if (e.code === "Equal" || e.code === "NumpadAdd" || e.key === "=" || e.key === "+") {
    e.preventDefault();
    bumpSqlEditorZoom(1);
    return;
  }
  if (e.code === "Minus" || e.code === "NumpadSubtract" || e.key === "-" || e.key === "_") {
    e.preventDefault();
    bumpSqlEditorZoom(-1);
    return;
  }
  if (e.code === "Digit0" || e.code === "Numpad0" || e.key === "0") {
    e.preventDefault();
    applySqlEditorZoom(100);
    return;
  }
  if (e.code === "Space" || e.key === " ") {
    e.preventDefault();
    updateSqlSuggest({ force: true });
    return;
  }
  if (e.code === "Slash" || e.key === "/") {
    e.preventDefault();
    toggleSqlLineComment();
    return;
  }
  if (e.code === "Enter" || e.key === "Enter") {
    e.preventDefault();
    if ($("#btn-run")?.disabled) return;
    runSql();
    return;
  }
  if (e.code === "KeyF" || e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSqlFindBar();
    return;
  }
  if (e.code === "KeyG" || e.key.toLowerCase() === "g") {
    e.preventDefault();
    if ($("#sql-find-bar")?.hidden) openSqlFindBar();
    else runSqlFind(e.shiftKey ? -1 : 1, { focusEditor: true });
    return;
  }
  if (e.code === "KeyS" || e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveSqlFile();
    return;
  }
  if (e.code === "KeyO" || e.key.toLowerCase() === "o") {
    e.preventDefault();
    loadSqlFile();
  }
}

function wireSqlGlobalShortcuts() {
  if (window.__sqlGlobalShortcutsWired) return;
  window.__sqlGlobalShortcutsWired = true;
  window.addEventListener("keydown", (e) => {
    if (!isSqlPanelActive()) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    const t = e.target;
    const id = t && t.id;
    const inLog = !!(t && (id === "sql-log-output" || t.closest?.("#sql-log")));
    const inFindInput = id === "sql-find-input" || id === "sql-log-find-input";

    if (e.code === "KeyF" || (e.key && e.key.toLowerCase() === "f")) {
      // Always handle find on the SQL panel (WebView often won't reach the textarea handler).
      if (inFindInput) return;
      e.preventDefault();
      e.stopPropagation();
      if (inLog) openSqlLogFindBar();
      else openSqlFindBar();
      return;
    }

    if (inFindInput || id === "sql-editor") return; // editor has its own handler

    if (e.code === "Equal" || e.code === "NumpadAdd" || e.key === "=" || e.key === "+") {
      e.preventDefault();
      bumpSqlEditorZoom(1);
    } else if (e.code === "Minus" || e.code === "NumpadSubtract" || e.key === "-" || e.key === "_") {
      e.preventDefault();
      bumpSqlEditorZoom(-1);
    } else if (e.code === "Digit0" || e.code === "Numpad0" || e.key === "0") {
      e.preventDefault();
      applySqlEditorZoom(100);
    }
  }, true);
}

function wireSqlEditor() {
  const editor = getSqlEditor();
  if (!editor || editor.dataset.sqlEditorWired === "1") return;
  editor.dataset.sqlEditorWired = "1";
  editor.addEventListener("keydown", handleSqlEditorKeydown);
  editor.addEventListener("input", () => {
    refreshSqlEditorUi();
    if (!$("#sql-find-bar")?.hidden) runSqlFind(0, { focusEditor: false });
    updateSqlSuggest().catch(() => {});
  });
  editor.addEventListener("scroll", syncSqlEditorScroll);
  editor.addEventListener("keyup", refreshSqlCursorStatus);
  editor.addEventListener("click", () => {
    refreshSqlEditorUi();
    closeSqlSuggest();
  });
  editor.addEventListener("select", refreshSqlCursorStatus);
  editor.addEventListener("blur", () => {
    setTimeout(() => {
      if (!$("#sql-suggest")?.matches(":hover")) closeSqlSuggest();
    }, 150);
  });
  editor.addEventListener("focus", () => {
    ensureSqlMeta().catch(() => {});
  });
  editor.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    bumpSqlEditorZoom(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  $("#sql-suggest")?.addEventListener("mousedown", (e) => {
    const btn = e.target.closest(".sql-suggest-item");
    if (!btn) return;
    e.preventDefault();
    acceptSqlSuggest(Number(btn.dataset.idx));
  });
  wireSqlGlobalShortcuts();
  applySqlEditorZoom(loadPrefs().sqlEditorZoom ?? 100, { persist: false });
  refreshSqlEditorUi();
}

function setSqlEditorContent(sql, fileName = null, filePath = null) {
  const editor = getSqlEditor();
  if (!editor) return;
  setSqlEditorValue(sql ?? "");
  state.sqlFileName = fileName || null;
  state.sqlFilePath = filePath || null;
  updateSqlFileChip(state.sqlFileName);
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (tab) {
    tab.sql = editor.value;
    tab.sqlFileName = state.sqlFileName;
    tab.sqlFilePath = state.sqlFilePath;
    if (tab.source === "file" && state.sqlFileName) {
      tab.title = state.sqlFileName;
      renderWorkspaceTabs();
    }
  }
}

function suggestedSqlFileName() {
  if (state.sqlFileName) return state.sqlFileName;
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (tab?.sqlFileName) return tab.sqlFileName;
  const base = (tab?.table || tab?.schema || tab?.querySchema || tab?.database || tab?.queryDatabase || "query")
    .toString()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "query";
  return `${base}.sql`;
}

function sqlFileTabId(pathOrName) {
  return `sqlfile:${pathOrName || `untitled-${Date.now()}`}`;
}

/** Open one SQL file as its own workspace tab. */
async function openSqlFileTab(file, {
  activate = true,
  connectionId = null,
  database = "",
  schema = "",
} = {}) {
  if (!file || file.base64) return null;
  const cid = connectionId || state.activeConnectionId;
  const name = file.name || "query.sql";
  const path = file.path || name;
  const id = sqlFileTabId(path);
  const profile = profileById(cid);
  const dbName = database
    || state.detailFocus?.database
    || profileDatabaseName(cid)
    || "";
  const schName = schema
    || (isThreeLayerProfile(profile) ? (state.detailFocus?.schema || "") : "")
    || "";

  let tab = state.workspaceTabs.find((t) => t.id === id);
  if (!tab) {
    tab = {
      id,
      kind: "sql",
      source: "file",
      title: name,
      database: dbName,
      schema: schName,
      table: null,
      connectionId: cid,
      queryDatabase: dbName,
      querySchema: schName,
      sqlFileName: name,
      sqlFilePath: file.path || null,
      closable: true,
      pinned: false,
      viewMode: "sql",
      sql: file.content ?? "",
    };
    state.workspaceTabs.push(tab);
  } else {
    tab.sql = file.content ?? tab.sql;
    tab.sqlFileName = name;
    tab.sqlFilePath = file.path || tab.sqlFilePath || null;
    tab.title = name;
    tab.connectionId = cid || tab.connectionId;
    tab.queryDatabase = dbName || tab.queryDatabase;
    tab.querySchema = schName || tab.querySchema;
    tab.database = dbName || tab.database;
    tab.schema = schName || tab.schema;
    tab.viewMode = "sql";
  }

  if (activate) {
    state.activeWorkspaceTabId = id;
    state.currentSchema = schName || null;
    state.currentTable = null;
    state.sqlFileName = tab.sqlFileName;
    state.sqlFilePath = tab.sqlFilePath;
    setDetailFocus({
      scope: schName ? "schema" : "database",
      schema: schName || null,
      database: dbName,
      connectionId: cid,
    });
    updateRunButton();
    renderWorkspaceTabs();
    await applyWorkspaceTab(id);
  }
  return tab;
}

async function openSqlFiles(files) {
  const list = (files || []).filter((f) => f && !f.error && !f.base64);
  if (!list.length) {
    const err = (files || []).find((f) => f?.error);
    if (err?.error) alert(err.error);
    else alert("No SQL text files selected");
    return;
  }
  snapshotActiveWorkspaceTab();
  let lastId = null;
  for (let i = 0; i < list.length; i++) {
    const tab = await openSqlFileTab(list[i], {
      activate: false,
      connectionId: state.activeConnectionId,
      database: state.detailFocus?.database || "",
      schema: isThreeLayerProfile(activeProfile())
        ? (state.detailFocus?.scope === "schema" ? (state.detailFocus.schema || "") : "")
        : "",
    });
    if (tab) lastId = tab.id;
  }
  renderWorkspaceTabs();
  if (lastId) {
    state.activeWorkspaceTabId = lastId;
    await applyWorkspaceTab(lastId);
  }
  const names = list.map((f) => f.name || "file").join(", ");
  setStatus(list.length === 1
    ? `Loaded ${names}`
    : `Loaded ${list.length} SQL files`);
  switchTab("sql");
}

function applyLoadedSqlFile(payload) {
  if (!payload) return;
  if (payload.error) {
    alert(payload.error);
    return;
  }
  if (payload.base64) {
    alert("Binary files cannot be loaded into the SQL editor. Choose a .sql or .txt file.");
    return;
  }
  openSqlFiles([payload]).catch((e) => alert(e.message || "Failed to open SQL file"));
}

function loadSqlFile() {
  try {
    if (window.javaApp && typeof window.javaApp.pickSqlFiles === "function") {
      const raw = window.javaApp.pickSqlFiles();
      if (!raw) return;
      const payload = JSON.parse(raw);
      if (payload.error) {
        alert(payload.error);
        return;
      }
      const files = Array.isArray(payload.files) ? payload.files : [payload];
      openSqlFiles(files).catch((e) => alert(e.message || "Failed to open SQL files"));
      return;
    }
    if (window.javaApp && typeof window.javaApp.pickSqlFile === "function") {
      const raw = window.javaApp.pickSqlFile();
      if (!raw) return;
      applyLoadedSqlFile(JSON.parse(raw));
      return;
    }
  } catch (e) {
    alert(e.message || "Failed to open SQL file");
    return;
  }
  // Browser / fallback: hidden multi file input
  const input = $("#sql-file-input");
  if (!input) {
    alert("File picker unavailable");
    return;
  }
  input.value = "";
  input.click();
}

function onSqlFileInputChange(e) {
  const files = [...(e.target?.files || [])];
  if (!files.length) return;
  Promise.all(files.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, content: String(reader.result ?? "") });
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsText(file);
  })))
    .then((loaded) => openSqlFiles(loaded))
    .catch((err) => alert(err.message || "Failed to read SQL files"));
}

function collectSqlFindMatches(text, query, matchCase) {
  if (!query) return [];
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  const matches = [];
  let from = 0;
  while (from <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    matches.push(idx);
    from = idx + Math.max(1, needle.length);
  }
  return matches;
}

function updateSqlFindCount(current, total) {
  const el = $("#sql-find-count");
  if (!el) return;
  if (!total) {
    el.textContent = "0 / 0";
    el.classList.toggle("sql-find-empty", !!($("#sql-find-input")?.value || "").trim());
  } else {
    el.textContent = `${current + 1} / ${total}`;
    el.classList.remove("sql-find-empty");
  }
}

function selectSqlFindMatch(start, length, { focusEditor = false } = {}) {
  const editor = getSqlEditor();
  if (!editor || start < 0) return;
  if (focusEditor) editor.focus();
  try {
    editor.setSelectionRange(start, start + length);
  } catch {
    /* ignore */
  }
  // Keep the match in view when possible.
  try {
    const before = editor.value.slice(0, start);
    const lines = before.split("\n").length;
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 18;
    editor.scrollTop = Math.max(0, (lines - 3) * lineHeight);
    syncSqlEditorScroll();
  } catch {
    /* ignore */
  }
  refreshSqlHighlight();
  refreshSqlGutter();
  refreshSqlCursorStatus();
}

function runSqlFind(direction = 0, { focusEditor = false } = {}) {
  const editor = getSqlEditor();
  const input = $("#sql-find-input");
  if (!editor || !input) return;
  const query = input.value || "";
  const matchCase = !!$("#sql-find-case")?.checked;
  const matches = collectSqlFindMatches(editor.value, query, matchCase);
  if (!matches.length) {
    state.sqlFindIndex = -1;
    updateSqlFindCount(-1, 0);
    refreshSqlHighlight();
    return;
  }

  let idx = state.sqlFindIndex;
  if (direction === 0) {
    const caret = editor.selectionStart || 0;
    idx = matches.findIndex((m) => m >= caret);
    if (idx < 0) idx = 0;
  } else if (direction > 0) {
    idx = (idx + 1 + matches.length) % matches.length;
  } else {
    idx = (idx - 1 + matches.length) % matches.length;
  }
  state.sqlFindIndex = idx;
  updateSqlFindCount(idx, matches.length);
  selectSqlFindMatch(matches[idx], query.length, { focusEditor: focusEditor || direction !== 0 });
}

function openSqlFindBar(seed = "") {
  const bar = $("#sql-find-bar");
  const input = $("#sql-find-input");
  const editor = getSqlEditor();
  if (!bar || !input) return;
  // Ensure SQL panel is visible for SQL workspace tabs.
  if (!isSqlPanelActive() && activeWorkspaceTab()?.kind === "sql") switchTab("sql");
  bar.hidden = false;
  bar.removeAttribute("hidden");
  if (seed) {
    input.value = seed;
  } else if (editor) {
    const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (selected && !selected.includes("\n")) input.value = selected;
  }
  // Focus find box on next tick so WebView reliably accepts it.
  setTimeout(() => {
    input.focus();
    input.select();
    runSqlFind(0, { focusEditor: false });
  }, 0);
}

function closeSqlFindBar() {
  const bar = $("#sql-find-bar");
  if (bar) {
    bar.hidden = true;
    bar.setAttribute("hidden", "");
  }
  state.sqlFindIndex = -1;
  updateSqlFindCount(-1, 0);
  refreshSqlHighlight();
  getSqlEditor()?.focus();
}

function saveSqlFile() {
  const sql = $("#sql-editor")?.value ?? "";
  if (!sql.trim()) {
    alert("SQL editor is empty");
    return;
  }
  const suggested = suggestedSqlFileName();
  try {
    if (window.javaApp && typeof window.javaApp.saveSqlFile === "function") {
      const raw = window.javaApp.saveSqlFile(suggested, sql);
      if (!raw) return;
      const payload = JSON.parse(raw);
      if (payload.error) {
        alert(payload.error);
        return;
      }
      state.sqlFileName = payload.name || suggested;
      state.sqlFilePath = payload.path || state.sqlFilePath;
      updateSqlFileChip(state.sqlFileName);
      const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
      if (tab) {
        tab.sql = sql;
        tab.sqlFileName = state.sqlFileName;
        tab.sqlFilePath = state.sqlFilePath;
        if (tab.source === "file" || tab.kind === "sql") {
          tab.title = state.sqlFileName;
          tab.source = tab.source || "file";
          renderWorkspaceTabs();
        }
      }
      setStatus(`Saved ${state.sqlFileName}`);
      return;
    }
  } catch (e) {
    alert(e.message || "Failed to save SQL file");
    return;
  }
  // Browser fallback: download
  const blob = new Blob([sql], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggested;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  state.sqlFileName = suggested;
  updateSqlFileChip(state.sqlFileName);
  setStatus(`Saved ${suggested}`);
}

function addCreateTableColumnRow(defaults = {}) {
  const row = document.createElement("div");
  row.className = "col-row";
  row.innerHTML = `
    <input class="input col-name" placeholder="name" value="${escapeHtml(defaults.name || "")}" required />
    <input class="input col-type" placeholder="VARCHAR(255)" value="${escapeHtml(defaults.sqlType || "VARCHAR(255)")}" />
    <label class="check"><input type="checkbox" class="col-null" ${defaults.nullable === false ? "" : "checked"} /> Null</label>
    <label class="check"><input type="checkbox" class="col-pk" ${defaults.primaryKey ? "checked" : ""} /> PK</label>
    <label class="check"><input type="checkbox" class="col-ai" ${defaults.autoIncrement ? "checked" : ""} /> AI</label>
    <button type="button" class="btn ghost sm col-remove">✕</button>
  `;
  row.querySelector(".col-remove").onclick = () => row.remove();
  $("#create-table-cols").appendChild(row);
}

function openCreateTableModal(schema) {
  hideAllContextMenus();
  $("#create-table-schema").value = schema;
  $("#form-create-table").name.value = "";
  $("#create-table-cols").innerHTML = "";
  addCreateTableColumnRow({ name: "id", sqlType: "INTEGER", nullable: false, primaryKey: true, autoIncrement: true });
  addCreateTableColumnRow({ name: "name", sqlType: "VARCHAR(255)", nullable: true });
  $("#modal-create-table").showModal();
}

function openCreateViewModal(schema) {
  hideAllContextMenus();
  const form = $("#form-create-view");
  form.reset();
  $("#create-view-schema").value = schema;
  $("#modal-create-view").showModal();
}

async function openIndexesModal(schema, table) {
  hideAllContextMenus();
  $("#indexes-title").textContent = `Indexes · ${schema}.${table}`;
  $("#index-schema").value = schema;
  $("#index-table").value = table;
  $("#form-create-index").reset();
  $("#index-schema").value = schema;
  $("#index-table").value = table;
  await refreshIndexesList(schema, table);
  $("#modal-indexes").showModal();
}

async function refreshIndexesList(schema, table) {
  const list = $("#indexes-list");
  list.innerHTML = `<div class="hint">Loading…</div>`;
  try {
    const indexes = await api(`/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/indexes`);
    list.innerHTML = "";
    if (!indexes.length) {
      list.innerHTML = `<div class="profile-empty">No indexes found.</div>`;
      return;
    }
    for (const idx of indexes) {
      const item = document.createElement("div");
      item.className = "index-item";
      const cols = Array.isArray(idx.columns) ? idx.columns.join(", ") : "";
      item.innerHTML = `<div><strong>${escapeHtml(idx.name)}</strong><div class="profile-detail">${idx.unique ? "UNIQUE · " : ""}${escapeHtml(cols)}</div></div>`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn ghost sm danger";
      del.textContent = "Drop";
      del.onclick = async () => {
        if (!confirm(`Drop index “${idx.name}”?`)) return;
        await api(`/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/indexes/${encodeURIComponent(idx.name)}`, { method: "DELETE" });
        await refreshIndexesList(schema, table);
        setStatus(`Dropped index ${idx.name}`);
      };
      item.appendChild(del);
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="error-text">${escapeHtml(e.message)}</div>`;
  }
}

function openAddColumnModal(schema, table) {
  hideAllContextMenus();
  const form = $("#form-add-column");
  form.reset();
  $("#add-col-schema").value = schema;
  $("#add-col-table").value = table;
  form.sqlType.value = "VARCHAR(255)";
  form.nullable.checked = true;
  $("#modal-add-column").showModal();
}

async function downloadExportPayload(payload) {
  let blob;
  if (payload.base64) {
    const bin = atob(payload.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: payload.contentType || "application/octet-stream" });
  } else {
    blob = new Blob([payload.content], { type: payload.contentType || "text/plain" });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = payload.filename || "export";
  a.click();
  URL.revokeObjectURL(url);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function handleContextAction(action) {
  const target = state.contextTarget || {};
  const schema = target.schema || state.contextDb;
  try {
    switch (action) {
      case "conn-connect":
        hideAllContextMenus();
        if (target.profile) {
          state.pendingExpandProfileId = target.profile.id;
          await accessConnection(target.profile);
        }
        break;
      case "conn-disconnect":
        hideAllContextMenus();
        await disconnectCurrent(target.profile?.id);
        break;
      case "conn-edit":
        hideAllContextMenus();
        if (target.profile) openEditConnection(target.profile);
        break;
      case "conn-delete":
        hideAllContextMenus();
        if (target.profile) await deleteConnection(target.profile);
        break;
      case "conn-properties":
        if (target.profile) await openConnectionProperties(target.profile);
        break;
      case "properties":
        await openDatabaseProperties(schema);
        break;
      case "create-db":
        if (target.profile) {
          state.activeConnectionId = target.profile.id;
          await api("/api/session/active", {
            method: "POST",
            body: JSON.stringify({ id: target.profile.id }),
          }).catch(() => {});
        }
        openCreateDatabaseModal();
        break;
      case "create-schema":
        if (target.profile) {
          state.activeConnectionId = target.profile.id;
          await api("/api/session/active", {
            method: "POST",
            body: JSON.stringify({ id: target.profile.id }),
          }).catch(() => {});
        }
        hideAllContextMenus();
        $("#form-schema").reset();
        $("#modal-schema").showModal();
        break;
      case "modify-db":
        openModifyDatabaseModal(schema);
        break;
      case "clone-db":
        openCloneModal(schema);
        break;
      case "export-db":
        openExportModal({ schema, scope: "database" });
        break;
      case "import-sql":
        if (target.profile) {
          state.activeConnectionId = target.profile.id;
          await api("/api/session/active", {
            method: "POST",
            body: JSON.stringify({ id: target.profile.id }),
          }).catch(() => {});
        }
        openImportModal({ schema: schema || "", mode: "sql" });
        break;
      case "drop-db":
        hideAllContextMenus();
        if (!confirm(`Drop database “${schema}”? This cannot be undone.`)) return;
        await api(`/api/databases/${encodeURIComponent(schema)}`, { method: "DELETE" });
        await loadTree();
        setStatus(`Dropped database ${schema}`);
        break;
      case "drop-schema":
        hideAllContextMenus();
        if (!confirm(`Drop schema “${schema}”? This cannot be undone.`)) return;
        await api(`/api/schemas/${encodeURIComponent(schema)}`, { method: "DELETE" });
        await loadTree();
        setStatus(`Dropped schema ${schema}`);
        break;
      case "create-table":
        if (!schema) {
          alert("Select a database/schema first");
          return;
        }
        openCreateTableModal(schema);
        break;
      case "create-view":
        if (!schema) {
          alert("Select a database/schema first");
          return;
        }
        openCreateViewModal(schema);
        break;
      case "import-table":
        if (target.type === "table") {
          openImportModal({ schema: target.schema, table: target.table, mode: "table" });
        } else {
          const table = prompt("Import into which table?");
          if (!table) return;
          openImportModal({ schema, table, mode: "table" });
        }
        break;
      case "ws-pin":
        hideAllContextMenus();
        if (target.tabId) setWorkspaceTabPinned(target.tabId, true);
        break;
      case "ws-unpin":
        hideAllContextMenus();
        if (target.tabId) setWorkspaceTabPinned(target.tabId, false);
        break;
      case "ws-close":
        hideAllContextMenus();
        if (target.tabId) closeWorkspaceTab(target.tabId);
        break;
      case "open-sql": {
        hideAllContextMenus();
        const three = isThreeLayerProfile(activeProfile());
        const dbName = target.database
          || (target.kind === "database" ? target.schema : null)
          || (!three ? target.schema : null)
          || profileDatabaseName(state.activeConnectionId)
          || "";
        const schemaName = three
          ? (target.kind === "schema" || target.type === "table" || target.type === "view"
            ? (target.schema || "")
            : "")
          : "";
        await openSqlEditor({
          connectionId: state.activeConnectionId,
          database: dbName,
          schema: schemaName,
          table: target.table || target.view || null,
        });
        break;
      }
      case "open-table":
        hideAllContextMenus();
        await openTable(target.schema, target.table, state.activeConnectionId, target.database);
        break;
      case "export-table":
        openExportModal({ schema: target.schema, table: target.table, scope: "table" });
        break;
      case "manage-indexes":
        await openIndexesModal(target.schema, target.table);
        break;
      case "add-column":
        openAddColumnModal(target.schema, target.table);
        break;
      case "rename-table": {
        hideAllContextMenus();
        const newName = prompt("New table name:", target.table);
        if (!newName || newName === target.table) return;
        await api(`/api/databases/${encodeURIComponent(target.schema)}/tables/${encodeURIComponent(target.table)}/rename`, {
          method: "POST",
          body: JSON.stringify({ newName }),
        });
        await loadTree();
        setStatus(`Renamed to ${newName}`);
        break;
      }
      case "drop-table":
        hideAllContextMenus();
        if (!confirm(`Drop table “${target.schema}.${target.table}”?`)) return;
        await api(`/api/databases/${encodeURIComponent(target.schema)}/tables/${encodeURIComponent(target.table)}`, { method: "DELETE" });
        await loadTree();
        setStatus(`Dropped table ${target.table}`);
        break;
      case "open-view":
        hideAllContextMenus();
        await openTable(target.schema, target.view);
        break;
      case "drop-view":
        hideAllContextMenus();
        if (!confirm(`Drop view “${target.schema}.${target.view}”?`)) return;
        await api(`/api/databases/${encodeURIComponent(target.schema)}/views/${encodeURIComponent(target.view)}`, { method: "DELETE" });
        await loadTree();
        setStatus(`Dropped view ${target.view}`);
        break;
      default:
        break;
    }
  } catch (e) {
    alert(e.message);
  }
}

function folder(label, badge, schema, items, kind, connectionId, database = null) {
  const wrap = document.createElement("div");
  wrap.className = "tree-node";
  const row = document.createElement("div");
  row.className = "tree-row";
  row.innerHTML = `<span class="badge ${badge}">${badge.toUpperCase()}</span><span class="tree-label">${label} (${items.length})</span>`;
  if (kind === "table" || kind === "view") {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "tree-more";
    more.title = `${label} actions`;
    more.textContent = "⋯";
    more.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = more.getBoundingClientRect();
      if (connectionId) state.activeConnectionId = connectionId;
      showFolderContextMenu(rect.left, rect.bottom + 4, schema, kind);
    };
    row.appendChild(more);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (connectionId) state.activeConnectionId = connectionId;
      showFolderContextMenu(e.clientX, e.clientY, schema, kind);
    };
  }
  const kids = document.createElement("div");
  kids.className = "tree-children";
  kids.hidden = true;
  row.onclick = (e) => {
    if (e.target.closest(".tree-more")) return;
    e.stopPropagation();
    kids.hidden = !kids.hidden;
  };
  for (const name of items) {
    const item = document.createElement("div");
    item.className = "tree-row";
    item.innerHTML = `<span class="tree-label">${escapeHtml(name)}</span>`;
    if (kind === "table" || kind === "view") {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "tree-more";
      more.title = "Actions";
      more.textContent = "⋯";
      more.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = more.getBoundingClientRect();
        if (connectionId) state.activeConnectionId = connectionId;
        if (kind === "table") showTableContextMenu(rect.left, rect.bottom + 4, schema, name, database);
        else showViewContextMenu(rect.left, rect.bottom + 4, schema, name, database);
      };
      item.appendChild(more);
      item.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (connectionId) state.activeConnectionId = connectionId;
        if (kind === "table") showTableContextMenu(e.clientX, e.clientY, schema, name, database);
        if (kind === "view") showViewContextMenu(e.clientX, e.clientY, schema, name, database);
      };
    }
    item.onclick = async (e) => {
      if (e.target.closest(".tree-more")) return;
      e.stopPropagation();
      $$(".tree-row.active").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      if (kind === "table" || kind === "view") {
        if (connectionId) {
          state.activeConnectionId = connectionId;
          await api("/api/session/active", {
            method: "POST",
            body: JSON.stringify({ id: connectionId }),
          }).catch(() => {});
        }
        await openTable(schema, name, connectionId, database);
      }
    };
    kids.appendChild(item);
  }
  if (!items.length) {
    kids.innerHTML = `<div class="hint" style="padding:.35rem">(empty)</div>`;
  }
  wrap.append(row, kids);
  return wrap;
}

function tableTabId(schema, table, connectionId) {
  return `table:${connectionId || state.activeConnectionId || ""}:${schema}.${table}`;
}

function activeProfile() {
  const id = state.activeConnectionId || state.selectedProfileId;
  if (!id) return null;
  return state.profiles.find((p) => p.id === id) || null;
}

function profileById(id) {
  if (!id) return activeProfile();
  return state.profiles.find((p) => p.id === id) || null;
}

function profileDatabaseName(connectionId) {
  const profile = profileById(connectionId || state.activeConnectionId);
  if (!profile?.database) return "";
  return profile.fileBased || ["SQLITE", "H2_FILE"].includes(profile.dbType)
    ? fileBaseName(profile.database)
    : profile.database;
}

function isThreeLayerProfile(profile) {
  if (!profile) return false;
  return profile.connectionMode === "THREE_LAYER"
    || ["POSTGRESQL", "H2", "H2_FILE"].includes(profile.dbType);
}

/** Hover tooltip — MySQL: connection · database; PostgreSQL: connection · database · schema */
function workspaceTabTooltip(tab) {
  const profile = profileById(tab.connectionId || state.activeConnectionId);
  const connName = (profile?.name || "").trim() || profile?.displayType || "Connection";
  const threeLayer = !!(profile && (isThreeLayerProfile(profile) || profile.dbType === "POSTGRESQL"));
  const mysqlLike = !!(profile && (profile.dbType === "MYSQL" || (!threeLayer && !profile.fileBased)));

  let schema = "";
  if (tab.kind === "table") {
    schema = tab.schema || "";
  } else {
    const focus = tab.detailFocus || state.detailFocus || {};
    if (focus.scope === "schema" || focus.scope === "table") {
      schema = focus.schema || "";
    }
  }

  // MySQL 2-layer: schema slot is the database name.
  const database = tab.database
    || tab.detailFocus?.database
    || (mysqlLike || !threeLayer ? (schema || profileDatabaseName(tab.connectionId)) : "")
    || profileDatabaseName(tab.connectionId || state.activeConnectionId)
    || "";

  if (tab.kind === "sql") {
    if (tab.source === "file" || tab.sqlFileName) {
      const tip = [connName, tab.sqlFileName || tab.title].filter(Boolean).join(" · ");
      return tab.sqlFilePath ? `${tip}\n${tab.sqlFilePath}` : tip;
    }
    const db = tab.queryDatabase || tab.database || database;
    const sch = tab.querySchema || tab.schema || schema;
    if (threeLayer) {
      return [connName, db, sch].filter(Boolean).join(" · ");
    }
    return [connName, db || sch].filter(Boolean).join(" · ");
  }

  if (threeLayer) {
    const parts = [connName];
    if (database) parts.push(database);
    if (schema && schema !== database) parts.push(schema);
    return parts.join(" · ");
  }

  // MySQL / 2-layer: connection · database
  if (mysqlLike || profile?.dbType === "MYSQL" || tab.kind === "table" || tab.kind === "context") {
    const parts = [connName];
    if (database) parts.push(database);
    return parts.join(" · ");
  }

  return tab.title || connName;
}

/** Label for the DB/SCH context tab. */
function contextTabTitle(focus = state.detailFocus) {
  const f = focus || {};
  if (f.scope === "schema" && f.schema) return f.schema;
  if (f.scope === "database" && f.database) return f.database;
  if (f.scope === "table" && f.schema) return f.schema;
  const profile = profileById(f.connectionId) || activeProfile();
  if (profile) {
    if (profile.database) {
      return profile.fileBased || ["SQLITE", "H2_FILE"].includes(profile.dbType)
        ? fileBaseName(profile.database)
        : profile.database;
    }
    return profile.name || profile.displayType || "Database";
  }
  return "Database";
}

function contextTabBadge(tab) {
  if (tab.kind === "table") return "TBL";
  if (tab.kind === "sql") return tab.source === "file" || tab.sqlFileName ? "FILE" : "SQL";
  const scope = tab.detailFocus?.scope || tab.scope;
  if (scope === "schema") return "SCH";
  return "DB";
}

/** Visible title in the workspace tab bar. */
function workspaceTabLabel(tab) {
  if (!tab) return "Tab";
  if (tab.source === "file" || tab.sqlFileName) {
    return tab.sqlFileName || tab.title || "query.sql";
  }
  if (tab.kind === "sql") {
    if (tab.table) return tab.table;
    return tab.title || tab.querySchema || tab.queryDatabase || "Query";
  }
  if (tab.kind === "table") return tab.table || tab.title || "Table";
  return tab.title || contextTabTitle(tab.detailFocus) || "Database";
}

function removeContextTabs() {
  // Keep pinned DB/SCH tabs; drop unpinned context tabs when opening a table.
  state.workspaceTabs = state.workspaceTabs.filter(
    (t) => ((t.kind !== "context" && t.kind !== "home") || t.pinned)
  );
}

function sortWorkspaceTabs() {
  state.workspaceTabs.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
}

function setWorkspaceTabPinned(tabId, pinned) {
  const tab = state.workspaceTabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.pinned = !!pinned;
  tab.closable = !tab.pinned;
  sortWorkspaceTabs();
  renderWorkspaceTabs();
  setStatus(tab.pinned ? `Pinned “${tab.title}”` : `Unpinned “${tab.title}”`);
}

function showWsTabContextMenu(x, y, tab) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextTarget = { type: "wstab", tabId: tab.id };
  const menu = $("#ctx-menu-wstab");
  menu.querySelector('[data-action="ws-pin"]').hidden = !!tab.pinned;
  menu.querySelector('[data-action="ws-unpin"]').hidden = !tab.pinned;
  menu.querySelector('[data-action="ws-close"]').hidden = !!tab.pinned;
  positionContextMenu(menu, x, y);
}

function ensureContextTab(focus) {
  const normalized = {
    ...(focus || {}),
    connectionId: focus?.connectionId || state.activeConnectionId || null,
    database: focus?.database || profileDatabaseName(focus?.connectionId || state.activeConnectionId) || null,
  };
  let tab = state.workspaceTabs.find((t) => t.kind === "context" || t.id === "context" || t.id === "home");
  if (!tab) {
    tab = {
      id: "context",
      kind: "context",
      title: contextTabTitle(normalized),
      closable: true,
      pinned: false,
      viewMode: "details",
      connectionId: normalized.connectionId,
      database: normalized.database || "",
      detailFocus: { ...normalized },
    };
    // Context tab leads the bar (before any leftover table tabs).
    state.workspaceTabs.unshift(tab);
  } else {
    tab.id = "context";
    tab.kind = "context";
    tab.closable = !tab.pinned;
    tab.detailFocus = { ...normalized };
    tab.connectionId = normalized.connectionId;
    tab.database = normalized.database || "";
    tab.viewMode = "details";
    tab.title = contextTabTitle(normalized);
  }
  sortWorkspaceTabs();
  return tab;
}

function showEmptyWorkspace() {
  state.workspaceTabs = [];
  state.activeWorkspaceTabId = null;
  state.currentSchema = null;
  state.currentTable = null;
  state.columns = [];
  state.result = null;
  state.page = 1;
  state.hiddenColumns = {};
  state.columnFilters = {};
  closeColumnFilterPopup();
  updateRunButton();
  updateContextMeta("");
  closeColumnVisibilityMenu();
  updateClearFiltersButton();
  setSqlEditorContent("", null);
  $("#ddl-view").textContent = "Select a table to view DDL.";
  renderStructure([]);
  renderData(null);
  renderWorkspaceTabs();
  switchTab("details", { skipTitle: true });
}

function resetWorkspaceTabs() {
  showEmptyWorkspace();
}

function snapshotActiveWorkspaceTab() {
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (!tab) return;
  tab.viewMode = state.currentTab || "details";
  tab.schema = state.currentSchema;
  tab.table = state.currentTable;
  tab.connectionId = state.activeConnectionId;
  tab.database = state.detailFocus?.database || tab.database || profileDatabaseName(state.activeConnectionId);
  tab.columns = state.columns;
  tab.result = state.result;
  tab.page = state.page;
  tab.hiddenColumns = { ...(state.hiddenColumns || {}) };
  tab.columnFilters = { ...(state.columnFilters || {}) };
  tab.sql = $("#sql-editor")?.value ?? tab.sql;
  tab.sqlFileName = state.sqlFileName;
  tab.sqlFilePath = state.sqlFilePath;
  tab.ddl = $("#ddl-view")?.textContent ?? tab.ddl;
  tab.detailFocus = { ...(state.detailFocus || {}) };
  const ctx = readSqlContextFromUi();
  tab.queryDatabase = ctx.database;
  tab.querySchema = ctx.schema;
  if (tab.kind === "sql") {
    tab.database = ctx.database || tab.database;
    tab.schema = ctx.schema || tab.schema;
  }
}

function closeWorkspaceTabsOverflowMenu() {
  const menu = $("#ws-tabs-overflow-menu");
  const btn = $("#ws-tabs-more");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function toggleWorkspaceTabsOverflowMenu() {
  const menu = $("#ws-tabs-overflow-menu");
  const btn = $("#ws-tabs-more");
  if (!menu || !btn || btn.hidden) return;
  if (!menu.hidden) {
    closeWorkspaceTabsOverflowMenu();
    return;
  }
  // Ensure items exist before opening (e.g. after a partial layout).
  if (!menu.childElementCount) layoutWorkspaceTabOverflow({ keepMenuOpen: false });
  if (!menu.childElementCount) return;
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
}

function layoutWorkspaceTabOverflow({ keepMenuOpen = false } = {}) {
  const root = $("#workspace-tabs");
  const moreBtn = $("#ws-tabs-more");
  const menu = $("#ws-tabs-overflow-menu");
  if (!root || !moreBtn || !menu) return;

  const wasOpen = keepMenuOpen && !menu.hidden;
  const tabs = [...root.querySelectorAll(".ws-tab")];
  tabs.forEach((t) => { t.hidden = false; });
  moreBtn.hidden = true;
  menu.hidden = true;
  menu.innerHTML = "";
  moreBtn.setAttribute("aria-expanded", "false");

  if (tabs.length <= 1) return;

  // Reserve space for the more button while measuring.
  moreBtn.hidden = false;
  moreBtn.textContent = "▾";
  const fits = () => root.scrollWidth <= root.clientWidth + 1;

  if (fits()) {
    moreBtn.hidden = true;
    return;
  }

  const overflow = [];
  // Hide trailing non-active tabs first, then leading ones, keep active visible.
  for (let i = tabs.length - 1; i >= 0 && !fits(); i--) {
    const tabEl = tabs[i];
    if (tabEl.classList.contains("active") || tabEl.hidden) continue;
    tabEl.hidden = true;
    overflow.unshift(tabEl);
  }
  for (let i = 0; i < tabs.length && !fits(); i++) {
    const tabEl = tabs[i];
    if (tabEl.classList.contains("active") || tabEl.hidden) continue;
    tabEl.hidden = true;
    overflow.push(tabEl);
  }

  if (!overflow.length) {
    moreBtn.hidden = true;
    return;
  }

  moreBtn.hidden = false;
  moreBtn.textContent = `▾ ${overflow.length}`;
  for (const tabEl of overflow) {
    const tabId = tabEl.dataset.tabId;
    const tab = state.workspaceTabs.find((t) => t.id === tabId);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ws-overflow-item" + (tabId === state.activeWorkspaceTabId ? " active" : "");
    item.role = "menuitem";
    item.innerHTML =
      `<span class="ws-overflow-kind">${escapeHtml(contextTabBadge(tab || {}))}</span>`
      + `<span class="ws-overflow-label">${escapeHtml(workspaceTabLabel(tab) || tabEl.textContent || "Tab")}</span>`;
    item.title = tab ? workspaceTabTooltip(tab) : "";
    item.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeWorkspaceTabsOverflowMenu();
      activateWorkspaceTab(tabId).catch((err) => alert(err.message));
    };
    menu.appendChild(item);
  }
  if (wasOpen) {
    menu.hidden = false;
    moreBtn.setAttribute("aria-expanded", "true");
  }
}

function renderWorkspaceTabs() {
  const root = $("#workspace-tabs");
  if (!root) return;
  closeWorkspaceTabsOverflowMenu();
  root.innerHTML = "";
  sortWorkspaceTabs();
  for (const tab of state.workspaceTabs) {
    // Keep file-tab titles synced to the file name.
    if ((tab.source === "file" || tab.sqlFileName) && tab.sqlFileName) {
      tab.title = tab.sqlFileName;
    }
    const canClose = !tab.pinned && tab.closable !== false;
    const label = workspaceTabLabel(tab);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-tab"
      + (tab.id === state.activeWorkspaceTabId ? " active" : "")
      + (canClose ? " closable" : "")
      + (tab.pinned ? " pinned" : "");
    btn.role = "tab";
    btn.dataset.tabId = tab.id;
    const tip = workspaceTabTooltip(tab);
    btn.title = tab.pinned ? `${tip} (pinned — double-click to unpin)` : `${tip} (double-click to pin)`;
    btn.innerHTML =
      `<span class="ws-tab-kind">${escapeHtml(contextTabBadge(tab))}</span>`
      + `<span class="ws-tab-label">${escapeHtml(label)}</span>`
      + `<span class="ws-tab-close" data-close-tab="${escapeHtml(tab.id)}" title="Close" aria-label="Close">×</span>`;
    btn.onclick = (e) => {
      const close = e.target.closest("[data-close-tab]");
      if (close) {
        e.preventDefault();
        e.stopPropagation();
        closeWorkspaceTab(close.dataset.closeTab);
        return;
      }
      activateWorkspaceTab(tab.id).catch((err) => alert(err.message));
    };
    btn.ondblclick = (e) => {
      if (e.target.closest("[data-close-tab]")) return;
      e.preventDefault();
      e.stopPropagation();
      setWorkspaceTabPinned(tab.id, !tab.pinned);
    };
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showWsTabContextMenu(e.clientX, e.clientY, tab);
    };
    btn.onauxclick = (e) => {
      if (e.button === 1 && canClose) {
        e.preventDefault();
        closeWorkspaceTab(tab.id);
      }
    };
    root.appendChild(btn);
  }
  requestAnimationFrame(() => layoutWorkspaceTabOverflow());
}

async function activateWorkspaceTab(tabId, { forceReload = false } = {}) {
  if (!tabId) return;
  const same = tabId === state.activeWorkspaceTabId;
  if (!same) {
    snapshotActiveWorkspaceTab();
  }
  const tab = state.workspaceTabs.find((t) => t.id === tabId);
  if (!tab) return;
  state.activeWorkspaceTabId = tabId;
  renderWorkspaceTabs();
  // Re-clicking the active workspace tab must not wipe query results / editor state.
  if (same && !forceReload) return;
  await applyWorkspaceTab(tabId, { forceReload });
}

async function applyWorkspaceTab(tabId, { forceReload = false } = {}) {
  if (!tabId) {
    showEmptyWorkspace();
    return;
  }
  const tab = state.workspaceTabs.find((t) => t.id === tabId);
  if (!tab) return;
  const epoch = ++state.workspaceApplyEpoch;

  if (tab.kind === "context" || tab.kind === "home") {
    state.currentSchema = null;
    state.currentTable = null;
    state.columns = [];
    state.page = tab.page || 1;
    state.hiddenColumns = { ...(tab.hiddenColumns || {}) };
    state.columnFilters = { ...(tab.columnFilters || {}) };
    closeColumnFilterPopup();
    closeColumnVisibilityMenu();
    updateClearFiltersButton();
    if (tab.detailFocus) state.detailFocus = { ...tab.detailFocus };
    tab.title = contextTabTitle(state.detailFocus);
    tab.queryDatabase = tab.queryDatabase
      || tab.detailFocus?.database
      || profileDatabaseName(tab.connectionId)
      || "";
    tab.querySchema = tab.querySchema
      ?? (tab.detailFocus?.scope === "schema" ? (tab.detailFocus.schema || "") : "");
    renderWorkspaceTabs();
    updateRunButton();
    setSqlEditorValue(tab.sql || "");
    state.sqlFileName = tab.sqlFileName || null;
    state.sqlFilePath = tab.sqlFilePath || null;
    updateSqlFileChip(state.sqlFileName);
    $("#ddl-view").textContent = tab.ddl || "Select a table to view DDL.";
    renderStructure([]);
    // Keep prior query results on DB/SCH tabs (do not wipe on re-apply).
    state.result = tab.result || null;
    switchTab(tab.viewMode || "details", { skipTitle: true });
    renderData(tab.result || null);
    updateContextMeta(tab.title || "");
    await refreshSqlContextUi();
    if (epoch !== state.workspaceApplyEpoch) return;
    // Re-assert editor/results in case an older refresh raced.
    if (tab.sql != null) setSqlEditorValue(tab.sql);
    if (tab.result) {
      state.result = tab.result;
      renderData(tab.result);
    }
    return;
  }

  if (tab.kind === "sql") {
    if (tab.connectionId) state.activeConnectionId = tab.connectionId;
    state.currentSchema = tab.schema || tab.querySchema || null;
    state.currentTable = tab.table || null;
    state.columns = [];
    state.hiddenColumns = { ...(tab.hiddenColumns || {}) };
    state.columnFilters = { ...(tab.columnFilters || {}) };
    closeColumnFilterPopup();
    closeColumnVisibilityMenu();
    updateClearFiltersButton();
    if (tab.source === "file" || tab.sqlFileName) {
      tab.title = tab.sqlFileName || tab.title || "query.sql";
    } else if (tab.table) {
      tab.title = tab.table;
    }
    setDetailFocus({
      scope: tab.table ? "table" : (tab.schema || tab.querySchema ? "schema" : "database"),
      schema: tab.schema || tab.querySchema || null,
      table: tab.table || null,
      database: tab.database || tab.queryDatabase || profileDatabaseName(tab.connectionId),
      connectionId: tab.connectionId,
    });
    updateRunButton();
    setSqlEditorValue(tab.sql || "");
    state.sqlFileName = tab.sqlFileName || null;
    state.sqlFilePath = tab.sqlFilePath || null;
    updateSqlFileChip(state.sqlFileName);
    $("#ddl-view").textContent = "Run a query to explore objects, or open a table for DDL.";
    renderStructure([]);
    state.result = tab.result || null;
    state.page = tab.page || 1;
    // SQL workspace tabs use the SQL panel (or Data for result grids).
    const mode = (tab.viewMode === "data" && tab.result) ? "data" : "sql";
    tab.viewMode = mode;
    switchTab(mode, { skipTitle: true });
    renderData(tab.result || null);
    await refreshSqlContextUi();
    if (epoch !== state.workspaceApplyEpoch) return;
    // File/query tabs: never let a stale refresh wipe the editor or result grid.
    if (tab.sql != null) setSqlEditorValue(tab.sql);
    if (tab.sqlFileName) {
      tab.title = tab.sqlFileName;
      state.sqlFileName = tab.sqlFileName;
      updateSqlFileChip(state.sqlFileName);
    } else if (tab.table) {
      tab.title = tab.table;
    }
    if (tab.result) {
      state.result = tab.result;
      renderData(tab.result);
    }
    return;
  }

  if (tab.connectionId) state.activeConnectionId = tab.connectionId;
  state.currentSchema = tab.schema;
  state.currentTable = tab.table;
  setDetailFocus({
    scope: "table",
    schema: tab.schema,
    table: tab.table,
    database: tab.database || profileDatabaseName(tab.connectionId),
    connectionId: tab.connectionId,
  });
  if (tab.queryDatabase == null) {
    tab.queryDatabase = tab.database || profileDatabaseName(tab.connectionId) || "";
  }
  if (tab.querySchema == null) {
    tab.querySchema = isThreeLayerProfile(profileById(tab.connectionId)) ? (tab.schema || "") : "";
  }
  updateRunButton();
  updateContextMeta(`${tab.schema} · ${tab.table}`);

  state.hiddenColumns = { ...(tab.hiddenColumns || {}) };
  state.columnFilters = { ...(tab.columnFilters || {}) };
  closeColumnFilterPopup();
  updateClearFiltersButton();

  const hasCache = !forceReload && tab.columns && tab.result;
  if (hasCache) {
    state.columns = tab.columns;
    state.result = tab.result;
    state.page = tab.page || 1;
    setSqlEditorValue(tab.sql || `SELECT * FROM ${quoteIdent(tab.table)} LIMIT ${Number($("#row-limit").value) || 1000}`);
    state.sqlFileName = tab.sqlFileName || null;
    state.sqlFilePath = tab.sqlFilePath || null;
    updateSqlFileChip(state.sqlFileName);
    $("#ddl-view").textContent = tab.ddl || "";
    renderStructure(tab.columns);
    renderData(tab.result);
    const cachedMode = tab.viewMode === "sql" || tab.viewMode === "ddl"
      ? (tab.viewMode === "ddl" ? "structure" : "data")
      : (tab.viewMode || "data");
    switchTab(cachedMode, { skipTitle: true });
    await refreshSqlContextUi();
    return;
  }

  await loadTableIntoActiveTab(tab);
  await refreshSqlContextUi();
}

function dataPageSize() {
  return Math.max(1, state.pageSize || 1000);
}

function usesServerTablePaging(result = state.result, tab = activeWorkspaceTab()) {
  if (!tab || tab.kind !== "table") return false;
  const tableTotal = Number(result?.totalRows);
  if (!Number.isFinite(tableTotal) || tableTotal < 0) return false;
  const loaded = result?.rows?.length || 0;
  const filtered = filteredRows(result).length;
  // Client filters apply only to the loaded page — keep paging local then.
  return filtered === loaded;
}

function tablePageSql(table, page, pageSize) {
  const offset = Math.max(0, (page - 1) * pageSize);
  if (offset > 0) {
    return `SELECT * FROM ${quoteIdent(table)} LIMIT ${pageSize} OFFSET ${offset}`;
  }
  return `SELECT * FROM ${quoteIdent(table)} LIMIT ${pageSize}`;
}

async function fetchTableRowsPage(tab, page) {
  const pageSize = dataPageSize();
  const offset = Math.max(0, (Math.max(1, page) - 1) * pageSize);
  const cid = tab.connectionId || state.activeConnectionId;
  const base = `/api/databases/${encodeURIComponent(tab.schema)}/tables/${encodeURIComponent(tab.table)}`;
  return api(withConnectionId(`${base}/rows?limit=${pageSize}&offset=${offset}`, cid));
}

async function loadTablePage(page) {
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (!tab || tab.kind !== "table") return;
  const pageSize = dataPageSize();
  const tableTotal = Number(tab.result?.totalRows);
  const totalPages = Number.isFinite(tableTotal) && tableTotal > 0
    ? Math.max(1, Math.ceil(tableTotal / pageSize))
    : 1;
  const next = Math.min(totalPages, Math.max(1, page));
  setStatus(`Loading page ${next}…`);
  try {
    const rows = await fetchTableRowsPage(tab, next);
    const live = state.workspaceTabs.find((t) => t.id === tab.id);
    if (!live) return;
    const sql = tablePageSql(tab.table, next, pageSize);
    live.result = rows;
    live.page = next;
    live.sql = sql;
    if (state.activeWorkspaceTabId !== live.id) return;
    state.result = rows;
    state.page = next;
    setSqlEditorValue(sql);
    renderData(rows);
    setStatus(rows.message || `Page ${next} of ${totalPages}`);
  } catch (e) {
    setStatus(e.message || "Failed to load page");
  }
}

async function changeDataPage(delta) {
  const result = state.result;
  if (!result) return;
  const pageSize = dataPageSize();
  const current = state.page || 1;

  if (usesServerTablePaging(result)) {
    const tableTotal = Number(result.totalRows) || 0;
    const totalPages = Math.max(1, Math.ceil(tableTotal / pageSize) || 1);
    const next = Math.min(totalPages, Math.max(1, current + delta));
    if (next === current) return;
    await loadTablePage(next);
    return;
  }

  const rows = filteredRows(result);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize) || 1);
  const next = Math.min(totalPages, Math.max(1, current + delta));
  if (next === current) return;
  state.page = next;
  const tab = activeWorkspaceTab();
  if (tab) tab.page = next;
  renderData(result);
}

async function loadTableIntoActiveTab(tab) {
  const schema = tab.schema;
  const table = tab.table;
  const cid = tab.connectionId || state.activeConnectionId;
  updateContextMeta("Loading…");
  setStatus(`Loading ${table}…`);
  const pageSize = dataPageSize();
  const base = `/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}`;
  const [cols, rows] = await Promise.all([
    api(withConnectionId(`${base}/columns`, cid)),
    api(withConnectionId(`${base}/rows?limit=${pageSize}&offset=0`, cid)),
  ]);
  let ddlText = "DDL unavailable";
  try {
    const ddl = await api(withConnectionId(`${base}/ddl`, cid));
    ddlText = ddl.ddl || "";
  } catch {
    /* ignore */
  }
  const sql = tablePageSql(table, 1, pageSize);

  // Tab may have been closed while loading
  const live = state.workspaceTabs.find((t) => t.id === tab.id);
  if (!live) return;

  live.columns = cols;
  live.result = rows;
  live.ddl = ddlText;
  live.sql = sql;
  live.page = 1;
  if (live.viewMode === "details" || live.viewMode === "sql") live.viewMode = "data";
  else if (live.viewMode === "ddl") live.viewMode = "structure";
  else live.viewMode = live.viewMode || "data";

  if (state.activeWorkspaceTabId !== live.id) return;

  state.columns = cols;
  state.result = rows;
  state.page = 1;
  // Keep prior hide choices for this tab; drop names that no longer exist.
  state.hiddenColumns = { ...(live.hiddenColumns || {}) };
  pruneHiddenColumns(rows.columns || []);
  live.hiddenColumns = { ...state.hiddenColumns };
  state.currentSchema = schema;
  state.currentTable = table;
  setSqlEditorValue(sql);
  $("#ddl-view").textContent = ddlText;
  renderStructure(cols);
  renderData(rows);
  updateContextMeta(`${schema} · ${table}`);
  switchTab(live.viewMode || "data", { skipTitle: true });
  setStatus(rows.message || `Loaded ${table}`);
}

function closeWorkspaceTab(tabId) {
  const idx = state.workspaceTabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = state.workspaceTabs[idx];
  if (tab.pinned || tab.closable === false) {
    setStatus("Unpin the tab before closing it");
    return;
  }

  const wasActive = state.activeWorkspaceTabId === tabId;
  state.workspaceTabs.splice(idx, 1);

  if (!state.workspaceTabs.length) {
    showEmptyWorkspace();
    return;
  }

  if (!wasActive) {
    renderWorkspaceTabs();
    return;
  }

  const next = state.workspaceTabs[idx] || state.workspaceTabs[idx - 1] || state.workspaceTabs[0];
  state.activeWorkspaceTabId = next.id;
  renderWorkspaceTabs();
  applyWorkspaceTab(state.activeWorkspaceTabId).catch((e) => console.error(e));
}

async function openTable(schema, table, connectionId, database = null) {
  if (connectionId) state.activeConnectionId = connectionId;
  const cid = connectionId || state.activeConnectionId;
  const id = tableTabId(schema, table, cid);
  const profile = profileById(cid);
  // MySQL 2-layer: the explorer "schema" is the database name.
  const dbName = database
    || (!isThreeLayerProfile(profile) ? schema : null)
    || state.detailFocus?.database
    || profileDatabaseName(cid)
    || "";
  snapshotActiveWorkspaceTab();
  // Opening a table replaces the DB/SCH context tab.
  removeContextTabs();

  const three = isThreeLayerProfile(profile);
  let tab = state.workspaceTabs.find((t) => t.id === id);

  if (!tab) {
    // Reuse an unpinned table tab (prefer the active one). Only open a new
    // tab when every existing table tab is pinned (or none exist yet).
    const active = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
    let replace = null;
    if (active && active.kind === "table" && !active.pinned) {
      replace = active;
    } else {
      replace = state.workspaceTabs.find((t) => t.kind === "table" && !t.pinned) || null;
    }

    if (replace) {
      const oldId = replace.id;
      replace.id = id;
      replace.kind = "table";
      replace.title = table;
      replace.schema = schema;
      replace.table = table;
      replace.database = dbName;
      replace.connectionId = cid;
      replace.queryDatabase = dbName;
      replace.querySchema = three ? schema : "";
      replace.columns = null;
      replace.result = null;
      replace.ddl = null;
      replace.sql = null;
      replace.page = 1;
      replace.hiddenColumns = {};
      replace.columnFilters = {};
      replace.sqlFileName = null;
      replace.sqlFilePath = null;
      if (replace.viewMode === "details" || replace.viewMode === "sql") replace.viewMode = "data";
      else if (replace.viewMode === "ddl") replace.viewMode = "structure";
      else replace.viewMode = replace.viewMode || "data";
      if (state.activeWorkspaceTabId === oldId) state.activeWorkspaceTabId = id;
      tab = replace;
    } else {
      tab = {
        id,
        kind: "table",
        title: table,
        schema,
        table,
        database: dbName,
        connectionId: cid,
        queryDatabase: dbName,
        querySchema: three ? schema : "",
        closable: true,
        pinned: false,
        viewMode: "data",
      };
      state.workspaceTabs.push(tab);
    }
  } else {
    tab.connectionId = cid;
    tab.schema = schema;
    tab.table = table;
    tab.database = dbName || tab.database;
    tab.queryDatabase = tab.queryDatabase || dbName;
    if (tab.querySchema == null) tab.querySchema = three ? schema : "";
    tab.title = table;
  }

  state.activeWorkspaceTabId = id;
  state.currentSchema = schema;
  state.currentTable = table;
  setDetailFocus({ scope: "table", schema, table, database: dbName, connectionId: cid });
  updateRunButton();
  renderWorkspaceTabs();
  await applyWorkspaceTab(id, { forceReload: !tab.columns || !tab.result });
}

function sqlTabId(connectionId, database, schema) {
  return `sql:${connectionId || state.activeConnectionId || ""}:${database || ""}:${schema || ""}`;
}

function sqlTableTabId(connectionId, schema, table) {
  return `sqltable:${connectionId || state.activeConnectionId || ""}:${schema || ""}.${table || ""}`;
}

function sqlContextLabel(tab = {}) {
  const profile = profileById(tab.connectionId || state.activeConnectionId);
  const three = isThreeLayerProfile(profile);
  const db = tab.queryDatabase || tab.database || "";
  const sch = tab.querySchema || tab.schema || "";
  const table = tab.table || state.currentTable || "";
  if (three) {
    return [db, sch, table].filter(Boolean).join(" · ") || "Query";
  }
  return [db || sch, table].filter(Boolean).join(" · ") || "Query";
}

function readSqlContextFromUi() {
  return {
    database: ($("#sql-db")?.value || "").trim(),
    schema: ($("#sql-schema")?.value || "").trim(),
  };
}

function fillSelectOptions(select, values, selected, { allowEmpty = true, emptyLabel = "—" } = {}) {
  if (!select) return;
  const prev = selected ?? select.value;
  select.innerHTML = "";
  if (allowEmpty) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = emptyLabel;
    select.appendChild(opt);
  }
  for (const value of values || []) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
  if (prev && [...select.options].some((o) => o.value === prev)) {
    select.value = prev;
  } else if (!allowEmpty && select.options.length) {
    select.selectedIndex = 0;
  } else {
    select.value = "";
  }
}

async function loadSqlDatabaseOptions() {
  const cid = state.activeConnectionId;
  if (!cid) return [];
  try {
    return await api(withConnectionId("/api/databases", cid));
  } catch {
    const fallback = profileDatabaseName(cid);
    return fallback ? [fallback] : [];
  }
}

async function loadSqlSchemaOptions(database) {
  const cid = state.activeConnectionId;
  if (!cid) return [];
  const profile = activeProfile();
  if (!isThreeLayerProfile(profile)) return [];
  try {
    const q = database ? `?database=${encodeURIComponent(database)}` : "";
    return await api(withConnectionId(`/api/schemas${q}`, cid));
  } catch {
    return [];
  }
}

function desiredSqlContextFromTab(tab) {
  if (!tab) {
    return {
      database: state.detailFocus?.database || profileDatabaseName() || "",
      schema: state.detailFocus?.scope === "schema" ? (state.detailFocus.schema || "") : "",
      table: state.currentTable || "",
    };
  }
  if (tab.kind === "table") {
    const three = isThreeLayerProfile(profileById(tab.connectionId));
    return {
      database: tab.queryDatabase || tab.database || profileDatabaseName(tab.connectionId) || "",
      schema: tab.querySchema != null
        ? tab.querySchema
        : (three ? (tab.schema || "") : ""),
      table: tab.table || "",
    };
  }
  if (tab.kind === "sql") {
    return {
      database: tab.queryDatabase || tab.database || profileDatabaseName(tab.connectionId) || "",
      schema: tab.querySchema || tab.schema || "",
      table: tab.table || "",
    };
  }
  // context / home
  const focus = tab.detailFocus || state.detailFocus || {};
  const three = isThreeLayerProfile(profileById(tab.connectionId || focus.connectionId));
  return {
    database: tab.queryDatabase
      || focus.database
      || profileDatabaseName(tab.connectionId)
      || "",
    schema: tab.querySchema != null
      ? tab.querySchema
      : (three && focus.scope === "schema" ? (focus.schema || "") : ""),
    table: "",
  };
}

async function refreshSqlContextUi() {
  const dbSel = $("#sql-db");
  const schSel = $("#sql-schema");
  const schWrap = $("#sql-schema-wrap");
  const tableChip = $("#sql-table-chip");
  if (!dbSel || !schSel) return;

  const epoch = state.workspaceApplyEpoch;
  const editorBefore = $("#sql-editor")?.value;
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  const profile = activeProfile() || profileById(tab?.connectionId);
  const three = isThreeLayerProfile(profile);
  const desired = desiredSqlContextFromTab(tab);

  if (schWrap) schWrap.hidden = !three;

  const databases = await loadSqlDatabaseOptions();
  if (epoch !== state.workspaceApplyEpoch) return;
  fillSelectOptions(dbSel, databases, desired.database, {
    allowEmpty: true,
    emptyLabel: "Database…",
  });

  if (three) {
    const schemas = await loadSqlSchemaOptions(dbSel.value || desired.database);
    if (epoch !== state.workspaceApplyEpoch) return;
    fillSelectOptions(schSel, schemas, desired.schema, {
      allowEmpty: true,
      emptyLabel: "Schema…",
    });
  } else {
    schSel.innerHTML = "";
    schSel.value = "";
  }

  if (tableChip) {
    if (desired.table) {
      tableChip.hidden = false;
      tableChip.textContent = `Table: ${desired.table}`;
      tableChip.title = desired.table;
    } else {
      tableChip.hidden = true;
      tableChip.textContent = "";
    }
  }

  // Prefer live editor text / tab.sql over whatever an older apply had.
  const liveTab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  const keepSql = $("#sql-editor")?.value ?? editorBefore ?? liveTab?.sql;
  persistSqlContextToActiveTab();
  if (liveTab && keepSql != null) liveTab.sql = keepSql;
  if (keepSql != null) setSqlEditorValue(keepSql);
  ensureSqlMeta().catch(() => {});
}

function persistSqlContextToActiveTab() {
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (!tab) return;
  const ctx = readSqlContextFromUi();
  tab.queryDatabase = ctx.database;
  tab.querySchema = ctx.schema;
  // Always keep editor text on the tab (prevents wipe after async refresh/apply).
  if ($("#sql-editor")) {
    tab.sql = $("#sql-editor").value;
  }
  if (tab.kind === "sql") {
    tab.database = ctx.database || tab.database;
    tab.schema = ctx.schema || tab.schema;
    // File tabs keep the filename; only untitled SQL tabs follow db/schema.
    if (tab.source === "file" || tab.sqlFileName) {
      const fileTitle = tab.sqlFileName || tab.title || "query.sql";
      if (tab.title !== fileTitle) {
        tab.title = fileTitle;
        renderWorkspaceTabs();
      }
    } else {
      const nextTitle = ctx.schema || ctx.database || tab.title || "Query";
      if (tab.title !== nextTitle) {
        tab.title = nextTitle;
        renderWorkspaceTabs();
      }
    }
  }
}

async function onSqlDatabaseChanged() {
  persistSqlContextToActiveTab();
  const profile = activeProfile();
  if (isThreeLayerProfile(profile)) {
    const schSel = $("#sql-schema");
    const schemas = await loadSqlSchemaOptions($("#sql-db")?.value || "");
    const keep = schSel?.value || "";
    fillSelectOptions(schSel, schemas, keep, { allowEmpty: true, emptyLabel: "Schema…" });
    persistSqlContextToActiveTab();
  }
  ensureSqlMeta({ force: true }).catch(() => {});
}

/** Open SQL editor at database, schema, or table level. */
async function openSqlEditor({
  connectionId = null,
  database = "",
  schema = "",
  table = null,
} = {}) {
  const cid = connectionId || state.activeConnectionId;
  if (cid) {
    state.activeConnectionId = cid;
    await api("/api/session/active", {
      method: "POST",
      body: JSON.stringify({ id: cid }),
    }).catch(() => {});
  }

  // Table / view: always open a dedicated SQL workspace tab.
  await openSqlTab({
    connectionId: cid,
    database,
    schema,
    table: table || null,
  });
}

async function openSqlTab({
  connectionId = null,
  database = "",
  schema = "",
  table = null,
} = {}) {
  const cid = connectionId || state.activeConnectionId;
  const profile = profileById(cid);
  const three = isThreeLayerProfile(profile);
  const dbName = database
    || (!three && schema ? schema : null)
    || profileDatabaseName(cid)
    || "";
  const schName = three ? (schema || "") : "";
  const tableName = table || null;
  const id = tableName
    ? sqlTableTabId(cid, schema || schName || dbName, tableName)
    : sqlTabId(cid, dbName, schName);
  snapshotActiveWorkspaceTab();
  removeContextTabs();

  const limit = Number($("#row-limit")?.value) || 1000;
  const defaultSql = tableName
    ? `SELECT * FROM ${quoteIdent(tableName)} LIMIT ${limit}`
    : "";

  let tab = state.workspaceTabs.find((t) => t.id === id);
  if (!tab) {
    tab = {
      id,
      kind: "sql",
      title: tableName || schName || dbName || "Query",
      database: dbName,
      schema: three ? schName : (schema || ""),
      table: tableName,
      connectionId: cid,
      queryDatabase: dbName,
      querySchema: three ? schName : "",
      closable: true,
      pinned: false,
      viewMode: "sql",
      sql: defaultSql,
    };
    state.workspaceTabs.push(tab);
  } else {
    tab.connectionId = cid;
    tab.database = dbName || tab.database;
    tab.schema = three ? schName : (schema || tab.schema || "");
    tab.table = tableName;
    tab.queryDatabase = dbName;
    tab.querySchema = three ? schName : "";
    tab.title = tableName || schName || dbName || tab.title || "Query";
    tab.viewMode = "sql";
    if (tableName && !String(tab.sql || "").trim()) tab.sql = defaultSql;
  }

  state.activeWorkspaceTabId = id;
  state.currentSchema = (three ? schName : (schema || dbName)) || null;
  state.currentTable = tableName;
  setDetailFocus({
    scope: tableName ? "table" : (schName ? "schema" : "database"),
    schema: three ? (schName || null) : (schema || dbName || null),
    table: tableName,
    database: dbName,
    connectionId: cid,
  });
  updateRunButton();
  renderWorkspaceTabs();
  await applyWorkspaceTab(id);
  setStatus(`SQL editor · ${sqlContextLabel(tab)}`);
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function updateContextMeta(_text) {
  // Context summary lives in the status bar only (not the tab bar).
}

function setDetailFocus({
  scope = "connection",
  schema = null,
  table = null,
  database = null,
  connectionId = null,
} = {}) {
  state.detailFocus = {
    scope,
    schema,
    table,
    database,
    connectionId: connectionId || state.activeConnectionId || null,
  };
}

async function refreshDetails() {
  const title = $("#details-title");
  const subtitle = $("#details-subtitle");
  const grid = $("#details-grid");
  const empty = $("#details-empty");
  if (!title || !grid) return;

  if (!state.connected && !Object.keys(state.connectedIds || {}).length) {
    title.textContent = "Details";
    subtitle.textContent = "Connect to a database to see object counts.";
    grid.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }

  const focus = state.detailFocus || { scope: "connection" };
  const params = new URLSearchParams({ scope: focus.scope || "connection" });
  if (focus.schema) params.set("schema", focus.schema);
  if (focus.database && focus.scope === "database") params.set("schema", focus.database);
  if (focus.table) params.set("table", focus.table);
  const cid = state.activeConnectionId;
  grid.innerHTML = `<div class="hint">Loading…</div>`;
  if (empty) empty.hidden = true;
  try {
    const data = await api(withConnectionId(`/api/details?${params}`, cid));
    title.textContent = data.title || "Details";
    subtitle.textContent = data.subtitle || data.hierarchy || data.engine || "";
    renderDetailsItems(data.items || []);
  } catch (e) {
    title.textContent = "Details";
    subtitle.textContent = e.message || "Failed to load details";
    grid.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = e.message || "Failed to load details";
    }
  }
}

function renderDetailsItems(items) {
  const grid = $("#details-grid");
  const empty = $("#details-empty");
  grid.innerHTML = "";
  if (!items.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "No details available.";
    }
    return;
  }
  if (empty) empty.hidden = true;
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "details-card";
    card.innerHTML =
      `<div class="details-value">${escapeHtml(String(item.value ?? 0))}</div>`
      + `<div class="details-label">${escapeHtml(item.label || "")}</div>`;
    grid.appendChild(card);
  }
}

/* ── Tabs / data grid ────────────────────────────── */

function activeWorkspaceTab() {
  return state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId) || null;
}

/** True when the active workspace tab is a concrete table. */
function isTableWorkspaceActive(tab = activeWorkspaceTab()) {
  return !!(tab && tab.kind === "table" && tab.table);
}

/**
 * View tabs (Details/Data/Structure) only for table workspace tabs.
 * Non-table query results keep the data tool strip (search/pager/export).
 */
function updateViewTabBarVisibility() {
  const nav = $("#view-tabs");
  const left = $("#view-tabs-left");
  const right = $("#view-tabs-right");
  const backBtn = $("#btn-back-to-sql");
  if (!nav) return;

  const tab = activeWorkspaceTab();
  const isTable = isTableWorkspaceActive(tab);
  const onData = state.currentTab === "data";
  const showDataTools = onData && !!(state.result || isTable);

  if (isTable) {
    nav.hidden = false;
    nav.classList.remove("tabs-tools-only");
    if (left) left.hidden = false;
    if (right) right.hidden = false;
  } else if (showDataTools) {
    // Query result on a DB/SQL tab: tools only, no view switcher.
    nav.hidden = false;
    nav.classList.add("tabs-tools-only");
    if (left) left.hidden = true;
    if (right) right.hidden = false;
  } else {
    nav.hidden = true;
    nav.classList.remove("tabs-tools-only");
    if (left) left.hidden = true;
    if (right) right.hidden = true;
  }

  if (backBtn) {
    backBtn.hidden = isTable || !onData || !(tab && (tab.kind === "sql" || tab.kind === "context" || tab.kind === "home"));
  }
}

function switchTab(name, { skipTitle = false } = {}) {
  const tab = activeWorkspaceTab();
  const isTable = isTableWorkspaceActive(tab);
  let target = name;

  // Table tabs no longer have an SQL view — use a dedicated SQL workspace tab instead.
  if (isTable && target === "sql") {
    target = "data";
  }
  // DDL merged into Structure.
  if (target === "ddl") target = "structure";

  // Without a table workspace tab, Structure/Details don't apply to SQL tabs.
  if (!isTable) {
    if (tab?.kind === "sql") {
      target = (name === "data" && (state.result || tab.result)) ? "data" : "sql";
    } else if (tab?.kind === "context" || tab?.kind === "home") {
      if (name === "data" && (state.result || tab.result)) target = "data";
      else target = "details";
    } else if (!tab) {
      target = "details";
    }
  } else if (tab.viewMode === "sql") {
    // Migrate any persisted table tab that still points at the removed SQL view.
    target = target === "sql" ? "data" : target;
  }

  state.currentTab = target;
  if (tab) tab.viewMode = target;

  $$(".tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === target));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${target}`));
  updateViewTabBarVisibility();

  if (!skipTitle) {
    if (state.currentTable && state.currentSchema) {
      updateContextMeta(`${state.currentSchema} · ${state.currentTable}`);
    } else if (state.detailFocus?.scope === "schema" && state.detailFocus.schema) {
      updateContextMeta(state.detailFocus.schema);
    } else if (state.detailFocus?.scope === "database" && state.detailFocus.database) {
      updateContextMeta(state.detailFocus.database);
    } else if (target !== "details") {
      updateContextMeta("");
    }
  }
  if (target === "details") {
    refreshDetails().catch((e) => console.error(e));
  }
  if (target === "sql") {
    refreshSqlContextUi().catch((e) => console.error(e));
    ensureSqlMeta().catch(() => {});
    requestAnimationFrame(() => refreshSqlEditorUi());
  }
}

/** Show connection/database/schema details on a transient DB/SCH tab. */
async function focusHomeDetails(focus) {
  snapshotActiveWorkspaceTab();
  const normalized = {
    ...(focus || {}),
    connectionId: focus?.connectionId || state.activeConnectionId || null,
    database: focus?.database || profileDatabaseName(focus?.connectionId || state.activeConnectionId) || null,
  };
  setDetailFocus(normalized);
  const tab = ensureContextTab(normalized);
  state.activeWorkspaceTabId = tab.id;
  state.currentSchema = null;
  state.currentTable = null;
  updateRunButton();
  renderWorkspaceTabs();
  await applyWorkspaceTab(tab.id);
}

function compareFilterValues(cell, target) {
  const aNum = Number(cell);
  const bNum = Number(target);
  if (cell !== "" && target !== "" && Number.isFinite(aNum) && Number.isFinite(bNum)) {
    return aNum - bNum;
  }
  return String(cell).localeCompare(String(target), undefined, { sensitivity: "base", numeric: true });
}

function rowMatchesColumnFilter(value, filter) {
  if (!filter || !filter.op) return true;
  const op = filter.op;
  const target = filter.value ?? "";

  if (op === "null") return value == null;
  if (op === "not_null") return value != null;

  if (value == null) {
    // NULL is only matched by null / not_null (already handled).
    return false;
  }

  const text = String(value);
  const textLower = text.toLowerCase();
  const targetLower = String(target).toLowerCase();

  switch (op) {
    case "empty":
      return text.trim() === "";
    case "not_empty":
      return text.trim() !== "";
    case "contains":
      return target === "" ? true : textLower.includes(targetLower);
    case "not_contains":
      return target === "" ? true : !textLower.includes(targetLower);
    case "eq":
      return textLower === targetLower;
    case "neq":
      return textLower !== targetLower;
    case "starts":
      return target === "" ? true : textLower.startsWith(targetLower);
    case "ends":
      return target === "" ? true : textLower.endsWith(targetLower);
    case "gt":
      return target === "" ? true : compareFilterValues(text, target) > 0;
    case "gte":
      return target === "" ? true : compareFilterValues(text, target) >= 0;
    case "lt":
      return target === "" ? true : compareFilterValues(text, target) < 0;
    case "lte":
      return target === "" ? true : compareFilterValues(text, target) <= 0;
    default:
      return true;
  }
}

function activeColumnFilterCount() {
  return Object.values(state.columnFilters || {}).filter(isColumnFilterActive).length;
}

function updateClearFiltersButton() {
  const clearBtn = $("#btn-clear-filters");
  if (clearBtn) clearBtn.hidden = activeColumnFilterCount() === 0;
}

function isColumnFilterActive(filter) {
  if (!filter?.op) return false;
  const meta = COLUMN_FILTER_OPS.find((o) => o.id === filter.op);
  if (!meta) return false;
  if (!meta.needsValue) return true;
  return (filter.value ?? "") !== "";
}

function persistColumnFilters() {
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (tab) tab.columnFilters = { ...(state.columnFilters || {}) };
}

function setColumnFilter(column, op, value) {
  if (!state.columnFilters) state.columnFilters = {};
  const meta = COLUMN_FILTER_OPS.find((o) => o.id === op) || COLUMN_FILTER_OPS[0];
  if (meta.needsValue && (value ?? "") === "") {
    delete state.columnFilters[column];
  } else {
    state.columnFilters[column] = {
      op: meta.id,
      value: meta.needsValue ? (value ?? "") : "",
    };
  }
  persistColumnFilters();
  state.page = 1;
  updateClearFiltersButton();
  renderData(state.result);
}

function clearColumnFilter(column) {
  if (!state.columnFilters) state.columnFilters = {};
  delete state.columnFilters[column];
  persistColumnFilters();
  state.page = 1;
  updateClearFiltersButton();
  renderData(state.result);
}

function clearColumnFilters() {
  state.columnFilters = {};
  persistColumnFilters();
  state.page = 1;
  closeColumnFilterPopup();
  updateClearFiltersButton();
  renderData(state.result);
}

function opNeedsValue(op) {
  return !!(COLUMN_FILTER_OPS.find((o) => o.id === op)?.needsValue);
}

function syncFilterPopupValueEnabled() {
  const opSel = $("#col-filter-op");
  const valueInput = $("#col-filter-value");
  if (!opSel || !valueInput) return;
  const needs = opNeedsValue(opSel.value);
  valueInput.disabled = !needs;
  if (!needs) valueInput.value = "";
}

function closeColumnFilterPopup() {
  const popup = $("#col-filter-popup");
  if (popup) popup.hidden = true;
  state.filterPopupColumn = null;
}

function positionColumnFilterPopup(anchorEl) {
  const popup = $("#col-filter-popup");
  if (!popup || !anchorEl) return;
  popup.hidden = false;
  const rect = anchorEl.getBoundingClientRect();
  const pad = 8;
  const width = popup.offsetWidth || 264;
  const height = popup.offsetHeight || 200;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + width > window.innerWidth - pad) left = window.innerWidth - width - pad;
  if (left < pad) left = pad;
  if (top + height > window.innerHeight - pad) top = Math.max(pad, rect.top - height - 6);
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
}

function openColumnFilterPopup(column, anchorEl) {
  const popup = $("#col-filter-popup");
  const title = $("#col-filter-title");
  const opSel = $("#col-filter-op");
  const valueInput = $("#col-filter-value");
  if (!popup || !opSel || !valueInput) return;

  state.filterPopupColumn = column;
  if (title) title.textContent = column;
  const current = state.columnFilters?.[column] || { op: "contains", value: "" };
  opSel.value = current.op || "contains";
  valueInput.value = current.value || "";
  syncFilterPopupValueEnabled();
  positionColumnFilterPopup(anchorEl);
  requestAnimationFrame(() => {
    if (opNeedsValue(opSel.value)) valueInput.focus();
    else opSel.focus();
  });
}

function applyColumnFilterFromPopup() {
  const column = state.filterPopupColumn;
  if (!column) return;
  const op = $("#col-filter-op")?.value || "contains";
  const value = $("#col-filter-value")?.value ?? "";
  setColumnFilter(column, op, value);
  closeColumnFilterPopup();
}

function filteredRows(result) {
  const q = ($("#data-search").value || "").toLowerCase();
  const cols = result.columns || [];
  const filterEntries = Object.entries(state.columnFilters || {}).filter(
    ([col, f]) => cols.includes(col) && isColumnFilterActive(f)
  );

  return (result.rows || []).filter((row) => {
    if (q) {
      const hit = Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(q));
      if (!hit) return false;
    }
    for (const [col, filter] of filterEntries) {
      if (!rowMatchesColumnFilter(row[col], filter)) return false;
    }
    return true;
  });
}

function initColumnFilterPopup() {
  const opSel = $("#col-filter-op");
  if (!opSel || opSel.options.length) return;
  for (const op of COLUMN_FILTER_OPS) {
    const opt = document.createElement("option");
    opt.value = op.id;
    opt.textContent = op.label;
    opSel.appendChild(opt);
  }
}

function visibleColumns(columns) {
  const cols = columns || [];
  const hidden = state.hiddenColumns || {};
  const visible = cols.filter((c) => !hidden[c]);
  // Keep at least one column so the grid never goes blank.
  return visible.length ? visible : cols.slice(0, 1);
}

function hiddenColumnCount(columns) {
  const cols = columns || [];
  return cols.filter((c) => state.hiddenColumns?.[c]).length;
}

function pruneHiddenColumns(columns) {
  const allowed = new Set(columns || []);
  const next = {};
  for (const [name, on] of Object.entries(state.hiddenColumns || {})) {
    if (on && allowed.has(name)) next[name] = true;
  }
  // Never hide every column.
  if (allowed.size && Object.keys(next).length >= allowed.size) {
    const keep = columns[0];
    delete next[keep];
  }
  state.hiddenColumns = next;
}

function updateColumnsButton(columns) {
  const btn = $("#btn-columns");
  if (!btn) return;
  const total = (columns || state.result?.columns || []).length;
  const hidden = hiddenColumnCount(columns || state.result?.columns || []);
  btn.textContent = hidden ? `Columns (${hidden} hidden)` : "Columns";
  btn.disabled = !total;
}

function closeColumnVisibilityMenu() {
  const menu = $("#col-visibility-menu");
  if (menu) menu.hidden = true;
}

function closeExportMenu() {
  const menu = $("#export-menu");
  const btn = $("#btn-export");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function toggleExportMenu() {
  const menu = $("#export-menu");
  const btn = $("#btn-export");
  if (!menu || !btn) return;
  const open = menu.hidden;
  closeColumnVisibilityMenu();
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function renderColumnVisibilityList(columns) {
  const list = $("#col-visibility-list");
  if (!list) return;
  list.innerHTML = "";
  const cols = columns || state.result?.columns || [];
  if (!cols.length) {
    list.innerHTML = `<div class="hint" style="padding:.35rem">No columns</div>`;
    return;
  }
  pruneHiddenColumns(cols);
  for (const name of cols) {
    const label = document.createElement("label");
    label.className = "col-vis-item";
    const checked = !state.hiddenColumns?.[name];
    label.innerHTML =
      `<input type="checkbox" ${checked ? "checked" : ""} />`
      + `<span title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
    const input = label.querySelector("input");
    input.onchange = () => {
      if (!state.hiddenColumns) state.hiddenColumns = {};
      if (input.checked) {
        delete state.hiddenColumns[name];
      } else {
        // Prevent hiding the last visible column.
        if (visibleColumns(cols).length <= 1 && !state.hiddenColumns[name]) {
          input.checked = true;
          return;
        }
        state.hiddenColumns[name] = true;
      }
      const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
      if (tab) tab.hiddenColumns = { ...state.hiddenColumns };
      updateColumnsButton(cols);
      renderData(state.result);
      renderColumnVisibilityList(cols);
    };
    list.appendChild(label);
  }
  updateColumnsButton(cols);
}

function toggleColumnVisibilityMenu() {
  const menu = $("#col-visibility-menu");
  if (!menu) return;
  const open = menu.hidden;
  closeExportMenu();
  if (open) {
    renderColumnVisibilityList(state.result?.columns || []);
    menu.hidden = false;
  } else {
    menu.hidden = true;
  }
}

function setAllColumnsVisible(show) {
  const cols = state.result?.columns || [];
  if (!cols.length) return;
  if (show) {
    state.hiddenColumns = {};
  } else {
    const hidden = {};
    for (let i = 1; i < cols.length; i++) hidden[cols[i]] = true;
    state.hiddenColumns = hidden;
  }
  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (tab) tab.hiddenColumns = { ...state.hiddenColumns };
  renderColumnVisibilityList(cols);
  renderData(state.result);
}

function renderData(result) {
  const thead = $("#data-table thead");
  const tbody = $("#data-table tbody");
  thead.innerHTML = "";
  tbody.innerHTML = "";
  const empty = $("#data-empty");
  if (!result || result.update || !result.columns?.length) {
    empty.hidden = false;
    empty.textContent = result?.message || "No data to show.";
    updateContextMeta(result?.message || "");
    updatePager(0, 0, 0, 1);
    updateColumnsButton([]);
    updateClearFiltersButton();
    closeColumnFilterPopup();
    closeColumnVisibilityMenu();
    updateViewTabBarVisibility();
    return;
  }
  empty.hidden = true;
  pruneHiddenColumns(result.columns);
  const columns = visibleColumns(result.columns);

  const head = document.createElement("tr");
  for (const c of columns) {
    const th = document.createElement("th");
    th.className = "col-filterable" + (isColumnFilterActive(state.columnFilters?.[c]) ? " col-filtered" : "");
    th.title = "Click to filter · right-click to hide";
    const label = document.createElement("span");
    label.className = "col-name";
    label.textContent = c;
    const mark = document.createElement("span");
    mark.className = "col-filter-mark";
    mark.textContent = "▾";
    mark.setAttribute("aria-hidden", "true");
    th.append(label, mark);
    th.onclick = (e) => {
      e.stopPropagation();
      closeColumnVisibilityMenu();
      if (state.filterPopupColumn === c && !$("#col-filter-popup")?.hidden) {
        closeColumnFilterPopup();
        return;
      }
      openColumnFilterPopup(c, th);
    };
    th.oncontextmenu = (e) => {
      e.preventDefault();
      closeColumnFilterPopup();
      if (!state.hiddenColumns) state.hiddenColumns = {};
      if (visibleColumns(result.columns).length <= 1) return;
      state.hiddenColumns[c] = true;
      const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
      if (tab) tab.hiddenColumns = { ...state.hiddenColumns };
      updateColumnsButton(result.columns);
      renderData(result);
    };
    head.appendChild(th);
  }
  thead.appendChild(head);

  const rows = filteredRows(result);
  const pageSize = dataPageSize();
  const loadedTotal = result.rows?.length || 0;
  const isFiltered = rows.length !== loadedTotal;
  const tableTotal = Number(result.totalRows);
  const hasTableTotal = Number.isFinite(tableTotal) && tableTotal >= 0;
  const serverPaging = usesServerTablePaging(result);

  let totalPages;
  let pageRows;
  let from;
  let end;
  let pagerTotal;

  if (serverPaging) {
    totalPages = Math.max(1, Math.ceil(tableTotal / pageSize) || 1);
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    // Current page was fetched from the server — show all loaded rows.
    pageRows = rows;
    const offset = (state.page - 1) * pageSize;
    from = rows.length ? offset + 1 : 0;
    end = rows.length ? offset + rows.length : 0;
    pagerTotal = tableTotal;
  } else {
    totalPages = Math.max(1, Math.ceil(rows.length / pageSize) || 1);
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * pageSize;
    pageRows = rows.slice(start, start + pageSize);
    from = rows.length ? start + 1 : 0;
    end = rows.length ? Math.min(start + pageRows.length, rows.length) : 0;
    pagerTotal = rows.length;
  }

  for (const row of pageRows) {
    const tr = document.createElement("tr");
    for (const c of columns) {
      const td = document.createElement("td");
      const v = row[c];
      if (v == null) {
        td.innerHTML = `<span class="null">NULL</span>`;
      } else {
        td.textContent = v;
        td.title = v;
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const schemaBit = state.currentSchema ? `${state.currentSchema} · ` : "";
  const tableBit = state.currentTable ? `${state.currentTable} · ` : "";
  updateContextMeta(
    `${schemaBit}${tableBit}${rows.length} row${rows.length === 1 ? "" : "s"}` +
    (isFiltered ? ` (filtered from ${loadedTotal})` : "") +
    (hasTableTotal && !isFiltered && tableTotal !== loadedTotal ? ` of ${tableTotal}` : "") +
    ` · showing ${from}–${end}` +
    (result.executionMs != null ? ` · ${result.executionMs} ms` : "")
  );
  updatePager(from, end, pagerTotal, totalPages);
  updateColumnsButton(result.columns);
  updateClearFiltersButton();
  updateViewTabBarVisibility();
}

function updatePager(from, to, total, totalPages) {
  const page = state.page || 1;
  const pages = Math.max(1, totalPages || 1);
  if (!total) {
    $("#page-info").textContent = "0 / 0";
  } else {
    $("#page-info").textContent = `${from}–${to} / ${total}`;
  }
  $("#btn-page-prev").disabled = page <= 1 || !total;
  $("#btn-page-next").disabled = page >= pages || !total;
}

function renderStructure(cols) {
  const tbody = $("#structure-table tbody");
  tbody.innerHTML = "";
  const empty = $("#structure-empty");
  if (!cols?.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const c of cols) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td>${escapeHtml(c.type)}</td>
      <td>${c.nullable ? "YES" : "NO"}</td>
      <td>${c.primaryKey ? "✓" : ""}</td>
      <td>${c.autoIncrement ? "✓" : ""}</td>
      <td>${escapeHtml(c.defaultValue ?? "")}</td>`;
    tbody.appendChild(tr);
  }
}

/* ── SQL output log ──────────────────────────────── */

function applySqlLogLayout() {
  const prefs = loadPrefs();
  const log = $("#sql-log");
  const workspace = $("#sql-workspace");
  if (!log || !workspace) return;
  const minimized = !!prefs.sqlLogMinimized;
  log.classList.toggle("minimized", minimized);
  const toggle = $("#btn-sql-log-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", minimized ? "false" : "true");
    toggle.textContent = minimized ? "▸" : "▾";
    toggle.title = minimized ? "Expand output" : "Minimize output";
  }
  const h = Number(prefs.sqlLogHeight);
  const height = Number.isFinite(h) ? Math.min(480, Math.max(80, Math.round(h))) : 152;
  if (!minimized) {
    workspace.style.setProperty("--sql-log-height", `${height}px`);
  }
}

function setSqlLogMinimized(minimized) {
  savePrefs({ sqlLogMinimized: !!minimized });
  applySqlLogLayout();
}

function toggleSqlLogMinimized() {
  const prefs = loadPrefs();
  setSqlLogMinimized(!prefs.sqlLogMinimized);
}

function expandSqlLog() {
  if (loadPrefs().sqlLogMinimized) setSqlLogMinimized(false);
}

function formatSqlLogTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function summarizeSqlSnippet(sql, max = 160) {
  const one = String(sql || "").replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function formatQueryResultLog(result, { sql, where } = {}) {
  const lines = [];
  if (sql) lines.push(summarizeSqlSnippet(sql, 240));
  if (where) lines.push(`Context: ${where}`);
  if (!result) {
    lines.push("(no result)");
    return lines.join("\n");
  }
  if (result.message) lines.push(result.message);
  if (result.executionMs != null) lines.push(`Time: ${result.executionMs} ms`);
  if (result.update) {
    lines.push(`Rows affected: ${result.affectedRows ?? result.rowCount ?? 0}`);
  } else if (result.columns?.length) {
    lines.push(`Columns: ${result.columns.length}`);
    lines.push(`Rows returned: ${result.rows?.length ?? result.affectedRows ?? 0}`);
  }
  return lines.join("\n");
}

function updateSqlLogMeta() {
  const meta = $("#sql-log-meta");
  if (!meta) return;
  const n = state.sqlLogEntries?.length || 0;
  meta.textContent = n ? `${n} entr${n === 1 ? "y" : "ies"}` : "";
}

function renderSqlLogOutput() {
  const out = $("#sql-log-output");
  if (!out) return;
  const entries = state.sqlLogEntries || [];
  if (!entries.length) {
    out.textContent = "Query output will appear here.";
    updateSqlLogMeta();
    return;
  }
  out.innerHTML = entries.map((e) => (
    `<div class="sql-log-entry ${escapeHtml(e.level || "info")}">`
    + `<div class="sql-log-entry-head">${escapeHtml(e.head || "")}</div>`
    + `<div class="sql-log-entry-body">${escapeHtml(e.body || "")}</div>`
    + `</div>`
  )).join("");
  out.scrollTop = out.scrollHeight;
  updateSqlLogMeta();
  if (!$("#sql-log-find-bar")?.hidden) runSqlLogFind(0);
}

function appendSqlLog(level, head, body) {
  if (!state.sqlLogEntries) state.sqlLogEntries = [];
  state.sqlLogEntries.push({
    level: level || "info",
    head: head || formatSqlLogTime(),
    body: body || "",
    at: Date.now(),
  });
  // Cap history so the DOM stays light.
  if (state.sqlLogEntries.length > 200) {
    state.sqlLogEntries = state.sqlLogEntries.slice(-200);
  }
  renderSqlLogOutput();
}

function clearSqlLog() {
  state.sqlLogEntries = [];
  state.sqlLogFindIndex = -1;
  renderSqlLogOutput();
  closeSqlLogFindBar();
}

function getSqlLogPlainText() {
  const entries = state.sqlLogEntries || [];
  if (!entries.length) return "";
  return entries.map((e) => `${e.head}\n${e.body}`).join("\n\n");
}

async function copySqlLog() {
  const out = $("#sql-log-output");
  let text = "";
  const sel = window.getSelection?.();
  if (sel && !sel.isCollapsed && out?.contains(sel.anchorNode)) {
    text = sel.toString();
  } else {
    text = getSqlLogPlainText();
  }
  if (!text.trim()) {
    setStatus("Output is empty");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setStatus("Output copied");
  } catch (e) {
    setStatus(e.message || "Copy failed");
  }
}

function updateSqlLogFindCount(current, total) {
  const el = $("#sql-log-find-count");
  if (!el) return;
  if (!total) {
    el.textContent = "0 / 0";
    el.classList.toggle("sql-find-empty", !!($("#sql-log-find-input")?.value || "").trim());
  } else {
    el.textContent = `${current + 1} / ${total}`;
    el.classList.remove("sql-find-empty");
  }
}

function clearSqlLogMarks() {
  const out = $("#sql-log-output");
  if (!out) return;
  out.querySelectorAll("mark.sql-log-mark").forEach((mark) => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
}

function collectSqlLogMatches(query, matchCase) {
  const out = $("#sql-log-output");
  if (!out || !query) return [];
  clearSqlLogMarks();
  const walker = document.createTreeWalker(out, NodeFilter.SHOW_TEXT);
  const matches = [];
  const needle = matchCase ? query : query.toLowerCase();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue || "";
    const hay = matchCase ? text : text.toLowerCase();
    let from = 0;
    while (from <= hay.length - needle.length) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      matches.push({ node, start: idx, length: needle.length });
      from = idx + Math.max(1, needle.length);
    }
  }
  // Wrap matches in reverse order so offsets stay valid within each node.
  const byNode = new Map();
  for (const m of matches) {
    if (!byNode.has(m.node)) byNode.set(m.node, []);
    byNode.get(m.node).push(m);
  }
  const marks = [];
  for (const [node, list] of byNode) {
    list.sort((a, b) => b.start - a.start);
    for (const m of list) {
      if (m.start + m.length > (node.nodeValue || "").length) continue;
      const range = document.createRange();
      range.setStart(node, m.start);
      range.setEnd(node, m.start + m.length);
      const mark = document.createElement("mark");
      mark.className = "sql-log-mark";
      try {
        range.surroundContents(mark);
        marks.unshift(mark);
      } catch {
        /* skip awkward boundaries */
      }
    }
  }
  return marks;
}

function runSqlLogFind(direction = 0) {
  const input = $("#sql-log-find-input");
  const out = $("#sql-log-output");
  if (!input || !out) return;
  const query = input.value || "";
  const matchCase = !!$("#sql-log-find-case")?.checked;
  if (!query) {
    clearSqlLogMarks();
    state.sqlLogFindIndex = -1;
    updateSqlLogFindCount(-1, 0);
    return;
  }
  const marks = collectSqlLogMatches(query, matchCase);
  if (!marks.length) {
    state.sqlLogFindIndex = -1;
    updateSqlLogFindCount(-1, 0);
    return;
  }
  let idx = state.sqlLogFindIndex;
  if (direction === 0) {
    idx = Math.min(Math.max(idx, 0), marks.length - 1);
  } else if (direction > 0) {
    idx = (idx + 1 + marks.length) % marks.length;
  } else {
    idx = (idx - 1 + marks.length) % marks.length;
  }
  state.sqlLogFindIndex = idx;
  marks.forEach((m, i) => m.classList.toggle("current", i === idx));
  marks[idx].scrollIntoView({ block: "nearest" });
  updateSqlLogFindCount(idx, marks.length);
}

function openSqlLogFindBar(seed = "") {
  expandSqlLog();
  const bar = $("#sql-log-find-bar");
  const input = $("#sql-log-find-input");
  if (!bar || !input) return;
  bar.hidden = false;
  if (seed) input.value = seed;
  else {
    const sel = window.getSelection?.()?.toString();
    if (sel && !sel.includes("\n")) input.value = sel;
  }
  input.focus();
  input.select();
  runSqlLogFind(0);
}

function closeSqlLogFindBar() {
  const bar = $("#sql-log-find-bar");
  if (bar) bar.hidden = true;
  clearSqlLogMarks();
  state.sqlLogFindIndex = -1;
  updateSqlLogFindCount(-1, 0);
  $("#sql-log-output")?.focus();
}

function wireSqlLogResize() {
  const handle = $("#sql-log-resizer");
  const log = $("#sql-log");
  const workspace = $("#sql-workspace");
  if (!handle || !log || !workspace) return;

  let dragging = false;
  let startY = 0;
  let startH = 0;

  const onMove = (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const next = Math.min(workspace.clientHeight * 0.7, Math.max(80, startH + dy));
    workspace.style.setProperty("--sql-log-height", `${Math.round(next)}px`);
  };

  const stop = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("active");
    document.body.classList.remove("resizing-sql-log");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    const raw = getComputedStyle(workspace).getPropertyValue("--sql-log-height").trim();
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) savePrefs({ sqlLogHeight: n });
  };

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || log.classList.contains("minimized")) return;
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = log.getBoundingClientRect().height;
    handle.classList.add("active");
    document.body.classList.add("resizing-sql-log");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  });
}

function wireSqlLog() {
  applySqlLogLayout();
  renderSqlLogOutput();
  wireSqlLogResize();

  $("#btn-sql-log-toggle")?.addEventListener("click", () => toggleSqlLogMinimized());
  $("#btn-sql-log-clear")?.addEventListener("click", () => clearSqlLog());
  $("#btn-sql-log-copy")?.addEventListener("click", () => copySqlLog());
  $("#btn-sql-log-find")?.addEventListener("click", () => openSqlLogFindBar());
  $("#btn-sql-log-find-next")?.addEventListener("click", () => runSqlLogFind(1));
  $("#btn-sql-log-find-prev")?.addEventListener("click", () => runSqlLogFind(-1));
  $("#btn-sql-log-find-close")?.addEventListener("click", () => closeSqlLogFindBar());
  $("#sql-log-find-input")?.addEventListener("input", () => runSqlLogFind(0));
  $("#sql-log-find-case")?.addEventListener("change", () => runSqlLogFind(0));
  $("#sql-log-find-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSqlLogFind(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSqlLogFindBar();
    }
  });

  const out = $("#sql-log-output");
  out?.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSqlLogFindBar();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      // Select all output text
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(out);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
}

async function runSql() {
  if (!state.activeConnectionId && !state.connected) {
    setStatus("Connect to a database first");
    return;
  }
  const editor = $("#sql-editor");
  const sqlText = editor?.value ?? "";
  const sql = sqlText.trim();
  if (!sql) return;

  // Cancel any in-flight tab apply/refresh that could wipe editor/results.
  state.workspaceApplyEpoch += 1;

  const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (tab) tab.sql = sqlText;
  persistSqlContextToActiveTab();
  if (tab) tab.sql = sqlText; // keep full editor text even if persist raced

  const ctx = readSqlContextFromUi();
  const profile = activeProfile();
  const three = isThreeLayerProfile(profile);
  const body = { sql };
  if (ctx.database) body.database = ctx.database;
  // 2-layer: database dropdown is enough. 3-layer: schema is optional (db-level when empty).
  if (three && ctx.schema) body.schema = ctx.schema;
  if (!three && !body.database && ctx.schema) body.database = ctx.schema;

  const where = [ctx.database, three ? ctx.schema : null].filter(Boolean).join(" · ");
  expandSqlLog();
  appendSqlLog("info", `${formatSqlLogTime()} · Running`, summarizeSqlSnippet(sql, 240) + (where ? `\nContext: ${where}` : ""));
  setStatus("Executing…");
  try {
    const result = await api("/api/query", { method: "POST", body: JSON.stringify(body) });
    state.workspaceApplyEpoch += 1;
    state.result = result;
    state.page = 1;
    // Fresh query result — don't keep prior column filters that can hide all rows.
    state.columnFilters = {};
    state.hiddenColumns = {};
    closeColumnFilterPopup();
    const live = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
    if (live && (live.kind === "table" || live.kind === "sql" || live.kind === "context" || live.kind === "home")) {
      live.result = result;
      live.page = 1;
      live.sql = sqlText;
      live.queryDatabase = ctx.database;
      live.querySchema = ctx.schema;
      live.columnFilters = {};
      live.hiddenColumns = {};
      if (live.source === "file" || live.sqlFileName) {
        live.title = live.sqlFileName || live.title;
      }
    }
    // Keep the query in the editor after Run.
    setSqlEditorValue(sqlText);
    state.sqlFileName = live?.sqlFileName || state.sqlFileName;
    state.sqlFilePath = live?.sqlFilePath || state.sqlFilePath;
    updateSqlFileChip(state.sqlFileName);

    const hasGrid = !result.update && !!result.columns?.length;
    appendSqlLog(
      "ok",
      `${formatSqlLogTime()} · OK${result.executionMs != null ? ` · ${result.executionMs} ms` : ""}`,
      formatQueryResultLog(result, { sql, where })
    );

    if (hasGrid) {
      if (live) live.viewMode = "data";
      // Show Data panel for result grids; output log keeps the execution summary.
      switchTab("data");
      renderData(result);
    } else {
      if (live) live.viewMode = "sql";
      switchTab("sql");
      renderData(result);
    }
    updateClearFiltersButton();
    setStatus(where ? `${result.message} · ${where}` : result.message);
  } catch (e) {
    // Preserve editor text even when the query fails.
    setSqlEditorValue(sqlText);
    appendSqlLog(
      "err",
      `${formatSqlLogTime()} · ERROR`,
      `${summarizeSqlSnippet(sql, 240)}${where ? `\nContext: ${where}` : ""}\n${e.message || String(e)}`
    );
    expandSqlLog();
    switchTab("sql");
    setStatus(e.message);
  }
}

function exportCsv() {
  if (state.currentSchema && state.currentTable) {
    openExportModal({ schema: state.currentSchema, table: state.currentTable, scope: "table" });
    $("#form-export").format.value = "csv";
    return;
  }
  const result = state.result;
  if (!result?.columns?.length) return;
  const lines = [result.columns.join(",")];
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => csvEscape(row[c])).join(","));
  }
  downloadBlob(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }), "export.csv");
}

function exportJson() {
  if (state.currentSchema && state.currentTable) {
    openExportModal({ schema: state.currentSchema, table: state.currentTable, scope: "table" });
    $("#form-export").format.value = "json";
    return;
  }
  const result = state.result;
  if (!result?.columns?.length) return;
  const rows = (result.rows || []).map((row) => {
    const obj = {};
    for (const col of result.columns) {
      obj[col] = row[col] ?? null;
    }
    return obj;
  });
  const payload = {
    columns: result.columns,
    rowCount: rows.length,
    rows,
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
    "export.json"
  );
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* ── Wire events ─────────────────────────────────── */

function wire() {
  wirePrefs();
  $("#btn-refresh-profiles").onclick = () => loadProfiles().catch(console.error);
  $("#btn-new-connection").onclick = openNewConnection;
  $("#btn-cancel-conn").onclick = () => {
    state.editingProfileId = null;
    setConnTestStatus("");
    $("#modal-connection").close();
  };
  $("#btn-test-conn").onclick = async () => {
    const form = $("#form-connection");
    const profile = readConnectionForm(form);
    const btn = $("#btn-test-conn");
    btn.disabled = true;
    setConnTestStatus("Testing connection…");
    try {
      const result = await api("/api/profiles/test", {
        method: "POST",
        body: JSON.stringify(profile),
      });
      setConnTestStatus(result.message || "Connection successful");
    } catch (err) {
      setConnTestStatus(err.message || "Connection test failed", true);
    } finally {
      btn.disabled = false;
    }
  };
  $("#btn-cancel-pw").onclick = () => $("#modal-password").close();
  $("#btn-import-browse").onclick = () => pickImportFileNative();
  $("#btn-close-db-props").onclick = () => $("#modal-db-props").close();
  $("#btn-cancel-db-admin").onclick = () => $("#modal-db-admin").close();
  $("#btn-cancel-schema").onclick = () => $("#modal-schema").close();
  $("#btn-cancel-create-table").onclick = () => $("#modal-create-table").close();
  $("#btn-cancel-create-view").onclick = () => $("#modal-create-view").close();
  $("#btn-close-indexes").onclick = () => $("#modal-indexes").close();
  $("#btn-cancel-add-col").onclick = () => $("#modal-add-column").close();
  $("#btn-cancel-clone").onclick = () => $("#modal-clone").close();
  $("#btn-cancel-export").onclick = () => $("#modal-export").close();
  $("#btn-cancel-import").onclick = () => $("#modal-import").close();
  $("#btn-add-col-row").onclick = () => addCreateTableColumnRow();

  for (const sel of CTX_MENUS) {
    $(sel).onclick = (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      handleContextAction(btn.dataset.action).catch((err) => alert(err.message));
    };
  }

  document.addEventListener("pointerdown", (e) => {
    if (Date.now() < suppressMenuHideUntil) return;
    if (e.target.closest(".ctx-menu") || e.target.closest(".tree-more")) return;
    hideAllContextMenus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideAllContextMenus();
  });
  window.addEventListener("blur", () => {
    if (Date.now() < suppressMenuHideUntil) return;
    hideAllContextMenus();
  });

  $("#form-db-admin").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      if (form.mode.value === "create") {
        await api("/api/databases", {
          method: "POST",
          body: JSON.stringify({
            name: form.name.value.trim(),
            charset: form.charset.value.trim() || undefined,
            collation: form.collation.value.trim() || undefined,
          }),
        });
        setStatus(`Created database ${form.name.value.trim()}`);
      } else {
        await api(`/api/databases/${encodeURIComponent(form.originalName.value)}`, {
          method: "PATCH",
          body: JSON.stringify({
            newName: form.newName.value.trim() || undefined,
            charset: form.charset.value.trim() || undefined,
            collation: form.collation.value.trim() || undefined,
          }),
        });
        setStatus(`Modified database ${form.originalName.value}`);
      }
      $("#modal-db-admin").close();
      await loadTree();
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-schema").onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    try {
      await api("/api/schemas", { method: "POST", body: JSON.stringify({ name }) });
      $("#modal-schema").close();
      await loadTree();
      setStatus(`Created schema ${name}`);
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-create-table").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const schema = form.schema.value;
    const columns = [...$("#create-table-cols").querySelectorAll(".col-row")].map((row) => ({
      name: row.querySelector(".col-name").value.trim(),
      sqlType: row.querySelector(".col-type").value.trim() || "VARCHAR(255)",
      nullable: row.querySelector(".col-null").checked,
      primaryKey: row.querySelector(".col-pk").checked,
      autoIncrement: row.querySelector(".col-ai").checked,
    })).filter((c) => c.name);
    try {
      await api(`/api/databases/${encodeURIComponent(schema)}/tables`, {
        method: "POST",
        body: JSON.stringify({ name: form.name.value.trim(), columns }),
      });
      $("#modal-create-table").close();
      await loadTree();
      setStatus(`Created table ${form.name.value.trim()}`);
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-create-view").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await api(`/api/databases/${encodeURIComponent(form.schema.value)}/views`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.value.trim(),
          selectSql: form.selectSql.value,
          replace: form.replace.checked,
        }),
      });
      $("#modal-create-view").close();
      await loadTree();
      setStatus(`Created view ${form.name.value.trim()}`);
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-create-index").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const columns = form.columns.value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await api(`/api/databases/${encodeURIComponent(form.schema.value)}/tables/${encodeURIComponent(form.table.value)}/indexes`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.value.trim() || undefined,
          columns,
          unique: form.unique.checked,
        }),
      });
      form.name.value = "";
      form.columns.value = "";
      form.unique.checked = false;
      await refreshIndexesList(form.schema.value, form.table.value);
      setStatus("Index created");
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-add-column").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await api(`/api/databases/${encodeURIComponent(form.schema.value)}/tables/${encodeURIComponent(form.table.value)}/columns`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.value.trim(),
          sqlType: form.sqlType.value.trim(),
          nullable: form.nullable.checked,
        }),
      });
      $("#modal-add-column").close();
      if (state.currentSchema === form.schema.value && state.currentTable === form.table.value) {
        await openTable(form.schema.value, form.table.value);
      }
      setStatus(`Added column ${form.name.value.trim()}`);
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-clone").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      setStatus("Cloning…");
      const result = await api(`/api/databases/${encodeURIComponent(form.source.value)}/clone`, {
        method: "POST",
        body: JSON.stringify({
          targetName: form.targetName.value.trim(),
          includeData: form.includeData.checked,
          includeViews: form.includeViews.checked,
          includeIndexes: form.includeIndexes.checked,
        }),
      });
      $("#modal-clone").close();
      await loadTree();
      setStatus(`Cloned ${result.tablesCopied || 0} table(s) to ${form.targetName.value.trim()}`);
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-export").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      setStatus("Exporting…");
      let payload;
      if (form.scope.value === "database") {
        const qs = new URLSearchParams({
          includeData: String(!!form.includeData.checked),
          limit: String(Number(form.limit.value) || 100000),
        });
        payload = await api(`/api/databases/${encodeURIComponent(form.schema.value)}/export?${qs}`);
      } else {
        const qs = new URLSearchParams({
          format: form.format.value,
          limit: String(Number(form.limit.value) || 100000),
        });
        payload = await api(`/api/databases/${encodeURIComponent(form.schema.value)}/tables/${encodeURIComponent(form.table.value)}/export?${qs}`);
      }
      await downloadExportPayload(payload);
      $("#modal-export").close();
      setStatus(`Exported ${payload.filename}`);
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-import").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const picked = state.importPicked;
    const paste = (form.paste?.value || "").trim();
    if (!picked && !paste) {
      alert("Choose a file or paste content to import");
      return;
    }
    if (!form.schema.value && form.mode.value !== "sql" && form.format.value !== "sql") {
      alert("Missing database/schema for import");
      return;
    }
    if (!form.table.value && form.mode.value !== "sql" && form.format.value !== "sql") {
      alert("Missing table name for import");
      return;
    }
    try {
      setStatus("Importing…");
      const format = form.format.value;
      const isExcel = format === "xlsx" || format === "excel";
      let content;
      let base64 = false;
      if (picked) {
        content = picked.content;
        base64 = !!picked.base64 || isExcel;
      } else {
        content = paste;
        base64 = false;
        if (isExcel) {
          alert("Excel import requires Choose file… (paste is for CSV/JSON/SQL).");
          return;
        }
      }
      const connOpts = state.activeConnectionId ? { connectionId: state.activeConnectionId } : {};
      if (form.mode.value === "sql" || format === "sql") {
        const result = await api("/api/import/sql", {
          method: "POST",
          body: JSON.stringify({ sql: content }),
          ...connOpts,
        });
        state.importPicked = null;
        $("#modal-import").close();
        await loadTree();
        setStatus(result.message || "SQL imported");
        return;
      }
      const result = await api(
        `/api/databases/${encodeURIComponent(form.schema.value)}/tables/${encodeURIComponent(form.table.value)}/import`,
        {
          method: "POST",
          body: JSON.stringify({
            format,
            content,
            base64,
            truncate: form.truncate.checked,
            headerRow: form.headerRow.checked,
          }),
          ...connOpts,
        }
      );
      state.importPicked = null;
      $("#modal-import").close();
      if (state.currentSchema === form.schema.value && state.currentTable === form.table.value) {
        await openTable(form.schema.value, form.table.value);
      } else {
        await loadTree();
      }
      setStatus(`Imported ${result.imported || 0} row(s)` + (result.failed ? `, ${result.failed} failed` : ""));
      if (result.errors?.length) {
        alert(`Import completed with errors:\n${result.errors.slice(0, 5).join("\n")}`);
      }
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-connection").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const profile = readConnectionForm(form);
    const wasEdit = !!state.editingProfileId;
    const typedPassword = profile.password;
    const typedSshPassword = profile.sshPassword;
    try {
      showError($("#sidebar-error"), "");
      const result = await api("/api/profiles", { method: "POST", body: JSON.stringify(profile) });
      const savedId = result.id || profile.id;
      state.editingProfileId = null;
      setConnTestStatus("");
      $("#modal-connection").close();
      await loadProfiles();
      setStatus("Connection saved");
      if (!wasEdit) {
        const saved = state.profiles.find((p) => p.id === savedId);
        if (saved) {
          state.selectedProfileId = saved.id;
          state.pendingExpandProfileId = saved.id;
          renderProfiles();
          // Reuse the password just typed so we don't prompt again.
          const credentials = (typedPassword || typedSshPassword)
            ? {
                username: profile.username,
                password: typedPassword || undefined,
                savePassword: profile.savePassword,
                sshUsername: profile.sshUsername || undefined,
                sshPassword: typedSshPassword || undefined,
                saveSshPassword: profile.saveSshPassword,
              }
            : null;
          await accessConnection(saved, credentials);
        }
      }
    } catch (err) {
      alert(err.message);
    }
  };

  $("#form-password").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const base = state.pendingProfile;
    if (!base) return;
    try {
      setStatus("Connecting…");
      await api("/api/connect/" + encodeURIComponent(base.id), {
        method: "POST",
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          savePassword: form.savePassword.checked,
          sshUsername: form.sshUsername ? form.sshUsername.value.trim() : undefined,
          sshPassword: form.sshPassword ? form.sshPassword.value : undefined,
          saveSshPassword: form.saveSshPassword ? form.saveSshPassword.checked : undefined,
        }),
      });
      $("#modal-password").close();
      showError($("#sidebar-error"), "");
      await onConnected();
    } catch (err) {
      setStatus("Connection failed");
      alert(err.message);
    }
  };

  $("#btn-run").onclick = () => runSql();
  $("#btn-load-sql").onclick = () => loadSqlFile();
  $("#btn-save-sql").onclick = () => saveSqlFile();
  $("#btn-find-sql").onclick = () => openSqlFindBar();
  $("#btn-sql-zoom-out")?.addEventListener("click", () => bumpSqlEditorZoom(-1));
  $("#btn-sql-zoom-in")?.addEventListener("click", () => bumpSqlEditorZoom(1));
  $("#btn-sql-find-next").onclick = () => runSqlFind(1, { focusEditor: true });
  $("#btn-sql-find-prev").onclick = () => runSqlFind(-1, { focusEditor: true });
  $("#btn-sql-find-close").onclick = () => closeSqlFindBar();
  $("#sql-find-input")?.addEventListener("input", () => runSqlFind(0, { focusEditor: false }));
  $("#sql-find-case")?.addEventListener("change", () => runSqlFind(0, { focusEditor: false }));
  $("#sql-find-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSqlFind(e.shiftKey ? -1 : 1, { focusEditor: false });
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSqlFindBar();
    } else if ((e.metaKey || e.ctrlKey) && (e.code === "Equal" || e.code === "Minus" || e.key === "=" || e.key === "-" || e.key === "+" || e.key === "_")) {
      // Allow zoom while find box focused.
      e.preventDefault();
      if (e.code === "Minus" || e.key === "-" || e.key === "_") bumpSqlEditorZoom(-1);
      else bumpSqlEditorZoom(1);
    }
  });
  wireSqlGlobalShortcuts();
  $("#btn-clear-sql").onclick = () => {
    setSqlEditorContent("", null, null);
    closeSqlFindBar();
  };
  $("#sql-file-input")?.addEventListener("change", onSqlFileInputChange);
  $("#ws-tabs-more")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWorkspaceTabsOverflowMenu();
  });
  $("#ws-tabs-overflow-menu")?.addEventListener("click", (e) => e.stopPropagation());
  $("#ws-tabs-overflow-menu")?.addEventListener("pointerdown", (e) => e.stopPropagation());
  $("#sql-db")?.addEventListener("change", () => {
    onSqlDatabaseChanged().catch((e) => console.error(e));
  });
  $("#sql-schema")?.addEventListener("change", () => {
    persistSqlContextToActiveTab();
    ensureSqlMeta({ force: true }).catch(() => {});
  });
  wireSqlEditor();
  wireSqlLog();
  updateRunButton();
  updateSqlFileChip();
  $("#data-search").oninput = () => {
    state.page = 1;
    renderData(state.result);
  };
  $("#btn-columns").onclick = (e) => {
    e.stopPropagation();
    toggleColumnVisibilityMenu();
  };
  $("#btn-columns-show-all").onclick = (e) => {
    e.stopPropagation();
    setAllColumnsVisible(true);
  };
  $("#btn-columns-hide-all").onclick = (e) => {
    e.stopPropagation();
    setAllColumnsVisible(false);
  };
  initColumnFilterPopup();
  $("#btn-clear-filters").onclick = () => clearColumnFilters();
  $("#col-filter-op").onchange = () => syncFilterPopupValueEnabled();
  $("#col-filter-apply").onclick = () => applyColumnFilterFromPopup();
  $("#col-filter-clear").onclick = () => {
    const column = state.filterPopupColumn;
    if (!column) return;
    clearColumnFilter(column);
    closeColumnFilterPopup();
  };
  $("#col-filter-value").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyColumnFilterFromPopup();
    }
  });
  $("#col-filter-popup")?.addEventListener("pointerdown", (e) => e.stopPropagation());
  updateClearFiltersButton();
  $("#col-visibility-menu")?.addEventListener("click", (e) => e.stopPropagation());
  $("#export-menu")?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".ws-tabs-more-wrap")) closeWorkspaceTabsOverflowMenu();
    if (!e.target.closest(".col-vis-wrap")) closeColumnVisibilityMenu();
    if (!e.target.closest(".export-wrap")) closeExportMenu();
    if (e.target.closest("#col-filter-popup") || e.target.closest("#data-table thead th.col-filterable")) return;
    closeColumnFilterPopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeColumnFilterPopup();
      closeColumnVisibilityMenu();
      closeExportMenu();
      closeWorkspaceTabsOverflowMenu();
    }
  });
  window.addEventListener("resize", () => {
    layoutWorkspaceTabOverflow({ keepMenuOpen: !$("#ws-tabs-overflow-menu")?.hidden });
    if (state.filterPopupColumn) closeColumnFilterPopup();
  });
  $("#btn-export")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleExportMenu();
  });
  $("#btn-export-csv").onclick = () => {
    closeExportMenu();
    exportCsv();
  };
  $("#btn-export-json").onclick = () => {
    closeExportMenu();
    exportJson();
  };
  $("#btn-page-prev").onclick = () => {
    changeDataPage(-1).catch((e) => setStatus(e.message || "Failed to change page"));
  };
  $("#btn-page-next").onclick = () => {
    changeDataPage(1).catch((e) => setStatus(e.message || "Failed to change page"));
  };
  $$(".tabs .tab").forEach((t) => t.onclick = () => {
    closeColumnVisibilityMenu();
    closeExportMenu();
    closeColumnFilterPopup();
    closeWorkspaceTabsOverflowMenu();
    switchTab(t.dataset.tab);
  });
  $("#btn-back-to-sql")?.addEventListener("click", () => {
    switchTab("sql");
    $("#sql-editor")?.focus();
  });
}

async function boot() {
  wire();
  setConnectedUi(false);
  updateRunButton();
  renderWorkspaceTabs();
  updateViewTabBarVisibility();
  await loadDbTypes();
  await loadProfiles();
  const session = await syncSessionState();
  if (session.connected || (session.sessions || []).length) {
    for (const s of session.sessions || []) {
      if (s.id) setExpanded(s.id, true);
    }
    if (session.activeId) {
      state.selectedProfileId = session.activeId;
      setExpanded(session.activeId, true);
    } else if (session.profile?.id) {
      state.selectedProfileId = session.profile.id;
      setExpanded(session.profile.id, true);
    }
    setConnectedUi(true);
    renderProfiles();
    const count = Object.keys(state.connectedIds).length;
    setStatus(count > 1 ? `Connected (${count} sessions)` : "Connected");
    await focusHomeDetails({ scope: "connection" });
  } else {
    setStatus("Ready");
    showEmptyWorkspace();
  }
}

boot().catch((e) => {
  console.error(e);
  showError($("#sidebar-error"), e.message);
});
