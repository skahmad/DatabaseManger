package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ConnectionProfile;
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
                if (!p.isSavePassword()) {
                    p.setPassword("");
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
            toSave.add(copy);
        }
        try {
            Files.writeString(STORE_FILE, gson.toJson(toSave));
        } catch (IOException ignored) {
            // best-effort persistence
        }
    }

    public List<String> loadHistory() {
        ensureDir();
        if (!Files.exists(HISTORY_FILE)) {
            return new ArrayList<>();
        }
        try {
            String json = Files.readString(HISTORY_FILE);
            Type type = new TypeToken<List<String>>() {}.getType();
            List<String> list = gson.fromJson(json, type);
            return list == null ? new ArrayList<>() : list;
        } catch (IOException e) {
            return new ArrayList<>();
        }
    }

    public void saveHistory(List<String> history) {
        ensureDir();
        try {
            List<String> trimmed = history.size() > 100 ? history.subList(0, 100) : history;
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
