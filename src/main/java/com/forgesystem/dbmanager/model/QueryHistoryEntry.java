package com.forgesystem.dbmanager.model;

import java.util.UUID;

/**
 * One executed statement (or script) recorded for the Execution History panel.
 *
 * <p>Persisted to {@code ~/.forge-dbmanager/query-history.json}, so the fields are
 * plain and stable: adding one later must not break reading an older file.
 * Only the SQL text and its outcome are kept — never connection credentials.
 */
public class QueryHistoryEntry {
    private String id;
    private String connectionId;
    private String connectionName;
    private String engine;
    private String database;
    private String schema;
    private String sql;
    /** Epoch millis when execution started. */
    private long startedAt;
    private long durationMs;
    private boolean success;
    /** Rows returned by a SELECT. */
    private long rowCount;
    /** Rows changed by an INSERT / UPDATE / DELETE / DDL batch. */
    private long affectedRows;
    private boolean update;
    private String error;

    public QueryHistoryEntry() {
        this.id = UUID.randomUUID().toString();
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getConnectionId() {
        return connectionId;
    }

    public void setConnectionId(String connectionId) {
        this.connectionId = connectionId;
    }

    public String getConnectionName() {
        return connectionName;
    }

    public void setConnectionName(String connectionName) {
        this.connectionName = connectionName;
    }

    public String getEngine() {
        return engine;
    }

    public void setEngine(String engine) {
        this.engine = engine;
    }

    public String getDatabase() {
        return database;
    }

    public void setDatabase(String database) {
        this.database = database;
    }

    public String getSchema() {
        return schema;
    }

    public void setSchema(String schema) {
        this.schema = schema;
    }

    public String getSql() {
        return sql;
    }

    public void setSql(String sql) {
        this.sql = sql;
    }

    public long getStartedAt() {
        return startedAt;
    }

    public void setStartedAt(long startedAt) {
        this.startedAt = startedAt;
    }

    public long getDurationMs() {
        return durationMs;
    }

    public void setDurationMs(long durationMs) {
        this.durationMs = durationMs;
    }

    public boolean isSuccess() {
        return success;
    }

    public void setSuccess(boolean success) {
        this.success = success;
    }

    public long getRowCount() {
        return rowCount;
    }

    public void setRowCount(long rowCount) {
        this.rowCount = rowCount;
    }

    public long getAffectedRows() {
        return affectedRows;
    }

    public void setAffectedRows(long affectedRows) {
        this.affectedRows = affectedRows;
    }

    public boolean isUpdate() {
        return update;
    }

    public void setUpdate(boolean update) {
        this.update = update;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    /** First line of the statement, for compact list rendering. */
    public String getPreview() {
        if (sql == null) {
            return "";
        }
        String flat = sql.replaceAll("\\s+", " ").trim();
        return flat.length() > 200 ? flat.substring(0, 200) + "…" : flat;
    }
}
