import { describe, it, expect } from 'vitest';
import { computePopoverPosition, type Rect, type Viewport } from './popoverPosition';

function rect(top: number, left: number, width: number, height = 36): Rect {
  return { top, left, width, height, bottom: top + height, right: left + width };
}

const DESKTOP_1920: Viewport = { width: 1920, height: 1080 };
const DESKTOP_1366: Viewport = { width: 1366, height: 768 };
const MOBILE: Viewport = { width: 390, height: 640 };

describe('computePopoverPosition — placement', () => {
  it('opens below when there is plenty of room (trigger near the top)', () => {
    const p = computePopoverPosition(rect(120, 400, 300), DESKTOP_1920);
    expect(p.placement).toBe('bottom');
    expect(p.top).toBe(120 + 36 + 6);
    expect(p.bottom).toBeUndefined();
    expect(p.maxHeight).toBe(360); // capped
  });

  it('flips up when the trigger sits near the bottom (lower credit line)', () => {
    // trigger low in a 768-tall viewport → little room below, lots above
    const p = computePopoverPosition(rect(700, 400, 300), DESKTOP_1366);
    expect(p.placement).toBe('top');
    expect(p.bottom).toBe(768 - 700 + 6);
    expect(p.top).toBeUndefined();
    expect(p.maxHeight).toBeGreaterThan(0);
  });

  it('constrains max-height to the available space when flipped up', () => {
    const p = computePopoverPosition(rect(700, 400, 300), DESKTOP_1366);
    const spaceAbove = 700 - 6 - 12;
    expect(p.maxHeight).toBeLessThanOrEqual(spaceAbove);
  });
});

describe('computePopoverPosition — width', () => {
  it('matches the trigger width when it fits', () => {
    const p = computePopoverPosition(rect(120, 400, 300), DESKTOP_1920);
    expect(p.width).toBe(300);
  });
  it('never exceeds the max width or the viewport', () => {
    const p = computePopoverPosition(rect(120, 10, 1000), MOBILE, { maxWidth: 480 });
    expect(p.width).toBeLessThanOrEqual(390 - 24);
  });
  it('is at least the trigger width (min-width behaviour)', () => {
    const p = computePopoverPosition(rect(120, 100, 260), DESKTOP_1920);
    expect(p.width).toBeGreaterThanOrEqual(260);
  });
});

describe('computePopoverPosition — horizontal clamping', () => {
  it('keeps the panel inside the right edge of the viewport', () => {
    // trigger far right; panel would overflow → left shifts in
    const p = computePopoverPosition(rect(120, 1800, 300), DESKTOP_1920);
    expect(p.left + p.width).toBeLessThanOrEqual(1920 - 12);
    expect(p.left).toBeGreaterThanOrEqual(12);
  });
  it('never places the panel past the left padding', () => {
    const p = computePopoverPosition(rect(120, -50, 300), DESKTOP_1920);
    expect(p.left).toBeGreaterThanOrEqual(12);
  });
});

describe('computePopoverPosition — viewport sizes', () => {
  it('works on a short mobile viewport (still returns a positive, bounded height)', () => {
    const p = computePopoverPosition(rect(500, 20, 340), MOBILE);
    expect(p.placement).toBe('top'); // little room below at y=500 in a 640 viewport
    expect(p.maxHeight).toBeGreaterThan(0);
    expect(p.maxHeight).toBeLessThanOrEqual(360);
  });
  it('1366×768 top-row opens downward and is bounded', () => {
    const p = computePopoverPosition(rect(150, 200, 320), DESKTOP_1366);
    expect(p.placement).toBe('bottom');
    expect(p.maxHeight).toBeLessThanOrEqual(768);
  });
  it('1920×1080 mid-screen opens downward with the full cap', () => {
    const p = computePopoverPosition(rect(300, 600, 320), DESKTOP_1920);
    expect(p.placement).toBe('bottom');
    expect(p.maxHeight).toBe(360);
  });
});
