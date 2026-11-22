// Message catalogue for every built-in string (D30). Components never contain user-facing literals: they call
// i18n.t(key, params). zh-CN and en ship with the kit; apps add or override locales with add().
// Messages are strings with {name} placeholders, or functions (params, plural) => string.

const EN = {
  close: 'Close', dismiss: 'Dismiss', more: 'More', retry: 'Retry', cancel: 'Cancel', clear: 'Clear', apply: 'Apply', undo: 'Undo', back: 'Back', 'md.backTo': 'Back to {label}', 'tree.empty': 'No items',
  'password.show': 'Show password',
  required: 'Required', optional: 'Optional', loading: 'Loading…', search: 'Search', noResults: 'No results', noOptions: 'No options',
  'action.pending': 'Saving…', 'action.confirmed': 'Saved', 'action.failed': "Couldn't save", 'action.unconfirmed': 'Sent, not yet confirmed', 'action.superseded': 'Replaced by a newer change',
  'empty.title': 'Nothing here yet', 'empty.filtered': 'No results for these filters', 'empty.clearFilters': 'Clear filters', 'error.load': "Couldn't load", 'error.network': "Couldn't reach the server. Check your connection and try again.",
  'empty.unavailable': 'Not available', 'empty.unavailableMessage': "This isn't available right now.", 'empty.noAccess': 'No access', 'empty.noAccessMessage': "You don't have permission to see this.",
  'empty.offline': "You're offline", 'empty.offlineMessage': 'Connect to the internet, then try again.', 'empty.unconfigured': 'Not set up yet', 'empty.setup': 'Set up',
  'empty.stale': 'Not up to date', 'empty.staleSince': 'Showing data from {time}.', 'empty.staleMessage': 'Showing the last data received.', 'empty.partial': "Some items couldn't load",
  'field.invalid': 'Enter a valid value', 'field.required': 'This field is required', 'field.min': 'Enter {min} or more', 'field.max': 'Enter {max} or less', 'field.step': 'Use steps of {step}', 'field.tooLong': 'Use {max} characters or fewer', 'field.tooShort': 'Use at least {min} characters', 'field.checking': 'Checking…', 'field.unshowable': "The saved value can't be shown exactly here",
  'field.readOnly': 'Read only',
  'number.increment': 'Increase', 'number.decrement': 'Decrease',
  'date.previousMonth': 'Previous month', 'date.nextMonth': 'Next month', 'date.today': 'Today', 'date.choose': 'Choose date', 'date.chooseRange': 'Choose date range', 'date.start': 'Start', 'date.end': 'End', 'date.invalid': 'Enter a date like {example}', 'date.selectedDay': '{date}, selected',
  'file.drop': 'Drop files here or browse', 'file.browse': 'Browse', 'file.hint': '{types} · up to {size}', 'file.tooLarge': 'Larger than {size}', 'file.wrongType': 'Not an accepted file type', 'file.tooMany': 'Choose at most {max} files', 'file.remove': 'Remove {name}',
  'combobox.results': (p, plural) => plural(p.count) === 'one' ? '1 result' : `${p.count} results`, 'combobox.more': 'Showing {shown} of {total}. Keep typing to narrow the list.',
  'select.placeholder': 'Choose…', 'select.search': 'Filter options', 'select.missing': 'Not one of the options', 'select.readOnly': 'Read only', 'combobox.selected': '{list} selected', 'combobox.remove': 'Remove {label}', 'combobox.create': 'Add “{query}”', 'tag.remove': 'Remove {label}',
  selected: (p, plural) => plural(p.count) === 'one' ? '1 selected' : `${p.count} selected`,
  'form.unsaved': (p, plural) => plural(p.count) === 'one' ? '1 unsaved change' : `${p.count} unsaved changes`, 'form.discard': 'Discard', 'form.save': 'Save', 'form.fixErrors': 'Fix the highlighted fields first',
  'nav.main': 'Main', 'nav.skip': 'Skip to content', 'nav.more': 'More', 'nav.badge': (p, plural) => plural(p.count) === 'one' ? '1 new' : `${p.count} new`, 'nav.attention': 'Needs attention',
  breadcrumb: 'Breadcrumb', 'breadcrumb.more': 'More levels',
  'pagination.label': 'Pagination', 'pagination.previous': 'Previous page', 'pagination.next': 'Next page', 'pagination.page': 'Page {page}', 'pagination.pageOf': 'Page {page} of {count}', 'pagination.perPage': 'Rows per page', 'pagination.range': '{from}–{to} of {total}',
  'toolbar.more': 'More actions', 'tabs.more': 'More tabs', 'link.external': '(opens in a new tab)', 'toast.region': 'Notifications', 'dialog.error': 'Something went wrong. Try again.', 'confirm.type': 'Type “{text}” to confirm',
  'table.selectAll': 'Select all rows', 'table.select': 'Select', 'table.selectRow': 'Select {name}', 'table.rowActions': 'Actions for {name}', 'table.actions': 'Actions', 'table.expand': 'Details for {name}', 'table.details': 'Details', 'table.resize': 'Resize {column}', 'table.columns': 'Columns', 'table.clearSelection': 'Clear selection', 'table.total': 'Total', 'card.select': 'Select {title}',
  'table.count': (p, plural) => (plural(p.count) === 'one' ? '1 row' : `${p.count} rows`), 'table.countOf': '{shown} of {total} rows',
  'table.current': 'Current', 'table.unavailable': 'Unavailable',
  'reorder.column': 'Reorder', 'reorder.handle': 'Move {name}', 'reorder.hint': 'Press Space to pick up, the arrow keys to move, Space to drop, Escape to cancel.',
  'reorder.grabbed': '{name} picked up, position {pos} of {count}', 'reorder.position': 'Position {pos} of {count}', 'reorder.dropped': '{name} moved to position {pos} of {count}',
  'reorder.cancelled': 'Move cancelled', 'reorder.items': (p, plural) => (plural(p.count) === 'one' ? '1 item' : `${p.count} items`),
  'workspace.start': 'Sidebar', 'workspace.end': 'Side panel', 'workspace.resize': 'Resize {label}',
  'metric.up': 'Up', 'metric.down': 'Down', 'metric.flat': 'No change', 'metric.updated': 'Updated {time}', 'metric.stale': 'Not updated since {time}',
  'timeline.done': 'done', 'timeline.current': 'in progress', 'timeline.failed': 'failed', 'timeline.pending': 'not started', copy: 'Copy', copied: 'Copied',
};
const ZH = {
  close: '关闭', dismiss: '关闭', more: '更多', retry: '重试', cancel: '取消', clear: '清除', apply: '应用', undo: '撤销', back: '返回', 'md.backTo': '返回“{label}”', 'tree.empty': '没有项目',
  'password.show': '显示密码',
  required: '必填', optional: '可选', loading: '加载中…', search: '搜索', noResults: '没有结果', noOptions: '没有选项',
  'action.pending': '正在保存…', 'action.confirmed': '已保存', 'action.failed': '保存失败', 'action.unconfirmed': '已发送，尚未确认', 'action.superseded': '已被更新的修改取代',
  'empty.title': '这里还没有内容', 'empty.filtered': '没有符合筛选条件的结果', 'empty.clearFilters': '清除筛选', 'error.load': '加载失败', 'error.network': '无法连接服务器。请检查网络后重试。',
  'empty.unavailable': '暂不可用', 'empty.unavailableMessage': '此内容当前无法使用。', 'empty.noAccess': '没有访问权限', 'empty.noAccessMessage': '你没有查看此内容的权限。',
  'empty.offline': '当前处于离线状态', 'empty.offlineMessage': '请连接网络后重试。', 'empty.unconfigured': '尚未设置', 'empty.setup': '去设置',
  'empty.stale': '内容可能不是最新的', 'empty.staleSince': '显示的是{time}的数据。', 'empty.staleMessage': '显示的是上次获取的数据。', 'empty.partial': '部分内容未能加载',
  'field.invalid': '请输入有效的值', 'field.required': '此项为必填', 'field.min': '请输入不小于 {min} 的值', 'field.max': '请输入不大于 {max} 的值', 'field.step': '请按 {step} 的步长输入', 'field.tooLong': '最多 {max} 个字符', 'field.tooShort': '至少 {min} 个字符', 'field.checking': '正在检查…', 'field.unshowable': '已保存的值无法在这里原样显示',
  'field.readOnly': '只读',
  'number.increment': '增加', 'number.decrement': '减少',
  'date.previousMonth': '上个月', 'date.nextMonth': '下个月', 'date.today': '今天', 'date.choose': '选择日期', 'date.chooseRange': '选择日期范围', 'date.start': '开始', 'date.end': '结束', 'date.invalid': '请输入类似 {example} 的日期', 'date.selectedDay': '{date}，已选择',
  'file.drop': '拖放文件到这里，或点击选择', 'file.browse': '选择文件', 'file.hint': '{types} · 不超过 {size}', 'file.tooLarge': '超过 {size}', 'file.wrongType': '不支持的文件类型', 'file.tooMany': '最多选择 {max} 个文件', 'file.remove': '移除 {name}',
  'combobox.results': p => `${p.count} 个结果`, 'combobox.more': '显示 {total} 项中的 {shown} 项，继续输入以缩小范围',
  'select.placeholder': '请选择…', 'select.search': '筛选选项', 'select.missing': '当前值不在选项中', 'select.readOnly': '只读', 'combobox.selected': '已选：{list}', 'combobox.remove': '移除 {label}', 'combobox.create': '添加“{query}”', 'tag.remove': '移除 {label}',
  selected: p => `已选 ${p.count} 项`, 'form.unsaved': p => `${p.count} 项未保存的修改`, 'form.discard': '放弃修改', 'form.save': '保存', 'form.fixErrors': '请先修正标出的字段',
  'nav.main': '主导航', 'nav.skip': '跳到主要内容', 'nav.more': '更多', 'nav.badge': p => `${p.count} 条新内容`, 'nav.attention': '需要处理',
  breadcrumb: '路径', 'breadcrumb.more': '更多层级',
  'pagination.label': '分页', 'pagination.previous': '上一页', 'pagination.next': '下一页', 'pagination.page': '第 {page} 页', 'pagination.pageOf': '第 {page} 页，共 {count} 页', 'pagination.perPage': '每页行数', 'pagination.range': '第 {from}–{to} 条，共 {total} 条',
  'toolbar.more': '更多操作', 'tabs.more': '更多标签页', 'link.external': '（在新标签页中打开）', 'toast.region': '通知', 'dialog.error': '出了点问题，请重试。', 'confirm.type': '输入“{text}”以确认',
  'table.selectAll': '选择所有行', 'table.select': '选择', 'table.selectRow': '选择 {name}', 'table.rowActions': '{name} 的操作', 'table.actions': '操作', 'table.expand': '{name} 的详情', 'table.details': '详情', 'table.resize': '调整“{column}”列宽', 'table.columns': '列', 'table.clearSelection': '取消选择', 'table.total': '合计', 'card.select': '选择“{title}”',
  'table.count': p => `${p.count} 行`, 'table.countOf': '第 {shown} / {total} 行',
  'table.current': '当前', 'table.unavailable': '不可用',
  'reorder.column': '排序', 'reorder.handle': '移动 {name}', 'reorder.hint': '按空格键拿起，方向键移动，空格键放下，Esc 键取消。',
  'reorder.grabbed': '已拿起 {name}，位置 {pos} / {count}', 'reorder.position': '位置 {pos} / {count}', 'reorder.dropped': '{name} 已移到位置 {pos} / {count}',
  'reorder.cancelled': '已取消移动', 'reorder.items': p => `${p.count} 项`,
  'workspace.start': '侧边栏', 'workspace.end': '侧面板', 'workspace.resize': '调整“{label}”宽度',
  'metric.up': '上升', 'metric.down': '下降', 'metric.flat': '持平', 'metric.updated': '{time}更新', 'metric.stale': '自{time}起未更新',
  'timeline.done': '已完成', 'timeline.current': '进行中', 'timeline.failed': '失败', 'timeline.pending': '未开始', copy: '复制', copied: '已复制',
};
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'yi', 'dv', 'ckb', 'sd', 'ug']);
export const dirOf = locale => (RTL.has(String(locale).toLowerCase().split('-')[0]) ? 'rtl' : 'ltr');

