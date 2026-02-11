import { Injectable } from '@angular/core';
import { GraphData, GraphNode, GraphLink } from '../../shared/models/graph.model';
import { Parser } from 'node-sql-parser';

@Injectable({ providedIn: 'root' })
export class SqlParserService {
  private parser = new Parser();
  private readonly dbOpt = { database: 'PostgresQL' as const };

  parseQueryToGraph(sql: string): GraphData {
    try {
      const ast = this.parser.astify(sql, this.dbOpt);
      const stmts = Array.isArray(ast) ? ast : [ast];

      const nodesMap = new Map<string, GraphNode>();
      const links: GraphLink[] = [];
      const aliasToId = new Map<string, string>();

      for (const stmt of stmts) {
        const s = stmt as any;
        if (s.from) {
          this.extractFromClause(s.from, nodesMap, links, aliasToId);
        }
      }

      // Set node val based on column count
      for (const node of nodesMap.values()) {
        node.val = Math.max(2, (node.columns?.length || 0) + 1);
      }

      return {
        nodes: Array.from(nodesMap.values()),
        links,
      };
    } catch (err) {
      console.warn('SQL parse error:', err);
      return { nodes: [], links: [] };
    }
  }

  private extractFromClause(
    from: any[],
    nodesMap: Map<string, GraphNode>,
    links: GraphLink[],
    aliasToId: Map<string, string>,
  ): void {
    for (const item of from) {
      this.processTableRef(item, nodesMap, links, aliasToId);

      if (item.join && item.on) {
        const link = this.extractOnCondition(
          item.on,
          nodesMap,
          aliasToId,
          item.join,
        );
        if (link) links.push(link);
      }
    }
  }

  private processTableRef(
    item: any,
    nodesMap: Map<string, GraphNode>,
    links: GraphLink[],
    aliasToId: Map<string, string>,
  ): void {
    if (item.table) {
      const schema = item.db || '';
      const tableName = item.table;
      const id = schema ? `${schema}.${tableName}` : tableName;
      const alias = item.as || tableName;

      if (!nodesMap.has(id)) {
        nodesMap.set(id, {
          id,
          name: alias,
          schema: schema || undefined,
          columns: [],
        });
      } else {
        // Update alias if changed
        const existing = nodesMap.get(id)!;
        if (item.as) existing.name = item.as;
      }
      aliasToId.set(alias, id);
      aliasToId.set(tableName, id);
    } else if (item.expr) {
      // Subquery / derived table
      const subAst = item.expr.ast || item.expr;
      const alias = item.as || `sub_${nodesMap.size}`;
      const id = `__sub_${alias}`;

      if (!nodesMap.has(id)) {
        nodesMap.set(id, {
          id,
          name: alias,
          isSubquery: true,
          columns: [],
        });
      }
      aliasToId.set(alias, id);

      // Recurse into subquery FROM
      if (subAst.from) {
        this.extractFromClause(subAst.from, nodesMap, links, aliasToId);
      }
    }
  }

  private extractOnCondition(
    on: any,
    nodesMap: Map<string, GraphNode>,
    aliasToId: Map<string, string>,
    joinType: string,
  ): GraphLink | null {
    if (on.type === 'binary_expr' && on.operator === '=') {
      const left = on.left;
      const right = on.right;

      if (left.type === 'column_ref' && right.type === 'column_ref') {
        const leftTable = left.table;
        const rightTable = right.table;
        const leftCol = left.column;
        const rightCol = right.column;

        const sourceId = aliasToId.get(leftTable) || leftTable;
        const targetId = aliasToId.get(rightTable) || rightTable;

        this.addColumn(nodesMap, sourceId, leftCol);
        this.addColumn(nodesMap, targetId, rightCol);

        return {
          source: sourceId,
          target: targetId,
          sourceColumn: leftCol,
          targetColumn: rightCol,
          type: this.normalizeJoinType(joinType),
        };
      }
    }

    // Handle compound conditions (AND)
    if (on.type === 'binary_expr' && on.operator === 'AND') {
      return this.extractOnCondition(on.left, nodesMap, aliasToId, joinType);
    }

    return null;
  }

  private addColumn(
    nodesMap: Map<string, GraphNode>,
    nodeId: string,
    column: string,
  ): void {
    const node = nodesMap.get(nodeId);
    if (node && node.columns && !node.columns.includes(column)) {
      node.columns.push(column);
    }
  }

  private normalizeJoinType(
    join: string,
  ): 'inner' | 'left' | 'right' | 'full' {
    const j = join.toUpperCase();
    if (j.includes('LEFT')) return 'left';
    if (j.includes('RIGHT')) return 'right';
    if (j.includes('FULL')) return 'full';
    return 'inner';
  }
}
