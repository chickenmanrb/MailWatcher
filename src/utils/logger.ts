import fs from 'node:fs/promises';
import path from 'node:path';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: any;
  duration?: number;
}

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel;
  private logFile?: string;
  private buffer: LogEntry[] = [];
  private metrics: Map<string, { count: number; totalDuration: number }> = new Map();

  private constructor() {
    this.logLevel = this.parseLogLevel(process.env.LOG_LEVEL || 'INFO');
    this.logFile = process.env.LOG_FILE;
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private parseLogLevel(level: string): LogLevel {
    switch (level.toUpperCase()) {
      case 'DEBUG': return LogLevel.DEBUG;
      case 'INFO': return LogLevel.INFO;
      case 'WARN': return LogLevel.WARN;
      case 'ERROR': return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  private formatLevel(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return 'DEBUG';
      case LogLevel.INFO: return 'INFO';
      case LogLevel.WARN: return 'WARN';
      case LogLevel.ERROR: return 'ERROR';
    }
  }

  private async writeToFile(entry: LogEntry) {
    if (!this.logFile) return;
    
    try {
      const line = JSON.stringify(entry) + '\n';
      await fs.appendFile(this.logFile, line);
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  private log(level: LogLevel, module: string, message: string, data?: any, duration?: number) {
    if (level < this.logLevel) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      data,
      duration,
    };

    this.buffer.push(entry);
    
    const levelStr = this.formatLevel(level);
    const prefix = `[${entry.timestamp}] [${levelStr}] [${module}]`;
    const durationStr = duration ? ` (${duration}ms)` : '';
    
    const output = `${prefix} ${message}${durationStr}`;
    
    if (level === LogLevel.ERROR) {
      console.error(output, data || '');
    } else if (level === LogLevel.WARN) {
      console.warn(output, data || '');
    } else {
      console.log(output, data || '');
    }

    this.writeToFile(entry);
  }

  debug(module: string, message: string, data?: any) {
    this.log(LogLevel.DEBUG, module, message, data);
  }

  info(module: string, message: string, data?: any) {
    this.log(LogLevel.INFO, module, message, data);
  }

  warn(module: string, message: string, data?: any) {
    this.log(LogLevel.WARN, module, message, data);
  }

  error(module: string, message: string, data?: any) {
    this.log(LogLevel.ERROR, module, message, data);
  }

  time(module: string, operation: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.log(LogLevel.INFO, module, `${operation} completed`, undefined, duration);
      
      const key = `${module}:${operation}`;
      const metric = this.metrics.get(key) || { count: 0, totalDuration: 0 };
      metric.count++;
      metric.totalDuration += duration;
      this.metrics.set(key, metric);
    };
  }

  getMetrics(): Record<string, { count: number; avgDuration: number }> {
    const result: Record<string, { count: number; avgDuration: number }> = {};
    for (const [key, metric] of this.metrics) {
      result[key] = {
        count: metric.count,
        avgDuration: Math.round(metric.totalDuration / metric.count),
      };
    }
    return result;
  }

  async flush(outputDir?: string) {
    if (!outputDir) return;
    
    const reportPath = path.join(outputDir, 'automation-report.json');
    const report = {
      entries: this.buffer,
      metrics: this.getMetrics(),
      summary: {
        totalEntries: this.buffer.length,
        errors: this.buffer.filter(e => e.level === LogLevel.ERROR).length,
        warnings: this.buffer.filter(e => e.level === LogLevel.WARN).length,
      },
    };
    
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  }
}

export const logger = Logger.getInstance();