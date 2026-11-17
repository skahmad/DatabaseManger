package com.forgesystem.dbmanager.util;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Console log of every query DB Pilot sends to a database server.
 *
 * <p>Each JDBC connection is wrapped so that executed statements and metadata lookups
 * (which drivers turn into catalog queries) print one line:
 * <pre>[SQL] 22:41:07.123 #57   3 ms  shop  SELECT ...</pre>
 * and each API request that touched the database prints a summary:
 * <pre>[API] 22:41:07.125 GET /api/databases/shop/objects → 2 queries, 5 ms</pre>
 *
 * <p>On by default. Disable with {@code DBPILOT_SQL_LOG=0} (environment) or
 * {@code -Ddbpilot.sqlLog=false}.
 */
public final class QueryLog {
    private static final boolean ENABLED = isEnabled();
    private static final int MAX_SQL_CHARS = 400;
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");
    private static final AtomicLong TOTAL = new AtomicLong();
    /** Queries run by the current API request (null outside a request). */
    private static final ThreadLocal<int[]> REQUEST_COUNT = new ThreadLocal<>();

    private static final Set<String> EXECUTE_METHODS = Set.of(
            "execute", "executeQuery", "executeUpdate", "executeLargeUpdate",
            "executeBatch", "executeLargeBatch");
    private static final Set<String> PREPARE_METHODS = Set.of("prepareStatement", "prepareCall");

    private QueryLog() {
    }

    private static boolean isEnabled() {
        String env = System.getenv("DBPILOT_SQL_LOG");
        String prop = System.getProperty("dbpilot.sqlLog");
        return !("0".equals(env) || "false".equalsIgnoreCase(env) || "false".equalsIgnoreCase(prop));
    }

    public static boolean enabled() {
        return ENABLED;
    }

    /** Wrap a freshly opened connection; {@code label} names its database in log lines. */
    public static Connection wrap(Connection connection, String label) {
        if (!ENABLED || connection == null) {
            return connection;
        }
        String name = (label == null || label.isBlank()) ? "-" : label;
        log("[DB ] " + now() + " opened connection to " + name);
        return (Connection) Proxy.newProxyInstance(
                QueryLog.class.getClassLoader(),
                new Class<?>[]{Connection.class},
                new ConnectionHandler(connection, name));
    }

    /** Start counting queries for an API request on this thread. */
    public static void beginRequest() {
        if (ENABLED) {
            REQUEST_COUNT.set(new int[1]);
        }
    }

    /** Print the request summary (only when it ran queries or failed) and stop counting. */
    public static void endRequest(String method, String path, int status, long elapsedMs) {
        if (!ENABLED) {
            return;
        }
        int[] count = REQUEST_COUNT.get();
        REQUEST_COUNT.remove();
        int n = count == null ? 0 : count[0];
        if (n == 0 && status < 400) {
            return;
        }
        log("[API] " + now() + " " + method + " " + path + " → " + n
                + (n == 1 ? " query" : " queries") + ", " + elapsedMs + " ms"
                + (status >= 400 ? " (HTTP " + status + ")" : ""));
    }

    private static void record(String db, String kind, String sql, long nanos, Throwable error) {
        long id = TOTAL.incrementAndGet();
        int[] count = REQUEST_COUNT.get();
        if (count != null) {
            count[0]++;
        }
        long ms = nanos / 1_000_000L;
        StringBuilder line = new StringBuilder(160)
                .append("[SQL] ").append(now())
                .append(" #").append(id)
                .append(String.format(" %4d ms  ", ms))
                .append(db).append("  ");
        if (!"sql".equals(kind)) {
            line.append(kind).append(' ');
        }
        line.append(oneLine(sql));
        if (error != null) {
            String msg = error.getMessage() == null ? error.toString() : error.getMessage();
            line.append("  !! ").append(oneLine(msg));
        }
        log(line.toString());
    }

    private static String oneLine(String text) {
        if (text == null) {
            return "";
        }
        String s = text.replaceAll("\\s+", " ").trim();
        return s.length() > MAX_SQL_CHARS ? s.substring(0, MAX_SQL_CHARS) + "…" : s;
    }

