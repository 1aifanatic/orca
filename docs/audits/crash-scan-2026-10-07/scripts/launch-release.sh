#!/usr/bin/env bash
# Launch released v1.4.222 hidden with an isolated profile/home/LOCALAPPDATA.
S="$1"; PORT="$2"; WS="$3"
export ORCA_BACKGROUND_LAUNCH=1
export ORCA_E2E_USER_DATA_DIR="$S\profile"
export ORCA_E2E_HOME_DIR="$S\home"
export USERPROFILE="$S\home"
export HOME="$S\home"
export LOCALAPPDATA="$S\localappdata"
export ORCA_E2E_RUNTIME_WS_PORT="$WS"
exec /c/Users/neil/orca-crash-222/app-1.4.222/Orca.exe --remote-debugging-port="$PORT" >"$S\logs\stdout.log" 2>"$S\logs\stderr.log"
