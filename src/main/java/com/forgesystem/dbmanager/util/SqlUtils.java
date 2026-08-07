package com.forgesystem.dbmanager.util;

import java.util.ArrayList;
import java.util.List;

public final class SqlUtils {
    private SqlUtils() {
    }

    /**
     * Splits a SQL script into individual statements on semicolons,
     * ignoring semicolons inside quotes, dollar-quotes (PostgreSQL), or comments.
     */
    public static List<String> splitStatements(String script) {
        List<String> result = new ArrayList<>();
        if (script == null || script.isBlank()) {
            return result;
        }

        StringBuilder current = new StringBuilder();
        boolean inSingle = false;
        boolean inDouble = false;
        boolean inLineComment = false;
        boolean inBlockComment = false;
        String dollarTag = null; // e.g. "$$" or "$body$"

        for (int i = 0; i < script.length(); i++) {
            char c = script.charAt(i);
            char next = i + 1 < script.length() ? script.charAt(i + 1) : '\0';

            if (dollarTag != null) {
                if (startsWithAt(script, i, dollarTag)) {
                    current.append(dollarTag);
                    i += dollarTag.length() - 1;
                    dollarTag = null;
                } else {
                    current.append(c);
                }
                continue;
            }

            if (inLineComment) {
                current.append(c);
                if (c == '\n') {
                    inLineComment = false;
                }
                continue;
            }
            if (inBlockComment) {
                current.append(c);
                if (c == '*' && next == '/') {
                    current.append(next);
                    i++;
                    inBlockComment = false;
                }
                continue;
            }

            if (!inSingle && !inDouble) {
                if (c == '-' && next == '-') {
                    inLineComment = true;
                    current.append(c);
                    continue;
                }
                if (c == '/' && next == '*') {
                    inBlockComment = true;
                    current.append(c);
                    continue;
                }
                if (c == '$') {
                    String tag = readDollarQuoteTag(script, i);
                    if (tag != null) {
                        dollarTag = tag;
                        current.append(tag);
                        i += tag.length() - 1;
                        continue;
                    }
                }
            }

            if (c == '\'' && !inDouble) {
                current.append(c);
                // SQL escaped quote: ''
                if (inSingle && next == '\'') {
                    current.append(next);
                    i++;
                } else {
                    inSingle = !inSingle;
                }
                continue;
            }
            if (c == '"' && !inSingle) {
                inDouble = !inDouble;
                current.append(c);
                continue;
            }

            if (c == ';' && !inSingle && !inDouble) {
                String stmt = current.toString().trim();
                if (!stmt.isEmpty()) {
                    result.add(stmt);
                }
                current.setLength(0);
                continue;
            }

            current.append(c);
        }

        String last = current.toString().trim();
        if (!last.isEmpty()) {
            result.add(last);
        }
        return result;
    }

    /**
     * Reads a PostgreSQL dollar-quote delimiter starting at {@code index}
     * ({@code $$} or {@code $tag$}). Returns null if this {@code $} is not a delimiter.
     */
    static String readDollarQuoteTag(String script, int index) {
        if (index < 0 || index >= script.length() || script.charAt(index) != '$') {
            return null;
        }
        int i = index + 1;
        while (i < script.length()) {
            char c = script.charAt(i);
            if (c == '$') {
                return script.substring(index, i + 1);
            }
            // Tag follows unquoted-identifier rules, minus '$'.
            boolean first = i == index + 1;
            if (isDollarTagChar(c, first)) {
                i++;
                continue;
            }
            return null;
        }
        return null;
    }

    private static boolean isDollarTagChar(char c, boolean first) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_') {
            return true;
        }
        return !first && c >= '0' && c <= '9';
    }

    private static boolean startsWithAt(String script, int index, String token) {
        if (index + token.length() > script.length()) {
            return false;
        }
        return script.regionMatches(index, token, 0, token.length());
    }

    public static String escapeCsv(Object value) {
        if (value == null) {
            return "";
        }
        String s = value.toString();
        if (s.contains(",") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }
}