/** createI18n({ locale, messages }) — messages: { [locale]: { key: string | fn } } merged over the built-ins. */
export function createI18n({ locale = 'en', messages = {} } = {}) {
  const catalogs = new Map([['en', { ...EN }], ['zh-CN', { ...ZH }]]);
  const listeners = new Set();
  let current = locale, plural = new Intl.PluralRules(current);
  const add = (loc, msgs) => { catalogs.set(loc, { ...(catalogs.get(loc) || {}), ...msgs }); listeners.forEach(f => f(current)); };
  // Built-in strings of optional modules (e.g. @creeperux/gui/plus): fill only keys that the catalogue lacks, so app strings win.
  const defaults = (loc, msgs) => { catalogs.set(loc, { ...msgs, ...(catalogs.get(loc) || {}) }); };
  for (const [loc, msgs] of Object.entries(messages)) add(loc, msgs);
  // Resolution chain: exact locale → language → en.
  const chain = loc => [loc, loc.split('-')[0], loc.startsWith('zh') ? 'zh-CN' : null, 'en'].filter(Boolean);
  function t(key, params = {}) {
    for (const loc of chain(current)) {
      const msg = catalogs.get(loc)?.[key];
      if (msg == null) continue;
      if (typeof msg === 'function') return msg(params, n => plural.select(n));
      return msg.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    }
    return key;
  }
  return {
    t, add, defaults,
    has: key => chain(current).some(loc => catalogs.get(loc)?.[key] != null),
    get locale() { return current; },
    set locale(loc) { current = loc; plural = new Intl.PluralRules(loc); listeners.forEach(f => f(loc)); },
    get dir() { return dirOf(current); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
