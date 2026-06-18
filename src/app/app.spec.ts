import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';
import { DisclaimerStore } from './disclaimer-store';

describe('App', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('creates the root component', () => {
    const fixture = TestBed.createComponent(App);

    expect(fixture.componentInstance).toBeTruthy();
  });

  it('redirects to the disclaimer when it has not been acknowledged', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');

    expect(TestBed.inject(Router).url).toBe('/disclaimer');
    const notice = harness.routeNativeElement?.querySelector('.notice');
    expect(notice?.textContent).toContain('not a certified medical device');
  });

  it('lets an acknowledged user reach the viewer', async () => {
    TestBed.inject(DisclaimerStore).acknowledge();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');

    expect(TestBed.inject(Router).url).toBe('/');
    const brand = harness.routeNativeElement?.querySelector('.brand');
    expect(brand?.textContent).toContain('DICOM Workspace');
  });

  it('sends a declining user to the dead-end page', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/disclaimer');

    const decline = harness.routeNativeElement?.querySelector('.decline') as HTMLButtonElement;
    decline.click();
    await harness.fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/declined');
  });
});
