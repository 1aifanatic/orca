#!/usr/bin/env bash
# Release CLI bound to the isolated run1 profile only.
S='C:\Users\neil\orca-crash-222\run1'
export ORCA_USER_DATA_PATH="$S\profile" USERPROFILE="$S\home" HOME="$S\home" LOCALAPPDATA="$S\localappdata" ORCA_BACKGROUND_LAUNCH=1
exec /c/Users/neil/orca-crash-222/app-1.4.222/resources/bin/orca.exe "$@"
