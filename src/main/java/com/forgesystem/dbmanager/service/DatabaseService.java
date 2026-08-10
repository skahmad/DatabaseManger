package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ColumnInfo;
import com.forgesystem.dbmanager.model.ConnectionMode;
import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.DbType;
import com.forgesystem.dbmanager.model.QueryResult;
import com.forgesystem.dbmanager.util.SqlUtils;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

public class DatabaseService {
    private final ConnectionService connectionService;

    public DatabaseService(ConnectionService connectionService) {
        this.connectionService = connectionService;
    }

    public List<String> listDatabases() throws SQLException {
        Connection conn = connectionService.getConnection();
        DbType type = connectionService.getProfile().getDbType();
        List<String> dbs = new ArrayList<>();

        switch (type) {
            case MYSQL, MARIADB -> {
                try (ResultSet rs = conn.createStatement().executeQuery("SHOW DATABASES")) {
                    while (rs.next()) {
                        dbs.add(rs.getString(1));
                    }
                }
            }
            case POSTGRESQL -> {
                // Real PostgreSQL databases on the server (not schemas).
                try (ResultSet rs = conn.createStatement().executeQuery(
                        "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1")) {
                    while (rs.next()) {
                        dbs.add(rs.getString(1));
                    }
                }
            }
            case SQLSERVER -> {
                try (ResultSet rs = conn.createStatement().executeQuery(
                        "SELECT name FROM sys.databases ORDER BY name")) {
                    while (rs.next()) {
                        dbs.add(rs.getString(1));
                    }
                }
            }
            case H2, H2_FILE -> dbs.addAll(listSchemas());
            case SQLITE -> {
                String db = connectionService.getProfile().getDatabase();
                dbs.add(sqliteDisplayName(db));
            }
        }
        return dbs;
    }

    /**
     * List schemas, optionally after switching to {@code database} (PostgreSQL catalog).
     * Restores the previous catalog afterward when a database override was applied.
     */
    public List<String> listSchemas(String database) throws SQLException {
        Connection conn = connectionService.getConnection();
        DbType type = connectionService.getProfile().getDbType();
        String previousCatalog = null;
        boolean switched = false;
        if (database != null && !database.isBlank()
                && (type == DbType.POSTGRESQL || type == DbType.SQLSERVER)) {
            try {
                previousCatalog = conn.getCatalog();
            } catch (SQLException ignored) {
            }
            if (previousCatalog == null || !database.equals(previousCatalog)) {
                conn.setCatalog(database);
                switched = true;
            }
        }
        try {
            return listSchemas();
        } finally {
            if (switched && previousCatalog != null && !previousCatalog.isBlank()) {
                try {
                    conn.setCatalog(previousCatalog);
                } catch (SQLException ignored) {
                }
            }
        }
    }

    public List<String> listSchemas() throws SQLException {
        Connection conn = connectionService.getConnection();
        DbType type = connectionService.getProfile().getDbType();
        List<String> schemas = new ArrayList<>();
        switch (type) {
            case POSTGRESQL -> {
                try (ResultSet rs = conn.createStatement().executeQuery(
                        "SELECT nspname FROM pg_namespace " +
                                "WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' " +
                                "AND nspname <> 'information_schema' " +
                                "ORDER BY 1")) {
                    while (rs.next()) {
                        schemas.add(rs.getString(1));
                    }
                }
                if (schemas.isEmpty()) {
                    schemas.add("public");
                }
            }
            case H2, H2_FILE -> {
                DatabaseMetaData meta = conn.getMetaData();
                try (ResultSet rs = meta.getSchemas()) {
                    while (rs.next()) {
                        schemas.add(rs.getString("TABLE_SCHEM"));
                    }
                }
                if (schemas.isEmpty()) {
                    schemas.add("PUBLIC");
                }
            }
            case MYSQL, MARIADB -> schemas.addAll(listDatabases());
            case SQLSERVER -> {
                try (ResultSet rs = conn.createStatement().executeQuery(
                        "SELECT name FROM sys.schemas " +
                                "WHERE name NOT IN ('guest','INFORMATION_SCHEMA','sys') " +
                                "ORDER BY name")) {
                    while (rs.next()) {
                        schemas.add(rs.getString(1));
                    }
                } catch (SQLException e) {
                    schemas.add("dbo");
                }
                if (schemas.isEmpty()) {
                    schemas.add("dbo");
                }
            }
            case SQLITE -> schemas.add("main");
        }
        return schemas;
    }

    /**
     * Hierarchical explorer roots for the connected session.
     * <ul>
     *   <li>PostgreSQL / H2 — always 3-layer: database → schemas → tables</li>
     *   <li>SQLite — always 2-layer: database → tables</li>
     *   <li>MySQL — 2-layer: databases → tables (schema ≈ database)</li>
     *   <li>Others — follow {@link ConnectionMode}</li>
     * </ul>
     */
    public Map<String, Object> getExplorerTree() throws SQLException {
        Connection conn = connectionService.getConnection();
        ConnectionProfile profile = connectionService.getProfile();
        DbType type = profile.getDbType();
        ConnectionMode mode = effectiveHierarchy(profile);
        boolean threeLayer = mode == ConnectionMode.THREE_LAYER;

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("engine", type.name());
        out.put("displayEngine", type.getDisplayName());
        out.put("connectionMode", mode.name());
        out.put("hierarchy", threeLayer ? "database-schemas-tables" : "database-tables");

        String catalog = null;
        try {
            catalog = conn.getCatalog();
        } catch (SQLException ignored) {
        }
        if (catalog == null || catalog.isBlank()) {
            catalog = profile.getDatabase();
        }

        if (type == DbType.SQLITE) {
            String path = profile.getDatabase();
            if (path == null || path.isBlank()) {
                path = catalog;
            }
            String dbName = sqliteDisplayName(path);
            out.put("layout", "file-database");
            out.put("currentDatabase", dbName);
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("name", dbName);
            node.put("kind", "database");
            node.put("schema", "main");
            out.put("nodes", List.of(node));
            return out;
        }

        // PostgreSQL (and H2): always database → schemas → tables
        if (type == DbType.POSTGRESQL || type == DbType.H2 || type == DbType.H2_FILE
                || (threeLayer && type == DbType.SQLSERVER)) {
            String dbName = (catalog == null || catalog.isBlank()) ? "database" : catalog;
            out.put("layout", "database-schemas");
            out.put("currentDatabase", dbName);
            out.put("connectionMode", ConnectionMode.THREE_LAYER.name());
            out.put("hierarchy", "database-schemas-tables");
            List<Map<String, Object>> schemas = new ArrayList<>();
            for (String schema : listSchemas()) {
                Map<String, Object> node = new LinkedHashMap<>();
                node.put("name", schema);
                node.put("kind", "schema");
                node.put("schema", schema);
                schemas.add(node);
            }
            Map<String, Object> dbNode = new LinkedHashMap<>();
            dbNode.put("name", dbName);
            dbNode.put("kind", "database");
            dbNode.put("schema", dbName);
            dbNode.put("children", schemas);
            out.put("nodes", List.of(dbNode));
            return out;
        }

        // MySQL / SQL Server (2-layer): databases → tables
        out.put("layout", "server-databases");
        out.put("currentDatabase", catalog);
        List<Map<String, Object>> nodes = new ArrayList<>();
        for (String db : listDatabases()) {
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("name", db);
            node.put("kind", "database");
            node.put("schema", db);
            nodes.add(node);
        }
        out.put("nodes", nodes);
        return out;
    }

