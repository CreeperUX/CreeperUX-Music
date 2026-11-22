// Types for @creeperux/gui/plus (P1, D44).
import type { Services, Handle, MenuItem, ButtonProps, FieldProps, Option, Tone, ActionState, Placement } from '../ui/index.js';

/** A handle without focus(): display components that are not themselves focusable. */
export type ViewHandle<P> = Omit<Handle<P>, 'focus'>;

/** Adds the P1 strings to these services once; app-supplied strings with the same keys win. */
export function plusStrings(services: Services): Services;

// ---------------------------------------------------------------- display
export function initials(name?: string): string;
export interface AvatarOptions { src?: string; size?: 'sm' | 'md' | 'lg'; status?: Tone; statusLabel?: string; decorative?: boolean; doc?: Document }
export function avatar(name: string, o?: AvatarOptions): HTMLElement;
export function avatarGroup(people: Array<string | { name: string; src?: string }>, o?: { max?: number; size?: AvatarOptions['size']; services?: Services; doc?: Document }): HTMLElement;

export interface StepperStep { id: string | number; label: string; description?: string; optional?: boolean; status?: 'error' }
export interface StepperProps { steps: StepperStep[]; current?: number | string; orientation?: 'horizontal' | 'vertical'; label?: string; onSelect?: (e: { id: StepperStep['id']; index: number }) => void }
export function createStepper(container: HTMLElement, props: StepperProps, services?: Services): ViewHandle<StepperProps>;

export interface MeterProps { label: string; value: number; min?: number; max?: number; low?: number; high?: number; optimum?: number; valueText?: string; variant?: 'bar' | 'ring'; size?: number; hideLabel?: boolean }
export function createMeter(container: HTMLElement, props: MeterProps, services?: Services): ViewHandle<MeterProps>;
export interface ProgressRingProps { label: string; /** 0..1, or null for indeterminate */ value?: number | null; size?: number; showValue?: boolean }
export function createProgressRing(container: HTMLElement, props: ProgressRingProps, services?: Services): ViewHandle<ProgressRingProps>;

// ---------------------------------------------------------------- log, virtual list, chart
export interface LogLine { id: string | number; time: number | Date; level?: 'debug' | 'info' | 'warn' | 'error'; source?: string; message: string }
export interface LogProps { lines?: LogLine[]; label?: string; height?: string; follow?: boolean; maxLines?: number; /** options for the locale's time format, or a function */ timeFormat?: Intl.DateTimeFormatOptions | ((d: Date) => string) }
export function createLog(container: HTMLElement, props: LogProps, services?: Services): ViewHandle<LogProps> & { append(lines: LogLine[]): void; clear(): void; pause(): void; resume(): void };

export interface VirtualListItem { id: string | number; title?: string; description?: string; meta?: string }
export interface VirtualListProps<I extends VirtualListItem = VirtualListItem> { items: I[]; label?: string; height?: string; render?: (item: I) => Node; onSelect?: (e: { id: I['id']; item: I }) => void; /** The selected item's id (listbox mode). */ value?: I['id'] | null; /** Since 2.5.0 (G64): a header wherever the key changes; the current group's header stays at the top. */ groupBy?: (item: I) => unknown; groupLabel?: (key: any, items: I[]) => string }
export function createVirtualList<I extends VirtualListItem = VirtualListItem>(container: HTMLElement, props: VirtualListProps<I>, services?: Services): Handle<VirtualListProps<I>> & { scrollToIndex(index: number): void };

