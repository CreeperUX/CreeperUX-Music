// @creeperux/gui — the package root since 2.0.0 (D54): the stage 2 layer (D31), infrastructure and components on the
// agreed system. The 1.0 /web factories and the Lit components were removed in 2.0.0; see docs/MIGRATION_2.md.
export { createMotion, curves } from '../motion-core.js';
export { MOTION_ROLES, MOTION_REDUCED, PRESS_SCALE, BREAKPOINTS, LAYERS, DENSITY, COLORS } from '../tokens.js';
export { createServices, getServices } from '../services.js';
export { createI18n, dirOf } from '../i18n.js';
export { createFormatter } from '../format.js';
export { createAnnouncer } from '../announce.js';
export { createAsyncAction } from '../async-action.js';
export { createOverlayManager, focusableIn } from '../overlay.js';
export { computePosition, autoPosition } from '../position.js';
export { trackInputModality, createRovingFocus } from '../interaction.js';
export { icon, registerIcons, iconNames } from '../icons.js';
// Component authoring helpers (the conventions every stage 2 component follows; used by @creeperux/gui/plus and apps).
export { setup, fill, h, field, uid, validateValue, safeHref } from './base.js';
export { pendingValue } from './pending.js';
// Components (M2: inputs and selection)
export { createButton, createIconButton, createToggleButton, createButtonGroup, createTextField, createTextArea, createSearchField, createNumberField, createTimeField, createCheckbox, createCheckboxGroup, createRadioGroup, createSwitch, createSegmented } from './controls.js';
export { createSelect } from './select.js';
export { createCombobox } from './combobox.js';
export { createCalendar, createDatePicker, createDateRangePicker, parseISO, toISO, addDays, addMonths, todayISO, formatTyped, parseTyped } from './date.js';
export { createFileDrop } from './file.js';
export { createForm, createFieldset } from './form.js';
// Components (M3: navigation, overlays, feedback)
export { createAppShell, createMasterDetail } from './shell.js';
export { createWorkspace } from './workspace.js';
export { createNavList, createTabs, createBreadcrumbs, createPagination, createToolbar, createLink } from './navigation.js';
export { openMenu, createMenuButton, createContextMenu, createTooltip, createPopover, createDialog, confirm, createSheet } from './overlays.js';
export { getToaster, toast, reportFeedback, createInlineAlert, createProgress, createSpinner, createSkeleton } from './feedback.js';
// Components (M4: data display, layout)
export { createTable } from './table.js';
export { createVirtualizer, reconcileChildren } from './virtual.js';
export { createTree } from './tree.js';
export { badge, statusLabel, tag, truncate, twoLine, sparkline, createRelativeTime, createPageHeader, createPanel, createDisclosure, createAccordion, createKeyValue, createCard, createMetric, createTimeline, createList, createEmptyState } from './display.js';