    /** Engine-enforced hierarchy (PostgreSQL is always 3-layer). */
    private static ConnectionMode effectiveHierarchy(ConnectionProfile profile) {
        DbType type = profile.getDbType();
        if (type == DbType.POSTGRESQL || type == DbType.H2 || type == DbType.H2_FILE) {
            return ConnectionMode.THREE_LAYER;
        }
        if (type == DbType.SQLITE || type.isMysqlFamily()) {
            return ConnectionMode.TWO_LAYER;
        }
        return profile.getConnectionMode();
    }

    /**
     * Contextual object counts for the Details tab.
     * scope: connection | database | schema | table
     */
    public Map<String, Object> getDetails(String scope, String schema, String table) throws SQLException {
        ConnectionProfile profile = connectionService.getProfile();
        DbType type = profile.getDbType();
        ConnectionMode mode = effectiveHierarchy(profile);
        String normalized = scope == null ? "connection" : scope.trim().toLowerCase();

        return switch (normalized) {
            case "table" -> tableDetails(schema, table);
            case "schema" -> schemaDetails(schema);
            case "database" -> databaseLevelDetails(schema);
            default -> connectionDetails(profile, type, mode);
        };
    }

    private Map<String, Object> connectionDetails(ConnectionProfile profile, DbType type, ConnectionMode mode)
            throws SQLException {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "connection");
        out.put("title", profile.getName() == null || profile.getName().isBlank()
                ? type.getDisplayName() : profile.getName());
        out.put("subtitle", type.getDisplayName() + " · " + mode.getDisplayName());
        out.put("engine", type.getDisplayName());
        out.put("hierarchy", mode.getDescription());

