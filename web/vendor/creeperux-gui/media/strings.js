// Built-in strings for the media layer (2.5.0, G68), added to a services catalogue on first use, as plusStrings does.
// Apps override them or add locales with services.i18n.add(locale, messages).
const EN = {
  'player.play': 'Play', 'player.pause': 'Pause', 'player.previous': 'Previous', 'player.next': 'Next', 'player.retry': 'Try again',
  'player.shuffle': 'Shuffle', 'player.shuffleOn': 'Shuffle on', 'player.shuffleOff': 'Shuffle off',
  'player.repeat.off': 'Repeat: off', 'player.repeat.all': 'Repeat: all', 'player.repeat.one': 'Repeat: one track',
  'player.like': 'Like', 'player.liked': 'Liked', 'player.unliked': 'Removed from liked',
  'player.position': 'Playback position', 'player.positionText': '{elapsed} of {total}', 'player.live': 'Live', 'player.unknownTime': '--:--',
  'player.volume': 'Volume', 'player.mute': 'Mute', 'player.mutedText': '{volume}, muted',
  'player.loading': 'Loading…', 'player.error': "Couldn't play this track", 'player.nothing': 'Nothing playing', 'player.more': 'More player controls',
  'player.controls': 'Player controls',
  'tracks.number': '#', 'tracks.title': 'Title', 'tracks.artist': 'Artist', 'tracks.album': 'Album', 'tracks.added': 'Date added', 'tracks.duration': 'Duration',
  'tracks.play': 'Play {title}', 'tracks.like': 'Like {title}', 'tracks.playing': 'Playing', 'tracks.paused': 'Paused', 'tracks.explicit': 'Explicit',
  'tracks.unavailable': 'Unavailable', 'tracks.empty': 'No tracks', 'tracks.label': 'Tracks',
  'queue.label': 'Queue', 'queue.now': 'Now playing', 'queue.next': 'Next in queue', 'queue.clear': 'Clear queue', 'queue.remove': 'Remove from queue',
  'queue.removeSelected': 'Remove', 'queue.empty': 'Your queue is empty', 'queue.emptyMessage': 'Add tracks to play them next.',
  'queue.removed': (p, pl) => (pl(p.count) === 'one' ? 'Removed 1 track from the queue' : `Removed ${p.count} tracks from the queue`),
  'lyrics.label': 'Lyrics', 'lyrics.follow': 'Back to the current line', 'lyrics.empty': 'No lyrics for this track', 'lyrics.loading': 'Loading lyrics…',
  'lyrics.error': "Couldn't load the lyrics", 'lyrics.unsynced': "These lyrics aren't synced to the track.",
  'devices.label': 'Connect to a device', 'devices.title': 'Play on', 'devices.current': 'Current device', 'devices.connecting': 'Connecting…',
  'devices.unavailable': 'Unavailable', 'devices.error': "Couldn't connect", 'devices.empty': 'No other devices found',
};
const ZH = {
  'player.play': '播放', 'player.pause': '暂停', 'player.previous': '上一首', 'player.next': '下一首', 'player.retry': '重试',
  'player.shuffle': '随机播放', 'player.shuffleOn': '随机播放已开启', 'player.shuffleOff': '随机播放已关闭',
  'player.repeat.off': '循环：关闭', 'player.repeat.all': '循环：列表', 'player.repeat.one': '循环：单曲',
  'player.like': '喜欢', 'player.liked': '已添加到喜欢', 'player.unliked': '已从喜欢中移除',
  'player.position': '播放进度', 'player.positionText': '{elapsed}，共 {total}', 'player.live': '直播', 'player.unknownTime': '--:--',
  'player.volume': '音量', 'player.mute': '静音', 'player.mutedText': '{volume}，已静音',
  'player.loading': '加载中…', 'player.error': '无法播放这首曲目', 'player.nothing': '未在播放', 'player.more': '更多播放控制',
  'player.controls': '播放控制',
  'tracks.number': '#', 'tracks.title': '标题', 'tracks.artist': '艺人', 'tracks.album': '专辑', 'tracks.added': '添加日期', 'tracks.duration': '时长',
  'tracks.play': '播放“{title}”', 'tracks.like': '喜欢“{title}”', 'tracks.playing': '正在播放', 'tracks.paused': '已暂停', 'tracks.explicit': '含不雅内容',
  'tracks.unavailable': '不可用', 'tracks.empty': '没有曲目', 'tracks.label': '曲目',
  'queue.label': '播放队列', 'queue.now': '正在播放', 'queue.next': '队列中的下一首', 'queue.clear': '清空队列', 'queue.remove': '从队列中移除',
  'queue.removeSelected': '移除', 'queue.empty': '播放队列为空', 'queue.emptyMessage': '添加曲目即可接着播放。',
  'queue.removed': p => `已从队列中移除 ${p.count} 首曲目`,
  'lyrics.label': '歌词', 'lyrics.follow': '回到当前歌词', 'lyrics.empty': '这首曲目没有歌词', 'lyrics.loading': '正在加载歌词…',
  'lyrics.error': '无法加载歌词', 'lyrics.unsynced': '这些歌词未与曲目同步。',
  'devices.label': '连接到设备', 'devices.title': '播放设备', 'devices.current': '当前设备', 'devices.connecting': '正在连接…',
  'devices.unavailable': '不可用', 'devices.error': '无法连接', 'devices.empty': '没有找到其他设备',
};
const done = new WeakSet();
/** Adds the media layer's strings to these services once; app-supplied strings with the same keys win. */
export function mediaStrings(s) {
  if (done.has(s)) return s;
  done.add(s);
  s.i18n.defaults('en', EN); s.i18n.defaults('zh-CN', ZH);
  return s;
}
