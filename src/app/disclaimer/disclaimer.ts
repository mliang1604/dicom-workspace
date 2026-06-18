import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DisclaimerStore } from '../disclaimer-store';

/**
 * Start-up warning shown before the viewer. The user must acknowledge that this
 * build is not a certified medical device; declining sends them to a
 * non-functional page instead of the application.
 */
@Component({
  selector: 'app-disclaimer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './disclaimer.html',
  styleUrl: './disclaimer.css',
})
export class Disclaimer {
  private readonly store = inject(DisclaimerStore);
  private readonly router = inject(Router);

  protected acknowledge(): void {
    this.store.acknowledge();
    void this.router.navigate(['/']);
  }

  protected decline(): void {
    void this.router.navigate(['/declined']);
  }
}
