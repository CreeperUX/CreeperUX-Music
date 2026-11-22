// Icons the app adds to the kit's registry (24 px grid, 1.6 px stroke, as the kit's own).
import { registerIcons } from '../vendor/creeperux-gui/ui/index.js';
import { registerMediaIcons } from '../vendor/creeperux-gui/media/index.js';

export function registerAppIcons() {
  registerMediaIcons();
  registerIcons({
    'panel-right': '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>',
    browse: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M9 14h6"/>',
    pin: '<path d="M14.5 3.5l6 6-3 1.5-3.5 3.5-.5 4-2-2-5 5M10.5 13.5l-4.5-4.5 4-.5 3.5-3.5z"/>',
    folder: '<path d="M3.5 6.5a1 1 0 0 1 1-1h5l2 2.5h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/>',
    waveform: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
    expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
    'list-compact': '<path d="M8 6h12M8 10h12M8 14h12M8 18h12M4 6h.01M4 10h.01M4 14h.01M4 18h.01"/>',
    logout: '<path d="M9.5 20.5h-4a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1h4M15.5 16.5l4.5-4.5-4.5-4.5M20 12H9.5"/>',
    sparkle: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  });
}
