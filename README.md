# Forge Database Manager

Desktop database manager for **macOS, Windows, and Linux** with an embedded HTML UI (JavaFX WebView).

## Features

- Native desktop window (no browser tab)
- Multiple live connections at once (switch without disconnecting)
- Saved connections in a resizable sidebar; password prompt when opening one
- **Object hierarchy**
  - **2-layer** — database → tables (MySQL / SQLite)
  - **3-layer** — database → schemas → tables (PostgreSQL always; H2 / SQL Server by default)
- Optional **SSH tunnel** (independent of hierarchy)
- **Details** tab with counts for connection / database / schema / table
- Admin actions via tree context menus (create, clone, export, import, drop, indexes, …)
- SQL editor, Data / Structure / DDL tabs
- Import / export CSV, Excel (XLSX), SQL, and JSON
- MySQL, PostgreSQL, SQLite, H2, SQL Server

## Requirements

- JDK 21+
- Maven 3.8+
- Docker (only when building Linux packages from macOS)

## Run

```bash
./run.sh
# or
mvn javafx:run
```

Use JDK 21+ (`JAVA_HOME`). The desktop window embeds the UI; the local API binds to `127.0.0.1` only.

## Object hierarchy

| Mode | Explorer tree | Typical engines |
|------|---------------|-----------------|
| **2-layer** | database → tables | MySQL, SQLite |
| **3-layer** | database → schemas → tables | PostgreSQL (always), H2, SQL Server |

SSH tunnel is a separate checkbox on the connection form (not the same as 3-layer hierarchy). When using SSH, set the database host/port as seen **from the bastion**.

## Build installers

Outputs are copied under `binary/` (gitignored).

### macOS

```bash
./scripts/build-mac.sh
```

Output: `binary/mac/Forge Database Manager-1.0.0.dmg`

Open the DMG and drag the app into **Applications**. If Gatekeeper blocks it: right-click → **Open**.

### Linux (amd64 / arm64)

From macOS (Docker) or natively on Linux:

```bash
# Intel/AMD Linux (most PCs/VMs) — default from macOS
./scripts/build-linux.sh --platform=linux/amd64

# ARM Linux
./scripts/build-linux.sh --platform=linux/arm64

# Both
./scripts/build-linux.sh --all
```

| Machine | Package |
|---------|---------|
| Intel/AMD PC or VM | `binary/linux/amd64/*.deb` (+ portable `.tar.gz`) |
| ARM Linux | `binary/linux/arm64/*.deb` |

```bash
dpkg --print-architecture   # amd64 or arm64
sudo apt install ./binary/linux/amd64/forge-database-manager_1.0.0_amd64.deb
# or
tar -xzf binary/linux/amd64/forge-database-manager-1.0.0-linux-x86_64.tar.gz
./"Forge Database Manager"/bin/"Forge Database Manager"
```

Requires a desktop Linux environment with GTK (JavaFX WebView).

### Windows

**Native installer / app-image** (must run on Windows with JDK 21+):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Type exe   # needs WiX
```

Or Git Bash on Windows:

```bash
./scripts/build-windows.sh
./scripts/build-windows.sh --type=exe
```

Output: `binary/windows/amd64/` (or `arm64` on ARM Windows)

| Artifact | Notes |
|----------|--------|
| App folder / `.zip` | Portable app-image from jpackage |
| `.exe` / `.msi` | Installer — needs [WiX Toolset](https://wixtoolset.org/) |

**Portable JAR zip** (can be assembled on macOS; needs JDK 21 on the Windows PC):

```text
binary/windows/amd64/forge-database-manager-1.0.0-windows-x86_64-portable.zip
```

Unzip and run `Forge Database Manager.bat`.

## Demo

1. Start the app (`./run.sh`)
2. Click **+** → new connection (e.g. SQLite → `/tmp/forge-demo.db`)
3. Connect — **Details** shows object counts
4. Expand the connection tree → open a database / schema
5. Open a table (or use **SQL** after a table is selected — **Run** stays disabled until then)

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT);
INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com'), ('Grace', 'grace@example.com');
SELECT * FROM users;
```
