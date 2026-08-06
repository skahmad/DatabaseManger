package com.forgesystem.dbmanager.model;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class QueryResult {
    private final List<String> columnNames;
    private final List<String> columnTypes;
    private final List<Map<String, Object>> rows;
    private final long affectedRows;
    private final long executionMs;
    private final boolean update;
    private final String message;

    private QueryResult(List<String> columnNames, List<String> columnTypes,
                        List<Map<String, Object>> rows, long affectedRows,
                        long executionMs, boolean update, String message) {
        this.columnNames = columnNames;
        this.columnTypes = columnTypes;
        this.rows = rows;
        this.affectedRows = affectedRows;
        this.executionMs = executionMs;
        this.update = update;
        this.message = message;
    }

    public static QueryResult select(List<String> columns, List<String> types,
                                     List<Map<String, Object>> rows, long ms) {
        return new QueryResult(columns, types, rows, rows.size(), ms, false,
                rows.size() + " row(s) returned in " + ms + " ms");
    }

    public static QueryResult update(long affected, long ms) {
        return new QueryResult(List.of(), List.of(), List.of(), affected, ms, true,
                affected + " row(s) affected in " + ms + " ms");
    }

    public List<String> getColumnNames() {
        return columnNames;
    }

    public List<String> getColumnTypes() {
        return columnTypes;
    }

    public List<Map<String, Object>> getRows() {
        return rows;
    }

    public long getAffectedRows() {
        return affectedRows;
    }

    public long getExecutionMs() {
        return executionMs;
    }

    public boolean isUpdate() {
        return update;
    }

    public String getMessage() {
        return message;
    }

    public List<Map<String, Object>> filtered(String search) {
        if (search == null || search.isBlank()) {
            return rows;
        }
        String q = search.toLowerCase();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            for (Object v : row.values()) {
                if (v != null && v.toString().toLowerCase().contains(q)) {
                    out.add(row);
                    break;
                }
            }
        }
        return out;
    }
}
