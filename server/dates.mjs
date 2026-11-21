/** NYSE regular-session dates; all clock comparisons use explicit time zones. */
export function dateInZone(value = new Date(), timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

export function shiftDate(isoDate, days) {
  const value = new Date(`${isoDate}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + (weekday - first.getUTCDay() + 7) % 7 + (nth - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  last.setUTCDate(last.getUTCDate() - (last.getUTCDay() - weekday + 7) % 7);
  return last.toISOString().slice(0, 10);
}

function observed(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 6 ? shiftDate(date, -1) : day === 0 ? shiftDate(date, 1) : date;
}

function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31);
  return `${year}-${String(month).padStart(2, '0')}-${String((h + l - 7 * m + 114) % 31 + 1).padStart(2, '0')}`;
}

export function holidays(year) {
  const dates = [
    // NYSE does not observe a Saturday New Year's Day on the previous Friday.
    new Date(`${year}-01-01T12:00:00Z`).getUTCDay() === 6 ? `${year}-01-01` : observed(`${year}-01-01`),
    nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), shiftDate(easter(year), -2),
    lastWeekday(year, 5, 1), observed(`${year}-07-04`), nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4), observed(`${year}-12-25`),
  ];
  if (year >= 2022) dates.push(observed(`${year}-06-19`));
  return new Set(dates);
}

export function isTradingDay(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6 && !holidays(Number(date.slice(0, 4))).has(date);
}

export function isEarlyClose(date) {
  const year = Number(date.slice(0, 4));
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  return date === shiftDate(thanksgiving, 1) || (date === `${year}-12-24` && isTradingDay(date)) || (date === `${year}-07-03` && isTradingDay(date));
}

/** Convert an actual New York wall-clock value using Intl's DST rules. */
export function nyTimeToUtc(date, hour = 16, minute = 0) {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset', hour: '2-digit' }).formatToParts(guess);
  const offset = parts.find(part => part.type === 'timeZoneName').value.match(/GMT([+-])(\d{2}):(\d{2})/);
  const minutes = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1);
  return new Date(guess.getTime() - minutes * 60000);
}

export function sessionCloseUtc(date) { return nyTimeToUtc(date, isEarlyClose(date) ? 13 : 16); }

export function tradingDateAt(now = new Date()) {
  let date = dateInZone(now, 'America/New_York');
  if (!isTradingDay(date) || now < sessionCloseUtc(date)) date = shiftDate(date, -1);
  for (let i = 0; i < 14; i++, date = shiftDate(date, -1)) if (isTradingDay(date)) return date;
  throw new Error('无法确定最近已收盘交易日');
}

export function nextReportTime(now = new Date()) {
  let date = dateInZone(now);
  let next = new Date(`${date}T20:00:00+08:00`);
  if (next <= now) next = new Date(`${shiftDate(date, 1)}T20:00:00+08:00`);
  return next.toISOString();
}

export function marketSessionAt(now = new Date()) {
  const date = dateInZone(now, 'America/New_York');
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const sessionOpen = nyTimeToUtc(date, 9, 30), sessionClose = sessionCloseUtc(date);
  const preOpen = nyTimeToUtc(date, 4), postClose = nyTimeToUtc(date, isEarlyClose(date) ? 17 : 20);
  let nextDate = shiftDate(date, 1);
  while (!isTradingDay(nextDate)) nextDate = shiftDate(nextDate, 1);
  const common = { date, timeZone: 'America/New_York', earlyClose: isTradingDay(date) && isEarlyClose(date), regularOpenAt: isTradingDay(date) ? sessionOpen.toISOString() : null, regularCloseAt: isTradingDay(date) ? sessionClose.toISOString() : null, nextOpenAt: (isTradingDay(date) && now < sessionOpen ? sessionOpen : nyTimeToUtc(nextDate, 9, 30)).toISOString(), note: '按 NYSE 常规日历计算，不含临时停市' };
  if (!isTradingDay(date)) return { ...common, status: weekday === 0 || weekday === 6 ? 'weekend' : 'holiday', nextTransitionAt: nyTimeToUtc(nextDate, 4).toISOString() };
  if (now < preOpen) return { ...common, status: 'closed', nextTransitionAt: preOpen.toISOString() };
  if (now < sessionOpen) return { ...common, status: 'pre', nextTransitionAt: sessionOpen.toISOString() };
  if (now < sessionClose) return { ...common, status: 'open', nextTransitionAt: sessionClose.toISOString() };
  if (now < postClose) return { ...common, status: 'post', nextTransitionAt: postClose.toISOString() };
  return { ...common, status: 'closed', nextTransitionAt: nyTimeToUtc(nextDate, 4).toISOString() };
}
