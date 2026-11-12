"""Consistent SQLite backup/restore to a new file; never overwrites a database."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3
import time


def copy_database(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file():
        raise ValueError("Source database does not exist")
    if source == destination or destination.exists():
        raise ValueError("Destination must be a new file; existing data is never overwritten")
    if any(Path(str(destination) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Destination has existing SQLite sidecar files")
    deadline = time.monotonic() + 60

    def progress(_status, _remaining, _total):
        if time.monotonic() > deadline:
            raise TimeoutError("Backup exceeded 60 seconds; retry during lower load")

    # Exclusive creation prevents a concurrent operation from replacing data.
    with destination.open("xb"):
        pass
    try:
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src:
            with closing(sqlite3.connect(destination)) as dst:
                src.backup(dst, pages=256, progress=progress)
                if dst.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError("Backup integrity check failed")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "restore"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path, help="New database file; restore never replaces a running database")
    args = parser.parse_args()
    output = copy_database(args.source, args.destination)
    print(f"{args.action} verified: {output}")


if __name__ == "__main__":
    main()
