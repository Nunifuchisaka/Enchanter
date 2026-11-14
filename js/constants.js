'use strict';

// Enchanter: 定数(状態・重要度などの表示名、時間の単位)

/* ---------- constants ---------- */

// 旧バージョン(localStorage保存)からの移行用キー
const LEGACY_STORAGE_KEY = 'enchanter-data-v1';
const MIGRATED_FLAG_KEY = 'enchanter-data-v1-migrated';

// プロジェクトのデフォルト色。ライト/ダーク両サーフェスで
// 色覚特性・コントラストの検証を通した8色(固定順で割り当て)
const PALETTE = [
  '#3987e5', '#199e70', '#c98500', '#008300',
  '#9085e9', '#e66767', '#d55181', '#d95926',
];

const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const MINUTES_PER_DAY = 1440;
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 計測中がこの時間を超えたら「止め忘れ」の警告を出す
const LONG_TIMER_WARNING_MS = 8 * MS_PER_HOUR;

// タスクの状態。状態切替ボタンとカンバンの矢印キーはこの順で移動する
const TASK_STATUS_ORDER = ['todo', 'in_progress', 'waiting_review', 'done'];
const TASK_STATUS_LABELS = {
  todo: '未着手',
  in_progress: '作業中',
  waiting_review: '作業済み(確認待ち)',
  done: '完了',
};
// 状態を示す記号(予定の一覧・ガントのツールチップで共用)
const TASK_STATUS_ICONS = { in_progress: '▶', waiting_review: '⏳', done: '✔' };

// 重要度・重さは0〜3の段階値。表示名だけが違うので同じ仕組みで扱う
const LEVEL_FIELDS = {
  importance: { labels: ['指定なし', '低', '中', '高'], formLabel: '重要度', chipLabel: '重要度' },
  weight: { labels: ['指定なし', '軽い', 'ふつう', '重い'], formLabel: '重さ', chipLabel: '重さ' },
};

const REPEAT_LABELS = { daily: '毎日', weekly: '毎週', monthly: '毎月' };

// Todoタブの分類エリア。配置(列と並び順)はdata.todoLayoutに保存し、無い・壊れているときはこの既定に戻す
const TODO_GROUP_KEYS = ['today', 'limited', 'upcoming', 'recurring'];
const DEFAULT_TODO_LAYOUT = [['today', 'limited'], ['upcoming', 'recurring']];
