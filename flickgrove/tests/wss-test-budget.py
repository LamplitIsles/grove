"""Run WSS checks serially inside a dedicated, memory-limited systemd scope."""
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import tempfile
import threading
import time

repo = Path(__file__).resolve().parents[2]
codex = shutil.which("codex")
og = shutil.which("og")
if not codex or not og:
    raise SystemExit("the existing codex and og executables must be on PATH")
relative = Path(open("/proc/self/cgroup").read().strip().split("::", 1)[1].lstrip("/"))
group = Path("/sys/fs/cgroup") / relative
if not relative.name.startswith("grove-wss-test-") or not relative.name.endswith(".scope"):
    raise SystemExit("refusing to run outside the dedicated WSS test scope")
if int((group / "memory.max").read_text().strip()) > 1024**3 or (group / "memory.swap.max").read_text().strip() != "0":
    raise SystemExit("scope must enforce MemoryMax=1G and MemorySwapMax=0")

# The native fixture writes at most a sparse 20 MiB test file. Bound individual
# files and stop at 160 MiB allocated, leaving headroom before the 256 MiB plan.
resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
peak_disk = 0
exceeded = threading.Event()

with tempfile.TemporaryDirectory(prefix="grove-wss-budget-", dir="/tmp") as directory:
    root = Path(directory)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(root), "TMPDIR": str(root),
           "CODEX_HOME": str(root / "codex"), "XDG_CONFIG_HOME": str(root / "config"),
           "XDG_CACHE_HOME": str(root / "cache"), "XDG_DATA_HOME": str(root / "data"),
           "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0", "PYTHONDONTWRITEBYTECODE": "1",
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "RUN_NATIVE_WSS": "1",
           "TEST_CODEX_BINARY": codex, "TEST_OG_BINARY": og}
    stopping = threading.Event()
    def monitor():
        global peak_disk
        while not stopping.wait(.1):
            total = 0
            for path, _, files in os.walk(root):
                for name in files:
                    try:
                        total += (Path(path) / name).lstat().st_blocks * 512
                    except FileNotFoundError:
                        pass
            peak_disk = max(peak_disk, total)
            if total >= 160 * 1024 * 1024:
                exceeded.set()
                # All test descendants are in this dedicated cgroup, including
                # subprocesses that create their own Unix process groups.
                for entry in (group / "cgroup.procs").read_text().split():
                    pid = int(entry)
                    if pid != os.getpid():
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                return
    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    bun_test = ["/usr/local/bin/bun", "test", "--no-env-file", "--cwd", "flickgrove"]
    if os.environ.get("WSS_TEST_PRELOAD"):
        bun_test.extend(["--preload", os.environ["WSS_TEST_PRELOAD"]])
    bun_test.extend(["server/exec-project-read.test.ts", "server/wss-environments.test.ts", "server/project-environments.test.ts"])
    commands = [
        bun_test,
        ["/usr/bin/python3", "-m", "unittest", "discover", "-s", "flickgrove/tests", "-p", "native_wss_test.py", "-v"],
    ]
    try:
        for command in commands:
            print("RUN", " ".join(command), flush=True)
            result = subprocess.run(command, cwd=repo, env=env, timeout=180)
            if exceeded.is_set() or result.returncode:
                raise SystemExit("test failed or storage threshold reached")
    finally:
        stopping.set()
        watcher.join()
        # Do not leave detached children if a test timed out or crashed.
        for entry in (group / "cgroup.procs").read_text().split():
            pid = int(entry)
            if pid != os.getpid():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        print(f"scope memory.peak={(group / 'memory.peak').read_text().strip()} bytes; sampled temporary allocation peak={peak_disk} bytes", flush=True)
