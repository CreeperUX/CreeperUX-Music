// Types for @creeperux/gui (the package root; stage 2 layer, D31, D54).

// ---- Motion core and tokens (moved here from the removed 1.0 declarations in 2.0.0) ----
// ---- Motion core and tokens (stage 2, M1) ----
export type MotionChannel = 'x'|'y'|'sx'|'sy'|'o'|'h'|'w';
export type MotionSpec = {t:'tween';d:number;e:[number,number,number,number]}|{t:'spring';r:number;z:number}|{t:'instant'};
export type MotionRole = 'press'|'release'|'control'|'detent'|'drag'|'enter'|'exit'|'layout'|'list'|'view'|'viewExit'|'push'|'sheet'|'expand'|'instant';
export interface MotionAnimateOptions {role?:MotionRole|string;from?:Partial<Record<MotionChannel,number>>;vel?:Partial<Record<MotionChannel,number>>;delay?:number;autoHeight?:boolean}
export interface Motion {
 /** Animates channels toward targets from the current modelled pose; resolves true when settled, false if interrupted. */
 animate(element:Element,to:Partial<Record<MotionChannel,number>>,options?:MotionAnimateOptions):Promise<boolean>;
 stop(element:Element,jump?:boolean):void; reset(element:Element):void;
 flip(elements:Iterable<Element>,mutate:()=>void,options?:{role?:MotionRole|string;stagger?:number;onlyVisible?:boolean}):Promise<boolean[]>;
 read(element:Element,channel:MotionChannel):{v:number;dv:number};
 finishAll():void; spec(role:MotionRole|string,channel:MotionChannel):MotionSpec;
 readonly activeCount:number; speed:number; reduced:'system'|boolean; readonly isReduced:boolean; readonly destroyed:boolean; destroy():void;
}
export function createMotion(options?:{roles?:Record<string,MotionSpec>;speed?:number;reduced?:'system'|boolean;document?:Document}):Motion;
export const curves:{bezier(p1x:number,p1y:number,p2x:number,p2y:number):(x:number)=>number;spring(response:number,zeta:number,x0:number,v0:number):(t:number)=>number;channel(spec:MotionSpec,from:number,to:number,v0?:number,name?:MotionChannel):{to:number;at(t:number):number;vel(t:number):number;end:number}};
export const MOTION_ROLES:Readonly<Record<Exclude<MotionRole,'instant'>,MotionSpec>>;
export const MOTION_REDUCED:Readonly<{opacity:MotionSpec;other:MotionSpec}>;
export const PRESS_SCALE:number;
export const BREAKPOINTS:Readonly<{rail:number;stack:number;sidebar:number}>;
export const LAYERS:Readonly<Record<'content'|'sticky'|'savebar'|'scrim'|'drawer'|'menu'|'palette'|'dialog'|'toast'|'tooltip',number>>;
export const DENSITY:Readonly<Record<'compact'|'touch',Record<string,string>>>;
export const COLORS:Readonly<Record<string,{dark:string;light:string}>>;

type PluralFn = (n: number) => Intl.LDMLPluralRule;
export interface I18n { t(key: string, params?: Record<string, unknown>): string; add(locale: string, messages: Record<string, string | ((p: any, plural: PluralFn) => string)>): void; defaults(locale: string, messages: Record<string, string | ((p: any, plural: PluralFn) => string)>): void; has(key: string): boolean; locale: string; readonly dir: 'ltr' | 'rtl'; subscribe(fn: (locale: string) => void): () => void }
export function createI18n(options?: { locale?: string; messages?: Record<string, Record<string, unknown>> }): I18n;
export function dirOf(locale: string): 'ltr' | 'rtl';
type DateIn = Date | number | string;
export interface Formatter {
  locale: string; number(v: number | null, o?: Intl.NumberFormatOptions): string; integer(v: number): string; currency(v: number, currency: string, o?: Intl.NumberFormatOptions): string;
  percent(v: number, digits?: number): string; unit(v: number, unit: string, o?: Intl.NumberFormatOptions): string; bytes(b: number): string; compact(v: number): string;
  date(d: DateIn, o?: Intl.DateTimeFormatOptions): string; time(d: DateIn, o?: Intl.DateTimeFormatOptions): string; dateTime(d: DateIn, o?: Intl.DateTimeFormatOptions): string;
  dateRange(a: DateIn, b: DateIn, o?: Intl.DateTimeFormatOptions): string; relative(then: DateIn, now?: DateIn): string; list(items: string[], type?: 'conjunction' | 'disjunction' | 'unit'): string;
  parseNumber(text: string): number; weekStart(): number;
  /** Since 2.5.0: seconds as a clock ("3:05", "1:02:03") or in words for screen readers (`style: 'long'`); unknown → "—". */
  duration(seconds: number | null | undefined, o?: { style?: 'clock' | 'long'; hours?: boolean }): string;
}
export function createFormatter(locale?: string): Formatter;
export interface Announcer { announce(message: string, o?: { politeness?: 'polite' | 'assertive'; dedupeMs?: number }): void; readonly regions: { polite: HTMLElement; assertive: HTMLElement }; destroy(): void }
export function createAnnouncer(root?: HTMLElement): Announcer;
export type ActionPhase = 'idle' | 'pending' | 'confirmed' | 'failed' | 'unconfirmed';
export interface ActionState<V = unknown> { phase: ActionPhase; value: V | undefined; error: unknown; attempt: number; id: number }
export interface ActionResult { status: ActionPhase | 'superseded' | 'destroyed' | 'invalid'; result?: unknown; error?: unknown }
export interface AsyncAction<V = unknown> { run(task: (signal: AbortSignal) => Promise<unknown>, o?: { value?: V; attempt?: number }): Promise<ActionResult>; retry(): Promise<ActionResult>; confirm(id?: number): void; /** Read-back (since 2.2.0): what the device or server now holds; a match confirms the change, even before its acknowledgement. */ observe(value: V): void; cancel(): void; reset(): void; readonly state: ActionState<V>; readonly pending: boolean; destroy(): void }
export function createAsyncAction<V = unknown>(options?: { onChange?: (s: ActionState<V>) => void; confirmTimeout?: number; /** Since 2.2.0: fail an unconfirmed change that is not observed within this many ms. */ readbackTimeout?: number; unconfirmed?: boolean; /** Since 2.2.0: how observe() compares; default same value or same string. */ matches?: (expected: V | undefined, observed: V) => boolean; clearConfirmedAfter?: number }): AsyncAction<V>;
export type LayerKind = 'menu' | 'dialog' | 'drawer' | 'palette' | 'toast' | 'tooltip' | 'sticky' | 'savebar' | 'scrim';
export interface OverlayHandle { readonly element: HTMLElement; readonly isTop: boolean; close(o?: { restoreFocus?: boolean; remove?: boolean }): void }
export interface OverlayOpenOptions { kind?: LayerKind; modal?: boolean; trigger?: Element | null; initialFocus?: false | Element | (() => Element | null); restoreFocus?: boolean; trap?: boolean; dismissOnOutside?: boolean; dismissOnEscape?: boolean; passive?: boolean; onDismiss?: (reason: 'escape' | 'outside') => void }
export interface OverlayManager { /** Shows `element` as a layer; a hidden element is shown here (since 2.3.0), and a modal's background turns inert after the layer's first paint (D67). */ open(element: HTMLElement, o?: OverlayOpenOptions): OverlayHandle; /** Since 2.3.0: dismisses the top layer as Escape would; false when none was open. */ handleBack(): boolean; readonly portal: HTMLElement; readonly stack: Array<{ kind: LayerKind; element: HTMLElement; modal: boolean }>; readonly top: HTMLElement | null; readonly count: number; closeAll(): void; destroy(): void }
export function createOverlayManager(o?: { root?: HTMLElement; onStackChange?: (stack: Array<{ kind: LayerKind; element: HTMLElement }>) => void }): OverlayManager;
export function focusableIn(root: Element): HTMLElement[];
export type Placement = `${'top' | 'bottom' | 'start' | 'end'}-${'start' | 'end' | 'center'}`;
export function computePosition(o: { anchor: { left: number; top: number; right?: number; bottom?: number; width: number; height: number } | { x: number; y: number }; floating: { width: number; height: number }; viewport: { width: number; height: number }; placement?: Placement; offset?: number; /** A number, or per side (since 2.3.0) to keep clear of a notch or home indicator. */ padding?: number | { top?: number; right?: number; bottom?: number; left?: number }; dir?: 'ltr' | 'rtl'; flip?: boolean }): { x: number; y: number; placement: Placement; maxHeight: number };
export function autoPosition(anchor: Element, floating: HTMLElement, o?: { placement?: Placement; offset?: number; /** Since 2.3.0 also per side; the safe-area insets are always kept clear. */ padding?: number | { top?: number; right?: number; bottom?: number; left?: number }; point?: { x: number; y: number }; limitHeight?: boolean; dir?: 'ltr' | 'rtl'; onPlace?: (r: { x: number; y: number; placement: Placement }) => void }): { update(): void; cleanup(): void };
export function trackInputModality(root?: HTMLElement): { readonly modality: 'keyboard' | 'pointer' | 'touch'; destroy(): void };
export function createRovingFocus(container: HTMLElement, o: { items: () => HTMLElement[]; orientation?: 'horizontal' | 'vertical' | 'both'; loop?: boolean; typeahead?: boolean; getLabel?: (el: HTMLElement) => string; onMove?: (el: HTMLElement, index: number, e: KeyboardEvent) => void }): { sync(): void; focus(el?: HTMLElement): void; readonly current: HTMLElement | null; destroy(): void };
export function icon(name: string, o?: { label?: string; size?: number | string; doc?: Document }): SVGSVGElement;
export function registerIcons(map: Record<string, string>, o?: { mirror?: string[] }): void;
export function iconNames(): string[];
export interface Services { readonly root: HTMLElement; readonly motion: Motion; readonly i18n: I18n; readonly format: Formatter; readonly overlays: OverlayManager; readonly announcer: Announcer; readonly dir: 'ltr' | 'rtl'; t(key: string, params?: Record<string, unknown>): string; announce(message: string, o?: { politeness?: 'polite' | 'assertive' }): void; /** Since 2.3.0: an embedding host's back button; false when no layer was open. */ handleBack(): boolean; readonly destroyed: boolean; destroy(): void }
export function createServices(o?: { root?: HTMLElement; locale?: string; messages?: Record<string, Record<string, unknown>>; motion?: Motion; reduced?: 'system' | boolean; /** Since 2.2.0: icon-only buttons and cut-off text show their text as a tooltip. Default true. */ tips?: boolean; /** Since 2.3.0: called whenever a layer opens or closes, for embedding hosts. */ onStackChange?: (stack: Array<{ kind: string; element: HTMLElement }>) => void }): Services;
export function getServices(node?: Node): Services;

