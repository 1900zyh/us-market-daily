import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export class ReportStore {
  constructor(directory) { this.directory = directory; }
  async read(date) {
    if (!DATE.test(date)) return null;
    try { return JSON.parse(await readFile(path.join(this.directory, `${date}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  async list() {
    let files;
    try { files = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const reports = await Promise.all(files.filter(file => DATE.test(file.replace(/\.json$/, '')) && file.endsWith('.json')).sort().reverse().map(file => this.read(file.slice(0, 10))));
    return reports.filter(Boolean).map(report => ({ date: report.reportDate, generatedAt: report.generatedAt, sessionDate: report.sessionDate, status: report.status, moverCount: report.movers?.length || 0, eventCount: report.events?.length || 0 }));
  }
  async latest() { const reports = await this.list(); return reports.length ? this.read(reports[0].date) : null; }
  async save(report) {
    if (!DATE.test(report.reportDate)) throw new Error('无效日报日期');
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `${report.reportDate}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(report, null, 2), 'utf8');
    await rename(temporary, file);
  }
}
