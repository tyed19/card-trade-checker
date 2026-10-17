// Custom icon set — hand-authored inline SVGs drawn for this app
// (the owner disliked stock phone emoji in the kid-facing chrome).
//
// One coherent style: 24x24 grid, 2-unit stroke, rounded caps and
// joins, bold simple geometry that stays legible at nav-button size.
// Icons are stroke drawings in `currentColor`, so they inherit the
// color of the button/label around them — on the app's dark navy
// theme that means cream/white line work, the gold of the big action
// buttons, or a coral/red accent wherever the surrounding CSS sets
// one (the brand palette #00596B / #FF7156 / #FDF2DC lives in those
// surrounding colors, not in the paths). A few glyphs (star, play,
// dice pips, keyhole) are filled shapes for readability — same
// currentColor rule.
//
// Every icon takes { size, className } and renders at an explicit
// width/height, so an icon can never blow up a layout.

function Svg({ size = 24, className = '', children }) {
  return (
    <svg
      className={`icn${className ? ' ' + className : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

// Balance scales — the trade icon (also the "almost fair" verdict mark).
export function IconScales(p) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="4.1" r="1.3" />
      <path d="M12 5.4v15.1" />
      <path d="M4.5 7.5h15" />
      <path d="M4.5 7.5L3 13M4.5 7.5L6 13" />
      <path d="M2.6 13a1.9 1.9 0 0 0 3.8 0" />
      <path d="M19.5 7.5L18 13M19.5 7.5L21 13" />
      <path d="M17.6 13a1.9 1.9 0 0 0 3.8 0" />
      <path d="M8 20.5h8" />
    </Svg>
  );
}

// Ring binder — the binder icon.
export function IconBinder(p) {
  return (
    <Svg {...p}>
      <path d="M7 3.5h11.5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7" />
      <path d="M7 3.5v17" />
      <path d="M3.5 7.5H7M3.5 12H7M3.5 16.5H7" />
    </Svg>
  );
}

// Two stacked cards — a card collection.
export function IconCards(p) {
  return (
    <Svg {...p}>
      <rect x="3" y="6.5" width="12.5" height="14.5" rx="2" />
      <path d="M15.5 6.5V5.3A2.3 2.3 0 0 1 17.8 3h.9A2.3 2.3 0 0 1 21 5.3v9.4a2.3 2.3 0 0 1-2.3 2.3h-1.2" />
    </Svg>
  );
}

// Card with a plus — add cards.
export function IconCardPlus(p) {
  return (
    <Svg {...p}>
      <rect x="3" y="5.5" width="13" height="15" rx="2" />
      <path d="M16 5.5V4.8A1.8 1.8 0 0 1 17.8 3h1.4A1.8 1.8 0 0 1 21 4.8v9.4a1.8 1.8 0 0 1-1.8 1.8H18" />
      <path d="M9.5 10v6M6.5 13h6" />
    </Svg>
  );
}

export function IconCamera(p) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="7" width="19" height="13" rx="2.5" />
      <path d="M8.3 7l1.3-2.5h4.8L15.7 7" />
      <circle cx="12" cy="13.5" r="3.4" />
      <circle cx="18.4" cy="10.2" r="0.7" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconBulb(p) {
  return (
    <Svg {...p}>
      <path d="M12 3.5a5.6 5.6 0 0 1 3.3 10.1c-.7.6-1.3 1.1-1.3 2H10c0-.9-.6-1.4-1.3-2A5.6 5.6 0 0 1 12 3.5z" />
      <path d="M9.8 18.6h4.4" />
      <path d="M10.6 21.2h2.8" />
    </Svg>
  );
}

export function IconStar(p) {
  return (
    <Svg {...p}>
      <path
        d="M12 3.2l2.68 5.55 6.12.84-4.46 4.28 1.1 6.05L12 17.05l-5.44 2.87 1.1-6.05L3.2 9.59l6.12-.84z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

export function IconCheck(p) {
  return (
    <Svg {...p}>
      <path d="M4.5 12.8l5 5L19.5 6.8" />
    </Svg>
  );
}

export function IconX(p) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconLock(p) {
  return (
    <Svg {...p}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
      <circle cx="12" cy="15.3" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconGift(p) {
  return (
    <Svg {...p}>
      <rect x="4" y="11" width="16" height="9.5" />
      <path d="M3 7.5h18V11H3z" />
      <path d="M12 7.5v13" />
      <path d="M12 7.5C9.6 7.5 8.2 6.4 8.2 5 8.2 3.8 9.2 3 10.1 3.4c1.3.5 1.9 2.2 1.9 4.1z" />
      <path d="M12 7.5c2.4 0 3.8-1.1 3.8-2.5 0-1.2-1-2-1.9-1.6-1.3.5-1.9 2.2-1.9 4.1z" />
    </Svg>
  );
}

// Two arrows swapping places — trades, doubles, moving cards.
export function IconSwap(p) {
  return (
    <Svg {...p}>
      <path d="M4 7.5h12.5" />
      <path d="M13.5 4L17 7.5 13.5 11" />
      <path d="M20 16.5H7.5" />
      <path d="M10.5 13L7 16.5l3.5 3.5" />
    </Svg>
  );
}

export function IconTrash(p) {
  return (
    <Svg {...p}>
      <path d="M4 6.5h16" />
      <path d="M9.8 6.5V4.9a1.4 1.4 0 0 1 1.4-1.4h1.6a1.4 1.4 0 0 1 1.4 1.4v1.6" />
      <path d="M6.2 6.5l.8 12a2 2 0 0 0 2 1.9h6a2 2 0 0 0 2-1.9l.8-12" />
      <path d="M10 10.8v5.4M14 10.8v5.4" />
    </Svg>
  );
}

export function IconSearch(p) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L21 21" />
    </Svg>
  );
}

// Two hands clasped — "We traded!".
export function IconHandshake(p) {
  return (
    <Svg {...p}>
      <path d="M8.6 4.6L3.4 9.4a1.9 1.9 0 0 0 0 2.7l3.9 3.7a2.3 2.3 0 0 0 3.2 0l1-1" />
      <path d="M15.4 4.6l5.2 4.8a1.9 1.9 0 0 1 0 2.7l-3.9 3.7a2.3 2.3 0 0 1-3.2 0l-1-1" />
      <path d="M8.6 4.6a1.9 1.9 0 0 1 2.5.3l4.3 4.4a1.9 1.9 0 0 1-2.7 2.7l-1.2-1.2" />
      <path d="M9.4 14.1l1.5 1.5a1.7 1.7 0 0 0 2.4 0l.9-.9" />
    </Svg>
  );
}

export function IconPlus(p) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconMinus(p) {
  return (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function IconBack(p) {
  return (
    <Svg {...p}>
      <path d="M20 12H5.5" />
      <path d="M11 6l-6 6 6 6" />
    </Svg>
  );
}

// Circular arrow — start over / new trade.
export function IconRefresh(p) {
  return (
    <Svg {...p}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M20.8 3.4v4.2h-4.2" />
    </Svg>
  );
}

export function IconDice(p) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <circle cx="8.4" cy="8.4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="8.4" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="8.4" cy="15.6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="15.6" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconCompass(p) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5l-1.9 4.9-4.9 1.9 1.9-4.9z" fill="currentColor" fillOpacity="0.35" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconCrown(p) {
  return (
    <Svg {...p}>
      <path d="M3.8 8.2l4.4 3.8L12 6.2l3.8 5.8 4.4-3.8-1.3 9.3H5.1z" />
      <path d="M5.1 20.6h13.8" />
    </Svg>
  );
}

// Price tag — binder totals and price lines.
export function IconTag(p) {
  return (
    <Svg {...p}>
      <path d="M3.5 3.5H11L20.3 12.8a2 2 0 0 1 0 2.9l-5.6 5.6a2 2 0 0 1-2.9 0L3.5 13z" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconPlay(p) {
  return (
    <Svg {...p}>
      <path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconLink(p) {
  return (
    <Svg {...p}>
      <path d="M9.2 14.8l5.6-5.6" />
      <path d="M11 8.2l1.9-1.9a3.9 3.9 0 1 1 5.5 5.5l-1.9 1.9" />
      <path d="M13 15.8l-1.9 1.9a3.9 3.9 0 1 1-5.5-5.5l1.9-1.9" />
    </Svg>
  );
}

export const ICONS = {
  scales: IconScales,
  binder: IconBinder,
  cards: IconCards,
  cardPlus: IconCardPlus,
  camera: IconCamera,
  bulb: IconBulb,
  star: IconStar,
  check: IconCheck,
  x: IconX,
  lock: IconLock,
  gift: IconGift,
  swap: IconSwap,
  trash: IconTrash,
  search: IconSearch,
  handshake: IconHandshake,
  plus: IconPlus,
  minus: IconMinus,
  back: IconBack,
  refresh: IconRefresh,
  dice: IconDice,
  compass: IconCompass,
  crown: IconCrown,
  tag: IconTag,
  play: IconPlay,
  link: IconLink,
};

export function Icon({ name, ...props }) {
  const Cmp = ICONS[name] || IconStar;
  return <Cmp {...props} />;
}