// ---- components: createX(container, props, services?) → handle
export interface Handle<P> { readonly root: HTMLElement; update(props: Partial<P>): void; focus(): void; destroy(): boolean | void }
export interface FieldProps { label?: string; hideLabel?: boolean; description?: string; error?: string | null; required?: boolean; optional?: boolean; disabled?: boolean; readOnly?: boolean }
export interface ButtonProps { label: string; icon?: string; iconEnd?: string; variant?: 'secondary' | 'primary' | 'ghost' | 'danger'; iconOnly?: boolean; disabled?: boolean; busy?: boolean; pressed?: boolean; type?: 'button' | 'submit' | 'reset'; haspopup?: string; describedBy?: string; onClick?: (e: { event: MouseEvent }) => void; onPressedChange?: (e: { pressed: boolean; previous: boolean }) => void }
export type ButtonHandle = Handle<ButtonProps> & { readonly element: HTMLButtonElement };
export function createButton(container: HTMLElement, props: ButtonProps, services?: Services): ButtonHandle;
/** Since 2.3.0: related actions attached side by side, a named group of ordinary buttons. */
export interface ButtonGroupProps { label?: string; buttons: Array<ButtonProps & { id: string }>; disabled?: boolean; onClick?: (e: { id: string; event?: Event }) => void }
export function createButtonGroup(container: HTMLElement, props: ButtonGroupProps, services?: Services): Handle<ButtonGroupProps> & { readonly buttons: Array<Handle<ButtonProps> & { readonly element: HTMLButtonElement }> };
export function createIconButton(container: HTMLElement, props: ButtonProps, services?: Services): ButtonHandle;
export function createToggleButton(container: HTMLElement, props: ButtonProps, services?: Services): ButtonHandle;
export interface TextFieldProps extends FieldProps { value?: string; placeholder?: string; type?: 'text' | 'email' | 'url' | 'tel' | 'password' | 'search'; prefix?: string; suffix?: string; clearable?: boolean; maxLength?: number; counter?: boolean; autocomplete?: string; inputMode?: string; name?: string; ariaLabel?: string; hideLabel?: boolean; autosize?: boolean; maxHeight?: number; rows?: number; reveal?: boolean; /** Since 2.2.0. */ minLength?: number; /** Since 2.2.0: a string is matched whole, like the HTML attribute; a RegExp as given. */ pattern?: string | RegExp; /** Since 2.2.0: the message when `pattern` does not match (default "Enter a valid value"). */ patternMessage?: string; /** Since 2.2.0: Escape restored the last committed value. */ onCancel?: (e: { value: string; previous: string }) => void; validateOn?: 'blur' | 'input' | 'submit'; /** A message, or nothing when the value is fine. Since 2.2.0 it may answer later with a promise (an availability check): the field shows a spinner, a newer value aborts the older check through `signal`, and a check that rejects counts as passed. */ validate?: (value: string, signal: AbortSignal) => string | null | undefined | Promise<string | null | undefined>; /** Since 2.2.0: after a check has answered late, typing waits this long before checking again. Default 400 ms. */ validateDelay?: number; onInput?: (e: { value: string }) => void; onChange?: (e: { value: string }) => void; onSearch?: (e: { value: string }) => void }
export type TextFieldHandle = Handle<TextFieldProps> & { readonly input: HTMLInputElement | HTMLTextAreaElement; readonly value: string; /** Checks now; false while a check that answers later is still running. */ validate(): boolean; /** Since 2.2.0: checks now and resolves once every check has answered. */ validateAsync(): Promise<boolean>; /** Since 2.2.0: a check is running or waiting for a pause in typing. */ readonly checking: boolean };
export function createTextField(container: HTMLElement, props: TextFieldProps, services?: Services): TextFieldHandle;
export function createTextArea(container: HTMLElement, props: TextFieldProps, services?: Services): TextFieldHandle;
export function createSearchField(container: HTMLElement, props: TextFieldProps, services?: Services): TextFieldHandle;
export interface NumberFieldProps extends FieldProps { value?: number | null; min?: number; max?: number; step?: number | 'any'; largeStep?: number; format?: Intl.NumberFormatOptions; prefix?: string; suffix?: string; placeholder?: string; validate?: (v: number) => string | null; onChange?: (e: { value: number | null; previous: number | null }) => void; onInput?: (e: { value: number | null }) => void }
export function createNumberField(container: HTMLElement, props: NumberFieldProps, services?: Services): Handle<NumberFieldProps> & { readonly input: HTMLInputElement; readonly value: number | null };
export interface Option<V = string | number> { value: V; label: string; description?: string; disabled?: boolean; group?: string }
export interface SelectProps<V = string | number> extends FieldProps {
  options: Option<V>[]; value?: V | null; placeholder?: string;
  /** 'native' (default): the browser's <select>, whose open list cannot be themed. 'popup': a list drawn by the kit,
   *  anchored to the field. 'sheet': the list in a sheet (bottom sheet on narrow screens). 'auto': sheet on narrow touch
   *  screens, popup elsewhere. Drawn presentations follow the WAI-ARIA select-only combobox. Since 2.1.0. */
  presentation?: 'native' | 'popup' | 'sheet' | 'auto';
  /** Drawn presentations: a filter field at the top of the list. Since 2.1.0. */
  searchable?: boolean;
  /** Drawn presentations: the list shows a loading row instead of options. Since 2.1.0. */
  loading?: boolean;
  onChange?: (e: { value: V | null; previous: V | null; option: Option<V> | null }) => void;
  /** Since 2.2.0: save the change; it shows at once, the field says how saving went, a failure puts the confirmed value back and offers Retry. Resolve { unconfirmed: true } to wait for observe(). */
  action?: (next: V | null, signal: AbortSignal) => Promise<unknown>;
  /** Drawn presentations: the list opened / closed. Since 2.1.0. */
  onOpen?: () => void; onClose?: () => void;
}
/** A select field. presentation 'native' (default) uses the browser's <select>, whose open list cannot be themed;
 *  'popup', 'sheet' and 'auto' draw the list with the kit (since 2.1.0). In drawn presentations `select` is a hidden
 *  <select> mirroring the value and `trigger` is the focusable field; in 'native' `trigger` is null. */
