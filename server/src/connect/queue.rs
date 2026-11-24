//! The session's queue: the Windows app's `src/Sonus.Core/PlayQueue.cs` as the protocol's reference has it
//! (`tools/demo-server/connect-session.mjs`, `PlayQueue`), line by line, plus the key of the song that plays. The
//! context in playback order with a pointer, and the songs queued by hand, which play first.
//!
//! Pure: what the library has and the random numbers come from the caller.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Value, json};

/// A song id. Shared, so a queue of 10,000 is cheap to copy (every change keeps the queue from before, to undo a
/// refused one and to see whether it changed).
pub type Id = Arc<str>;

/// The most songs a context holds, and the most queued by hand (connect.md, Queue).
pub const MAX_ORDER: usize = 10_000;
pub const MAX_MANUAL: usize = 1_000;

/// What the server knows of a song before the active device reports `loaded`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Song {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub cover_art: Option<String>,
    pub duration_ms: Option<i64>,
}

/// The library as the session's user sees it.
pub trait Library {
    fn has(&self, id: &str) -> bool;
    fn lookup(&self, id: &str) -> Option<Song>;
}

/// A source of random numbers: n → an integer in [0, n).
pub type Random<'a> = &'a mut dyn FnMut(usize) -> usize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Default,
    RepeatAll,
    RepeatOne,
    Random,
    ShuffleTracks,
    ShuffleAlbums,
    ShuffleFolders,
}

