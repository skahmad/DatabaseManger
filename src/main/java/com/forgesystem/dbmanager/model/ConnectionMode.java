package com.forgesystem.dbmanager.model;

/**
 * Explorer / object hierarchy for a connection.
 * <ul>
 *   <li>{@link #TWO_LAYER} — database → tables (no schema level).</li>
 *   <li>{@link #THREE_LAYER} — database → schemas → tables.</li>
 * </ul>
 */
public enum ConnectionMode {
    TWO_LAYER("2-layer", "Database → tables"),
    THREE_LAYER("3-layer", "Database → schemas → tables");

    private final String displayName;
    private final String description;

    ConnectionMode(String displayName, String description) {
        this.displayName = displayName;
        this.description = description;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getDescription() {
        return description;
    }

    /** Default hierarchy for an engine. */
    public static ConnectionMode defaultFor(DbType type) {
        if (type == null) {
            return TWO_LAYER;
        }
        return switch (type) {
            case POSTGRESQL, H2, H2_FILE, SQLSERVER -> THREE_LAYER;
            default -> TWO_LAYER;
        };
    }
}
