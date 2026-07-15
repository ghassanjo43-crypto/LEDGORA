/**
 * Collision-aware positioning for a portaled popover (e.g. the AccountSelect
 * dropdown). Pure and framework-free so it can be unit-tested without a DOM:
 * given the trigger's viewport rect and the viewport size, it decides whether
 * to open below or flip above, clamps the panel inside the viewport, matches the
 * trigger width, and constrains the max-height to the available space.
 */

export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type PopoverPlacement = 'top' | 'bottom';

export interface PopoverPosition {
  placement: PopoverPlacement;
  /** Distance from the top of the viewport (set when placement === 'bottom'). */
  top?: number;
  /** Distance from the bottom of the viewport (set when placement === 'top'). */
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

export interface PopoverPositionOptions {
  /** Gap between the trigger and the panel. */
  offset?: number;
  /** Minimum gap kept from every viewport edge. */
  padding?: number;
  /** Hard cap on the panel height regardless of available space. */
  maxHeight?: number;
  /** Panel is never narrower than this (defaults to the trigger width). */
  minWidth?: number;
  /** Panel never grows wider than this (before the viewport clamp). */
  maxWidth?: number;
  /**
   * The panel prefers to open downward; it only flips up when the space below
   * is less than this and there is more room above.
   */
  preferredMinHeight?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computePopoverPosition(
  trigger: Rect,
  viewport: Viewport,
  options: PopoverPositionOptions = {},
): PopoverPosition {
  const offset = options.offset ?? 6;
  const padding = options.padding ?? 12;
  const maxCap = options.maxHeight ?? 360;
  const preferredMinHeight = options.preferredMinHeight ?? 200;

  const spaceBelow = viewport.height - trigger.bottom - offset - padding;
  const spaceAbove = trigger.top - offset - padding;

  // Prefer opening downward; flip up only when below is cramped and above is roomier.
  const placement: PopoverPlacement =
    spaceBelow >= Math.min(maxCap, preferredMinHeight) || spaceBelow >= spaceAbove ? 'bottom' : 'top';

  const available = Math.max(0, placement === 'bottom' ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(maxCap, available);

  // Width: at least the trigger width, capped by an optional max and the viewport.
  const minWidth = options.minWidth ?? trigger.width;
  const maxWidth = Math.min(options.maxWidth ?? 480, viewport.width - padding * 2);
  const width = clamp(Math.max(trigger.width, minWidth), Math.min(minWidth, maxWidth), maxWidth);

  // Horizontal: align to the trigger's left edge, kept inside the viewport.
  const left = clamp(trigger.left, padding, Math.max(padding, viewport.width - width - padding));

  if (placement === 'bottom') {
    return { placement, top: trigger.bottom + offset, left, width, maxHeight };
  }
  return { placement, bottom: viewport.height - trigger.top + offset, left, width, maxHeight };
}
