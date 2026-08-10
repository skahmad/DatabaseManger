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
  /**
   * Explorer tree cache per connection:
   * { [connectionId]: { explorer, objects: { [schema]: { tables, views, procs, funcs } }, details: { [key]: payload } } }
   */
  explorerCache: {},
  /** Unified sidebar search: entity = db | sch | tbl */
  explorerSearch: {
    entity: "db",
    query: "",
    matches: [],
    activeIndex: 0,
    scanToken: 0,
    scanning: false,
    /** True while a one-time path reveal is running (paint stays unlocked). */
    revealing: false,
    /** `${entity}\\0${query}` — when this changes, paths may be auto-opened once. */
    revealKey: "",
    /** Connection ids already auto-opened for the current revealKey. */
    revealedConnIds: {},
    /** Connection ids the user collapsed while a search is active. */
    userCollapsedConnIds: {},
  },
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

function wireExplorerSearch() {
  const input = $("#explorer-search");
  if (!input) return;

  let debounce = null;
  const run = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => refreshExplorerSearch(), 120);
  };

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closeExplorerEntityMenu();
      const m = (state.explorerSearch.matches || [])[0];
      if (m) openExplorerSearchMatch(m).catch((err) => showError($("#sidebar-error"), err.message));
      else $("#conn-tree")?.querySelector(".tree-row.search-hit")?.click();
    } else if (e.key === "Escape") {
      const menu = $("#explorer-entity-menu");
      if (menu && !menu.hidden) {
        e.preventDefault();
        closeExplorerEntityMenu();
        return;
      }
      input.value = "";
      refreshExplorerSearch();
    }
  });

  const chip = $("#explorer-entity-chip");
  chip?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleExplorerEntityMenu();
  });

  $$(".explorer-entity-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setExplorerSearchEntity(opt.dataset.entity);
      input.focus();
    });
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#explorer-search-field")) return;
    closeExplorerEntityMenu();
  });

  setExplorerSearchEntity(state.explorerSearch.entity || "db", { refresh: false });
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

const EXPLORER_SEARCH_ENTITIES = ["db", "sch", "tbl", "vw", "proc", "func"];
const EXPLORER_SEARCH_META = {
  db: { label: "Database", chip: "DB", placeholder: "Search databases…", badge: "DB", badgeClass: "db", empty: "No databases match. Connect and expand a connection first." },
  sch: { label: "Schema", chip: "SCH", placeholder: "Search schemas…", badge: "SCH", badgeClass: "vw", empty: "No schemas match. Connect and expand a connection first." },
  tbl: { label: "Table", chip: "TBL", placeholder: "Search tables…", badge: "TBL", badgeClass: "tbl", empty: "No tables match in cache — expand a database to load its tables." },
  vw: { label: "View", chip: "VW", placeholder: "Search views…", badge: "VW", badgeClass: "vw", empty: "No views match in cache — expand a database to load its views." },
  proc: { label: "Procedure", chip: "PROC", placeholder: "Search procedures…", badge: "PROC", badgeClass: "db", empty: "No procedures match in cache — expand a database to load them." },
  func: { label: "Function", chip: "FN", placeholder: "Search functions…", badge: "FN", badgeClass: "db", empty: "No functions match in cache — expand a database to load them." },
};

function explorerSearchQuery() {
  return (state.explorerSearch?.query
    || $("#explorer-search")?.value
    || "").trim().toLowerCase();
}

function explorerSearchEntity() {
  const entity = state.explorerSearch?.entity || "db";
  return EXPLORER_SEARCH_ENTITIES.includes(entity) ? entity : "db";
}

function closeExplorerEntityMenu() {
  const menu = $("#explorer-entity-menu");
  const chip = $("#explorer-entity-chip");
  if (menu) menu.hidden = true;
  if (chip) chip.setAttribute("aria-expanded", "false");
}

function openExplorerEntityMenu() {
  const menu = $("#explorer-entity-menu");
  const chip = $("#explorer-entity-chip");
  if (!menu || !chip) return;
  const current = explorerSearchEntity();
  menu.querySelectorAll(".explorer-entity-option").forEach((opt) => {
    opt.setAttribute("aria-selected", opt.dataset.entity === current ? "true" : "false");
  });
  menu.hidden = false;
  chip.setAttribute("aria-expanded", "true");
}

function toggleExplorerEntityMenu() {
  const menu = $("#explorer-entity-menu");
  if (!menu || !menu.hidden) closeExplorerEntityMenu();
  else openExplorerEntityMenu();
}

function setExplorerSearchEntity(entity, { refresh = true } = {}) {
  const next = EXPLORER_SEARCH_ENTITIES.includes(entity) ? entity : "db";
  state.explorerSearch.entity = next;
  const meta = EXPLORER_SEARCH_META[next] || EXPLORER_SEARCH_META.db;
  const chipLabel = $("#explorer-entity-chip-label");
  if (chipLabel) chipLabel.textContent = meta.chip;
  const chip = $("#explorer-entity-chip");
  if (chip) chip.title = `Search ${meta.label.toLowerCase()}s`;
  const input = $("#explorer-search");
  if (input) input.placeholder = meta.placeholder || "Search…";
  $$(".explorer-entity-option").forEach((opt) => {
    opt.setAttribute("aria-selected", opt.dataset.entity === next ? "true" : "false");
  });
  closeExplorerEntityMenu();
  if (refresh) refreshExplorerSearch();
}

function needsExplorerObjectIndex(entity = explorerSearchEntity()) {
  return entity === "tbl" || entity === "vw" || entity === "proc" || entity === "func";
}

function connectionLabel(connectionId) {
  const p = (state.profiles || []).find((x) => x.id === connectionId);
  return p?.name || "Connection";
}

function pushObjectSearchMatches(out, {
  entity, connectionId, connName, schema, names, kind, badge, badgeClass, query,
}) {
  for (const name of names || []) {
    if (!String(name).toLowerCase().includes(query)) continue;
    out.push({
      entity,
      connectionId,
      name,
      schema,
      database: schema,
      kind,
      path: `${connName} · ${schema}`,
      badge,
      badgeClass,
    });
  }
}

