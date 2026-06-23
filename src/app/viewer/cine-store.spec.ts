import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orientation } from '../../dicom/types';
import { CineStore, DEFAULT_CINE_FPS, type CineSession } from './cine-store';

/** Build a store inside an injection context (it injects DestroyRef in its ctor). */
function makeStore(): CineStore {
  TestBed.configureTestingModule({ providers: [CineStore] });
  return TestBed.inject(CineStore);
}

/** A session that records the orientations it was ticked with. */
function recordingSession(orientation: Orientation): CineSession & { ticks: Orientation[] } {
  const ticks: Orientation[] = [];
  return { orientation, advance: (o) => ticks.push(o), ticks };
}

describe('CineStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('starts stopped at the default fps', () => {
    const store = makeStore();
    expect(store.isPlaying()).toBe(false);
    expect(store.fps()).toBe(DEFAULT_CINE_FPS);
  });

  it('toggle starts then stops playback', () => {
    const store = makeStore();
    store.toggle(() => recordingSession(Orientation.Axial));
    expect(store.isPlaying()).toBe(true);
    store.toggle(() => recordingSession(Orientation.Coronal));
    expect(store.isPlaying()).toBe(false);
  });

  it('does not start when the session is null (nothing to cine)', () => {
    const store = makeStore();
    store.toggle(() => null);
    expect(store.isPlaying()).toBe(false);
    vi.advanceTimersByTime(1000);
    // No timer was armed, so nothing fires.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop is idempotent and safe before any playback', () => {
    const store = makeStore();
    expect(() => store.stop()).not.toThrow();
    store.toggle(() => recordingSession(Orientation.Axial));
    store.stop();
    store.stop();
    expect(store.isPlaying()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ticks the captured orientation once per interval', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Sagittal);
    store.toggle(() => session);
    // Default 15 fps => one tick every 1000/15 ms.
    vi.advanceTimersByTime((1000 / DEFAULT_CINE_FPS) * 3);
    expect(session.ticks).toEqual([
      Orientation.Sagittal,
      Orientation.Sagittal,
      Orientation.Sagittal,
    ]);
  });

  it('stops advancing once stopped', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    vi.advanceTimersByTime(1000 / DEFAULT_CINE_FPS);
    store.stop();
    vi.advanceTimersByTime(1000);
    expect(session.ticks).toHaveLength(1);
  });

  it('setFps re-arms the running timer so the new rate takes effect at once', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    store.setFps(50); // faster: one tick every 20 ms
    expect(store.fps()).toBe(50);
    vi.advanceTimersByTime(100);
    expect(session.ticks).toHaveLength(5);
  });

  it('setFps while stopped only records the speed, arming no timer', () => {
    const store = makeStore();
    store.setFps(30);
    expect(store.fps()).toBe(30);
    expect(store.isPlaying()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores non-positive or non-finite fps', () => {
    const store = makeStore();
    store.setFps(0);
    store.setFps(-5);
    store.setFps(Number.NaN);
    expect(store.fps()).toBe(DEFAULT_CINE_FPS);
  });

  it('clamps the interval rate so an absurd fps still ticks', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    store.setFps(1000); // clamped to 60 fps => ~16.7 ms per tick
    vi.advanceTimersByTime(1000 / 60);
    expect(session.ticks).toHaveLength(1);
  });

  it('drives the index through a looping advance closure', () => {
    const store = makeStore();
    const count = 3;
    let index = count - 1; // start on the last slice so the next tick wraps
    store.toggle(() => ({
      orientation: Orientation.Axial,
      advance: () => {
        index = (index + 1) % count;
      },
    }));
    const period = 1000 / DEFAULT_CINE_FPS;
    vi.advanceTimersByTime(period);
    expect(index).toBe(0); // wrapped past the end
    vi.advanceTimersByTime(period);
    expect(index).toBe(1);
  });

  it('tears the timer down on destroy', () => {
    const store = makeStore();
    const session = recordingSession(Orientation.Axial);
    store.toggle(() => session);
    expect(vi.getTimerCount()).toBe(1);
    TestBed.resetTestingModule(); // destroys the injector, firing DestroyRef
    expect(vi.getTimerCount()).toBe(0);
    expect(store.isPlaying()).toBe(false);
  });
});
