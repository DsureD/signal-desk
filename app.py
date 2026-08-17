import os
import hmac
import json
import math
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from urllib.parse import urlparse

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("DATABASE_PATH", BASE_DIR / "dashboard.db"))
THINGSPEAK_BASE = os.getenv("THINGSPEAK_BASE_URL", "https://api.thingspeak.com").rstrip("/")
DASHBOARD_PASSWORD = os.getenv("DASHBOARD_PASSWORD", "")
SHARE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
DEBUG_MODE = os.getenv("FLASK_DEBUG", "0") == "1"


# 这些是文档和 .env.example 里的占位值，一旦生效就等于把签名密钥公开在仓库里，
# 攻击者可以自行签发 {"authenticated": true} 的 session cookie 绕过登录。
INSECURE_SECRET_KEYS = {
    "dev-only-change-me",
    "replace-with-a-random-secret",
    "replace-with-a-long-random-secret",
}


def load_secret_key():
    key = os.getenv("FLASK_SECRET_KEY", "").strip()
    if key and key not in INSECURE_SECRET_KEYS and len(key) >= 16:
        return key
    if DEBUG_MODE:
        # 本地调试允许临时密钥，进程重启后已登录的 session 会失效。
        return secrets.token_urlsafe(32)
    raise RuntimeError(
        "FLASK_SECRET_KEY 未配置、仍是占位值或长度不足 16 位，拒绝启动。\n"
        "请在 .env 中设置一个不可预测的随机值，例如：\n"
        '  python -c "import secrets; print(secrets.token_urlsafe(32))"'
    )


def password_matches(candidate):
    """恒定时间比较访问密码。

    hmac.compare_digest 不接受含非 ASCII 字符的 str（会抛 TypeError），
    所以这里统一按 UTF-8 编码成 bytes 再比较，否则中文密码会 500。
    """
    if not DASHBOARD_PASSWORD:
        return False
    return hmac.compare_digest(str(candidate).encode("utf-8"), DASHBOARD_PASSWORD.encode("utf-8"))


def safe_next_url(target):
    """只允许跳回本站的绝对路径。

    仅判断 startswith("/") 是不够的：//evil.com 和 /\\evil.com 都以 / 开头，
    但浏览器会当成协议相对 URL 跳到外站，形成 open redirect。
    """
    if not target:
        return "/"
    target = str(target)
    if any(char in target for char in ("\\", "\n", "\r", "\t")) or "\x00" in target:
        return "/"
    if not target.startswith("/") or target.startswith("//"):
        return "/"
    parsed = urlparse(target)
    if parsed.scheme or parsed.netloc:
        return "/"
    return target


app = Flask(__name__)
app.config["SECRET_KEY"] = load_secret_key()
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.getenv("SESSION_COOKIE_SECURE", "0") == "1"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=int(os.getenv("SESSION_DAYS", 7)))  # 1.新增修改关联session时效的

