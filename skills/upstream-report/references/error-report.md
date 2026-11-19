# The error report

Upstream ships a collector with the server: `tools/ErrorReport/`. Its zip (versions, system facts, log
window, error digest, logs, config) is the report the developers expect. Scripts here only read its output.

## Before each use

From the user's own EveJS tree, read `tools/ErrorReport/README.md`, `doc/PAUSE_PROFILING.md` and the output of
`node tools/ErrorReport/collect-error-report.js --help`. Upstream can change the tool in any release: follow
those over the examples here. If `add-report` says `upstream changed the report format`, stop and re-read them.

## When it is needed

Required for runtime and performance bugs (errors, stalls, wrong behaviour you can see in logs). **Skip it** for
a content or data bug (wrong values in a table, nothing in the logs): write the README line
`Health capture: not applicable: <reason>`, skip `add-report`, and ignore the capture steps below.

## Getting the zip

A setup with its own wrapper script for the collector (for example one that runs it in a container) may use
that script instead of the Windows steps below, as long as the result is the collector's zip.

- **Windows, native install:** run `ErrorReport.bat` in the server folder after the bug. For stalls, run
  `ProfileServer.bat` (pause profiler; native Windows only).
- **Linux, macOS or Docker:** follow the README's commands: copy the logs out of the server's logs folder
  or container (in Docker, `docker compose cp` copies them out read-only), save recent server output, then
  run the collector (`--logs-dir`, `--out`, `--no-prompt`) from a throwaway container if the server runs in one.
- **Close Watch (`/health watch`):** before reproducing, in game as a staff character run `/health watch <minutes>`, so
  `server-health.log` holds captures for the collector to pick up. To start one without a game session,
  call `getServerCpuWatch().start()` from `server/src/utils/serverCpuWatch.js` inside the server process
  (read that file first for the arguments).
- **Pause profiles:** start the server with the `EVEJS_PAUSE_PROFILE*` flags from `doc/PAUSE_PROFILING.md`;
  pass the capture folder to the collector with `--profile-dir`. That is the only profile kind the collector takes.
- **One zip per run, from that run's logs folder.** Never run two CPU profilers on one server process:
  the pause profiler and a health watch capture need separate runs.
- Close Watch profiles (`logs/tick-profiles/*.cpuprofile`) are not collected: add them separately with
  `node <skill>/scripts/bundle.js add-profiles <bundle> <profiles folder> --as evidence/before|evidence/after`.

## Ingesting

`node <skill>/scripts/bundle.js add-report <bundle> <zip> --names <names file> --hosts <hosts file>` where the names file lists
every character in the logs, one per line, and the hosts file lists the host names to hide (the LAN names
kept in the terms file, and any host `check` refused; re-run with the host added if it does). Default target is `error-report/`. For a before/after
comparison use `--as evidence/before/error-report` and `--as evidence/after/error-report`, one zip each.
The collector warns its output holds paths and character names: redaction happens here, and `check`
and `leak-scan.js` still refuse any leftover. Read two folders by eye as well: `config/` (the scan knows
common secret shapes, not every key) and `server-logs/node-reports/` (Node's fatal-error reports hold the
host name, working folder, command line and environment variables; the environment is redacted, the rest
is not).
