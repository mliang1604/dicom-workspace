import { Routes } from '@angular/router';
import { Viewer } from './viewer/viewer';
import { Disclaimer } from './disclaimer/disclaimer';
import { Declined } from './declined/declined';
import { acknowledgedGuard } from './acknowledged-guard';

export const routes: Routes = [
  { path: '', component: Viewer, canActivate: [acknowledgedGuard] },
  { path: 'disclaimer', component: Disclaimer },
  { path: 'declined', component: Declined },
  { path: '**', redirectTo: '' },
];
