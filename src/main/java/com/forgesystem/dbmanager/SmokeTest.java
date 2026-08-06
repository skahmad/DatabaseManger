package com.forgesystem.dbmanager;

import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.DbType;
import com.forgesystem.dbmanager.model.QueryResult;
import com.forgesystem.dbmanager.service.ConnectionService;
import com.forgesystem.dbmanager.service.DatabaseService;
import com.forgesystem.dbmanager.service.DatabaseService.ColumnDefinition;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Headless smoke test for core JDBC features (no JavaFX UI).
 */
public final class SmokeTest {
    private SmokeTest() {
    }

    public static void main(String[] args) throws Exception {
        Path dbFile = Files.createTempFile("forge-dbmanager-smoke-", ".db");
        Files.deleteIfExists(dbFile);

        ConnectionProfile profile = new ConnectionProfile(
                "smoke", DbType.SQLITE, "localhost", 0, dbFile.toString(), "", "");

        ConnectionService cs = new ConnectionService();
        DatabaseService ds = new DatabaseService(cs);
        cs.connect(profile);

        ds.createTable(null, "users", List.of(
                new ColumnDefinition("id", "INTEGER", false, true, true),
                new ColumnDefinition("name", "TEXT", false, false, false),
                new ColumnDefinition("email", "TEXT", true, false, false)
        ));

        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", "Ada");
        row.put("email", "ada@example.com");
        ds.insertRow(null, "users", row);

        QueryResult result = ds.execute("SELECT * FROM users");
        if (result.getRows().size() != 1) {
            throw new IllegalStateException("Expected 1 row, got " + result.getRows().size());
        }

        Map<String, Object> pk = Map.of("id", result.getRows().get(0).get("id"));
        ds.updateRow(null, "users", pk, Map.of("name", "Ada Lovelace"));
        ds.deleteRow(null, "users", pk);

        QueryResult empty = ds.execute("SELECT COUNT(*) AS c FROM users");
        Object count = empty.getRows().get(0).get("c");
        if (!"0".equals(String.valueOf(count))) {
            throw new IllegalStateException("Expected 0 rows after delete, got " + count);
        }

        List<String> tables = ds.listTables(null);
        if (!tables.contains("users")) {
            throw new IllegalStateException("users table missing from metadata");
        }

        cs.disconnect();
        Files.deleteIfExists(dbFile);
        System.out.println("Smoke test passed.");
    }
}
