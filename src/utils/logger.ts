/**
 * Structured logger for The Matchmaker
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Module = 'observer' | 'extractor' | 'matcher' | 'publisher' | 'api' | 'db' | 'main' | 'learning-store' | 'reflector' | 'consolidator' | 'principle-loader';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: Module;
  event: string;
  data?: Record<string, unknown>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private minLevel: LogLevel = 'info';
  private module: Module;

  constructor(module: Module) {
    this.module = module;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      event,
      ...(data && { data }),
    };

    const output = JSON.stringify(entry);

    switch (level) {
      case 'error':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log('debug', event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.log('info', event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.log('warn', event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.log('error', event, data);
  }
}

export function createLogger(module: Module): Logger {
  return new Logger(module);
}

// Global log level setter
let globalLogLevel: LogLevel = 'info';
const loggers: Logger[] = [];

export function setGlobalLogLevel(level: LogLevel): void {
  globalLogLevel = level;
  loggers.forEach((l) => l.setLevel(level));
}

export function registerLogger(logger: Logger): void {
  logger.setLevel(globalLogLevel);
  loggers.push(logger);
}
