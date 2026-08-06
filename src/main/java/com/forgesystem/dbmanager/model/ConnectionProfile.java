package com.forgesystem.dbmanager.model;

import java.util.Objects;
import java.util.UUID;

public class ConnectionProfile {
    private String id;
    private String name;
    private DbType dbType;
    private ConnectionMode connectionMode;
    private String host;
    private int port;
    private String database;
    private String username;
    private String password;
    private boolean savePassword;

    /** Optional SSH tunnel (independent of 2/3-layer hierarchy). */
    private boolean useSshTunnel;
    private String sshHost;
    private int sshPort;
    private String sshUsername;
    private String sshPassword;
    private String sshPrivateKeyPath;
    private String sshPassphrase;
    private boolean saveSshPassword;

    public ConnectionProfile() {
        this.id = UUID.randomUUID().toString();
        this.host = "localhost";
        this.port = 3306;
        this.dbType = DbType.MYSQL;
        this.connectionMode = ConnectionMode.TWO_LAYER;
        this.savePassword = false;
        this.useSshTunnel = false;
        this.sshPort = 22;
        this.saveSshPassword = false;
    }

    public ConnectionProfile(String name, DbType dbType, String host, int port,
                             String database, String username, String password) {
        this();
        this.name = name;
        this.dbType = dbType;
        this.host = host;
        this.port = port;
        this.database = database;
        this.username = username;
        this.password = password;
    }

    public String getJdbcUrl() {
        return dbType.buildUrl(host, port, database);
    }

    public String getJdbcUrl(String jdbcHost, int jdbcPort) {
        return dbType.buildUrl(jdbcHost, jdbcPort, database);
    }

    public boolean usesSshTunnel() {
        if (dbType != null && dbType.isFileBased()) {
            return false;
        }
        return useSshTunnel;
    }

    /**
     * Migrate older profiles where THREE_LAYER meant “SSH tunnel”.
     * Hierarchy is reset to the engine default; SSH becomes {@link #useSshTunnel}.
     */
    public void migrateLegacySshAsThreeLayer() {
        if (useSshTunnel) {
            return;
        }
        if (connectionMode == ConnectionMode.THREE_LAYER
                && sshHost != null && !sshHost.isBlank()) {
            useSshTunnel = true;
            connectionMode = ConnectionMode.defaultFor(dbType);
        }
    }

    public ConnectionProfile copy() {
        ConnectionProfile c = new ConnectionProfile();
        c.id = this.id;
        c.name = this.name;
        c.dbType = this.dbType;
        c.connectionMode = this.connectionMode;
        c.host = this.host;
        c.port = this.port;
        c.database = this.database;
        c.username = this.username;
        c.password = this.password;
        c.savePassword = this.savePassword;
        c.useSshTunnel = this.useSshTunnel;
        c.sshHost = this.sshHost;
        c.sshPort = this.sshPort;
        c.sshUsername = this.sshUsername;
        c.sshPassword = this.sshPassword;
        c.sshPrivateKeyPath = this.sshPrivateKeyPath;
        c.sshPassphrase = this.sshPassphrase;
        c.saveSshPassword = this.saveSshPassword;
        return c;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public DbType getDbType() {
        return dbType;
    }

    public void setDbType(DbType dbType) {
        this.dbType = dbType;
    }

    public ConnectionMode getConnectionMode() {
        return connectionMode == null ? ConnectionMode.TWO_LAYER : connectionMode;
    }

    public void setConnectionMode(ConnectionMode connectionMode) {
        this.connectionMode = connectionMode == null ? ConnectionMode.TWO_LAYER : connectionMode;
    }

    public boolean isUseSshTunnel() {
        return useSshTunnel;
    }

    public void setUseSshTunnel(boolean useSshTunnel) {
        this.useSshTunnel = useSshTunnel;
    }

    public String getHost() {
        return host;
    }

    public void setHost(String host) {
        this.host = host;
    }

    public int getPort() {
        return port;
    }

    public void setPort(int port) {
        this.port = port;
    }

    public String getDatabase() {
        return database;
    }

    public void setDatabase(String database) {
        this.database = database;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        this.password = password;
    }

    public boolean isSavePassword() {
        return savePassword;
    }

    public void setSavePassword(boolean savePassword) {
        this.savePassword = savePassword;
    }

    public String getSshHost() {
        return sshHost;
    }

    public void setSshHost(String sshHost) {
        this.sshHost = sshHost;
    }

    public int getSshPort() {
        return sshPort <= 0 ? 22 : sshPort;
    }

    public void setSshPort(int sshPort) {
        this.sshPort = sshPort;
    }

    public String getSshUsername() {
        return sshUsername;
    }

    public void setSshUsername(String sshUsername) {
        this.sshUsername = sshUsername;
    }

    public String getSshPassword() {
        return sshPassword;
    }

    public void setSshPassword(String sshPassword) {
        this.sshPassword = sshPassword;
    }

    public String getSshPrivateKeyPath() {
        return sshPrivateKeyPath;
    }

    public void setSshPrivateKeyPath(String sshPrivateKeyPath) {
        this.sshPrivateKeyPath = sshPrivateKeyPath;
    }

    public String getSshPassphrase() {
        return sshPassphrase;
    }

    public void setSshPassphrase(String sshPassphrase) {
        this.sshPassphrase = sshPassphrase;
    }

    public boolean isSaveSshPassword() {
        return saveSshPassword;
    }

    public void setSaveSshPassword(boolean saveSshPassword) {
        this.saveSshPassword = saveSshPassword;
    }

    @Override
    public String toString() {
        String base = name != null && !name.isBlank() ? name : dbType.getDisplayName() + " @ " + host;
        if (usesSshTunnel()) {
            return base + " via SSH " + (sshHost == null ? "" : sshHost);
        }
        return base;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof ConnectionProfile that)) return false;
        return Objects.equals(id, that.id);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id);
    }
}
