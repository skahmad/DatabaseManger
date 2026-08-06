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
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}

function setStatus(msg) {
  $("#status").textContent = msg;
}

function showGate(show) {
  $("#gate").hidden = !show;
  $("#app").hidden = show;
}

function showError(el, msg) {
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = msg;
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
  const density = DENSITIES.includes(prefs.density) ? prefs.density : "comfortable";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = density;
  $$(".pref-theme").forEach((el) => { el.value = theme; });
  $$(".pref-density").forEach((el) => { el.value = density; });
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
}

/* ── Profiles / connect gate ─────────────────────── */

async function loadProfiles() {
  state.profiles = await api("/api/profiles");
  renderProfiles();
}

function renderProfiles() {
  const list = $("#profile-list");
  list.innerHTML = "";
  if (!state.profiles.length) {
    list.innerHTML = `<div class="profile-empty">No saved connections yet. Create one to begin.</div>`;
    $("#btn-connect-selected").disabled = true;
    return;
  }
  for (const p of state.profiles) {
    const row = document.createElement("div");
    row.className = "profile-item" + (p.id === state.selectedProfileId ? " active" : "");
    row.dataset.id = p.id;

    const detail = p.fileBased || ["SQLITE", "H2_FILE"].includes(p.dbType)
      ? `${p.displayType} · ${p.database || ""}`
      : `${p.displayType} · ${p.host}${p.database ? " / " + p.database : ""}`;

    const main = document.createElement("div");
    main.className = "profile-main";
    main.innerHTML = `<strong>${escapeHtml(p.name || "Untitled")}</strong><div class="profile-detail">${escapeHtml(detail)}</div>`;
    main.onclick = () => {
      state.selectedProfileId = p.id;
      renderProfiles();
      $("#btn-connect-selected").disabled = false;
    };
    main.ondblclick = () => connectSelected();

    const actions = document.createElement("div");
    actions.className = "profile-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn ghost sm";
    editBtn.textContent = "Edit";
    editBtn.onclick = (e) => {
      e.stopPropagation();
      openEditConnection(p);
    };

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn ghost sm danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteConnection(p).catch((err) => showError($("#gate-error"), err.message));
    };

    actions.append(editBtn, delBtn);
    row.append(main, actions);
    list.appendChild(row);
  }
  $("#btn-connect-selected").disabled = !state.selectedProfileId;
}

async function deleteConnection(profile) {
  const ok = confirm(`Delete connection “${profile.name || "Untitled"}”?`);
  if (!ok) return;
  await api("/api/profiles/" + encodeURIComponent(profile.id), { method: "DELETE" });
  if (state.selectedProfileId === profile.id) state.selectedProfileId = null;
  showError($("#gate-error"), "");
  await loadProfiles();
}

async function connectSelected() {
  const profile = state.profiles.find((p) => p.id === state.selectedProfileId);
  if (!profile) return;
  showError($("#gate-error"), "");
  try {
    const fileBased = ["SQLITE", "H2_FILE"].includes(profile.dbType);
    if (!fileBased && !profile.hasPassword) {
      openPasswordModal(profile);
      return;
    }
    setStatus("Connecting…");
    await api("/api/connect/" + encodeURIComponent(profile.id), {
      method: "POST",
      body: "{}",
    });
    await enterApp();
  } catch (e) {
    if (/Access denied|password|authentication|fe_sendauth/i.test(e.message)) {
      openPasswordModal(profile);
      showError($("#gate-error"), "Password required or incorrect.");
      return;
    }
    showError($("#gate-error"), e.message);
  }
}

async function enterApp() {
  state.session = await api("/api/session");
  state.connected = !!state.session.connected;
  showGate(false);
  const p = state.session.profile;
  $("#session-meta").textContent = p
    ? `${p.displayType} · ${p.username}@${p.host || "file"} / ${p.database || ""}`
    : "";
  $("#conn-pill").textContent = "connected";
  setStatus("Connected");
  await loadTree();
}

/* ── Connection modal ────────────────────────────── */

async function loadDbTypes() {
  state.dbTypes = await api("/api/db-types");
  const sel = $("#db-type");
  sel.innerHTML = state.dbTypes.map((t) =>
    `<option value="${t.id}">${t.name}</option>`).join("");
  sel.onchange = () => updateConnFormForType();
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
}

