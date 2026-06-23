import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { clamp } from '../../dicom/math';
import { Orientation } from '../../dicom/types';

/** Default cine playback speed (fps), used until the user picks another. */
export const DEFAULT_CINE_FPS = 15;

/** Slowest / fastest interval the timer is clamped to (fps), guarding bad input. */
const MIN_CINE_FPS = 1;
const MAX_CINE_FPS = 60;

/**
 * What one cine session drives: the pane to advance (captured for the session's
 * life) and how to step it. The store calls {@link advance} once per tick with
 * the captured orientation, which keeps the store free of the renderer — the
 * caller supplies the slice count and the index update.
 */
export interface CineSession {
  /** Orientation whose stack to cine, captured when playback starts. */
  readonly orientation: Orientation;
  /** Advance the given orientation's slice by one tick (looping at the ends). */
  readonly advance: (orientation: Orientation) => void;
}

/**
 * Owns cine playback: the play/pause flag, the speed, the orientation being
 * cined, and the interval timer. The viewer drives it through {@link toggle} /
 * {@link setFps} / {@link stop}; the actual slice stepping is injected as a
 * {@link CineSession} so the store never touches the renderer. The timer is torn
 * down on teardown via {@link DestroyRef}.
 *
 * Provided at the component so its lifetime tracks the viewer.
 */
@Injectable()
export class CineStore {
  private readonly playing = signal(false);
  /** True while cine playback is auto-advancing slices through a pane. */
  readonly isPlaying = this.playing.asReadonly();

  /** Cine playback speed in frames per second. */
  readonly fps = signal(DEFAULT_CINE_FPS);

  /** Orientation whose slices cine is advancing; captured when playback starts. */
  private readonly orientation = signal<Orientation>(Orientation.Axial);

  /** Handle of the playback interval, or null when paused. */
  private handle: ReturnType<typeof setInterval> | null = null;

  /** How to step the cined pane; held for the session so re-arming reuses it. */
  private advance: ((orientation: Orientation) => void) | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /**
   * Start or stop playback. When starting, `begin` returns the session describing
   * which pane to cine and how to step it, or null when nothing can be cined right
   * now (no volume / no MPR pane) — in which case playback stays stopped.
   */
  toggle(begin: () => CineSession | null): void {
    if (this.playing()) {
      this.stop();
      return;
    }
    const session = begin();
    if (!session) return;
    this.orientation.set(session.orientation);
    this.advance = session.advance;
    this.playing.set(true);
    this.rearm();
  }

  /**
   * Change the speed. Ignores non-positive / non-finite input; re-arms a running
   * timer so the new fps takes effect at once.
   */
  setFps(fps: number): void {
    if (!Number.isFinite(fps) || fps <= 0) return;
    this.fps.set(fps);
    if (this.playing()) this.rearm();
  }

  /** Stop playback and clear its timer. Idempotent — safe to call any time. */
  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
    this.advance = null;
    if (this.playing()) this.playing.set(false);
  }

  /** (Re)arm the interval from the current fps, replacing any running timer. */
  private rearm(): void {
    if (this.handle !== null) clearInterval(this.handle);
    const fps = clamp(this.fps(), MIN_CINE_FPS, MAX_CINE_FPS);
    this.handle = setInterval(() => this.advance?.(this.orientation()), 1000 / fps);
  }
}
