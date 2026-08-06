package com.forgesystem.dbmanager.service;

import com.forgesystem.dbmanager.model.ConnectionProfile;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;

/**
 * Opens an SSH local port-forward so JDBC can reach a remote DB through a bastion host.
 */
public class SshTunnelService implements AutoCloseable {
    private Session session;
    private int localPort;

    public int open(ConnectionProfile profile) throws SQLException {
        close();

        String sshHost = blankToNull(profile.getSshHost());
        if (sshHost == null) {
            throw new SQLException("SSH tunnel requires an SSH host");
        }
        String sshUser = blankToNull(profile.getSshUsername());
        if (sshUser == null) {
            throw new SQLException("SSH tunnel requires an SSH username");
        }
        String dbHost = blankToNull(profile.getHost());
        if (dbHost == null) {
            throw new SQLException("Database host is required for SSH tunnel");
        }
        if (profile.getPort() <= 0) {
            throw new SQLException("Database port is required for SSH tunnel");
        }

        try {
            JSch jsch = new JSch();
            String keyPath = blankToNull(profile.getSshPrivateKeyPath());
            if (keyPath != null) {
                Path key = Path.of(keyPath);
                if (!Files.isRegularFile(key)) {
                    throw new SQLException("SSH private key not found: " + keyPath);
                }
                String passphrase = profile.getSshPassphrase();
                if (passphrase != null && !passphrase.isBlank()) {
                    jsch.addIdentity(key.toAbsolutePath().toString(), passphrase);
                } else {
                    jsch.addIdentity(key.toAbsolutePath().toString());
                }
            }

            session = jsch.getSession(sshUser, sshHost, profile.getSshPort());
            String sshPassword = profile.getSshPassword();
            if (sshPassword != null && !sshPassword.isBlank()) {
                session.setPassword(sshPassword);
            } else if (keyPath == null) {
                throw new SQLException("SSH tunnel requires an SSH password or private key");
            }

            java.util.Properties config = new java.util.Properties();
            config.put("StrictHostKeyChecking", "no");
            config.put("PreferredAuthentications", "publickey,password,keyboard-interactive");
            session.setConfig(config);
            session.connect(20_000);

            // Bind an ephemeral local port → remote DB host:port (as seen from the bastion)
            localPort = session.setPortForwardingL(0, dbHost, profile.getPort());
            return localPort;
        } catch (JSchException e) {
            close();
            throw new SQLException("SSH tunnel failed: " + e.getMessage(), e);
        }
    }

    public int getLocalPort() {
        return localPort;
    }

    public boolean isOpen() {
        return session != null && session.isConnected();
    }

    @Override
    public void close() {
        if (session != null) {
            try {
                if (session.isConnected()) {
                    session.disconnect();
                }
            } catch (Exception ignored) {
            }
            session = null;
            localPort = 0;
        }
    }

    private static String blankToNull(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        return s.trim();
    }
}
