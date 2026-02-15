import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, catchError, map, timeout } from 'rxjs';
import { GraphData } from '../../shared/models/graph.model';

/**
 * Service that calls the Python sqlglot backend to parse SQL queries.
 *
 * In development: calls http://localhost:8000 (local Python server)
 * In production (Vercel): calls /api (Vercel Python serverless function)
 *
 * Falls back to returning empty data if the backend is unreachable.
 */
@Injectable({ providedIn: 'root' })
export class SqlglotParserService {
    private readonly baseUrl =
        typeof window !== 'undefined' && window.location.hostname === 'localhost'
            ? 'http://localhost:8000'  // Local dev: Python FastAPI server
            : '/api';                  // Production (Vercel): serverless function

    constructor(private http: HttpClient) { }

    /**
     * Parse a SQL query using sqlglot backend.
     * @param sql The SQL query string
     * @param dialect The SQL dialect (default: 'postgres')
     */
    parseQuery(sql: string, dialect = 'postgres'): Observable<GraphData> {
        return this.http
            .post<{
                nodes: Array<{
                    id: string;
                    name: string;
                    columns: string[];
                    schema: string | null;
                    isSubquery: boolean;
                }>;
                links: Array<{
                    source: string;
                    target: string;
                    sourceColumn: string;
                    targetColumn: string;
                    type: string;
                }>;
            }>(`${this.baseUrl}/parse`, { sql, dialect })
            .pipe(
                timeout(5000),
                map((response) => ({
                    nodes: response.nodes.map((n) => ({
                        id: n.id,
                        name: n.name,
                        columns: n.columns || [],
                        schema: n.schema || undefined,
                        isSubquery: n.isSubquery || false,
                    })),
                    links: response.links.map((l) => ({
                        source: l.source,
                        target: l.target,
                        sourceColumn: l.sourceColumn,
                        targetColumn: l.targetColumn,
                        type: l.type as 'inner' | 'left' | 'right' | 'full',
                    })),
                })),
                catchError((err) => {
                    console.warn('sqlglot backend unreachable:', err.message || err);
                    return of({ nodes: [], links: [] });
                }),
            );
    }

    /**
     * Check if the sqlglot backend is running.
     */
    healthCheck(): Observable<boolean> {
        return this.http.get<{ status: string }>(`${this.baseUrl}/health`).pipe(
            timeout(2000),
            map(() => true),
            catchError(() => of(false)),
        );
    }
}
