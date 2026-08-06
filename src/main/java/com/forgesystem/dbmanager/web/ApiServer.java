package com.forgesystem.dbmanager.web;

import com.forgesystem.dbmanager.model.ColumnInfo;
import com.forgesystem.dbmanager.model.ConnectionMode;
import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.DbType;
import com.forgesystem.dbmanager.model.QueryResult;
import com.forgesystem.dbmanager.service.CloneMigrateService;
import com.forgesystem.dbmanager.service.ConnectionService;
import com.forgesystem.dbmanager.service.ConnectionStore;
import com.forgesystem.dbmanager.service.DatabaseService;
import com.forgesystem.dbmanager.service.DatabaseService.ColumnDefinition;
import com.forgesystem.dbmanager.service.ImportExportService;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.HttpStatus;

import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class ApiServer {
    private final int port;
    private final Gson gson = new GsonBuilder().serializeNulls().create();
    private final ConnectionService connectionService = new ConnectionService();
    private final DatabaseService databaseService = new DatabaseService(connectionService);
    private final ImportExportService importExportService = new ImportExportService(databaseService);
    private final CloneMigrateService cloneMigrateService = new CloneMigrateService(connectionService, databaseService);
    private final ConnectionStore connectionStore = new ConnectionStore();
    private final List<ConnectionProfile> profiles = new ArrayList<>(connectionStore.load());
    private Javalin app;

    public ApiServer(int port) {
        this.port = port;
    }

    public void start() {
        app = Javalin.create(config -> {
            config.staticFiles.add(staticFiles -> {
                staticFiles.hostedPath = "/";
                staticFiles.directory = "/public";
                staticFiles.location = io.javalin.http.staticfiles.Location.CLASSPATH;
            });
            config.http.defaultContentType = "application/json";
        });

        app.exception(Exception.class, (e, ctx) -> {
            connectionService.clearRequestSession();
            ctx.status(HttpStatus.BAD_REQUEST);
            ctx.json(Map.of("error", e.getMessage() == null ? e.toString() : e.getMessage()));
        });

        // Clear per-request session binding after every call (parallel explorer loads).
        app.after(ctx -> connectionService.clearRequestSession());

        // Health
        app.get("/api/health", ctx -> ctx.json(Map.of("ok", true, "app", "Forge Database Manager")));

        // Connection profiles
        app.get("/api/profiles", ctx -> ctx.json(sanitizeProfiles(profiles)));
        app.get("/api/profiles/{id}/properties", this::profileProperties);
        app.post("/api/profiles", this::saveProfile);
        app.delete("/api/profiles/{id}", this::deleteProfile);

        // Session
        app.get("/api/session", this::session);
        app.post("/api/session/active", this::setActiveSession);
        app.post("/api/connect", this::connect);
        app.post("/api/connect/{id}", this::connectById);
        app.post("/api/disconnect", this::disconnect);
        app.post("/api/disconnect/{id}", this::disconnectById);

        // Metadata
        app.get("/api/databases", this::databases);
        app.get("/api/explorer", this::explorer);
        app.get("/api/details", this::details);
        app.get("/api/databases/{schema}/properties", this::databaseProperties);
        app.get("/api/databases/{schema}/tables", this::tables);
        app.get("/api/databases/{schema}/views", this::views);
        app.get("/api/databases/{schema}/procedures", this::procedures);
        app.get("/api/databases/{schema}/functions", this::functions);
        app.get("/api/databases/{schema}/tables/{table}/columns", this::columns);
        app.get("/api/databases/{schema}/tables/{table}/ddl", this::ddl);
        app.get("/api/databases/{schema}/tables/{table}/rows", this::previewRows);

        // Query / CRUD
        app.post("/api/query", this::query);
        app.post("/api/databases/{schema}/tables/{table}/rows", this::insertRow);
        app.put("/api/databases/{schema}/tables/{table}/rows", this::updateRow);
        app.delete("/api/databases/{schema}/tables/{table}/rows", this::deleteRow);

        // Database / schema administration
        app.post("/api/databases", this::createDatabase);
        app.patch("/api/databases/{name}", this::alterDatabase);
        app.delete("/api/databases/{name}", this::dropDatabase);
        app.post("/api/databases/{name}/clone", this::cloneDatabase);
        app.post("/api/migrate", this::migrateDatabase);
        app.post("/api/schemas", this::createSchema);
        app.delete("/api/schemas/{name}", this::dropSchema);

        // Table / view / index administration
        app.post("/api/databases/{schema}/tables", this::createTable);
        app.delete("/api/databases/{schema}/tables/{table}", this::dropTable);
        app.post("/api/databases/{schema}/tables/{table}/rename", this::renameTable);
        app.post("/api/databases/{schema}/tables/{table}/columns", this::addColumn);
        app.delete("/api/databases/{schema}/tables/{table}/columns/{column}", this::dropColumn);
        app.post("/api/databases/{schema}/views", this::createView);
        app.delete("/api/databases/{schema}/views/{view}", this::dropView);
        app.get("/api/databases/{schema}/tables/{table}/indexes", this::listIndexes);
        app.post("/api/databases/{schema}/tables/{table}/indexes", this::createIndex);
        app.delete("/api/databases/{schema}/tables/{table}/indexes/{name}", this::dropIndex);

        // Import / export
        app.get("/api/databases/{schema}/tables/{table}/export", this::exportTable);
        app.get("/api/databases/{schema}/export", this::exportDatabase);
        app.post("/api/databases/{schema}/tables/{table}/import", this::importTable);
        app.post("/api/import/sql", this::importSql);

        app.get("/api/db-types", ctx -> {
            List<Map<String, Object>> types = new ArrayList<>();
            for (DbType t : DbType.values()) {
                types.add(Map.of(
                        "id", t.name(),
                        "name", t.getDisplayName(),
                        "defaultPort", t.getDefaultPort(),
                        "fileBased", t.isFileBased()
                ));
            }
            ctx.json(types);
        });

        // Localhost only — consumed by the desktop WebView, not exposed as a public site.
        app.start("127.0.0.1", port);
    }

    public int getPort() {
        return app != null ? app.port() : port;
    }

    public void stop() {
        if (app != null) {
            app.stop();
            app = null;
        }
    }

    private void session(Context ctx) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("connected", connectionService.isConnected());
        out.put("activeId", connectionService.getActiveId());

        List<Map<String, Object>> sessions = new ArrayList<>();
        for (ConnectionProfile p : connectionService.listConnectedProfiles()) {
            sessions.add(sessionProfileJson(p, p.getId().equals(connectionService.getActiveId())));
        }
        out.put("sessions", sessions);

        if (connectionService.isConnected() && connectionService.getProfile() != null) {
            out.put("profile", sessionProfileJson(
                    connectionService.getProfile(),
                    true
            ));
        }
        ctx.json(out);
    }

    private Map<String, Object> sessionProfileJson(ConnectionProfile p, boolean active) {
        Map<String, Object> profile = new LinkedHashMap<>();
        profile.put("id", p.getId());
        profile.put("name", nullToEmpty(p.getName()));
        profile.put("dbType", p.getDbType().name());
        profile.put("displayType", p.getDbType().getDisplayName());
        profile.put("connectionMode", p.getConnectionMode().name());
        profile.put("connectionModeLabel",
                p.getConnectionMode().getDisplayName() + " · " + p.getConnectionMode().getDescription());
        profile.put("host", nullToEmpty(p.getHost()));
        profile.put("database", nullToEmpty(p.getDatabase()));
        profile.put("username", nullToEmpty(p.getUsername()));
        profile.put("active", active);
        profile.put("useSshTunnel", p.isUseSshTunnel());
        profile.put("sshTunnel", active && connectionService.isSshTunnelActive());
        if (p.usesSshTunnel()) {
            profile.put("sshHost", nullToEmpty(p.getSshHost()));
        }
        return profile;
    }

    private void setActiveSession(Context ctx) {
        JsonObject body = gson.fromJson(ctx.body().isBlank() ? "{}" : ctx.body(), JsonObject.class);
        String id = body != null && body.has("id") ? body.get("id").getAsString() : null;
        if (id == null || id.isBlank()) {
            ctx.status(HttpStatus.BAD_REQUEST);
            ctx.json(Map.of("error", "id is required"));
            return;
        }
        if (!connectionService.setActive(id)) {
            ctx.status(HttpStatus.BAD_REQUEST);
            ctx.json(Map.of("error", "Connection is not open: " + id));
            return;
        }
        ctx.json(Map.of("ok", true, "activeId", id));
    }

    private void connect(Context ctx) {
        ConnectionProfile profile = gson.fromJson(ctx.body(), ConnectionProfile.class);
        if (profile.getDbType() == null) {
            profile.setDbType(DbType.MYSQL);
        }
        if (profile.getConnectionMode() == null) {
            profile.setConnectionMode(ConnectionMode.TWO_LAYER);
        }
        try {
            connectionService.connect(profile);
            upsertProfile(profile);
            connectionStore.save(profiles);
            ctx.json(Map.of(
                    "ok", true,
                    "message", "Connected to " + profile,
                    "id", profile.getId(),
                    "activeId", connectionService.getActiveId()
            ));
        } catch (Exception e) {
            ctx.status(HttpStatus.BAD_REQUEST);
            ctx.json(Map.of("error", e.getMessage() == null ? "Connection failed" : e.getMessage()));
        }
    }

    private void connectById(Context ctx) {
        String id = ctx.pathParam("id");
        ConnectionProfile stored = profiles.stream()
                .filter(p -> id.equals(p.getId()))
                .findFirst()
                .orElse(null);
        if (stored == null) {
            ctx.status(HttpStatus.NOT_FOUND);
            ctx.json(Map.of("error", "Saved connection not found"));
            return;
        }
        // Already connected — just activate, no re-auth.
        if (connectionService.isConnected(id)) {
            connectionService.setActive(id);
            ctx.json(Map.of(
                    "ok", true,
                    "message", "Using existing connection",
                    "id", id,
                    "activeId", id,
                    "reused", true
            ));
            return;
        }
        ConnectionProfile profile = stored.copy();
        JsonObject body = gson.fromJson(ctx.body().isBlank() ? "{}" : ctx.body(), JsonObject.class);
        if (body != null) {
            if (body.has("username") && !body.get("username").isJsonNull()) {
                profile.setUsername(body.get("username").getAsString());
            }
            if (body.has("password") && !body.get("password").isJsonNull()) {
                String pw = body.get("password").getAsString();
                if (pw != null && !pw.isBlank()) {
                    profile.setPassword(pw);
                }
            }
            if (body.has("savePassword")) {
                profile.setSavePassword(body.get("savePassword").getAsBoolean());
            }
            if (body.has("sshUsername") && !body.get("sshUsername").isJsonNull()) {
                profile.setSshUsername(body.get("sshUsername").getAsString());
            }
            if (body.has("sshPassword") && !body.get("sshPassword").isJsonNull()) {
                String sshPw = body.get("sshPassword").getAsString();
                if (sshPw != null && !sshPw.isBlank()) {
                    profile.setSshPassword(sshPw);
                }
            }
            if (body.has("saveSshPassword")) {
                profile.setSaveSshPassword(body.get("saveSshPassword").getAsBoolean());
            }
        }
        try {
            connectionService.connect(profile);
            upsertProfile(profile);
            connectionStore.save(profiles);
            ctx.json(Map.of(
                    "ok", true,
                    "message", "Connected to " + profile,
                    "id", profile.getId(),
                    "activeId", connectionService.getActiveId()
            ));
        } catch (Exception e) {
            ctx.status(HttpStatus.BAD_REQUEST);
            ctx.json(Map.of("error", e.getMessage() == null ? "Connection failed" : e.getMessage()));
        }
    }

    private void disconnect(Context ctx) {
        JsonObject body = gson.fromJson(ctx.body().isBlank() ? "{}" : ctx.body(), JsonObject.class);
        if (body != null && body.has("id") && !body.get("id").isJsonNull()) {
            connectionService.disconnect(body.get("id").getAsString());
        } else if (body != null && body.has("all") && body.get("all").getAsBoolean()) {
            connectionService.disconnectAll();
        } else {
            connectionService.disconnect();
        }
        ctx.json(Map.of(
                "ok", true,
                "activeId", connectionService.getActiveId() == null ? "" : connectionService.getActiveId(),
                "connected", connectionService.isConnected()
        ));
    }

    private void disconnectById(Context ctx) {
        connectionService.disconnect(ctx.pathParam("id"));
        ctx.json(Map.of(
                "ok", true,
                "activeId", connectionService.getActiveId() == null ? "" : connectionService.getActiveId(),
                "connected", connectionService.isConnected()
        ));
    }

    private void saveProfile(Context ctx) {
        ConnectionProfile incoming = gson.fromJson(ctx.body(), ConnectionProfile.class);
        if (incoming.getId() == null || incoming.getId().isBlank()) {
            incoming.setId(java.util.UUID.randomUUID().toString());
        }
        if (incoming.getConnectionMode() == null) {
            incoming.setConnectionMode(ConnectionMode.TWO_LAYER);
        }
        ConnectionProfile existing = profiles.stream()
                .filter(p -> incoming.getId().equals(p.getId()))
                .findFirst()
                .orElse(null);
        if (existing != null) {
            if (incoming.getPassword() == null || incoming.getPassword().isBlank()) {
                // Keep stored password when the edit form leaves password empty
                incoming.setPassword(existing.getPassword());
            }
            if (incoming.getSshPassword() == null || incoming.getSshPassword().isBlank()) {
                incoming.setSshPassword(existing.getSshPassword());
            }
            if (incoming.getSshPassphrase() == null || incoming.getSshPassphrase().isBlank()) {
                incoming.setSshPassphrase(existing.getSshPassphrase());
            }
        }
        upsertProfile(incoming);
        connectionStore.save(profiles);
        ctx.json(Map.of("ok", true, "id", incoming.getId()));
    }

    private void deleteProfile(Context ctx) {
        String id = ctx.pathParam("id");
        profiles.removeIf(p -> id.equals(p.getId()));
        connectionStore.save(profiles);
        ctx.json(Map.of("ok", true));
    }

    private void profileProperties(Context ctx) {
        String id = ctx.pathParam("id");
        ConnectionProfile profile = profiles.stream()
                .filter(p -> id.equals(p.getId()))
                .findFirst()
                .orElse(null);
        if (profile == null) {
            ctx.status(HttpStatus.NOT_FOUND);
            ctx.json(Map.of("error", "Saved connection not found"));
            return;
        }

        Map<String, Object> props = new LinkedHashMap<>();
        props.put("kind", "Connection");
        props.put("name", nullToEmpty(profile.getName()).isBlank() ? "Untitled" : profile.getName());
        props.put("engine", profile.getDbType() == null ? "" : profile.getDbType().getDisplayName());
        props.put("status", connectionService.isConnected(id) ? "Connected" : "Disconnected");
        props.put("connectionModeLabel",
                profile.getConnectionMode() == null ? "" : profile.getConnectionMode().getDisplayName());
        boolean fileBased = profile.getDbType() != null && profile.getDbType().isFileBased();
        if (fileBased) {
            props.put("filePath", nullToEmpty(profile.getDatabase()));
        } else {
            props.put("host", nullToEmpty(profile.getHost()));
            props.put("port", profile.getPort());
            props.put("database", nullToEmpty(profile.getDatabase()));
            props.put("username", nullToEmpty(profile.getUsername()));
        }
        if (profile.usesSshTunnel()) {
            props.put("sshHost", nullToEmpty(profile.getSshHost()));
            props.put("sshPort", profile.getSshPort());
            props.put("sshUsername", nullToEmpty(profile.getSshUsername()));
            if (profile.getSshPrivateKeyPath() != null && !profile.getSshPrivateKeyPath().isBlank()) {
                props.put("sshPrivateKeyPath", profile.getSshPrivateKeyPath());
            }
        }

        if (connectionService.isConnected(id)) {
            connectionService.bindRequestSession(id);
            try {
                java.sql.Connection conn = connectionService.getConnection();
                java.sql.DatabaseMetaData meta = conn.getMetaData();
                props.put("serverProduct", meta.getDatabaseProductName());
                props.put("serverVersion", meta.getDatabaseProductVersion());
                props.put("driverName", meta.getDriverName());
                props.put("driverVersion", meta.getDriverVersion());
                props.put("url", meta.getURL());
                try {
                    props.put("userName", meta.getUserName());
                } catch (Exception ignored) {
                }
                props.put("sshTunnel", connectionService.isSshTunnelActive());
            } catch (Exception e) {
                props.put("liveError", e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                connectionService.clearRequestSession();
            }
        }

        ctx.json(props);
    }

    private void databases(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.listDatabases());
    }

    private void explorer(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.getExplorerTree());
    }

    private void details(Context ctx) throws Exception {
        requireConnected(ctx);
        String scope = ctx.queryParam("scope");
        if (scope == null || scope.isBlank()) {
            scope = "connection";
        }
        String schema = ctx.queryParam("schema");
        String table = ctx.queryParam("table");
        ctx.json(databaseService.getDetails(scope, schema, table));
    }

    private void databaseProperties(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.getDatabaseProperties(ctx.pathParam("schema")));
    }

    private void tables(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.listTables(ctx.pathParam("schema")));
    }

    private void views(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.listViews(ctx.pathParam("schema")));
    }

    private void procedures(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.listProcedures(ctx.pathParam("schema")));
    }

    private void functions(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.listFunctions(ctx.pathParam("schema")));
    }

    private void columns(Context ctx) throws Exception {
        requireConnected(ctx);
        String schema = ctx.pathParam("schema");
        String table = ctx.pathParam("table");
        List<ColumnInfo> cols = databaseService.getColumns(schema, table);
        List<Map<String, Object>> out = new ArrayList<>();
        for (ColumnInfo c : cols) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", c.getName());
            m.put("type", c.getDisplayType());
            m.put("nullable", c.isNullable());
            m.put("primaryKey", c.isPrimaryKey());
            m.put("autoIncrement", c.isAutoIncrement());
            m.put("defaultValue", c.getDefaultValue());
            out.add(m);
        }
        ctx.json(out);
    }

    private void ddl(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(Map.of("ddl", databaseService.getCreateStatement(
                ctx.pathParam("schema"), ctx.pathParam("table"))));
    }

    private void previewRows(Context ctx) throws Exception {
        requireConnected(ctx);
        String schema = ctx.pathParam("schema");
        String table = ctx.pathParam("table");
        int limit = ctx.queryParamAsClass("limit", Integer.class).getOrDefault(500);
        try {
            connectionService.useDatabase(schema);
        } catch (Exception ignored) {
        }
        QueryResult result = databaseService.previewTable(schema, table, limit);
        ctx.json(toResultJson(result));
    }

    private void query(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String sql = body.get("sql").getAsString();
        QueryResult result = databaseService.executeScript(sql);
        ctx.json(toResultJson(result));
    }

    private void insertRow(Context ctx) throws Exception {
        requireConnected(ctx);
        Type type = new TypeToken<Map<String, Object>>() {}.getType();
        Map<String, Object> values = gson.fromJson(ctx.body(), type);
        int n = databaseService.insertRow(ctx.pathParam("schema"), ctx.pathParam("table"), values);
        ctx.json(Map.of("ok", true, "affected", n));
    }

    private void updateRow(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        Type type = new TypeToken<Map<String, Object>>() {}.getType();
        Map<String, Object> pk = gson.fromJson(body.get("pk"), type);
        Map<String, Object> values = gson.fromJson(body.get("values"), type);
        int n = databaseService.updateRow(ctx.pathParam("schema"), ctx.pathParam("table"), pk, values);
        ctx.json(Map.of("ok", true, "affected", n));
    }

    private void deleteRow(Context ctx) throws Exception {
        requireConnected(ctx);
        Type type = new TypeToken<Map<String, Object>>() {}.getType();
        Map<String, Object> pk = gson.fromJson(ctx.body(), type);
        int n = databaseService.deleteRow(ctx.pathParam("schema"), ctx.pathParam("table"), pk);
        ctx.json(Map.of("ok", true, "affected", n));
    }

    private void createDatabase(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String name = body.get("name").getAsString();
        String charset = body.has("charset") && !body.get("charset").isJsonNull()
                ? body.get("charset").getAsString() : null;
        String collation = body.has("collation") && !body.get("collation").isJsonNull()
                ? body.get("collation").getAsString() : null;
        databaseService.createDatabase(name, charset, collation);
        ctx.json(Map.of("ok", true));
    }

    private void alterDatabase(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body().isBlank() ? "{}" : ctx.body(), JsonObject.class);
        String newName = body.has("newName") && !body.get("newName").isJsonNull()
                ? body.get("newName").getAsString() : null;
        String charset = body.has("charset") && !body.get("charset").isJsonNull()
                ? body.get("charset").getAsString() : null;
        String collation = body.has("collation") && !body.get("collation").isJsonNull()
                ? body.get("collation").getAsString() : null;
        databaseService.alterDatabase(ctx.pathParam("name"), newName, charset, collation);
        ctx.json(Map.of("ok", true));
    }

    private void dropDatabase(Context ctx) throws Exception {
        requireConnected(ctx);
        databaseService.dropDatabase(ctx.pathParam("name"));
        ctx.json(Map.of("ok", true));
    }

    private void createSchema(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        databaseService.createSchema(body.get("name").getAsString());
        ctx.json(Map.of("ok", true));
    }

    private void dropSchema(Context ctx) throws Exception {
        requireConnected(ctx);
        databaseService.dropSchema(ctx.pathParam("name"));
        ctx.json(Map.of("ok", true));
    }

    private void cloneDatabase(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body().isBlank() ? "{}" : ctx.body(), JsonObject.class);
        String target = body.get("targetName").getAsString();
        boolean includeData = !body.has("includeData") || body.get("includeData").getAsBoolean();
        boolean includeViews = !body.has("includeViews") || body.get("includeViews").getAsBoolean();
        boolean includeIndexes = !body.has("includeIndexes") || body.get("includeIndexes").getAsBoolean();
        ctx.json(cloneMigrateService.cloneDatabase(
                ctx.pathParam("name"), target, includeData, includeViews, includeIndexes));
    }

    private void migrateDatabase(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String source = body.get("source").getAsString();
        String target = body.get("target").getAsString();
        boolean includeData = !body.has("includeData") || body.get("includeData").getAsBoolean();
        ctx.json(cloneMigrateService.migrateWithinServer(source, target, includeData));
    }

    private void createTable(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String name = body.get("name").getAsString();
        Type colType = new TypeToken<List<Map<String, Object>>>() {}.getType();
        List<Map<String, Object>> cols = gson.fromJson(body.get("columns"), colType);
        List<ColumnDefinition> defs = new ArrayList<>();
        for (Map<String, Object> c : cols) {
            defs.add(new ColumnDefinition(
                    String.valueOf(c.get("name")),
                    String.valueOf(c.getOrDefault("sqlType", "VARCHAR(255)")),
                    c.get("nullable") == null || Boolean.TRUE.equals(c.get("nullable")),
                    Boolean.TRUE.equals(c.get("primaryKey")),
                    Boolean.TRUE.equals(c.get("autoIncrement"))
            ));
        }
        databaseService.createTable(ctx.pathParam("schema"), name, defs);
        ctx.json(Map.of("ok", true));
    }

    private void dropTable(Context ctx) throws Exception {
        requireConnected(ctx);
        databaseService.dropTable(ctx.pathParam("schema"), ctx.pathParam("table"));
        ctx.json(Map.of("ok", true));
    }

    private void renameTable(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        databaseService.renameTable(ctx.pathParam("schema"), ctx.pathParam("table"),
                body.get("newName").getAsString());
        ctx.json(Map.of("ok", true));
    }

    private void addColumn(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        ColumnDefinition def = new ColumnDefinition(
                body.get("name").getAsString(),
                body.has("sqlType") ? body.get("sqlType").getAsString() : "VARCHAR(255)",
                !body.has("nullable") || body.get("nullable").getAsBoolean(),
                body.has("primaryKey") && body.get("primaryKey").getAsBoolean(),
                body.has("autoIncrement") && body.get("autoIncrement").getAsBoolean()
        );
        databaseService.addColumn(ctx.pathParam("schema"), ctx.pathParam("table"), def);
        ctx.json(Map.of("ok", true));
    }

    private void dropColumn(Context ctx) throws Exception {
        requireConnected(ctx);
        databaseService.dropColumn(ctx.pathParam("schema"), ctx.pathParam("table"), ctx.pathParam("column"));
        ctx.json(Map.of("ok", true));
    }

    private void createView(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        boolean replace = body.has("replace") && body.get("replace").getAsBoolean();
        databaseService.createView(
                ctx.pathParam("schema"),
                body.get("name").getAsString(),
                body.get("selectSql").getAsString(),
                replace
        );
        ctx.json(Map.of("ok", true));
    }

    private void dropView(Context ctx) throws Exception {
        requireConnected(ctx);
        databaseService.dropView(ctx.pathParam("schema"), ctx.pathParam("view"));
        ctx.json(Map.of("ok", true));
    }

    private void listIndexes(Context ctx) throws Exception {
        requireConnected(ctx);
        ctx.json(databaseService.listIndexes(ctx.pathParam("schema"), ctx.pathParam("table")));
    }

    private void createIndex(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        Type listType = new TypeToken<List<String>>() {}.getType();
        List<String> columns = gson.fromJson(body.get("columns"), listType);
        boolean unique = body.has("unique") && body.get("unique").getAsBoolean();
        String name = body.has("name") && !body.get("name").isJsonNull()
                ? body.get("name").getAsString() : null;
        databaseService.createIndex(ctx.pathParam("schema"), ctx.pathParam("table"), name, columns, unique);
        ctx.json(Map.of("ok", true));
    }

    private void dropIndex(Context ctx) throws Exception {
        requireConnected(ctx);
        databaseService.dropIndex(ctx.pathParam("schema"), ctx.pathParam("table"), ctx.pathParam("name"));
        ctx.json(Map.of("ok", true));
    }

    private void exportTable(Context ctx) throws Exception {
        requireConnected(ctx);
        String format = ctx.queryParam("format") == null ? "csv" : ctx.queryParam("format");
        int limit = ctx.queryParam("limit") == null ? 100_000 : Integer.parseInt(ctx.queryParam("limit"));
        var payload = importExportService.exportTable(
                ctx.pathParam("schema"), ctx.pathParam("table"), format, limit);
        ctx.json(Map.of(
                "filename", payload.filename(),
                "contentType", payload.contentType(),
                "content", payload.content(),
                "base64", payload.base64()
        ));
    }

    private void exportDatabase(Context ctx) throws Exception {
        requireConnected(ctx);
        boolean includeData = !"false".equalsIgnoreCase(ctx.queryParam("includeData"));
        int limit = ctx.queryParam("limit") == null ? 100_000 : Integer.parseInt(ctx.queryParam("limit"));
        var payload = importExportService.exportDatabaseSql(ctx.pathParam("schema"), includeData, limit);
        ctx.json(Map.of(
                "filename", payload.filename(),
                "contentType", payload.contentType(),
                "content", payload.content(),
                "base64", payload.base64()
        ));
    }

    private void importTable(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String format = body.has("format") ? body.get("format").getAsString() : "csv";
        String content = body.has("content") ? body.get("content").getAsString() : "";
        boolean base64 = body.has("base64") && body.get("base64").getAsBoolean();
        boolean truncate = body.has("truncate") && body.get("truncate").getAsBoolean();
        boolean headerRow = !body.has("headerRow") || body.get("headerRow").getAsBoolean();
        ctx.json(importExportService.importIntoTable(
                ctx.pathParam("schema"),
                ctx.pathParam("table"),
                format,
                content,
                base64,
                truncate,
                headerRow
        ));
    }

    private void importSql(Context ctx) throws Exception {
        requireConnected(ctx);
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String sql = body.has("sql") ? body.get("sql").getAsString() : body.has("content")
                ? body.get("content").getAsString() : "";
        ctx.json(importExportService.importSqlScript(sql));
    }

    private Map<String, Object> toResultJson(QueryResult result) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("update", result.isUpdate());
        out.put("message", result.getMessage());
        out.put("affectedRows", result.getAffectedRows());
        out.put("executionMs", result.getExecutionMs());
        out.put("columns", result.getColumnNames());
        out.put("columnTypes", result.getColumnTypes());
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> row : result.getRows()) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : row.entrySet()) {
                Object v = e.getValue();
                copy.put(e.getKey(), v == null ? null : String.valueOf(v));
            }
            rows.add(copy);
        }
        out.put("rows", rows);
        return out;
    }

    private void requireConnected() {
        requireConnected(null);
    }

    private void requireConnected(Context ctx) {
        String connectionId = null;
        if (ctx != null) {
            connectionId = ctx.queryParam("connectionId");
            if (connectionId == null || connectionId.isBlank()) {
                connectionId = ctx.header("X-Connection-Id");
            }
        }
        if (connectionId != null && !connectionId.isBlank()) {
            // Bind this request only — do not flip global activeId (avoids race when
            // multiple connection trees load in parallel).
            if (!connectionService.isConnected(connectionId)) {
                throw new IllegalStateException("Connection is not open: " + connectionId);
            }
            connectionService.bindRequestSession(connectionId);
            return;
        }
        if (!connectionService.isConnected()) {
            throw new IllegalStateException("Not connected to a database");
        }
    }

    private void upsertProfile(ConnectionProfile profile) {
        for (int i = 0; i < profiles.size(); i++) {
            if (profiles.get(i).getId().equals(profile.getId())) {
                profiles.set(i, profile);
                return;
            }
        }
        profiles.add(profile);
    }

    private List<Map<String, Object>> sanitizeProfiles(List<ConnectionProfile> list) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ConnectionProfile p : list) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", p.getId());
            m.put("name", p.getName());
            m.put("dbType", p.getDbType() == null ? "MYSQL" : p.getDbType().name());
            m.put("displayType", p.getDbType() == null ? "MySQL" : p.getDbType().getDisplayName());
            m.put("connectionMode", p.getConnectionMode().name());
            m.put("connectionModeLabel",
                    p.getConnectionMode().getDisplayName() + " · " + p.getConnectionMode().getDescription());
            m.put("host", p.getHost());
            m.put("port", p.getPort());
            m.put("database", p.getDatabase());
            m.put("username", p.getUsername());
            m.put("savePassword", p.isSavePassword());
            m.put("hasPassword", p.getPassword() != null && !p.getPassword().isBlank());
            m.put("fileBased", p.getDbType() != null && p.getDbType().isFileBased());
            m.put("useSshTunnel", p.isUseSshTunnel());
            m.put("sshHost", p.getSshHost());
            m.put("sshPort", p.getSshPort());
            m.put("sshUsername", p.getSshUsername());
            m.put("sshPrivateKeyPath", p.getSshPrivateKeyPath());
            m.put("saveSshPassword", p.isSaveSshPassword());
            m.put("hasSshPassword", p.getSshPassword() != null && !p.getSshPassword().isBlank());
            m.put("hasSshPassphrase", p.getSshPassphrase() != null && !p.getSshPassphrase().isBlank());
            // Never send passwords to the browser list
            out.add(m);
        }
        return out;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
