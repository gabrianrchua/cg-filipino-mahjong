# Frontend visual foundation

The first-release interface uses a modern, minimal direction: plain white and
soft-gray surfaces, dark neutral text, and one restrained emerald accent.
`architecture-and-rules.md` is normative whenever it narrows or conflicts with
the broader `filipino-mahjong-rules.md` source.

## Design tokens

Global tokens live in `src/index.css`; component and screen layout belongs in
CSS Modules. The type stack uses local system sans-serif fonts for display text,
controls, and body copy, plus a monospace face for room codes. Spacing follows a
4/8/12/16/24/32/48/64px progression. Controls have a 44px minimum height and all
keyboard focus uses a high-contrast emerald ring. Components favor solid fills,
thin borders, modest rounding, and no decorative shadows except on the modal.

Tiles are intentionally sized rather than scaled to fit a hand. They are 48 by
66px on tablet/desktop and 44 by 61px below 768px. A long local rack uses its own
horizontal scroll container, so all 17 tiles remain legible in phone portrait
and landscape layouts.

## Responsive and accessible behavior

- Content uses fluid gutters plus all four CSS safe-area inset values.
- Waiting-room seats collapse from two columns to one. The table preserves the
  local player at the bottom, the next counterclockwise seat on the right, the
  opposite seat on top, and the previous seat on the left.
- Buttons, links, inputs, errors, landmarks, and headings remain semantic.
  Interaction is never available only through hover.
- Radix Dialog owns modal focus containment, Escape dismissal, and restoration
  to the trigger. Motion and transitions are suppressed when the user requests
  reduced motion.
- The palette is intentionally light and neutral for the first release and does not
  automatically change with the operating-system color scheme.

## Navigation

The lobby lives at `/`. Rooms use `/room/:roomCode`, where room codes are
validated and canonicalized through the shared contract. A room URL remains
stable while authoritative snapshots choose the waiting, playing, or
between-hands view. A direct room link retains its code while an anonymous user
creates a guest session, then uses the safe room-entry summary to select a
normal seat or an available bot takeover. During development only, the room shell exposes Waiting
and Table preview links; `?preview=table` makes the responsive table directly
inspectable without simulating realtime state.
