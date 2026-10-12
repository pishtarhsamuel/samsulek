"""File helpers shared by every layer (no imports from the rest of samsulek)."""

from __future__ import annotations

import os
import time
from pathlib import Path


def atomic_write_text(path: Path, text: str, attempts: int = 5) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    last_exc: OSError | None = None
    for i in range(attempts):
        try:
            os.replace(tmp, path)
            return
        except PermissionError as exc:  # Windows: target briefly locked (antivirus, reader)
            last_exc = exc
            time.sleep(0.05 * (i + 1))
    tmp.unlink(missing_ok=True)
    raise last_exc or OSError(f"could not replace {path}")
