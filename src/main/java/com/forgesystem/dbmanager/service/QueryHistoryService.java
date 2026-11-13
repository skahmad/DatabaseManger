package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.QueryHistoryEntry;
import com.forgesystem.dbmanager.model.QueryResult;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Execution history: every statement run from the SQL editor, with its outcome.
 *
 * <p>Newest first, capped at {@link #MAX_ENTRIES}, persisted to disk so history
 * survives a restart. Writes are coalesced onto a single background thread — a
 * query should never wait on the history file.
 */
public class QueryHistoryService {
    /** Entries kept across all connections. Older entries fall off the end. */
    public static final int MAX_ENTRIES = 500;

    private final ConnectionStore store;
    private final List<QueryHistoryEntry> entries;
    private final ExecutorService writer =
            Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "db-pilot-history-writer");
                t.setDaemon(true);
                return t;
            });
    private final AtomicBoolean saveQueued = new AtomicBoolean(false);

    public QueryHistoryService(ConnectionStore store) {
        this.store = store;
        this.entries = new ArrayList<>(store.loadHistory());
        trim();
    }

    /**
     * Record a successful execution.
     *
     * @param profile  connection the statement ran on (may be null)
     * @param database database context at execution time
     * @param schema   schema context at execution time
     */
    public synchronized QueryHistoryEntry recordSuccess(ConnectionProfile profile, String database,
                                                        String schema, String sql,
                                                        QueryResult result, long startedAt, long durationMs) {
        QueryHistoryEntry entry = base(profile, database, schema, sql, startedAt, durationMs);
        entry.setSuccess(true);
        if (result != null) {
            entry.setUpdate(result.isUpdate());
            entry.setAffectedRows(result.getAffectedRows());
            entry.setRowCount(result.isUpdate() ? 0 : result.getRows().size());
        }
        return add(entry);
    }

    /** Record a failed execution; the error message is what the user needs to see later. */
    public synchronized QueryHistoryEntry recordFailure(ConnectionProfile profile, String database,
                                                        String schema, String sql,
                                                        String error, long startedAt, long durationMs) {
        QueryHistoryEntry entry = base(profile, database, schema, sql, startedAt, durationMs);
        entry.setSuccess(false);
        entry.setError(error == null || error.isBlank() ? "Query failed" : error);
        return add(entry);
    }

    private QueryHistoryEntry base(ConnectionProfile profile, String database, String schema,
                                   String sql, long startedAt, long durationMs) {
        QueryHistoryEntry entry = new QueryHistoryEntry();
        if (profile != null) {
            entry.setConnectionId(profile.getId());
            entry.setConnectionName(profile.getName() == null || profile.getName().isBlank()
                    ? (profile.getDbType() == null ? "Connection" : profile.getDbType().getDisplayName())
                    : profile.getName());
            entry.setEngine(profile.getDbType() == null ? "" : profile.getDbType().getDisplayName());
            if (database == null || database.isBlank()) {
                database = profile.getDatabase();
            }
        }
        entry.setDatabase(database);
        entry.setSchema(schema);
        entry.setSql(sql == null ? "" : sql);
        entry.setStartedAt(startedAt);
        entry.setDurationMs(durationMs);
        return entry;
    }

    private QueryHistoryEntry add(QueryHistoryEntry entry) {
        entries.add(0, entry);
        trim();
        scheduleSave();
        return entry;
    }

    private void trim() {
        while (entries.size() > MAX_ENTRIES) {
            entries.remove(entries.size() - 1);
        }
    }

    /**
     * History filtered by connection and free-text search over SQL, database and error.
     *
     * @param connectionId restrict to one connection, or null/blank for all
     * @param search       case-insensitive substring, or null/blank for everything
     */
    public synchronized List<QueryHistoryEntry> list(String connectionId, String search,
                                                     int limit, int offset) {
        List<QueryHistoryEntry> matched = match(connectionId, search);
        int from = Math.max(0, offset);
        if (from >= matched.size()) {
            return List.of();
        }
        int to = limit <= 0 ? matched.size() : Math.min(matched.size(), from + limit);
        return new ArrayList<>(matched.subList(from, to));
    }

    public synchronized int count(String connectionId, String search) {
        return match(connectionId, search).size();
    }

    private List<QueryHistoryEntry> match(String connectionId, String search) {
        String conn = connectionId == null || connectionId.isBlank() ? null : connectionId;
        String q = search == null || search.isBlank() ? null : search.toLowerCase(Locale.ROOT);
        List<QueryHistoryEntry> out = new ArrayList<>();
        for (QueryHistoryEntry e : entries) {
            if (conn != null && !conn.equals(e.getConnectionId())) {
                continue;
            }
            if (q != null && !matchesText(e, q)) {
                continue;
            }
            out.add(e);
        }
        return out;
    }

    private static boolean matchesText(QueryHistoryEntry e, String lowerQuery) {
        return contains(e.getSql(), lowerQuery)
                || contains(e.getDatabase(), lowerQuery)
                || contains(e.getSchema(), lowerQuery)
                || contains(e.getConnectionName(), lowerQuery)
                || contains(e.getError(), lowerQuery);
    }

    private static boolean contains(String value, String lowerQuery) {
        return value != null && value.toLowerCase(Locale.ROOT).contains(lowerQuery);
    }

    public synchronized QueryHistoryEntry get(String id) {
        if (id == null) {
            return null;
        }
        for (QueryHistoryEntry e : entries) {
            if (id.equals(e.getId())) {
                return e;
            }
        }
        return null;
    }

    public synchronized boolean delete(String id) {
        if (id == null) {
            return false;
        }
        boolean removed = entries.removeIf(e -> id.equals(e.getId()));
        if (removed) {
            scheduleSave();
        }
        return removed;
    }

    /** Clear one connection's history, or everything when {@code connectionId} is blank. */
    public synchronized int clear(String connectionId) {
        int before = entries.size();
        if (connectionId == null || connectionId.isBlank()) {
            entries.clear();
        } else {
            entries.removeIf(e -> connectionId.equals(e.getConnectionId()));
        }
        int removed = before - entries.size();
        if (removed > 0) {
            scheduleSave();
        }
        return removed;
    }

    /** Coalesced background write — several rapid queries produce one file write. */
    private void scheduleSave() {
        if (!saveQueued.compareAndSet(false, true)) {
            return;
        }
        try {
            writer.execute(() -> {
                saveQueued.set(false);
                List<QueryHistoryEntry> snapshot;
                synchronized (QueryHistoryService.this) {
                    snapshot = new ArrayList<>(entries);
                }
                store.saveHistory(snapshot);
            });
        } catch (RuntimeException e) {
            // Executor shutting down — history is best-effort, never fail a query for it.
            saveQueued.set(false);
        }
    }

    /** Flush and stop the writer thread (called on app shutdown). */
    public void shutdown() {
        List<QueryHistoryEntry> snapshot;
        synchronized (this) {
            snapshot = new ArrayList<>(entries);
        }
        store.saveHistory(snapshot);
        writer.shutdown();
    }
}
