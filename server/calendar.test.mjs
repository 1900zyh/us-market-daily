import test from 'node:test';
import assert from 'node:assert/strict';
import {zonedISO,beijingDate,parseBea,parseCensus,parseBlsICS,parseFed,regularNyseHolidays,exchangeEvents,getUpcomingEvents} from './calendar.mjs';

test('economic release timestamps respect US daylight saving and Beijing date rollover',()=>{
  assert.equal(zonedISO(2026,11,25,8,30),'2026-11-25T13:30:00.000Z');
  assert.equal(zonedISO(2026,7,15,8,30),'2026-07-15T12:30:00.000Z');
  assert.equal(beijingDate(zonedISO(2026,12,9,14,0)),'2026-12-10');
});
test('BEA uses table year rather than data reference period and classifies PCE',()=>{
  const html='<table><thead><tr><th>Year 2026</th></tr></thead><tbody><tr><td><div class="release-date">November 25</div><small>8:30 AM</small></td><td>N</td><td class="release-title views-field">Personal Income and Outlays, October 2026</td></tr></tbody></table>';
  const [event]=parseBea(html);
  assert.equal(event.date,'2026-11-25');assert.equal(event.time,'2026-11-25T13:30:00.000Z');assert.equal(event.importance,'high');assert.match(event.title,/PCE/);
});
test('Census parses complete release date, not covered data month',()=>{
  const html='<table><tr><td><a>New Residential Sales</a></td><td sorttable_customkey="202611251000">November 25, 2026</td><td>10:00 AM</td><td>October 2026</td><td>A202611251000</td></tr></table>';
  const [event]=parseCensus(html,'https://www.census.gov/economic-indicators/calendar-listview-2026.html');
  assert.equal(event.date,'2026-11-25');assert.equal(event.time,'2026-11-25T15:00:00.000Z');assert.equal(event.period,'October 2026');
});
test('BLS ICS handles US-Eastern alias, escaped summary and line folding',()=>{
  const ics='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;TZID=US-Eastern:20261204T083000\r\nSUMMARY:Employment Situation for November \\n\r\n 2026\r\nEND:VEVENT\r\nEND:VCALENDAR';
  const [event]=parseBlsICS(ics);
  assert.equal(event.time,'2026-12-04T13:30:00.000Z');assert.equal(event.importance,'high');
});
test('Fed preserves unknown announcement time instead of inventing it',()=>{
  const html='<div class="panel-heading"><h4>2026 FOMC Meetings</h4></div><div class="fomc-meeting__month"><strong>December</strong></div><div class="fomc-meeting__date">8-9*</div><div class="panel-heading"><h4>2025 FOMC Meetings</h4></div>';
  const [event]=parseFed(html);
  assert.equal(event.date,'2026-12-09');assert.equal(event.time,null);assert.equal(event.dateTimezone,'America/New_York');
  const crossMonth='<div>2026 FOMC Meetings<div class="fomc-meeting__month"><strong>Apr/May</strong></div><div class="fomc-meeting__date">30-1</div>';
  assert.equal(parseFed(crossMonth).length,0);
});
test('NYSE handles Good Friday, Thanksgiving, early close and Saturday New Year exception',()=>{
  const holidays=regularNyseHolidays(2026);
  assert.ok(holidays.some(([d])=>d==='2026-04-03'));assert.ok(holidays.some(([d])=>d==='2026-11-26'));
  assert.ok(!regularNyseHolidays(2022).some(([d])=>d==='2021-12-31'));
  const early=exchangeEvents(2026).find(e=>e.id==='nyse-early-2026-11-27');
  assert.equal(early.time,'2026-11-27T18:00:00.000Z');assert.equal(early.date,'2026-11-28');
});
test('network failures remain explicit and seven-day result never invents macro data',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('fixture offline');};
  try {
    const report=await getUpcomingEvents({now:new Date('2026-11-20T12:00:00Z')});
    assert.equal(report.events.filter(e=>e.category==='macro'||e.category==='fed').length,0);
    assert.ok(report.errors.length>=4);
    assert.ok(report.events.some(e=>e.id==='nyse-closed-2026-11-26'));
    assert.ok(!report.events.some(e=>e.id==='nyse-early-2026-11-27'));
  } finally {globalThis.fetch=original;}
});
