// Built-in strings for the P1 entry, added to a services catalogue on first use (keeps the P0 catalogue small).
// Apps override or add locales with services.i18n.add(locale, messages) as for P0 (D30).
const EN = {
  'stepper.step': 'Step {n} of {count}', 'stepper.done': 'completed', 'stepper.current': 'current step', 'stepper.error': 'needs attention', 'stepper.optional': 'Optional',
  'log.newLines': (p, pl) => (pl(p.count) === 'one' ? '1 new line' : `${p.count} new lines`), 'log.pause': 'Pause', 'log.resume': 'Resume', 'log.paused': 'Paused', 'log.empty': 'No lines yet', 'log.debug': 'DEBUG', 'log.info': 'INFO', 'log.warn': 'WARN', 'log.error': 'ERROR',
  'chart.data': 'Data table', 'chart.hideData': 'Hide data table', 'chart.keys': 'Use the arrow keys to read each point',
  'chart.keysSelect': 'Use the arrow keys to read each point and Enter to select it', 'chart.keysZoom': 'Plus and minus zoom in and out, 0 shows everything',
  'chart.reset': 'Reset zoom', 'chart.showing': 'Showing {from} to {to}', 'chart.empty': 'No data', 'chart.total': 'Total', 'chart.band': '{lo} to {hi}',
  'chart.selected': 'Selected: {label}', 'chart.selectedMark': 'Selected', 'avatar.more': (p, pl) => (pl(p.count) === 'one' ? '1 more' : `${p.count} more`),
  'slider.min': 'Minimum', 'slider.max': 'Maximum', 'slider.unknown': 'Not set', 'time.hours': 'Hours', 'time.minutes': 'Minutes', 'time.seconds': 'Seconds', 'time.period': 'AM/PM',
  'color.hue': 'Hue', 'color.saturation': 'Saturation and brightness', 'color.hex': 'Hex', 'color.swatches': 'Swatches', 'color.red': 'Red', 'color.green': 'Green', 'color.blue': 'Blue', 'color.none': 'Not set',
  'upload.cancel': 'Cancel upload of {name}', 'upload.retry': 'Retry {name}', 'upload.remove': 'Remove {name}', 'upload.done': 'Uploaded', 'upload.failed': 'Upload failed', 'upload.queued': 'Waiting', 'upload.summary': '{done} of {total} uploaded',
  'tags.remove': 'Remove {label}', 'tags.add': 'Add', 'palette.label': 'Command palette', 'palette.placeholder': 'Type a command or search', 'palette.empty': 'No matching commands',
  'shortcuts.title': 'Keyboard shortcuts', 'shortcuts.then': 'then', 'toggletip.label': 'More information', 'split.more': 'More options', 'copy': 'Copy', 'copied': 'Copied', 'loading': 'Loading…', 'code.label': 'Code',
  'result.back': 'Back', 'media.previous': 'Previous', 'media.next': 'Next', 'media.counter': '{n} of {count}', 'pane.resize': 'Resize panes',
  'cell.edit': 'Edit {column}', 'cell.save': 'Save', 'cell.cancel': 'Cancel',
  'otp.char': 'Character {n} of {count}', 'rating.stars': (p, pl) => (pl(p.n) === 'one' ? '1 star' : `${p.n} stars`), 'rating.rated': 'Rated {value} out of {max}',
  'chips.count': (p, pl) => (pl(p.count) === 'one' ? '1 result' : `${p.count} results`), 'datetime.date': 'Date', 'datetime.time': 'Time',
  'datetime.range': 'Choose a date and time in the allowed range',
  'mediaCard.play': 'Play {title}', 'mediaCard.pause': 'Pause {title}', 'mediaCard.more': 'More options for {title}',
};
const ZH = {
  'stepper.step': '第 {n} 步，共 {count} 步', 'stepper.done': '已完成', 'stepper.current': '当前步骤', 'stepper.error': '需要处理', 'stepper.optional': '可选',
  'log.newLines': p => `${p.count} 条新日志`, 'log.pause': '暂停', 'log.resume': '继续', 'log.paused': '已暂停', 'log.empty': '暂无日志', 'log.debug': '调试', 'log.info': '信息', 'log.warn': '警告', 'log.error': '错误',
  'chart.data': '数据表', 'chart.hideData': '隐藏数据表', 'chart.keys': '使用方向键逐点读取数值',
  'chart.keysSelect': '使用方向键逐点读取数值，按回车键选择', 'chart.keysZoom': '加号和减号放大缩小，0 显示全部',
  'chart.reset': '重置缩放', 'chart.showing': '显示 {from} 至 {to}', 'chart.empty': '暂无数据', 'chart.total': '合计', 'chart.band': '{lo} 至 {hi}',
  'chart.selected': '已选择：{label}', 'chart.selectedMark': '已选择', 'avatar.more': p => `另外 ${p.count} 人`,
  'slider.min': '最小值', 'slider.max': '最大值', 'time.hours': '时', 'time.minutes': '分', 'time.seconds': '秒', 'time.period': '上午/下午',
  'color.hue': '色相', 'color.saturation': '饱和度与亮度', 'color.hex': '十六进制', 'color.swatches': '色板', 'color.red': '红', 'color.green': '绿', 'color.blue': '蓝', 'color.none': '未设置',
  'upload.cancel': '取消上传 {name}', 'upload.retry': '重试 {name}', 'upload.remove': '移除 {name}', 'upload.done': '已上传', 'upload.failed': '上传失败', 'upload.queued': '等待中', 'upload.summary': '已上传 {done} / {total}',
  'tags.remove': '移除 {label}', 'tags.add': '添加', 'palette.label': '命令面板', 'palette.placeholder': '输入命令或搜索', 'palette.empty': '没有匹配的命令',
  'shortcuts.title': '键盘快捷键', 'shortcuts.then': '然后', 'toggletip.label': '更多信息', 'split.more': '更多选项', 'copy': '复制', 'copied': '已复制', 'loading': '加载中…', 'code.label': '代码',
  'result.back': '返回', 'media.previous': '上一项', 'media.next': '下一项', 'media.counter': '第 {n} 项，共 {count} 项', 'pane.resize': '调整窗格大小',
  'cell.edit': '编辑{column}', 'cell.save': '保存', 'cell.cancel': '取消',
  'otp.char': '第 {n} 位，共 {count} 位', 'rating.stars': p => `${p.n} 星`, 'rating.rated': '评分 {value}，满分 {max}',
  'chips.count': p => `${p.count} 项`, 'datetime.date': '日期', 'datetime.time': '时间', 'datetime.range': '请选择允许范围内的日期和时间',
  'slider.unknown': '未设置', 'mediaCard.play': '播放“{title}”', 'mediaCard.pause': '暂停“{title}”', 'mediaCard.more': '“{title}”的更多选项',
};
const done = new WeakSet();
/** Adds the P1 strings to these services once; app-supplied strings with the same keys win. */
export function plusStrings(s) {
  if (done.has(s)) return s;
  done.add(s);
  s.i18n.defaults('en', EN); s.i18n.defaults('zh-CN', ZH);
  return s;
}
