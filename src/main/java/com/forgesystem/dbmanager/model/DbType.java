package com.forgesystem.dbmanager.model;

public enum DbType {
    MYSQL("MySQL", "com.mysql.cj.jdbc.Driver", 3306, "jdbc:mysql://%s:%d/%s"),
    POSTGRESQL("PostgreSQL", "org.postgresql.Driver", 5432, "jdbc:postgresql://%s:%d/%s"),
    SQLITE("SQLite", "org.sqlite.JDBC", 0, "jdbc:sqlite:%s"),
    H2("H2", "org.h2.Driver", 9092, "jdbc:h2:tcp://%s:%d/%s"),
    H2_FILE("H2 (File)", "org.h2.Driver", 0, "jdbc:h2:%s"),
    SQLSERVER("SQL Server", "com.microsoft.sqlserver.jdbc.SQLServerDriver", 1433,
            "jdbc:sqlserver://%s:%d;databaseName=%s;encrypt=true;trustServerCertificate=true");

    private final String displayName;
    private final String driverClass;
    private final int defaultPort;
    private final String urlTemplate;

    DbType(String displayName, String driverClass, int defaultPort, String urlTemplate) {
        this.displayName = displayName;
        this.driverClass = driverClass;
        this.defaultPort = defaultPort;
        this.urlTemplate = urlTemplate;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getDriverClass() {
        return driverClass;
    }

    public int getDefaultPort() {
        return defaultPort;
    }

    public boolean isFileBased() {
        return this == SQLITE || this == H2_FILE;
    }

    public String buildUrl(String host, int port, String database) {
        if (this == SQLITE || this == H2_FILE) {
            return String.format(urlTemplate, database);
        }
        if (this == H2) {
            String db = (database == null || database.isBlank()) ? "~/testdb" : database;
            return String.format(urlTemplate, host, port, db);
        }
        String db = database == null ? "" : database;
        return String.format(urlTemplate, host, port, db);
    }

    @Override
    public String toString() {
        return displayName;
    }
}
