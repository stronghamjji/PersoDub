// The two icons two screens share. Everything else each screen draws is its
// own: these are here because the SAME mark has to mean the same thing in two
// places, and a second copy is how the two quietly drift apart.
//
// CHECK_ICON is "this is done" -- worn by a finished stage on the running
// screen and by a line whose voice has just been made on the finished one.
// REMAKE_ICON is "do it again" -- the circling arrow on a script line's voice
// button, which turns back into the tick once the voice is made.

// "Make this line's voice again": a circling arrow, which says "again" the way
// a waveform never did (user decision 2026-08-27). The same button turns
// green with a tick once the voice was made -- until the words change again
// or the app restarts.
export const REMAKE_ICON = '<svg viewBox="0 0 24 24" style="stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>';
// The tick that button wears once the voice is made, and the same mark the
// running screen draws over a finished stage.
export const CHECK_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
// The same tick at the picker's smaller size (the Dub Agent strip's rows).
export const CHECK_ICON_SM = CHECK_ICON.replace('class="icon"', 'class="icon icon-sm"');
