"""
Vercel Serverless Function — SQL Parser using sqlglot.

Vercel Python runtime automatically detects this file in the api/ directory
and exposes it as POST /api/parse.

The handler class receives HTTP requests and returns JSON responses
in the same format the Angular frontend expects.
"""

from http.server import BaseHTTPRequestHandler
import json
import sqlglot
from sqlglot import exp


def normalize_join_type(join_type: str) -> str:
    jt = (join_type or "").upper()
    if "LEFT" in jt:
        return "left"
    if "RIGHT" in jt:
        return "right"
    if "FULL" in jt or "OUTER" in jt:
        return "full"
    return "inner"


def parse_sql_to_graph(sql: str, dialect: str = "postgres") -> dict:
    nodes_map: dict[str, dict] = {}
    links: list[dict] = []
    alias_to_id: dict[str, str] = {}

    try:
        parsed = sqlglot.parse(sql, read=dialect)
    except Exception as e:
        return {"nodes": [], "links": [], "error": str(e)}

    for statement in parsed:
        if statement is None:
            continue

        # Extract all table references
        for table in statement.find_all(exp.Table):
            schema = table.db or ""
            table_name = table.name
            if not table_name:
                continue

            node_id = f"{schema}.{table_name}" if schema else table_name
            alias = table.alias or table_name

            if node_id not in nodes_map:
                nodes_map[node_id] = {
                    "id": node_id,
                    "name": alias,
                    "columns": [],
                    "schema": schema or None,
                    "isSubquery": False,
                }
            elif table.alias:
                nodes_map[node_id]["name"] = alias

            alias_to_id[alias] = node_id
            alias_to_id[table_name] = node_id

        # Extract subqueries
        for subquery in statement.find_all(exp.Subquery):
            alias = subquery.alias or f"sub_{len(nodes_map)}"
            node_id = f"__sub_{alias}"
            if node_id not in nodes_map:
                nodes_map[node_id] = {
                    "id": node_id,
                    "name": alias,
                    "columns": [],
                    "schema": None,
                    "isSubquery": True,
                }
            alias_to_id[alias] = node_id

        # Extract joins
        for join in statement.find_all(exp.Join):
            join_type = normalize_join_type(join.kind or "")
            on_condition = join.args.get("on")
            if on_condition is None:
                continue

            eqs = [on_condition] if isinstance(on_condition, exp.EQ) else on_condition.find_all(exp.EQ)
            for eq in eqs:
                left = eq.left
                right = eq.right

                if isinstance(left, exp.Column) and isinstance(right, exp.Column):
                    left_table = left.table or ""
                    right_table = right.table or ""
                    left_col = left.name
                    right_col = right.name

                    source_id = alias_to_id.get(left_table, left_table)
                    target_id = alias_to_id.get(right_table, right_table)

                    if source_id in nodes_map and left_col not in nodes_map[source_id]["columns"]:
                        nodes_map[source_id]["columns"].append(left_col)
                    if target_id in nodes_map and right_col not in nodes_map[target_id]["columns"]:
                        nodes_map[target_id]["columns"].append(right_col)

                    links.append({
                        "source": source_id,
                        "target": target_id,
                        "sourceColumn": left_col,
                        "targetColumn": right_col,
                        "type": join_type,
                    })
                    break

        # Extract column references from SELECT, WHERE, etc.
        for col_ref in statement.find_all(exp.Column):
            table_ref = col_ref.table
            col_name = col_ref.name
            if table_ref and col_name:
                node_id = alias_to_id.get(table_ref, table_ref)
                if node_id in nodes_map and col_name not in nodes_map[node_id]["columns"]:
                    nodes_map[node_id]["columns"].append(col_name)

    return {
        "nodes": list(nodes_map.values()),
        "links": links,
    }


class handler(BaseHTTPRequestHandler):
    """Vercel Python Serverless Function handler."""

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length)) if content_length else {}

            sql = body.get("sql", "")
            dialect = body.get("dialect", "postgres")

            result = parse_sql_to_graph(sql, dialect)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        """Health check."""
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok", "parser": "sqlglot"}).encode())
