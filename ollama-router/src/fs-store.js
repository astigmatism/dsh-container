import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

async function readJsonlTail(filePath, limit) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit);
    const rows = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Ignore corrupt log lines and keep serving healthy history.
      }
    }
    return rows;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export class JsonlStore {
  constructor(config) {
    this.config = config;
    this.requests = [];
    this.events = [];
  }

  async init() {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    this.requests = await readJsonlTail(this.config.requestLogPath, this.config.requestHistoryLimit);
    this.events = await readJsonlTail(this.config.eventLogPath, this.config.eventHistoryLimit);
  }

  async appendRequest(record) {
    this.requests.push(record);
    if (this.requests.length > this.config.requestHistoryLimit) {
      this.requests.splice(0, this.requests.length - this.config.requestHistoryLimit);
    }
    await fs.appendFile(this.config.requestLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async appendEvent(event) {
    const withDefaults = {
      id: event.id || randomUUID(),
      ts: event.ts || new Date().toISOString(),
      ...event
    };
    this.events.push(withDefaults);
    if (this.events.length > this.config.eventHistoryLimit) {
      this.events.splice(0, this.events.length - this.config.eventHistoryLimit);
    }
    await fs.appendFile(this.config.eventLogPath, `${JSON.stringify(withDefaults)}\n`, 'utf8');
    return withDefaults;
  }

  recentRequests(limit = this.config.requestHistoryLimit) {
    return this.requests.slice(-limit).reverse();
  }

  recentEvents(limit = this.config.eventHistoryLimit) {
    return this.events.slice(-limit).reverse();
  }

  paths() {
    return {
      dataDir: path.resolve(this.config.dataDir),
      requestLogPath: path.resolve(this.config.requestLogPath),
      eventLogPath: path.resolve(this.config.eventLogPath)
    };
  }
}
