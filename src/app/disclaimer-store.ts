import { Injectable, signal } from '@angular/core';

/** localStorage key under which the acknowledgement flag is persisted. */
const STORAGE_KEY = 'dicom-workspace.disclaimer-acknowledged';

/**
 * Tracks whether the user has acknowledged the medical-device disclaimer. The
 * flag is persisted so the warning is shown once per browser, not on every
 * navigation. Reads/writes to `localStorage` are guarded so the service still
 * works where storage is unavailable (private mode, server-side rendering).
 */
@Injectable({ providedIn: 'root' })
export class DisclaimerStore {
  private readonly acknowledged = signal(readStored());

  /** Whether the user has accepted the disclaimer in this browser. */
  readonly isAcknowledged = this.acknowledged.asReadonly();

  /** Record that the user accepted the disclaimer and persist the choice. */
  acknowledge(): void {
    this.acknowledged.set(true);
    writeStored(true);
  }
}

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStored(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage is unavailable; the in-memory signal still gates this session.
  }
}