/** Collect explorer matches from cache for the selected entity type. */
function collectExplorerSearchMatches(query, entity) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const liveIds = Object.keys(state.connectedIds || {}).filter((id) => state.connectedIds[id]);
  const ids = liveIds.length
    ? liveIds
    : Object.keys(state.explorerCache || {});
  const meta = EXPLORER_SEARCH_META[entity] || EXPLORER_SEARCH_META.db;

  for (const connectionId of ids) {
    const entry = state.explorerCache[connectionId];
    if (!entry) continue;
    const connName = connectionLabel(connectionId);
    const nodes = entry.explorer?.nodes || [];
    const layout = entry.explorer?.layout || "";

    if (entity === "db") {
      if (!entry.explorer) continue;
      for (const node of nodes) {
        if ((node.kind || "database") !== "database") continue;
        const name = node.name || "";
        if (!name.toLowerCase().includes(q)) continue;
        out.push({
          entity: "db",
          connectionId,
          name,
          schema: node.schema || name,
          database: name,
          path: connName,
          badge: meta.badge,
          badgeClass: meta.badgeClass,
        });
      }
    } else if (entity === "sch") {
      if (!entry.explorer) continue;
      for (const node of nodes) {
        const kind = node.kind || "database";
        if (kind === "schema") {
          const name = node.name || "";
          if (!name.toLowerCase().includes(q)) continue;
          out.push({
            entity: "sch",
            connectionId,
            name,
            schema: node.schema || name,
            database: null,
            path: connName,
            badge: meta.badge,
            badgeClass: meta.badgeClass,
          });
          continue;
        }
        if (kind === "database" && Array.isArray(node.children)) {
          for (const child of node.children) {
            const name = child.name || "";
            if (!name.toLowerCase().includes(q)) continue;
            out.push({
              entity: "sch",
              connectionId,
              name,
              schema: child.schema || name,
              database: node.name || null,
              path: `${connName} · ${node.name}`,
              badge: meta.badge,
              badgeClass: meta.badgeClass,
            });
          }
        } else if (kind === "database" && layout !== "database-schemas") {
          // MySQL 2-layer: database acts as schema namespace too.
          const name = node.name || "";
          if (!name.toLowerCase().includes(q)) continue;
          out.push({
            entity: "sch",
            connectionId,
            name,
            schema: node.schema || name,
            database: name,
            path: connName,
            badge: meta.badge,
            badgeClass: meta.badgeClass,
          });
        }
      }
    } else if (needsExplorerObjectIndex(entity)) {
      // Cache-only — never trigger network from search.
      const objects = entry.objects || {};
      for (const [schema, bag] of Object.entries(objects)) {
        if (entity === "tbl") {
          pushObjectSearchMatches(out, {
            entity, connectionId, connName, schema, query: q,
            names: bag.tables, kind: "table",
            badge: meta.badge, badgeClass: meta.badgeClass,
          });
        } else if (entity === "vw") {
          pushObjectSearchMatches(out, {
            entity, connectionId, connName, schema, query: q,
            names: bag.views, kind: "view",
            badge: meta.badge, badgeClass: meta.badgeClass,
          });
        } else if (entity === "proc") {
          pushObjectSearchMatches(out, {
            entity, connectionId, connName, schema, query: q,
            names: bag.procs, kind: "procedure",
            badge: meta.badge, badgeClass: meta.badgeClass,
          });
        } else if (entity === "func") {
          pushObjectSearchMatches(out, {
            entity, connectionId, connName, schema, query: q,
            names: bag.funcs, kind: "function",
            badge: meta.badge, badgeClass: meta.badgeClass,
          });
        }
      }
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return out.slice(0, 200);
}

function clearExplorerSearchFilterClasses() {
  const tree = $("#conn-tree");
  if (!tree) return;
  tree.classList.remove("is-searching");
  tree.querySelectorAll(".search-miss, .search-hit").forEach((el) => {
    el.classList.remove("search-miss", "search-hit");
  });
}

function resetExplorerSearchDomState() {
  clearExplorerSearchFilterClasses();
  const tree = $("#conn-tree");
  if (!tree) return;
  tree.querySelectorAll("[data-search-opened],[data-user-collapsed]").forEach((el) => {
    delete el.dataset.searchOpened;
    delete el.dataset.userCollapsed;
  });
}

function searchLeafKind(entity) {
  return ({ tbl: "table", vw: "view", proc: "proc", func: "func" })[entity] || null;
}

function markSearchOpened(node, kids) {
  if (!node || !kids) return;
  // Respect manual collapse during an active search.
  if (node.dataset.userCollapsed === "1") return;
  if (node.classList.contains("conn-node")) {
    const id = node.dataset.profileId;
    if (id && state.explorerSearch.userCollapsedConnIds[id]) return;
    // Keep state in sync with DOM — otherwise later clicks invert expand/collapse.
    if (id) setExpanded(id, true);
  }
  if (kids.hidden) {
    node.dataset.searchOpened = "1";
    kids.hidden = false;
  }
  const caret = node.querySelector(":scope > .tree-row .tree-caret");
  if (caret) caret.textContent = "▾";
}

/** Open paths to current matches once — never re-force after the user collapses. */
async function expandTreeForSearchMatches(matches, entity) {
  const tree = $("#conn-tree");
  if (!tree || !matches?.length) return;

  const byConn = new Map();
  for (const m of matches) {
    if (!byConn.has(m.connectionId)) byConn.set(m.connectionId, []);
    byConn.get(m.connectionId).push(m);
  }

  for (const [connectionId, list] of byConn) {
    if (state.explorerSearch.userCollapsedConnIds[connectionId]) continue;
    const conn = tree.querySelector(`.conn-node[data-profile-id="${CSS.escape(connectionId)}"]`);
    if (!conn || conn.dataset.userCollapsed === "1") continue;
    const connKids = conn.querySelector(":scope > .conn-children");
    markSearchOpened(conn, connKids);

    if (entity === "db") continue;

    const schemas = [...new Set(list.map((m) => m.schema).filter(Boolean))];
    for (const schema of schemas) {
      const dbNode = [...conn.querySelectorAll(".tree-node[data-tree-kind='database']")]
        .find((n) => {
          const kids = n.querySelectorAll(":scope > .tree-children > .tree-node[data-tree-kind='schema']");
          return [...kids].some((s) => s.dataset.treeSchema === schema);
        });
      if (dbNode && dbNode.dataset.userCollapsed !== "1" && dbNode.expandForSearch) {
        await dbNode.expandForSearch();
      }

      const node = findExplorerTreeNode(connectionId, schema);
      if (!node || node.dataset.userCollapsed === "1" || !node.expandForSearch) continue;
      await node.expandForSearch();
      if (!needsExplorerObjectIndex(entity)) continue;
      const want = searchLeafKind(entity);
      const folder = [...node.querySelectorAll(":scope > .tree-children > .tree-node[data-folder-kind]")]
        .find((el) => el.dataset.folderKind === want);
      if (folder && folder.dataset.userCollapsed !== "1") {
        markSearchOpened(folder, folder.querySelector(":scope > .tree-children"));
      }
    }
  }
}

/** Apply search-miss / search-hit classes only (no expand/collapse mutation). */
function paintExplorerSearchFilter(matches, entity) {
  const tree = $("#conn-tree");
  if (!tree) return;
  tree.classList.add("is-searching");
  const matchConnIds = new Set((matches || []).map((m) => m.connectionId));

  for (const conn of tree.querySelectorAll(".conn-node")) {
    const id = conn.dataset.profileId;
    const hide = !matchConnIds.has(id)
      && !(state.explorerSearch.scanning && isLiveProfile({ id }));
    conn.classList.toggle("search-miss", hide);
    conn.classList.toggle("search-hit", matchConnIds.has(id));
  }

  if (entity === "db") {
    // Filter databases only — leave descendants unmarked so expand/collapse still shows content.
    for (const node of tree.querySelectorAll(".tree-node[data-tree-kind='database']")) {
      const cid = node.dataset.treeConnectionId;
      const key = node.dataset.treeSchema;
      const hit = matches.some((m) => m.connectionId === cid && (m.name === key || m.schema === key));
      node.classList.toggle("search-miss", !hit);
      node.classList.toggle("search-hit", hit);
      node.querySelector(":scope > .tree-row")?.classList.toggle("search-hit", hit);
    }
    return;
  }

  if (entity === "sch") {
    // Filter schemas (and DB parents) only — do not hide tables/folders under a hit schema.
    for (const node of tree.querySelectorAll(".tree-node[data-tree-kind='database']")) {
      const cid = node.dataset.treeConnectionId;
      const dbName = node.dataset.treeSchema;
      const childSchemas = [...node.querySelectorAll(":scope > .tree-children > .tree-node[data-tree-kind='schema']")];
      if (childSchemas.length) {
        let any = false;
        for (const sch of childSchemas) {
          const key = sch.dataset.treeSchema;
          const hit = matches.some((m) => m.connectionId === cid && (m.name === key || m.schema === key));
          sch.classList.toggle("search-miss", !hit);
          sch.classList.toggle("search-hit", hit);
          sch.querySelector(":scope > .tree-row")?.classList.toggle("search-hit", hit);
          if (hit) any = true;
        }
        node.classList.toggle("search-miss", !any);
        node.classList.toggle("search-hit", any);
      } else {
        const hit = matches.some((m) => m.connectionId === cid && (m.name === dbName || m.schema === dbName));
        node.classList.toggle("search-miss", !hit);
        node.classList.toggle("search-hit", hit);
        node.querySelector(":scope > .tree-row")?.classList.toggle("search-hit", hit);
      }
    }
    return;
  }

  const wantKind = searchLeafKind(entity);
  for (const leaf of tree.querySelectorAll(".tree-leaf")) {
    const hit = matches.some((m) => (
      m.connectionId === leaf.dataset.treeConnectionId
      && m.schema === leaf.dataset.treeSchema
      && m.name === leaf.dataset.treeTable
      && leaf.dataset.treeKind === wantKind
    ));
    leaf.classList.toggle("search-miss", !hit);
    leaf.classList.toggle("search-hit", hit);
    leaf.querySelector(":scope > .tree-row")?.classList.toggle("search-hit", hit);
  }
  for (const folder of tree.querySelectorAll(".tree-node[data-folder-kind]")) {
    const visibleLeaf = folder.dataset.folderKind === wantKind
      && !!folder.querySelector(".tree-leaf.search-hit");
    folder.classList.toggle("search-miss", !visibleLeaf);
    folder.classList.toggle("search-hit", visibleLeaf);
  }
  for (const node of tree.querySelectorAll(
    ".tree-node[data-tree-kind='database'], .tree-node[data-tree-kind='schema']"
  )) {
    const hasHit = !!node.querySelector(".tree-leaf.search-hit, .tree-node[data-folder-kind].search-hit");
    node.classList.toggle("search-miss", !hasHit);
    node.classList.toggle("search-hit", hasHit);
  }
}

/** Update search-miss/hit classes + status only (never toggles expand/collapse). */
function syncExplorerSearchFilter() {
  const status = $("#explorer-search-status");
  const tree = $("#conn-tree");
  if (!tree) return;

  const q = explorerSearchQuery();
  const entity = explorerSearchEntity();

  if (!q) {
    const wasSearching = tree.classList.contains("is-searching")
      || !!state.explorerSearch.revealKey
      || !!(state.explorerSearch.matches || []).length;
    state.explorerSearch.scanToken += 1;
    state.explorerSearch.scanning = false;
    state.explorerSearch.matches = [];
    state.explorerSearch.revealKey = "";
    state.explorerSearch.revealedConnIds = {};
    state.explorerSearch.userCollapsedConnIds = {};
    resetExplorerSearchDomState();
    if (status) status.hidden = true;
    if (wasSearching) renderProfiles();
    return;
  }

  const matches = collectExplorerSearchMatches(q, entity);
  state.explorerSearch.matches = matches;
  clearExplorerSearchFilterClasses();
  paintExplorerSearchFilter(matches, entity);

  if (status) {
    if (state.explorerSearch.scanning) {
      status.hidden = false;
    } else if (!matches.length) {
      status.hidden = false;
      status.textContent = EXPLORER_SEARCH_META[entity]?.empty || "No matches";
    } else {
      status.hidden = false;
      status.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"} in list`;
    }
  }
}

/**
 * One-time open for match connections not yet revealed (and not user-collapsed).
 * Safe to call after indexing finds additional connections — does not re-force
 * connections the user already collapsed/expanded.
 */
async function revealExplorerSearchPaths() {
  const q = explorerSearchQuery();
  if (!q || state.explorerSearch.revealing) return;
  state.explorerSearch.revealing = true;
  try {
    const entity = explorerSearchEntity();
    const matches = collectExplorerSearchMatches(q, entity);
    state.explorerSearch.matches = matches;

    const pendingIds = [...new Set(matches.map((m) => m.connectionId))]
      .filter((id) => (
        state.connectedIds[id]
        && !state.explorerSearch.userCollapsedConnIds[id]
        && !state.explorerSearch.revealedConnIds[id]
      ));
    if (!pendingIds.length) return;

    let needRerender = false;
    for (const id of pendingIds) {
      state.explorerSearch.revealedConnIds[id] = true;
      if (!isExpanded(id)) {
        setExpanded(id, true);
        needRerender = true;
      }
    }
    if (needRerender) {
      renderProfiles();
      // Children load async; loadTreeInto paints + opens nested match paths.
      return;
    }

    const subset = matches.filter((m) => pendingIds.includes(m.connectionId));
    await expandTreeForSearchMatches(subset, entity);
    syncExplorerSearchFilter();
  } finally {
    state.explorerSearch.revealing = false;
  }
}

/** Paint filter, then reveal any not-yet-opened match connections. */
async function applyExplorerSearchToTree() {
  const q = explorerSearchQuery();
  if (!q) {
    syncExplorerSearchFilter();
    return;
  }
  syncExplorerSearchFilter();
  await revealExplorerSearchPaths();
}

function refreshExplorerSearch() {
  const input = $("#explorer-search");
  state.explorerSearch.query = (input?.value || "").trim();
  const q = explorerSearchQuery();
  const entity = explorerSearchEntity();
  const key = q ? `${entity}\0${q}` : "";
  if (key !== state.explorerSearch.revealKey) {
    state.explorerSearch.revealKey = key;
    state.explorerSearch.revealedConnIds = {};
    state.explorerSearch.userCollapsedConnIds = {};
  }
  state.explorerSearch.activeIndex = 0;
  // Cache-only filter — do not background-index every schema (that hung the UI).
  applyExplorerSearchToTree().catch(() => {});
}

function routineSearchSql(match) {
  const ident = String(match.name || "").replace(/`/g, "``");
  if (match.entity === "func") {
    return `SELECT \`${ident}\`(/* args */);`;
  }
  return `CALL \`${ident}\`(/* args */);`;
}

async function openExplorerSearchMatch(match) {
  if (!match) return;
  hideAllContextMenus();
  state.activeConnectionId = match.connectionId;
  setExpanded(match.connectionId, true);
  await api("/api/session/active", {
    method: "POST",
    body: JSON.stringify({ id: match.connectionId }),
  }).catch(() => {});

  if (match.entity === "db") {
    await focusHomeDetails({
      scope: "database",
      database: match.database || match.name,
      schema: match.schema || match.name,
      connectionId: match.connectionId,
    });
    renderProfiles();
    setStatus(`Opened database ${match.name}`);
    return;
  }
  if (match.entity === "sch") {
    await focusHomeDetails({
      scope: "schema",
      schema: match.schema || match.name,
      database: match.database || profileDatabaseName(match.connectionId),
      connectionId: match.connectionId,
    });
    renderProfiles();
    setStatus(`Opened schema ${match.name}`);
    return;
  }
  if (match.entity === "proc" || match.entity === "func") {
    await openSqlEditor({
      connectionId: match.connectionId,
      database: match.database || match.schema,
      schema: match.schema,
      table: null,
    });
    const sql = routineSearchSql(match);
    setSqlEditorValue(sql);
    const tab = activeWorkspaceTab();
    if (tab) tab.sql = sql;
    setStatus(`Opened ${match.entity === "func" ? "function" : "procedure"} ${match.name}`);
    return;
  }
  // Table or view
  await openTable(
    match.schema,
    match.name,
    match.connectionId,
    match.database || match.schema
  );
  setStatus(`Opened ${match.name}`);
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

  const profiles = state.profiles || [];

  for (const p of profiles) {
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

function connNodeEl(profileId) {
  const tree = $("#conn-tree");
  if (!tree || profileId == null) return null;
  return tree.querySelector(`.conn-node[data-profile-id="${CSS.escape(String(profileId))}"]`);
}

/** Sync active/selected classes on connection rows without rebuilding the tree. */
function paintConnRowActiveState() {
  const tree = $("#conn-tree");
  if (!tree) return;
  tree.querySelectorAll(".conn-node").forEach((node) => {
    const id = node.dataset.profileId;
    const row = node.querySelector(":scope > .conn-row");
    if (!row) return;
    row.classList.toggle("active", id === state.selectedProfileId);
    row.classList.toggle("active-session", id === state.activeConnectionId);
  });
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

    const wrap = connNodeEl(profile.id);
    const kids = wrap?.querySelector(":scope > .conn-children");
    const caret = wrap?.querySelector(":scope > .tree-row .tree-caret");
    // Trust the DOM — search may have opened a shell without isExpanded staying in sync.
    const currentlyOpen = kids ? !kids.hidden : isExpanded(profile.id);

    if (currentlyOpen) {
      // Collapse in-place — do not renderProfiles() (that fights search + wipes nested expand).
      setExpanded(profile.id, false);
      if (explorerSearchQuery()) {
        state.explorerSearch.userCollapsedConnIds[profile.id] = true;
      }
      if (wrap) delete wrap.dataset.searchOpened;
      if (kids) kids.hidden = true;
      if (caret) caret.textContent = "▸";
    } else {
      setExpanded(profile.id, true);
      delete state.explorerSearch.userCollapsedConnIds[profile.id];
      if (wrap) delete wrap.dataset.userCollapsed;
      if (explorerSearchQuery()) {
        state.explorerSearch.revealedConnIds[profile.id] = true;
      }
      if (!kids) {
        renderProfiles();
      } else {
        kids.hidden = false;
        if (caret) caret.textContent = "▾";
        if (!kids.childElementCount) {
          await loadTreeInto(kids, profile.id);
        } else if (explorerSearchQuery()) {
          const entity = explorerSearchEntity();
          const matches = (state.explorerSearch.matches || [])
            .filter((m) => m.connectionId === profile.id);
          if (matches.length && entity !== "db") {
            await expandTreeForSearchMatches(matches, entity);
          }
          syncExplorerSearchFilter();
        }
      }
    }
    paintConnRowActiveState();
    // Don't await — Details must not block expanding the database list.
    focusHomeDetails({ scope: "connection" }).catch((e) => console.error(e));
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

  const startConnectProgress = () => {
    const host = findConnectionTreeNode(profile.id);
    return beginTreeLoading(host, "Connecting…", { determinate: true });
  };

  const fileBased = profile.fileBased || ["SQLITE", "H2_FILE"].includes(profile.dbType);
  if (fileBased) {
    setStatus("Connecting…");
    const progress = startConnectProgress();
    progress.setProgress(30);
    try {
      await api("/api/connect/" + encodeURIComponent(profile.id), {
        method: "POST",
        body: "{}",
      });
      progress.setProgress(100);
      await onConnected();
    } finally {
      progress.end();
    }
    return;
  }

  // Connect with credentials from the add/edit form, or stored password — skip re-prompt.
  if (credentials || profile.hasPassword) {
    setStatus("Connecting…");
    const progress = startConnectProgress();
    progress.setProgress(25);
    progress.setLabel("Connecting…");
    try {
      await api("/api/connect/" + encodeURIComponent(profile.id), {
        method: "POST",
        body: JSON.stringify(credentials || {}),
      });
      progress.setProgress(100);
      await onConnected();
      return;
    } catch (err) {
      if (credentials) throw err;
      // Stored password failed — fall through to prompt.
    } finally {
      progress.end();
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
  // Show the database tree immediately. Connection Details used to block this and
  // scanned every MySQL database for table counts (very slow across regions).
  await loadProfiles();
  focusHomeDetails({ scope: "connection" }).catch((e) => console.error(e));
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
  invalidateExplorerCache();
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
    if (t.kind === "erd") return t.connectionId !== connectionId;
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
  invalidateExplorerCache(id);
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
    invalidateExplorerCache(profile.id);
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

/**
 * Show an inline progress bar under a tree node row (connection / DB / schema / table).
 * Returns { setLabel, setProgress, end }.
 */
function beginTreeLoading(host, label = "Loading…", { determinate = false } = {}) {
  const noop = {
    setLabel() {},
    setProgress() {},
    end() {},
  };
  if (!host) return noop;

  host.classList.add("is-loading");
  const row = host.querySelector(":scope > .tree-row");
  if (row) row.classList.add("loading");

  let bar = host.querySelector(":scope > .tree-progress");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "tree-progress";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-busy", "true");
    bar.innerHTML = `
      <div class="tree-progress-track"><div class="tree-progress-bar"></div></div>
      <span class="tree-progress-label"></span>`;
    if (row) row.insertAdjacentElement("afterend", bar);
    else host.prepend(bar);
  }

  const labelEl = bar.querySelector(".tree-progress-label");
  const barEl = bar.querySelector(".tree-progress-bar");
  bar.hidden = false;
  bar.dataset.mode = determinate ? "determinate" : "indeterminate";
  if (labelEl) labelEl.textContent = label;
  bar.setAttribute("aria-valuetext", label);
  if (determinate && barEl) {
    bar.style.setProperty("--tree-progress", "8%");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", "8");
  } else {
    bar.removeAttribute("aria-valuenow");
  }

  let ended = false;
  return {
    setLabel(text) {
      if (ended || !text) return;
      if (labelEl) labelEl.textContent = text;
      bar.setAttribute("aria-valuetext", text);
    },
    setProgress(pct) {
      if (ended || !determinate) return;
      const n = Math.max(0, Math.min(100, Math.round(pct)));
      bar.style.setProperty("--tree-progress", `${n}%`);
      bar.setAttribute("aria-valuenow", String(n));
    },
    end() {
      if (ended) return;
      ended = true;
      host.classList.remove("is-loading");
      if (row) row.classList.remove("loading");
      bar.remove();
    },
  };
}

function findConnectionTreeNode(profileId) {
  if (!profileId) return null;
  return document.querySelector(`.conn-node[data-profile-id="${CSS.escape(profileId)}"]`);
}

function explorerCacheEntry(connectionId) {
  if (!connectionId) return { explorer: null, objects: {}, details: {} };
  if (!state.explorerCache[connectionId]) {
    state.explorerCache[connectionId] = { explorer: null, objects: {}, details: {} };
  }
  const entry = state.explorerCache[connectionId];
  if (!entry.details) entry.details = {};
  return entry;
}

/** Clear explorer + schema-object + details cache for one connection, or all when omitted. */
function invalidateExplorerCache(connectionId) {
  if (!connectionId) {
    state.explorerCache = {};
    return;
  }
  delete state.explorerCache[connectionId];
}

function invalidateSchemaObjectsCache(connectionId, schema) {
  if (!connectionId || schema == null || schema === "") return;
  const entry = state.explorerCache[connectionId];
  if (!entry) return;
  delete entry.objects[schema];
  invalidateDetailsCache(connectionId, schema);
}

function detailsCacheKey(focus = {}) {
  const scope = focus.scope || "connection";
  const schema = focus.schema
    || (scope === "database" ? focus.database : "")
    || "";
  const table = focus.table || "";
  return `${scope}\0${schema}\0${table}`;
}

function getCachedDetails(connectionId, focus) {
  if (!connectionId) return null;
  const entry = explorerCacheEntry(connectionId);
  return entry.details?.[detailsCacheKey(focus)] || null;
}

function setCachedDetails(connectionId, focus, data) {
  if (!connectionId || !data) return;
  const entry = explorerCacheEntry(connectionId);
  entry.details[detailsCacheKey(focus)] = data;
}

function invalidateDetailsCache(connectionId, schema = null) {
  const entry = state.explorerCache[connectionId];
  if (!entry?.details) return;
  if (!schema) {
    entry.details = {};
    return;
  }
  for (const key of Object.keys(entry.details)) {
    const parts = key.split("\0");
    if (parts[1] === schema) delete entry.details[key];
  }
}

/**
 * Build connection/schema/database details from explorer + object caches when possible
 * so opening a DB does not re-hit /api/details every time.
 */
function buildDetailsFromExplorerCache(connectionId, focus = {}) {
  if (!connectionId) return null;
  const entry = explorerCacheEntry(connectionId);
  const scope = focus.scope || "connection";
  const profile = (state.profiles || []).find((p) => p.id === connectionId);
  const engine = profile?.dbType || "";

  if (scope === "connection") {
    if (!entry.explorer) return null;
    const nodes = entry.explorer.nodes || [];
    const layout = entry.explorer.layout || "";
    const items = [];
    if (layout === "database-schemas") {
      const databases = nodes.filter((n) => (n.kind || "database") === "database");
      items.push({ label: "Databases", value: databases.length });
      let schemas = 0;
      for (const db of databases) {
        schemas += Array.isArray(db.children) ? db.children.length : 0;
      }
      if (!schemas) {
        schemas = nodes.filter((n) => (n.kind || "") === "schema").length;
      }
      items.push({ label: "Schemas", value: schemas });
    } else {
      const databases = nodes.filter((n) => (n.kind || "database") === "database");
      items.push({ label: "Databases", value: databases.length || nodes.length });
    }
    return {
      scope: "connection",
      title: profile?.name || "Connection",
      subtitle: engine ? String(engine) : "Connection",
      engine,
      items,
    };
  }

  if (scope === "schema" || scope === "database") {
    const schema = focus.schema || focus.database;
    if (!schema) return null;
    const bag = entry.objects?.[schema];
    if (!bag) return null;
    const isSchema = scope === "schema";
    return {
      scope,
      title: schema,
      subtitle: isSchema ? "Schema" : "Database",
      engine,
      items: [
        { label: "Tables", value: (bag.tables || []).length },
        { label: "Views", value: (bag.views || []).length },
        { label: "Procedures", value: (bag.procs || []).length },
        { label: "Functions", value: (bag.funcs || []).length },
      ],
    };
  }

  return null;
}

async function fetchExplorer(connectionId, { force = false } = {}) {
  const entry = explorerCacheEntry(connectionId);
  if (!force && entry.explorer) return entry.explorer;
  const explorer = await api(withConnectionId("/api/explorer", connectionId));
  entry.explorer = explorer;
  // Drop stale nested object lists when the database/schema set is refreshed.
  if (force) entry.objects = {};
  return explorer;
}

async function fetchSchemaObjects(connectionId, schema, { force = false, onProgress } = {}) {
  const entry = explorerCacheEntry(connectionId);
  if (!force && entry.objects[schema]) return entry.objects[schema];
  const base = `/api/databases/${encodeURIComponent(schema)}`;
  const stages = [
    ["Loading tables…", "tables"],
    ["Loading views…", "views"],
    ["Loading procedures…", "procs"],
    ["Loading functions…", "funcs"],
  ];
  let done = 0;
  const bump = (label) => {
    done += 1;
    onProgress?.(label, Math.round((done / stages.length) * 100));
  };
  onProgress?.("Loading tables…", 8);
  const [tables, views, procs, funcs] = await Promise.all([
    api(withConnectionId(`${base}/tables`, connectionId)).then((r) => {
      bump("Loading views…");
      return r;
    }),
    api(withConnectionId(`${base}/views`, connectionId)).then((r) => {
      bump("Loading procedures…");
      return r;
    }),
    api(withConnectionId(`${base}/procedures`, connectionId)).then((r) => {
      bump("Loading functions…");
      return r;
    }),
    api(withConnectionId(`${base}/functions`, connectionId)).then((r) => {
      bump("Finishing…");
      return r;
    }),
  ]);
  const data = { tables, views, procs, funcs };
  entry.objects[schema] = data;
  onProgress?.("Done", 100);
  return data;
}

function findExplorerTreeNode(connectionId, schema) {
  if (!connectionId || schema == null) return null;
  const nodes = document.querySelectorAll(
    `.tree-node[data-tree-connection-id="${CSS.escape(connectionId)}"]`
  );
  for (const el of nodes) {
    if (el.dataset.treeSchema === schema) return el;
  }
  return null;
}

/**
 * Invalidate cache then re-render. Pass schema to refresh only that DB/schema's objects.
 * Used after create/drop/rename so the tree does not keep stale lists.
 */
async function loadTree(opts = {}) {
  const cid = opts.connectionId || state.activeConnectionId;
  if (opts.schema && cid) {
    invalidateSchemaObjectsCache(cid, opts.schema);
  } else if (cid) {
    invalidateExplorerCache(cid);
  } else {
    invalidateExplorerCache();
  }
  renderProfiles();
}

async function loadTreeInto(container, connectionId, { force = false } = {}) {
  if (!container) return;
  if (!isExpanded(connectionId) || state.explorerSearch.userCollapsedConnIds[connectionId]) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const hasCache = !force && !!explorerCacheEntry(connectionId).explorer;
  const host = container.closest(".conn-node") || container.parentElement;
  const showProgress = force || !hasCache;
  const progress = showProgress
    ? beginTreeLoading(host, force ? "Refreshing databases…" : "Loading databases…", { determinate: true })
    : null;
  if (showProgress) {
    container.innerHTML = "";
    progress?.setProgress(12);
  }
  try {
    // Use connectionId on the request — do not steal active session from siblings.
    progress?.setLabel(force ? "Refreshing databases…" : "Fetching databases…");
    progress?.setProgress(35);
    const explorer = await fetchExplorer(connectionId, { force });
    // User may have collapsed this connection while the request was in flight.
    if (!isExpanded(connectionId) || state.explorerSearch.userCollapsedConnIds[connectionId]) {
      container.hidden = true;
      return;
    }
    progress?.setProgress(85);
    progress?.setLabel("Building tree…");
    container.innerHTML = "";
    const nodes = explorer.nodes || [];
    if (!nodes.length) {
      container.innerHTML = `<div class="profile-empty">No databases/schemas found.</div>`;
      return;
    }
    for (const node of nodes) {
      container.appendChild(renderExplorerNode(node, explorer.layout, connectionId));
    }
    progress?.setProgress(100);
    if (!isExpanded(connectionId) || state.explorerSearch.userCollapsedConnIds[connectionId]) {
      container.hidden = true;
      return;
    }
    if (explorerSearchQuery()) {
      const entity = explorerSearchEntity();
      const matches = collectExplorerSearchMatches(explorerSearchQuery(), entity)
        .filter((m) => m.connectionId === connectionId);
      state.explorerSearch.revealedConnIds[connectionId] = true;
      if (matches.length && entity !== "db"
        && !state.explorerSearch.userCollapsedConnIds[connectionId]) {
        await expandTreeForSearchMatches(matches, entity);
      }
      syncExplorerSearchFilter();
      // Pick up any other match connections indexing may have found.
      revealExplorerSearchPaths().catch(() => {});
    }
  } catch (e) {
    container.innerHTML = `<div class="error-text">${escapeHtml(e.message)}</div>`;
  } finally {
    progress?.end();
    if (!isExpanded(connectionId) || state.explorerSearch.userCollapsedConnIds[connectionId]) {
      container.hidden = true;
      const caret = host?.querySelector(":scope > .tree-row .tree-caret");
      if (caret) caret.textContent = "▸";
    }
  }
}

function renderExplorerNode(node, layout, connectionId, parentDatabase = null) {
  const kind = node.kind || "database";
  // MySQL: database node name is the DB; PostgreSQL: parent DB for schema children.
  const databaseName = kind === "database"
    ? (node.name || null)
    : (parentDatabase || null);
  const schemaKey = node.schema || node.name || "";
  const wrap = document.createElement("div");
  wrap.className = "tree-node";
  wrap.dataset.treeKind = kind;
  wrap.dataset.treeSchema = schemaKey;
  if (connectionId) wrap.dataset.treeConnectionId = connectionId;

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

  async function fillChildren({ force = false } = {}) {
    const schema = node.schema || node.name;
    const needsNetwork = force
      || (childSchemas && layout === "database-schemas" && force)
      || (!childSchemas && !(explorerCacheEntry(connectionId).objects[schema]));
    const loadingLabel = force
      ? (childSchemas
        ? "Refreshing schemas…"
        : (kind === "schema" ? "Refreshing schema objects…" : "Refreshing database objects…"))
      : (childSchemas
        ? "Loading schemas…"
        : (kind === "schema" ? "Loading schema objects…" : "Loading database objects…"));
    const progress = needsNetwork
      ? beginTreeLoading(wrap, loadingLabel, { determinate: true })
      : null;
    if (needsNetwork) kids.innerHTML = "";
    try {
      if (childSchemas && layout === "database-schemas" && force) {
        // Re-fetch explorer so schema children under this database stay current.
        progress?.setProgress(20);
        progress?.setLabel("Refreshing schemas…");
        const explorer = await fetchExplorer(connectionId, { force: true });
        progress?.setProgress(80);
        const fresh = (explorer.nodes || []).find((n) => (n.name || "") === (node.name || ""));
        const schemas = Array.isArray(fresh?.children) ? fresh.children : childSchemas;
        kids.innerHTML = "";
        for (const schemaNode of schemas) {
          kids.appendChild(renderExplorerNode(schemaNode, "schema-objects", connectionId, node.name));
        }
        progress?.setProgress(100);
        loaded = true;
        if (explorerSearchQuery()) syncExplorerSearchFilter();
        return;
      }
      if (childSchemas) {
        kids.innerHTML = "";
        for (const schemaNode of childSchemas) {
          kids.appendChild(renderExplorerNode(schemaNode, "schema-objects", connectionId, node.name));
        }
        loaded = true;
        if (explorerSearchQuery()) syncExplorerSearchFilter();
        return;
      }
      const dbForObjects = databaseName || profileDatabaseName(connectionId);
      progress?.setProgress(15);
      progress?.setLabel("Loading tables…");
      const objects = await fetchSchemaObjects(connectionId, schema, {
        force,
        onProgress: (stage, pct) => {
          progress?.setLabel(stage);
          progress?.setProgress(pct);
        },
      });
      kids.innerHTML = "";
      kids.appendChild(folder("Tables", "tbl", schema, objects.tables, "table", connectionId, dbForObjects));
      kids.appendChild(folder("Views", "vw", schema, objects.views, "view", connectionId, dbForObjects));
      kids.appendChild(folder("Procedures", "db", schema, objects.procs, "proc", connectionId, dbForObjects));
      kids.appendChild(folder("Functions", "db", schema, objects.funcs, "func", connectionId, dbForObjects));
      progress?.setProgress(100);
      loaded = true;
      // Keep details panel in sync with object counts without another /api/details round-trip.
      const detailScope = kind === "schema" ? "schema" : "database";
      const built = buildDetailsFromExplorerCache(connectionId, {
        scope: detailScope,
        schema,
        database: dbForObjects || schema,
      });
      if (built) {
        setCachedDetails(connectionId, {
          scope: detailScope,
          schema,
          database: dbForObjects || schema,
        }, built);
        const focus = state.detailFocus || {};
        const focusSchema = focus.schema || focus.database;
        if (
          state.currentTab === "details"
          && (focus.connectionId || state.activeConnectionId) === connectionId
          && focusSchema === schema
          && (focus.scope === "schema" || focus.scope === "database")
        ) {
          refreshDetails().catch(() => {});
        }
      }
      if (explorerSearchQuery()) syncExplorerSearchFilter();
    } catch (err) {
      kids.innerHTML = `<div class="error-text">${escapeHtml(err.message)}</div>`;
      loaded = false;
    } finally {
      progress?.end();
    }
  }

  wrap.reloadTreeChildren = async () => {
    kids.hidden = false;
    loaded = false;
    await fillChildren({ force: true });
  };

  wrap.expandForSearch = async () => {
    markSearchOpened(wrap, kids);
    if (!loaded) await fillChildren({ force: false });
  };

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
    // Manual toggle owns expand state for this search session.
    delete wrap.dataset.searchOpened;
    if (kids.hidden) wrap.dataset.userCollapsed = "1";
    else delete wrap.dataset.userCollapsed;
    if (kids.hidden || loaded) return;
    // Use cache when available — only the first expand (or Refresh) hits the API.
    const schema = node.schema || node.name;
    const cachedObjects = !childSchemas && schema
      ? explorerCacheEntry(connectionId).objects[schema]
      : null;
    if (!childSchemas && !cachedObjects) {
      // show loading inside fillChildren
    }
    await fillChildren({ force: false });
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
  } else if (profile.dbType === "MYSQL" || profile.dbType === "MARIADB" || profile.dbType === "SQLITE") {
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
      case "conn-refresh": {
        hideAllContextMenus();
        const profile = target.profile;
        if (!profile || !isLiveProfile(profile)) break;
        invalidateExplorerCache(profile.id);
        state.activeConnectionId = profile.id;
        setExpanded(profile.id, true);
        delete state.explorerSearch.userCollapsedConnIds[profile.id];
        await api("/api/session/active", {
          method: "POST",
          body: JSON.stringify({ id: profile.id }),
        }).catch(() => {});

        let wrap = findConnectionTreeNode(profile.id);
        let kids = wrap?.querySelector(":scope > .conn-children");
        if (!wrap || !kids) {
          renderProfiles();
          wrap = findConnectionTreeNode(profile.id);
          kids = wrap?.querySelector(":scope > .conn-children");
        }
        if (wrap && kids) {
          kids.hidden = false;
          const caret = wrap.querySelector(":scope > .tree-row .tree-caret");
          if (caret) caret.textContent = "▾";
          await loadTreeInto(kids, profile.id, { force: true });
        } else {
          renderProfiles();
        }
        setStatus(`Refreshed databases for “${profile.name || "Untitled"}”`);
        break;
      }
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
      case "refresh-tree": {
        hideAllContextMenus();
        const cid = state.activeConnectionId;
        if (!cid || !schema) break;
        const nodeEl = findExplorerTreeNode(cid, schema);
        if (nodeEl?.reloadTreeChildren) {
          if (target.kind === "database") {
            invalidateExplorerCache(cid);
          } else {
            invalidateSchemaObjectsCache(cid, schema);
          }
          await nodeEl.reloadTreeChildren();
        } else if (target.kind === "database") {
          invalidateExplorerCache(cid);
          setExpanded(cid, true);
          let wrap = findConnectionTreeNode(cid);
          let kids = wrap?.querySelector(":scope > .conn-children");
          if (!wrap || !kids) {
            renderProfiles();
            wrap = findConnectionTreeNode(cid);
            kids = wrap?.querySelector(":scope > .conn-children");
          }
          if (kids) {
            kids.hidden = false;
            await loadTreeInto(kids, cid, { force: true });
          }
        } else {
          invalidateSchemaObjectsCache(cid, schema);
          await loadTree({ connectionId: cid, schema });
        }
        setStatus(`Refreshed “${schema}”`);
        break;
      }
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
      case "open-erd": {
        hideAllContextMenus();
        const schema = target.schema;
        if (!schema) {
          alert("Select a database/schema first");
          return;
        }
        const three = isThreeLayerProfile(activeProfile());
        const dbName = target.database
          || (target.kind === "database" ? target.schema : null)
          || (!three ? target.schema : null)
          || profileDatabaseName(state.activeConnectionId)
          || "";
        await openErd(schema, state.activeConnectionId, dbName);
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
      case "rename-column": {
        hideAllContextMenus();
        let column = "";
        const openTab = state.workspaceTabs.find((t) =>
          t.kind === "table"
          && t.schema === target.schema
          && t.table === target.table
          && Array.isArray(t.columns)
          && t.columns.length);
        if (openTab?.columns?.length === 1) {
          column = openTab.columns[0].name;
        } else if (openTab?.columns?.length) {
          const names = openTab.columns.map((c) => c.name).join(", ");
          column = String(prompt(`Column to rename (${names}):`, openTab.columns[0].name) || "").trim();
        } else {
          column = String(prompt("Column to rename:", "") || "").trim();
        }
        if (!column) return;
        await renameColumnInteractive(
          target.schema,
          target.table,
          column,
          state.activeConnectionId,
        );
        break;
      }
      case "rename-table": {
        hideAllContextMenus();
        const newName = String(prompt("New table name:", target.table) || "").trim();
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
  wrap.dataset.folderKind = kind;
  if (connectionId) wrap.dataset.treeConnectionId = connectionId;
  wrap.dataset.treeSchema = schema;
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
  wrap.expandForSearch = async () => {
    markSearchOpened(wrap, kids);
  };
  row.onclick = (e) => {
    if (e.target.closest(".tree-more")) return;
    e.stopPropagation();
    kids.hidden = !kids.hidden;
    delete wrap.dataset.searchOpened;
    if (kids.hidden) wrap.dataset.userCollapsed = "1";
    else delete wrap.dataset.userCollapsed;
  };
  for (const name of items) {
    const leaf = document.createElement("div");
    leaf.className = "tree-node tree-leaf";
    leaf.dataset.treeKind = kind;
    leaf.dataset.treeSchema = schema;
    leaf.dataset.treeTable = name;
    if (connectionId) leaf.dataset.treeConnectionId = connectionId;

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
        const progress = beginTreeLoading(leaf, `Loading ${name}…`, { determinate: true });
        progress.setProgress(20);
        try {
          progress.setLabel(`Loading ${name}…`);
          await openTable(schema, name, connectionId, database);
          progress.setProgress(100);
        } finally {
          progress.end();
        }
      }
    };
    leaf.appendChild(item);
    kids.appendChild(leaf);
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
  const mysqlLike = !!(profile && (profile.dbType === "MYSQL" || profile.dbType === "MARIADB" || (!threeLayer && !profile.fileBased)));

  let schema = "";
  if (tab.kind === "table" || tab.kind === "erd") {
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

  if (tab.kind === "erd") {
    const db = tab.database || database;
    const sch = tab.schema || schema;
    if (threeLayer) {
      return [connName, db, sch, "ERD"].filter(Boolean).join(" · ");
    }
    return [connName, db || sch, "ERD"].filter(Boolean).join(" · ");
  }

  if (threeLayer) {
    const parts = [connName];
    if (database) parts.push(database);
    if (schema && schema !== database) parts.push(schema);
    return parts.join(" · ");
  }

  // MySQL / 2-layer: connection · database
  if (mysqlLike || profile?.dbType === "MYSQL" || profile?.dbType === "MARIADB" || tab.kind === "table" || tab.kind === "context") {
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
  if (tab.kind === "erd") return "ERD";
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
  if (tab.kind === "erd") return tab.title || tab.schema || "ERD";
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
  if (tab.kind === "erd") {
    tab.viewMode = "erd";
    tab.connectionId = state.activeConnectionId || tab.connectionId;
    tab.database = state.detailFocus?.database || tab.database || profileDatabaseName(state.activeConnectionId);
    tab.detailFocus = { ...(state.detailFocus || {}) };
    return;
  }
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

  if (tab.kind === "erd") {
    if (tab.connectionId) state.activeConnectionId = tab.connectionId;
    state.currentSchema = tab.schema || null;
    state.currentTable = null;
    state.columns = [];
    state.result = null;
    setDetailFocus({
      scope: isThreeLayerProfile(profileById(tab.connectionId)) ? "schema" : "database",
      schema: tab.schema || null,
      table: null,
      database: tab.database || profileDatabaseName(tab.connectionId),
      connectionId: tab.connectionId,
    });
    updateRunButton();
    updateContextMeta(tab.title || tab.schema || "ERD");
    tab.viewMode = "erd";
    switchTab("erd", { skipTitle: true });
    if (!forceReload && tab.erd) {
      renderErdDiagram(tab.erd, tab);
      return;
    }
    await loadErdIntoActiveTab(tab);
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

function erdTabId(schema, connectionId) {
  return `erd:${connectionId || state.activeConnectionId || ""}:${schema || ""}`;
}

async function openErd(schema, connectionId, database = null) {
  if (!schema) {
    alert("Select a database/schema first");
    return;
  }
  if (connectionId) state.activeConnectionId = connectionId;
  const cid = connectionId || state.activeConnectionId;
  const id = erdTabId(schema, cid);
  const profile = profileById(cid);
  const three = isThreeLayerProfile(profile);
  const dbName = database
    || (!three ? schema : null)
    || state.detailFocus?.database
    || profileDatabaseName(cid)
    || "";
  snapshotActiveWorkspaceTab();
  removeContextTabs();

  let tab = state.workspaceTabs.find((t) => t.id === id);
  if (!tab) {
    tab = {
      id,
      kind: "erd",
      title: schema,
      schema,
      table: null,
      database: dbName,
      connectionId: cid,
      closable: true,
      pinned: false,
      viewMode: "erd",
      erd: null,
      erdView: { x: 0, y: 0, scale: 1 },
    };
    state.workspaceTabs.push(tab);
  } else {
    tab.connectionId = cid;
    tab.schema = schema;
    tab.database = dbName || tab.database;
    tab.title = schema;
    tab.viewMode = "erd";
    if (!tab.erdView) tab.erdView = { x: 0, y: 0, scale: 1 };
  }

  state.activeWorkspaceTabId = id;
  state.currentSchema = schema;
  state.currentTable = null;
  setDetailFocus({
    scope: three ? "schema" : "database",
    schema,
    table: null,
    database: dbName,
    connectionId: cid,
  });
  updateRunButton();
  renderWorkspaceTabs();
  await applyWorkspaceTab(id, { forceReload: !tab.erd });
}

async function loadErdIntoActiveTab(tab) {
  if (!tab || tab.kind !== "erd" || !tab.schema) return;
  const empty = $("#erd-empty");
  const title = $("#erd-title");
  const subtitle = $("#erd-subtitle");
  if (title) title.textContent = tab.schema;
  if (subtitle) {
    const n = tab.erd?.tables?.length;
    subtitle.textContent = n != null
      ? `${n} table${n === 1 ? "" : "s"} · foreign keys`
      : "Loading tables and foreign keys…";
  }
  if (empty) {
    empty.hidden = false;
    empty.textContent = "Loading ER diagram…";
  }
  setErdCanvasEmpty();
  try {
    if (tab.connectionId) {
      await api("/api/session/active", {
        method: "POST",
        body: JSON.stringify({ id: tab.connectionId }),
      }).catch(() => {});
    }
    const path = withConnectionId(
      `/api/databases/${encodeURIComponent(tab.schema)}/erd`,
      tab.connectionId,
    );
    const data = await api(path, { connectionId: tab.connectionId });
    const live = state.workspaceTabs.find((t) => t.id === tab.id);
    if (!live || live.id !== state.activeWorkspaceTabId) return;
    live.erd = data;
    live.erdLogicalRelations = null;
    live.erdView = { ...(live.erdView || { x: 0, y: 0, scale: 1 }), _needsFit: true };
    const tableCount = (data.tables || []).length;
    const fkCount = (data.relations || []).length;
    const logical = inferLogicalErdRelations(data.tables || [], data.relations || []);
    live.erdLogicalRelations = logical;
    // When no FK edges exist, default to showing inferred logical relationships.
    if (live.erdShowLogical == null) {
      live.erdShowLogical = fkCount === 0 && logical.length > 0;
    }
    const shown = getErdDisplayRelations(live).length;
    if (subtitle) {
      subtitle.textContent = erdRelationSubtitle(tableCount, fkCount, logical.length, live.erdShowLogical);
    }
    setStatus(`ERD · ${tab.schema}${shown ? ` · ${shown} link${shown === 1 ? "" : "s"}` : ""}`);
    syncErdLogicalToggle(live);
    renderErdDiagram(data, live);
  } catch (err) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = err.message || "Failed to load ER diagram";
    }
    setErdCanvasEmpty();
    setStatus(err.message || "ERD failed");
  }
}

function setErdCanvasEmpty() {
  const svg = $("#erd-canvas");
  if (svg) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }
}

function updateErdZoomLabel(scale) {
  const label = $("#erd-zoom-label");
  if (label) label.textContent = `${Math.round((scale || 1) * 100)}%`;
}

function applyErdTransform(tab) {
  const svg = $("#erd-canvas");
  if (!svg || !tab) return;
  const view = tab.erdView || { x: 0, y: 0, scale: 1 };
  tab.erdView = view;
  const root = svg.querySelector(".erd-root");
  if (root) {
    root.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  }
  updateErdZoomLabel(view.scale);
}

function fitErdToViewport(tab) {
  if (!tab?.erdLayout) return;
  const viewport = $("#erd-viewport");
  if (!viewport) return;
  const pad = 32;
  const vw = Math.max(1, viewport.clientWidth - pad * 2);
  const vh = Math.max(1, viewport.clientHeight - pad * 2);
  const { width, height } = tab.erdLayout;
  if (!width || !height) return;
  const scale = Math.min(1.4, Math.max(0.15, Math.min(vw / Math.max(width, 1), vh / Math.max(height, 1))));
  tab.erdView = {
    scale,
    x: pad + (vw - width * scale) / 2,
    y: pad + (vh - height * scale) / 2,
  };
  applyErdTransform(tab);
}

function erdZoomBy(factor) {
  const tab = activeWorkspaceTab();
  if (!tab || tab.kind !== "erd") return;
  const viewport = $("#erd-viewport");
  if (!viewport) return;
  const view = tab.erdView || { x: 0, y: 0, scale: 1 };
  const rect = viewport.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const next = Math.min(2.5, Math.max(0.15, view.scale * factor));
  const wx = (cx - view.x) / view.scale;
  const wy = (cy - view.y) / view.scale;
  tab.erdView = {
    scale: next,
    x: cx - wx * next,
    y: cy - wy * next,
  };
  applyErdTransform(tab);
}

/** Tables connected to `tableName` via FK (either direction), including itself. */
function erdFocusNeighborhood(data, tableName, tab = null) {
  const related = new Set([tableName]);
  const relations = tab ? getErdAllRelations(tab) : (data?.relations || []);
  for (const rel of relations) {
    if (rel.fromTable === tableName && rel.toTable) related.add(rel.toTable);
    if (rel.toTable === tableName && rel.fromTable) related.add(rel.fromTable);
  }
  return related;
}

function erdRelationSubtitle(tableCount, fkCount, logicalCount, showLogical) {
  const parts = [`${tableCount} table${tableCount === 1 ? "" : "s"}`];
  parts.push(`${fkCount} FK`);
  if (showLogical) {
    parts.push(`${logicalCount} logical`);
  } else if (fkCount === 0 && logicalCount > 0) {
    parts.push(`${logicalCount} logical available`);
  }
  return parts.join(" · ");
}

function erdPluralVariants(stem) {
  const s = String(stem || "").toLowerCase();
  if (!s) return [];
  const out = new Set([s]);
  if (s.endsWith("ies") && s.length > 3) out.add(`${s.slice(0, -3)}y`);
  if (s.endsWith("ses") || s.endsWith("xes") || s.endsWith("zes")
    || s.endsWith("ches") || s.endsWith("shes")) {
    out.add(s.slice(0, -2));
  }
  if (s.endsWith("s") && !s.endsWith("ss") && s.length > 1) out.add(s.slice(0, -1));
  if (s.endsWith("y") && s.length > 1 && !/[aeiou]y$/i.test(s)) {
    out.add(`${s.slice(0, -1)}ies`);
  } else if (s.endsWith("s") || s.endsWith("x") || s.endsWith("z")
    || s.endsWith("ch") || s.endsWith("sh")) {
    out.add(`${s}es`);
  } else {
    out.add(`${s}s`);
  }
  return [...out];
}

function erdSplitCamel(name) {
  const s = String(name || "");
  if (!s || !/[a-z][A-Z]/.test(s)) return null;
  const parts = s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split("_");
  return parts.length >= 2 ? parts : null;
}

/**
 * Infer logical relationships from naming, without needing PK/FK metadata.
 * Examples:
 *   user_id → users.id
 *   a_code → a.code
 *   order_user_code → order_user.code (longest table prefix wins)
 */
function inferLogicalErdRelations(tables, fkRelations = []) {
  const list = tables || [];
  const byLower = new Map();
  /** @type {Map<string, { name: string, cols: Map<string, string>, pk: string[] }>} */
  const meta = new Map();

  for (const t of list) {
    const name = String(t.name || "");
    if (!name) continue;
    byLower.set(name.toLowerCase(), name);
    const cols = new Map();
    const pk = [];
    for (const c of t.columns || []) {
      const cn = String(c.name || "");
      if (!cn) continue;
      cols.set(cn.toLowerCase(), cn);
      if (c.primaryKey) pk.push(cn);
    }
    meta.set(name, { name, cols, pk });
  }

  const fkSeen = new Set();
  for (const rel of fkRelations || []) {
    const fromCols = (rel.fromColumns || []).join(",");
    const toCols = (rel.toColumns || []).join(",");
    fkSeen.add(`${rel.fromTable}\0${rel.toTable}\0${fromCols}\0${toCols}`);
    fkSeen.add(`${rel.fromTable}\0${rel.toTable}\0${(rel.fromColumns || [])[0] || ""}`);
  }

  const resolveTarget = (stem) => {
    for (const variant of erdPluralVariants(stem)) {
      const hit = byLower.get(variant);
      if (hit) return hit;
    }
    return null;
  };

  /** Prefer exact column, then id / PK fallbacks when suffix is id-like. */
  const resolveTargetColumn = (targetName, suffix) => {
    const info = meta.get(targetName);
    if (!info) return null;
    const want = String(suffix || "").toLowerCase();
    if (!want) return null;
    if (info.cols.has(want)) return info.cols.get(want);

    // id-like suffixes may map to a bare `id` column (even without PK flag).
    if (want === "id" || want === "fk" || want === "uuid" || want === "guid") {
      if (info.cols.has("id")) return info.cols.get("id");
      if (info.cols.has("uuid")) return info.cols.get("uuid");
      if (info.pk.length === 1) return info.pk[0];
      if (info.pk.length) return info.pk[0];
    }

    // user_id → users.user_id when present
    const stem = targetName.toLowerCase();
    for (const candidate of [`${stem}_${want}`, `${stem}${want}`]) {
      if (info.cols.has(candidate)) return info.cols.get(candidate);
    }
    return null;
  };

  const out = [];
  const seen = new Set();

  const addRel = (fromTable, fromCol, toTable, toCol) => {
    if (!fromTable || !fromCol || !toTable || !toCol || fromTable === toTable) return;
    const fkKey = `${fromTable}\0${toTable}\0${fromCol}`;
    if (fkSeen.has(fkKey) || fkSeen.has(`${fromTable}\0${toTable}\0${fromCol}\0${toCol}`)) return;
    const key = `${fromTable}\0${toTable}\0${fromCol}\0${toCol}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: `${fromCol} → ${toTable}.${toCol}`,
      fromTable,
      toTable,
      fromColumns: [fromCol],
      toColumns: [toCol],
      logical: true,
    });
  };

  const tryPrefixedParts = (fromTable, colName, parts) => {
    if (!parts || parts.length < 2) return false;
    // Longest table-name prefix first: a_code → (a, code); order_item_code → (order_item, code)
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = parts.slice(0, i).join("_");
      const suffix = parts.slice(i).join("_");
      if (!prefix || !suffix) continue;
      // Avoid ultra-generic single-letter noise unless it really matches a table.
      const toTable = resolveTarget(prefix);
      if (!toTable || toTable === fromTable) continue;
      const toCol = resolveTargetColumn(toTable, suffix);
      if (!toCol) continue;
      addRel(fromTable, colName, toTable, toCol);
      return true;
    }
    return false;
  };

  for (const t of list) {
    const fromTable = String(t.name || "");
    for (const col of t.columns || []) {
      const colName = String(col.name || "");
      if (!colName) continue;

      // snake_case prefixes: a_code, user_id, order_item_code
      if (colName.includes("_")) {
        if (tryPrefixedParts(fromTable, colName, colName.toLowerCase().split("_"))) continue;
      }

      // camelCase: userId, aCode, orderUserId
      const camelParts = erdSplitCamel(colName);
      if (camelParts) {
        if (tryPrefixedParts(fromTable, colName, camelParts)) continue;
      }

      // Trailing Id/Fk without underscore: userid (weak) — only if stem resolves to a table
      const m = colName.match(/^(.*?)(id|fk|uuid|guid)$/i);
      if (m && m[1] && m[1].length >= 1) {
        let stem = m[1].replace(/_+$/, "");
        if (/[A-Z]$/.test(stem)) {
          // FooId already handled via camel; keep stem as-is lowercased path
        }
        stem = stem.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
        const toTable = resolveTarget(stem.replace(/_+/g, "_").replace(/^_|_$/g, ""));
        if (toTable && toTable !== fromTable) {
          const toCol = resolveTargetColumn(toTable, m[2]);
          if (toCol) addRel(fromTable, colName, toTable, toCol);
        }
      }
    }
  }

  out.sort((a, b) => {
    const t = String(a.fromTable).localeCompare(String(b.fromTable), undefined, { sensitivity: "base" });
    if (t) return t;
    return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
  });
  return out;
}

function getErdDisplayRelations(tab) {
  const all = getErdAllRelations(tab);
  // Focus mode: drop connections that do not touch the focused table.
  const focus = tab?.erdFocusTable;
  if (!focus) return all;
  return all.filter((r) => r.fromTable === focus || r.toTable === focus);
}

/** All FK/logical relations ignoring focus filter (for counts / neighborhood). */
function getErdAllRelations(tab) {
  const fk = (tab?.erd?.relations || []).map((r) => ({ ...r, logical: !!r.logical }));
  if (!tab?.erdShowLogical) return fk;
  if (!Array.isArray(tab.erdLogicalRelations)) {
    tab.erdLogicalRelations = inferLogicalErdRelations(tab.erd?.tables || [], tab.erd?.relations || []);
  }
  return [...fk, ...tab.erdLogicalRelations];
}

function syncErdLogicalToggle(tab) {
  const chk = $("#chk-erd-logical");
  const wrap = $("#erd-logical-toggle");
  if (!chk) return;
  const fkCount = (tab?.erd?.relations || []).length;
  if (tab?.kind === "erd") {
    tab.erdLogicalRelations = inferLogicalErdRelations(tab.erd?.tables || [], tab.erd?.relations || []);
    const logicalCount = tab.erdLogicalRelations.length;
    chk.checked = !!tab.erdShowLogical;
    chk.disabled = logicalCount === 0;
    if (wrap) {
      wrap.classList.toggle("has-logical", logicalCount > 0);
      wrap.classList.toggle("no-fk", fkCount === 0 && logicalCount > 0);
      wrap.title = logicalCount === 0
        ? "No logical relationships inferred (e.g. a_code → a.code, user_id → users.id)"
        : "Show relationships inferred from column names (e.g. a_code → a.code, user_id → users.id)";
    }
  } else {
    chk.checked = false;
    chk.disabled = true;
    if (wrap) {
      wrap.classList.remove("has-logical", "no-fk");
      wrap.title = "Show relationships inferred from column names";
    }
  }
}

function setErdShowLogical(enabled) {
  const tab = activeWorkspaceTab();
  if (!tab || tab.kind !== "erd") return;
  tab.erdShowLogical = !!enabled;
  const data = tab.erd;
  if (!data) return;
  const keepView = tab.erdView ? { ...tab.erdView, _needsFit: false } : null;
  if (keepView) tab.erdView = keepView;
  renderErdDiagram(data, tab);
  const fkCount = (data.relations || []).length;
  const logicalCount = (tab.erdLogicalRelations || []).length;
  const subtitle = $("#erd-subtitle");
  if (subtitle && !tab.erdFocusTable) {
    subtitle.textContent = erdRelationSubtitle(
      (data.tables || []).length,
      fkCount,
      logicalCount,
      tab.erdShowLogical,
    );
  }
  setStatus(tab.erdShowLogical
    ? `ERD · logical relationships on (${logicalCount})`
    : "ERD · logical relationships off");
}

function updateErdFocusButton(tab) {
  const btn = $("#btn-erd-clear-focus");
  if (!btn) return;
  const active = !!(tab && tab.kind === "erd" && tab.erdFocusTable);
  btn.disabled = !active;
  btn.classList.toggle("active", active);
  btn.title = active
    ? `Clear focus on ${tab.erdFocusTable}`
    : "Click a table to enter focus mode";
}

function setErdFocus(tab, tableName) {
  if (!tab || tab.kind !== "erd") return;
  if (!tableName || tab.erdFocusTable === tableName) {
    tab.erdFocusTable = null;
  } else {
    tab.erdFocusTable = tableName;
  }
  redrawErdEdges(tab);
  applyErdFocusStyles(tab);
  updateErdFocusButton(tab);
  applyErdSearchStyles(tab);
  const subtitle = $("#erd-subtitle");
  const tables = tab.erd?.tables || [];
  if (subtitle) {
    if (tab.erdFocusTable) {
      const n = erdFocusNeighborhood(tab.erd, tab.erdFocusTable, tab).size;
      subtitle.textContent = `Focus · ${tab.erdFocusTable} · ${n} related table${n === 1 ? "" : "s"}`;
    } else {
      const fkCount = (tab.erd?.relations || []).length;
      const logicalCount = (tab.erdLogicalRelations || []).length;
      subtitle.textContent = erdRelationSubtitle(tables.length, fkCount, logicalCount, !!tab.erdShowLogical);
    }
  }
  if (tab.erdFocusTable) {
    setStatus(`ERD focus · ${tab.erdFocusTable}`);
  }
}

function clearErdFocus(tab = activeWorkspaceTab()) {
  if (!tab || tab.kind !== "erd") return;
  if (!tab.erdFocusTable) {
    updateErdFocusButton(tab);
    return;
  }
  tab.erdFocusTable = null;
  redrawErdEdges(tab);
  applyErdFocusStyles(tab);
  applyErdSearchStyles(tab);
  updateErdFocusButton(tab);
  const subtitle = $("#erd-subtitle");
  const tables = tab.erd?.tables || [];
  const fkCount = (tab.erd?.relations || []).length;
  const logicalCount = (tab.erdLogicalRelations || []).length;
  if (subtitle) {
    subtitle.textContent = erdRelationSubtitle(tables.length, fkCount, logicalCount, !!tab.erdShowLogical);
  }
}

function applyErdFocusStyles(tab) {
  const svg = $("#erd-canvas");
  const root = svg?.querySelector(".erd-root");
  if (!root) return;
  const focus = tab?.erdFocusTable || null;
  root.classList.toggle("erd-focus-mode", !!focus);
  const related = focus ? erdFocusNeighborhood(tab.erd, focus, tab) : null;

  root.querySelectorAll(".erd-table").forEach((g) => {
    const name = g.dataset.table;
    g.classList.remove("erd-focused", "erd-related", "erd-dimmed");
    if (!focus) return;
    if (name === focus) g.classList.add("erd-focused");
    else if (related?.has(name)) g.classList.add("erd-related");
    else g.classList.add("erd-dimmed");
  });

  // Only focused-table connections are drawn; highlight those edges.
  root.querySelectorAll(".erd-edge, .erd-edge-label, .erd-port").forEach((el) => {
    el.classList.remove("erd-edge-active", "erd-dimmed");
    if (!focus) {
      if (el.classList.contains("erd-edge")) {
        el.setAttribute("marker-end", "url(#erd-arrow)");
      }
      return;
    }
    el.classList.add("erd-edge-active");
    if (el.classList.contains("erd-edge")) {
      el.setAttribute("marker-end", "url(#erd-arrow-active)");
    }
  });
}

function syncErdSearchUi(tab) {
  const input = $("#erd-search-input");
  const scope = $("#erd-search-scope");
  if (!input || !scope) return;
  if (tab?.kind === "erd") {
    if (document.activeElement !== input) {
      input.value = tab.erdSearchQuery || "";
    }
    if (document.activeElement !== scope) {
      scope.value = tab.erdSearchScope === "column" ? "column" : "table";
    }
  } else {
    input.value = "";
    scope.value = "table";
  }
  updateErdSearchNav(tab);
}

function updateErdSearchNav(tab) {
  const countEl = $("#erd-search-count");
  const prev = $("#btn-erd-search-prev");
  const next = $("#btn-erd-search-next");
  const matches = tab?.kind === "erd" ? (tab.erdSearchMatches || []) : [];
  const q = (tab?.erdSearchQuery || "").trim();
  const has = matches.length > 0;
  if (countEl) {
    if (!q) {
      countEl.hidden = true;
      countEl.textContent = "";
    } else {
      countEl.hidden = false;
      countEl.textContent = has
        ? `${(tab.erdSearchIndex || 0) + 1}/${matches.length}`
        : "0";
    }
  }
  if (prev) prev.disabled = !has;
  if (next) next.disabled = !has;
}

function collectErdSearchMatches(tab) {
  const q = (tab?.erdSearchQuery || "").trim().toLowerCase();
  const scope = tab?.erdSearchScope === "column" ? "column" : "table";
  if (!q || !tab?.erd?.tables) return [];
  const matches = [];
  for (const t of tab.erd.tables) {
    const tableName = String(t.name || "");
    if (scope === "table") {
      if (tableName.toLowerCase().includes(q)) {
        matches.push({ table: tableName, column: null });
      }
      continue;
    }
    for (const c of t.columns || []) {
      const colName = String(c.name || "");
      if (colName.toLowerCase().includes(q)) {
        matches.push({ table: tableName, column: colName });
      }
    }
  }
  matches.sort((a, b) => {
    const t = a.table.localeCompare(b.table, undefined, { sensitivity: "base" });
    if (t) return t;
    return String(a.column || "").localeCompare(String(b.column || ""), undefined, { sensitivity: "base" });
  });
  return matches;
}

function applyErdSearchStyles(tab) {
  const svg = $("#erd-canvas");
  const root = svg?.querySelector(".erd-root");
  if (!root) return;
  const q = (tab?.erdSearchQuery || "").trim().toLowerCase();
  const scope = tab?.erdSearchScope === "column" ? "column" : "table";
  const matches = tab?.erdSearchMatches || [];
  const hitTables = new Set(matches.map((m) => m.table));
  const active = matches[tab?.erdSearchIndex || 0] || null;
  const searching = !!q;

  root.classList.toggle("erd-search-mode", searching);

  root.querySelectorAll(".erd-table").forEach((g) => {
    const name = g.dataset.table;
    g.classList.remove("erd-search-hit", "erd-search-miss", "erd-search-current");
    if (!searching) return;
    if (hitTables.has(name)) {
      g.classList.add("erd-search-hit");
      if (active && active.table === name) g.classList.add("erd-search-current");
    } else {
      g.classList.add("erd-search-miss");
    }
  });

  root.querySelectorAll(".erd-col").forEach((el) => {
    el.classList.remove("erd-col-match", "erd-col-current");
    if (!searching || scope !== "column") return;
    const col = el.dataset.col || "";
    const table = el.closest(".erd-table")?.dataset?.table || "";
    if (!col || !table) return;
    if (col.toLowerCase().includes(q)) {
      el.classList.add("erd-col-match");
      if (active && active.table === table && active.column === col) {
        el.classList.add("erd-col-current");
      }
    }
  });

  // Dim edges that don't touch a hit table while searching
  root.querySelectorAll(".erd-edge, .erd-edge-label, .erd-port").forEach((el) => {
    el.classList.remove("erd-search-miss");
    if (!searching) return;
    const from = el.dataset.from;
    const to = el.dataset.to;
    if (!hitTables.has(from) && !hitTables.has(to)) {
      el.classList.add("erd-search-miss");
    }
  });
}

function panErdToTable(tab, tableName) {
  if (!tab?.erdLayout?.boxes || !tableName) return;
  const box = tab.erdLayout.boxes[tableName];
  const viewport = $("#erd-viewport");
  if (!box || !viewport) return;
  const view = tab.erdView || { x: 0, y: 0, scale: 1 };
  const scale = view.scale || 1;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  tab.erdView = {
    scale,
    x: viewport.clientWidth / 2 - cx * scale,
    y: viewport.clientHeight / 2 - cy * scale,
  };
  applyErdTransform(tab);
}

function runErdSearch(tab, { pan = true } = {}) {
  if (!tab || tab.kind !== "erd") return;
  tab.erdSearchMatches = collectErdSearchMatches(tab);
  if (!tab.erdSearchMatches.length) {
    tab.erdSearchIndex = 0;
  } else {
    const idx = Number(tab.erdSearchIndex) || 0;
    tab.erdSearchIndex = ((idx % tab.erdSearchMatches.length) + tab.erdSearchMatches.length)
      % tab.erdSearchMatches.length;
  }
  applyErdSearchStyles(tab);
  updateErdSearchNav(tab);
  if (pan && tab.erdSearchMatches.length) {
    const cur = tab.erdSearchMatches[tab.erdSearchIndex];
    panErdToTable(tab, cur.table);
    const label = cur.column ? `${cur.table}.${cur.column}` : cur.table;
    setStatus(`ERD search · ${label}`);
  } else if ((tab.erdSearchQuery || "").trim() && !tab.erdSearchMatches.length) {
    setStatus("ERD search · no matches");
  }
}

function erdSearchStep(delta) {
  const tab = activeWorkspaceTab();
  if (!tab || tab.kind !== "erd") return;
  const matches = tab.erdSearchMatches || [];
  if (!matches.length) return;
  tab.erdSearchIndex = (tab.erdSearchIndex + delta + matches.length) % matches.length;
  applyErdSearchStyles(tab);
  updateErdSearchNav(tab);
  const cur = matches[tab.erdSearchIndex];
  panErdToTable(tab, cur.table);
  const label = cur.column ? `${cur.table}.${cur.column}` : cur.table;
  setStatus(`ERD search · ${label}`);
}

function wireErdSearch() {
  const input = $("#erd-search-input");
  const scope = $("#erd-search-scope");
  if (!input || !scope || input.dataset.wired === "1") return;
  input.dataset.wired = "1";

  const applyFromUi = ({ pan = true } = {}) => {
    const tab = activeWorkspaceTab();
    if (!tab || tab.kind !== "erd") return;
    tab.erdSearchQuery = input.value || "";
    tab.erdSearchScope = scope.value === "column" ? "column" : "table";
    tab.erdSearchIndex = 0;
    runErdSearch(tab, { pan });
  };

  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => applyFromUi({ pan: true }), 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      applyFromUi({ pan: false });
      if (e.shiftKey) erdSearchStep(-1);
      else erdSearchStep(1);
    } else if (e.key === "Escape" && input.value) {
      e.preventDefault();
      clearTimeout(timer);
      input.value = "";
      applyFromUi({ pan: false });
    }
  });
  scope.addEventListener("change", () => applyFromUi({ pan: true }));
  $("#btn-erd-search-prev")?.addEventListener("click", () => erdSearchStep(-1));
  $("#btn-erd-search-next")?.addEventListener("click", () => erdSearchStep(1));
}

function updateErdLayoutBounds(tab) {
  const boxes = tab?.erdLayout?.boxes || {};
  let maxR = 0;
  let maxB = 0;
  for (const b of Object.values(boxes)) {
    maxR = Math.max(maxR, (b.x || 0) + (b.w || 0));
    maxB = Math.max(maxB, (b.y || 0) + (b.h || 0));
  }
  if (tab.erdLayout) {
    tab.erdLayout.width = maxR;
    tab.erdLayout.height = maxB;
  }
}

function erdColRowCenterY(box, colName, headerH = 28, rowH = 18) {
  const key = String(colName || "").toLowerCase();
  let idx = box.colIndex?.[key];
  if (idx == null) {
    const all = box.table?.columns || [];
    const found = all.find((c) => String(c.name || "").toLowerCase() === key);
    if (found) idx = box.colIndex?.[String(found.name).toLowerCase()];
  }
  if (idx == null) return (box.y || 0) + headerH + rowH / 2;
  return (box.y || 0) + headerH + idx * rowH + rowH / 2;
}

/** Redraw FK/logical edges from current box positions (used while dragging tables). */
function redrawErdEdges(tab) {
  const svg = $("#erd-canvas");
  const edges = svg?.querySelector(".erd-edges");
  const layout = tab?.erdLayout;
  if (!edges || !layout?.boxes) return;
  while (edges.firstChild) edges.removeChild(edges.firstChild);

  const NS = "http://www.w3.org/2000/svg";
  const HEADER_H = layout.headerH || 28;
  const ROW_H = layout.rowH || 18;
  const boxes = layout.boxes;
  const relations = getErdDisplayRelations(tab);

  for (const rel of relations) {
    // Data model: from* = FK/child side (b.a_id), to* = PK/parent side (a.id).
    // Draw parent → child so the arrow reads a.id → b.a_id.
    const parent = boxes[rel.toTable];
    const child = boxes[rel.fromTable];
    if (!parent || !child) continue;
    const childCol = (rel.fromColumns && rel.fromColumns[0]) || "";
    const parentCol = (rel.toColumns && rel.toColumns[0]) || "";
    if (!childCol && !parentCol) continue;

    const y1 = erdColRowCenterY(parent, parentCol, HEADER_H, ROW_H);
    const y2 = erdColRowCenterY(child, childCol, HEADER_H, ROW_H);
    let x1;
    let x2;
    const parentCenter = parent.x + parent.w / 2;
    const childCenter = child.x + child.w / 2;
    if (childCenter >= parentCenter) {
      x1 = parent.x + parent.w;
      x2 = child.x;
    } else {
      x1 = parent.x;
      x2 = child.x + child.w;
    }
    const dx = Math.max(28, Math.abs(x2 - x1) * 0.45);
    const c1x = x1 <= x2 ? x1 + dx : x1 - dx;
    const c2x = x1 <= x2 ? x2 - dx : x2 + dx;

    const startDot = document.createElementNS(NS, "circle");
    startDot.setAttribute("cx", String(x1));
    startDot.setAttribute("cy", String(y1));
    startDot.setAttribute("r", "2.5");
    startDot.classList.add("erd-port");
    if (rel.logical) startDot.classList.add("erd-port-logical");
    startDot.dataset.from = rel.fromTable || "";
    startDot.dataset.to = rel.toTable || "";
    edges.appendChild(startDot);

    const endDot = document.createElementNS(NS, "circle");
    endDot.setAttribute("cx", String(x2));
    endDot.setAttribute("cy", String(y2));
    endDot.setAttribute("r", "2.5");
    endDot.classList.add("erd-port");
    if (rel.logical) endDot.classList.add("erd-port-logical");
    endDot.dataset.from = rel.fromTable || "";
    endDot.dataset.to = rel.toTable || "";
    edges.appendChild(endDot);

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`);
    path.classList.add("erd-edge");
    if (rel.logical) path.classList.add("erd-edge-logical");
    path.dataset.from = rel.fromTable || "";
    path.dataset.to = rel.toTable || "";
    path.dataset.fromCol = childCol;
    path.dataset.toCol = parentCol;
    path.dataset.logical = rel.logical ? "1" : "0";
    path.setAttribute("marker-end", "url(#erd-arrow)");
    edges.appendChild(path);

    if (parentCol || childCol) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2 - 5;
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", String(mx));
      label.setAttribute("y", String(my));
      label.setAttribute("text-anchor", "middle");
      label.classList.add("erd-edge-label");
      if (rel.logical) label.classList.add("erd-edge-logical");
      label.dataset.from = rel.fromTable || "";
      label.dataset.to = rel.toTable || "";
      const nm = rel.logical
        ? `~ ${parentCol} → ${childCol}`
        : `${parentCol} → ${childCol}`;
      label.textContent = nm.length > 28 ? `${nm.slice(0, 27)}…` : nm;
      edges.appendChild(label);
    }
  }

  applyErdFocusStyles(tab);
  applyErdSearchStyles(tab);
}

function renderErdDiagram(data, tab) {
  const svg = $("#erd-canvas");
  const empty = $("#erd-empty");
  const title = $("#erd-title");
  const subtitle = $("#erd-subtitle");
  if (!svg || !tab) return;

  const tables = [...(data?.tables || [])].sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }),
  );
  tab.erdLogicalRelations = inferLogicalErdRelations(tables, data?.relations || []);
  const fkRelations = data?.relations || [];
  const relations = getErdDisplayRelations(tab);

  if (title) title.textContent = tab.schema || data?.schema || "ER Diagram";
  if (subtitle && !tab.erdFocusTable) {
    subtitle.textContent = erdRelationSubtitle(
      tables.length,
      fkRelations.length,
      (tab.erdLogicalRelations || []).length,
      !!tab.erdShowLogical,
    );
  }
  syncErdLogicalToggle(tab);

  setErdCanvasEmpty();
  if (!tables.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "No tables in this database/schema.";
    }
    tab.erdLayout = { width: 0, height: 0, boxes: {} };
    return;
  }
  if (empty) empty.hidden = true;

  const CARD_W = 220;
  const HEADER_H = 28;
  const ROW_H = 18;
  const PAD_X = 10;
  const GAP_X = 56;
  const GAP_Y = 48;
  const MAX_SHOWN_COLS = 40;
  const cols = Math.max(1, Math.ceil(Math.sqrt(tables.length)));

  // Columns that must be visible so edge ports can attach accurately.
  const requiredColsByTable = new Map();
  const requireCol = (tableName, colName) => {
    if (!tableName || !colName) return;
    if (!requiredColsByTable.has(tableName)) requiredColsByTable.set(tableName, new Set());
    requiredColsByTable.get(tableName).add(String(colName).toLowerCase());
  };
  for (const rel of relations) {
    for (const c of rel.fromColumns || []) requireCol(rel.fromTable, c);
    for (const c of rel.toColumns || []) requireCol(rel.toTable, c);
  }

  const buildShownColumns = (table) => {
    const all = table.columns || [];
    const required = requiredColsByTable.get(table.name) || new Set();
    const shown = [];
    const used = new Set();
    const pushCol = (c) => {
      if (!c?.name) return;
      const key = String(c.name).toLowerCase();
      if (used.has(key)) return;
      used.add(key);
      shown.push(c);
    };
    // Always keep PKs + relationship endpoints visible first.
    for (const c of all) {
      if (c.primaryKey || required.has(String(c.name || "").toLowerCase())) pushCol(c);
    }
    for (const c of all) {
      if (shown.length >= MAX_SHOWN_COLS) break;
      pushCol(c);
    }
    // If a required column is missing from metadata, synthesize a stub row so the port still exists.
    for (const need of required) {
      if (used.has(need)) continue;
      pushCol({ name: need, type: "", primaryKey: false, nullable: true });
    }
    return shown;
  };

  const boxes = {};
  let maxBottom = 0;
  let maxRight = 0;
  tables.forEach((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const shownColumns = buildShownColumns(t);
    const hiddenCount = Math.max(0, (t.columns || []).length - shownColumns.length);
    const moreRow = hiddenCount > 0 ? 1 : 0;
    const colCount = Math.max(1, shownColumns.length);
    const h = HEADER_H + (colCount + moreRow) * ROW_H + 8;
    const x = col * (CARD_W + GAP_X);
    const colIndex = {};
    shownColumns.forEach((c, idx) => {
      colIndex[String(c.name || "").toLowerCase()] = idx;
    });
    boxes[t.name] = {
      name: t.name,
      table: t,
      x,
      y: 0,
      w: CARD_W,
      h,
      col,
      row,
      colCount,
      shownColumns,
      hiddenCount,
      colIndex,
    };
  });

  // Compact row packing: track max height per grid row
  const rowHeights = [];
  tables.forEach((t) => {
    const b = boxes[t.name];
    rowHeights[b.row] = Math.max(rowHeights[b.row] || 0, b.h);
  });
  const rowTops = [];
  let accY = 0;
  for (let r = 0; r < rowHeights.length; r++) {
    rowTops[r] = accY;
    accY += (rowHeights[r] || HEADER_H) + GAP_Y;
  }
  Object.values(boxes).forEach((b) => {
    b.y = rowTops[b.row] || 0;
    const saved = tab.erdPositions?.[b.name];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      b.x = saved.x;
      b.y = saved.y;
    }
    maxBottom = Math.max(maxBottom, b.y + b.h);
    maxRight = Math.max(maxRight, b.x + b.w);
  });

  tab.erdLayout = {
    width: maxRight,
    height: maxBottom,
    boxes,
    headerH: HEADER_H,
    rowH: ROW_H,
  };

  const NS = "http://www.w3.org/2000/svg";
  const root = document.createElementNS(NS, "g");
  root.classList.add("erd-root");

  // Marker for FK arrows — tip sits on the target column port.
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(NS, "defs");
    svg.appendChild(defs);
  }
  defs.innerHTML = `
    <marker id="erd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M 0 1.2 L 8 5 L 0 8.8 z" class="erd-arrow-fill"/>
    </marker>
    <marker id="erd-arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M 0 1.2 L 8 5 L 0 8.8 z" class="erd-arrow-fill-active"/>
    </marker>
  `;

  const nodes = document.createElementNS(NS, "g");
  nodes.classList.add("erd-nodes");
  root.appendChild(nodes);

  const edges = document.createElementNS(NS, "g");
  edges.classList.add("erd-edges");
  root.appendChild(edges);

  Object.values(boxes).forEach((b) => {
    const g = document.createElementNS(NS, "g");
    g.classList.add("erd-table");
    g.setAttribute("transform", `translate(${b.x} ${b.y})`);
    g.dataset.table = b.name;

    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("width", String(b.w));
    rect.setAttribute("height", String(b.h));
    rect.setAttribute("rx", "6");
    rect.classList.add("erd-table-card");
    g.appendChild(rect);

    const head = document.createElementNS(NS, "rect");
    head.setAttribute("width", String(b.w));
    head.setAttribute("height", String(HEADER_H));
    head.setAttribute("rx", "6");
    head.classList.add("erd-table-head");
    g.appendChild(head);
    const headFix = document.createElementNS(NS, "rect");
    headFix.setAttribute("y", String(HEADER_H - 6));
    headFix.setAttribute("width", String(b.w));
    headFix.setAttribute("height", "6");
    headFix.classList.add("erd-table-head");
    g.appendChild(headFix);

    const nameText = document.createElementNS(NS, "text");
    nameText.setAttribute("x", String(PAD_X));
    nameText.setAttribute("y", "18");
    nameText.classList.add("erd-table-name");
    nameText.textContent = b.name;
    g.appendChild(nameText);

    (b.shownColumns || []).forEach((c, idx) => {
      const y = HEADER_H + 13 + idx * ROW_H;
      const row = document.createElementNS(NS, "text");
      row.setAttribute("x", String(PAD_X));
      row.setAttribute("y", String(y));
      row.classList.add("erd-col");
      row.dataset.col = c.name || "";
      if (c.primaryKey) row.classList.add("erd-col-pk");
      const required = requiredColsByTable.get(b.name);
      if (required?.has(String(c.name || "").toLowerCase())) {
        row.classList.add("erd-col-linked");
      }
      const pk = c.primaryKey ? "PK " : "";
      const type = c.type ? ` : ${c.type}` : "";
      const label = `${pk}${c.name}${type}`;
      row.textContent = label.length > 30 ? `${label.slice(0, 29)}…` : label;
      g.appendChild(row);
    });
    if (b.hiddenCount > 0) {
      const more = document.createElementNS(NS, "text");
      more.setAttribute("x", String(PAD_X));
      more.setAttribute("y", String(HEADER_H + 13 + (b.shownColumns || []).length * ROW_H));
      more.classList.add("erd-col", "erd-col-more");
      more.textContent = `+${b.hiddenCount} more…`;
      g.appendChild(more);
    }

    g.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      clearTimeout(erdTableFocusTimer);
      openTable(tab.schema, b.name, tab.connectionId, tab.database).catch((err) => alert(err.message));
    });

    nodes.appendChild(g);
  });

  svg.appendChild(root);
  redrawErdEdges(tab);

  if (!tab.erdView || tab.erdView._needsFit) {
    tab.erdView = { x: 0, y: 0, scale: 1, _needsFit: false };
    requestAnimationFrame(() => fitErdToViewport(tab));
  } else {
    applyErdTransform(tab);
  }
  applyErdFocusStyles(tab);
  updateErdFocusButton(tab);
  syncErdSearchUi(tab);
  tab.erdSearchMatches = collectErdSearchMatches(tab);
  if (tab.erdSearchMatches.length) {
    const idx = Number(tab.erdSearchIndex) || 0;
    tab.erdSearchIndex = ((idx % tab.erdSearchMatches.length) + tab.erdSearchMatches.length)
      % tab.erdSearchMatches.length;
  } else {
    tab.erdSearchIndex = 0;
  }
  applyErdSearchStyles(tab);
  updateErdSearchNav(tab);
  if (tab.erdFocusTable) {
    const subtitleEl = $("#erd-subtitle");
    if (subtitleEl && !(tab.erdSearchQuery || "").trim()) {
      const n = erdFocusNeighborhood(data, tab.erdFocusTable, tab).size;
      subtitleEl.textContent = `Focus · ${tab.erdFocusTable} · ${n} related table${n === 1 ? "" : "s"}`;
    }
  }
  ensureErdInteractions();
}

