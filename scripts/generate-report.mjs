import { createApp } from '../server.mjs';

const app = await createApp({ autoRefresh: false, scheduled: false });
await app.refresh('scheduled-cli');
if (app.llm.status().configured && app.llm.status().enabled) await app.analyzeSnapshot();
const report = app.getSnapshot();
console.log(JSON.stringify({ reportDate: report.reportDate, sessionDate: report.sessionDate, generatedAt: report.generatedAt, status: report.status, indices: report.indices.length, movers: report.movers.length, aiMovers: report.aiMovers?.length || 0, events: report.events.length, llm: report.llm?.status || 'unconfigured', warnings: report.warnings }, null, 2));
if (report.status === 'unavailable' || report.status === 'stale') process.exitCode = 1;
