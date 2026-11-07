// A POSIX TZ string such as "MEZ-1MESZ,M3.5.0,M10.5.0/3": the UTC offset it
// gives at a time, in minutes east of UTC, as glibc's localtime would.

const NAME = /^(?:[A-Za-z]{3,}|<[^>]+>)/;
const OFFSET = /^[+-]?\d{1,3}(?::\d{1,2}(?::\d{1,2})?)?/;
const TIME = new RegExp(OFFSET.source + "$");

function seconds(s: string): number {
  const sign = s[0] === "-" ? -1 : 1;
  const [h, m = "0", sec = "0"] = s.replace(/^[+-]/, "").split(":");
  return sign * (Number(h) * 3600 + Number(m) * 60 + Number(sec));
}

// Seconds from the start of the year (local wall clock) to a rule's day and time
function ruleSeconds(rule: string, year: number): number | null {
  const [day, time = "2"] = rule.split("/");
  if (!TIME.test(time)) return null;
  const at = seconds(time);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  let m = /^M(\d+)\.(\d)\.(\d)$/.exec(day);
  if (m) {
    const [month, week, weekday] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (month < 1 || month > 12 || week < 1 || week > 5 || weekday > 6) return null;
    const first = Date.UTC(year, month - 1, 1);
    let d = (weekday - new Date(first).getUTCDay() + 7) % 7 + (week - 1) * 7;
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    while (d >= length) d -= 7;
    return (first + d * 86400000 - Date.UTC(year, 0, 1)) / 1000 + at;
  }
  m = /^J(\d+)$/.exec(day);
  if (m) {
    const n = Number(m[1]);
    if (n < 1 || n > 365) return null;
    return (n - 1 + (leap && n >= 60 ? 1 : 0)) * 86400 + at;
  }
  m = /^(\d+)$/.exec(day);
  return m && Number(m[1]) <= 365 ? Number(m[1]) * 86400 + at : null;
}

export function posixOffsetMinutes(tz: string, nowMs: number): number | null {
  let rest = tz;
  const std = NAME.exec(rest);
  if (!std) return null;
  rest = rest.slice(std[0].length);
  const stdOff = OFFSET.exec(rest);
  if (!stdOff) return null;
  rest = rest.slice(stdOff[0].length);
  const stdEast = -seconds(stdOff[0]);
  if (!rest) return stdEast / 60;
  const dst = NAME.exec(rest);
  if (!dst) return null;
  rest = rest.slice(dst[0].length);
  const dstOff = OFFSET.exec(rest);
  const dstEast = dstOff ? -seconds(dstOff[0]) : stdEast + 3600;
  if (dstOff) rest = rest.slice(dstOff[0].length);
  // glibc's default rules, the US ones, apply without a rule part
  const [startRule, endRule] = rest.startsWith(",") ? rest.slice(1).split(",") : ["M3.2.0", "M11.1.0"];
  if (!endRule) return null;
  const year = new Date(nowMs + stdEast * 1000).getUTCFullYear();
  const start = ruleSeconds(startRule, year), end = ruleSeconds(endRule, year);
  if (start === null || end === null) return null;
  const yearStart = Date.UTC(year, 0, 1) / 1000;
  // the start is in standard time, the end in daylight time
  const now = nowMs / 1000;
  const from = yearStart + start - stdEast, to = yearStart + end - dstEast;
  const inDst = from < to ? now >= from && now < to : now >= from || now < to;
  return (inDst ? dstEast : stdEast) / 60;
}
