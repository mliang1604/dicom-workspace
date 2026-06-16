import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('creates the root component', () => {
    const fixture = TestBed.createComponent(App);

    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the viewer toolbar', async () => {
    const fixture = TestBed.createComponent(App);

    await fixture.whenStable();

    const brand = fixture.nativeElement.querySelector('.brand') as HTMLElement | null;
    expect(brand?.textContent).toContain('DICOM Workspace');
  });
});
