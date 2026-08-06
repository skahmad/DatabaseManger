# Forge Database Manager

Desktop database manager for **macOS, Windows, and Linux** with an embedded HTML UI (JavaFX WebView).

## Features

- Native desktop window (no browser tab)
- Connect gate (saved connections or new) before the main UI
- Explorer for databases / schemas, tables, views, procedures, functions
- SQL editor with results grid
- Data / Structure / DDL tabs
- CSV / JSON export
- MySQL, PostgreSQL, SQLite, H2, SQL Server

## Requirements

- JDK 21+
- Maven 3.8+

## Run

```bash
./run.sh
# or
mvn javafx:run
```

A desktop window opens with the UI rendered inside the app. The local API binds to `127.0.0.1` only.

## macOS installer

Build a drag-to-Applications `.dmg` (requires JDK 21+ with `jpackage`):

```bash
./scripts/build-mac.sh
```

Output: `binary/mac/Forge Database Manager-1.0.0.dmg`

Open the DMG and drag **Forge Database Manager** into **Applications**. If macOS Gatekeeper blocks an unsigned build, right-click the app → **Open**.

## Linux installer

Build packages with Docker (from macOS) or natively on Linux:

```bash
# Intel/AMD Linux (most PCs/VMs) — default from macOS
./scripts/build-linux.sh --platform=linux/amd64

# ARM Linux
./scripts/build-linux.sh --platform=linux/arm64

# Both
./scripts/build-linux.sh --all
```

**Arch must match the install machine.** Check on Linux:

```bash
dpkg --print-architecture   # amd64 or arm64
```

| Machine | Use package |
|---------|-------------|
| Intel/AMD PC or VM | `binary/linux/amd64/*.deb` |
| ARM / Apple Silicon Linux VM | `binary/linux/arm64/*.deb` |

Install:

```bash
sudo apt install ./binary/linux/amd64/forge-database-manager_1.0.0_amd64.deb
# or
tar -xzf binary/linux/amd64/forge-database-manager-1.0.0-linux-x86_64.tar.gz
./"Forge Database Manager"/bin/"Forge Database Manager"
```

Requires a desktop Linux environment with GTK (for JavaFX WebView).

## Demo

1. Start the app
2. Click **New connection**
3. Choose **SQLite**, set database path e.g. `/tmp/forge-demo.db`
4. Connect — main UI appears
5. Run in SQL:

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT);
INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com'), ('Grace', 'grace@example.com');
SELECT * FROM users;
```

6. Expand the explorer → Tables → `users` to browse data