function openNewConnection() {
  state.editingProfileId = null;
  $("#modal-conn-title").textContent = "New connection";
  $("#btn-submit-conn").textContent = "Connect";
  const form = $("#form-connection");
  form.reset();
  form.id.value = "";
  form.dbType.value = "MYSQL";
  form.host.value = "localhost";
  form.port.value = 3306;
  form.username.value = "root";
  form.password.placeholder = "";
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
  updateConnFormForType();
  $("#modal-connection").showModal();
}

function openPasswordModal(profile) {
  state.pendingProfile = profile;
  $("#password-lead").textContent = `Password required for “${profile.name}”.`;
  const form = $("#form-password");
  form.username.value = profile.username || "";
  form.password.value = "";
  form.savePassword.checked = false;
  $("#modal-password").showModal();
}

function readConnectionForm(form) {
  const profile = {
    name: form.name.value.trim() || undefined,
    dbType: form.dbType.value,
    host: form.host.value.trim(),
    port: Number(form.port.value) || 0,
    database: form.database.value.trim(),
    username: form.username.value.trim(),
    password: form.password.value,
    savePassword: form.savePassword.checked,
  };
  if (form.id.value) profile.id = form.id.value;
  return profile;
}

/* ── Explorer tree ───────────────────────────────── */

async function loadTree() {
  const filter = ($("#explorer-filter").value || "").toLowerCase();
  const dbs = await api("/api/databases");
  const tree = $("#tree");
  tree.innerHTML = "";
  for (const db of dbs) {
    if (filter && !db.toLowerCase().includes(filter)) continue;
    tree.appendChild(renderDbNode(db));
  }
  if (!dbs.length) {
    tree.innerHTML = `<div class="profile-empty">No schemas/databases found.</div>`;
  }
}

function renderDbNode(db) {
  const wrap = document.createElement("div");
  wrap.className = "tree-node";
  const row = document.createElement("div");
  row.className = "tree-row";
  row.innerHTML = `<span class="badge db">DB</span><span>${escapeHtml(db)}</span>`;
  const kids = document.createElement("div");
  kids.className = "tree-children";
  kids.hidden = true;
  let loaded = false;
  row.onclick = async () => {
    kids.hidden = !kids.hidden;
    if (!kids.hidden && !loaded) {
      loaded = true;
      kids.innerHTML = `<div class="hint" style="padding:.4rem">Loading…</div>`;
      try {
        const [tables, views, procs, funcs] = await Promise.all([
          api(`/api/databases/${encodeURIComponent(db)}/tables`),
          api(`/api/databases/${encodeURIComponent(db)}/views`),
          api(`/api/databases/${encodeURIComponent(db)}/procedures`),
          api(`/api/databases/${encodeURIComponent(db)}/functions`),
        ]);
        kids.innerHTML = "";
        kids.appendChild(folder("Tables", "tbl", db, tables, "table"));
        kids.appendChild(folder("Views", "vw", db, views, "view"));
        kids.appendChild(folder("Procedures", "db", db, procs, "proc"));
        kids.appendChild(folder("Functions", "db", db, funcs, "func"));
      } catch (e) {
        kids.innerHTML = `<div class="error-text">${escapeHtml(e.message)}</div>`;
        loaded = false;
      }
    }
  };
  wrap.append(row, kids);
  return wrap;
}

