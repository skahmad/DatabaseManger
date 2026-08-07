package com.forgesystem.dbmanager;

import javafx.stage.FileChooser;
import javafx.stage.Stage;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import java.util.Locale;

/**
 * JS↔Java bridge for the embedded WebView (native file dialogs, etc.).
 */
public class DesktopBridge {
    private final Stage stage;

    public DesktopBridge(Stage stage) {
        this.stage = stage;
    }

    /**
     * Opens a native file picker and returns a JSON payload:
     * {@code {"name":"...","base64":true|false,"content":"..."}} or empty string if cancelled.
     */
    public String pickImportFile() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("Import file");
        chooser.getExtensionFilters().addAll(
                new FileChooser.ExtensionFilter("Data files", "*.csv", "*.json", "*.sql", "*.xlsx", "*.xls"),
                new FileChooser.ExtensionFilter("CSV", "*.csv"),
                new FileChooser.ExtensionFilter("JSON", "*.json"),
                new FileChooser.ExtensionFilter("SQL", "*.sql"),
                new FileChooser.ExtensionFilter("Excel", "*.xlsx", "*.xls"),
                new FileChooser.ExtensionFilter("All files", "*.*")
        );
        return readPickedFile(chooser.showOpenDialog(stage));
    }

    /**
     * Opens a native multi-file picker for SQL scripts.
     * Returns {@code {"files":[{name,path,content,base64},...]}} or empty string if cancelled.
     */
    public String pickSqlFiles() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("Open SQL files");
        chooser.getExtensionFilters().addAll(
                new FileChooser.ExtensionFilter("SQL files", "*.sql", "*.txt"),
                new FileChooser.ExtensionFilter("All files", "*.*")
        );
        var files = chooser.showOpenMultipleDialog(stage);
        if (files == null || files.isEmpty()) {
            return "";
        }
        StringBuilder sb = new StringBuilder("{\"files\":[");
        boolean first = true;
        for (File file : files) {
            String item = readPickedFile(file);
            if (item == null || item.isBlank()) {
                continue;
            }
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append(item);
        }
        if (first) {
            return "";
        }
        sb.append("]}");
        return sb.toString();
    }

    /**
     * Opens a native picker for a single SQL script (compat).
     * Prefer {@link #pickSqlFiles()} for multi-select.
     */
    public String pickSqlFile() {
        String multi = pickSqlFiles();
        if (multi == null || multi.isBlank()) {
            return "";
        }
        try {
            // Return the first file object for older callers.
            int start = multi.indexOf("{\"name\"");
            if (start < 0) {
                return "";
            }
            // Each file object is a complete JSON object from readPickedFile.
            int depth = 0;
            for (int i = start; i < multi.length(); i++) {
                char c = multi.charAt(i);
                if (c == '{') {
                    depth++;
                } else if (c == '}') {
                    depth--;
                    if (depth == 0) {
                        return multi.substring(start, i + 1);
                    }
                }
            }
            return "";
        } catch (Exception e) {
            return "{\"error\":" + jsonString(e.getMessage() == null ? "Failed to open file" : e.getMessage()) + "}";
        }
    }

    /**
     * Opens a native save dialog and writes {@code content} as UTF-8 text.
     * Returns {@code {"ok":true,"name":"...","path":"..."}} or empty string if cancelled.
     */
    public String saveSqlFile(String suggestedName, String content) {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("Save SQL query");
        chooser.getExtensionFilters().addAll(
                new FileChooser.ExtensionFilter("SQL files", "*.sql"),
                new FileChooser.ExtensionFilter("Text files", "*.txt"),
                new FileChooser.ExtensionFilter("All files", "*.*")
        );
        String initial = (suggestedName == null || suggestedName.isBlank()) ? "query.sql" : suggestedName.trim();
        if (!initial.toLowerCase(Locale.ROOT).endsWith(".sql")
                && !initial.toLowerCase(Locale.ROOT).endsWith(".txt")) {
            initial = initial + ".sql";
        }
        chooser.setInitialFileName(initial);
        File file = chooser.showSaveDialog(stage);
        if (file == null) {
            return "";
        }
        try {
            String path = file.getAbsolutePath();
            String lower = path.toLowerCase(Locale.ROOT);
            if (!lower.endsWith(".sql") && !lower.endsWith(".txt")
                    && chooser.getSelectedExtensionFilter() != null
                    && chooser.getSelectedExtensionFilter().getExtensions().contains("*.sql")) {
                file = new File(path + ".sql");
            }
            Files.writeString(file.toPath(), content == null ? "" : content, StandardCharsets.UTF_8);
            return "{\"ok\":true,\"name\":" + jsonString(file.getName())
                    + ",\"path\":" + jsonString(file.getAbsolutePath()) + "}";
        } catch (Exception e) {
            return "{\"error\":" + jsonString(e.getMessage() == null ? "Failed to save file" : e.getMessage()) + "}";
        }
    }

    private String readPickedFile(File file) {
        if (file == null) {
            return "";
        }
        try {
            String name = file.getName();
            String lower = name.toLowerCase(Locale.ROOT);
            boolean binary = lower.endsWith(".xlsx") || lower.endsWith(".xls");
            String content;
            if (binary) {
                content = Base64.getEncoder().encodeToString(Files.readAllBytes(file.toPath()));
            } else {
                content = Files.readString(file.toPath(), StandardCharsets.UTF_8);
            }
            return "{\"name\":" + jsonString(name)
                    + ",\"path\":" + jsonString(file.getAbsolutePath())
                    + ",\"base64\":" + binary
                    + ",\"content\":" + jsonString(content) + "}";
        } catch (Exception e) {
            return "{\"error\":" + jsonString(e.getMessage() == null ? "Failed to read file" : e.getMessage()) + "}";
        }
    }

    private static String jsonString(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"' -> sb.append("\\\"");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
        return sb.toString();
    }
}
