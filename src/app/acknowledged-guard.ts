import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { DisclaimerStore } from './disclaimer-store';

/**
 * Blocks the main application until the medical-device disclaimer has been
 * acknowledged. Unacknowledged visitors are redirected to the disclaimer page.
 */
export const acknowledgedGuard: CanActivateFn = () => {
  const store = inject(DisclaimerStore);
  const router = inject(Router);
  return store.isAcknowledged() ? true : router.createUrlTree(['/disclaimer']);
};
