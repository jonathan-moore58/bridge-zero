/* Bridge Zero v2 icon sprite. Every icon is drawn here on a 24 px grid, 1.75 px round strokes.
   Use: <svg class="i"><use href="#i-check"/></svg>. The marks (logo, Portaldot, Ethereum) are full-colour
   symbols: <svg class="mark"><use href="#m-zero"/></svg>. Inserted once, at the top of <body>, before the app renders. */
export function insertSprite(): void {
  const s = function (id: string, body: string): string {
    return '<symbol id="' + id + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + body + "</symbol>";
  };
  const icons = [
    s("i-chevron-down", '<path d="M6.5 9.5 12 15l5.5-5.5"/>'),
    s("i-chevron-right", '<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
    s("i-swap-h", '<path d="M4 8.5h15M15.5 5l3.5 3.5-3.5 3.5"/><path d="M20 15.5H5M8.5 12 5 15.5 8.5 19"/>'),
    s("i-swap-v", '<path d="M8 19.5V4.5M4.5 8 8 4.5 11.5 8"/><path d="M16 4.5v15M12.5 16l3.5 3.5 3.5-3.5"/>'),
    s("i-check", '<path d="M5 12.5 9.5 17 19 7.5"/>'),
    s("i-shield-check", '<path d="M12 3.2 19 6v5.6c0 4.2-2.9 7.7-7 9.2-4.1-1.5-7-5-7-9.2V6z"/><path d="m8.9 12.1 2.2 2.2 4.1-4.3"/>'),
    s("i-users", '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.2 19.5c.6-3.1 2.9-5 5.8-5s5.2 1.9 5.8 5"/><circle cx="17" cy="9.2" r="2.5"/><path d="M16.4 14.6c2.3 0 4 1.7 4.5 4.4"/>'),
    s("i-bolt", '<path d="M13.2 3 5.5 13.4h5.9L10.8 21l7.7-10.4h-5.9z"/>'),
    s("i-clock", '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6V12l2.9 1.9"/>'),
    s("i-gas", '<path d="M5.5 20V5.6c0-.9.7-1.6 1.6-1.6h5.8c.9 0 1.6.7 1.6 1.6V20"/><path d="M4 20h12"/><path d="M8 8.5h4"/><path d="M14.5 10.5h1.3c.9 0 1.6.7 1.6 1.6v3.6a1.5 1.5 0 0 0 3 0V8.6L18 6"/>'),
    s("i-info", '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5"/><path d="M12 7.9h.01"/>'),
    s("i-copy", '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.5"/><path d="M15.5 8.5V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>'),
    s("i-external", '<path d="M13.5 4.5h6v6"/><path d="m19.5 4.5-8.5 8.5"/><path d="M17.5 14v4.5c0 .8-.7 1.5-1.5 1.5H6c-.8 0-1.5-.7-1.5-1.5v-10C4.5 7.7 5.2 7 6 7h4.5"/>'),
    s("i-wallet", '<path d="M18 7.5V6a1.5 1.5 0 0 0-1.5-1.5h-10A2.5 2.5 0 0 0 4 7v10.5A2.5 2.5 0 0 0 6.5 20h12a1.5 1.5 0 0 0 1.5-1.5V9a1.5 1.5 0 0 0-1.5-1.5H6.5A2.5 2.5 0 0 1 4 5"/><circle cx="16" cy="13.75" r="1.1" fill="currentColor" stroke="none"/>'),
    s("i-x", '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    s("i-alert", '<path d="M10.4 4.6 3.3 17.3A1.8 1.8 0 0 0 4.9 20h14.2a1.8 1.8 0 0 0 1.6-2.7L13.6 4.6a1.8 1.8 0 0 0-3.2 0z"/><path d="M12 9.5v4"/><path d="M12 16.6h.01"/>'),
    s("i-lock", '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
    s("i-flame", '<path d="M12 21c-3.8 0-6.5-2.6-6.5-6.1 0-3.3 2.4-5.2 3.5-8.4 1.8 1.2 2.8 2.9 3 4.5 1-.8 1.6-2 1.8-3.3 2.4 1.9 4.7 4.6 4.7 7.2C18.5 18.4 15.8 21 12 21z"/>'),
    s("i-arrow-right", '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>'),
    s("i-arrow-down", '<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>'),
    s("i-activity", '<path d="M3.5 12h3.8l2.6-6.5 4.2 13 2.6-6.5h3.8"/>'),
    s("i-network", '<circle cx="12" cy="5.8" r="2.3"/><circle cx="5.8" cy="17.6" r="2.3"/><circle cx="18.2" cy="17.6" r="2.3"/><path d="M10.9 7.8 6.9 15.5M13.1 7.8l4 7.7M8.1 17.6h7.8"/>'),
    s("i-flask", '<path d="M9 3.5h6"/><path d="M10 3.5v5.6l-5 8.7A2.1 2.1 0 0 0 6.8 21h10.4a2.1 2.1 0 0 0 1.8-3.2l-5-8.7V3.5"/><path d="M7.4 15h9.2"/>'),
    s("i-bridge", '<path d="M3 17.5h18"/><path d="M5 17.5V12M19 17.5V12M12 17.5V9.5"/><path d="M3 9.5c3-3.2 6-4.7 9-4.7s6 1.5 9 4.7"/>'),
    s("i-cube", '<path d="m12 3.5 7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7z"/><path d="m4.8 7.9 7.2 4.1 7.2-4.1M12 12v8.3"/>'),
    s("i-key", '<circle cx="8" cy="15.5" r="3.8"/><path d="m10.8 12.8 7.7-7.8M15.6 8l2.4 2.4M17.8 5.7 20 8"/>'),
    s("i-doc", '<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5v5h5M9 13h6M9 16.5h4"/>'),
    s("i-sliders", '<path d="M5 7h9M18 7h1M5 17h1M10 17h9"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'),
    s("i-refresh", '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
    /* v2 app additions (bridge-ui/v2) */
    s("i-arrow-left", '<path d="M19 12H5M10.5 6.5 5 12l5.5 5.5"/>'),
    s("i-play", '<path d="M8 5.6v12.8a.9.9 0 0 0 1.4.8l10-6.4a.9.9 0 0 0 0-1.6l-10-6.4a.9.9 0 0 0-1.4.8z"/>'),
    s("i-x-circle", '<circle cx="12" cy="12" r="8.6"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>'),
    s("i-check-circle", '<circle cx="12" cy="12" r="8.6"/><path d="m8.4 12.2 2.4 2.4 4.8-5"/>'),
    s("i-plus", '<path d="M12 5.5v13M5.5 12h13"/>'),
    s("i-logout", '<path d="M14 4.5h3.5A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15"/>'),
    s("i-layers", '<path d="m12 4 8 4.2-8 4.2-8-4.2z"/><path d="m4 12.1 8 4.2 8-4.2"/><path d="m4 15.9 8 4.2 8-4.2"/>'),
    s("i-target", '<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r=".9" fill="currentColor"/>'),
    s("i-server", '<rect x="4" y="4.5" width="16" height="6.5" rx="2"/><rect x="4" y="13" width="16" height="6.5" rx="2"/><path d="M7.5 7.75h.01M7.5 16.25h.01"/>'),
    s("i-eye", '<path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>'),
    s("i-hash", '<path d="M5 9h15M4 15h15M10.5 4 8.5 20M15.5 4l-2 16"/>'),
  ];

  /* Bridge Zero v2: the tile with two offset bars, violet and blue, joined by a white beam.
     Drawn from logo-v2/mark-tile.svg, with ids prefixed for the page. */
  const zero =
    '<symbol id="m-zero" viewBox="0 0 64 64">' +
    '<rect x="2" y="2" width="60" height="60" rx="16" fill="#16141F"/>' +
    '<rect x="2" y="2" width="60" height="60" rx="16" fill="url(#bzGlowV)"/>' +
    '<rect x="2" y="2" width="60" height="60" rx="16" fill="url(#bzGlowB)"/>' +
    '<rect x="2.375" y="2.375" width="59.25" height="59.25" rx="15.625" fill="none" stroke="url(#bzEdge)" stroke-width=".75"/>' +
    '<rect x="12" y="16" width="30" height="8" rx="4" fill="url(#bzBlockV)"/>' +
    '<rect x="12" y="16" width="30" height="8" rx="4" fill="url(#bzSheen)"/>' +
    '<rect x="22" y="40" width="30" height="8" rx="4" fill="url(#bzBlockB)"/>' +
    '<rect x="22" y="40" width="30" height="8" rx="4" fill="url(#bzSheen)"/>' +
    '<g clip-path="url(#bzInTile)"><path d="M38 20 L26 44" stroke="#B197FF" stroke-opacity=".75" stroke-width="9" stroke-linecap="round" filter="url(#bzSoft)"/></g>' +
    '<path d="M38 20 L26 44" stroke="url(#bzBeam)" stroke-width="8" stroke-linecap="round"/>' +
    "</symbol>";

  /* Portaldot: a round chip with the violet-to-blue "p" ring, drawn for small sizes. */
  const pdot =
    '<symbol id="m-pdot" viewBox="0 0 64 64">' +
    '<circle cx="32" cy="32" r="31" fill="#0b0a12"/>' +
    '<circle cx="32" cy="32" r="30.5" fill="none" stroke="rgb(255 255 255 / .08)"/>' +
    '<path d="M18.5 47.5 L22.6 36.4" stroke="url(#bzPdot)" stroke-width="7.5" stroke-linecap="round" fill="none"/>' +
    '<circle cx="34" cy="29" r="12.5" fill="none" stroke="url(#bzPdot)" stroke-width="7.5"/>' +
    '<circle cx="34" cy="29" r="3.6" fill="#9b7bff"/>' +
    '<path d="M36.6 31.8 43 40" stroke="#5c5cf5" stroke-width="3.2" stroke-linecap="round"/>' +
    "</symbol>";

  /* Ethereum: the octahedron glyph in a round chip (from the site's marks.tsx). */
  const eth =
    '<symbol id="m-eth" viewBox="0 0 64 64">' +
    '<circle cx="32" cy="32" r="31" fill="#1c1928" stroke="#2f2a42" stroke-width="2"/>' +
    '<g transform="translate(20.5 13.3) scale(0.0898)">' +
    '<path fill="#c9d1ff" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z"/>' +
    '<path fill="#ffffff" d="M127.962 0L0 212.32l127.962 75.639V154.158z"/>' +
    '<path fill="#aab6ff" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z"/>' +
    '<path fill="#e6eaff" d="M127.962 416.905v-104.72L0 236.585z"/>' +
    '<path fill="#8a99f0" d="M127.961 287.958l127.96-75.637-127.96-58.162z"/>' +
    '<path fill="#bcc6ff" d="M0 212.32l127.96 75.638v-133.8z"/>' +
    "</g></symbol>";

  const defs =
    "<defs>" +
    '<radialGradient id="bzGlowV" gradientUnits="userSpaceOnUse" cx="6" cy="4" r="48"><stop offset="0" stop-color="#6C27E2" stop-opacity=".42"/><stop offset="1" stop-color="#6C27E2" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="bzGlowB" gradientUnits="userSpaceOnUse" cx="60" cy="62" r="46"><stop offset="0" stop-color="#2D68F4" stop-opacity=".36"/><stop offset="1" stop-color="#2D68F4" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="bzEdge" gradientUnits="userSpaceOnUse" x1="8" y1="4" x2="56" y2="60"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".30"/><stop offset=".45" stop-color="#FFFFFF" stop-opacity=".05"/><stop offset="1" stop-color="#B197FF" stop-opacity=".22"/></linearGradient>' +
    '<linearGradient id="bzBlockV" gradientUnits="userSpaceOnUse" x1="12" y1="0" x2="42" y2="0"><stop offset="0" stop-color="#B197FF"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient>' +
    '<linearGradient id="bzBlockB" gradientUnits="userSpaceOnUse" x1="22" y1="0" x2="52" y2="0"><stop offset="0" stop-color="#4A34F0"/><stop offset="1" stop-color="#2D68F4"/></linearGradient>' +
    '<linearGradient id="bzSheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".42"/><stop offset=".55" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="bzBeam" gradientUnits="userSpaceOnUse" x1="38" y1="20" x2="26" y2="44"><stop offset="0" stop-color="#D6C9FF"/><stop offset=".55" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF"/></linearGradient>' +
    '<linearGradient id="bzPdot" gradientUnits="userSpaceOnUse" x1="14" y1="14" x2="50" y2="50"><stop offset="0" stop-color="#8a3dfa"/><stop offset=".55" stop-color="#5b3cf2"/><stop offset="1" stop-color="#2d68f4"/></linearGradient>' +
    '<filter id="bzSoft" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><feGaussianBlur stdDeviation="2.4"/></filter>' +
    '<clipPath id="bzInTile"><rect x="2" y="2" width="60" height="60" rx="16"/></clipPath>' +
    "</defs>";

  const sprite = '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" class="sprite">' + defs + icons.join("") + zero + pdot + eth + "</svg>";
  document.body.insertAdjacentHTML("afterbegin", sprite);
}
