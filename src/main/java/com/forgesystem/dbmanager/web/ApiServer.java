package com.forgesystem.dbmanager.web;

import com.forgesystem.dbmanager.model.ColumnInfo;
import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.DbType;
import com.forgesystem.dbmanager.model.QueryResult;
import com.forgesystem.dbmanager.service.ConnectionService;
import com.forgesystem.dbmanager.service.ConnectionStore;
import com.forgesystem.dbmanager.service.DatabaseService;
import com.forgesystem.dbmanager.service.DatabaseService.ColumnDefinition;
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
            ctx.status(HttpStatus.BAD_REQUEST);
            ctx.json(Map.of("error", e.getMessage() == null ? e.toString() : e.getMessage()));
        });

        // Health
        app.get("/api/health", ctx -> ctx.json(Map.of("ok", true, "app", "Forge Database Manager")));

        // Connection profiles
        app.get("/api/profiles", ctx -> ctx.json(sanitizeProfiles(profiles)));
        app.post("/api/profiles", this::saveProfile);
        app.delete("/api/profiles/{id}", this::deleteProfile);

        // Session
        app.get("/api/session", this::session);
        app.post("/api/connect", this::connect);
        app.post("/api/connect/{id}", this::connectById);
        app.post("/api/disconnect", this::disconnect);

        // Metadata
        app.get("/api/databases", this::databases);
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
        app.post("/api/databases", this::createDatabase);
        app.delete("/api/databases/{name}", this::dropDatabase);
        app.post("/api/databases/{schema}/tables", this::createTable);
        app.delete("/api/databases/{schema}/tables/{table}", this::dropTable);

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
        if (connectionService.isConnected() && connectionService.getProfile() != null) {
            ConnectionProfile p = connectionService.getProfile();
            out.put("profile", Map.of(
                    "id", p.getId(),
                    "name", nullToEmpty(p.getName()),
                    "dbType", p.getDbType().name(),
                    "displayType", p.getDbType().getDisplayName(),
                    "host", nullToEmpty(p.getHost()),
                    "database", nullToEmpty(p.getDatabase()),
                    "username", nullToEmpty(p.getUsername())
            ));
        }
        ctx.json(out);
    }

    private void connect(Context ctx) {
        ConnectionProfile profile = gson.fromJson(ctx.body(), ConnectionProfile.class);
        if (profile.getDbType() == null) {
            profile.setDbType(DbType.MYSQL);
        }
        try {
            connectionService.connect(profile);
            upsertProfile(profile);
            connectionStore.save(profiles);
            ctx.json(Map.of("ok", true, "message", "Connected to " + profile));
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
        ConnectionProfile profile = stored.copy();
        JsonObject body = gson.fromJson(ctx.body().isBlank() ? "{}" : ctx.body(), JsonObject.class);
        if (body != null) {
            if (body.has("username") && !body.get("username").isJsonNull()) {
                profile.setUsername(body.get("username").getAsString());
            }
            if (body.has("password") && !body.get("password").isJsonNull()) {
                profile.setPassword(body.get("password").getAsString());
            }
            if (body.has("savePassword")) {
                profile.setSavePassword(body.get("savePassword").getAsBoolean());
            }
        }
        try {
            connectionService.connect(profile);
            upsertProfile(profile);
            connectionStore.save(profiles);
            ctx.json(Map.of("ok", true, "message", "Connected to " + profile));
        } catch (Exception e) {
            ctx.status(HttpStatus.BAD_REQUEST);
            ctx.json(Map.of("error", e.getMessage() == null ? "Connection failed" : e.getMessage()));
        }
    }

    private void disconnect(Context ctx) {
        connectionService.disconnect();
        ctx.json(Map.of("ok", true));
    }

    private void saveProfile(Context ctx) {
        ConnectionProfile incoming = gson.fromJson(ctx.body(), ConnectionProfile.class);
        if (incoming.getId() == null || incoming.getId().isBlank()) {
            incoming.setId(java.util.UUID.randomUUID().toString());
        }
        ConnectionProfile existing = profiles.stream()
                .filter(p -> incoming.getId().equals(p.getId()))
                .findFirst()
                .orElse(null);
        if (existing != null && (incoming.getPassword() == null || incoming.getPassword().isBlank())) {
            // Keep stored password when the edit form leaves password empty
            incoming.setPassword(existing.getPassword());
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

    private void databases(Context ctx) throws Exception {
        requireConnected();
        ctx.json(databaseService.listDatabases());
    }

    private void tables(Context ctx) throws Exception {
        requireConnected();
        ctx.json(databaseService.listTables(ctx.pathParam("schema")));
    }

    private void views(Context ctx) throws Exception {
        requireConnected();
        ctx.json(databaseService.listViews(ctx.pathParam("schema")));
    }

    private void procedures(Context ctx) throws Exception {
        requireConnected();
        ctx.json(databaseService.listProcedures(ctx.pathParam("schema")));
    }

    private void functions(Context ctx) throws Exception {
        requireConnected();
        ctx.json(databaseService.listFunctions(ctx.pathParam("schema")));
    }

    private void columns(Context ctx) throws Exception {
        requireConnected();
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
        requireConnected();
        ctx.json(Map.of("ddl", databaseService.getCreateStatement(
                ctx.pathParam("schema"), ctx.pathParam("table"))));
    }

    private void previewRows(Context ctx) throws Exception {
        requireConnected();
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
        requireConnected();
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String sql = body.get("sql").getAsString();
        QueryResult result = databaseService.executeScript(sql);
        ctx.json(toResultJson(result));
    }

    private void insertRow(Context ctx) throws Exception {
        requireConnected();
        Type type = new TypeToken<Map<String, Object>>() {}.getType();
        Map<String, Object> values = gson.fromJson(ctx.body(), type);
        int n = databaseService.insertRow(ctx.pathParam("schema"), ctx.pathParam("table"), values);
        ctx.json(Map.of("ok", true, "affected", n));
    }

    private void updateRow(Context ctx) throws Exception {
        requireConnected();
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        Type type = new TypeToken<Map<String, Object>>() {}.getType();
        Map<String, Object> pk = gson.fromJson(body.get("pk"), type);
        Map<String, Object> values = gson.fromJson(body.get("values"), type);
        int n = databaseService.updateRow(ctx.pathParam("schema"), ctx.pathParam("table"), pk, values);
        ctx.json(Map.of("ok", true, "affected", n));
    }

    private void deleteRow(Context ctx) throws Exception {
        requireConnected();
        Type type = new TypeToken<Map<String, Object>>() {}.getType();
        Map<String, Object> pk = gson.fromJson(ctx.body(), type);
        int n = databaseService.deleteRow(ctx.pathParam("schema"), ctx.pathParam("table"), pk);
        ctx.json(Map.of("ok", true, "affected", n));
    }

    private void createDatabase(Context ctx) throws Exception {
        requireConnected();
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        databaseService.createDatabase(body.get("name").getAsString());
        ctx.json(Map.of("ok", true));
    }

    private void dropDatabase(Context ctx) throws Exception {
        requireConnected();
        databaseService.dropDatabase(ctx.pathParam("name"));
        ctx.json(Map.of("ok", true));
    }

    private void createTable(Context ctx) throws Exception {
        requireConnected();
        JsonObject body = gson.fromJson(ctx.body(), JsonObject.class);
        String name = body.get("name").getAsString();
        Type colType = new TypeToken<List<Map<String, Object>>>() {}.getType();
        List<Map<String, Object>> cols = gson.fromJson(body.get("columns"), colType);
        List<ColumnDefinition> defs = new ArrayList<>();
        for (Map<String, Object> c : cols) {
            defs.add(new ColumnDefinition(
                    String.valueOf(c.get("name")),
                    String.valueOf(c.getOrDefault("sqlType", "VARCHAR(255)")),
                    Boolean.TRUE.equals(c.get("nullable")),
                    Boolean.TRUE.equals(c.get("primaryKey")),
                    Boolean.TRUE.equals(c.get("autoIncrement"))
            ));
        }
        databaseService.createTable(ctx.pathParam("schema"), name, defs);
        ctx.json(Map.of("ok", true));
    }

    private void dropTable(Context ctx) throws Exception {
        requireConnected();
        databaseService.dropTable(ctx.pathParam("schema"), ctx.pathParam("table"));
        ctx.json(Map.of("ok", true));
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
            m.put("host", p.getHost());
            m.put("port", p.getPort());
            m.put("database", p.getDatabase());
            m.put("username", p.getUsername());
            m.put("savePassword", p.isSavePassword());
            m.put("hasPassword", p.getPassword() != null && !p.getPassword().isBlank());
            // Never send password to the browser list
            out.add(m);
        }
        return out;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
