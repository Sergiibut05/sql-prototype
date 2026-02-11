import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, interval, takeUntil } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class QuerySimulatorService implements OnDestroy {
  private readonly INTERVAL_MS = 12_000;

  private readonly queries: string[] = [
    // Step 1: Single table
    `SELECT * FROM torcal_erp.aut_autoescuela au`,

    // Step 2: Add alumno_matricula
    `SELECT au.aut_pk, au.aut_denominacion, am.alumat_pk, am.alu_pk
FROM torcal_erp.aut_autoescuela au
JOIN torcal_erp.alumat_alumno_matricula am ON au.aut_pk = am.aut_pk`,

    // Step 3: Add alumno_examen_permiso
    `SELECT au.aut_pk, am.alumat_pk, aep.aluexps_pk
FROM torcal_erp.aut_autoescuela au
JOIN torcal_erp.alumat_alumno_matricula am ON au.aut_pk = am.aut_pk
JOIN torcal_erp.aluexps_alumno_examen_permiso aep ON am.alumat_pk = aep.alumat_alumno_matricula_alumat_pk`,

    // Step 4: Add tipo_examen
    `SELECT au.aut_pk, am.alumat_pk, aep.aluexps_pk, te.text_desc
FROM torcal_erp.aut_autoescuela au
JOIN torcal_erp.alumat_alumno_matricula am ON au.aut_pk = am.aut_pk
JOIN torcal_erp.aluexps_alumno_examen_permiso aep ON am.alumat_pk = aep.alumat_alumno_matricula_alumat_pk
JOIN torcal_erp.tex_tipo_examen te ON aep.tex_tipo_examen_tex_pk = te.tex_pk`,

    // Step 5: Add alumno_permiso
    `SELECT au.aut_pk, am.alumat_pk, aep.aluexps_pk, te.text_desc, aps.alups_pk
FROM torcal_erp.aut_autoescuela au
JOIN torcal_erp.alumat_alumno_matricula am ON au.aut_pk = am.aut_pk
JOIN torcal_erp.aluexps_alumno_examen_permiso aep ON am.alumat_pk = aep.alumat_alumno_matricula_alumat_pk
JOIN torcal_erp.tex_tipo_examen te ON aep.tex_tipo_examen_tex_pk = te.tex_pk
JOIN torcal_erp.alups_alumno_permiso aps ON aep.alups_alumno_permiso_alups_pk = aps.alups_pk`,

    // Step 6: Add ps_tipo
    `SELECT au.aut_pk, am.alumat_pk, aep.aluexps_pk, te.text_desc, aps.alups_pk, pt.ps_permiso_dgt
FROM torcal_erp.aut_autoescuela au
JOIN torcal_erp.alumat_alumno_matricula am ON au.aut_pk = am.aut_pk
JOIN torcal_erp.aluexps_alumno_examen_permiso aep ON am.alumat_pk = aep.alumat_alumno_matricula_alumat_pk
JOIN torcal_erp.tex_tipo_examen te ON aep.tex_tipo_examen_tex_pk = te.tex_pk
JOIN torcal_erp.alups_alumno_permiso aps ON aep.alups_alumno_permiso_alups_pk = aps.alups_pk
JOIN torcal_erp.ps_tipo pt ON aps.ps_tipo_ps_pk = pt.ps_pk`,

    // Step 7: Full complex query with subquery
    `SELECT au.aut_denominacion AS section_name,
  COUNT(DISTINCT CASE WHEN fa.passed = 1 THEN fa.alu_pk END) AS total_passed,
  COUNT(DISTINCT fa.alu_pk) AS total_students
FROM torcal_erp.aut_autoescuela au
JOIN (
  SELECT am.alu_pk, am.aut_pk,
    CASE WHEN SUM(CASE WHEN te.text_desc = 'Teorico' AND aep.aluexps_nconvocatorias = 1 AND aep.aluexps_apto_sn = 1 THEN 1 ELSE 0 END) > 0
         AND SUM(CASE WHEN te.text_desc = 'Circulacion' AND aep.aluexps_nconvocatorias = 1 AND aep.aluexps_apto_sn = 1 THEN 1 ELSE 0 END) > 0
    THEN 1 ELSE 0 END AS passed
  FROM torcal_erp.aluexps_alumno_examen_permiso aep
  JOIN torcal_erp.tex_tipo_examen te ON aep.tex_tipo_examen_tex_pk = te.tex_pk
  JOIN torcal_erp.alups_alumno_permiso aps ON aep.alups_alumno_permiso_alups_pk = aps.alups_pk
  JOIN torcal_erp.ps_tipo pt ON aps.ps_tipo_ps_pk = pt.ps_pk
  JOIN torcal_erp.alumat_alumno_matricula am ON aep.alumat_alumno_matricula_alumat_pk = am.alumat_pk
  WHERE pt.ps_permiso_dgt = 'B'
  GROUP BY am.alu_pk, am.aut_pk
) AS fa ON au.aut_pk = fa.aut_pk
GROUP BY au.aut_pk, au.aut_denominacion
ORDER BY total_passed DESC`,
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
