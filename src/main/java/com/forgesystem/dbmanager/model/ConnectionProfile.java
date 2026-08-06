package com.forgesystem.dbmanager.model;

import java.util.Objects;
import java.util.UUID;

public class ConnectionProfile {
    private String id;
    private String name;
    private DbType dbType;
    private String host;
    private int port;
    private String database;
    private String username;
    private String password;
    private boolean savePassword;

    public ConnectionProfile() {
        this.id = UUID.randomUUID().toString();
        this.host = "localhost";
        this.port = 3306;
        this.dbType = DbType.MYSQL;
        this.savePassword = false;
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

    public ConnectionProfile copy() {
        ConnectionProfile c = new ConnectionProfile();
        c.id = this.id;
        c.name = this.name;
        c.dbType = this.dbType;
        c.host = this.host;
        c.port = this.port;
        c.database = this.database;
        c.username = this.username;
        c.password = this.password;
        c.savePassword = this.savePassword;
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

    @Override
    public String toString() {
        return name != null && !name.isBlank() ? name : dbType.getDisplayName() + " @ " + host;
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
