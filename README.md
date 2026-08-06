# Forge Database Manager

Desktop database manager for **macOS, Windows, and Linux** with an embedded HTML UI (JavaFX WebView).

## Features

- Native desktop window (no browser tab)
- Saved connections in the left sidebar; password prompt when opening one
- **2-layer** (direct JDBC) and **3-layer** (SSH tunnel → database) connection modes
- Database administration: create / modify / drop databases and schemas
- Manage tables, views, indexes (create, rename, drop, add columns)
- Import / export CSV, Excel (XLSX), SQL, and JSON
- Clone / migrate databases and schemas on the same server
- Explorer for databases / schemas, tables, views, procedures, functions
- SQL editor with results grid
- Data / Structure / DDL tabs
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

## Connection modes

| Mode | Path | When to use |
|------|------|-------------|
| **2-layer** | App → database | Direct network access to the DB host |
| **3-layer** | App → SSH bastion → database | DB is only reachable from a jump host |

For 3-layer, set the database host/port as seen **from the SSH host** (often `127.0.0.1` if MySQL/Postgres listens locally on the bastion). Authenticate SSH with password and/or a private key path.

File databases (SQLite / H2 file) always use 2-layer.

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

## Windows installer

Build on a **Windows** machine with JDK 21+ (`jpackage`). Cross-building from macOS/Linux is not supported.

```powershell
# Portable app folder + zip (default, no WiX needed)
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1

# Installer (.exe) — requires WiX Toolset 3.x
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Type exe

# Or from Git Bash:
./scripts/build-windows.sh
./scripts/build-windows.sh --type=exe
```

Output: `binary/windows/amd64/` (or `arm64` on ARM Windows)

| Artifact | Notes |
|----------|--------|
| App folder / `.zip` | Portable — run `Forge Database Manager.exe` inside |
| `.exe` / `.msi` | Installer — needs [WiX Toolset](https://wixtoolset.org/) |

Optional: ImageMagick for a custom `.ico` (`packaging/windows/AppIcon.ico`).

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
