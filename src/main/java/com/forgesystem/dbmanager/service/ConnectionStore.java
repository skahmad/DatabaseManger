package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ConnectionMode;
import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.QueryHistoryEntry;
import com.forgesystem.dbmanager.model.DbType;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;

import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public class ConnectionStore {
    private static final Path STORE_DIR = Path.of(System.getProperty("user.home"), ".forge-dbmanager");
    private static final Path STORE_FILE = STORE_DIR.resolve("connections.json");
    private static final Path HISTORY_FILE = STORE_DIR.resolve("query-history.json");
    private static final int HISTORY_LIMIT = 500;

    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();

    public List<ConnectionProfile> load() {
        ensureDir();
        if (!Files.exists(STORE_FILE)) {
            return new ArrayList<>();
        }
        try {
            String json = Files.readString(STORE_FILE);
            Type type = new TypeToken<List<ConnectionProfile>>() {}.getType();
            List<ConnectionProfile> list = gson.fromJson(json, type);
            if (list == null) {
                return new ArrayList<>();
            }
            for (ConnectionProfile p : list) {
                p.migrateLegacySshAsThreeLayer();
                // PostgreSQL is always 3-layer: database → schemas → tables
                if (p.getDbType() == DbType.POSTGRESQL
                        || p.getDbType() == DbType.H2
                        || p.getDbType() == DbType.H2_FILE) {
                    p.setConnectionMode(ConnectionMode.THREE_LAYER);
                }
                if (!p.isSavePassword()) {
                    p.setPassword("");
                }
                if (!p.isSaveSshPassword()) {
                    p.setSshPassword("");
                    p.setSshPassphrase("");
                }
            }
            return list;
        } catch (IOException e) {
            return new ArrayList<>();
        }
    }

    public void save(List<ConnectionProfile> profiles) {
        ensureDir();
        List<ConnectionProfile> toSave = new ArrayList<>();
        for (ConnectionProfile p : profiles) {
            ConnectionProfile copy = p.copy();
            if (!copy.isSavePassword()) {
                copy.setPassword("");
            }
            if (!copy.isSaveSshPassword()) {
                copy.setSshPassword("");
                copy.setSshPassphrase("");
            }
            toSave.add(copy);
        }
        try {
            Files.writeString(STORE_FILE, gson.toJson(toSave));
        } catch (IOException ignored) {
            // best-effort persistence
        }
    }

    /** Execution history, newest first. Unreadable or legacy files start empty. */
    public List<QueryHistoryEntry> loadHistory() {
        ensureDir();
        if (!Files.exists(HISTORY_FILE)) {
            return new ArrayList<>();
        }
        try {
            String json = Files.readString(HISTORY_FILE);
            Type type = new TypeToken<List<QueryHistoryEntry>>() {}.getType();
            List<QueryHistoryEntry> list = gson.fromJson(json, type);
            if (list == null) {
                return new ArrayList<>();
            }
            List<QueryHistoryEntry> out = new ArrayList<>();
            for (QueryHistoryEntry entry : list) {
                if (entry == null || entry.getSql() == null || entry.getSql().isBlank()) {
                    continue;
                }
                if (entry.getId() == null || entry.getId().isBlank()) {
                    entry.setId(java.util.UUID.randomUUID().toString());
                }
                out.add(entry);
            }
            return out;
        } catch (IOException | RuntimeException e) {
            // Pre-1.1 files held a bare list of SQL strings; corrupt JSON lands here too.
            return new ArrayList<>();
        }
    }

    public void saveHistory(List<QueryHistoryEntry> history) {
        ensureDir();
        try {
            List<QueryHistoryEntry> trimmed = history.size() > HISTORY_LIMIT
                    ? history.subList(0, HISTORY_LIMIT)
                    : history;
            Files.writeString(HISTORY_FILE, gson.toJson(trimmed));
        } catch (IOException ignored) {
        }
    }

    private void ensureDir() {
        try {
            Files.createDirectories(STORE_DIR);
        } catch (IOException ignored) {
        }
    }
}
