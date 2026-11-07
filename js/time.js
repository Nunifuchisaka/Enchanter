'use strict';

// Enchanter: 日付・時刻ヘルパー

/* ---------- date / time helpers ---------- */

// 数値を2桁の文字列にする(1桁なら先頭に0)
function pad2(value) {
  return String(value).padStart(2, '0');
}

// Date → "YYYY-MM-DD"(ローカル時刻。toISOString はUTCになるので使わない)
function toDateStr(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayStr() {
  return toDateStr(new Date());
}

// "YYYY-MM-DD" → ローカル時刻0時の Date
function fromDateStr(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(dateStr, days) {
  const date = fromDateStr(dateStr);
  date.setDate(date.getDate() + days);
  return toDateStr(date);
}

// 月曜始まりの週の開始日(0時)
function startOfWeek(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  return start;
}

// "2026-10-08" → "2026年10月8日(木)"
function fmtDateJa(dateStr) {
  const date = fromDateStr(dateStr);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${WEEKDAY_LABELS[date.getDay()]})`;
}

// "M/D"(年が違う場合のみ "YYYY/M/D")
function fmtShortDate(dateStr) {
  const date = fromDateStr(dateStr);
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `${date.getFullYear()}/`;
  return `${year}${date.getMonth() + 1}/${date.getDate()}`;
}

// タイムスタンプ → "HH:MM"
function fmtTime(timestamp) {
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// 0時からの分数 → "HH:MM"(範囲外は0時〜23:59に丸める)
function minutesToTime(minuteOfDay) {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 1, minuteOfDay));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

// "HH:MM" → タイムスタンプ(dayStart基準)
function timeToTimestamp(dayStart, hhmm) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return dayStart + hours * MS_PER_HOUR + minutes * MS_PER_MINUTE;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

// 経過時間 → "1:23:45"
function fmtClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
}

// 合計時間 → "3時間25分" / "45分"
function fmtDur(ms) {
  const totalMin = Math.round(ms / MS_PER_MINUTE);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours === 0) return `${minutes}分`;
  return `${hours}時間${minutes}分`;
}

// 作業記録の終了時刻。計測中(end が null)は現在時刻とみなす
function entryEnd(entry, now) {
  return entry.end === null ? now : entry.end;
}

function entryDur(entry, now) {
  return entryEnd(entry, now) - entry.start;
}

// 作業記録と期間[rangeStart, rangeEnd)の重なり時間(ms)。重ならなければ0以下
function overlapMs(entry, rangeStart, rangeEnd, now) {
  return Math.min(entryEnd(entry, now), rangeEnd) - Math.max(entry.start, rangeStart);
}

// 集計期間の開始・終了(ms)。開始日0時から終了日の翌0時まで(終了は含まない)
function reportRangeMs(fromStr, toStr) {
  return {
    start: fromDateStr(fromStr).getTime(),
    end: fromDateStr(toStr).getTime() + MS_PER_DAY,
  };
}

function endOfMonthStr(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  return toDateStr(new Date(year, month, 0));
}
