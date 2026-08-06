package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ColumnInfo;
import com.forgesystem.dbmanager.model.QueryResult;
import com.forgesystem.dbmanager.util.SqlUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public class ImportExportService {
    private final DatabaseService databaseService;
    private final Gson gson = new GsonBuilder().serializeNulls().create();

    public ImportExportService(DatabaseService databaseService) {
        this.databaseService = databaseService;
    }

    public record ExportPayload(String filename, String contentType, String content, boolean base64) {
    }

    public ExportPayload exportTable(String schema, String table, String format, int limit) throws Exception {
        int rowLimit = limit <= 0 ? 100_000 : Math.min(limit, 500_000);
        QueryResult data = databaseService.previewTable(schema, table, rowLimit);
        String fmt = format == null ? "csv" : format.toLowerCase(Locale.ROOT);
        String safeName = (table == null ? "export" : table).replaceAll("[^a-zA-Z0-9._-]", "_");

        return switch (fmt) {
            case "json" -> new ExportPayload(
                    safeName + ".json",
                    "application/json",
                    gson.toJson(Map.of(
                            "schema", schema,
                            "table", table,
                            "columns", data.getColumnNames(),
                            "rows", data.getRows()
                    )),
                    false
            );
            case "sql" -> new ExportPayload(
                    safeName + ".sql",
                    "application/sql",
                    buildSqlDump(schema, table, data, true),
                    false
            );
            case "xlsx", "excel" -> {
                byte[] bytes = buildExcel(table, data);
                yield new ExportPayload(
                        safeName + ".xlsx",
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        Base64.getEncoder().encodeToString(bytes),
                        true
                );
            }
            default -> new ExportPayload(
                    safeName + ".csv",
                    "text/csv",
                    buildCsv(data),
                    false
            );
        };
    }

    public ExportPayload exportDatabaseSql(String schema, boolean includeData, int limitPerTable) throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("-- Forge Database Manager SQL export\n");
        sb.append("-- Schema/Database: ").append(schema).append("\n\n");
        List<String> tables = databaseService.listTables(schema);
        int limit = limitPerTable <= 0 ? 100_000 : Math.min(limitPerTable, 500_000);
        for (String table : tables) {
            String ddl = databaseService.getCreateStatement(schema, table);
            if (ddl != null && !ddl.isBlank()) {
                sb.append(ddl.trim());
                if (!ddl.trim().endsWith(";")) {
                    sb.append(";");
                }
                sb.append("\n\n");
            }
            if (includeData) {
                QueryResult data = databaseService.previewTable(schema, table, limit);
                sb.append(buildSqlDump(schema, table, data, false));
                sb.append("\n");
            }
        }
        for (String view : databaseService.listViews(schema)) {
            try {
                String ddl = databaseService.getCreateStatement(schema, view);
                if (ddl != null && !ddl.isBlank()) {
                    sb.append(ddl.trim());
                    if (!ddl.trim().endsWith(";")) {
                        sb.append(";");
                    }
                    sb.append("\n\n");
                }
            } catch (SQLException ignored) {
            }
        }
        String safe = schema == null ? "database" : schema.replaceAll("[^a-zA-Z0-9._-]", "_");
        return new ExportPayload(safe + "-export.sql", "application/sql", sb.toString(), false);
    }

    public Map<String, Object> importIntoTable(String schema, String table, String format,
                                              String content, boolean base64, boolean truncate,
                                              boolean headerRow) throws Exception {
        if (truncate) {
            databaseService.execute("DELETE FROM " + databaseService.qualify(schema, table));
        }
        String fmt = format == null ? "csv" : format.toLowerCase(Locale.ROOT);
        List<Map<String, Object>> rows = switch (fmt) {
            case "json" -> parseJsonRows(content);
            case "sql" -> {
                QueryResult result = databaseService.executeScript(content);
                yield List.of(Map.of("message", result.getMessage() == null ? "SQL executed" : result.getMessage()));
            }
            case "xlsx", "excel" -> parseExcelRows(content, base64, headerRow);
            default -> parseCsvRows(content, headerRow);
        };

        if ("sql".equals(fmt)) {
            return Map.of("ok", true, "imported", 0, "mode", "sql");
        }

        int imported = 0;
        List<String> errors = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            try {
                databaseService.insertRow(schema, table, row);
                imported++;
            } catch (SQLException e) {
                if (errors.size() < 20) {
                    errors.add(e.getMessage());
                }
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", errors.isEmpty());
        out.put("imported", imported);
        out.put("failed", rows.size() - imported);
        if (!errors.isEmpty()) {
            out.put("errors", errors);
        }
        return out;
    }

    public Map<String, Object> importSqlScript(String sql) throws SQLException {
        QueryResult result = databaseService.executeScript(sql);
        return Map.of(
                "ok", true,
                "message", result.getMessage() == null ? "Script executed" : result.getMessage(),
                "affected", result.getAffectedRows()
        );
    }

    private String buildCsv(QueryResult data) {
        StringBuilder sb = new StringBuilder();
        List<String> cols = data.getColumnNames();
        for (int i = 0; i < cols.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(SqlUtils.escapeCsv(cols.get(i)));
        }
        sb.append('\n');
        for (Map<String, Object> row : data.getRows()) {
            for (int i = 0; i < cols.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(SqlUtils.escapeCsv(row.get(cols.get(i))));
            }
            sb.append('\n');
        }
        return sb.toString();
    }

    private String buildSqlDump(String schema, String table, QueryResult data, boolean includeDdl) throws SQLException {
        StringBuilder sb = new StringBuilder();
        if (includeDdl) {
            String ddl = databaseService.getCreateStatement(schema, table);
            if (ddl != null && !ddl.isBlank()) {
                sb.append(ddl.trim());
                if (!ddl.trim().endsWith(";")) sb.append(';');
                sb.append("\n\n");
            }
        }
        List<String> cols = data.getColumnNames();
        if (cols.isEmpty()) {
            return sb.toString();
        }
        String colList = cols.stream().map(databaseService::quoteIdent).reduce((a, b) -> a + ", " + b).orElse("");
        String qualified = databaseService.qualify(schema, table);
        for (Map<String, Object> row : data.getRows()) {
            sb.append("INSERT INTO ").append(qualified).append(" (").append(colList).append(") VALUES (");
            for (int i = 0; i < cols.size(); i++) {
                if (i > 0) sb.append(", ");
                sb.append(databaseService.sqlLiteral(row.get(cols.get(i))));
            }
            sb.append(");\n");
        }
        return sb.toString();
    }

    private byte[] buildExcel(String sheetName, QueryResult data) throws IOException {
        try (Workbook wb = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = wb.createSheet(sheetName == null || sheetName.isBlank() ? "data" : sheetName);
            List<String> cols = data.getColumnNames();
            Row header = sheet.createRow(0);
            for (int i = 0; i < cols.size(); i++) {
                header.createCell(i).setCellValue(cols.get(i));
            }
            int r = 1;
            for (Map<String, Object> row : data.getRows()) {
                Row excelRow = sheet.createRow(r++);
                for (int i = 0; i < cols.size(); i++) {
                    Object v = row.get(cols.get(i));
                    Cell cell = excelRow.createCell(i);
                    if (v == null) {
                        cell.setBlank();
                    } else if (v instanceof Number n) {
                        cell.setCellValue(n.doubleValue());
                    } else if (v instanceof Boolean b) {
                        cell.setCellValue(b);
                    } else {
                        cell.setCellValue(String.valueOf(v));
                    }
                }
            }
            wb.write(out);
            return out.toByteArray();
        }
    }

    private List<Map<String, Object>> parseJsonRows(String content) {
        Type type = new TypeToken<List<Map<String, Object>>>() {}.getType();
        String trimmed = content == null ? "" : content.trim();
        if (trimmed.startsWith("{")) {
            Map<String, Object> wrapper = gson.fromJson(trimmed, new TypeToken<Map<String, Object>>() {}.getType());
            Object rows = wrapper.get("rows");
            if (rows != null) {
                return gson.fromJson(gson.toJson(rows), type);
            }
        }
        List<Map<String, Object>> rows = gson.fromJson(trimmed, type);
        return rows == null ? List.of() : rows;
    }

    private List<Map<String, Object>> parseCsvRows(String content, boolean headerRow) {
        List<String> lines = splitCsvLines(content == null ? "" : content);
        if (lines.isEmpty()) {
            return List.of();
        }
        List<String> headers;
        int start;
        if (headerRow) {
            headers = parseCsvLine(lines.get(0));
            start = 1;
        } else {
            List<String> first = parseCsvLine(lines.get(0));
            headers = new ArrayList<>();
            for (int i = 0; i < first.size(); i++) {
                headers.add("c" + (i + 1));
            }
            start = 0;
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = start; i < lines.size(); i++) {
            List<String> values = parseCsvLine(lines.get(i));
            if (values.stream().allMatch(String::isBlank)) {
                continue;
            }
            Map<String, Object> row = new LinkedHashMap<>();
            for (int c = 0; c < headers.size(); c++) {
                row.put(headers.get(c), c < values.size() ? values.get(c) : null);
            }
            rows.add(row);
        }
        return rows;
    }

    private List<Map<String, Object>> parseExcelRows(String content, boolean base64, boolean headerRow)
            throws IOException {
        byte[] bytes = base64
                ? Base64.getDecoder().decode(content)
                : content.getBytes(StandardCharsets.ISO_8859_1);
        try (Workbook wb = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            Sheet sheet = wb.getNumberOfSheets() > 0 ? wb.getSheetAt(0) : null;
            if (sheet == null) {
                return List.of();
            }
            DataFormatter formatter = new DataFormatter();
            List<String> headers = new ArrayList<>();
            List<Map<String, Object>> rows = new ArrayList<>();
            int first = sheet.getFirstRowNum();
            int last = sheet.getLastRowNum();
            for (int r = first; r <= last; r++) {
                Row row = sheet.getRow(r);
                if (row == null) continue;
                List<String> values = new ArrayList<>();
                short lastCell = row.getLastCellNum();
                for (int c = 0; c < lastCell; c++) {
                    Cell cell = row.getCell(c);
                    values.add(cell == null ? "" : formatter.formatCellValue(cell));
                }
                if (r == first && headerRow) {
                    headers.addAll(values);
                    continue;
                }
                if (headers.isEmpty()) {
                    for (int i = 0; i < values.size(); i++) {
                        headers.add("c" + (i + 1));
                    }
                }
                Map<String, Object> map = new LinkedHashMap<>();
                for (int i = 0; i < headers.size(); i++) {
                    map.put(headers.get(i), i < values.size() ? values.get(i) : null);
                }
                rows.add(map);
            }
            return rows;
        }
    }

    private static List<String> splitCsvLines(String content) {
        List<String> lines = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < content.length(); i++) {
            char c = content.charAt(i);
            if (c == '"') {
                inQuotes = !inQuotes;
                cur.append(c);
                continue;
            }
            if ((c == '\n' || c == '\r') && !inQuotes) {
                if (c == '\r' && i + 1 < content.length() && content.charAt(i + 1) == '\n') {
                    i++;
                }
                String line = cur.toString();
                if (!line.isBlank()) {
                    lines.add(line);
                }
                cur.setLength(0);
                continue;
            }
            cur.append(c);
        }
        if (!cur.isEmpty()) {
            lines.add(cur.toString());
        }
        return lines;
    }

    private static List<String> parseCsvLine(String line) {
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                        cur.append('"');
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    cur.append(c);
                }
            } else if (c == '"') {
                inQuotes = true;
            } else if (c == ',') {
                out.add(cur.toString());
                cur.setLength(0);
            } else {
                cur.append(c);
            }
        }
        out.add(cur.toString());
        return out;
    }
}