let erdInteractionsBound = false;
let erdTableFocusTimer = null;

function ensureErdInteractions() {
  if (erdInteractionsBound) return;
  const viewport = $("#erd-viewport");
  if (!viewport) return;
  erdInteractionsBound = true;

  let panning = false;
  let panMoved = false;
  let lastX = 0;
  let lastY = 0;
  /** @type {{ name: string, el: Element, lastX: number, lastY: number, moved: boolean } | null} */
  let tableDrag = null;

  viewport.addEventListener("pointerdown", (e) => {
    const tab = activeWorkspaceTab();
    if (!tab || tab.kind !== "erd") return;

    const tableEl = e.target.closest?.(".erd-table");
    if (tableEl) {
      const name = tableEl.dataset.table;
      if (!name || !tab.erdLayout?.boxes?.[name]) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(erdTableFocusTimer);
      tableDrag = {
        name,
        el: tableEl,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
      };
      tableEl.classList.add("erd-dragging");
      viewport.classList.add("erd-dragging-table");
      viewport.setPointerCapture?.(e.pointerId);
      return;
    }

    panning = true;
    panMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    viewport.setPointerCapture?.(e.pointerId);
    viewport.classList.add("erd-panning");
  });

  viewport.addEventListener("pointermove", (e) => {
    const tab = activeWorkspaceTab();
    if (!tab || tab.kind !== "erd") return;

    if (tableDrag) {
      const box = tab.erdLayout?.boxes?.[tableDrag.name];
      if (!box) return;
      const scale = Math.max(0.01, tab.erdView?.scale || 1);
      const dxScreen = e.clientX - tableDrag.lastX;
      const dyScreen = e.clientY - tableDrag.lastY;
      if (Math.abs(dxScreen) + Math.abs(dyScreen) > 3) tableDrag.moved = true;
      box.x += dxScreen / scale;
      box.y += dyScreen / scale;
      tableDrag.lastX = e.clientX;
      tableDrag.lastY = e.clientY;
      tableDrag.el.setAttribute("transform", `translate(${box.x} ${box.y})`);
      if (!tab.erdPositions) tab.erdPositions = {};
      tab.erdPositions[tableDrag.name] = { x: box.x, y: box.y };
      updateErdLayoutBounds(tab);
      redrawErdEdges(tab);
      return;
    }

    if (!panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 3) panMoved = true;
    const view = tab.erdView || { x: 0, y: 0, scale: 1 };
    view.x += dx;
    view.y += dy;
    lastX = e.clientX;
    lastY = e.clientY;
    tab.erdView = view;
    applyErdTransform(tab);
  });

  const endPointer = (e) => {
    const tab = activeWorkspaceTab();
    if (tableDrag) {
      const drag = tableDrag;
      tableDrag = null;
      drag.el.classList.remove("erd-dragging");
      viewport.classList.remove("erd-dragging-table");
      try { viewport.releasePointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }
      if (!drag.moved && tab?.kind === "erd") {
        clearTimeout(erdTableFocusTimer);
        erdTableFocusTimer = setTimeout(() => {
          const live = state.workspaceTabs.find((t) => t.id === tab.id) || tab;
          setErdFocus(live, drag.name);
        }, 220);
      }
      return;
    }
    if (!panning) return;
    const wasMoved = panMoved;
    panning = false;
    panMoved = false;
    viewport.classList.remove("erd-panning");
    try { viewport.releasePointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }
    if (!wasMoved && tab?.kind === "erd" && tab.erdFocusTable) clearErdFocus(tab);
  };
  viewport.addEventListener("pointerup", endPointer);
  viewport.addEventListener("pointercancel", endPointer);

  // Two-finger trackpad scroll pans; pinch / ctrl+wheel zoom stays blocked (toolbar ±).
  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return;
    const tab = activeWorkspaceTab();
    if (!tab || tab.kind !== "erd") return;
    const view = tab.erdView || { x: 0, y: 0, scale: 1 };
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= viewport.clientWidth;
      dy *= viewport.clientHeight;
    }
    if (e.shiftKey && dx === 0 && dy !== 0) {
      dx = dy;
      dy = 0;
    }
    view.x -= dx;
    view.y -= dy;
    tab.erdView = view;
    applyErdTransform(tab);
  }, { passive: false });
  viewport.addEventListener("gesturestart", (e) => e.preventDefault());
  viewport.addEventListener("gesturechange", (e) => e.preventDefault());
  viewport.addEventListener("gestureend", (e) => e.preventDefault());

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const tab = activeWorkspaceTab();
    if (tab?.kind === "erd" && tab.erdFocusTable) {
      clearErdFocus(tab);
      e.stopPropagation();
    }
  });
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

