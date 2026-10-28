import json
import os
from pathlib import Path
import sys

reference = (Path(__file__).resolve().parents[1] / "references" / "style.txt").read_text()
content = Path(sys.argv[1]).read_text() if len(sys.argv) > 1 else "local workflow"
summary = " ".join(content.split())
output = Path(os.environ["WORKDAY_OUTPUT_DIR"]) / "summary.txt"
output.write_text(summary)
print(json.dumps({"reference": reference.strip(), "summary": summary, "output": output.name}))
