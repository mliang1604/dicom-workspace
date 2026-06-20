import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../app.routes';
import { DisclaimerStore } from '../disclaimer-store';

describe('Disclaimer accessibility', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  async function renderDisclaimer(): Promise<RouterTestingHarness> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/disclaimer');
    return harness;
  }

  it('labels the card region by its heading', async () => {
    const el = (await renderDisclaimer()).routeNativeElement!;
    const region = el.querySelector('[role="region"]')!;
    const heading = el.querySelector('h1')!;

    expect(heading.id).toBeTruthy();
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
  });

  it('exposes both decisions as keyboard-reachable buttons in a logical order', async () => {
    const el = (await renderDisclaimer()).routeNativeElement!;
    const buttons = Array.from(el.querySelectorAll('button')) as HTMLButtonElement[];

    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      'Decline',
      'I acknowledge and accept',
    ]);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('acknowledges and proceeds when the accept button is activated', async () => {
    const harness = await renderDisclaimer();
    const accept = harness.routeNativeElement!.querySelector('.accept') as HTMLButtonElement;

    accept.focus();
    accept.click(); // what Enter/Space do on a focused native button
    await harness.fixture.whenStable();

    expect(TestBed.inject(DisclaimerStore).isAcknowledged()).toBe(true);
    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('routes to the dead-end page when the user declines via the keyboard', async () => {
    const harness = await renderDisclaimer();
    const decline = harness.routeNativeElement!.querySelector('.decline') as HTMLButtonElement;

    decline.focus();
    decline.click();
    await harness.fixture.whenStable();

    expect(TestBed.inject(DisclaimerStore).isAcknowledged()).toBe(false);
    expect(TestBed.inject(Router).url).toBe('/declined');
  });

  it('offers a keyboard-reachable path back to the disclaimer from the dead end', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/declined');
    const el = harness.routeNativeElement!;

    const region = el.querySelector('[role="region"]')!;
    const heading = el.querySelector('h1')!;
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);

    const reconsider = el.querySelector('button') as HTMLButtonElement;
    reconsider.focus();
    expect(document.activeElement).toBe(reconsider);
    reconsider.click();
    await harness.fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/disclaimer');
  });
});