// ---------------------------------------------------------------- 2.5.0: images, media cards, virtual grid (G61, G65, G66)
/** A URL, or a resolver (an artwork cache) called with a signal that aborts when the source changes. Null or '' is "no image". */
export type ImageSource = string | null | undefined | ((signal: AbortSignal) => Promise<string | null | undefined>);
export interface ImageProps { src?: ImageSource; /** '' marks the image decorative. */ alt?: string; /** Aspect ratio, e.g. 1 or '16 / 9'. Default 1. */ ratio?: number | string; fit?: 'cover' | 'contain'; shape?: 'rounded' | 'square' | 'circle'; /** A CSS width; the height follows the ratio. */ size?: string; lazy?: boolean; /** Icon name or node shown while loading, when missing and on error. Default 'image'. */ placeholder?: string | Node; label?: string; onLoad?: (e: { src: string }) => void; onError?: (e: { src: string | null }) => void }
export function createImage(container: HTMLElement, props?: ImageProps, services?: Services): ViewHandle<ImageProps> & { readonly state: 'empty' | 'loading' | 'loaded' | 'error'; retry(): void };
export interface MediaCardProps { title: string; subtitle?: string; meta?: string; artwork?: string | { src?: ImageSource; alt?: string; shape?: ImageProps['shape']; placeholder?: string } | null; layout?: 'tile' | 'row'; href?: string; onOpen?: (e: { event: MouseEvent }) => void; onPlay?: (e: { event: MouseEvent }) => void; playLabel?: string; playing?: boolean; current?: boolean; menu?: () => MenuItem[]; onMenu?: (e: { item: MenuItem }) => void; menuLabel?: string; disabled?: boolean; level?: 1 | 2 | 3 | 4 | 5 | 6 }
export function createMediaCard(container: HTMLElement, props: MediaCardProps, services?: Services): Handle<MediaCardProps> & { readonly image: ReturnType<typeof createImage> };
export interface VirtualGridProps<I = any> { items: I[]; label?: string; render?: (item: I, index: number) => Node | { root: HTMLElement; destroy(): unknown }; itemKey?: string | ((item: I) => unknown); minItemWidth?: number; gap?: number; /** Row height estimate in px. */ estimate?: number; /** The grid's own scroll height, or null inside `scroller`. */ height?: string | null; /** A scrolling ancestor (e.g. a workspace's main region) to scroll instead of its own region. */ scroller?: HTMLElement }
export function createVirtualGrid<I = any>(container: HTMLElement, props: VirtualGridProps<I>, services?: Services): Handle<VirtualGridProps<I>> & { readonly list: HTMLElement; readonly columns: number; scrollToIndex(index: number): void; focusItem(index: number): void };

/** Since 2.4.0 (G40, G41): `points` for scatter, `band` for a min / max envelope, `hidden`, `as: 'area'`, `tones` for donut slices. */
export interface ChartSeries { id: string; label: string; values?: Array<number | null>; points?: Array<[number, number] | { x: number; y: number }>; band?: { lo: Array<number | null>; hi: Array<number | null> }; tone?: Tone; tones?: Tone[]; dashed?: boolean; as?: 'line' | 'area' | 'bar'; hidden?: boolean }
export type ChartSelectEvent = { index: number; x?: string | number; label?: string; values?: Record<string, number | null>; series?: string; y?: number; value?: number };
/** Since 2.4.0: scatter and donut, numeric and time x axes, zoom, selection, legend toggles and data states (G40, G41). */
export interface ChartProps { type?: 'line' | 'area' | 'bar' | 'scatter' | 'donut'; series: ChartSeries[]; labels?: string[]; x?: Array<number | Date>; xType?: 'category' | 'linear' | 'time'; label: string; description?: string; height?: number; stacked?: boolean; min?: number; max?: number; yFormat?: (v: number) => string; xFormat?: (v: number) => string; legend?: boolean; toggle?: boolean; maxGap?: number; zoom?: boolean; range?: [number, number] | null; onRangeChange?: (e: { range: [number, number] | null; reason: 'brush' | 'keyboard' | 'reset' | 'api' }) => void; selected?: number; onSelect?: (e: ChartSelectEvent) => void; onSeriesToggle?: (e: { id: string | number; hidden: boolean }) => void; state?: 'loading' | 'error' | 'stale' | 'empty' | null; stateMessage?: string; updatedAt?: number | Date; onRetry?: () => void }
export function createChart(container: HTMLElement, props: ChartProps, services?: Services): Handle<ChartProps> & { readonly range: [number, number] | null; readonly selected: number; setRange(range: [number, number] | null): void };
/** Since 2.4.0: local-time axis ticks between two timestamps. */
export function timeTicks(from: number, to: number, max?: number): { ticks: number[]; unit: 's' | 'm' | 'h' | 'd' | 'mo' | 'y' };

