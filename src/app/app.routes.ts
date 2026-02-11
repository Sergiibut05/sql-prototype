import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/er-diagram/er-diagram.component').then(
        (m) => m.ErDiagramComponent
      ),
  },
];
