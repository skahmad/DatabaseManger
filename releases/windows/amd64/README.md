# Windows standalone package (split parts)

GitHub rejects single files over **100 MB**. The standalone zip (~135 MB) is split into parts under that limit so it can be pushed via git.

## Reassemble on Windows (PowerShell)

```powershell
cd path\to\releases\windows\amd64
Get-Content -Encoding Byte -ReadCount 0 .\forge-database-manager-1.0.0-windows-x86_64-standalone.part-* |
  Set-Content -Encoding Byte .\forge-database-manager-1.0.0-windows-x86_64-standalone.zip
```

Or double-click / run:

```text
reassemble.bat
```

## Reassemble on macOS / Linux

```bash
./reassemble.sh
# or:
cat forge-database-manager-1.0.0-windows-x86_64-standalone.part-* \
  > forge-database-manager-1.0.0-windows-x86_64-standalone.zip
```

## After reassemble

1. Unzip `forge-database-manager-1.0.0-windows-x86_64-standalone.zip`
2. Run `DB Pilot.vbs` (or `Start.vbs`)

Optional checksum: compare against `SHA256SUMS.txt`.