// ---------------------------------------------------------------- inputs
export interface SliderProps extends Pick<FieldProps, 'label' | 'hideLabel' | 'description' | 'disabled' | 'readOnly'> { /** Since 2.2.0, null is an unknown value: shown as "Not set", not as the minimum. */ value: number | [number, number] | null; min?: number; max?: number; step?: number; largeStep?: number; marks?: Array<{ value: number; label?: string }>; format?: (v: number) => string; /** Since 2.2.0. */ orientation?: 'horizontal' | 'vertical'; onInput?: (e: { value: number | [number, number] }) => void; onChange?: (e: { value: number | [number, number] }) => void; /** Since 2.2.0: Escape or a cancelled pointer put back the value from before the drag (since 2.5.0: or the latest value the host sent during it). */ onCancel?: (e: { value: number | [number, number] | null }) => void; /** Since 2.5.0 (G59): a pointer drag starts; then onInput previews every move and onChange commits once on release. */ onDragStart?: (e: { value: number | [number, number] | null }) => void; /** Since 2.5.0: what an arrow key adds (default step). */ keyStep?: number; /** Since 2.5.0: what assistive technology reads (aria-valuetext); ormat stays the visible text. */ valueText?: (v: number) => string; /** Since 2.5.0: while focused, host updates change the reading at most every this many ms (user changes are read at once). */ valueTextInterval?: number; /** Since 2.2.0: save the change; it shows at once, the field says how saving went, a failure puts the confirmed value back and offers Retry. Resolve { unconfirmed: true } to wait for observe(). */ action?: (next: number | [number, number], signal: AbortSignal) => Promise<unknown> }
export function createSlider(container: HTMLElement, props: SliderProps, services?: Services): Handle<SliderProps> & { /** null while the value is unknown (props value null); typed without null to keep 2.x callers compiling. */ readonly value: number | [number, number]; readonly state: ActionState<number | [number, number]>; /** Since 2.2.0: read-back for an action that resolved { unconfirmed: true }. */ observe(value: number | [number, number]): void; /** Since 2.5.0: a pointer drag is under way (update({ value }) is held until it ends). */ readonly dragging: boolean };

export interface TimeInputProps extends FieldProps { /** 'HH:MM' or 'HH:MM:SS', 24-hour */ value?: string | null; seconds?: boolean; hour12?: boolean; /** minutes between picker entries */ step?: number; picker?: boolean; onChange?: (e: { value: string | null }) => void }
export function createTimeInput(container: HTMLElement, props: TimeInputProps, services?: Services): Handle<TimeInputProps> & { readonly value: string | null; validate(): boolean };

export interface ColorPickerProps extends Pick<FieldProps, 'label' | 'hideLabel' | 'description'> { /** '#rrggbb' */ value?: string; swatches?: string[]; onChange?: (e: { value: string }) => void }
export function createColorPicker(container: HTMLElement, props: ColorPickerProps, services?: Services): Handle<ColorPickerProps> & { readonly value: string };

export interface TagInputProps extends FieldProps { value?: string[]; placeholder?: string; validate?: (tag: string) => string | null | undefined; maxTags?: number; separators?: string[]; onChange?: (e: { value: string[] }) => void }
/** Since 2.2.0: a field that shows its colour and opens a picker with Apply / Cancel. */
export interface ColorFieldProps extends FieldProps { /** '#rrggbb', or null for no colour ("Not set", never white). */ value?: string | null; swatches?: string[]; presentation?: 'auto' | 'popover' | 'sheet'; onChange?: (e: { value: string; previous: string | null }) => void }
export function createColorField(container: HTMLElement, props: ColorFieldProps, services?: Services): Handle<ColorFieldProps> & { readonly value: string | null; readonly isOpen: boolean; open(): void; close(): void; validate(): boolean };
export function createTagInput(container: HTMLElement, props: TagInputProps, services?: Services): Handle<TagInputProps> & { readonly input: HTMLInputElement; readonly value: string[]; validate(): boolean };

