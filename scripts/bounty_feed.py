#!/usr/bin/env python3
"""Turns the best new open bounty from a bounty_watch database into a SignalPass alert.

  python3 scripts/bounty_feed.py                 publish at most one alert
  python3 scripts/bounty_feed.py --dry-run       print what would be published

Picks open, eligible listings first seen in the last 48 hours, highest score first,
skipping anything already sent (kept in data/bounty_feed_sent.json). The alert is
published with scripts/alert.mjs, which also keeps the server awake until the reveal.
Environment: BOUNTY_DB (default ~/bounty_watch/bounties.db), MIN_SCORE (default 50).
"""
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = Path(os.getenv("BOUNTY_DB", Path.home() / "bounty_watch" / "bounties.db"))
SENT = ROOT / "data" / "bounty_feed_sent.json"
MIN_SCORE = float(os.getenv("MIN_SCORE", "50"))
MAX_BYTES = 180
SOURCES = {"superteam": "Superteam", "devpost": "Devpost", "dorahacks": "DoraHacks",
           "github": "GitHub", "akindo": "Akindo"}


def alert_text(r) -> str:
    """One line, at most 180 UTF-8 bytes: title, prize, competition, deadline, link."""
    parts = []
    if r["reward_usd"]:
        parts.append(f"${r['reward_usd']:,.0f}")
    if r["submissions"] is not None and r["source"] != "github":
        parts.append(f"{r['submissions']} subs")
    if r["deadline"]:
        parts.append("closes " + datetime.fromisoformat(r["deadline"]).strftime("%b %d"))
    src = SOURCES.get(r["source"], r["source"])
    tail = " · ".join(parts)
    url = r["url"]
    title = r["title"].strip()
    for with_url in (True, False):
        fixed = f"{src}: " + (f" · {tail}" if tail else "") + (f" {url}" if with_url else "")
        room = MAX_BYTES - len(fixed.encode())
        if room >= 24:
            t = title
            while len(t.encode()) > room:
                t = t[:-2] + "…"
            return f"{src}: {t}" + (f" · {tail}" if tail else "") + (f" {url}" if with_url else "")
    return f"{src}: {title}"[:60]


def pick(con, sent: set):
    since = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
    now = datetime.now(timezone.utc).isoformat()
    rows = con.execute(
        """SELECT * FROM bounties WHERE status='open' AND ignored=0 AND score>=?
           AND first_seen>=? AND (deadline IS NULL OR deadline>?)
           ORDER BY score DESC""", (MIN_SCORE, since, now)).fetchall()
    for r in rows:
        if r["key"] in sent or "⛔" in (r["note"] or ""):
            continue
        return r
    return None


def main() -> None:
    dry = "--dry-run" in sys.argv
    sent = set(json.loads(SENT.read_text())) if SENT.exists() else set()
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    con.row_factory = sqlite3.Row
    r = pick(con, sent)
    if not r:
        print("nothing new to send")
        return
    text = alert_text(r)
    print(f"{r['key']} (score {r['score']:.0f}) -> {text!r} [{len(text.encode())} bytes]")
    if dry:
        return
    # record first, so a crash after publishing never sends the same listing twice
    SENT.parent.mkdir(exist_ok=True)
    SENT.write_text(json.dumps(sorted(sent | {r["key"]})))
    subprocess.run(["node", str(ROOT / "scripts" / "alert.mjs"), text], check=True, cwd=ROOT)


if __name__ == "__main__":
    main()
