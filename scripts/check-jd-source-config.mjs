import { checkJdSourceConfiguration } from '../probes/lib/jd-source-config.mjs';

const report = checkJdSourceConfiguration({
  configured: process.env.TCL_OPS_BASE_URL,
  approved: process.env.JD_APPROVED_SOURCE_ORIGIN,
  legacy: process.env.JD_LEGACY_SOURCE_ORIGIN,
});
console.log(JSON.stringify(report));
if (report.status !== 'CONFIG_MATCH') process.exitCode = 2;
