"""Acquire one pinned MSI for disposable CI metadata parsing; never install it."""
import hashlib, importlib.util, json, os, pathlib, sys, time, urllib.request
ROOT = pathlib.Path(__file__).resolve().parent
PLAN_SHA = "6e3cfa60f677cb3b0556f10d3a1036292605fe4e64e585e966b0a2438a43ba8e"

def main(destination):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Disposable CI only; reuse retained MSI locally")
    raw = (ROOT / "media-input-plan.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != PLAN_SHA:
        raise ValueError("Media plan identity mismatch")
    rows = json.loads(raw)["primaryInputs"]
    if len(rows) != 1 or rows[0]["size"] != 405504:
        raise ValueError("Expected exactly one historical MSI")
    spec = importlib.util.spec_from_file_location("acquisition", ROOT / "retained-byte-acquisition.py")
    acquisition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(acquisition)
    item = rows[0]
    acquisition.validate_url(item["url"])
    destination.mkdir(exist_ok=False)
    opener = urllib.request.build_opener(acquisition.Redirect())
    deadline = time.monotonic() + 120
    with opener.open(item["url"], timeout=30) as response:
        acquisition.validate_url(response.geturl())
        receipt = acquisition.retain(response, destination / "ucrt.msi", item, deadline)
    (destination / "acquisition.json").write_text(json.dumps(receipt, indent=2) + "\n")

if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