export function createSelect<V = string | number>(container: HTMLElement, props: SelectProps<V>, services?: Services): Handle<SelectProps<V>> & { readonly select: HTMLSelectElement; readonly trigger: HTMLButtonElement | null; readonly value: V | null; readonly isOpen: boolean; open(): void; close(): void; validate(): boolean; readonly state: ActionState<V | null>; /** Since 2.2.0: read-back for an action that resolved { unconfirmed: true }. */ observe(value: V | null): void };
export interface TimeFieldProps extends FieldProps { type?: 'time' | 'datetime-local' | 'month' | 'week'; value?: string; min?: string; max?: string; step?: number; onChange?: (e: { value: string; previous: string }) => void }
export function createTimeField(container: HTMLElement, props: TimeFieldProps, services?: Services): Handle<TimeFieldProps> & { readonly input: HTMLInputElement; readonly value: string };
export interface CheckboxProps { label?: string; description?: string; checked?: boolean; indeterminate?: boolean; disabled?: boolean; name?: string; ariaLabel?: string; onChange?: (e: { checked: boolean; previous: boolean }) => void; /** Since 2.2.0: save the change; it shows at once, the field says how saving went, a failure puts the confirmed value back and offers Retry. Resolve { unconfirmed: true } to wait for observe(). */ action?: (next: boolean, signal: AbortSignal) => Promise<unknown> }
export function createCheckbox(container: HTMLElement, props: CheckboxProps, services?: Services): Handle<CheckboxProps> & { readonly input: HTMLInputElement; readonly checked: boolean; readonly state: ActionState<boolean>; /** Since 2.2.0: read-back for an action that resolved { unconfirmed: true }. */ observe(value: boolean): void };
export interface ChoiceGroupProps<V> extends FieldProps { options: Option<V>[]; orientation?: 'vertical' | 'horizontal' }
export function createCheckboxGroup<V = string>(container: HTMLElement, props: ChoiceGroupProps<V> & { value?: V[]; onChange?: (e: { value: V[]; previous: V[] }) => void; /** Since 2.2.0: save the change; it shows at once, the field says how saving went, a failure puts the confirmed value back and offers Retry. Resolve { unconfirmed: true } to wait for observe(). */ action?: (next: V[], signal: AbortSignal) => Promise<unknown> }, services?: Services): Handle<ChoiceGroupProps<V> & { value?: V[] }> & { readonly value: V[]; validate(): boolean; readonly state: ActionState<V[]>; /** Since 2.2.0: read-back for an action that resolved { unconfirmed: true }. */ observe(value: V[]): void };
export function createRadioGroup<V = string>(container: HTMLElement, props: ChoiceGroupProps<V> & { value?: V | null; onChange?: (e: { value: V; previous: V | null }) => void; /** Since 2.2.0: save the change; it shows at once, the field says how saving went, a failure puts the confirmed value back and offers Retry. Resolve { unconfirmed: true } to wait for observe(). */ action?: (next: V, signal: AbortSignal) => Promise<unknown> }, services?: Services): Handle<ChoiceGroupProps<V> & { value?: V | null }> & { readonly value: V | null; validate(): boolean; readonly state: ActionState<V | null>; /** Since 2.2.0: read-back for an action that resolved { unconfirmed: true }. */ observe(value: V | null): void };
export interface SwitchProps { label: string; hideLabel?: boolean; description?: string; checked?: boolean; disabled?: boolean; readOnly?: boolean; action?: (next: boolean, signal: AbortSignal) => Promise<unknown>; onChange?: (e: { checked: boolean }) => void }
export function createSwitch(container: HTMLElement, props: SwitchProps, services?: Services): Handle<SwitchProps> & { readonly button: HTMLButtonElement; readonly checked: boolean; readonly state: ActionState<boolean> };
export interface SegmentedProps<V = string> { label?: string; options: Array<{ value: V; label: string; icon?: string; count?: number | string; disabled?: boolean }>; value?: V | V[] | null; multiple?: boolean; disabled?: boolean; onChange?: (e: { value: V | V[]; previous: V | V[] | null }) => void; /** Since 2.2.0: save the change; it shows at once, the field says how saving went, a failure puts the confirmed value back and offers Retry. Resolve { unconfirmed: true } to wait for observe(). */ action?: (next: V | V[], signal: AbortSignal) => Promise<unknown> }
export function createSegmented<V = string>(container: HTMLElement, props: SegmentedProps<V>, services?: Services): Handle<SegmentedProps<V>> & { readonly value: V | V[] | null; readonly state: ActionState<V | V[] | null>; /** Since 2.2.0: read-back for an action that resolved { unconfirmed: true }. */ observe(value: V | V[] | null): void };
export interface ComboboxProps<V = string | number> extends FieldProps { options?: Option<V>[]; load?: (query: string, signal: AbortSignal) => Promise<Option<V>[]>; multiple?: boolean; value?: V | null; values?: V[]; creatable?: boolean; minQuery?: number; maxResults?: number; placeholder?: string; openOnFocus?: boolean; /** Since 2.2.0: the host is loading the options itself. */ loading?: boolean; /** Since 2.2.0: the host's load failed; a message, or true for "Couldn't load". */ loadError?: string | boolean | null; /** Since 2.2.0: Retry for a host `loadError`. */ onRetry?: () => void; onChange?: (e: { value?: V | null; values?: V[]; previous: unknown }) => void; onQuery?: (e: { query: string }) => void; onCreate?: (e: { query: string }) => void }
export function createCombobox<V = string | number>(container: HTMLElement, props: ComboboxProps<V>, services?: Services): Handle<ComboboxProps<V>> & { readonly input: HTMLInputElement; readonly value: V | null | V[]; readonly isOpen: boolean; open(): void; close(): void; validate(): boolean };
export interface DatePickerProps extends FieldProps { value?: string | null; min?: string; max?: string; isDateDisabled?: (iso: string) => boolean; weekStart?: number; onChange?: (e: { value: string | null; previous: string | null }) => void }
/** Since 2.2.0: the date picker's grid on the page. */
export interface CalendarProps { /** The group's accessible name. */ label?: string; /** Single: 'YYYY-MM-DD' | null; with `range`: { start, end } | null. */ value?: string | DateRange | null; range?: boolean; min?: string; max?: string; isDateDisabled?: (iso: string) => boolean; weekStart?: number; months?: number; readOnly?: boolean; disabled?: boolean; onChange?: (e: { value: string | DateRange | null; previous: string | DateRange | null }) => void }
export function createCalendar(container: HTMLElement, props: CalendarProps, services?: Services): Handle<CalendarProps> & { readonly value: string | DateRange | null };
export function createDatePicker(container: HTMLElement, props: DatePickerProps, services?: Services): Handle<DatePickerProps> & { readonly input: HTMLInputElement; readonly value: string | null; readonly isOpen: boolean; open(): void; close(): void; validate(): boolean };
export interface DateRange { start: string; end: string }
export interface DateRangePickerProps extends FieldProps { value?: DateRange | null; min?: string; max?: string; isDateDisabled?: (iso: string) => boolean; weekStart?: number; months?: 1 | 2; presets?: Array<DateRange & { label: string }>; onChange?: (e: { value: DateRange | null; previous: DateRange | null }) => void }
export function createDateRangePicker(container: HTMLElement, props: DateRangePickerProps, services?: Services): Handle<DateRangePickerProps> & { readonly value: DateRange | null; readonly isOpen: boolean; open(): void; close(): void; validate(): boolean };
export function parseISO(iso: string): { y: number; m: number; d: number } | null;
export function toISO(d: { y: number; m: number; d: number }): string;
export function addDays(iso: string, n: number): string;
export function addMonths(iso: string, n: number): string;
export function todayISO(now?: Date): string;
export function formatTyped(iso: string, locale: string): string;
export function parseTyped(text: string, locale: string): string | null;
export interface FileItem { id?: string; name: string; size?: number; status?: 'ready' | 'uploading' | 'done' | 'error'; progress?: number; error?: string }
export interface FileDropProps extends FieldProps { accept?: string; acceptLabel?: string; maxSize?: number; maxFiles?: number; multiple?: boolean; files?: FileItem[]; onFiles?: (e: { accepted: File[]; rejected: Array<{ file: File; reason: string }> }) => void; onRemove?: (e: { file: FileItem }) => void }
export function createFileDrop(container: HTMLElement, props: FileDropProps, services?: Services): Handle<FileDropProps> & { readonly input: HTMLInputElement; addFiles(files: FileList | File[]): void };
export interface FormControl { readonly value: unknown; update(p: { value?: any; error?: string | null }): void; validate?(): boolean; /** Since 2.2.0: the form waits for it when `checking` is true. */ validateAsync?(): Promise<boolean>; readonly checking?: boolean; focus?(): void }
export interface FormHandle { readonly root: HTMLElement; readonly bar: HTMLElement; add<T extends FormControl>(name: string, control: T, initial?: unknown): T; remove(name: string): void; readonly values: Record<string, unknown>; readonly dirty: string[]; readonly state: ActionState; submit(): Promise<ActionResult>; reset(): void; update(p: { onSubmit?: (values: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>; saveBar?: boolean }): void; destroy(): boolean | void }
/** Since 2.2.0: a native fieldset with a legend for any fields; put them in `body`. */
export interface FieldsetProps { legend?: string; hideLegend?: boolean; description?: string; /** A message for the group as a whole, such as a rule across its fields. */ error?: string | null; /** Disables every native control inside. */ disabled?: boolean; /** Side by side, dropping to fewer columns below 12rem each. Default 1. */ columns?: number }
export function createFieldset(container: HTMLElement, props: FieldsetProps, services?: Services): Handle<FieldsetProps> & { readonly root: HTMLFieldSetElement; readonly body: HTMLElement };
export function createForm(container: HTMLElement, props?: { onSubmit?: (values: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>; saveBar?: boolean; onDirtyChange?: (e: { count: number; keys: string[] }) => void }, services?: Services): FormHandle;

// ---- M3: navigation, overlays, feedback
/** Since 2.3.0 an item with `children` is a group (G31): a disclosure in the list layout, a menu in the rail and bar. */
export interface NavItem { id: string; label: string; short?: string; icon?: string; href?: string; badge?: number | string; attention?: boolean; section?: string; children?: NavItem[] }
export interface NavEvent<T> { id: string; item: T; event?: Event }
export interface NavListProps { items: NavItem[]; value?: string; label?: string; layout?: 'list' | 'rail' | 'bar'; maxItems?: number; /** Since 2.3.0: groups open at the start. */ expanded?: string[]; onNavigate?: (e: NavEvent<NavItem>) => void }
export function createNavList(container: HTMLElement, props: NavListProps, services?: Services): Handle<NavListProps> & { readonly value: string | undefined; setValue(id: string): void };
export interface Crumb { id?: string; label: string; href?: string }
export interface AppShellProps { brand?: { label: string; mark?: Node; href?: string }; nav: NavItem[]; value?: string; onNavigate?: (e: NavEvent<NavItem>) => void; breadcrumbs?: Crumb[]; onBreadcrumb?: (e: NavEvent<Crumb>) => void; topItems?: Node | Node[] | ((slot: HTMLElement) => void); navLabel?: string; maxBarItems?: number; mode?: 'auto' | 'side' | 'rail' | 'bar' }
export interface AppShellHandle extends Omit<Handle<AppShellProps>, 'focus'> { readonly main: HTMLElement; readonly top: HTMLElement; readonly mode: 'side' | 'rail' | 'bar'; setValue(id: string): void; setBreadcrumbs(items: Crumb[]): void; focusMain(): void }
/** Since 2.3.0: a list and the item it opens; side by side when wide, push navigation when stacked (G38). */
export interface MasterDetailProps { masterLabel?: string; detailLabel?: string; open?: boolean; stackBelow?: number; masterWidth?: string; onOpenChange?: (e: { open: boolean; reason: 'button' | 'api' }) => void }
export function createMasterDetail(container: HTMLElement, props?: MasterDetailProps, services?: Services): Handle<MasterDetailProps> & { readonly master: HTMLElement; readonly detail: HTMLElement; readonly stacked: boolean; readonly open: boolean; showDetail(o?: { focus?: boolean }): void; back(): boolean };
export function createAppShell(container: HTMLElement, props: AppShellProps, services?: Services): AppShellHandle;
/** Since 2.5.0 (G56): one sidebar of a workspace. Widths are preferences in px; the layout gives way when the window is narrow. */
export interface WorkspaceSide { label?: string; width?: number; min?: number; max?: number; open?: boolean; resizable?: boolean }
export type WorkspaceRegion = 'start' | 'end';
export interface WorkspaceLayout { mode: 'wide' | 'medium' | 'narrow'; start: { open: boolean; width: number }; end: { open: boolean; width: number } }
export interface WorkspaceProps {
  top?: boolean; bottom?: boolean; start?: WorkspaceSide | false; end?: WorkspaceSide | false; mainLabel?: string; bottomLabel?: string;
  /** The main region's minimum width (px) before sidebars give way. Default 360. */ mainMin?: number;
  /** Below this width (px) both sidebars float over the main region. Default 760. */ narrowBelow?: number;
  onLayoutChange?: (e: WorkspaceLayout & { region: WorkspaceRegion | null; reason: 'resize' | 'toggle' | 'mode' | 'escape' | 'outside' | 'blur' }) => void;
}
export interface WorkspaceHandle extends Handle<WorkspaceProps> {
  readonly top: HTMLElement; readonly start: HTMLElement; readonly main: HTMLElement; readonly end: HTMLElement; readonly bottom: HTMLElement;
  readonly layout: WorkspaceLayout; readonly mode: WorkspaceLayout['mode'];
  open(region: WorkspaceRegion, o?: { focus?: boolean }): void; close(region: WorkspaceRegion): void; toggle(region: WorkspaceRegion, o?: { focus?: boolean }): void;
  setWidth(region: WorkspaceRegion, px: number): void; focusMain(): void;
}
export function createWorkspace(container: HTMLElement, props?: WorkspaceProps, services?: Services): WorkspaceHandle;
export interface TabsProps { tabs: Array<{ id: string; label: string; icon?: string; badge?: number | string; disabled?: boolean }>; value?: string; label?: string; activation?: 'auto' | 'manual'; /** Since 2.3.0: 'menu' moves the tabs that do not fit into a More tabs menu. */ overflow?: 'scroll' | 'menu'; onChange?: (e: { value: string; previous: string | undefined }) => void }
export function createTabs(container: HTMLElement, props: TabsProps, services?: Services): Handle<TabsProps> & { panel(id: string): HTMLElement; readonly value: string | undefined; select(id: string): void };
export interface BreadcrumbsProps { items: Crumb[]; label?: string; maxItems?: number; onNavigate?: (e: NavEvent<Crumb>) => void }
export function createBreadcrumbs(container: HTMLElement, props: BreadcrumbsProps, services?: Services): Omit<Handle<BreadcrumbsProps>, 'focus'>;
export interface PaginationProps { page: number; pageCount: number; /** Since 2.3.0: every page button and the page-size field off. */ disabled?: boolean; total?: number; pageSize?: number; pageSizes?: number[]; siblings?: number; label?: string; onChange?: (e: { page: number; previous: number }) => void; onPageSizeChange?: (e: { pageSize: number }) => void }
export function createPagination(container: HTMLElement, props: PaginationProps, services?: Services): Omit<Handle<PaginationProps>, 'focus'> & { readonly page: number };
/** Since 2.3.0 (G31) a toolbar also takes filters: 'search', 'select' and 'date' items, which never move into More. */
export interface ToolbarItem { id?: string; label?: string; icon?: string; iconOnly?: boolean; type?: 'button' | 'toggle' | 'menu' | 'separator' | 'search' | 'select' | 'date'; pressed?: boolean; disabled?: boolean; variant?: ButtonProps['variant']; items?: MenuItem[]; value?: string | null; options?: Option<string>[]; placeholder?: string }
export interface ToolbarProps { label?: string; items: ToolbarItem[]; overflow?: boolean; onAction?: (e: { id?: string; item: ToolbarItem; pressed?: boolean; selected?: MenuItem; value?: string | null }) => void }
export function createToolbar(container: HTMLElement, props: ToolbarProps, services?: Services): Handle<ToolbarProps>;
export interface LinkProps { label: string; href: string; external?: boolean; standalone?: boolean; onClick?: (e: { event: MouseEvent }) => void }
export function createLink(container: HTMLElement, props: LinkProps, services?: Services): Handle<LinkProps>;

export interface MenuItem { id?: string; label?: string; icon?: string; description?: string; shortcut?: string; disabled?: boolean; danger?: boolean; href?: string; checked?: boolean; type?: 'radio'; /** Since 2.3.0: names the set a radio item belongs to; reported with the selection. */ group?: string; items?: MenuItem[]; separator?: boolean; heading?: string; onSelect?: (item: MenuItem, event?: Event, info?: MenuSelection) => void }
/** Since 2.3.0: where a selected item sits: the ids from the top menu down to it, and a radio item's group. */
export interface MenuSelection { path: string[]; group: string | null }
export interface MenuHandle { readonly element: HTMLElement; readonly isOpen: boolean; close(reason?: string, o?: { restoreFocus?: boolean }): void; focusFirst(): void }
export function openMenu(services: Services | undefined, o: { items: MenuItem[]; trigger?: Element; anchor?: Element; point?: { x: number; y: number }; placement?: string; offset?: number; label?: string; focus?: 'first' | 'last' | 'none'; onSelect?: (item: MenuItem, event?: Event, info?: MenuSelection) => void; onClose?: (reason: string) => void }): MenuHandle;
export interface MenuButtonProps { label: string; icon?: string; iconOnly?: boolean; variant?: ButtonProps['variant']; items: MenuItem[] | (() => MenuItem[]); placement?: string; disabled?: boolean; onSelect?: (e: { item: MenuItem; id?: string; /** Since 2.3.0. */ path: string[]; /** Since 2.3.0. */ group: string | null; event?: Event }) => void }
export function createMenuButton(container: HTMLElement, props: MenuButtonProps, services?: Services): Handle<MenuButtonProps> & { readonly element: HTMLButtonElement; readonly isOpen: boolean; open(focus?: 'first' | 'last' | 'none'): void; close(): void };
export interface ContextMenuProps { items: MenuItem[] | ((event: Event) => MenuItem[]); label?: string; disabled?: boolean; onSelect?: (e: { item: MenuItem; id?: string; /** Since 2.3.0. */ path: string[]; /** Since 2.3.0. */ group: string | null; origin: Element; event?: Event }) => void }
export function createContextMenu(target: HTMLElement, props: ContextMenuProps, services?: Services): Omit<Handle<ContextMenuProps>, 'focus'> & { readonly isOpen: boolean; close(): void };
export interface TooltipProps { content: string | Node; placement?: string; delay?: number; describe?: boolean }
export function createTooltip(target: HTMLElement, props: TooltipProps, services?: Services): Omit<Handle<TooltipProps>, 'focus'> & { show(): void; hide(): void; readonly isOpen: boolean };
export interface PopoverProps { content: Node | ((body: HTMLElement) => void); title?: string; label?: string; placement?: string; initialFocus?: () => Element | null; onOpenChange?: (e: { open: boolean; reason?: string }) => void }
export function createPopover(trigger: HTMLElement, props: PopoverProps, services?: Services): Omit<Handle<PopoverProps>, 'focus'> & { readonly body: HTMLElement; readonly isOpen: boolean; open(): void; close(o?: { restoreFocus?: boolean; reason?: string }): void; toggle(): void };
export interface ModalAction<V = unknown> { label: string; variant?: ButtonProps['variant']; icon?: string; value?: V; autoFocus?: boolean; disabled?: boolean; close?: boolean; onClick?: (ctx: { dialog: ModalHandle<V>; value?: V }) => V | false | void | Promise<V | false | void> }
export interface ModalProps<V = unknown> { title: string; description?: string; content?: Node | ((body: HTMLElement) => void); actions?: ModalAction<V>[]; dismissible?: boolean; closeButton?: boolean; initialFocus?: Element | (() => Element | null); onClose?: (e: { value: V | undefined; reason: string }) => void }
export interface ModalHandle<V = unknown> { readonly element: HTMLElement; readonly body: HTMLElement; readonly isOpen: boolean; open(): Promise<V | undefined>; close(value?: V): void; setError(message: string | null): void; update(p: Partial<ModalProps<V>>): void; destroy(): boolean | void }
export function createDialog<V = unknown>(props: ModalProps<V> & { role?: 'dialog' | 'alertdialog'; size?: 'sm' | 'md' | 'lg'; /** Since 2.3.0: a CSS width, capped by the screen; or set --ui-dialog-width. */ width?: string }, services?: Services): ModalHandle<V>;
export function confirm(props: { title: string; message?: string; content?: Node; confirmLabel?: string; cancelLabel?: string; danger?: boolean; /** Since 2.2.0: the confirm action stays disabled until this exact text is typed. */ typeToConfirm?: string; onConfirm?: () => unknown }, services?: Services): Promise<boolean>;
export function createSheet<V = unknown>(props: ModalProps<V> & { side?: 'auto' | 'end' | 'start' | 'bottom'; /** Since 2.3.0: a CSS width for a side sheet; or set --ui-sheet-width. */ width?: string }, services?: Services): ModalHandle<V> & { readonly side: 'end' | 'start' | 'bottom' };

export type FeedbackKind = 'info' | 'ok' | 'warn' | 'fail';
export interface ToastOptions { kind?: FeedbackKind; message: string; detail?: string; undo?: () => void; retry?: () => void; action?: { label: string; onClick?: () => void }; /** ms. Info and ok toasts default to 5 s; warn, fail and (since 2.2.0) any toast with undo, retry or an action stay until handled. */ duration?: number; onDismiss?: (reason: string) => void }
export interface ToastHandle { dismiss(reason?: string): void; update(o: Partial<ToastOptions>): void; /** Stop the time limit (typed since 2.2.0; 1.0 parity). */ pause(): void; /** Restart the rest of the time limit, at least 1.2 s. */ resume(): void; readonly el: HTMLElement }
export interface Toaster { show(o: ToastOptions): ToastHandle; dismissAll(): void; readonly count: number; readonly region: HTMLElement }
export function getToaster(services?: Services): Toaster;
export function toast(o: ToastOptions, services?: Services): ToastHandle;
export function reportFeedback(o: ToastOptions & { source?: Element | null }, services?: Services): { placement: 'source' } | { placement: 'toast'; toast: ToastHandle };
export interface InlineAlertProps { kind?: 'info' | 'ok' | 'warn' | 'bad'; title?: string; message?: string; actions?: Array<{ label: string; variant?: ButtonProps['variant']; onClick?: () => void }>; dismissible?: boolean; onDismiss?: () => void; live?: false | 'polite' | 'assertive' }
export function createInlineAlert(container: HTMLElement, props: InlineAlertProps, services?: Services): Omit<Handle<InlineAlertProps>, 'focus'>;
export interface ProgressProps { label?: string; value?: number | null; showValue?: boolean; valueText?: string; hideLabel?: boolean }
export function createProgress(container: HTMLElement, props: ProgressProps, services?: Services): Omit<Handle<ProgressProps>, 'focus'>;
export function createSpinner(container: HTMLElement, props?: { label?: string; size?: 'sm' | 'md' | 'lg' }, services?: Services): Omit<Handle<{ label?: string; size?: 'sm' | 'md' | 'lg' }>, 'focus'>;
export function createSkeleton(container: HTMLElement, props?: { lines?: number; avatar?: boolean; block?: number | string }, services?: Services): Omit<Handle<{ lines?: number; avatar?: boolean; block?: number | string }>, 'focus'>;

// ---- M4: data display, layout and type
export type Tone = 'neutral' | 'info' | 'good' | 'warn' | 'bad' | 'accent';
export function badge(value: string | number, o?: { tone?: Tone; label?: string; doc?: Document }): HTMLElement;
export function statusLabel(label: string, tone?: Tone, o?: { doc?: Document }): HTMLElement;
export function tag(label: string, o?: { tone?: Tone; onRemove?: (e: MouseEvent) => void; /** Default "Remove {label}" in the services' language (since 2.2.0). */ removeLabel?: string; services?: Services; doc?: Document }): HTMLElement;
export function truncate(text: string, o?: { lines?: number; doc?: Document }): HTMLElement;
export function twoLine(primary: string | Node, secondary?: string | Node | null, o?: { doc?: Document }): HTMLElement;
export function sparkline(values: number[], o?: { label?: string; doc?: Document }): SVGSVGElement;
export function createRelativeTime(container: HTMLElement, props: { value: Date | number | string | null; now?: Date | number }, services?: Services): Omit<Handle<{ value: Date | number | string | null; now?: Date | number }>, 'focus'>;
export interface PageHeaderProps { title: string; description?: string | Node; eyebrow?: string; lead?: Node; actions?: Node[] | ((slot: HTMLElement) => void); level?: 1 | 2 | 3 }
export function createPageHeader(container: HTMLElement, props: PageHeaderProps, services?: Services): Handle<PageHeaderProps> & { readonly actions: HTMLElement; readonly heading: HTMLElement };
export interface PanelProps { title?: string; description?: string; actions?: Node[] | ((slot: HTMLElement) => void); columns?: 1 | 2; footer?: Node; padded?: boolean; level?: 2 | 3 | 4 }
export function createPanel(container: HTMLElement, props: PanelProps, services?: Services): Omit<Handle<PanelProps>, 'focus'> & { readonly body: HTMLElement; readonly actions: HTMLElement };
export interface DisclosureProps { title: string; open?: boolean; content?: Node | string | ((body: HTMLElement) => void); headingLevel?: 2 | 3 | 4 | 5 | 6; onToggle?: (e: { open: boolean }) => void }
export function createDisclosure(container: HTMLElement, props: DisclosureProps, services?: Services): Handle<DisclosureProps> & { readonly body: HTMLElement; readonly trigger: HTMLButtonElement; readonly isOpen: boolean; open(): void; close(): void; toggle(): void };
export interface AccordionProps { items: Array<{ id: string; title: string; content?: Node | string | ((body: HTMLElement) => void) }>; value?: string | string[] | null; multiple?: boolean; level?: 2 | 3 | 4 | 5 | 6; onChange?: (e: { value: string | string[] | null }) => void }
export function createAccordion(container: HTMLElement, props: AccordionProps, services?: Services): Omit<Handle<AccordionProps>, 'focus'> & { readonly value: string | string[] | null | undefined };
export type KeyValueItem = { label: string; value?: Node | string | null; mono?: boolean; copy?: boolean | string } | [string, (Node | string | null)?, { mono?: boolean; copy?: boolean | string }?];
export function createKeyValue(container: HTMLElement, props: { items: KeyValueItem[]; columns?: 1 | 2 | 3; label?: string }, services?: Services): Omit<Handle<{ items: KeyValueItem[]; columns?: 1 | 2 | 3; label?: string }>, 'focus'>;
export interface MetricProps { label: string; value?: string | number | Node | null; unit?: string; delta?: { value: string | number; direction?: 'up' | 'down' | 'flat'; good?: 'up' | 'down' | null; label?: string }; sparkline?: number[]; sparklineLabel?: string; footnote?: string; updatedAt?: Date | number | string; staleAfter?: number; loading?: boolean }
/** Since 2.3.0: a card; with href or onClick the whole card acts through its title (block link). */
export interface CardProps { title: string; description?: string; meta?: string; media?: { src: string; alt?: string } | Node; href?: string; onClick?: (e: { event?: Event }) => void; selectable?: boolean; selected?: boolean; onSelectChange?: (e: { selected: boolean }) => void; actions?: Array<{ id: string; label: string; icon?: string; iconOnly?: boolean; variant?: ButtonProps['variant']; disabled?: boolean; onClick?: () => void }>; onAction?: (e: { id: string }) => void; level?: 1 | 2 | 3 | 4 | 5 | 6; disabled?: boolean }
export function createCard(container: HTMLElement, props: CardProps, services?: Services): Handle<CardProps> & { readonly selected: boolean };
export function createMetric(container: HTMLElement, props: MetricProps, services?: Services): Omit<Handle<MetricProps>, 'focus'>;
export interface TimelineItem { id?: string; title: string | Node; description?: string | Node; time?: Date | number | string; timeText?: string; status?: 'done' | 'current' | 'failed' | 'pending'; actor?: string }
export function createTimeline(container: HTMLElement, props: { items: TimelineItem[]; label?: string }, services?: Services): Omit<Handle<{ items: TimelineItem[]; label?: string }>, 'focus'>;
export interface ListItem { id: string | number; title: string | Node; description?: string | Node; meta?: string | Node; leading?: string | Node; trailing?: string | Node; href?: string; selected?: boolean; disabled?: boolean; group?: string }
export function createList(container: HTMLElement, props: { items: ListItem[]; label?: string; onSelect?: (e: { id: ListItem['id']; item: ListItem; event: Event }) => void }, services?: Services): Omit<Handle<{ items: ListItem[]; label?: string }>, 'focus'>;
/** Since 2.2.0: 'unavailable' (with `reason`) and 'unconfigured' replace the content; 'stale' and 'partial' are a compact notice beside content that stays on screen. */
export type DataStateKind = 'empty' | 'filtered' | 'error' | 'unavailable' | 'unconfigured' | 'stale' | 'partial';
export interface EmptyStateProps { kind?: DataStateKind; /** For 'unavailable'. */ reason?: 'permission' | 'offline'; title?: string; message?: string; icon?: string; action?: { label: string; onClick?: () => void; variant?: ButtonProps['variant']; icon?: string }; /** The action is working, a retry in flight for example. */ busy?: boolean; /** For 'stale': "Showing data from …", kept current. */ updatedAt?: Date | number | string; onClearFilters?: () => void; onRetry?: () => void; /** For 'unconfigured': adds a Set up action. */ onSetup?: () => void }
export function createEmptyState(container: HTMLElement, props: EmptyStateProps, services?: Services): Handle<EmptyStateProps>;
/** Since 2.3.0 (G30): `description`; lazy children with `hasChildren`, `loading`, `loadError`. */
export interface TreeItem { id: string; label: string; description?: string; icon?: string; badge?: number | string; disabled?: boolean; children?: TreeItem[]; hasChildren?: boolean; loading?: boolean; loadError?: string | boolean }
/** Since 2.3.0 (G30): `selection` 'multiple' and 'checkbox' (value is then an array), `disabled`, `readOnly`, `onChange`, `onRetry`. */
export interface TreeProps { items: TreeItem[]; expanded?: string[]; value?: string | string[] | null; label?: string; selection?: 'single' | 'multiple' | 'checkbox'; disabled?: boolean; readOnly?: boolean; onSelect?: (e: { id: string; item: TreeItem }) => void; onChange?: (e: { value: string[]; id: string | null; item: TreeItem | null }) => void; onToggle?: (e: { id: string; open: boolean; item: TreeItem }) => void; onRetry?: (e: { id: string; item: TreeItem }) => void }
export function createTree(container: HTMLElement, props: TreeProps, services?: Services): Handle<TreeProps> & { readonly value: string | string[] | undefined; readonly expanded: string[]; expand(id: string, open?: boolean): void; /** Since 2.3.0: opens the items above `id` and focuses it. */ focus(id?: string): void };
export interface TableColumn<R> { id: string; label: string; role?: 'primary' | 'meta'; align?: 'start' | 'end'; priority?: 'low'; width?: string; pin?: 'start' | 'end'; minWidth?: number; resizable?: boolean; sortable?: boolean; sortValue?: (row: R) => unknown; text?: (row: R) => string; cell?: (row: R) => Node | string | number | null | undefined; stackLabel?: boolean; hideLabel?: boolean }
export interface TableProps<R> {
  label?: string; columns: TableColumn<R>[]; rows: R[]; rowKey?: keyof R | ((row: R) => unknown); rowLabel?: (row: R) => string;
  selectable?: false | 'multiple' | 'single'; selected?: unknown[]; onSelectionChange?: (e: { selected: unknown[] }) => void;
  sort?: { id: string; direction: 'asc' | 'desc' } | null; sortMode?: 'client' | 'host'; onSortChange?: (e: { id: string; direction: 'asc' | 'desc' }) => void;
  filter?: string | ((row: R) => boolean); onClearFilters?: () => void; pageSize?: number; page?: number; onPageChange?: (e: { page: number }) => void;
  rowMenu?: (row: R) => MenuItem[]; onRowMenu?: (e: { item: MenuItem; row: R; key: unknown; event?: Event }) => void;
  /** `via` since 2.5.0: what ran the action. */
  onRowAction?: (e: { row: R; key: unknown; event: Event; via: 'keyboard' | 'click' | 'double-click' }) => void;
  /** Since 2.5.0 (G58): 'primary' (default: Enter, or a click on the primary cell, also one holding a Node) or 'double-click' (Enter or a double-click anywhere on the row). */
  activation?: 'primary' | 'double-click';
  /** Since 2.5.0: plain clicks on a row; clicks on controls inside cells never count. */
  onRowClick?: (e: { row: R; key: unknown; event: MouseEvent }) => void; onRowDoubleClick?: (e: { row: R; key: unknown; event: MouseEvent }) => void;
  /** Since 2.5.0 (with `selectable`): a click selects the row, Ctrl / ⌘ + click toggles, Shift + click and Shift + ↑ ↓ select a range. */
  selectOnClick?: boolean;
  /** Since 2.5.0 (G58): current is marked (aria-current); disabled rows cannot be selected or acted on; unavailable rows say `reason` instead of running their action. Pass a new function to re-evaluate. */
  rowState?: (row: R) => { current?: boolean; currentLabel?: string; disabled?: boolean; unavailable?: boolean; reason?: string } | null | undefined;
  /** Since 2.5.0 (G64): a header row wherever the key changes in the current order; sticky in a virtual table. */
  groupBy?: (row: R) => unknown; groupLabel?: (key: any, rows: R[]) => Node | string;
  /** Since 2.5.0 (G57): drag handles; the table proposes an order, the host confirms it by passing new rows. Off while sorted on the client, filtered, searched, paginated or disabled. */
  reorderable?: boolean; onReorder?: (e: { keys: unknown[]; before: unknown | null; index: number; order: unknown[]; rows: R[] }) => void;
  /** Since 2.5.0 (D81): after a rows update, rows still in view glide from where they were and new rows fade in. Rows that confirm a reorder glide without it. Never on sort or filter. */
  animateRows?: boolean;
  bulkActions?: Array<{ id: string; label: string; icon?: string; variant?: ButtonProps['variant'] }>; onBulkAction?: (e: { id: string; keys: unknown[]; rows: R[] }) => void;
  expandable?: (row: R) => Node | string | null; totals?: Record<string, Node | string>; totalsLabel?: string;
  loading?: boolean; error?: string | boolean | null; onRetry?: () => void; empty?: { title?: string; message?: string; action?: EmptyStateProps['action'] };
  hidden?: string[]; columnMenu?: boolean; onColumnsChange?: (e: { hidden: string[] }) => void; stacked?: 'auto' | boolean;
  /** P1: render only the rows in view inside a scrolling region of this height (ignored with pageSize). */
  virtual?: { height?: string } | false;
  /** Column resizing (separator in each header cell); widths in px by column id. */
  /** Since 2.3.0 (G32): a search field above the rows; client filtering unless searchMode is 'host'. */
  search?: boolean | { label?: string; placeholder?: string }; query?: string; searchMode?: 'client' | 'host'; onQueryChange?: (e: { query: string }) => void;
  /** Since 2.3.0: a line with the row count and the selection; `total` for host-loaded data. */ status?: boolean; total?: number;
  /** Since 2.3.0: the compact "not up to date" notice, with Retry from onRetry. */ stale?: boolean | { updatedAt?: Date | number | string };
  /** Since 2.3.0: every control off; the rows stay readable and navigable. */ disabled?: boolean;
  resizable?: boolean; widths?: Record<string, number>; onColumnResize?: (e: { id: string; width: number | null; widths: Record<string, number> }) => void;
}
export type TableHandle<R = Record<string, unknown>> = Handle<TableProps<R>> & { readonly table: HTMLElement; readonly widths: Record<string, number>; readonly selected: unknown[]; readonly rows: R[]; readonly stacked: boolean; setSelected(keys: unknown[]): void; focusRow(key: unknown): void; scrollToRow(key: unknown): void };
export function createTable<R = Record<string, unknown>>(container: HTMLElement, props: TableProps<R>, services?: Services): TableHandle<R>;

// ---- component authoring helpers (D44: the conventions shared by /ui, /ui/plus and app components)
export interface ComponentContext { readonly s: Services; readonly doc: Document; readonly win: Window; readonly name: string; readonly dead: boolean;
  h(tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): HTMLElement; icon(name: string, o?: { label?: string; size?: number | string }): SVGSVGElement;
  on(target: EventTarget, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions): void; own<T extends Node>(node: T): T; cleanup(fn: () => void): () => void;
  emit(host: Element, type: string, detail: unknown, cb?: (detail: any) => void): void; destroy(): boolean }
export function setup(container: Element, services: Services | undefined, name: string): ComponentContext;
export function fill<T extends Element>(el: T, ...kids: unknown[]): T;
export function h(doc: Document, tag: string, attrs?: Record<string, unknown>, ...kids: unknown[]): HTMLElement;
export function uid(prefix?: string): string;
export function field(ctx: ComponentContext, box: HTMLElement, o?: { input?: HTMLElement; label?: string; description?: string; error?: string | null; required?: boolean; optional?: boolean; hideLabel?: boolean; labelFor?: boolean }): { el: HTMLElement; ids: Record<string, string>; labelEl: HTMLElement; setLabel(l: string): void; setDescription(d?: string | null): void; setError(m?: string | null): void; setCounter(t?: string | null): void; setRequired(r?: boolean, o?: boolean): void; describe(target: Element): void; readonly error: string | null };
/** The pending state of a value control (since 2.2.0; used by the kit's checkbox, choice groups, segmented control, select and slider). get() mounts the status line on first use. */
export interface PendingValue<V> { get(): { readonly el: HTMLElement; run(value: V, task: (value: V, signal: AbortSignal) => Promise<unknown>): Promise<ActionResult>; retry(): void; readonly pending: boolean; readonly state: ActionState<V> }; readonly state: ActionState<V>; observe(value: V): void; sync(value: V): void }
export function pendingValue<V>(ctx: ComponentContext, o: { place: (el: HTMLElement) => void; busy: Element; apply: (value: V) => void; current: () => V }): PendingValue<V>;
export function validateValue(ctx: ComponentContext, value: unknown, o?: { required?: boolean; min?: number; max?: number; step?: number | 'any'; minLength?: number; maxLength?: number; pattern?: string | RegExp; patternMessage?: string; validate?: (v: any) => string | null | undefined }): string | null;
export interface Virtualizer { readonly range: { start: number; end: number }; readonly count: number; total(): number; offsetOf(i: number): number; setCount(n: number): void; measure(index: number, height: number): boolean; scrollToIndex(index: number, align?: 'auto' | 'start' | 'end' | 'center'): void; update(): void; destroy(): void }
export function createVirtualizer(o: { scroller: HTMLElement; list?: HTMLElement; count?: number; estimate?: number; overscan?: number; /** Since 2.5.0: px at the top covered by sticky headers; scrollToIndex keeps items clear of it. */ inset?: () => number; onRange?: (r: { start: number; end: number; top: number; bottom: number }) => void }): Virtualizer;
/** Since 2.5.0: the link itself, or null for javascript:, vbscript: and data: URLs (and empty ones); the check every link built from props uses. */
export function safeHref(href: unknown): string | null;
export function reconcileChildren(parent: Element, nodes: Element[]): void;
