// Types for @creeperux/gui/media (2.5.0, G68): the player layer.
import type { Services, Handle, MenuItem, Placement, TableHandle } from '../ui/index.js';
import type { ImageSource, ViewHandle } from '../plus/index.js';

/** The media icon pack (G60), by name: transport, modes, library and output icons. */
export const MEDIA_ICONS: Readonly<Record<string, string>>;
/** Adds the media icon pack to the shared icon registry. Media components call it themselves; call it before using the icons in your own buttons. */
export function registerMediaIcons(): void;
/** Adds the media layer's strings to these services once; app-supplied strings with the same keys win. */
export function mediaStrings(services: Services): Services;

export interface Track { id: string | number; title: string; artist?: string; album?: string; /** Seconds. */ duration?: number | null; /** Its number on the album; defaults to the position in the list. */ number?: number; artwork?: ImageSource | (() => Promise<string | null | undefined>); added?: Date | number | string; liked?: boolean | null; explicit?: boolean; unavailable?: boolean; reason?: string; disabled?: boolean }

// ---------------------------------------------------------------- playback
export interface SeekBarProps { /** Seconds. */ position?: number; duration?: number | null; buffered?: number | null; seekable?: boolean; live?: boolean; label?: string; disabled?: boolean; valueTextInterval?: number; onSeekStart?: (e: { position: number }) => void; onSeekPreview?: (e: { position: number }) => void; onSeek?: (e: { position: number }) => void; onSeekCancel?: (e: { position: number }) => void }
export function createSeekBar(container: HTMLElement, props?: SeekBarProps, services?: Services): Handle<SeekBarProps> & { readonly slider: Handle<unknown>; readonly dragging: boolean };
export interface VolumeControlProps { /** 0–1. */ volume?: number; muted?: boolean; label?: string; disabled?: boolean; onVolume?: (e: { volume: number; final: boolean }) => void; onMuteChange?: (e: { muted: boolean }) => void }
export function createVolumeControl(container: HTMLElement, props?: VolumeControlProps, services?: Services): ViewHandle<VolumeControlProps> & { readonly slider: Handle<unknown> };
export type PlaybackState = 'playing' | 'paused' | 'stopped' | 'loading' | 'error';
export type PlaybackCommand = 'play' | 'pause' | 'retry' | 'previous' | 'next' | 'shuffle' | 'repeat' | 'like' | 'seek-start' | 'seek-preview' | 'seek' | 'seek-cancel' | 'volume' | 'mute' | 'open' | 'action';
export interface PlaybackAction { id: string; icon: string; label: string; /** A toggle when boolean (aria-pressed). */ pressed?: boolean; disabled?: boolean }
export interface PlaybackBarProps {
  track?: Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'artwork'> | null; state?: PlaybackState; error?: string;
  position?: number; duration?: number | null; buffered?: number | null; seekable?: boolean; live?: boolean;
  canPrevious?: boolean; canNext?: boolean; /** null hides the control. */ shuffle?: boolean | null; repeat?: 'off' | 'all' | 'one' | null; liked?: boolean | null;
  /** 0–1; null hides the volume control. */ volume?: number | null; muted?: boolean; actions?: PlaybackAction[];
  onCommand?: (e: { command: PlaybackCommand; value?: any; id?: string; event?: Event }) => void;
}
export interface PlaybackBarHandle extends ViewHandle<PlaybackBarProps> { readonly seekBar: ReturnType<typeof createSeekBar>; readonly volume: ReturnType<typeof createVolumeControl> }
export function createPlaybackBar(container: HTMLElement, props?: PlaybackBarProps, services?: Services): PlaybackBarHandle;

