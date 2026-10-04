/** 极简结构化日志：W1 只求可读 + 可 grep，不引入日志库 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function emit(level: string, message: string, meta?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] ${level} ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    console.log(line, JSON.stringify(meta));
  } else {
    console.log(line);
  }
}

export const consoleLogger: Logger = {
  info: (m, meta) => emit('INFO ', m, meta),
  warn: (m, meta) => emit('WARN ', m, meta),
  error: (m, meta) => emit('ERROR', m, meta),
};

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
