#!/usr/bin/env python3
"""Build a `.maic.zip` from a local OpenMAIC Postgres, for testing the player.

The real ZIP is produced client-side by OpenMAIC's export menu; this reproduces
the same manifest shape from the database so the player can be smoke-tested
without driving the app's UI. Audio lives in the browser, not Postgres, so the
sample is silent — speech falls back to the reading-time timer.

Usage: make-sample.py <stage_id> [out.maic.zip]
"""
import json
import os
import pathlib
import subprocess
import sys
import zipfile

# Local OpenMAIC Postgres. The default matches the repo's docker-compose
# development credentials; override for any other setup.
DB = os.environ.get("OPENMAIC_DB", "postgres://openmaic@127.0.0.1:5432/openmaic")
DB_PASSWORD = os.environ.get("OPENMAIC_DB_PASSWORD", "openmaic-dev")
PSQL = os.environ.get("PSQL", "psql")


def q(sql: str) -> str:
    r = subprocess.run(
        [PSQL, "-tA", DB, "-c", sql], capture_output=True, text=True,
        env={**os.environ, "PGPASSWORD": DB_PASSWORD},
    )
    if r.returncode:
        sys.exit(r.stderr.strip())
    return r.stdout


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sid = sys.argv[1].replace("'", "''")
    out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "sample-course.maic.zip")

    name = q(f"select name from document_stages where id='{sid}';").strip()
    if not name:
        sys.exit(f"no course with id {sid}")

    rows = json.loads(q(
        "select coalesce(jsonb_agg(jsonb_build_object('o',scene_order,'d',data) "
        f"order by scene_order),'[]'::jsonb) from document_scenes where stage_id='{sid}';"
    ))

    scenes = []
    for r in rows:
        d = r["d"]
        actions = []
        for a in d.get("actions") or []:
            a = dict(a)
            a.pop("audioId", None)  # manifest addresses audio by audioRef
            actions.append(a)
        scenes.append({
            "type": d.get("type"), "title": d.get("title"), "order": int(float(r["o"])),
            "content": d.get("content") or {}, "actions": actions,
        })

    manifest = {
        "formatVersion": 1, "exportedAt": "1970-01-01T00:00:00Z", "appVersion": "player-sample",
        "stage": {"name": name, "createdAt": 0, "updatedAt": 0},
        "agents": [], "scenes": scenes, "mediaIndex": {},
    }

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

    verbs = sorted({a["type"] for s in scenes for a in s["actions"]})
    print(f"{out} — {len(scenes)} scenes, "
          f"{sum(len(s['actions']) for s in scenes)} actions, verbs: {', '.join(verbs)}")


if __name__ == "__main__":
    main()