@app.before_request
def require_login():
    if request.endpoint in {"login", "logout", "static", "service_worker", "app_icon", "app_manifest", "share_view", "share_data"}:
        return None
    if session.get("authenticated"):
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "需要登录"}), 401
    return redirect(url_for("login", next=request.path))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    next_url = safe_next_url(request.args.get("next") or request.form.get("next"))
    if request.method == "POST":
        password = request.form.get("password", "")
        if not DASHBOARD_PASSWORD:
            error = "尚未配置访问密码，请在 .env 中设置 DASHBOARD_PASSWORD。"
        elif password_matches(password):
            session.clear()
            session.permanent = True  # 2.新增修改关联session时效的
            session["authenticated"] = True
            return redirect(next_url)
        else:
            error = "密码不正确"
    return render_template("login.html", error=error, next_url=next_url, configured=bool(DASHBOARD_PASSWORD))


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/sw.js")
def service_worker():
    response = send_from_directory(BASE_DIR / "static", "sw.js", mimetype="application/javascript")
    response.headers["Content-Type"] = "application/javascript; charset=utf-8"
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/icon.svg")
def app_icon():
    response = send_from_directory(BASE_DIR / "static", "icon.svg", mimetype="image/svg+xml")
    response.headers["Content-Type"] = "image/svg+xml"
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@app.get("/manifest.webmanifest")
def app_manifest():
    response = send_from_directory(BASE_DIR / "static", "manifest.webmanifest", mimetype="application/manifest+json")
    response.headers["Content-Type"] = "application/manifest+json; charset=utf-8"
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS data_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                read_api_key TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS fields (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER NOT NULL,
                field_number INTEGER NOT NULL,
                name TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '',
                visible INTEGER NOT NULL DEFAULT 1,
                y_axis INTEGER NOT NULL DEFAULT 0,
                UNIQUE(source_id, field_number),
                FOREIGN KEY(source_id) REFERENCES data_sources(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS dashboard_cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '实时趋势',
                field_numbers TEXT NOT NULL DEFAULT '[1]',
                field_selections TEXT NOT NULL DEFAULT '[]',
                chart_type TEXT NOT NULL DEFAULT 'line',
                y_axis_min REAL,
                show_stats INTEGER NOT NULL DEFAULT 1,
                share_enabled INTEGER NOT NULL DEFAULT 0,
                fullscreen_enabled INTEGER NOT NULL DEFAULT 1,
                share_token TEXT UNIQUE,
                share_hours INTEGER NOT NULL DEFAULT 24,
                share_start TEXT,
                share_end TEXT,
                share_windows TEXT NOT NULL DEFAULT '[24]',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(source_id) REFERENCES data_sources(id) ON DELETE CASCADE
            );
            """
        )
        source_columns = {row["name"] for row in db.execute("PRAGMA table_info(data_sources)").fetchall()}
        if "sort_order" not in source_columns:
            db.execute("ALTER TABLE data_sources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
            for index, source in enumerate(db.execute("SELECT id FROM data_sources ORDER BY id DESC").fetchall()):
                db.execute("UPDATE data_sources SET sort_order = ? WHERE id = ?", (index, source["id"]))
        columns = {row["name"] for row in db.execute("PRAGMA table_info(dashboard_cards)").fetchall()}
        if "share_hours" not in columns:
            db.execute("ALTER TABLE dashboard_cards ADD COLUMN share_hours INTEGER NOT NULL DEFAULT 24")
        if "share_start" not in columns:
            db.execute("ALTER TABLE dashboard_cards ADD COLUMN share_start TEXT")
        if "share_end" not in columns:
            db.execute("ALTER TABLE dashboard_cards ADD COLUMN share_end TEXT")
        if "share_windows" not in columns:
            db.execute("ALTER TABLE dashboard_cards ADD COLUMN share_windows TEXT NOT NULL DEFAULT '[24]'")
            for card in db.execute("SELECT id, share_hours FROM dashboard_cards").fetchall():
                db.execute(
                    "UPDATE dashboard_cards SET share_windows = ? WHERE id = ?",
                    (json.dumps([int(card["share_hours"] or 24)]), card["id"]),
                )
        if "field_selections" not in columns:
            db.execute("ALTER TABLE dashboard_cards ADD COLUMN field_selections TEXT NOT NULL DEFAULT '[]'")
        for card in db.execute(
            "SELECT id, source_id, field_numbers, field_selections FROM dashboard_cards"
        ).fetchall():
            try:
                selections = json.loads(card["field_selections"])
            except (TypeError, ValueError, json.JSONDecodeError):
                selections = []
            if selections:
                continue
            try:
                numbers = json.loads(card["field_numbers"])
            except (TypeError, ValueError, json.JSONDecodeError):
                numbers = [1]
            selections = [
                {"source_id": card["source_id"], "field_number": int(number)}
                for number in numbers
                if str(number).isdigit() and 1 <= int(number) <= 8
            ]
            db.execute(
                "UPDATE dashboard_cards SET field_selections = ? WHERE id = ?",
                (json.dumps(selections or [{"source_id": card["source_id"], "field_number": 1}]), card["id"]),
            )
        source_ids = db.execute("SELECT id FROM data_sources").fetchall()
        for source in source_ids:
            has_card = db.execute(
                "SELECT 1 FROM dashboard_cards WHERE source_id = ? LIMIT 1", (source["id"],)
            ).fetchone()
            if not has_card:
                selections = [
                    {"source_id": source["id"], "field_number": number}
                    for number in range(1, 9)
                ]
                db.execute(
                    "INSERT INTO dashboard_cards (source_id, title, field_numbers, field_selections, sort_order) VALUES (?, ?, ?, ?, ?)",
                    (source["id"], "实时趋势", json.dumps(list(range(1, 9))), json.dumps(selections), 0),
                )
        for card in db.execute(
            "SELECT id, share_token FROM dashboard_cards WHERE share_token IS NOT NULL"
        ).fetchall():
            if len(card["share_token"]) != 6:
                db.execute(
                    "UPDATE dashboard_cards SET share_token = ? WHERE id = ?",
                    (generate_share_token(), card["id"]),
                )


def generate_share_token():
    return "".join(secrets.choice(SHARE_TOKEN_ALPHABET) for _ in range(6))


def source_public(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "channel_id": row["channel_id"],
        "description": row["description"],
        "enabled": bool(row["enabled"]),
        "sort_order": row["sort_order"],
        "fields": get_fields(row["id"]),
        "cards": get_cards(row["id"]),
    }


def get_fields(source_id):
    with get_db() as db:
        rows = db.execute(
            "SELECT field_number, name, unit, visible, y_axis FROM fields WHERE source_id = ? ORDER BY field_number",
            (source_id,),
        ).fetchall()
    return [
        {
            "field_number": row["field_number"],
            "name": row["name"],
            "unit": row["unit"],
            "visible": bool(row["visible"]),
            "y_axis": row["y_axis"],
        }
        for row in rows
    ]


def card_field_selections(row):
    try:
        raw_selections = json.loads(row["field_selections"])
    except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        raw_selections = []
    selections = []
    seen = set()
    if isinstance(raw_selections, list):
        for item in raw_selections:
            if not isinstance(item, dict):
                continue
            try:
                source_id = int(item.get("source_id"))
                field_number = int(item.get("field_number"))
            except (TypeError, ValueError):
                continue
            key = (source_id, field_number)
            if source_id > 0 and 1 <= field_number <= 8 and key not in seen:
                selections.append({"source_id": source_id, "field_number": field_number})
                seen.add(key)
    if selections:
        return selections
    try:
        field_numbers = json.loads(row["field_numbers"])
    except (TypeError, ValueError, json.JSONDecodeError):
        field_numbers = [1]
    for item in field_numbers if isinstance(field_numbers, list) else [1]:
        try:
            field_number = int(item)
        except (TypeError, ValueError):
            continue
        if 1 <= field_number <= 8:
            selections.append({"source_id": int(row["source_id"]), "field_number": field_number})
    return selections or [{"source_id": int(row["source_id"]), "field_number": 1}]


def card_public(row, include_token=True):
    try:
        field_numbers = json.loads(row["field_numbers"])
    except (TypeError, ValueError, json.JSONDecodeError):
        field_numbers = [1]
    try:
        share_windows = json.loads(row["share_windows"])
    except (TypeError, ValueError, json.JSONDecodeError):
        share_windows = [row["share_hours"] or 24]
    result = {
        "id": row["id"],
        "source_id": row["source_id"],
        "title": row["title"],
        "field_numbers": field_numbers,
        "field_selections": card_field_selections(row),
        "chart_type": row["chart_type"],
        "y_axis_min": row["y_axis_min"],
        "show_stats": bool(row["show_stats"]),
        "share_enabled": bool(row["share_enabled"]),
        "fullscreen_enabled": True,
        "share_hours": row["share_hours"],
        "share_start": row["share_start"],
        "share_end": row["share_end"],
        "share_windows": share_windows,
        "sort_order": row["sort_order"],
    }
    if include_token and row["share_token"]:
        result["share_token"] = row["share_token"]
    return result


def get_cards(source_id, include_token=True):
    with get_db() as db:
        rows = db.execute(
            "SELECT * FROM dashboard_cards WHERE source_id = ? ORDER BY sort_order, id",
            (source_id,),
        ).fetchall()
    return [card_public(row, include_token=include_token) for row in rows]


def validate_payload(payload):
    name = str(payload.get("name", "")).strip()
    channel_id = str(payload.get("channel_id", "")).strip()
    if not name or not channel_id:
        return None, "名称和 Channel ID 为必填项"
    if not channel_id.isdigit():
        return None, "Channel ID 必须是数字"
    return {
        "name": name[:80],
        "channel_id": channel_id,
        "read_api_key": str(payload.get("read_api_key", "")).strip(),
        "description": str(payload.get("description", "")).strip()[:300],
        "enabled": 1 if payload.get("enabled", True) else 0,
    }, None


def validate_card_payload(payload, owner_source_id, existing=None):
    payload = payload if isinstance(payload, dict) else {}
    title = str(payload.get("title", existing["title"] if existing else "实时趋势")).strip()
    if not title:
        return None, "卡片名称不能为空"
    chart_type = str(payload.get("chart_type", existing["chart_type"] if existing else "line"))
    if chart_type not in {"line", "bar", "area"}:
        return None, "不支持的图表类型"

    raw_selections = payload.get("field_selections")
    if raw_selections is None and existing:
        raw_selections = card_field_selections(existing)
    if raw_selections is None:
        raw_fields = payload.get("field_numbers", [1])
        if isinstance(raw_fields, list):
            raw_selections = [
                {"source_id": owner_source_id, "field_number": number}
                for number in raw_fields
            ]
    if not isinstance(raw_selections, list):
        return None, "请选择至少一个 field"
    field_selections = []
    seen_fields = set()
    for item in raw_selections:
        if not isinstance(item, dict):
            continue
        try:
            source_id = int(item.get("source_id"))
            number = int(item.get("field_number"))
        except (TypeError, ValueError):
            continue
        key = (source_id, number)
        if source_id > 0 and 1 <= number <= 8 and key not in seen_fields:
            field_selections.append({"source_id": source_id, "field_number": number})
            seen_fields.add(key)
    if not field_selections:
        return None, "请选择至少一个 field"
    source_ids = {selection["source_id"] for selection in field_selections}
    with get_db() as db:
        placeholders = ",".join("?" for _ in source_ids)
        existing_source_ids = {
            row["id"]
            for row in db.execute(
                f"SELECT id FROM data_sources WHERE id IN ({placeholders})", tuple(source_ids)
            ).fetchall()
        }
    if existing_source_ids != source_ids:
        return None, "部分 Field 所属的数据源不存在"
    field_numbers = [
        selection["field_number"]
        for selection in field_selections
        if selection["source_id"] == owner_source_id
    ]
    if not field_numbers:
        field_numbers = [field_selections[0]["field_number"]]

    raw_min = payload.get("y_axis_min", existing["y_axis_min"] if existing else None)
    y_axis_min = None
    if raw_min not in (None, ""):
        try:
            y_axis_min = float(raw_min)
        except (TypeError, ValueError):
            return None, "Y 轴起始值必须是数字"
        if not math.isfinite(y_axis_min):
            return None, "Y 轴起始值必须是有限数字"

    share_enabled = bool(payload.get("share_enabled", existing["share_enabled"] if existing else False))
    raw_share_windows = payload.get("share_windows")
    if raw_share_windows is None:
        if "share_hours" in payload:
            raw_share_windows = [payload["share_hours"]]
        elif existing:
            try:
                raw_share_windows = json.loads(existing["share_windows"])
            except (TypeError, ValueError, json.JSONDecodeError):
                raw_share_windows = [existing["share_hours"] or 24]
        else:
            raw_share_windows = [24]
    if not isinstance(raw_share_windows, list):
        return None, "分享时间窗口无效"
    share_windows = []
    for item in raw_share_windows:
        try:
            window = int(item)
        except (TypeError, ValueError):
            continue
        if window in {0, 1, 6, 12, 24, 72, 168, 720} and window not in share_windows:
            share_windows.append(window)
    if not share_windows:
        return None, "至少选择一个分享时间窗口"
    if 0 in share_windows and len(share_windows) > 1:
        return None, "自定义时间不能与其他窗口同时选择"
    share_hours = share_windows[0]
    share_start = str(payload.get("share_start", existing["share_start"] if existing else "") or "").strip()
    share_end = str(payload.get("share_end", existing["share_end"] if existing else "") or "").strip()
    if share_hours == 0:
        if not share_start or not share_end:
            return None, "请填写完整的分享起止时间"
        try:
            start_time = datetime.fromisoformat(share_start.replace("Z", "+00:00"))
            end_time = datetime.fromisoformat(share_end.replace("Z", "+00:00"))
        except ValueError:
            return None, "分享起止时间格式无效"
        if end_time <= start_time:
            return None, "分享结束时间必须晚于开始时间"
    else:
        share_start = ""
        share_end = ""
    existing_token = existing["share_token"] if existing and len(existing["share_token"] or "") == 6 else None
    share_token = existing_token or generate_share_token()
    try:
        sort_order = max(0, int(payload.get("sort_order", existing["sort_order"] if existing else 0)))
    except (TypeError, ValueError):
        sort_order = 0
    return {
        "title": title[:80],
        "field_numbers": field_numbers,
        "field_selections": field_selections,
        "chart_type": chart_type,
        "y_axis_min": y_axis_min,
        "show_stats": 1 if payload.get("show_stats", existing["show_stats"] if existing else True) else 0,
        "share_enabled": 1 if share_enabled else 0,
        "fullscreen_enabled": 1,
        "share_token": share_token,
        "share_hours": share_hours,
        "share_start": share_start or None,
        "share_end": share_end or None,
        "share_windows": share_windows,
        "sort_order": sort_order,
    }, None


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/sources")
def list_sources():
    with get_db() as db:
        rows = db.execute("SELECT * FROM data_sources ORDER BY sort_order, id").fetchall()
    return jsonify([source_public(row) for row in rows])


@app.put("/api/sources/order")
def reorder_sources():
    source_ids = (request.get_json(silent=True) or {}).get("source_ids")
    if not isinstance(source_ids, list) or not source_ids:
        return jsonify({"error": "source_ids 必须是非空数组"}), 400
    try:
        source_ids = [int(source_id) for source_id in source_ids]
    except (TypeError, ValueError):
        return jsonify({"error": "source_ids 无效"}), 400
    if len(source_ids) != len(set(source_ids)):
        return jsonify({"error": "source_ids 不能重复"}), 400
    with get_db() as db:
        rows = db.execute("SELECT id FROM data_sources").fetchall()
        existing_ids = {row["id"] for row in rows}
        if set(source_ids) != existing_ids:
            return jsonify({"error": "数据源列表已变化，请刷新后重试"}), 409
        for index, source_id in enumerate(source_ids):
            db.execute("UPDATE data_sources SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (index, source_id))
    return jsonify({"ok": True})


@app.post("/api/sources")
def create_source():
    payload, error = validate_payload(request.get_json(silent=True) or {})
    if error:
        return jsonify({"error": error}), 400
    with get_db() as db:
        sort_order = db.execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM data_sources").fetchone()[0]
        cursor = db.execute(
            "INSERT INTO data_sources (name, channel_id, read_api_key, description, enabled, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
            (payload["name"], payload["channel_id"], payload["read_api_key"], payload["description"], payload["enabled"], sort_order),
        )
        source_id = cursor.lastrowid
        for number in range(1, 9):
            db.execute(
                "INSERT INTO fields (source_id, field_number, name) VALUES (?, ?, ?)",
                (source_id, number, f"Field {number}"),
            )
        db.execute(
            "INSERT INTO dashboard_cards (source_id, title, field_numbers, field_selections, sort_order) VALUES (?, ?, ?, ?, ?)",
            (source_id, "实时趋势", json.dumps(list(range(1, 9))), json.dumps([
                {"source_id": source_id, "field_number": number} for number in range(1, 9)
            ]), 0),
        )
        row = db.execute("SELECT * FROM data_sources WHERE id = ?", (source_id,)).fetchone()
    return jsonify(source_public(row)), 201


@app.put("/api/sources/<int:source_id>")
def update_source(source_id):
    payload, error = validate_payload(request.get_json(silent=True) or {})
    if error:
        return jsonify({"error": error}), 400
    with get_db() as db:
        existing = db.execute("SELECT * FROM data_sources WHERE id = ?", (source_id,)).fetchone()
        if not existing:
            return jsonify({"error": "数据源不存在"}), 404
        if not payload["read_api_key"]:
            payload["read_api_key"] = existing["read_api_key"]
        db.execute(
            "UPDATE data_sources SET name = ?, channel_id = ?, read_api_key = ?, description = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (payload["name"], payload["channel_id"], payload["read_api_key"], payload["description"], payload["enabled"], source_id),
        )
        row = db.execute("SELECT * FROM data_sources WHERE id = ?", (source_id,)).fetchone()
    return jsonify(source_public(row))


@app.delete("/api/sources/<int:source_id>")
def delete_source(source_id):
    with get_db() as db:
        cards = db.execute(
            "SELECT * FROM dashboard_cards WHERE source_id != ?", (source_id,)
        ).fetchall()
        for card in cards:
            selections = [
                selection
                for selection in card_field_selections(card)
                if selection["source_id"] != source_id
            ]
            if len(selections) == len(card_field_selections(card)):
                continue
            if not selections:
                selections = [{"source_id": card["source_id"], "field_number": 1}]
            owner_fields = [
                selection["field_number"]
                for selection in selections
                if selection["source_id"] == card["source_id"]
            ]
            db.execute(
                "UPDATE dashboard_cards SET field_numbers = ?, field_selections = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (json.dumps(owner_fields or [selections[0]["field_number"]]), json.dumps(selections), card["id"]),
            )
        result = db.execute("DELETE FROM data_sources WHERE id = ?", (source_id,))
    if result.rowcount == 0:
        return jsonify({"error": "数据源不存在"}), 404
    return jsonify({"ok": True})


@app.put("/api/sources/<int:source_id>/fields")
def update_fields(source_id):
    fields = (request.get_json(silent=True) or {}).get("fields", [])
    if not isinstance(fields, list):
        return jsonify({"error": "fields 必须是数组"}), 400
    if not get_source(source_id):
        return jsonify({"error": "数据源不存在"}), 404
    with get_db() as db:
        for item in fields:
            try:
                number = int(item["field_number"])
                if number < 1 or number > 8:
                    continue
                db.execute(
                    "UPDATE fields SET name = ?, unit = ?, visible = ?, y_axis = ? WHERE source_id = ? AND field_number = ?",
                    (str(item.get("name", f"Field {number}"))[:80], str(item.get("unit", ""))[:20], 1 if item.get("visible", True) else 0, 1 if int(item.get("y_axis", 0)) else 0, source_id, number),
                )
            except (KeyError, TypeError, ValueError):
                continue
    return jsonify({"fields": get_fields(source_id)})


@app.get("/api/sources/<int:source_id>/cards")
def list_cards(source_id):
    if not get_source(source_id):
        return jsonify({"error": "数据源不存在"}), 404
    return jsonify(get_cards(source_id))


@app.post("/api/sources/<int:source_id>/cards")
def create_card(source_id):
    if not get_source(source_id):
        return jsonify({"error": "数据源不存在"}), 404
    payload, error = validate_card_payload(request.get_json(silent=True) or {}, source_id)
    if error:
        return jsonify({"error": error}), 400
    with get_db() as db:
        current = db.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM dashboard_cards WHERE source_id = ?", (source_id,)
        ).fetchone()[0]
        payload["sort_order"] = current
        cursor = db.execute(
            """INSERT INTO dashboard_cards
            (source_id, title, field_numbers, field_selections, chart_type, y_axis_min, show_stats, share_enabled,
            fullscreen_enabled, share_token, share_hours, share_start, share_end, share_windows, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)""",
            (source_id, payload["title"], json.dumps(payload["field_numbers"]), json.dumps(payload["field_selections"]), payload["chart_type"],
             payload["y_axis_min"], payload["show_stats"], payload["share_enabled"],
             payload["fullscreen_enabled"], payload["share_token"], payload["share_hours"],
             payload["share_start"], payload["share_end"], json.dumps(payload["share_windows"]), payload["sort_order"]),
        )
        row = db.execute("SELECT * FROM dashboard_cards WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify(card_public(row)), 201


@app.put("/api/sources/<int:source_id>/cards/<int:card_id>")
def update_card(source_id, card_id):
    with get_db() as db:
        existing = db.execute(
            "SELECT * FROM dashboard_cards WHERE id = ? AND source_id = ?", (card_id, source_id)
        ).fetchone()
        if not existing:
            return jsonify({"error": "卡片不存在"}), 404
        payload, error = validate_card_payload(request.get_json(silent=True) or {}, source_id, existing)
        if error:
            return jsonify({"error": error}), 400
        db.execute(
            """UPDATE dashboard_cards SET title = ?, field_numbers = ?, field_selections = ?, chart_type = ?, y_axis_min = ?,
            show_stats = ?, share_enabled = ?, fullscreen_enabled = ?, share_token = ?, share_hours = ?,
            share_start = ?, share_end = ?, share_windows = ?, sort_order = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ? AND source_id = ?""",
            (payload["title"], json.dumps(payload["field_numbers"]), json.dumps(payload["field_selections"]), payload["chart_type"], payload["y_axis_min"],
             payload["show_stats"], payload["share_enabled"], payload["fullscreen_enabled"], payload["share_token"],
             payload["share_hours"], payload["share_start"], payload["share_end"], json.dumps(payload["share_windows"]), payload["sort_order"],
             card_id, source_id),
        )
        row = db.execute("SELECT * FROM dashboard_cards WHERE id = ?", (card_id,)).fetchone()
    return jsonify(card_public(row))


@app.delete("/api/sources/<int:source_id>/cards/<int:card_id>")
def delete_card(source_id, card_id):
    with get_db() as db:
        result = db.execute(
            "DELETE FROM dashboard_cards WHERE id = ? AND source_id = ?", (card_id, source_id)
        )
    if result.rowcount == 0:
        return jsonify({"error": "卡片不存在"}), 404
    return jsonify({"ok": True})


@app.get("/api/sources/<int:source_id>/channel")
def channel_info(source_id):
    source = get_source(source_id)
    if not source:
        return jsonify({"error": "数据源不存在"}), 404
    try:
        params = {"results": 1}
        if source["read_api_key"]:
            params["api_key"] = source["read_api_key"]
        response = requests.get(
            f"{THINGSPEAK_BASE}/channels/{source['channel_id']}/feeds.json",
            params=params,
            timeout=10,
        )
        response.raise_for_status()
        payload = response.json()
        channel = payload.get("channel") if isinstance(payload, dict) else None
        fields = {
            key: value for key, value in channel.items() if key.startswith("field")
        } if isinstance(channel, dict) else {}
        if not fields:
            return jsonify({"error": "ThingSpeak 未返回 Channel Field 元数据"}), 502
        return jsonify(fields)
    except (requests.RequestException, ValueError, AttributeError) as exc:
        return jsonify({"error": f"ThingSpeak 请求失败：{exc}"}), 502


def get_source(source_id):
    with get_db() as db:
        row = db.execute("SELECT * FROM data_sources WHERE id = ?", (source_id,)).fetchone()
    return dict(row) if row else None


def get_shared_card(token):
    with get_db() as db:
        row = db.execute(
            "SELECT * FROM dashboard_cards WHERE share_token = ? AND share_enabled = 1", (token,)
        ).fetchone()
    return row


def get_share_window(card, requested=None):
    now = datetime.now(timezone.utc)
    try:
        options = [int(item) for item in json.loads(card["share_windows"])]
    except (TypeError, ValueError, json.JSONDecodeError):
        options = [int(card["share_hours"] or 24)]
    options = [item for item in options if item in {0, 1, 6, 12, 24, 72, 168, 720}]
    if not options:
        options = [24]
    try:
        requested_window = int(requested) if requested is not None else options[0]
    except (TypeError, ValueError):
        requested_window = options[0]
    selected = requested_window if requested_window in options else options[0]
    labels = {
        1: "最近 1 小时",
        6: "最近 6 小时",
        12: "最近 12 小时",
        24: "最近 24 小时",
        72: "最近 3 天",
        168: "最近 7 天",
        720: "最近 30 天",
    }
    if selected > 0:
        return now - timedelta(hours=selected), now, labels.get(selected, "最近 24 小时"), selected, options
    try:
        start = datetime.fromisoformat(card["share_start"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(card["share_end"].replace("Z", "+00:00"))
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return start, end, "自定义时间", selected, options
    except (AttributeError, TypeError, ValueError):
        return now - timedelta(hours=24), now, "最近 24 小时", 24, options


@app.get("/share/<token>")
def share_view(token):
    card = get_shared_card(token)
    if not card:
        return render_template("share.html", missing=True), 404
    return render_template("share.html", missing=False, card_title=card["title"])


@app.get("/api/share/<token>")
def share_data(token):
    card = get_shared_card(token)
    if not card:
        return jsonify({"error": "分享链接不存在或已关闭"}), 404
    selections = card_field_selections(card)
    selected_source_ids = {selection["source_id"] for selection in selections}
    source_ids = selected_source_ids | {card["source_id"]}
    with get_db() as db:
        placeholders = ",".join("?" for _ in source_ids)
        sources = {
            row["id"]: row
            for row in db.execute(
                f"SELECT * FROM data_sources WHERE id IN ({placeholders})", tuple(source_ids)
            ).fetchall()
        }
    source = sources.get(card["source_id"])
    if not source or not source["enabled"]:
        return jsonify({"error": "数据源已禁用"}), 409
    start_time, end_time, window_label, selected_window, available_windows = get_share_window(
        card, request.args.get("window")
    )
    try:
        source_data = {}
        for selected_source_id in selected_source_ids:
            selected_source = sources.get(selected_source_id)
            if not selected_source:
                continue
            dataset = {
                "source": {"id": selected_source_id, "name": selected_source["name"]},
                "fields": get_fields(selected_source_id),
                "channel": {},
                "feeds": [],
            }
            if selected_source["enabled"]:
                params = {
                    "start": start_time.isoformat(),
                    "end": end_time.isoformat(),
                }
                if selected_source["read_api_key"]:
                    params["api_key"] = selected_source["read_api_key"]
                response = requests.get(
                    f"{THINGSPEAK_BASE}/channels/{selected_source['channel_id']}/feeds.json",
                    params=params,
                    timeout=15,
                )
                response.raise_for_status()
                response_payload = response.json()
                channel = response_payload.get("channel") or {}
                dataset["channel"] = {
                    key: value for key, value in channel.items() if key.startswith("field")
                }
                dataset["feeds"] = response_payload.get("feeds") or []
            source_data[str(selected_source_id)] = dataset
        owner_data = source_data.get(str(source["id"]), {})
        payload = {
            "channel": owner_data.get("channel", {}),
            "feeds": owner_data.get("feeds", []),
            "fields": get_fields(source["id"]),
            "source": {"id": source["id"], "name": source["name"]},
            "source_data": source_data,
        }
        payload["card"] = card_public(card, include_token=False)
        payload["share_window"] = window_label
        payload["selected_window"] = selected_window
        payload["available_windows"] = available_windows
        return jsonify(payload)
    except (requests.RequestException, ValueError) as exc:
        return jsonify({"error": f"无法读取 ThingSpeak 数据：{exc}"}), 502


@app.get("/api/sources/<int:source_id>/data")
def source_data(source_id):
    source = get_source(source_id)
    if not source:
        return jsonify({"error": "数据源不存在"}), 404
    if not source["enabled"]:
        return jsonify({"error": "数据源已禁用"}), 409

    last_only = request.args.get("last") in {"1", "true", "yes"}
    params = {"offset": 0}
    api_key = source["read_api_key"]
    if api_key:
        params["api_key"] = api_key
    start = request.args.get("start")
    end = request.args.get("end")
    if not last_only:
        if start:
            params["start"] = start
        if end:
            params["end"] = end
        if not start and not end:
            try:
                requested_results = int(request.args.get("results", 200))
            except (TypeError, ValueError):
                requested_results = 200
            params["results"] = min(max(requested_results, 1), 8000)
    try:
        endpoint = "feeds/last.json" if last_only else "feeds.json"
        response = requests.get(f"{THINGSPEAK_BASE}/channels/{source['channel_id']}/{endpoint}", params=params, timeout=15)
        response.raise_for_status()
        payload = response.json()
        if last_only:
            payload = {"feeds": [payload] if payload.get("entry_id") else []}
        payload["source"] = {"id": source["id"], "name": source["name"], "channel_id": source["channel_id"]}
        return jsonify(payload)
    except (requests.RequestException, ValueError) as exc:
        return jsonify({"error": f"无法读取 ThingSpeak 数据：{exc}"}), 502


@app.errorhandler(Exception)
def handle_error(error):
    app.logger.exception(error)
    return jsonify({"error": "服务器内部错误"}), 500


init_db()

if __name__ == "__main__":
    app.run(host=os.getenv("FLASK_HOST", "127.0.0.1"), port=int(os.getenv("FLASK_PORT", "5000")), debug=os.getenv("FLASK_DEBUG", "0") == "1")
