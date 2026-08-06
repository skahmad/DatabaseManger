package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.DbType;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.Properties;

public class ConnectionService {
    private Connection connection;
    private ConnectionProfile profile;

    public synchronized void connect(ConnectionProfile profile) throws SQLException {
        disconnect();
        try {
            Class.forName(profile.getDbType().getDriverClass());
        } catch (ClassNotFoundException e) {
            throw new SQLException("JDBC driver not found: " + profile.getDbType().getDriverClass(), e);
        }

        Properties props = new Properties();
        if (profile.getUsername() != null && !profile.getUsername().isBlank()) {
            props.setProperty("user", profile.getUsername());
        }
        if (profile.getPassword() != null) {
            props.setProperty("password", profile.getPassword());
        }

        // Helpful defaults for MySQL
        if (profile.getDbType() == DbType.MYSQL) {
            props.setProperty("allowPublicKeyRetrieval", "true");
            props.setProperty("useSSL", "false");
            props.setProperty("serverTimezone", "UTC");
        }

        this.connection = DriverManager.getConnection(profile.getJdbcUrl(), props);
        this.connection.setAutoCommit(true);
        this.profile = profile.copy();
    }

    public synchronized void disconnect() {
        if (connection != null) {
            try {
                connection.close();
            } catch (SQLException ignored) {
            }
            connection = null;
            profile = null;
        }
    }

    public synchronized boolean isConnected() {
        try {
            return connection != null && !connection.isClosed();
        } catch (SQLException e) {
            return false;
        }
    }

    public synchronized Connection getConnection() throws SQLException {
        if (!isConnected()) {
            throw new SQLException("Not connected to a database");
        }
        return connection;
    }

    public ConnectionProfile getProfile() {
        return profile;
    }

    public synchronized void useDatabase(String databaseOrSchema) throws SQLException {
        Connection conn = getConnection();
        DbType type = profile.getDbType();
        switch (type) {
            case MYSQL -> {
                conn.createStatement().execute("USE `" + databaseOrSchema.replace("`", "``") + "`");
                profile.setDatabase(databaseOrSchema);
            }
            case POSTGRESQL -> {
                // Argument is a schema name within the already-connected database
                conn.createStatement().execute(
                        "SET search_path TO \"" + databaseOrSchema.replace("\"", "\"\"") + "\"");
            }
            case SQLSERVER -> {
                conn.createStatement().execute("USE [" + databaseOrSchema.replace("]", "]]") + "]");
                profile.setDatabase(databaseOrSchema);
            }
            case H2, H2_FILE -> { /* schema handled via metadata */ }
            case SQLITE -> { /* single database file */ }
        }
    }
}
