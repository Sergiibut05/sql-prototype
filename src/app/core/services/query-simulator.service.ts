import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, interval, takeUntil } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class QuerySimulatorService implements OnDestroy {
  private readonly INTERVAL_MS = 12_000;

  private readonly queries: string[] = [
    // Step 1: Single table
    `SELECT * FROM shop.customers c`,

    // Step 2: Add orders
    `SELECT c.customer_id, c.full_name, o.order_id, o.order_date
FROM shop.customers c
JOIN shop.orders o ON c.customer_id = o.customer_id`,

    // Step 3: Add order_items
    `SELECT c.customer_id, o.order_id, oi.order_item_id, oi.product_id
FROM shop.customers c
JOIN shop.orders o ON c.customer_id = o.customer_id
JOIN shop.order_items oi ON o.order_id = oi.order_id`,

    // Step 4: Add products
    `SELECT c.customer_id, o.order_id, oi.order_item_id, p.name AS product_name
FROM shop.customers c
JOIN shop.orders o ON c.customer_id = o.customer_id
JOIN shop.order_items oi ON o.order_id = oi.order_id
JOIN shop.products p ON oi.product_id = p.product_id`,

    // Step 5: Add categories
    `SELECT c.customer_id, o.order_id, p.name AS product_name, cat.name AS category_name
FROM shop.customers c
JOIN shop.orders o ON c.customer_id = o.customer_id
JOIN shop.order_items oi ON o.order_id = oi.order_id
JOIN shop.products p ON oi.product_id = p.product_id
JOIN shop.categories cat ON p.category_id = cat.category_id`,

    // Step 6: Add reviews
    `SELECT c.customer_id, o.order_id, p.name AS product_name, cat.name AS category_name, rv.rating
FROM shop.customers c
JOIN shop.orders o ON c.customer_id = o.customer_id
JOIN shop.order_items oi ON o.order_id = oi.order_id
JOIN shop.products p ON oi.product_id = p.product_id
JOIN shop.categories cat ON p.category_id = cat.category_id
JOIN shop.reviews rv ON rv.product_id = p.product_id AND rv.customer_id = c.customer_id`,

    // Step 7: Full complex query with subquery
    `SELECT cat.name AS category_name,
  COUNT(DISTINCT CASE WHEN pr.avg_rating >= 4 THEN pr.customer_id END) AS satisfied_customers,
  COUNT(DISTINCT pr.customer_id) AS total_customers
FROM shop.categories cat
JOIN (
  SELECT p.category_id, o.customer_id, AVG(rv.rating) AS avg_rating
  FROM shop.products p
  JOIN shop.order_items oi ON oi.product_id = p.product_id
  JOIN shop.orders o ON o.order_id = oi.order_id
  JOIN shop.reviews rv ON rv.product_id = p.product_id AND rv.customer_id = o.customer_id
  WHERE o.status = 'completed'
  GROUP BY p.category_id, o.customer_id
) AS pr ON cat.category_id = pr.category_id
GROUP BY cat.category_id, cat.name
ORDER BY satisfied_customers DESC`,
  ];

  private stepIndex = 0;
  private destroy$ = new Subject<void>();
  private stop$ = new Subject<void>();

  private readonly _currentQuery$ = new BehaviorSubject<string>('');
  private readonly _currentStep$ = new BehaviorSubject<number>(0);
  private readonly _running$ = new BehaviorSubject<boolean>(false);

  readonly currentQuery$ = this._currentQuery$.asObservable();
  readonly currentStep$ = this._currentStep$.asObservable();
  readonly running$ = this._running$.asObservable();

  get totalSteps(): number {
    return this.queries.length;
  }

  start(): void {
    this.stop$.next();
    this._running$.next(true);

    // Emit first immediately
    this.emitCurrent();

    interval(this.INTERVAL_MS)
      .pipe(takeUntil(this.stop$), takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.stepIndex < this.queries.length - 1) {
          this.stepIndex++;
          this.emitCurrent();
        } else {
          this.stop();
        }
      });
  }

  stop(): void {
    this.stop$.next();
    this._running$.next(false);
  }

  next(): void {
    if (this.stepIndex < this.queries.length - 1) {
      this.stepIndex++;
      this.emitCurrent();
    }
  }

  prev(): void {
    if (this.stepIndex > 0) {
      this.stepIndex--;
      this.emitCurrent();
    }
  }

  private emitCurrent(): void {
    this._currentQuery$.next(this.queries[this.stepIndex]);
    this._currentStep$.next(this.stepIndex + 1);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
