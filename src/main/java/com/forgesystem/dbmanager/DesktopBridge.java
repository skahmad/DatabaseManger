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
        File file = chooser.showOpenDialog(stage);
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
            // Minimal JSON (escape content carefully)
            return "{\"name\":" + jsonString(name)
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