function folder(label, badge, schema, items, kind) {
  const wrap = document.createElement("div");
  wrap.className = "tree-node";
  const row = document.createElement("div");
  row.className = "tree-row";
  row.innerHTML = `<span class="badge ${badge}">${badge.toUpperCase()}</span><span>${label} (${items.length})</span>`;
  const kids = document.createElement("div");
  kids.className = "tree-children";
  kids.hidden = true;
  row.onclick = (e) => {
    e.stopPropagation();
    kids.hidden = !kids.hidden;
  };
  for (const name of items) {
    const item = document.createElement("div");
    item.className = "tree-row";
    item.innerHTML = `<span>${escapeHtml(name)}</span>`;
    item.onclick = async (e) => {
      e.stopPropagation();
      $$(".tree-row.active").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");
      if (kind === "table" || kind === "view") {
        await openTable(schema, name);
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

async function openTable(schema, table) {
  state.currentSchema = schema;
  state.currentTable = table;
  state.page = 1;
  $("#data-context").textContent = `${schema} · ${table}`;
  $("#context-title").textContent = table;
  updateContextMeta("Loading…");
  setStatus(`Loading ${table}…`);
  const limit = Number($("#row-limit").value) || 500;
  const [cols, rows] = await Promise.all([
    api(`/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/columns`),
    api(`/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/rows?limit=${limit}`),
  ]);
  state.columns = cols;
  state.result = rows;
  renderStructure(cols);
  renderData(rows);
  try {
    const ddl = await api(`/api/databases/${encodeURIComponent(schema)}/tables/${encodeURIComponent(table)}/ddl`);
    $("#ddl-view").textContent = ddl.ddl || "";
  } catch {
    $("#ddl-view").textContent = "DDL unavailable";
  }
  $("#sql-editor").value = `SELECT * FROM ${quoteIdent(table)} LIMIT ${limit}`;
  switchTab("data");
  setStatus(rows.message || `Loaded ${table}`);
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function updateContextMeta(text) {
  const el = $("#context-meta");
  if (!text) {
    el.textContent = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
}

/* ── Tabs / data grid ────────────────────────────── */

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  const titles = { sql: "SQL Editor", data: "Data", structure: "Structure", ddl: "DDL" };
  if (state.currentTable && name !== "sql") {
    $("#context-title").textContent = state.currentTable;
    if (state.result && !state.result.update) {
      // keep latest meta from last render
    } else if (state.currentSchema) {
      updateContextMeta(`${state.currentSchema} · ${state.currentTable}`);
    }
  } else {
    $("#context-title").textContent = titles[name];
    if (name === "sql") updateContextMeta("");
  }
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
  const sql = $("#sql-editor").value.trim();
  if (!sql) return;
  setStatus("Executing…");
  try {
    const result = await api("/api/query", { method: "POST", body: JSON.stringify({ sql }) });
    state.result = result;
    state.page = 1;
    if (!state.currentTable) {
      $("#context-title").textContent = "Query result";
      $("#data-context").textContent = "Query result";
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
  const result = state.result;
  if (!result?.columns?.length) return;
  const lines = [result.columns.join(",")];
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => csvEscape(row[c])).join(","));
  }
  downloadBlob(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }), "export.csv");
}

function exportJson() {
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
  $("#btn-connect-selected").onclick = () => connectSelected().catch((e) => showError($("#gate-error"), e.message));
  $("#btn-new-connection").onclick = openNewConnection;
  $("#btn-cancel-conn").onclick = () => {
    state.editingProfileId = null;
    $("#modal-connection").close();
  };
  $("#btn-cancel-pw").onclick = () => $("#modal-password").close();

  $("#form-connection").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const profile = readConnectionForm(form);
    try {
      showError($("#gate-error"), "");
      if (state.editingProfileId) {
        await api("/api/profiles", { method: "POST", body: JSON.stringify(profile) });
        state.editingProfileId = null;
        $("#modal-connection").close();
        await loadProfiles();
        setStatus("Connection saved");
        return;
      }
      await api("/api/connect", { method: "POST", body: JSON.stringify(profile) });
      $("#modal-connection").close();
      await loadProfiles();
      await enterApp();
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
      await api("/api/connect/" + encodeURIComponent(base.id), {
        method: "POST",
        body: JSON.stringify({
          username: form.username.value.trim(),
          password: form.password.value,
          savePassword: form.savePassword.checked,
        }),
      });
      $("#modal-password").close();
      await loadProfiles();
      await enterApp();
    } catch (err) {
      alert(err.message);
    }
  };

  $("#btn-disconnect").onclick = async () => {
    await api("/api/disconnect", { method: "POST", body: "{}" });
    state.connected = false;
    state.currentSchema = null;
    state.currentTable = null;
    state.result = null;
    state.page = 1;
    updateContextMeta("");
    $("#context-title").textContent = "SQL Editor";
    showGate(true);
    await loadProfiles();
    setStatus("Disconnected");
  };

  $("#btn-refresh-tree").onclick = () => loadTree().catch((e) => setStatus(e.message));
  $("#explorer-filter").oninput = () => loadTree().catch(console.error);
  $("#btn-run").onclick = () => runSql();
  $("#btn-clear-sql").onclick = () => { $("#sql-editor").value = ""; };
  $("#sql-editor").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runSql();
    }
  });
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
  $$(".tab").forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
}

async function boot() {
  wire();
  await loadDbTypes();
  const session = await api("/api/session");
  if (session.connected) {
    state.session = session;
    showGate(false);
    $("#session-meta").textContent = session.profile
      ? `${session.profile.displayType} · ${session.profile.username}`
      : "";
    await loadTree();
  } else {
    showGate(true);
    await loadProfiles();
  }
}

boot().catch((e) => {
  console.error(e);
  showError($("#gate-error"), e.message);
});