impl Mode {
    pub fn parse(name: &str) -> Option<Mode> {
        Some(match name {
            "default" => Mode::Default,
            "repeatAll" => Mode::RepeatAll,
            "repeatOne" => Mode::RepeatOne,
            "random" => Mode::Random,
            "shuffleTracks" => Mode::ShuffleTracks,
            "shuffleAlbums" => Mode::ShuffleAlbums,
            "shuffleFolders" => Mode::ShuffleFolders,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Default => "default",
            Mode::RepeatAll => "repeatAll",
            Mode::RepeatOne => "repeatOne",
            Mode::Random => "random",
            Mode::ShuffleTracks => "shuffleTracks",
            Mode::ShuffleAlbums => "shuffleAlbums",
            Mode::ShuffleFolders => "shuffleFolders",
        }
    }

    pub fn shuffled(self) -> bool {
        matches!(self, Mode::ShuffleTracks | Mode::ShuffleAlbums | Mode::ShuffleFolders)
    }

    /// The sender arranges the context (the server may not know albums and folders).
    pub fn arranged_by_sender(self) -> bool {
        matches!(self, Mode::ShuffleAlbums | Mode::ShuffleFolders)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Manual {
    pub key: String,
    pub track_id: Id,
}

/// What the queue panel lists: hand-queued songs first, then the rest of the context.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub key: String,
    pub track_id: Id,
    pub manual: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlayQueue {
    /// The context in playback order.
    pub context: Vec<Id>,
    /// The context in its own order, to come back to from shuffling.
    pub source: Vec<Id>,
    /// `context[pointer]` is the context's current song; -1 before any.
    pub pointer: i64,
    pub manual: Vec<Manual>,
    pub next_id: u64,
    pub current: Option<Id>,
    /// The entry the current song was when it became current (kept while the queue is rearranged).
    pub current_key: Option<String>,
    pub order: Mode,
    pub stop_after_current: bool,
}

impl Default for PlayQueue {
    fn default() -> Self {
        PlayQueue {
            context: Vec::new(),
            source: Vec::new(),
            pointer: -1,
            manual: Vec::new(),
            next_id: 0,
            current: None,
            current_key: None,
            order: Mode::Default,
            stop_after_current: false,
        }
    }
}

fn context_key(index: usize, id: &str) -> String {
    format!("c{index}:{id}")
}

impl PlayQueue {
    /// The index of the first context entry still to come.
    fn upcoming(&self) -> usize {
        ((self.pointer + 1).max(0) as usize).min(self.context.len())
    }

    pub fn entries(&self) -> Vec<Entry> {
        let from = self.upcoming();
        let manual = self.manual.iter().map(|m| Entry { key: m.key.clone(), track_id: m.track_id.clone(), manual: true });
        let context = self.context[from..].iter().enumerate().map(|(i, t)| Entry { key: context_key(from + i, t), track_id: t.clone(), manual: false });
        manual.chain(context).collect()
    }

    /// The keys of `entries`, without the entries.
    pub fn entry_keys(&self) -> HashSet<String> {
        let from = self.upcoming();
        self.manual.iter().map(|m| m.key.clone()).chain(self.context[from..].iter().enumerate().map(|(i, t)| context_key(from + i, t))).collect()
    }

    fn at(&mut self, pointer: usize) -> Option<Id> {
        let song = self.context.get(pointer)?.clone();
        self.pointer = pointer as i64;
        self.current_key = Some(context_key(pointer, &song));
        self.current = Some(song.clone());
        Some(song)
    }

    /// Plays from a context: from `start_id`, or its first song (a random one when shuffling). `arranged`: the context
    /// in the order the sender arranged it. None: no song (the queue may have changed: the caller undoes it).
    pub fn start(&mut self, ids: &[Id], start_id: Option<&str>, shuffle: bool, arranged: Option<&[Id]>, library: &dyn Library, random: Random) -> Option<Id> {
        if shuffle && !self.order.shuffled() {
            self.order = Mode::ShuffleTracks;
        }
        let known: Vec<Id> = ids.iter().filter(|id| library.has(id)).cloned().collect();
        if known.is_empty() {
            return None;
        }
        let known_set: HashSet<&str> = known.iter().map(|id| &**id).collect();
        // (an arranged context starts with its first song: the sender put the one to start with there)
        let start: Id = match start_id.and_then(|s| known.iter().find(|id| &***id == s)) {
            Some(id) => id.clone(),
            None => match arranged.and_then(|a| a.iter().find(|id| known_set.contains(&***id))) {
                Some(id) => id.clone(),
                None if self.order.shuffled() || self.order == Mode::Random => known[random(known.len()).min(known.len() - 1)].clone(),
                None => known[0].clone(),
            },
        };
        self.context = self.arrange(&known, self.order, Some(&start), arranged, library, random);
        self.source = known;
        let at = self.context.iter().position(|id| *id == start).unwrap_or(0);
        self.at(at)
    }

    /// The song that follows when the current one ends (what `next(true)` returns), without moving; None when that is
    /// not a different song known now (stop after current, repeat one, random).
    pub fn peek(&self) -> Option<Id> {
        if self.stop_after_current || self.order == Mode::RepeatOne {
            return None;
        }
        if let Some(first) = self.manual.first() {
            return Some(first.track_id.clone());
        }
        if self.order == Mode::Random {
            return None;
        }
        let next = (self.pointer + 1).max(0) as usize;
        if next < self.context.len() {
            return Some(self.context[next].clone());
        }
        if self.order == Mode::RepeatAll || self.order.shuffled() { self.context.first().cloned() } else { None }
    }

    /// Moves to the next song (hand-queued first). None: the end.
    pub fn next(&mut self, ended: bool, random: Random) -> Option<Id> {
        if ended && self.stop_after_current {
            self.stop_after_current = false;
            return None;
        }
        if ended && self.order == Mode::RepeatOne {
            return self.current.clone();
        }
        if !self.manual.is_empty() {
            let m = self.manual.remove(0);
            self.current = Some(m.track_id.clone());
            self.current_key = Some(m.key);
            return Some(m.track_id);
        }
        self.step(1, random)
    }

    /// The previous song in the context; while a hand-queued song plays, the context song that played before it.
    pub fn previous(&mut self, random: Random) -> Option<Id> {
        if let Some(current) = &self.current {
            if self.pointer >= 0 && (self.pointer as usize) < self.context.len() && self.context[self.pointer as usize] != *current {
                return self.at(self.pointer as usize);
            }
        }
        self.step(-1, random)
    }

    fn step(&mut self, dir: i64, random: Random) -> Option<Id> {
        let len = self.context.len() as i64;
        if len == 0 {
            return None;
        }
        let mut at = self.pointer + dir;
        if self.order == Mode::Random {
            at = (random(len as usize) as i64).min(len - 1);
        }
        if at >= len || at < 0 {
            if self.order == Mode::RepeatAll || self.order.shuffled() {
                at = if dir > 0 { 0 } else { len - 1 };
            } else {
                return None;
            }
        }
        self.at(at as usize)
    }

    pub fn set_order(&mut self, order: Mode, arranged: Option<&[Id]>, library: &dyn Library, random: Random) {
        let was = self.order;
        self.order = order;
        if !self.context.is_empty() && (order.shuffled() || was.shuffled()) {
            // back from shuffling: the context's own order, without the songs removed from the queue meanwhile
            let basis: Vec<Id> = if order.shuffled() {
                self.context.clone()
            } else {
                let in_context: HashSet<&str> = self.context.iter().map(|id| &**id).collect();
                let mut seen = HashSet::new();
                self.source.iter().filter(|id| in_context.contains(&***id) && seen.insert(&***id)).cloned().collect()
            };
            let current = self.current.clone();
            self.context = self.arrange(&basis, order, current.as_ref(), arranged, library, random);
            self.pointer = current.and_then(|c| self.context.iter().position(|id| *id == c)).unwrap_or(0) as i64;
        }
    }

    /// Queues by hand, at the end or first; at most `room` songs. Returns how many.
    pub fn add(&mut self, ids: &[Id], next: bool, room: usize, library: &dyn Library) -> usize {
        let mut added = Vec::new();
        for id in ids.iter().filter(|id| library.has(id)).take(room) {
            self.next_id += 1;
            added.push(Manual { key: format!("q{}", self.next_id), track_id: id.clone() });
        }
        let count = added.len();
        if next {
            added.append(&mut self.manual);
            self.manual = added;
        } else {
            self.manual.append(&mut added);
        }
        count
    }

    /// A drag in the queue panel: `order` is every entry key in the new order, `keys` the moved ones, now in
    /// `manual`'s section.
    pub fn move_entries(&mut self, order: &[Id], keys: &[Id], manual: bool) {
        let entries: std::collections::HashMap<String, Entry> = self.entries().into_iter().map(|e| (e.key.clone(), e)).collect();
        let moved: HashSet<&str> = keys.iter().map(|k| &**k).collect();
        let placed: Vec<Entry> = order
            .iter()
            .filter_map(|k| entries.get(&**k))
            .map(|e| if moved.contains(e.key.as_str()) { Entry { manual, ..e.clone() } } else { e.clone() })
            .collect();
        let mut queued = Vec::new();
        for e in placed.iter().filter(|e| e.manual) {
            if e.key.starts_with('q') {
                queued.push(Manual { key: e.key.clone(), track_id: e.track_id.clone() });
            } else {
                self.next_id += 1;
                queued.push(Manual { key: format!("q{}", self.next_id), track_id: e.track_id.clone() });
            }
        }
        self.manual = queued;
        self.context.truncate(self.upcoming());
        self.context.extend(placed.iter().filter(|e| !e.manual).map(|e| e.track_id.clone()));
    }

    pub fn remove(&mut self, entry_keys: &[Id]) {
        let keys: HashSet<&str> = entry_keys.iter().map(|k| &**k).collect();
        // a context entry is "c<index>:<song>": only removed while that index still holds that song and is still to come
        let indexes: HashSet<usize> = keys.iter().filter(|k| k.starts_with('c')).filter_map(|k| self.context_index(k)).collect();
        self.manual.retain(|m| !keys.contains(m.key.as_str()));
        let mut i = 0;
        self.context.retain(|_| {
            i += 1;
            !indexes.contains(&(i - 1))
        });
    }

    pub fn clear(&mut self, manual: bool) {
        if manual {
            self.manual.clear();
        } else {
            self.context.truncate(self.upcoming());
        }
    }

    /// The index a context key names, while that index still holds that song and is still to come.
    fn context_index(&self, key: &str) -> Option<usize> {
        let rest = key.strip_prefix('c')?;
        let colon = rest.find(':')?;
        let digits = &rest[..colon];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let i: usize = digits.parse().ok()?; // too large to be an index: no entry
        let song = &rest[colon + 1..];
        (i as i64 > self.pointer && i < self.context.len() && &*self.context[i] == song).then_some(i)
    }

    /// Jumps to a queue entry; returns its song, or None when there is no such entry (any more).
    pub fn jump(&mut self, key: &str) -> Option<Id> {
        if let Some(at) = self.manual.iter().position(|m| m.key == key) {
            let m = self.manual.remove(at);
            self.current = Some(m.track_id.clone());
            self.current_key = Some(m.key);
            return Some(m.track_id);
        }
        // exactly the key the entry has ("c05:x" is not the entry "c5:x")
        let i = self.context_index(key).filter(|i| context_key(*i, &self.context[*i]) == key)?;
        self.pointer = i as i64;
        self.current = Some(self.context[i].clone());
        self.current_key = Some(key.to_string());
        self.current.clone()
    }

    fn arrange(&self, ids: &[Id], order: Mode, start: Option<&Id>, arranged: Option<&[Id]>, library: &dyn Library, random: Random) -> Vec<Id> {
        match order {
            Mode::ShuffleTracks => {
                let mut rest: Vec<Id> = ids.iter().filter(|id| Some(*id) != start).cloned().collect();
                // Fisher–Yates from the end
                for i in (1..rest.len()).rev() {
                    let j = random(i + 1).min(i);
                    rest.swap(i, j);
                }
                match start {
                    Some(start) if ids.contains(start) => std::iter::once(start.clone()).chain(rest).collect(),
                    _ => rest,
                }
            }
            // albums and folders are what the sender knows: it sends the arranged context (checked by the caller)
            Mode::ShuffleAlbums | Mode::ShuffleFolders => arranged.unwrap_or(ids).iter().filter(|id| library.has(id)).take(MAX_ORDER).cloned().collect(),
            _ => ids.to_vec(),
        }
    }

    /// What is stored (the reference's `toJSON`).
    pub fn to_json(&self) -> Value {
        json!({
            "context": self.context.iter().map(|id| &**id).collect::<Vec<_>>(),
            "source": self.source.iter().map(|id| &**id).collect::<Vec<_>>(),
            "pointer": self.pointer,
            "manual": self.manual.iter().map(|m| json!({ "key": m.key, "trackId": &*m.track_id })).collect::<Vec<_>>(),
            "nextId": self.next_id,
            "current": self.current.as_deref(),
            "currentKey": self.current_key,
            "order": self.order.as_str(),
            "stopAfterCurrent": self.stop_after_current,
        })
    }

    /// A stored queue. None when it is not one this server could have written (then the session starts empty).
    pub fn from_json(saved: &Value) -> Option<PlayQueue> {
        let ids = |v: &Value| -> Option<Vec<Id>> { v.as_array()?.iter().map(|x| x.as_str().map(Id::from)).collect() };
        let context = ids(saved.get("context")?)?;
        let source = ids(saved.get("source")?)?;
        let pointer = saved.get("pointer")?.as_i64()?;
        let manual: Vec<Manual> = saved
            .get("manual")?
            .as_array()?
            .iter()
            .map(|m| Some(Manual { key: m.get("key")?.as_str()?.to_string(), track_id: Id::from(m.get("trackId")?.as_str()?) }))
            .collect::<Option<_>>()?;
        let text = |name: &str| -> Option<Option<String>> {
            match saved.get(name)? {
                Value::Null => Some(None),
                Value::String(s) => Some(Some(s.clone())),
                _ => None,
            }
        };
        let current = text("current")?.map(|s| Id::from(s.as_str()));
        let current_key = text("currentKey")?;
        let queue = PlayQueue {
            pointer,
            next_id: saved.get("nextId")?.as_u64()?,
            order: Mode::parse(saved.get("order")?.as_str()?)?,
            stop_after_current: saved.get("stopAfterCurrent")?.as_bool()?,
            context,
            source,
            manual,
            current,
            current_key,
        };
        let sane = queue.context.len() <= MAX_ORDER
            && queue.source.len() <= MAX_ORDER
            && queue.manual.len() <= MAX_MANUAL
            && queue.pointer >= -1
            && queue.pointer < queue.context.len().max(1) as i64
            && queue.current.is_some() == queue.current_key.is_some();
        sane.then_some(queue)
    }
}

/// At most `limit` songs of a context: a window of them in their own order that holds the start song (from 100
/// before it), or the first ones. Sending clients do the same, so a library-sized context stays within the limits.
pub fn window<'a>(ids: &'a [Id], start_id: Option<&str>, limit: usize) -> &'a [Id] {
    if ids.len() <= limit {
        return ids;
    }
    let from = match start_id.and_then(|s| ids.iter().position(|id| &**id == s)) {
        Some(at) => at.saturating_sub(100).min(ids.len() - limit),
        None => 0,
    };
    &ids[from..from + limit]
}
