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
 *
 * <p>Each session owns one <em>primary</em> connection (the database named on the
 * profile, or the server default when the profile leaves it blank) plus a lazily
 * opened pool of <em>catalog</em> connections — one per additional database the
 * user browses. This is what makes server-wide browsing possible on engines where
 * a connection is permanently bound to a single database: PostgreSQL cannot switch
 * catalogs at all ({@code setCatalog} is a no-op in pgjdbc), so the only correct
 * way to read another database is a second physical connection.
 *
 * <p>Request handlers bind a session id via {@link #bindRequestSession(String)} and
 * a catalog via {@link #bindRequestDatabase(String)} so parallel API calls (two
 * explorer trees, two databases) neither race on {@code activeId} nor on each
 * other's current catalog.
 */
public class ConnectionService {
    /**
     * Extra catalog connections kept open per session. The primary connection is
     * always retained; beyond this cap the least recently used catalog is closed.
     */
    private static final int MAX_CATALOG_CONNECTIONS = 8;

    private final Map<String, DbSession> sessions = new LinkedHashMap<>();
    private String activeId;
    /** Per-request override — does not change the UI "active" session. */
    private final ThreadLocal<String> requestSessionId = new ThreadLocal<>();
    /** Per-request catalog override — selects which database connection is returned. */
    private final ThreadLocal<String> requestDatabase = new ThreadLocal<>();

    public void bindRequestSession(String profileId) {
        if (profileId == null || profileId.isBlank()) {
            requestSessionId.remove();
        } else {
            requestSessionId.set(profileId);
        }
    }

    /**
     * Route {@link #getConnection()} for this request to a specific database.
     * Ignored by engines that cannot host more than one database per server.
     */
    public void bindRequestDatabase(String database) {
        if (database == null || database.isBlank()) {
            requestDatabase.remove();
        } else {
            requestDatabase.set(database.trim());
        }
    }

    /** Database bound to the current request, or {@code null} for the profile default. */
    public String getRequestDatabase() {
        return requestDatabase.get();
    }

    public void clearRequestSession() {
        requestSessionId.remove();
        requestDatabase.remove();
    }

    /** True when one server hosts several databases reachable with the same credentials. */
    public static boolean supportsMultipleCatalogs(DbType type) {
        if (type == null) {
            return false;
        }
        return switch (type) {
            case MYSQL, MARIADB, POSTGRESQL, SQLSERVER -> true;
            case SQLITE, H2, H2_FILE -> false;
        };
    }

    public synchronized void connect(ConnectionProfile profile) throws SQLException {
        normalizeProfile(profile);
        if (profile.getId() == null || profile.getId().isBlank()) {
            throw new SQLException("Connection profile id is required");
        }

        // Replace only this profile's prior session — keep other connections open.
        disconnect(profile.getId());

        SshTunnelService tunnel = null;
        try {
            tunnel = openTunnelIfNeeded(profile);
            Connection connection = openConnection(profile, profile.getDatabase(), tunnel);
            DbSession session = new DbSession(profile.copy(), tunnel, normalizeCatalog(profile.getDatabase()));
            session.adoptPrimary(connection);
            sessions.put(profile.getId(), session);
            activeId = profile.getId();
        } catch (SQLException | RuntimeException e) {
            if (tunnel != null) {
                tunnel.close();
            }
            throw e;
        }
    }

    /**
     * Opens a JDBC connection (and optional SSH tunnel), runs a trivial probe, then closes.
     * Does not keep a session.
     */
    public void testConnection(ConnectionProfile profile) throws SQLException {
        normalizeProfile(profile);
        SshTunnelService tunnel = openTunnelIfNeeded(profile);
        try (Connection connection = openConnection(profile, profile.getDatabase(), tunnel)) {
            try (var st = connection.createStatement()) {
                st.execute("SELECT 1");
            }
        } finally {
            if (tunnel != null) {
                tunnel.close();
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
            // PostgreSQL / H2 always use database -> schemas -> tables
            profile.setConnectionMode(ConnectionMode.THREE_LAYER);
        } else if (profile.getConnectionMode() == null) {
            profile.setConnectionMode(ConnectionMode.defaultFor(profile.getDbType()));
        }
    }

    private SshTunnelService openTunnelIfNeeded(ConnectionProfile profile) throws SQLException {
        if (!profile.usesSshTunnel()) {
            return null;
        }
        SshTunnelService tunnel = new SshTunnelService();
        tunnel.open(profile);
        return tunnel;
    }

    /**
     * Opens one JDBC connection for {@code database} (blank = the server default).
     * The tunnel, when present, is shared by every connection of the session.
     */
    private Connection openConnection(ConnectionProfile profile, String database, SshTunnelService tunnel)
            throws SQLException {
        if (profile.getDbType() == null) {
            throw new SQLException("Database type is required");
        }
        try {
            Class.forName(profile.getDbType().getDriverClass());
        } catch (ClassNotFoundException e) {
            throw new SQLException("JDBC driver not found: " + profile.getDbType().getDriverClass(), e);
        }

        ConnectionProfile target = profile;
        if (!profile.getDbType().isFileBased()
                && database != null
                && !database.isBlank()
                && !database.equals(profile.getDatabase())) {
            target = profile.copy();
            target.setDatabase(database);
        }

        String jdbcUrl = (tunnel != null && tunnel.isOpen())
                ? target.getJdbcUrl("127.0.0.1", tunnel.getLocalPort())
                : target.getJdbcUrl();

        Properties props = new Properties();
        if (profile.getUsername() != null && !profile.getUsername().isBlank()) {
            props.setProperty("user", profile.getUsername());
        }
        if (profile.getPassword() != null) {
            props.setProperty("password", profile.getPassword());
        }
        if (profile.getDbType().isMysqlFamily()) {
            // MariaDB Java Client properties (used for both MySQL and MariaDB servers).
            props.setProperty("allowPublicKeyRetrieval", "true");
            props.setProperty("sslMode", "disable");
            props.setProperty("useSsl", "false");
            props.setProperty("serverTimezone", "UTC");
            // Remote / cross-region: fail instead of hanging forever.
            props.setProperty("connectTimeout", "15000");
            props.setProperty("socketTimeout", "120000");
        }

        try {
            Connection connection = DriverManager.getConnection(jdbcUrl, props);
            connection.setAutoCommit(true);
            return connection;
        } catch (SQLException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.toLowerCase().contains("query_cache_size")) {
                throw new SQLException(
                        "Server rejected MySQL Connector handshake (unknown variable query_cache_size). "
                                + "This usually means MariaDB/MySQL 8+ behind a proxy with a mismatched JDBC driver. "
                                + "Reconnect with the latest DB Pilot build (MariaDB JDBC client).",
                        e);
            }
            throw e;
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

    /** Connection for the current request's session and catalog. */
    public synchronized Connection getConnection() throws SQLException {
        DbSession session = resolveSession();
        if (session == null || !session.isOpen()) {
            throw new SQLException("Not connected to a database");
        }
        return session.connectionFor(requestDatabase.get());
    }

    public synchronized Connection getConnection(String profileId) throws SQLException {
        return getConnection(profileId, null);
    }

    /** Connection to a specific database of a specific session, opened on demand. */
    public synchronized Connection getConnection(String profileId, String database) throws SQLException {
        DbSession session = sessions.get(profileId);
        if (session == null || !session.isOpen()) {
            throw new SQLException("Not connected: " + profileId);
        }
        return session.connectionFor(database);
    }

    /** The database the current request is pinned to, or the profile's own database. */
    public synchronized String currentDatabase() {
        DbSession session = resolveSession();
        if (session == null) {
            return null;
        }
        String bound = requestDatabase.get();
        if (bound != null && !bound.isBlank() && supportsMultipleCatalogs(session.profile.getDbType())) {
            return bound;
        }
        return session.profile.getDatabase();
    }

    /** Databases of this session that currently hold an open connection. */
    public synchronized List<String> openCatalogs() {
        DbSession session = resolveSession();
        return session == null ? List.of() : session.openCatalogNames();
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

    /**
     * Switch the working database/schema of the current connection.
     * On multi-catalog engines the caller normally binds a catalog instead — this
     * remains for schema-level switches and for callers that drive one connection
     * through several databases in sequence (clone / migrate).
     */
    public synchronized void useDatabase(String databaseOrSchema) throws SQLException {
        DbSession session = resolveSession();
        if (session == null) {
            throw new SQLException("Not connected to a database");
        }
        Connection conn = session.connectionFor(requestDatabase.get());
        DbType type = session.profile.getDbType();
        switch (type) {
            case MYSQL, MARIADB -> {
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
     *
     * <p>The database is applied by <em>selecting the connection bound to it</em>,
     * not by asking the driver to switch catalog: {@code Connection.setCatalog} is
     * silently ignored by pgjdbc, which previously let a query run against the
     * wrong database while the UI reported the switch as successful.
     */
    public synchronized void applyQueryContext(String database, String schema) throws SQLException {
        DbSession session = resolveSession();
        if (session == null) {
            throw new SQLException("Not connected to a database");
        }
        DbType type = session.profile.getDbType();
        String db = blankToNull(database);
        String sch = blankToNull(schema);

        if (db != null && supportsMultipleCatalogs(type)) {
            bindRequestDatabase(db);
        }
        Connection conn = session.connectionFor(requestDatabase.get());

        switch (type) {
            case MYSQL, MARIADB -> {
                // On MySQL a schema *is* a database; keep the session default aligned
                // so unqualified names resolve the way the user expects.
                String target = db != null ? db : sch;
                if (target != null) {
                    conn.createStatement().execute("USE `" + target.replace("`", "``") + "`");
                }
            }
            case SQLSERVER -> {
                // Catalog comes from the per-database connection; schema is qualified in SQL.
            }
            case POSTGRESQL -> {
                if (sch != null) {
                    conn.createStatement().execute(
                            "SET search_path TO \"" + sch.replace("\"", "\"\"") + "\"");
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

    private static String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private static String normalizeCatalog(String database) {
        return database == null ? "" : database.trim();
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

    /**
     * One live connection profile: the primary connection plus any additional
     * per-database connections opened while browsing the server.
     */
    private final class DbSession {
        private final ConnectionProfile profile;
        private final SshTunnelService sshTunnel;
        /** Catalog key of the primary connection ("" when the profile named no database). */
        private final String primaryKey;
        /** Catalog name -> connection. Access order, so eviction drops the coldest. */
        private final Map<String, CatalogConnection> catalogs =
                new LinkedHashMap<>(16, 0.75f, true);

        private DbSession(ConnectionProfile profile, SshTunnelService sshTunnel, String primaryKey) {
            this.profile = profile;
            this.sshTunnel = sshTunnel;
            this.primaryKey = primaryKey;
        }

        private void adoptPrimary(Connection connection) {
            catalogs.put(primaryKey, new CatalogConnection(connection));
        }

        private boolean isOpen() {
            CatalogConnection primary = catalogs.get(primaryKey);
            return primary != null && primary.isOpen();
        }

        private Connection requirePrimary() throws SQLException {
            CatalogConnection primary = catalogs.get(primaryKey);
            if (primary == null || !primary.isOpen()) {
                throw new SQLException("Not connected to a database");
            }
            return primary.connection;
        }

        /**
         * Connection for {@code database}, opening one if this session has not
         * reached that catalog yet. Falls back to the primary connection for
         * single-database engines and for the profile's own database.
         */
        private Connection connectionFor(String database) throws SQLException {
            String key = normalizeCatalog(database);
            if (key.isEmpty()
                    || key.equals(primaryKey)
                    || !supportsMultipleCatalogs(profile.getDbType())) {
                return requirePrimary();
            }

            CatalogConnection existing = catalogs.get(key);
            if (existing != null) {
                if (existing.isOpen()) {
                    return existing.connection;
                }
                catalogs.remove(key);
            }

            // Keep the pool bounded: close the least recently used non-primary catalog.
            evictColdCatalogs();

            Connection opened = openConnection(profile, key, sshTunnel);
            catalogs.put(key, new CatalogConnection(opened));
            return opened;
        }

        private void evictColdCatalogs() {
            while (catalogs.size() > MAX_CATALOG_CONNECTIONS) {
                String coldest = null;
                for (String key : catalogs.keySet()) {
                    if (!key.equals(primaryKey)) {
                        coldest = key;
                        break;
                    }
                }
                if (coldest == null) {
                    return;
                }
                CatalogConnection evicted = catalogs.remove(coldest);
                if (evicted != null) {
                    evicted.close();
                }
            }
        }

        private List<String> openCatalogNames() {
            List<String> names = new ArrayList<>();
            for (Map.Entry<String, CatalogConnection> e : catalogs.entrySet()) {
                if (!e.getKey().isEmpty() && e.getValue().isOpen()) {
                    names.add(e.getKey());
                }
            }
            return names;
        }

        private void close() {
            for (CatalogConnection c : new ArrayList<>(catalogs.values())) {
                c.close();
            }
            catalogs.clear();
            if (sshTunnel != null) {
                sshTunnel.close();
            }
        }
    }

    /** A single JDBC connection bound to one database. */
    private static final class CatalogConnection {
        private final Connection connection;

        private CatalogConnection(Connection connection) {
            this.connection = connection;
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
        }
    }
}