async function refreshDetails({ force = false } = {}) {
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
    updateDetailsActionButtons();
    return;
  }

  const focus = state.detailFocus || { scope: "connection" };
  const cid = focus.connectionId || state.activeConnectionId;

  const paint = (data) => {
    title.textContent = data.title || "Details";
    subtitle.textContent = data.subtitle || data.hierarchy || data.engine || "";
    renderDetailsItems(data.items || []);
    updateDetailsActionButtons();
  };

  if (!force && cid) {
    const cached = getCachedDetails(cid, focus);
    if (cached) {
      paint(cached);
      return;
    }
    const fromExplorer = buildDetailsFromExplorerCache(cid, focus);
    if (fromExplorer) {
      setCachedDetails(cid, focus, fromExplorer);
      paint(fromExplorer);
      return;
    }
  }

  if (force && cid) {
    const schema = focus.schema || (focus.scope === "database" ? focus.database : null);
    if (schema && (focus.scope === "schema" || focus.scope === "database")) {
      invalidateDetailsCache(cid, schema);
    } else if (focus.scope === "connection" || focus.scope === "table") {
      invalidateDetailsCache(cid);
    }
  }

  const params = new URLSearchParams({ scope: focus.scope || "connection" });
  if (focus.schema) params.set("schema", focus.schema);
  if (focus.database && focus.scope === "database") params.set("schema", focus.database);
  if (focus.table) params.set("table", focus.table);
  grid.innerHTML = `<div class="hint">Loading…</div>`;
  if (empty) empty.hidden = true;
  updateDetailsActionButtons();
  try {
    const data = await api(withConnectionId(`/api/details?${params}`, cid));
    if (cid) setCachedDetails(cid, focus, data);
    paint(data);
  } catch (e) {
    title.textContent = "Details";
    subtitle.textContent = e.message || "Failed to load details";
    grid.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = e.message || "Failed to load details";
    }
    updateDetailsActionButtons();
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
 * View tabs (Details/Data) only for table workspace tabs.
 * Structure is opened from the Details panel button, not a top tab.
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
  updateDetailsActionButtons();
}

