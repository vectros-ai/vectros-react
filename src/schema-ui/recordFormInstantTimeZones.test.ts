// ---------------------------------------------------------------------------
// `instant` form values across time zones, with literal expectations: the
// process time zone is pinned per block, so a local/UTC mix-up or a wrong
// offset sign fails here even when the suite itself runs in UTC.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fromInstantLocalInputValue, toInstantLocalInputValue } from './recordForm';

function inTimeZone(zone: string, body: () => void): void {
  describe(zone, () => {
    const previous = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = zone;
    });
    afterAll(() => {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    });
    body();
  });
}

inTimeZone('America/New_York', () => {
  it('shows a stored UTC value in local time, keeping seconds and milliseconds', () => {
    expect(toInstantLocalInputValue('2027-01-06T17:00:00.000Z')).toBe('2027-01-06T12:00:00');
    expect(toInstantLocalInputValue('2027-01-06T17:00:30.500Z')).toBe('2027-01-06T12:00:30.500');
    expect(toInstantLocalInputValue('2027-07-06T17:00:00.000Z')).toBe('2027-07-06T13:00:00');
  });

  it('saves a local value as UTC, round-tripping seconds and milliseconds', () => {
    expect(fromInstantLocalInputValue('2027-01-06T12:00')).toBe('2027-01-06T17:00:00.000Z');
    expect(fromInstantLocalInputValue('2027-01-06T12:00:30.500')).toBe('2027-01-06T17:00:30.500Z');
    expect(fromInstantLocalInputValue(toInstantLocalInputValue('2027-01-06T17:00:30.500Z'))).toBe(
      '2027-01-06T17:00:30.500Z',
    );
  });

  it('leaves a local time skipped by the spring-forward change for the server to refuse', () => {
    expect(fromInstantLocalInputValue('2027-03-14T02:30')).toBe('2027-03-14T02:30');
  });

  it('reads the repeated hour of the fall-back change as its first occurrence, and shows both', () => {
    expect(fromInstantLocalInputValue('2027-11-07T01:30')).toBe('2027-11-07T05:30:00.000Z');
    expect(toInstantLocalInputValue('2027-11-07T05:30:00.000Z')).toBe('2027-11-07T01:30:00');
    expect(toInstantLocalInputValue('2027-11-07T06:30:00.000Z')).toBe('2027-11-07T01:30:00');
  });
});

inTimeZone('Asia/Kolkata', () => {
  it('handles a half-hour offset both ways', () => {
    expect(toInstantLocalInputValue('2027-01-06T17:00:00.000Z')).toBe('2027-01-06T22:30:00');
    expect(fromInstantLocalInputValue('2027-01-06T22:30')).toBe('2027-01-06T17:00:00.000Z');
  });
});

inTimeZone('Pacific/Chatham', () => {
  it('handles a quarter-hour offset that moves the date', () => {
    expect(toInstantLocalInputValue('2027-01-06T17:00:00.000Z')).toBe('2027-01-07T06:45:00');
    expect(fromInstantLocalInputValue('2027-01-07T06:45')).toBe('2027-01-06T17:00:00.000Z');
  });
});
