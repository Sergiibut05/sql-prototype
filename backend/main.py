"""
Microservicio de parsing SQL con sqlglot.

Expone un endpoint POST /parse que recibe:
  { "sql": "SELECT ...", "dialect": "postgres" }

Y devuelve el grafo (tablas + joins) en el mismo formato
que usa el frontend Angular:
  {
    "nodes": [{ "id": "...", "name": "...", "columns": [...] }],
    "links": [{ "source": "...", "target": "...", "sourceColumn": "...", "targetColumn": "...", "type": "inner" }]
  }

Uso:
  pip install -r requirements.txt
  python main.py
  → http://localhost:8000/parse
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sqlglot
from sqlglot import exp
import uvicorn

app = FastAPI(title="SQL Parser (sqlglot)")

# Allow CORS from Angular dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ParseRequest(BaseModel):
    sql: str
    dialect: str = "postgres"  # postgres, mysql, bigquery, snowflake, etc.


class GraphNode(BaseModel):
    id: str
    name: str
    columns: list[str] = []
    schema_name: str | None = None
    is_subquery: bool = False


class GraphLink(BaseModel):
    source: str
    target: str
    sourceColumn: str = ""
    targetColumn: str = ""
    type: str = "inner"  # inner, left, right, full


class GraphData(BaseModel):
    nodes: list[GraphNode]
    links: list[GraphLink]


def normalize_join_type(join_type: str) -> str:
    """Normalize join type string to one of: inner, left, right, full."""
    jt = join_type.upper() if join_type else ""
    if "LEFT" in jt:
        return "left"
    if "RIGHT" in jt:
        return "right"
    if "FULL" in jt or "OUTER" in jt:
        return "full"
    if "CROSS" in jt:
        return "inner"
    return "inner"


def parse_sql_to_graph(sql: str, dialect: str = "postgres") -> GraphData:
    """
    Parse a SQL query using sqlglot and extract:
      - Tables (nodes) with referenced columns
      - Joins (links) with join conditions
    """
    nodes_map: dict[str, GraphNode] = {}
    links: list[GraphLink] = []
    alias_to_id: dict[str, str] = {}

    try:
        # Parse the SQL into an AST
        parsed = sqlglot.parse(sql, read=dialect)
    except Exception as e:
        print(f"sqlglot parse error: {e}")
        return GraphData(nodes=[], links=[])

    for statement in parsed:
        if statement is None:
            continue

        # Extract all table references (including subqueries)
        for table in statement.find_all(exp.Table):
            schema = table.db or ""
            table_name = table.name
            if not table_name:
                continue

            node_id = f"{schema}.{table_name}" if schema else table_name
            alias = table.alias or table_name

            if node_id not in nodes_map:
                nodes_map[node_id] = GraphNode(
                    id=node_id,
                    name=alias,
                    schema_name=schema or None,
                )
            else:
                # Update alias if provided
                if table.alias:
                    nodes_map[node_id].name = alias

            alias_to_id[alias] = node_id
            alias_to_id[table_name] = node_id

        # Extract subqueries
        for subquery in statement.find_all(exp.Subquery):
            alias = subquery.alias or f"sub_{len(nodes_map)}"
            node_id = f"__sub_{alias}"
            if node_id not in nodes_map:
                nodes_map[node_id] = GraphNode(
                    id=node_id,
                    name=alias,
                    is_subquery=True,
                )
            alias_to_id[alias] = node_id

        # Extract joins and their ON conditions
        for join in statement.find_all(exp.Join):
            join_type = normalize_join_type(join.kind or "")

            # Get the ON condition
            on_condition = join.args.get("on")
            if on_condition is None:
                continue

            # Find column references in the ON condition (looking for equality)
            for eq in [on_condition] if isinstance(on_condition, exp.EQ) else on_condition.find_all(exp.EQ):
                left = eq.left
                right = eq.right

                if isinstance(left, exp.Column) and isinstance(right, exp.Column):
                    left_table = left.table or ""
                    right_table = right.table or ""
                    left_col = left.name
                    right_col = right.name

                    source_id = alias_to_id.get(left_table, left_table)
                    target_id = alias_to_id.get(right_table, right_table)

                    # Add columns to their respective nodes
                    if source_id in nodes_map and left_col not in nodes_map[source_id].columns:
                        nodes_map[source_id].columns.append(left_col)
                    if target_id in nodes_map and right_col not in nodes_map[target_id].columns:
                        nodes_map[target_id].columns.append(right_col)

                    links.append(GraphLink(
                        source=source_id,
                        target=target_id,
                        sourceColumn=left_col,
                        targetColumn=right_col,
                        type=join_type,
                    ))
                    break  # Only take the first equality from compound conditions

        # Also extract column references from SELECT, WHERE, GROUP BY, etc.
        # to populate node columns more fully
        for col_ref in statement.find_all(exp.Column):
            table_ref = col_ref.table
            col_name = col_ref.name
            if table_ref and col_name:
                node_id = alias_to_id.get(table_ref, table_ref)
                if node_id in nodes_map and col_name not in nodes_map[node_id].columns:
                    nodes_map[node_id].columns.append(col_name)

    # Convert to output format
    nodes = []
    for node in nodes_map.values():
        nodes.append({
            "id": node.id,
            "name": node.name,
            "columns": node.columns,
            "schema": node.schema_name,
            "isSubquery": node.is_subquery,
        })

    links_out = []
    for link in links:
        links_out.append({
            "source": link.source,
            "target": link.target,
            "sourceColumn": link.sourceColumn,
            "targetColumn": link.targetColumn,
            "type": link.type,
        })

    return GraphData(
        nodes=[GraphNode(**n) for n in nodes],
        links=[GraphLink(**l) for l in links_out],
    )


@app.post("/parse")
def parse_endpoint(req: ParseRequest):
    """Parse SQL and return graph data (nodes + links)."""
    result = parse_sql_to_graph(req.sql, req.dialect)

    # Return in the exact format the Angular frontend expects
    return {
        "nodes": [
            {
                "id": n.id,
                "name": n.name,
                "columns": n.columns,
                "schema": n.schema_name,
                "isSubquery": n.is_subquery,
            }
            for n in result.nodes
        ],
        "links": [
            {
                "source": l.source,
                "target": l.target,
                "sourceColumn": l.sourceColumn,
                "targetColumn": l.targetColumn,
                "type": l.type,
            }
            for l in result.links
        ],
    }


@app.get("/health")
def health():
    return {"status": "ok", "parser": "sqlglot"}


if __name__ == "__main__":
    print("🚀 Starting sqlglot parser server on http://localhost:8000")
    print("📖 Docs: http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000)
