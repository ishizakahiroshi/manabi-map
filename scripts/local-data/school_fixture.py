"""Compose only the checked-in synthetic examples; no external inputs or services."""

import json
from pathlib import Path

import school_history
import school_admission


def synthetic_payload():
    core = json.loads(Path(__file__).with_name("example.core.synthetic.json").read_text(encoding="utf-8"))
    tables = core["tables"]
    return {
        "format": "synthetic-school-source", "input_version": 1, "schema_version": 3,
        "synthetic": True, "dataset_version": "synthetic-school-001", "source_version": "synthetic-input-001",
        "tables": {**tables, **school_history.synthetic_rows(tables), **school_admission.synthetic_rows(tables)},
    }