    private static String now() {
        return LocalTime.now().format(TIME);
    }

    private static void log(String line) {
        System.out.println(line);
    }

    private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
    }

    private static final class ConnectionHandler implements InvocationHandler {
        private final Connection target;
        private final String db;

        private ConnectionHandler(Connection target, String db) {
            this.target = target;
            this.db = db;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            String name = method.getName();
            if ("unwrap".equals(name) || "isWrapperFor".equals(name)) {
                return QueryLog.invoke(target, method, args);
            }
            Object result = QueryLog.invoke(target, method, args);
            if (result instanceof Statement st) {
                String sql = PREPARE_METHODS.contains(name) && args != null && args.length > 0
                        && args[0] instanceof String s ? s : null;
                Class<?> iface = st instanceof CallableStatement ? CallableStatement.class
                        : st instanceof PreparedStatement ? PreparedStatement.class
                        : Statement.class;
                return Proxy.newProxyInstance(QueryLog.class.getClassLoader(),
                        new Class<?>[]{iface}, new StatementHandler(st, db, sql, (Connection) proxy));
            }
            if (result instanceof DatabaseMetaData meta) {
                return Proxy.newProxyInstance(QueryLog.class.getClassLoader(),
                        new Class<?>[]{DatabaseMetaData.class}, new MetaDataHandler(meta, db, (Connection) proxy));
            }
            return result;
        }
    }

    private static final class StatementHandler implements InvocationHandler {
        private final Statement target;
        private final String db;
        private final String preparedSql;
        private final Connection connectionProxy;
        private final StringBuilder batch = new StringBuilder();

        private StatementHandler(Statement target, String db, String preparedSql, Connection connectionProxy) {
            this.target = target;
            this.db = db;
            this.preparedSql = preparedSql;
            this.connectionProxy = connectionProxy;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            String name = method.getName();
            if ("getConnection".equals(name)) {
                return connectionProxy;
            }
            if ("addBatch".equals(name) && args != null && args.length == 1 && args[0] instanceof String s) {
                if (batch.length() > 0) batch.append("; ");
                batch.append(s);
            }
            if (!EXECUTE_METHODS.contains(name)) {
                return QueryLog.invoke(target, method, args);
            }
            String sql;
            if (args != null && args.length > 0 && args[0] instanceof String s) {
                sql = s;
            } else if (name.contains("Batch")) {
                sql = "BATCH " + (preparedSql != null ? preparedSql : batch.toString());
                batch.setLength(0);
            } else {
                sql = preparedSql != null ? preparedSql : "?";
            }
            long t0 = System.nanoTime();
            try {
                Object result = QueryLog.invoke(target, method, args);
                record(db, "sql", sql, System.nanoTime() - t0, null);
                return result;
            } catch (Throwable e) {
                record(db, "sql", sql, System.nanoTime() - t0, e);
                throw e;
            }
        }
    }

    /** Driver metadata calls each run catalog queries on the server — log them too. */
    private static final class MetaDataHandler implements InvocationHandler {
        private final DatabaseMetaData target;
        private final String db;
        private final Connection connectionProxy;

        private MetaDataHandler(DatabaseMetaData target, String db, Connection connectionProxy) {
            this.target = target;
            this.db = db;
            this.connectionProxy = connectionProxy;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            if ("getConnection".equals(method.getName())) {
                return connectionProxy;
            }
            if (!java.sql.ResultSet.class.isAssignableFrom(method.getReturnType())) {
                return QueryLog.invoke(target, method, args);
            }
            StringBuilder call = new StringBuilder(method.getName()).append('(');
            if (args != null) {
                for (int i = 0; i < args.length; i++) {
                    if (i > 0) call.append(", ");
                    Object a = args[i];
                    call.append(a instanceof String[] arr ? String.join("|", arr) : String.valueOf(a));
                }
            }
            call.append(')');
            long t0 = System.nanoTime();
            try {
                Object result = QueryLog.invoke(target, method, args);
                record(db, "META", call.toString(), System.nanoTime() - t0, null);
                return result;
            } catch (Throwable e) {
                record(db, "META", call.toString(), System.nanoTime() - t0, e);
                throw e;
            }
        }
    }
}
