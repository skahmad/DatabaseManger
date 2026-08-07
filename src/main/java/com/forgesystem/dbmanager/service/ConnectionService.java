package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ConnectionMode;
import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.forgesystem.dbmanager.model.DbType;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * Manages multiple concurrent JDBC sessions keyed by connection profile id.
 * Request handlers may bind a session id via {@link #bindRequestSession(String)} so
 * parallel API calls (e.g. loading two explorer trees) do not race on {@code activeId}.
 */
public class ConnectionService {
    private final Map<String, DbSession> sessions = new LinkedHashMap<>();
    private String activeId;
    /** Per-request override — does not change the UI "active" session. */
    private final ThreadLocal<String> requestSessionId = new ThreadLocal<>();

    public void bindRequestSession(String profileId) {
        if (profileId == null || profileId.isBlank()) {
            requestSessionId.remove();
        } else {
            requestSessionId.set(profileId);
        }
    }

    public void clearRequestSession() {
        requestSessionId.remove();
    }

    public synchronized void connect(ConnectionProfile profile) throws SQLException {
        normalizeProfile(profile);
        if (profile.getId() == null || profile.getId().isBlank()) {
            throw new SQLException("Connection profile id is required");
        }

        // Replace only this profile's prior session — keep other connections open.
        disconnect(profile.getId());

        OpenedConnection opened = openJdbc(profile);
        try {
            DbSession session = new DbSession(profile.copy(), opened.connection, opened.tunnel);
            sessions.put(profile.getId(), session);
            activeId = profile.getId();
        } catch (RuntimeException e) {
            opened.closeQuietly();
            throw e;
        }
    }

    /**
     * Opens a JDBC connection (and optional SSH tunnel), runs a trivial probe, then closes.
     * Does not keep a session.
     */
    public void testConnection(ConnectionProfile profile) throws SQLException {
        normalizeProfile(profile);
        OpenedConnection opened = openJdbc(profile);
        try (Connection connection = opened.connection) {
            try (var st = connection.createStatement()) {
                st.execute("SELECT 1");
            }
        } finally {
            if (opened.tunnel != null) {
                opened.tunnel.close();
            }
        }
    }

    private void normalizeProfile(ConnectionProfile profile) {
        if (profile.getDbType() != null && profile.getDbType().isFileBased()) {
            profile.setUseSshTunnel(false);
            profile.setConnectionMode(ConnectionMode.TWO_LAYER);
        } else if (profile.getDbType() == DbType.POSTGRESQL
                || profile.getDbType() == DbType.H2
                || profile.getDbType() == DbType.H2_FILE) {
            // PostgreSQL / H2 always use database → schemas → tables
            profile.setConnectionMode(ConnectionMode.THREE_LAYER);
        } else if (profile.getConnectionMode() == null) {
            profile.setConnectionMode(ConnectionMode.defaultFor(profile.getDbType()));
        }
    }

    private OpenedConnection openJdbc(ConnectionProfile profile) throws SQLException {
        if (profile.getDbType() == null) {
            throw new SQLException("Database type is required");
        }
        try {
            Class.forName(profile.getDbType().getDriverClass());
        } catch (ClassNotFoundException e) {
            throw new SQLException("JDBC driver not found: " + profile.getDbType().getDriverClass(), e);
        }

        SshTunnelService tunnel = null;
        String jdbcUrl;
        if (profile.usesSshTunnel()) {
            tunnel = new SshTunnelService();
            int localPort = tunnel.open(profile);
            jdbcUrl = profile.getJdbcUrl("127.0.0.1", localPort);
        } else {
            jdbcUrl = profile.getJdbcUrl();
        }

        Properties props = new Properties();
        if (profile.getUsername() != null && !profile.getUsername().isBlank()) {
            props.setProperty("user", profile.getUsername());
        }
        if (profile.getPassword() != null) {
            props.setProperty("password", profile.getPassword());
        }
        if (profile.getDbType() == DbType.MYSQL) {
            props.setProperty("allowPublicKeyRetrieval", "true");
            props.setProperty("useSSL", "false");
            props.setProperty("serverTimezone", "UTC");
        }

        try {
            Connection connection = DriverManager.getConnection(jdbcUrl, props);
            connection.setAutoCommit(true);
            return new OpenedConnection(connection, tunnel);
        } catch (SQLException e) {
            if (tunnel != null) {
                tunnel.close();
            }
            throw e;
        }
    }

    private static final class OpenedConnection {
        private final Connection connection;
        private final SshTunnelService tunnel;

        private OpenedConnection(Connection connection, SshTunnelService tunnel) {
            this.connection = connection;
            this.tunnel = tunnel;
        }

        private void closeQuietly() {
            if (connection != null) {
                try {
                    connection.close();
                } catch (SQLException ignored) {
                }
            }
            if (tunnel != null) {
                tunnel.close();
            }
        }
    }

    public synchronized void disconnect() {
        if (activeId != null) {
            disconnect(activeId);
        }
    }

    public synchronized void disconnect(String profileId) {
        if (profileId == null) {
            return;
        }
        DbSession session = sessions.remove(profileId);
        if (session != null) {
            session.close();
        }
        if (profileId.equals(activeId)) {
            activeId = sessions.isEmpty() ? null : sessions.keySet().iterator().next();
        }
    }

    public synchronized void disconnectAll() {
        for (DbSession session : new ArrayList<>(sessions.values())) {
            session.close();
        }
        sessions.clear();
        activeId = null;
    }

    public synchronized boolean setActive(String profileId) {
        if (profileId == null || !isConnected(profileId)) {
            return false;
        }
        activeId = profileId;
        return true;
    }

    public synchronized String getActiveId() {
        return activeId;
    }

    public synchronized boolean isConnected() {
        return activeId != null && isConnected(activeId);
    }

    public synchronized boolean isConnected(String profileId) {
        DbSession session = sessions.get(profileId);
        return session != null && session.isOpen();
    }

    public synchronized boolean isSshTunnelActive() {
        DbSession session = resolveSession();
        return session != null && session.sshTunnel != null && session.sshTunnel.isOpen();
    }

    public synchronized Connection getConnection() throws SQLException {
        DbSession session = resolveSession();
        if (session == null || !session.isOpen()) {
            throw new SQLException("Not connected to a database");
        }
        return session.connection;
    }

    public synchronized Connection getConnection(String profileId) throws SQLException {
        DbSession session = sessions.get(profileId);
        if (session == null || !session.isOpen()) {
            throw new SQLException("Not connected: " + profileId);
        }
        return session.connection;
    }

    public synchronized ConnectionProfile getProfile() {
        DbSession session = resolveSession();
        return session == null ? null : session.profile;
    }

    public synchronized ConnectionProfile getProfile(String profileId) {
        DbSession session = sessions.get(profileId);
        return session == null ? null : session.profile;
    }

    public synchronized List<ConnectionProfile> listConnectedProfiles() {
        List<ConnectionProfile> out = new ArrayList<>();
        for (DbSession session : sessions.values()) {
            if (session.isOpen()) {
                out.add(session.profile.copy());
            }
        }
        return out;
    }

    public synchronized void useDatabase(String databaseOrSchema) throws SQLException {
        DbSession session = resolveSession();
        if (session == null) {
            throw new SQLException("Not connected to a database");
        }
        Connection conn = session.connection;
        DbType type = session.profile.getDbType();
        switch (type) {
            case MYSQL -> {
                conn.createStatement().execute("USE `" + databaseOrSchema.replace("`", "``") + "`");
                session.profile.setDatabase(databaseOrSchema);
            }
            case POSTGRESQL -> conn.createStatement().execute(
                    "SET search_path TO \"" + databaseOrSchema.replace("\"", "\"\"") + "\"");
            case SQLSERVER -> {
                conn.createStatement().execute("USE [" + databaseOrSchema.replace("]", "]]") + "]");
                session.profile.setDatabase(databaseOrSchema);
            }
            case H2, H2_FILE -> { /* schema handled via metadata */ }
            case SQLITE -> { /* single database file */ }
        }
    }

    /**
     * Apply optional database + schema context before running ad-hoc SQL.
     * <ul>
     *   <li>MySQL / SQL Server: {@code database} switches catalog ({@code USE}).</li>
     *   <li>PostgreSQL: {@code database} switches catalog; {@code schema} sets {@code search_path}.</li>
     *   <li>When only database is set on 3-layer engines, catalog is switched and search_path is left alone.</li>
     * </ul>
     */
    public synchronized void applyQueryContext(String database, String schema) throws SQLException {
        DbSession session = resolveSession();
        if (session == null) {
            throw new SQLException("Not connected to a database");
        }
        Connection conn = session.connection;
        DbType type = session.profile.getDbType();
        String db = blankToNull(database);
        String sch = blankToNull(schema);

        switch (type) {
            case MYSQL -> {
                String target = db != null ? db : sch;
                if (target != null) {
                    useDatabase(target);
                }
            }
            case SQLSERVER -> {
                if (db != null) {
                    useDatabase(db);
                }
                // Schema is typically qualified in SQL; default schema cannot be safely changed per query.
            }
            case POSTGRESQL -> {
                if (db != null) {
                    switchCatalog(conn, db);
                    session.profile.setDatabase(db);
                }
                if (sch != null) {
                    useDatabase(sch);
                }
            }
            case H2, H2_FILE -> {
                if (sch != null) {
                    conn.createStatement().execute(
                            "SET SCHEMA \"" + sch.replace("\"", "\"\"") + "\"");
                }
            }
            case SQLITE -> { /* single file database */ }
        }
    }

    /** Switch PostgreSQL / SQL Server catalog when supported by the driver. */
    private static void switchCatalog(Connection conn, String catalog) throws SQLException {
        if (catalog == null || catalog.isBlank()) {
            return;
        }
        try {
            String current = conn.getCatalog();
            if (catalog.equals(current)) {
                return;
            }
        } catch (SQLException ignored) {
        }
        conn.setCatalog(catalog);
    }

    private static String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** Prefer request-bound session (parallel-safe); otherwise the UI active session. */
    private DbSession resolveSession() {
        String bound = requestSessionId.get();
        if (bound != null) {
            DbSession session = sessions.get(bound);
            if (session != null && session.isOpen()) {
                return session;
            }
            return null;
        }
        return activeSession();
    }

    private DbSession activeSession() {
        if (activeId == null) {
            return null;
        }
        DbSession session = sessions.get(activeId);
        if (session == null || !session.isOpen()) {
            sessions.remove(activeId);
            activeId = sessions.isEmpty() ? null : sessions.keySet().iterator().next();
            return activeId == null ? null : sessions.get(activeId);
        }
        return session;
    }

    private static final class DbSession {
        private final ConnectionProfile profile;
        private final Connection connection;
        private final SshTunnelService sshTunnel;

        private DbSession(ConnectionProfile profile, Connection connection, SshTunnelService sshTunnel) {
            this.profile = profile;
            this.connection = connection;
            this.sshTunnel = sshTunnel;
        }

        private boolean isOpen() {
            try {
                return connection != null && !connection.isClosed();
            } catch (SQLException e) {
                return false;
            }
        }

        private void close() {
            if (connection != null) {
                try {
                    connection.close();
                } catch (SQLException ignored) {
                }
            }
            if (sshTunnel != null) {
                sshTunnel.close();
            }
        }
    }
}
