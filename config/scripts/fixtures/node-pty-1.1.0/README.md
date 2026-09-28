# Legacy SSH teardown patch fixtures

`windowsPtyAgent.js.txt` and `windowsTerminal.js.txt` are unmodified `lib/` files
from the published npm `node-pty@1.1.0` tarball. The upstream MIT license is in
`LICENSE`. These are test inputs only, not a shipped runtime dependency.

The legacy SSH repair asset verifies both original and patched SHA-256 hashes.
Keeping its published input here lets clean installs test that compatibility
path after the desktop dependency is retired.
