export type IconName =
  | 'logo'
  | 'plus'
  | 'x'
  | 'check'
  | 'chevronRight'
  | 'chevronDown'
  | 'arrowRight'
  | 'refresh'
  | 'settings'
  | 'picker'
  | 'scan'
  | 'shield'
  | 'eyeOff'
  | 'layers'
  | 'globe'
  | 'play'
  | 'stop'
  | 'plug'
  | 'unplug'
  | 'power'
  | 'trash'
  | 'alert'
  | 'info'
  | 'clock'
  | 'activity'
  | 'keyboard'
  | 'folder'
  | 'monitor'
  | 'copy'
  | 'more'
  | 'grid'
  | 'filter'
  | 'layout'
  | 'reset';

const PATHS: Record<IconName, string> = {
  logo: '<path d="M12 3l7 2.6v5.1c0 4.4-2.9 7.5-7 9.3-4.1-1.8-7-4.9-7-9.3V5.6L12 3z"/><path d="M13.3 8.1L9.2 12.6h2.8l-1.3 3.4 4.1-4.5h-2.8l1.3-3.4z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  arrowRight: '<path d="M4 12h16"/><path d="M14 6l6 6-6 6"/>',
  refresh: '<path d="M20.5 8.5A8.5 8.5 0 1 0 21 12"/><path d="M20.5 3.5v5h-5"/>',
  settings: '<path d="M4 7h8.6"/><path d="M17.4 7H20"/><circle cx="15" cy="7" r="2.2"/><path d="M4 12h3.6"/><path d="M12.4 12H20"/><circle cx="10" cy="12" r="2.2"/><path d="M4 17h8.6"/><path d="M17.4 17H20"/><circle cx="15" cy="17" r="2.2"/>',
  picker: '<path d="M5 3.5l6.2 17 2.3-6.6 6.6-2.3L5 3.5z"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"/><path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/><path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M7 12h10"/>',
  shield: '<path d="M12 3l7 2.6v5.1c0 4.4-2.9 7.5-7 9.3-4.1-1.8-7-4.9-7-9.3V5.6L12 3z"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7"/><path d="M6.7 6.8C4.6 8.1 3.1 10 2.5 12c1.2 3.2 4.9 6.5 9.5 6.5 1.4 0 2.7-.3 3.9-.8"/><path d="M9.9 4.6c.7-.1 1.4-.1 2.1-.1 4.6 0 8.3 3.3 9.5 6.5-.4 1.1-1 2.2-1.9 3.2"/>',
  layers: '<path d="M12 3.5l8.5 4.7-8.5 4.7-8.5-4.7L12 3.5z"/><path d="M3.5 12.3l8.5 4.7 8.5-4.7"/><path d="M3.5 16.8l8.5 4.7 8.5-4.7"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.5 5.3 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.3-3.5-8.5S9.7 5.9 12 3.5z"/>',
  play: '<path d="M8 5.2l10.5 6.8L8 18.8V5.2z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/>',
  plug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M6.5 7h11v4a5.5 5.5 0 0 1-11 0V7z"/><path d="M12 16.5V21"/>',
  unplug: '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M6.5 7h11v4a5.5 5.5 0 0 1-8.4 4.7"/><path d="M12 16.5V21"/><path d="M3.5 3.5l17 17"/>',
  power: '<path d="M12 3v8"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10 11v5.5"/><path d="M14 11v5.5"/>',
  alert: '<path d="M12 4l8.5 15H3.5L12 4z"/><path d="M12 9.5v4.5"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  activity: '<path d="M3 12h4l2.5-7 5 14 2.5-7h4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.2"/><path d="M6.5 10h.5"/><path d="M10 10h.5"/><path d="M13.5 10h.5"/><path d="M17 10h.5"/><path d="M7.5 14h9"/>',
  folder: '<path d="M3.5 6.5h5l2 2.2h10v9.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V6.5z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 20.5h7"/><path d="M12 17v3.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M5.5 15.5h-1A1.5 1.5 0 0 1 3 14V4.5A1.5 1.5 0 0 1 4.5 3H14a1.5 1.5 0 0 1 1.5 1.5v1"/>',
  more: '<circle cx="5" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.35" fill="currentColor" stroke="none"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  filter: '<path d="M3.5 5.5h17l-6.5 7.6v5.4l-4 1.8v-7.2L3.5 5.5z"/>',
  layout: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9.5 4v16"/><path d="M9.5 12h11"/>',
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.2"/><path d="M3.5 3.5v5h5"/>',
};

export function icon(name: IconName, size = 16, className = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  svg.innerHTML = PATHS[name];
  return svg;
}