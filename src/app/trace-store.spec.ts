import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableTrace } from '../diag/trace';
import { TraceStore } from './trace-store';

const STORAGE_KEY = 'dicom-workspace.trace';

describe('TraceStore', () => {
  beforeEach(() => {
    disableTrace('all'); // reset the shared singleton between tests
    localStorage.clear();
  });
  afterEach(() => {
    disableTrace('all');
    localStorage.clear();
  });

  it('toggles a category on and off', () => {
    const store = new TraceStore();
    expect(store.isEnabled('merge')).toBe(false);
    expect(store.anyEnabled()).toBe(false);

    store.toggle('merge');
    expect(store.isEnabled('merge')).toBe(true);
    expect(store.anyEnabled()).toBe(true);

    store.toggle('merge');
    expect(store.isEnabled('merge')).toBe(false);
    expect(store.anyEnabled()).toBe(false);
  });

  it('persists the enabled spec to localStorage, removing the key when empty', () => {
    const store = new TraceStore();
    store.toggle('load');
    store.toggle('merge');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('load,merge');

    store.disableAll();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('seeds its initial state from the shared tracer', () => {
    // A category already enabled on the tracer (e.g. from a persisted spec read at
    // startup) is reflected when a fresh store is constructed.
    new TraceStore().toggle('align');
    expect(new TraceStore().isEnabled('align')).toBe(true);
  });

  it('enableAll turns on every category and disableAll clears them', () => {
    const store = new TraceStore();
    store.enableAll();
    for (const category of store.categories) expect(store.isEnabled(category)).toBe(true);

    store.disableAll();
    for (const category of store.categories) expect(store.isEnabled(category)).toBe(false);
  });
});