/** Show Details → Structure only when a table workspace is active. */
function updateStructureEntryButton() {
  const btn = $("#btn-view-structure");
  if (!btn) return;
  const tab = activeWorkspaceTab();
  const show = isTableWorkspaceActive(tab) && state.currentTab === "details";
  btn.hidden = !show;
  if (show && tab) {
    btn.title = `View structure for ${tab.schema}.${tab.table}`;
  }
}

function updateDetailsActionButtons() {
  updateStructureEntryButton();
  const refreshBtn = $("#btn-refresh-details");
  if (!refreshBtn) return;
  const connected = state.connected || Object.keys(state.connectedIds || {}).length > 0;
  refreshBtn.hidden = !(connected && state.currentTab === "details");
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
    if (tab?.kind === "erd") {
      target = "erd";
    } else if (tab?.kind === "sql") {
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

  // Structure is a Details sub-view — only available for table tabs.
  if (target === "structure" && !isTable) {
    target = "details";
  }

  state.currentTab = target;
  if (tab) tab.viewMode = target;

  const tabHighlight = target === "structure" ? "details" : target;
  $$(".tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabHighlight));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${target}`));
  updateViewTabBarVisibility();

  if (!skipTitle) {
    if (state.currentTable && state.currentSchema) {
      updateContextMeta(`${state.currentSchema} · ${state.currentTable}`);
    } else if (state.detailFocus?.scope === "schema" && state.detailFocus.schema) {
      updateContextMeta(state.detailFocus.schema);
    } else if (state.detailFocus?.scope === "database" && state.detailFocus.database) {
      updateContextMeta(state.detailFocus.database);
    } else if (target !== "details" && target !== "structure") {
      updateContextMeta("");
    }
  }
  if (target === "details") {
    refreshDetails().catch((e) => console.error(e));
  } else {
    updateDetailsActionButtons();
  }
  if (target === "structure") {
    const st = $("#structure-title");
    const ss = $("#structure-subtitle");
    if (st && state.currentTable) st.textContent = state.currentTable;
    if (ss && state.currentSchema && state.currentTable) {
      ss.textContent = `${state.currentSchema} · columns & DDL`;
    }
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

function updateFilterIndicators() {
  const n = activeColumnFilterCount();
  const clearBtn = $("#btn-clear-filters");
  const label = $("#filter-indicator-label");
  if (clearBtn) clearBtn.hidden = n === 0;
  if (label) label.textContent = n === 1 ? "1 filter" : `${n} filters`;

  const search = $("#data-search");
  if (search) search.classList.toggle("has-filter", !!(search.value || "").trim());
}

function updateClearFiltersButton() {
  updateFilterIndicators();
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

function canEditDataCells() {
  const tab = activeWorkspaceTab();
  return !!(tab && tab.kind === "table" && tab.table && tab.schema);
}

function primaryKeyColumnNames() {
  return (state.columns || [])
    .filter((c) => c && c.primaryKey && c.name)
    .map((c) => c.name);
}

function formatCellEditorValue(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function parseCellEditorValue(text, original) {
  const raw = text ?? "";
  if (typeof original === "number" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  if (typeof original === "boolean") {
    const lower = raw.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  if (original != null && typeof original === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

let cellEditContext = null;

function openCellValueEditor(row, column) {
  if (!canEditDataCells()) {
    setStatus("Open a table to edit cell values");
    return;
  }
  const pks = primaryKeyColumnNames();
  if (!pks.length) {
    alert("Cannot update this table: no primary key is defined.");
    return;
  }
  for (const pk of pks) {
    if (!(pk in row)) {
      alert(`Cannot update: primary key column “${pk}” is missing from this row.`);
      return;
    }
  }

  const tab = activeWorkspaceTab();
  const modal = $("#modal-cell-edit");
  const valueEl = $("#cell-edit-value");
  const nullEl = $("#cell-edit-null");
  const err = $("#cell-edit-error");
  if (!modal || !valueEl || !nullEl) return;

  cellEditContext = {
    row,
    column,
    schema: tab.schema,
    table: tab.table,
    connectionId: tab.connectionId || state.activeConnectionId,
  };

  $("#cell-edit-title").textContent = `Edit ${column}`;
  $("#cell-edit-meta").textContent = `${tab.schema}.${tab.table}`;
  const isNull = row[column] == null;
  nullEl.checked = isNull;
  valueEl.value = formatCellEditorValue(row[column]);
  valueEl.disabled = isNull;
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  nullEl.onchange = () => {
    valueEl.disabled = nullEl.checked;
    if (!nullEl.checked) valueEl.focus();
  };
  modal.showModal();
  if (!isNull) {
    valueEl.focus();
    valueEl.select();
  }
}

function closeCellValueEditor() {
  cellEditContext = null;
  $("#modal-cell-edit")?.close();
}

async function saveCellValueEdit(e) {
  e.preventDefault();
  const ctx = cellEditContext;
  const err = $("#cell-edit-error");
  if (!ctx) return;
  const pks = primaryKeyColumnNames();
  if (!pks.length) {
    if (err) {
      err.hidden = false;
      err.textContent = "No primary key columns available.";
    }
    return;
  }

  const pk = {};
  for (const name of pks) {
    pk[name] = ctx.row[name];
  }

  const setNull = !!$("#cell-edit-null")?.checked;
  const raw = $("#cell-edit-value")?.value ?? "";
  const nextValue = setNull ? null : parseCellEditorValue(raw, ctx.row[ctx.column]);
  const values = { [ctx.column]: nextValue };

  const saveBtn = $("#btn-save-cell-edit");
  if (saveBtn) saveBtn.disabled = true;
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  try {
    const base = `/api/databases/${encodeURIComponent(ctx.schema)}/tables/${encodeURIComponent(ctx.table)}/rows`;
    await api(withConnectionId(base, ctx.connectionId), {
      method: "PUT",
      body: JSON.stringify({ pk, values }),
    });
    ctx.row[ctx.column] = nextValue;
    const tab = state.workspaceTabs.find((t) => t.id === state.activeWorkspaceTabId);
    if (tab?.result) tab.result = state.result;
    closeCellValueEditor();
    renderData(state.result);
    setStatus(`Updated ${ctx.table}.${ctx.column}`);
  } catch (ex) {
    if (err) {
      err.hidden = false;
      err.textContent = ex.message || "Failed to update value";
    } else {
      alert(ex.message || "Failed to update value");
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
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
    mark.textContent = "●";
    mark.title = "Filter active";
    mark.setAttribute("aria-label", "Filter active");
    th.append(label, mark);
    if (isColumnFilterActive(state.columnFilters?.[c])) {
      const f = state.columnFilters[c];
      const opMeta = COLUMN_FILTER_OPS.find((o) => o.id === f.op);
      th.title = opMeta?.needsValue
        ? `Filtered: ${opMeta.label} “${f.value || ""}” · click to edit · right-click to hide`
        : `Filtered: ${opMeta?.label || f.op} · click to edit · right-click to hide`;
    }
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
        td.textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
        td.title = typeof v === "object" ? JSON.stringify(v) : String(v);
      }
      if (canEditDataCells()) {
        td.classList.add("cell-editable");
        const tip = v == null ? "NULL" : (typeof v === "object" ? JSON.stringify(v) : String(v));
        td.title = `${tip} · double-click to edit`;
        td.ondblclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          openCellValueEditor(row, c);
        };
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
      <td>${escapeHtml(c.defaultValue ?? "")}</td>
      <td class="structure-actions"></td>`;
    const actions = tr.querySelector(".structure-actions");
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "btn ghost sm";
    renameBtn.textContent = "Rename";
    renameBtn.title = `Rename column ${c.name}`;
    renameBtn.addEventListener("click", () => {
      const tab = activeWorkspaceTab();
      const schema = tab?.schema || state.currentSchema;
      const table = tab?.table || state.currentTable;
      if (!schema || !table) {
        alert("Open a table first");
        return;
      }
      renameColumnInteractive(schema, table, c.name, tab?.connectionId || state.activeConnectionId)
        .catch((err) => alert(err.message));
    });
    actions.appendChild(renameBtn);
    tbody.appendChild(tr);
  }
}

async function renameColumnInteractive(schema, table, column, connectionId = null) {
  const current = String(column || "").trim();
  if (!schema || !table || !current) {
    throw new Error("Schema, table, and column are required");
  }
  const newName = String(prompt(`Rename column “${current}” to:`, current) || "").trim();
  if (!newName || newName === current) return null;
  const cid = connectionId || state.activeConnectionId;
  const path = withConnectionId(
    `/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/columns/${encodeURIComponent(current)}/rename`,
    cid,
  );
  await api(path, {
    method: "POST",
    body: JSON.stringify({ newName }),
    connectionId: cid,
  });
  setStatus(`Renamed column ${current} → ${newName}`);
  // Refresh open table workspace if it matches.
  const tab = activeWorkspaceTab();
  if (tab?.kind === "table" && tab.schema === schema && tab.table === table) {
    tab.columns = null;
    tab.ddl = null;
    await applyWorkspaceTab(tab.id, { forceReload: true });
    if (state.currentTab === "structure" || tab.viewMode === "structure") {
      switchTab("structure", { skipTitle: true });
    }
  }
  return newName;
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
  wireExplorerSearch();
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
  $("#btn-cancel-cell-edit")?.addEventListener("click", () => closeCellValueEditor());
  $("#form-cell-edit")?.addEventListener("submit", (e) => {
    saveCellValueEdit(e).catch((err) => console.error(err));
  });
  $("#modal-cell-edit")?.addEventListener("close", () => {
    cellEditContext = null;
  });
  $("#btn-add-col-row").onclick = () => addCreateTableColumnRow();

  $("#btn-erd-zoom-in")?.addEventListener("click", () => erdZoomBy(1.15));
  $("#btn-erd-zoom-out")?.addEventListener("click", () => erdZoomBy(1 / 1.15));
  $("#btn-erd-fit")?.addEventListener("click", () => {
    const tab = activeWorkspaceTab();
    if (tab?.kind === "erd") fitErdToViewport(tab);
  });
  $("#chk-erd-logical")?.addEventListener("change", (e) => {
    setErdShowLogical(!!e.target.checked);
  });
  $("#btn-erd-clear-focus")?.addEventListener("click", () => {
    clearErdFocus(activeWorkspaceTab());
  });
  $("#btn-erd-refresh")?.addEventListener("click", () => {
    const tab = activeWorkspaceTab();
    if (!tab || tab.kind !== "erd") return;
    applyWorkspaceTab(tab.id, { forceReload: true }).catch((err) => alert(err.message));
  });
  wireErdSearch();

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
    const progress = beginTreeLoading(
      findConnectionTreeNode(base.id),
      "Connecting…",
      { determinate: true }
    );
    progress.setProgress(25);
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
      progress.setProgress(100);
      $("#modal-password").close();
      showError($("#sidebar-error"), "");
      await onConnected();
    } catch (err) {
      setStatus("Connection failed");
      alert(err.message);
    } finally {
      progress.end();
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
    updateFilterIndicators();
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
  $("#btn-view-structure")?.addEventListener("click", () => {
    switchTab("structure");
  });
  $("#btn-refresh-details")?.addEventListener("click", () => {
    refreshDetails({ force: true }).catch((e) => {
      console.error(e);
      setStatus(e.message || "Failed to refresh details");
    });
  });
  $("#btn-back-to-details")?.addEventListener("click", () => {
    switchTab("details");
  });
}

function hideAppLoader() {
  document.documentElement.classList.remove("booting");
  const loader = $("#app-loader");
  if (loader) {
    loader.hidden = true;
    loader.setAttribute("aria-hidden", "true");
  }
}

async function waitForStylesheet() {
  const sheets = [...document.styleSheets].filter((s) => {
    try {
      return !!(s.href && s.href.includes("styles.css"));
    } catch {
      return false;
    }
  });
  if (!sheets.length) return;
  // Give the stylesheet a moment if rules aren't readable yet.
  for (let i = 0; i < 20; i++) {
    try {
      if (sheets.some((s) => s.cssRules && s.cssRules.length)) return;
    } catch {
      /* cross-origin / not ready */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
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
  await waitForStylesheet();
  // One paint with styles applied before revealing the UI.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  hideAppLoader();
}

boot().catch((e) => {
  console.error(e);
  showError($("#sidebar-error"), e.message);
  hideAppLoader();
});