// ---------------------------------------------------------------- lists
export type TrackColumn = 'index' | 'title' | 'artist' | 'album' | 'added' | 'like' | 'duration';
export interface TrackListProps<T extends Track = Track> {
  tracks: T[]; label?: string; columns?: TrackColumn[]; current?: T['id'] | null; playing?: boolean;
  selectable?: false | 'multiple' | 'single'; selected?: Array<T['id']>; onSelectionChange?: (e: { selected: Array<T['id']> }) => void;
  sort?: { id: string; direction: 'asc' | 'desc' } | null; sortMode?: 'client' | 'host'; onSortChange?: (e: { id: string; direction: 'asc' | 'desc' }) => void; sortable?: boolean;
  /** 'auto' renders only the rows in view over 150 tracks. */ virtual?: 'auto' | false | { height?: string }; /** The scrolling height; '100%' fills a container that has a height. Default '32rem'. */ height?: string;
  groupBy?: (track: T) => unknown; groupLabel?: (key: any, tracks: T[]) => Node | string;
  reorderable?: boolean; onReorder?: (e: { keys: Array<T['id']>; before: T['id'] | null; index: number; order: Array<T['id']>; rows: T[]; tracks: T[] }) => void;
  menu?: (track: T) => MenuItem[]; onMenu?: (e: { item: MenuItem; track: T }) => void;
  onPlay?: (e: { track: T; id: T['id']; via: 'double-click' | 'keyboard' | 'button' | 'click' }) => void; onPause?: (e: { track: T; id: T['id'] }) => void;
  onLike?: (e: { track: T; id: T['id']; liked: boolean }) => void;
  loading?: boolean; error?: string | boolean | null; onRetry?: () => void; empty?: { title?: string; message?: string }; status?: boolean;
  /** The table's stacked layout below 40 rem ('auto', the default), always or never. */ stacked?: 'auto' | boolean;
  /** Rows glide to their new place after every tracks update and new rows fade in (D81); a confirmed reorder glides anyway. */ animateRows?: boolean;
}
export interface TrackListHandle<T extends Track = Track> extends Handle<TrackListProps<T>> { /** The data table it is built on. */ readonly table: TableHandle<T>; readonly selected: Array<T['id']>; focusTrack(id: T['id']): void; scrollToTrack(id: T['id']): void }
export function createTrackList<T extends Track = Track>(container: HTMLElement, props: TrackListProps<T>, services?: Services): TrackListHandle<T>;
export interface QueueListProps<T extends Track & { section?: string } = Track & { section?: string }> {
  current?: T | null; tracks: T[]; /** Section labels by id; 'queue' defaults to "Next in queue". */ sections?: Record<string, string>; playing?: boolean; label?: string;
  onPlay?: (e: { track: T; id: T['id'] }) => void; onReorder?: (e: { keys: Array<T['id']>; before: T['id'] | null; index: number; order: Array<T['id']>; section: string }) => void;
  onRemove?: (e: { ids: Array<T['id']> }) => void; onClear?: (e: { section: string }) => void; /** Sections with a Clear button. Default ['queue']. */ clearable?: string[];
  menu?: (track: T) => MenuItem[]; onMenu?: (e: { item: MenuItem; track: T }) => void; loading?: boolean; error?: string | boolean | null; onRetry?: () => void;
}
export function createQueueList<T extends Track & { section?: string } = Track & { section?: string }>(container: HTMLElement, props: QueueListProps<T>, services?: Services): Handle<QueueListProps<T>> & { readonly list: TrackListHandle<T> };

// ---------------------------------------------------------------- panels
export interface NowPlayingProps { track?: Pick<Track, 'title' | 'artist' | 'album' | 'artwork'> | null; liked?: boolean | null; playing?: boolean; label?: string; level?: 1 | 2 | 3 | 4 | 5 | 6; onLike?: (e: { liked: boolean }) => void; onOpen?: (e: { part: 'track' | 'artist' | 'album' }) => void }
export function createNowPlaying(container: HTMLElement, props?: NowPlayingProps, services?: Services): ViewHandle<NowPlayingProps> & { readonly body: HTMLElement; readonly image: { readonly root: HTMLElement; readonly state: string } };
export interface LyricsLine { /** Seconds; omit for unsynced lyrics. */ time?: number; text: string }
export interface LyricsViewProps { lines?: LyricsLine[] | null; synced?: boolean; position?: number; state?: 'ready' | 'loading' | 'empty' | 'error'; follow?: boolean; /** ms without manual scrolling before following resumes; null waits for "Back to the current line". */ resumeAfter?: number | null; label?: string; height?: string; onSeek?: (e: { time: number; index: number }) => void; onRetry?: () => void }
export function createLyricsView(container: HTMLElement, props?: LyricsViewProps, services?: Services): ViewHandle<LyricsViewProps> & { readonly following: boolean; readonly active: number; follow(): void };
export interface OutputDevice { id: string; name: string; kind?: 'computer' | 'speaker' | 'headphones' | string; state?: 'connected' | 'available' | 'connecting' | 'unavailable' | 'error'; detail?: string }
export interface DevicePickerProps { devices: OutputDevice[]; current?: string | null; label?: string; placement?: Placement; onSelect?: (e: { id: string; device: OutputDevice }) => void }
export function createDevicePicker(container: HTMLElement, props: DevicePickerProps, services?: Services): ViewHandle<DevicePickerProps> & { readonly button: HTMLButtonElement; open(): void; close(): void };
