package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ColumnInfo;
import com.forgesystem.dbmanager.model.DbType;
import com.forgesystem.dbmanager.model.QueryResult;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Same-server database/schema cloning and migration helpers.
 */
public class CloneMigrateService {
    private final ConnectionService connectionService;
    private final DatabaseService databaseService;

    public CloneMigrateService(ConnectionService connectionService, DatabaseService databaseService) {
        this.connectionService = connectionService;
        this.databaseService = databaseService;
    }

    public Map<String, Object> cloneDatabase(String source, String target, boolean includeData,
                                             boolean includeViews, boolean includeIndexes) throws SQLException {
        if (target == null || target.isBlank()) {
            throw new SQLException("Target name is required");
        }
        if (target.equals(source)) {
            throw new SQLException("Target name must differ from source");
        }
        DbType type = connectionService.getProfile().getDbType();
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("source", source);
        summary.put("target", target);

        switch (type) {
            case MYSQL, MARIADB -> cloneMySqlDatabase(source, target, includeData, includeViews, includeIndexes, summary);
            case POSTGRESQL, H2, H2_FILE -> cloneSchema(source, target, includeData, includeViews, includeIndexes, summary);
            case SQLSERVER -> cloneSqlServerDatabase(source, target, includeData, includeViews, includeIndexes, summary);
            case SQLITE -> throw new SQLException("Clone is not supported for SQLite; export SQL and open a new file instead");
        }
        return summary;
    }

    public Map<String, Object> migrateWithinServer(String source, String target, boolean includeData) throws SQLException {
        return cloneDatabase(source, target, includeData, true, true);
    }

    private void cloneMySqlDatabase(String source, String target, boolean includeData, boolean includeViews,
                                    boolean includeIndexes, Map<String, Object> summary) throws SQLException {
        databaseService.createDatabase(target);
        connectionService.useDatabase(source);
        List<String> tables = databaseService.listTables(source);
        int copied = 0;
        for (String table : tables) {
            String ddl = "CREATE TABLE " + databaseService.qualify(target, table)
                    + " LIKE " + databaseService.qualify(source, table);
            databaseService.execute(ddl);
            if (includeData) {
                databaseService.execute("INSERT INTO " + databaseService.qualify(target, table)
                        + " SELECT * FROM " + databaseService.qualify(source, table));
            }
            copied++;
            if (includeIndexes) {
                // LIKE copies indexes on MySQL
            }
        }
        summary.put("tablesCopied", copied);
        if (includeViews) {
            int views = 0;
            for (String view : databaseService.listViews(source)) {
                try {
                    String def = fetchMySqlViewDefinition(source, view);
                    if (def != null) {
                        databaseService.execute("CREATE VIEW " + databaseService.qualify(target, view) + " AS " + def);
                        views++;
                    }
                } catch (SQLException ignored) {
                }
            }
            summary.put("viewsCopied", views);
        }
    }

    private String fetchMySqlViewDefinition(String schema, String view) throws SQLException {
        Connection conn = connectionService.getConnection();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")) {
            ps.setString(1, schema);
            ps.setString(2, view);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return rs.getString(1);
                }
            }
        }
        return null;
    }

    private void cloneSchema(String source, String target, boolean includeData, boolean includeViews,
                             boolean includeIndexes, Map<String, Object> summary) throws SQLException {
        databaseService.createSchema(target);
        List<String> tables = databaseService.listTables(source);
        int copied = 0;
        for (String table : tables) {
            List<ColumnInfo> cols = databaseService.getColumns(source, table);
            List<DatabaseService.ColumnDefinition> defs = new ArrayList<>();
            for (ColumnInfo c : cols) {
                defs.add(new DatabaseService.ColumnDefinition(
                        c.getName(),
                        c.getDisplayType() == null || c.getDisplayType().isBlank() ? "VARCHAR(255)" : c.getDisplayType(),
                        c.isNullable(),
                        c.isPrimaryKey(),
                        c.isAutoIncrement()
                ));
            }
            databaseService.createTable(target, table, defs);
            if (includeData) {
                copyTableData(source, table, target, table);
            }
            if (includeIndexes) {
                copyIndexes(source, table, target, table);
            }
            copied++;
        }
        summary.put("tablesCopied", copied);
        if (includeViews) {
            int views = 0;
            for (String view : databaseService.listViews(source)) {
                try {
                    // Best-effort: skip if engine-specific view DDL unavailable
                    String ddl = databaseService.getCreateStatement(source, view);
                    if (ddl != null && !ddl.isBlank() && ddl.toUpperCase().contains(" AS ")) {
                        int as = ddl.toUpperCase().lastIndexOf(" AS ");
                        String select = ddl.substring(as + 4).trim();
                        if (select.endsWith(";")) select = select.substring(0, select.length() - 1);
                        databaseService.createView(target, view, select, false);
                        views++;
                    }
                } catch (SQLException ignored) {
                }
            }
            summary.put("viewsCopied", views);
        }
    }

    private void cloneSqlServerDatabase(String source, String target, boolean includeData, boolean includeViews,
                                        boolean includeIndexes, Map<String, Object> summary) throws SQLException {
        // SQL Server cannot easily CREATE DATABASE AS COPY without backup/restore.
        // Fallback: create empty DB and copy table structures/data via INSERT SELECT.
        databaseService.createDatabase(target);
        List<String> tables = databaseService.listTables(source);
        int copied = 0;
        for (String table : tables) {
            String create = "SELECT * INTO " + databaseService.qualify(target, table)
                    + " FROM " + databaseService.qualify(source, table)
                    + (includeData ? "" : " WHERE 1 = 0");
            databaseService.execute(create);
            if (includeIndexes) {
                copyIndexes(source, table, target, table);
            }
            copied++;
        }
        summary.put("tablesCopied", copied);
        summary.put("viewsCopied", includeViews ? 0 : null);
        summary.put("note", "SQL Server clone copies tables via SELECT INTO; views may need manual recreation");
    }

    private void copyTableData(String sourceSchema, String sourceTable, String targetSchema, String targetTable)
            throws SQLException {
        QueryResult data = databaseService.previewTable(sourceSchema, sourceTable, 500_000);
        for (Map<String, Object> row : data.getRows()) {
            databaseService.insertRow(targetSchema, targetTable, row);
        }
    }

    private void copyIndexes(String sourceSchema, String sourceTable, String targetSchema, String targetTable)
            throws SQLException {
        List<Map<String, Object>> indexes = databaseService.listIndexes(sourceSchema, sourceTable);
        for (Map<String, Object> idx : indexes) {
            String name = String.valueOf(idx.get("name"));
            if (name.equalsIgnoreCase("PRIMARY") || name.toUpperCase().contains("PK_")) {
                continue;
            }
            @SuppressWarnings("unchecked")
            List<String> cols = (List<String>) idx.get("columns");
            boolean unique = Boolean.TRUE.equals(idx.get("unique"));
            try {
                String newName = name + "_clone";
                databaseService.createIndex(targetSchema, targetTable, newName, cols, unique);
            } catch (SQLException ignored) {
            }
        }
    }
}
