package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ColumnInfo;
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
            case MYSQL -> {
                try (ResultSet rs = conn.createStatement().executeQuery("SHOW DATABASES")) {
                    while (rs.next()) {
                        dbs.add(rs.getString(1));
                    }
                }
            }
            case POSTGRESQL -> {
                // In PostgreSQL the connection is already to one database;
                // explorer nodes are schemas (e.g. public), not other databases.
                try (ResultSet rs = conn.createStatement().executeQuery(
                        "SELECT nspname FROM pg_namespace " +
                                "WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' " +
                                "AND nspname <> 'information_schema' " +
                                "ORDER BY 1")) {
                    while (rs.next()) {
                        dbs.add(rs.getString(1));
                    }
                }
                if (dbs.isEmpty()) {
                    dbs.add("public");
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
            case H2, H2_FILE -> {
                DatabaseMetaData meta = conn.getMetaData();
                try (ResultSet rs = meta.getSchemas()) {
                    while (rs.next()) {
                        dbs.add(rs.getString("TABLE_SCHEM"));
                    }
                }
                if (dbs.isEmpty()) {
                    dbs.add("PUBLIC");
                }
            }
            case SQLITE -> {
                String db = connectionService.getProfile().getDatabase();
                dbs.add(db == null || db.isBlank() ? "main" : db);
            }
        }
        return dbs;
    }

    public List<String> listTables(String schema) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        if (type == DbType.MYSQL) {
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
        if (type == DbType.MYSQL) {
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
        if (type == DbType.MYSQL) {
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
                case MYSQL -> {
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

    public QueryResult previewTable(String schema, String table, int limit) throws SQLException {
        String qualified = qualify(schema, table);
        String sql = "SELECT * FROM " + qualified + " LIMIT " + Math.max(1, limit);
        DbType type = connectionService.getProfile().getDbType();
        if (type == DbType.SQLSERVER) {
            sql = "SELECT TOP " + Math.max(1, limit) + " * FROM " + qualified;
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
        DbType type = connectionService.getProfile().getDbType();
        String sql = switch (type) {
            case MYSQL, H2, H2_FILE -> "CREATE DATABASE " + quoteIdent(name);
            case POSTGRESQL -> "CREATE DATABASE " + quoteIdent(name);
            case SQLSERVER -> "CREATE DATABASE " + quoteIdent(name);
            case SQLITE -> throw new SQLException("SQLite uses a file path as the database");
        };
        execute(sql);
    }

    public void dropDatabase(String name) throws SQLException {
        DbType type = connectionService.getProfile().getDbType();
        if (type == DbType.SQLITE) {
            throw new SQLException("Cannot drop SQLite database file from here");
        }
        execute("DROP DATABASE " + quoteIdent(name));
    }

    public void dropTable(String schema, String table) throws SQLException {
        execute("DROP TABLE " + qualify(schema, table));
    }

    public void dropView(String schema, String view) throws SQLException {
        execute("DROP VIEW " + qualify(schema, view));
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
                        case MYSQL -> " AUTO_INCREMENT";
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
                case MYSQL -> {
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
            case MYSQL, SQLSERVER -> schema;
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

    private String qualify(String schema, String name) {
        DbType type = connectionService.getProfile().getDbType();
        if (schema == null || schema.isBlank() || type == DbType.SQLITE) {
            return quoteIdent(name);
        }
        if (type == DbType.MYSQL || type == DbType.SQLSERVER) {
            return quoteIdent(schema) + "." + quoteIdent(name);
        }
        return quoteIdent(schema) + "." + quoteIdent(name);
    }

    private String quoteIdent(String ident) {
        DbType type = connectionService.getProfile().getDbType();
        return switch (type) {
            case MYSQL -> "`" + ident.replace("`", "``") + "`";
            case SQLSERVER -> "[" + ident.replace("]", "]]") + "]";
            default -> "\"" + ident.replace("\"", "\"\"") + "\"";
        };
    }

    public record ColumnDefinition(String name, String sqlType, boolean nullable,
                                   boolean primaryKey, boolean autoIncrement) {
    }
}
