import json
import os
import subprocess
import sys

result = {}
try:
    os.setsid()
    result["setsid_leader"] = "allowed"
except PermissionError:
    result["setsid_leader"] = "denied"

try:
    child = os.fork()
    if child == 0:
        os._exit(42)
    os.waitpid(child, 0)
    result["fork"] = "allowed"
except PermissionError:
    result["fork"] = "denied"

try:
    child = os.posix_spawn(sys.executable, [sys.executable, "-c", "import os; os._exit(42)"], os.environ)
    os.waitpid(child, 0)
    result["posix_spawn"] = "allowed"
except PermissionError:
    result["posix_spawn"] = "denied"

try:
    child = subprocess.Popen([sys.executable, "-c", "import os; os._exit(42)"], start_new_session=True)
    child.wait(timeout=2)
    result["subprocess_new_session"] = "allowed"
except PermissionError:
    result["subprocess_new_session"] = "denied"

print(json.dumps(result, sort_keys=True))
