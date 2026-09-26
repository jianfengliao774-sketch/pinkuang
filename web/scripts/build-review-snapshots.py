"""Compatibility entrypoint: rebuild the current shared review, never revive retired policy."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name("build-mobile-review-v8.py")),run_name="__main__")
