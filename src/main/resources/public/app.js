const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PREFS_KEY = "forge-dbmanager-prefs";
const THEMES = ["teal", "ocean", "ember", "violet", "slate", "light"];
const DENSITIES = ["comfortable", "compact"];

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
  pageSize: 50,
  contextDb: null,
  contextTarget: null,
  expandedProfileIds: {},
  pendingExpandProfileId: null,
  connectedIds: {},
  activeConnectionId: null,
  detailFocus: { scope: "connection", schema: null, table: null, database: null },
  currentTab: "details",
  importPicked: null,
  /** Workspace tabs: DB/SCH context tab (transient) + closable table tabs. */
  workspaceTabs: [],
  activeWorkspaceTabId: null,
};

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
  const enabled = !!state.currentTable;
  btn.disabled = !enabled;
  btn.title = enabled ? "Run SQL (⌘/Ctrl + Enter)" : "Select a table to run SQL";
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

function applyPrefs() {
  const prefs = loadPrefs();
  const theme = THEMES.includes(prefs.theme) ? prefs.theme : "teal";
  const density = DENSITIES.includes(prefs.density) ? prefs.density : "compact";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = density;
  $$(".pref-theme").forEach((el) => { el.value = theme; });
  $$(".pref-density").forEach((el) => { el.value = density; });
  applySidebarWidth(prefs.sidebarWidth);
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
    };
  });
  applyPrefs();
  wireSidebarResize();
}

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
    return `${p.displayType} · ${fileBaseName(p.database) || ""}`;
  }
  if (p.useSshTunnel || p.sshTunnel) {
    return `${p.displayType} · ${p.host} via ${p.sshHost || "SSH"}`;
  }
  return `${p.displayType} · ${p.host}${p.database ? " / " + p.database : ""}`;
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
    label.innerHTML = `<strong>${escapeHtml(p.name || "Untitled")}</strong>`
      + `<span class="conn-meta">${escapeHtml(profileDetail(p))}${live ? " · live" : ""}</span>`;
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
    showDbContextMenu(rect.left, rect.bottom + 4, node.schema || node.name, kind);
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
    showDbContextMenu(e.clientX, e.clientY, node.schema || node.name, kind);
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

function showDbContextMenu(x, y, db, kind = "database") {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextDb = db;
  state.contextTarget = { type: "db", schema: db, kind };
  const menu = $("#ctx-menu-db");
  const isSchema = kind === "schema";
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

function showTableContextMenu(x, y, schema, table) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextTarget = { type: "table", schema, table };
  positionContextMenu($("#ctx-menu-table"), x, y);
}

function showViewContextMenu(x, y, schema, view) {
  for (const sel of CTX_MENUS) {
    const menu = $(sel);
    if (menu) menu.hidden = true;
  }
  state.contextTarget = { type: "view", schema, view };
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
      case "open-table":
        hideAllContextMenus();
        await openTable(target.schema, target.table);
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
        if (kind === "table") showTableContextMenu(rect.left, rect.bottom + 4, schema, name);
        else showViewContextMenu(rect.left, rect.bottom + 4, schema, name);
      };
      item.appendChild(more);
      item.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (connectionId) state.activeConnectionId = connectionId;
        if (kind === "table") showTableContextMenu(e.clientX, e.clientY, schema, name);
        if (kind === "view") showViewContextMenu(e.clientX, e.clientY, schema, name);
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
  const scope = tab.detailFocus?.scope || tab.scope;
  if (scope === "schema") return "SCH";
  return "DB";
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
  updateRunButton();
  updateContextMeta("");
  $("#data-context").textContent = "No table selected";
  $("#sql-editor").value = "";
  $("#ddl-view").textContent = "Select a table and open DDL.";
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
  tab.sql = $("#sql-editor")?.value ?? tab.sql;
  tab.ddl = $("#ddl-view")?.textContent ?? tab.ddl;
  tab.detailFocus = { ...(state.detailFocus || {}) };
}

