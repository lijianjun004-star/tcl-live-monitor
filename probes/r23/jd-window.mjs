/**
 * R2.3 JD Beijing-time sampling windows. GitHub Actions cron runs in UTC.
 * Schedule expression: minute 0,5,10,15,30,45,55 of every hour.
 * At least 5-minute sampling near whole-hour boundaries, 15 minutes between.
 * GH hosted scheduling is best-effort and is not a strict real-time SLA.
 */
export const CRON='0,5,10,15,30,45,55 * * * *';
const tz='Asia/Shanghai';
export function beijingClock(instant){
 const d=instant instanceof Date?instant:new Date(instant);
 if(!Number.isFinite(d.getTime()))throw Error('INVALID_TIME');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{
  timeZone:tz,hour12:false,hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit',
  year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
 return {hour:parts.hour%24,minute:parts.minute,second:parts.second};
}
export function isOperatingTime(instant){
 const {hour,minute}=beijingClock(instant),x=hour*60+minute;
 // TCL working window: 06:30 Beijing until next-day 02:00 inclusive
 return x>=390||x<=120;
}
export function plannedSample(instant){
 const {hour,minute}=beijingClock(instant);
 const slot=[0,5,10,15,30,45,55].includes(minute);
 const critical=[55,0,5,10].includes(minute);
 const reason=!isOperatingTime(instant)?'OUTSIDE_WORKING_WINDOW':
  !slot?'NOT_A_PLANNED_MINUTE':'DUE';
 return {scheduled_minute:minute,beijing_hour:hour,
  is_due:isOperatingTime(instant)&&slot,critical,reason,
  cron:CRON,nominal_minute_gap:critical?5:15,
  monitor_coverage:'TCL_JD_INTERNAL_ROOMS_ONLY'};
}