export interface ListboxProps<V = string | number> { label: string; hideLabel?: boolean; description?: string; options: Option<V>[]; value?: V | null; values?: V[]; multiple?: boolean; height?: string; onChange?: (e: { value?: V | null; values?: V[] }) => void }
export function createListbox<V = string | number>(container: HTMLElement, props: ListboxProps<V>, services?: Services): Handle<ListboxProps<V>> & { readonly listbox: HTMLElement; readonly value: V | null | V[] };

export interface UploadItem { id: string; file: File; name: string; size: number; status: 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled'; progress: number; error?: string }
export interface UploadManagerProps { label?: string; upload: (file: File, o: { signal: AbortSignal; onProgress: (fraction: number) => void }) => Promise<unknown>; concurrency?: number; accept?: string; acceptLabel?: string; maxSize?: number; maxFiles?: number; description?: string; onChange?: (e: { items: UploadItem[] }) => void }
export function createUploadManager(container: HTMLElement, props: UploadManagerProps, services?: Services): Handle<UploadManagerProps> & { readonly items: UploadItem[]; addFiles(files: Iterable<File>): void };

// ---------------------------------------------------------------- patterns
export interface SplitButtonProps { label: string; icon?: string; variant?: ButtonProps['variant']; disabled?: boolean; onClick?: (e: MouseEvent) => void; items: MenuItem[] | (() => MenuItem[]); menuLabel?: string; onSelect?: (e: { item: MenuItem; id?: string }) => void }
export function createSplitButton(container: HTMLElement, props: SplitButtonProps, services?: Services): Handle<SplitButtonProps>;
export interface OverflowMenuProps { label?: string; items: MenuItem[] | (() => MenuItem[]); placement?: string; onSelect?: (e: { item: MenuItem; id?: string }) => void }
export function createOverflowMenu(container: HTMLElement, props: OverflowMenuProps, services?: Services): Handle<OverflowMenuProps> & { readonly element: HTMLButtonElement; readonly isOpen: boolean; open(focus?: 'first' | 'last' | 'none'): void; close(): void };

export interface MenubarMenu { id: string; label: string; items: MenuItem[] | (() => MenuItem[]); /** Since 2.3.0: listed and focusable, but does not open. */ disabled?: boolean }
export interface MenubarProps { label?: string; menus: MenubarMenu[]; onSelect?: (e: { menu: string; item: MenuItem; /** Since 2.3.0. */ path: string[]; /** Since 2.3.0. */ group: string | null }) => void }
export function createMenubar(container: HTMLElement, props: MenubarProps, services?: Services): Handle<MenubarProps>;

/** 'mod+shift+k' → '⌘⇧K' on Apple platforms, 'Ctrl+Shift+K' elsewhere; since 2.4.0 a sequence 'g i' → 'G I'. */
export function formatKeys(spec: string): string;
export interface Shortcut { id?: string; /** e.g. 'mod+k', 'g', 'shift+?', or since 2.4.0 a sequence 'g i'; several alternatives as an array */ keys: string | string[]; label?: string; group?: string; handler: (e: KeyboardEvent) => void; allowInInputs?: boolean; /** fires even behind a modal layer it did not open */ global?: boolean }
/** Since 2.4.0 (G45): a shortcut that waits behind an earlier one with the same keys or a prefix of them. */
export interface ShortcutConflict { id: string; keys: string | string[]; with: string }
export interface ShortcutsHandle { register(def: Shortcut): string; unregister(id: string): void; readonly list: Array<Omit<Shortcut, 'handler'> & { id: string; handler: Shortcut['handler'] }>; /** Since 2.4.0 */ readonly conflicts: ShortcutConflict[]; /** Since 2.4.0: the keys of a registered shortcut, for a menu item's `shortcut`. */ hint(id: string): string | undefined; openHelp(): void; destroy(): void }
/** Since 2.4.0 every registry on the same services is one: shared conflicts and one help view (G45). */
export function createShortcuts(services?: Services, opts?: { target?: Document | HTMLElement; onConflict?: (e: ShortcutConflict) => void }): ShortcutsHandle;

export interface Command { id: string; label: string; group?: string; keywords?: string[]; shortcut?: string; icon?: string; /** Since 2.3.0: listed and found, but skipped by the arrows and never run. */ disabled?: boolean; run?: () => void }
export interface CommandPaletteProps { commands: Command[]; placeholder?: string; label?: string; limit?: number }
export function createCommandPalette(props: CommandPaletteProps, services?: Services): { readonly isOpen: boolean; open(): void; close(): void; update(props: Partial<CommandPaletteProps>): void; destroy(): void };

export interface ToggletipProps { content: string | Node; label?: string; placement?: string }
export function createToggletip(container: HTMLElement, props: ToggletipProps, services?: Services): Handle<ToggletipProps> & { readonly isOpen: boolean; open(): void; close(): void };

export interface LoadingOverlayProps { label?: string; active?: boolean; /** ms before it shows */ delay?: number }
export function createLoadingOverlay(target: HTMLElement, props?: LoadingOverlayProps, services?: Services): ViewHandle<LoadingOverlayProps> & { readonly active: boolean; show(): void; hide(): void };

export interface ResultAction { label: string; variant?: ButtonProps['variant']; href?: string; onClick?: (e: MouseEvent) => void }
export interface ResultProps { kind?: 'success' | 'error' | 'warning' | 'info' | 'notFound' | 'unavailable' | 'unconfigured'; /** For 'unavailable' (since 2.2.0). */ reason?: 'permission' | 'offline'; /** Required except for 'unavailable' and 'unconfigured', which have default copy. */ title?: string; message?: string; actions?: ResultAction[]; details?: Node; level?: 1 | 2 | 3 | 4 | 5 | 6; focus?: boolean }
export function createResult(container: HTMLElement, props: ResultProps, services?: Services): Handle<ResultProps>;

export interface SplitPaneProps { orientation?: 'horizontal' | 'vertical'; /** % of the first pane */ size?: number; min?: number; max?: number; label?: string; /** rem; side by side only above this width */ stackBelow?: number; onResize?: (e: { size: number }) => void }
export function createSplitPane(container: HTMLElement, props?: SplitPaneProps, services?: Services): Handle<SplitPaneProps> & { readonly start: HTMLElement; readonly end: HTMLElement; readonly size: number; setSize(size: number): void };

/** Key caps for a shortcut, in the platform's names. */
export function kbd(spec: string, o?: { doc?: Document; /** the word between the steps of a sequence (default "then") */ then?: string }): HTMLElement;
/** The text with case-insensitive matches of each query word wrapped in <mark>. */
export function highlight(text: string, query: string, o?: { doc?: Document }): HTMLElement;

export interface CodeBlockProps { code: string; label?: string; language?: string; copy?: boolean; wrap?: boolean }
export function createCodeBlock(container: HTMLElement, props: CodeBlockProps, services?: Services): ViewHandle<CodeBlockProps>;

export interface MediaItem { src: string; alt?: string; caption?: string; type?: 'image' | 'video'; poster?: string }
export interface MediaViewerProps { items: MediaItem[]; label?: string }
export function createMediaViewer(props: MediaViewerProps, services?: Services): { readonly index: number; readonly isOpen: boolean; open(index?: number): void; close(): void; update(props: Partial<MediaViewerProps>): void; destroy(): void };

export interface EditableCellOptions<V = string | number | null> { value: V; label?: string; type?: 'text' | 'number' | 'select'; options?: Option[]; format?: (v: V) => string; validate?: (v: V) => string | null | undefined; onCommit?: (v: V) => Promise<unknown> | void; services?: Services; doc?: Document }
/** Content for a table cell (column.cell): click or Enter edits, Enter saves, Escape cancels; a rejected save keeps the editor open with the message. */
export function editableCell<V = string | number | null>(o: EditableCellOptions<V>): HTMLElement;

// ---------------------------------------------------------------- 2.4.0: below the audit threshold (G49)
export interface OtpFieldProps { label: string; length?: number; value?: string; type?: 'numeric' | 'alphanumeric'; mask?: boolean; description?: string; error?: string | null; required?: boolean; disabled?: boolean; readOnly?: boolean; hideLabel?: boolean; onChange?: (e: { value: string; complete: boolean }) => void; onComplete?: (e: { value: string }) => void }
/** Since 2.4.0: a one-time code or PIN, one box per character; paste and autofill fill every box. */
export function createOtpField(container: HTMLElement, props: OtpFieldProps, services?: Services): Handle<OtpFieldProps> & { readonly value: string; clear(): void };
export interface RatingProps { label?: string; value?: number; max?: number; readOnly?: boolean; disabled?: boolean; allowClear?: boolean; description?: string; hideLabel?: boolean; onChange?: (e: { value: number; previous: number }) => void }
/** Since 2.4.0: stars as a radio group; read-only shows a fraction as one image. */
export function createRating(container: HTMLElement, props: RatingProps, services?: Services): Handle<RatingProps> & { readonly value: number };
export interface HoverCardProps { content: Node | string | ((body: HTMLElement) => void); placement?: Placement; delay?: number; closeDelay?: number; onOpenChange?: (e: { open: boolean }) => void }
/** Since 2.4.0: a preview on hover or keyboard focus; supplementary, so keep the same information reachable from the trigger. */
export function createHoverCard(trigger: HTMLElement, props: HoverCardProps, services?: Services): { readonly isOpen: boolean; readonly element: HTMLElement; open(): void; close(): void; update(props: Partial<HoverCardProps>): void; destroy(): void };
export interface FilterChipsProps<V = string> { label?: string; options: Array<{ value: V; label: string; count?: number; icon?: string; disabled?: boolean }>; value?: V[]; multiple?: boolean; clearable?: boolean; disabled?: boolean; onChange?: (e: { value: V[] }) => void }
/** Since 2.4.0: quick filters as pressed toggle buttons with counts. */
export function createFilterChips<V = string>(container: HTMLElement, props: FilterChipsProps<V>, services?: Services): Handle<FilterChipsProps<V>> & { readonly value: V[] };
export interface TreeGridRow { id: string | number; children?: TreeGridRow[]; hasChildren?: boolean; loading?: boolean; loadError?: string | boolean; [field: string]: unknown }
export interface TreeGridProps { label: string; columns: Array<{ id: string; label: string; width?: string; align?: 'start' | 'end'; cell?: (row: TreeGridRow) => Node | string }>; rows: TreeGridRow[]; expanded?: Array<string | number>; onToggle?: (e: { id: string | number; open: boolean; row: TreeGridRow }) => void; onRowAction?: (e: { id: string | number; row: TreeGridRow }) => void; onRetry?: (e: { id: string | number; row: TreeGridRow }) => void }
/** Since 2.4.0: rows with children in columns (APG treegrid, row focus), with lazy children. */
export function createTreeGrid(container: HTMLElement, props: TreeGridProps, services?: Services): Handle<TreeGridProps> & { readonly expanded: Array<string | number>; expand(id: string | number, open?: boolean): void; focus(id?: string | number): void };
export interface DateTimePickerProps { label: string; value?: string | null; min?: string; max?: string; description?: string; error?: string | null; required?: boolean; disabled?: boolean; readOnly?: boolean; hideLabel?: boolean; onChange?: (e: { value: string | null; date: string | null; time: string | null; previous: string | null }) => void }
/** Since 2.4.0: a date and a time under one label; the value is 'YYYY-MM-DDTHH:MM' once both are set. */
export function createDateTimePicker(container: HTMLElement, props: DateTimePickerProps, services?: Services): Handle<DateTimePickerProps> & { readonly value: string | null };
export interface SwatchPickerProps { label: string; value?: string | null; swatches: Array<string | { value: string; name?: string }>; description?: string; hideLabel?: boolean; disabled?: boolean; onChange?: (e: { value: string; previous: string | null }) => void }
/** Since 2.4.0: named colours as a radio group. */
export function createSwatchPicker(container: HTMLElement, props: SwatchPickerProps, services?: Services): Handle<SwatchPickerProps> & { readonly value: string | null };