function renderWorkspaceTabs() {
  const root = $("#workspace-tabs");
  if (!root) return;
  root.innerHTML = "";
  sortWorkspaceTabs();
  for (const tab of state.workspaceTabs) {
    const canClose = !tab.pinned && tab.closable !== false;
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
      + `<span class="ws-tab-label">${escapeHtml(tab.title)}</span>`
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
}

async function activateWorkspaceTab(tabId, { forceReload = false } = {}) {
  if (!tabId) return;
  if (tabId !== state.activeWorkspaceTabId) {
    snapshotActiveWorkspaceTab();
  }
  const tab = state.workspaceTabs.find((t) => t.id === tabId);
  if (!tab) return;
  state.activeWorkspaceTabId = tabId;
  renderWorkspaceTabs();
  await applyWorkspaceTab(tabId, { forceReload });
}

async function applyWorkspaceTab(tabId, { forceReload = false } = {}) {
  if (!tabId) {
    showEmptyWorkspace();
    return;
  }
  const tab = state.workspaceTabs.find((t) => t.id === tabId);
  if (!tab) return;

  if (tab.kind === "context" || tab.kind === "home") {
    state.currentSchema = null;
    state.currentTable = null;
    state.columns = [];
    state.result = null;
    state.page = 1;
    if (tab.detailFocus) state.detailFocus = { ...tab.detailFocus };
    tab.title = contextTabTitle(state.detailFocus);
    renderWorkspaceTabs();
    updateRunButton();
    $("#data-context").textContent = "No table selected";
    $("#sql-editor").value = tab.sql || "";
    $("#ddl-view").textContent = tab.ddl || "Select a table and open DDL.";
    renderStructure([]);
    renderData(null);
    updateContextMeta(tab.title || "");
    switchTab(tab.viewMode || "details", { skipTitle: true });
    return;
  }

  if (tab.connectionId) state.activeConnectionId = tab.connectionId;
  state.currentSchema = tab.schema;
  state.currentTable = tab.table;
  setDetailFocus({ scope: "table", schema: tab.schema, table: tab.table });
  updateRunButton();
  $("#data-context").textContent = `${tab.schema} · ${tab.table}`;
  updateContextMeta(`${tab.schema} · ${tab.table}`);

  const hasCache = !forceReload && tab.columns && tab.result;
  if (hasCache) {
    state.columns = tab.columns;
    state.result = tab.result;
    state.page = tab.page || 1;
    $("#sql-editor").value = tab.sql || `SELECT * FROM ${quoteIdent(tab.table)} LIMIT ${Number($("#row-limit").value) || 500}`;
    $("#ddl-view").textContent = tab.ddl || "";
    renderStructure(tab.columns);
    renderData(tab.result);
    switchTab(tab.viewMode || "data", { skipTitle: true });
    return;
  }

  await loadTableIntoActiveTab(tab);
}

async function loadTableIntoActiveTab(tab) {
  const schema = tab.schema;
  const table = tab.table;
  const cid = tab.connectionId || state.activeConnectionId;
  updateContextMeta("Loading…");
  setStatus(`Loading ${table}…`);
  const limit = Number($("#row-limit").value) || 500;
  const base = `/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}`;
  const [cols, rows] = await Promise.all([
    api(withConnectionId(`${base}/columns`, cid)),
    api(withConnectionId(`${base}/rows?limit=${limit}`, cid)),
  ]);
  let ddlText = "DDL unavailable";
  try {
    const ddl = await api(withConnectionId(`${base}/ddl`, cid));
    ddlText = ddl.ddl || "";
  } catch {
    /* ignore */
  }
  const sql = `SELECT * FROM ${quoteIdent(table)} LIMIT ${limit}`;

  // Tab may have been closed while loading
  const live = state.workspaceTabs.find((t) => t.id === tab.id);
  if (!live) return;

  live.columns = cols;
  live.result = rows;
  live.ddl = ddlText;
  live.sql = sql;
  live.page = 1;
  live.viewMode = live.viewMode === "details" ? "data" : (live.viewMode || "data");

  if (state.activeWorkspaceTabId !== live.id) return;

  state.columns = cols;
  state.result = rows;
  state.page = 1;
  state.currentSchema = schema;
  state.currentTable = table;
  $("#sql-editor").value = sql;
  $("#ddl-view").textContent = ddlText;
  $("#data-context").textContent = `${schema} · ${table}`;
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

  let tab = state.workspaceTabs.find((t) => t.id === id);
  if (!tab) {
    tab = {
      id,
      kind: "table",
      title: table,
      schema,
      table,
      database: dbName,
      connectionId: cid,
      closable: true,
      pinned: false,
      viewMode: "data",
    };
    state.workspaceTabs.push(tab);
  } else {
    tab.connectionId = cid;
    tab.schema = schema;
    tab.table = table;
    tab.database = dbName || tab.database;
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

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function updateContextMeta(text) {
  const el = $("#context-meta");
  if (!el) return;
  if (!text) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
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

function switchTab(name, { skipTitle = false } = {}) {
  state.currentTab = name;
  const activeWs = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
  if (activeWs) activeWs.viewMode = name;

  $$(".tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));

  if (!skipTitle) {
    if (state.currentTable && state.currentSchema) {
      updateContextMeta(`${state.currentSchema} · ${state.currentTable}`);
    } else if (state.detailFocus?.scope === "schema" && state.detailFocus.schema) {
      updateContextMeta(state.detailFocus.schema);
    } else if (state.detailFocus?.scope === "database" && state.detailFocus.database) {
      updateContextMeta(state.detailFocus.database);
    } else if (name !== "details") {
      updateContextMeta("");
    }
  }
  if (name === "details") {
    refreshDetails().catch((e) => console.error(e));
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

function filteredRows(result) {
  const q = ($("#data-search").value || "").toLowerCase();
  if (!q) return result.rows || [];
  return (result.rows || []).filter((row) =>
    Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(q))
  );
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
    return;
  }
  empty.hidden = true;

  const head = document.createElement("tr");
  for (const c of result.columns) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  thead.appendChild(head);

  const rows = filteredRows(result);
  const pageSize = Math.max(1, state.pageSize || 50);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize) || 1);
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const start = (state.page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  for (const row of pageRows) {
    const tr = document.createElement("tr");
    for (const c of result.columns) {
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

  const end = rows.length ? Math.min(start + pageRows.length, rows.length) : 0;
  const from = rows.length ? start + 1 : 0;
  const schemaBit = state.currentSchema ? `${state.currentSchema} · ` : "";
  const tableBit = state.currentTable ? `${state.currentTable} · ` : "";
  updateContextMeta(
    `${schemaBit}${tableBit}${rows.length} row${rows.length === 1 ? "" : "s"}` +
    (rows.length !== (result.rows?.length || 0) ? ` (filtered from ${result.rows.length})` : "") +
    ` · showing ${from}–${end}` +
    (result.executionMs != null ? ` · ${result.executionMs} ms` : "")
  );
  updatePager(from, end, rows.length, totalPages);
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

async function runSql() {
  if (!state.currentTable) {
    setStatus("Select a table first");
    return;
  }
  const sql = $("#sql-editor").value.trim();
  if (!sql) return;
  setStatus("Executing…");
  try {
    const result = await api("/api/query", { method: "POST", body: JSON.stringify({ sql }) });
    state.result = result;
    state.page = 1;
    const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
    if (tab && tab.kind === "table") {
      tab.result = result;
      tab.page = 1;
      tab.sql = sql;
      tab.viewMode = "data";
    }
    renderData(result);
    switchTab("data");
    setStatus(result.message);
  } catch (e) {
    setStatus(e.message);
    alert(e.message);
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
  $("#btn-clear-sql").onclick = () => { $("#sql-editor").value = ""; };
  $("#sql-editor").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!state.currentTable) return;
      runSql();
    }
  });
  updateRunButton();
  $("#data-search").oninput = () => {
    state.page = 1;
    renderData(state.result);
  };
  $("#btn-export-csv").onclick = exportCsv;
  $("#btn-export-json").onclick = exportJson;
  $("#btn-page-prev").onclick = () => {
    state.page -= 1;
    renderData(state.result);
  };
  $("#btn-page-next").onclick = () => {
    state.page += 1;
    renderData(state.result);
  };
  $$(".tabs .tab").forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
}

async function boot() {
  wire();
  setConnectedUi(false);
  updateRunButton();
  renderWorkspaceTabs();
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