        List<Map<String, Object>> items = new ArrayList<>();
        if (type == DbType.SQLITE) {
            items.add(stat("Databases", 1));
            items.add(stat("Tables", safeSize(() -> listTables("main"))));
            items.add(stat("Views", safeSize(() -> listViews("main"))));
        } else if (mode == ConnectionMode.THREE_LAYER) {
            // Connection-level only: avoid scanning every schema (slow on remote servers).
            items.add(stat("Databases", safeSize(this::listDatabases)));
            items.add(stat("Schemas", safeSize(this::listSchemas)));
        } else {
            // MySQL / 2-layer: listing tables across every database is O(n) round-trips and
            // hangs the UI when there are many remote databases. Show DB count only;
            // open a database for per-object counts.
            items.add(stat("Databases", safeSize(this::listDatabases)));
        }
        out.put("items", items);
        return out;
    }

    private Map<String, Object> databaseLevelDetails(String databaseName) throws SQLException {
        ConnectionProfile profile = connectionService.getProfile();
        DbType type = profile.getDbType();
        ConnectionMode mode = effectiveHierarchy(profile);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "database");
        String name = databaseName == null || databaseName.isBlank()
                ? (profile.getDatabase() == null ? "database" : profile.getDatabase())
                : databaseName;
        out.put("title", type == DbType.SQLITE ? sqliteDisplayName(name) : name);
        out.put("subtitle", "Database");
        out.put("engine", type.getDisplayName());

        List<Map<String, Object>> items = new ArrayList<>();
        if (mode == ConnectionMode.THREE_LAYER
                && (type == DbType.POSTGRESQL || type == DbType.H2 || type == DbType.H2_FILE
                || type == DbType.SQLSERVER)) {
            List<String> schemas = listSchemas();
            items.add(stat("Schemas", schemas.size()));
            int tables = 0;
            int views = 0;
            int procs = 0;
            int funcs = 0;
            for (String schema : schemas) {
                tables += safeSize(() -> listTables(schema));
                views += safeSize(() -> listViews(schema));
                procs += safeSize(() -> listProcedures(schema));
                funcs += safeSize(() -> listFunctions(schema));
            }
            items.add(stat("Tables", tables));
            items.add(stat("Views", views));
            items.add(stat("Procedures", procs));
            items.add(stat("Functions", funcs));
        } else {
            // 2-layer database node behaves like a schema/catalog
            return schemaDetails(name);
        }
        out.put("items", items);
        return out;
    }

    private Map<String, Object> schemaDetails(String schema) throws SQLException {
        if (schema == null || schema.isBlank()) {
            throw new SQLException("Schema/database name is required");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "schema");
        out.put("title", schema);
        DbType type = connectionService.getProfile().getDbType();
        out.put("subtitle", switch (type) {
            case POSTGRESQL, H2, H2_FILE -> "Schema";
            default -> "Database";
        });
        out.put("engine", type.getDisplayName());
        List<Map<String, Object>> items = new ArrayList<>();
        items.add(stat("Tables", safeSize(() -> listTables(schema))));
        items.add(stat("Views", safeSize(() -> listViews(schema))));
        items.add(stat("Procedures", safeSize(() -> listProcedures(schema))));
        items.add(stat("Functions", safeSize(() -> listFunctions(schema))));
        out.put("items", items);
        return out;
    }

    private Map<String, Object> tableDetails(String schema, String table) throws SQLException {
        if (schema == null || schema.isBlank() || table == null || table.isBlank()) {
            throw new SQLException("Schema and table are required");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "table");
        out.put("title", table);
        out.put("subtitle", schema + " · table");
        out.put("engine", connectionService.getProfile().getDbType().getDisplayName());

        List<ColumnInfo> columns = getColumns(schema, table);
        List<Map<String, Object>> indexes = listIndexes(schema, table);
        int pkCols = 0;
        for (ColumnInfo c : columns) {
            if (c.isPrimaryKey()) {
                pkCols++;
            }
        }
        int fkCount = countForeignKeys(schema, table);
        int uniqueIndexes = 0;
        for (Map<String, Object> idx : indexes) {
            if (Boolean.TRUE.equals(idx.get("unique"))) {
                uniqueIndexes++;
            }
        }

        List<Map<String, Object>> items = new ArrayList<>();
        items.add(stat("Rows", countTableRows(schema, table)));
        items.add(stat("Columns", columns.size()));
        items.add(stat("Indexes", indexes.size()));
        items.add(stat("Primary key columns", pkCols));
        items.add(stat("Foreign keys", fkCount));
        items.add(stat("Unique indexes", uniqueIndexes));
        items.add(stat("Constraints", pkCols > 0 ? 1 + fkCount + uniqueIndexes : fkCount + uniqueIndexes));
        out.put("items", items);
        return out;
    }

    public long countTableRows(String schema, String table) {
        try {
            String sql = "SELECT COUNT(*) AS c FROM " + qualify(schema, table);
            QueryResult result = execute(sql);
            if (result.getRows() != null && !result.getRows().isEmpty()) {
                Object c = result.getRows().get(0).get("c");
                if (c == null) {
                    c = result.getRows().get(0).values().iterator().next();
                }
                return Long.parseLong(String.valueOf(c));
            }
        } catch (Exception ignored) {
        }
        return 0;
    }

    private int countForeignKeys(String schema, String table) throws SQLException {
        Connection conn = connectionService.getConnection();
        DatabaseMetaData meta = conn.getMetaData();
        String catalog = resolveCatalog(schema);
        String schemaPattern = resolveSchemaPattern(schema);
        Set<String> keys = new LinkedHashSet<>();
        try (ResultSet rs = meta.getImportedKeys(catalog, schemaPattern, table)) {
            while (rs.next()) {
                String fk = rs.getString("FK_NAME");
                if (fk == null || fk.isBlank()) {
                    fk = rs.getString("PKTABLE_NAME") + "." + rs.getString("FKCOLUMN_NAME");
                }
                keys.add(fk);
            }
        } catch (SQLException ignored) {
        }
        return keys.size();
    }

    private static Map<String, Object> stat(String label, long value) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("label", label);
        m.put("value", value);
        return m;
    }

    private static int safeSize(java.util.concurrent.Callable<List<?>> op) {
        try {
            List<?> list = op.call();
            return list == null ? 0 : list.size();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Returns display properties for a database (MySQL/SQL Server) or schema (PostgreSQL/H2).
     */
    public Map<String, Object> getDatabaseProperties(String name) throws SQLException {
        Connection conn = connectionService.getConnection();
        DbType type = connectionService.getProfile().getDbType();
        Map<String, Object> props = new LinkedHashMap<>();

        props.put("name", type == DbType.SQLITE ? sqliteDisplayName(name) : name);
        props.put("kind", switch (type) {
            case POSTGRESQL, H2, H2_FILE -> "Schema";
            case SQLITE -> "Database file";
            default -> "Database";
        });
        props.put("engine", type.getDisplayName());

        DatabaseMetaData meta = conn.getMetaData();
        props.put("serverProduct", meta.getDatabaseProductName());
        props.put("serverVersion", meta.getDatabaseProductVersion());
        props.put("driverName", meta.getDriverName());
        props.put("driverVersion", meta.getDriverVersion());
        props.put("url", meta.getURL());
        props.put("userName", meta.getUserName());

        try {
            props.put("tableCount", listTables(name).size());
        } catch (SQLException e) {
            props.put("tableCount", null);
        }
        try {
            props.put("viewCount", listViews(name).size());
        } catch (SQLException e) {
            props.put("viewCount", null);
        }
        try {
            props.put("procedureCount", listProcedures(name).size());
        } catch (SQLException e) {
            props.put("procedureCount", null);
        }
        try {
            props.put("functionCount", listFunctions(name).size());
        } catch (SQLException e) {
            props.put("functionCount", null);
        }

        switch (type) {
            case MYSQL, MARIADB -> fillMySqlDatabaseProperties(conn, name, props);
            case POSTGRESQL -> fillPostgresSchemaProperties(conn, name, props);
            case SQLSERVER -> fillSqlServerDatabaseProperties(conn, name, props);
            case SQLITE -> fillSqliteDatabaseProperties(conn, props);
            case H2, H2_FILE -> fillH2SchemaProperties(conn, name, props);
        }

        return props;
    }

    private void fillMySqlDatabaseProperties(Connection conn, String name, Map<String, Object> props)
            throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME " +
                        "FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?")) {
            ps.setString(1, name);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    props.put("charset", rs.getString(1));
                    props.put("collation", rs.getString(2));
                }
            }
        }
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb " +
                        "FROM information_schema.TABLES WHERE table_schema = ?")) {
            ps.setString(1, name);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    Object size = rs.getObject(1);
                    if (size != null) {
                        props.put("sizeMb", size);
                    }
                }
            }
        }
    }

    private void fillPostgresSchemaProperties(Connection conn, String name, Map<String, Object> props)
            throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner " +
                        "FROM pg_catalog.pg_namespace WHERE nspname = ?")) {
            ps.setString(1, name);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    props.put("owner", rs.getString(1));
                }
            }
        }
        props.put("catalog", conn.getCatalog());
    }

    private void fillSqlServerDatabaseProperties(Connection conn, String name, Map<String, Object> props)
            throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT collation_name, state_desc, recovery_model_desc, " +
                        "compatibility_level, create_date " +
                        "FROM sys.databases WHERE name = ?")) {
            ps.setString(1, name);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    props.put("collation", rs.getString("collation_name"));
                    props.put("state", rs.getString("state_desc"));
                    props.put("recoveryModel", rs.getString("recovery_model_desc"));
                    props.put("compatibilityLevel", rs.getObject("compatibility_level"));
                    props.put("created", String.valueOf(rs.getTimestamp("create_date")));
                }
            }
        }
    }

    private void fillSqliteDatabaseProperties(Connection conn, Map<String, Object> props)
            throws SQLException {
        String path = connectionService.getProfile().getDatabase();
        if (path != null && !path.isBlank()) {
            props.put("filePath", path);
        }
        try (ResultSet rs = conn.createStatement().executeQuery("PRAGMA page_count")) {
            if (rs.next()) {
                long pages = rs.getLong(1);
                props.put("pageCount", pages);
                try (ResultSet rs2 = conn.createStatement().executeQuery("PRAGMA page_size")) {
                    if (rs2.next()) {
                        long pageSize = rs2.getLong(1);
                        props.put("pageSize", pageSize);
                        props.put("sizeMb", Math.round((pages * pageSize) / 1024.0 / 1024.0 * 100.0) / 100.0);
                    }
                }
            }
        }
        try (ResultSet rs = conn.createStatement().executeQuery("PRAGMA encoding")) {
            if (rs.next()) {
                props.put("encoding", rs.getString(1));
            }
        }
    }

    private void fillH2SchemaProperties(Connection conn, String name, Map<String, Object> props)
            throws SQLException {
        props.put("catalog", conn.getCatalog());
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT IS_DEFAULT FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?")) {
            ps.setString(1, name);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    props.put("isDefault", rs.getObject(1));
                }
            }
        } catch (SQLException ignored) {
            // older H2 variants may differ
        }
    }

    public List<String> listTables(String schema) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        if (type.isMysqlFamily()) {
            return listMySqlObjects(schema, "BASE TABLE");
        }
        if (type == DbType.POSTGRESQL) {
            return listPostgresObjects(schema, "BASE TABLE");
        }
        if (type == DbType.SQLITE) {
            return listSqliteObjects("table");
        }
        return listObjects(schema, new String[]{"TABLE", "BASE TABLE", "SYSTEM TABLE"});
    }

    public List<String> listViews(String schema) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        if (type.isMysqlFamily()) {
            return listMySqlObjects(schema, "VIEW");
        }
        if (type == DbType.POSTGRESQL) {
            return listPostgresObjects(schema, "VIEW");
        }
        if (type == DbType.SQLITE) {
            return listSqliteObjects("view");
        }
        return listObjects(schema, new String[]{"VIEW"});
    }

    private List<String> listPostgresObjects(String schema, String tableType) throws SQLException {
        Connection conn = connectionService.getConnection();
        String schemaName = (schema == null || schema.isBlank()) ? "public" : schema;
        List<String> names = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT table_name FROM information_schema.tables " +
                        "WHERE table_schema = ? AND table_type = ? " +
                        "ORDER BY 1")) {
            ps.setString(1, schemaName);
            ps.setString(2, tableType);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    names.add(rs.getString(1));
                }
            }
        }
        return names;
    }

    private List<String> listMySqlObjects(String schema, String tableType) throws SQLException {
        Connection conn = connectionService.getConnection();
        List<String> names = new ArrayList<>();
        String sql = "SHOW FULL TABLES FROM `" + schema.replace("`", "``") + "`";
        try (ResultSet rs = conn.createStatement().executeQuery(sql)) {
            while (rs.next()) {
                String name = rs.getString(1);
                String type = rs.getString(2);
                if (tableType.equalsIgnoreCase(type)) {
                    names.add(name);
                }
            }
        }
        Collections.sort(names);
        return names;
    }

    private List<String> listSqliteObjects(String type) throws SQLException {
        Connection conn = connectionService.getConnection();
        List<String> names = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY 1")) {
            ps.setString(1, type);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    names.add(rs.getString(1));
                }
            }
        }
        return names;
    }

    private List<String> listObjects(String schema, String[] types) throws SQLException {
        Connection conn = connectionService.getConnection();
        DatabaseMetaData meta = conn.getMetaData();
        List<String> names = new ArrayList<>();
        String catalog = resolveCatalog(schema);
        String schemaPattern = resolveSchemaPattern(schema);

        // First try with requested types
        try (ResultSet rs = meta.getTables(catalog, schemaPattern, "%", types)) {
            while (rs.next()) {
                names.add(rs.getString("TABLE_NAME"));
            }
        }

        // Fallback: some drivers ignore type filters — fetch all and filter
        if (names.isEmpty()) {
            try (ResultSet rs = meta.getTables(catalog, schemaPattern, "%", null)) {
                Set<String> wanted = Set.of(types);
                while (rs.next()) {
                    String tableType = rs.getString("TABLE_TYPE");
                    String name = rs.getString("TABLE_NAME");
                    if (tableType != null && wanted.stream().anyMatch(t -> t.equalsIgnoreCase(tableType))) {
                        names.add(name);
                    } else if (tableType != null && wanted.contains("TABLE")
                            && (tableType.equalsIgnoreCase("BASE TABLE")
                            || tableType.equalsIgnoreCase("SYSTEM TABLE"))) {
                        names.add(name);
                    }
                }
            }
        }
        Collections.sort(names);
        return names;
    }

    public List<String> listProcedures(String schema) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        if (type.isMysqlFamily()) {
            return listMySqlRoutines(schema, "PROCEDURE");
        }
        if (type == DbType.POSTGRESQL) {
            return listPostgresRoutines(schema, "p"); // prokind: p=procedure, f=function
        }
        Connection conn = connectionService.getConnection();
        DatabaseMetaData meta = conn.getMetaData();
        List<String> names = new ArrayList<>();
        String catalog = resolveCatalog(schema);
        String schemaPattern = resolveSchemaPattern(schema);

        try (ResultSet rs = meta.getProcedures(catalog, schemaPattern, "%")) {
            while (rs.next()) {
                names.add(rs.getString("PROCEDURE_NAME"));
            }
        }
        Collections.sort(names);
        return names;
    }

    public List<String> listFunctions(String schema) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        List<String> names = new ArrayList<>();

        try {
            switch (type) {
                case MYSQL, MARIADB -> {
                    return listMySqlRoutines(schema, "FUNCTION");
                }
                case POSTGRESQL -> {
                    return listPostgresRoutines(schema, "f");
                }
                default -> {
                }
            }
        } catch (SQLException ignored) {
            // optional feature
        }
        return names;
    }

    private List<String> listPostgresRoutines(String schema, String prokind) throws SQLException {
        Connection conn = connectionService.getConnection();
        String schemaName = (schema == null || schema.isBlank()) ? "public" : schema;
        List<String> names = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT p.proname FROM pg_proc p " +
                        "JOIN pg_namespace n ON p.pronamespace = n.oid " +
                        "WHERE n.nspname = ? AND p.prokind = ? " +
                        "ORDER BY 1")) {
            ps.setString(1, schemaName);
            ps.setString(2, prokind);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    names.add(rs.getString(1));
                }
            }
        }
        return names;
    }

    private List<String> listMySqlRoutines(String schema, String routineType) throws SQLException {
        Connection conn = connectionService.getConnection();
        List<String> names = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT ROUTINE_NAME FROM information_schema.ROUTINES " +
                        "WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY 1")) {
            ps.setString(1, schema);
            ps.setString(2, routineType);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    names.add(rs.getString(1));
                }
            }
        }
        return names;
    }

    public List<ColumnInfo> getColumns(String schema, String table) throws SQLException {
        Connection conn = connectionService.getConnection();
        DatabaseMetaData meta = conn.getMetaData();
        String catalog = resolveCatalog(schema);
        String schemaPattern = resolveSchemaPattern(schema);

        Set<String> pkCols = new LinkedHashSet<>();
        try (ResultSet pk = meta.getPrimaryKeys(catalog, schemaPattern, table)) {
            while (pk.next()) {
                pkCols.add(pk.getString("COLUMN_NAME"));
            }
        }

        List<ColumnInfo> columns = new ArrayList<>();
        try (ResultSet rs = meta.getColumns(catalog, schemaPattern, table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                String typeName = rs.getString("TYPE_NAME");
                int size = rs.getInt("COLUMN_SIZE");
                boolean nullable = rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls;
                String def = rs.getString("COLUMN_DEF");
                String auto = "";
                try {
                    auto = rs.getString("IS_AUTOINCREMENT");
                } catch (SQLException ignored) {
                }
                boolean autoInc = "YES".equalsIgnoreCase(auto);
                columns.add(new ColumnInfo(name, typeName, size, nullable,
                        pkCols.contains(name), autoInc, def));
            }
        }
        return columns;
    }

    /**
     * Build an ERD payload for a database/schema: tables with columns + FK relations.
     */
    public Map<String, Object> getErd(String schema) throws SQLException {
        if (schema == null || schema.isBlank()) {
            throw new SQLException("Schema/database name is required");
        }
        List<String> tableNames = listTables(schema);
        Collections.sort(tableNames);

        List<Map<String, Object>> tables = new ArrayList<>();
        for (String table : tableNames) {
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("name", table);
            List<Map<String, Object>> cols = new ArrayList<>();
            for (ColumnInfo c : getColumns(schema, table)) {
                Map<String, Object> col = new LinkedHashMap<>();
                col.put("name", c.getName());
                col.put("type", c.getDisplayType());
                col.put("primaryKey", c.isPrimaryKey());
                col.put("nullable", c.isNullable());
                cols.add(col);
            }
            t.put("columns", cols);
            tables.add(t);
        }

        List<Map<String, Object>> relations = listForeignKeyRelations(schema, tableNames);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", schema);
        out.put("tables", tables);
        out.put("relations", relations);
        return out;
    }

    private List<Map<String, Object>> listForeignKeyRelations(String schema, List<String> tableNames)
            throws SQLException {
        Connection conn = connectionService.getConnection();
        DatabaseMetaData meta = conn.getMetaData();
        String catalog = resolveCatalog(schema);
        String schemaPattern = resolveSchemaPattern(schema);
        Set<String> tableSet = new LinkedHashSet<>(tableNames);
        // Group composite FK columns by FK name + tables.
        Map<String, Map<String, Object>> grouped = new LinkedHashMap<>();

        for (String table : tableNames) {
            try (ResultSet rs = meta.getImportedKeys(catalog, schemaPattern, table)) {
                while (rs.next()) {
                    String fkTable = rs.getString("FKTABLE_NAME");
                    String pkTable = rs.getString("PKTABLE_NAME");
                    String fkCol = rs.getString("FKCOLUMN_NAME");
                    String pkCol = rs.getString("PKCOLUMN_NAME");
                    if (fkTable == null || pkTable == null || fkCol == null || pkCol == null) {
                        continue;
                    }
                    // Keep edges within this schema's table set when possible.
                    if (!tableSet.isEmpty() && (!tableSet.contains(fkTable) || !tableSet.contains(pkTable))) {
                        continue;
                    }
                    String fkName = rs.getString("FK_NAME");
                    if (fkName == null || fkName.isBlank()) {
                        fkName = fkTable + "_to_" + pkTable;
                    }
                    int seq = 1;
                    try {
                        seq = rs.getInt("KEY_SEQ");
                        if (rs.wasNull()) seq = 1;
                    } catch (SQLException ignored) {
                    }
                    String key = fkName + "\0" + fkTable + "\0" + pkTable;
                    Map<String, Object> rel = grouped.get(key);
                    if (rel == null) {
                        rel = new LinkedHashMap<>();
                        rel.put("name", fkName);
                        rel.put("fromTable", fkTable);
                        rel.put("toTable", pkTable);
                        rel.put("fromColumns", new ArrayList<String>());
                        rel.put("toColumns", new ArrayList<String>());
                        grouped.put(key, rel);
                    }
                    @SuppressWarnings("unchecked")
                    List<String> fromCols = (List<String>) rel.get("fromColumns");
                    @SuppressWarnings("unchecked")
                    List<String> toCols = (List<String>) rel.get("toColumns");
                    // KEY_SEQ is 1-based; ensure order
                    while (fromCols.size() < seq) fromCols.add(null);
                    while (toCols.size() < seq) toCols.add(null);
                    fromCols.set(seq - 1, fkCol);
                    toCols.set(seq - 1, pkCol);
                }
            } catch (SQLException ignored) {
                // Some engines/drivers lack FK metadata for this table.
            }
        }

        List<Map<String, Object>> relations = new ArrayList<>();
        for (Map<String, Object> rel : grouped.values()) {
            @SuppressWarnings("unchecked")
            List<String> fromCols = (List<String>) rel.get("fromColumns");
            @SuppressWarnings("unchecked")
            List<String> toCols = (List<String>) rel.get("toColumns");
            fromCols.removeIf(c -> c == null || c.isBlank());
            toCols.removeIf(c -> c == null || c.isBlank());
            if (fromCols.isEmpty() || toCols.isEmpty()) continue;
            relations.add(rel);
        }
        return relations;
    }

    public QueryResult previewTable(String schema, String table, int limit) throws SQLException {
        return previewTable(schema, table, limit, 0);
    }

    public QueryResult previewTable(String schema, String table, int limit, int offset) throws SQLException {
        String qualified = qualify(schema, table);
        int lim = Math.max(1, limit);
        int off = Math.max(0, offset);
        DbType type = connectionService.getProfile().getDbType();
        String sql;
        if (type == DbType.SQLSERVER) {
            sql = "SELECT * FROM " + qualified
                    + " ORDER BY (SELECT NULL) OFFSET " + off
                    + " ROWS FETCH NEXT " + lim + " ROWS ONLY";
        } else {
            sql = "SELECT * FROM " + qualified + " LIMIT " + lim + " OFFSET " + off;
        }
        return execute(sql);
    }

    public QueryResult execute(String sql) throws SQLException {
        Connection conn = connectionService.getConnection();
        long start = System.currentTimeMillis();
        try (Statement stmt = conn.createStatement()) {
            boolean hasResult = stmt.execute(sql);
            long ms = System.currentTimeMillis() - start;
            if (hasResult) {
                try (ResultSet rs = stmt.getResultSet()) {
                    return mapResultSet(rs, ms);
                }
            }
            return QueryResult.update(stmt.getUpdateCount(), ms);
        }
    }

    public QueryResult executeScript(String script) throws SQLException {
        List<String> statements = SqlUtils.splitStatements(script);
        QueryResult last = null;
        for (String sql : statements) {
            if (sql.isBlank()) continue;
            last = execute(sql);
        }
        if (last == null) {
            return QueryResult.update(0, 0);
        }
        return last;
    }

    public int insertRow(String schema, String table, Map<String, Object> values) throws SQLException {
        List<String> cols = new ArrayList<>(values.keySet());
        String colList = cols.stream().map(this::quoteIdent).collect(Collectors.joining(", "));
        String placeholders = cols.stream().map(c -> "?").collect(Collectors.joining(", "));
        String sql = "INSERT INTO " + qualify(schema, table) + " (" + colList + ") VALUES (" + placeholders + ")";
        try (PreparedStatement ps = connectionService.getConnection().prepareStatement(sql)) {
            for (int i = 0; i < cols.size(); i++) {
                ps.setObject(i + 1, values.get(cols.get(i)));
            }
            return ps.executeUpdate();
        }
    }

    public int updateRow(String schema, String table, Map<String, Object> pkValues,
                         Map<String, Object> newValues) throws SQLException {
        if (pkValues.isEmpty()) {
            throw new SQLException("Cannot update without primary key columns");
        }
        List<String> setCols = new ArrayList<>(newValues.keySet());
        String setClause = setCols.stream().map(c -> quoteIdent(c) + " = ?").collect(Collectors.joining(", "));
        List<String> whereCols = new ArrayList<>(pkValues.keySet());
        String whereClause = whereCols.stream().map(c -> quoteIdent(c) + " = ?").collect(Collectors.joining(" AND "));
        String sql = "UPDATE " + qualify(schema, table) + " SET " + setClause + " WHERE " + whereClause;

        try (PreparedStatement ps = connectionService.getConnection().prepareStatement(sql)) {
            int idx = 1;
            for (String c : setCols) {
                ps.setObject(idx++, newValues.get(c));
            }
            for (String c : whereCols) {
                ps.setObject(idx++, pkValues.get(c));
            }
            return ps.executeUpdate();
        }
    }

    public int deleteRow(String schema, String table, Map<String, Object> pkValues) throws SQLException {
        if (pkValues.isEmpty()) {
            throw new SQLException("Cannot delete without primary key columns");
        }
        List<String> whereCols = new ArrayList<>(pkValues.keySet());
        String whereClause = whereCols.stream().map(c -> quoteIdent(c) + " = ?").collect(Collectors.joining(" AND "));
        String sql = "DELETE FROM " + qualify(schema, table) + " WHERE " + whereClause;
        try (PreparedStatement ps = connectionService.getConnection().prepareStatement(sql)) {
            int idx = 1;
            for (String c : whereCols) {
                ps.setObject(idx++, pkValues.get(c));
            }
            return ps.executeUpdate();
        }
    }

    public void createDatabase(String name) throws SQLException {
        createDatabase(name, null, null);
    }

    public void createDatabase(String name, String charset, String collation) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        String sql = switch (type) {
            case MYSQL, MARIADB -> {
                StringBuilder sb = new StringBuilder("CREATE DATABASE ").append(quoteIdent(name));
                if (charset != null && !charset.isBlank()) {
                    sb.append(" CHARACTER SET ").append(charset.trim());
                }
                if (collation != null && !collation.isBlank()) {
                    sb.append(" COLLATE ").append(collation.trim());
                }
                yield sb.toString();
            }
            case H2, H2_FILE, POSTGRESQL, SQLSERVER -> "CREATE DATABASE " + quoteIdent(name);
            case SQLITE -> throw new SQLException("SQLite uses a file path as the database");
        };
        execute(sql);
    }

    public void alterDatabase(String name, String newName, String charset, String collation) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        switch (type) {
            case MYSQL, MARIADB -> {
                if ((charset != null && !charset.isBlank()) || (collation != null && !collation.isBlank())) {
                    StringBuilder sb = new StringBuilder("ALTER DATABASE ").append(quoteIdent(name));
                    if (charset != null && !charset.isBlank()) {
                        sb.append(" CHARACTER SET ").append(charset.trim());
                    }
                    if (collation != null && !collation.isBlank()) {
                        sb.append(" COLLATE ").append(collation.trim());
                    }
                    execute(sb.toString());
                }
                if (newName != null && !newName.isBlank() && !newName.equals(name)) {
                    throw new SQLException("MySQL does not support renaming databases; create a clone instead");
                }
            }
            case POSTGRESQL -> {
                if (newName != null && !newName.isBlank() && !newName.equals(name)) {
                    execute("ALTER DATABASE " + quoteIdent(name) + " RENAME TO " + quoteIdent(newName));
                } else {
                    throw new SQLException("PostgreSQL database alter supports rename only; use schemas for other changes");
                }
            }
            case SQLSERVER -> {
                if (newName != null && !newName.isBlank() && !newName.equals(name)) {
                    execute("ALTER DATABASE " + quoteIdent(name) + " MODIFY NAME = " + quoteIdent(newName));
                } else {
                    throw new SQLException("Provide a new name to rename the SQL Server database");
                }
            }
            case H2, H2_FILE -> throw new SQLException("H2 does not support ALTER DATABASE rename here");
            case SQLITE -> throw new SQLException("Cannot alter SQLite database file from here");
        }
    }

    public void dropDatabase(String name) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        if (type == DbType.SQLITE) {
            throw new SQLException("Cannot drop SQLite database file from here");
        }
        execute("DROP DATABASE " + quoteIdent(name));
    }

    public void createSchema(String name) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        switch (type) {
            case POSTGRESQL, H2, H2_FILE -> execute("CREATE SCHEMA " + quoteIdent(name));
            case MYSQL, MARIADB, SQLSERVER -> createDatabase(name);
            case SQLITE -> throw new SQLException("SQLite does not support CREATE SCHEMA");
        }
    }

    public void dropSchema(String name) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        switch (type) {
            case POSTGRESQL -> execute("DROP SCHEMA " + quoteIdent(name) + " CASCADE");
            case H2, H2_FILE -> execute("DROP SCHEMA IF EXISTS " + quoteIdent(name) + " CASCADE");
            case MYSQL, MARIADB, SQLSERVER -> dropDatabase(name);
            case SQLITE -> throw new SQLException("SQLite does not support DROP SCHEMA");
        }
    }

    public void dropTable(String schema, String table) throws SQLException {
        execute("DROP TABLE " + qualify(schema, table));
    }

    public void renameTable(String schema, String table, String newName) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        String sql = switch (type) {
            case MYSQL, MARIADB -> "RENAME TABLE " + qualify(schema, table) + " TO " + qualify(schema, newName);
            case POSTGRESQL, H2, H2_FILE -> "ALTER TABLE " + qualify(schema, table) + " RENAME TO " + quoteIdent(newName);
            case SQLSERVER -> "EXEC sp_rename '" + schema + "." + table + "', '" + newName + "'";
            case SQLITE -> "ALTER TABLE " + quoteIdent(table) + " RENAME TO " + quoteIdent(newName);
        };
        execute(sql);
    }

    public void dropView(String schema, String view) throws SQLException {
        execute("DROP VIEW " + qualify(schema, view));
    }

    public void createView(String schema, String viewName, String selectSql, boolean replace) throws SQLException {
        if (selectSql == null || selectSql.isBlank()) {
            throw new SQLException("View definition SQL is required");
        }
        String select = selectSql.trim();
        if (select.endsWith(";")) {
            select = select.substring(0, select.length() - 1).trim();
        }
        DbType type = connectionService.getProfile().getDbType();
        String verb = replace
                ? (type == DbType.POSTGRESQL ? "CREATE OR REPLACE VIEW " : "CREATE OR REPLACE VIEW ")
                : "CREATE VIEW ";
        if (type == DbType.SQLSERVER && replace) {
            try {
                dropView(schema, viewName);
            } catch (SQLException ignored) {
            }
            verb = "CREATE VIEW ";
        }
        if (type.isMysqlFamily() && replace) {
            try {
                dropView(schema, viewName);
            } catch (SQLException ignored) {
            }
            verb = "CREATE VIEW ";
        }
        execute(verb + qualify(schema, viewName) + " AS " + select);
    }

    public List<Map<String, Object>> listIndexes(String schema, String table) throws SQLException {
        Connection conn = connectionService.getConnection();
        DatabaseMetaData meta = conn.getMetaData();
        String catalog = resolveCatalog(schema);
        String schemaPattern = resolveSchemaPattern(schema);
        Map<String, Map<String, Object>> byName = new LinkedHashMap<>();
        try (ResultSet rs = meta.getIndexInfo(catalog, schemaPattern, table, false, false)) {
            while (rs.next()) {
                String indexName = rs.getString("INDEX_NAME");
                if (indexName == null) {
                    continue;
                }
                Map<String, Object> idx = byName.computeIfAbsent(indexName, k -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("name", k);
                    m.put("unique", false);
                    m.put("columns", new ArrayList<String>());
                    return m;
                });
                boolean nonUnique = rs.getBoolean("NON_UNIQUE");
                idx.put("unique", !nonUnique);
                @SuppressWarnings("unchecked")
                List<String> cols = (List<String>) idx.get("columns");
                String col = rs.getString("COLUMN_NAME");
                if (col != null && !cols.contains(col)) {
                    cols.add(col);
                }
            }
        }
        return new ArrayList<>(byName.values());
    }

    public void createIndex(String schema, String table, String indexName, List<String> columns, boolean unique)
            throws SQLException {
        if (columns == null || columns.isEmpty()) {
            throw new SQLException("Index requires at least one column");
        }
        String cols = columns.stream().map(this::quoteIdent).collect(Collectors.joining(", "));
        String name = (indexName == null || indexName.isBlank())
                ? "idx_" + table + "_" + String.join("_", columns)
                : indexName;
        String sql = (unique ? "CREATE UNIQUE INDEX " : "CREATE INDEX ")
                + quoteIdent(name) + " ON " + qualify(schema, table) + " (" + cols + ")";
        execute(sql);
    }

    public void dropIndex(String schema, String table, String indexName) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        String sql = switch (type) {
            case MYSQL, MARIADB -> "DROP INDEX " + quoteIdent(indexName) + " ON " + qualify(schema, table);
            case SQLSERVER -> "DROP INDEX " + quoteIdent(indexName) + " ON " + qualify(schema, table);
            case SQLITE -> "DROP INDEX IF EXISTS " + quoteIdent(indexName);
            default -> "DROP INDEX " + quoteIdent(indexName);
        };
        execute(sql);
    }

    public void addColumn(String schema, String table, ColumnDefinition column) throws SQLException {
        StringBuilder sb = new StringBuilder("ALTER TABLE ")
                .append(qualify(schema, table))
                .append(" ADD ")
                .append(quoteIdent(column.name()))
                .append(" ")
                .append(column.sqlType());
        if (!column.nullable()) {
            sb.append(" NOT NULL");
        }
        execute(sb.toString());
    }

    public void dropColumn(String schema, String table, String column) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        if (type == DbType.SQLITE) {
            throw new SQLException("SQLite versions before 3.35 have limited DROP COLUMN support; try a newer SQLite");
        }
        execute("ALTER TABLE " + qualify(schema, table) + " DROP COLUMN " + quoteIdent(column));
    }

    public void createTable(String schema, String tableName, List<ColumnDefinition> columns) throws SQLException {
        if (columns.isEmpty()) {
            throw new SQLException("Table must have at least one column");
        }
        DbType type = connectionService.getProfile().getDbType();
        StringBuilder sb = new StringBuilder("CREATE TABLE ");
        sb.append(qualify(schema, tableName)).append(" (");
        List<String> pk = new ArrayList<>();
        for (int i = 0; i < columns.size(); i++) {
            ColumnDefinition c = columns.get(i);
            if (i > 0) sb.append(", ");
            sb.append(quoteIdent(c.name())).append(" ").append(c.sqlType());

            // SQLite requires: INTEGER PRIMARY KEY AUTOINCREMENT (inline)
            if (type == DbType.SQLITE && c.autoIncrement() && c.primaryKey()) {
                sb.append(" PRIMARY KEY AUTOINCREMENT");
            } else {
                if (!c.nullable()) {
                    sb.append(" NOT NULL");
                }
                if (c.autoIncrement()) {
                    sb.append(switch (type) {
                        case MYSQL, MARIADB -> " AUTO_INCREMENT";
                        case POSTGRESQL -> "";
                        case SQLITE -> ""; // handled above when PK; otherwise ignored
                        case H2, H2_FILE -> " GENERATED BY DEFAULT AS IDENTITY";
                        case SQLSERVER -> " IDENTITY(1,1)";
                    });
                }
                if (c.primaryKey()) {
                    pk.add(c.name());
                }
            }
        }
        if (!pk.isEmpty()) {
            sb.append(", PRIMARY KEY (");
            sb.append(pk.stream().map(this::quoteIdent).collect(Collectors.joining(", ")));
            sb.append(")");
        }
        sb.append(")");
        execute(sb.toString());
    }

    public String getCreateStatement(String schema, String table) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        Connection conn = connectionService.getConnection();
        try {
            return switch (type) {
                case MYSQL, MARIADB -> {
                    try (ResultSet rs = conn.createStatement().executeQuery(
                            "SHOW CREATE TABLE " + qualify(schema, table))) {
                        if (rs.next()) {
                            yield rs.getString(2);
                        }
                        yield "";
                    }
                }
                case SQLITE -> {
                    try (PreparedStatement ps = conn.prepareStatement(
                            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?")) {
                        ps.setString(1, table);
                        try (ResultSet rs = ps.executeQuery()) {
                            yield rs.next() ? rs.getString(1) : "";
                        }
                    }
                }
                default -> {
                    List<ColumnInfo> cols = getColumns(schema, table);
                    StringBuilder sb = new StringBuilder("-- Approximate DDL\nCREATE TABLE ");
                    sb.append(qualify(schema, table)).append(" (\n");
                    for (int i = 0; i < cols.size(); i++) {
                        ColumnInfo c = cols.get(i);
                        sb.append("  ").append(quoteIdent(c.getName())).append(" ").append(c.getDisplayType());
                        if (!c.isNullable()) sb.append(" NOT NULL");
                        if (i < cols.size() - 1) sb.append(",");
                        sb.append("\n");
                    }
                    sb.append(");");
                    yield sb.toString();
                }
            };
        } catch (SQLException e) {
            return "-- Unable to retrieve DDL: " + e.getMessage();
        }
    }

    private QueryResult mapResultSet(ResultSet rs, long ms) throws SQLException {
        ResultSetMetaData meta = rs.getMetaData();
        int count = meta.getColumnCount();
        List<String> columns = new ArrayList<>();
        List<String> types = new ArrayList<>();
        for (int i = 1; i <= count; i++) {
            columns.add(meta.getColumnLabel(i));
            types.add(meta.getColumnTypeName(i));
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        while (rs.next()) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (String col : columns) {
                Object val = rs.getObject(col);
                row.put(col, val);
            }
            rows.add(row);
        }
        return QueryResult.select(columns, types, rows, ms);
    }

    private String resolveCatalog(String schema) {
        DbType type = connectionService.getProfile().getDbType();
        return switch (type) {
            case MYSQL, MARIADB, SQLSERVER -> schema;
            default -> null;
        };
    }

    private String resolveSchemaPattern(String schema) {
        DbType type = connectionService.getProfile().getDbType();
        return switch (type) {
            case POSTGRESQL, H2, H2_FILE -> schema == null ? "PUBLIC" : schema;
            case SQLITE -> null;
            default -> null;
        };
    }

    public String qualify(String schema, String name) {
        DbType type = connectionService.getProfile().getDbType();
        if (schema == null || schema.isBlank() || type == DbType.SQLITE) {
            return quoteIdent(name);
        }
        if (type.isMysqlFamily() || type == DbType.SQLSERVER) {
            return quoteIdent(schema) + "." + quoteIdent(name);
        }
        return quoteIdent(schema) + "." + quoteIdent(name);
    }

    public String quoteIdent(String ident) {
        DbType type = connectionService.getProfile().getDbType();
        return switch (type) {
            case MYSQL, MARIADB -> "`" + ident.replace("`", "``") + "`";
            case SQLSERVER -> "[" + ident.replace("]", "]]") + "]";
            default -> "\"" + ident.replace("\"", "\"\"") + "\"";
        };
    }

    /** File basename for SQLite labels (hide full path in the tree). */
    static String sqliteDisplayName(String pathOrName) {
        if (pathOrName == null || pathOrName.isBlank()) {
            return "main";
        }
        String normalized = pathOrName.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        String name = slash >= 0 ? normalized.substring(slash + 1) : normalized;
        return name.isBlank() ? "main" : name;
    }

    public String sqlLiteral(Object value) {
        if (value == null) {
            return "NULL";
        }
        if (value instanceof Number || value instanceof Boolean) {
            return String.valueOf(value);
        }
        String s = String.valueOf(value);
        return "'" + s.replace("'", "''") + "'";
    }

    public record ColumnDefinition(String name, String sqlType, boolean nullable,
                                   boolean primaryKey, boolean autoIncrement) {
    }
}
