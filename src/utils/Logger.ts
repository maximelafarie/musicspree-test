import winston from "winston";
import path from "path";

export class Logger {
  private static instance: winston.Logger;

  public static getInstance(): winston.Logger {
    if (!Logger.instance) {
      Logger.instance = Logger.createLogger();
    }
    return Logger.instance;
  }

  private static createLogger(): winston.Logger {
    // Get log level from environment, default to 'info'
    const logLevel = process.env.LOG_LEVEL?.toLowerCase() || "info";
    const logToFile = process.env.LOG_TO_FILE !== "false";

    const transports: winston.transport[] = [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize({ all: true }),
          winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            let metaStr = "";
            if (Object.keys(meta).length > 0) {
              metaStr = " " + JSON.stringify(meta, null, 2);
            }
            return `${timestamp} [${level}]: ${message}${metaStr}`;
          })
        ),
      }),
    ];

    // Add file transport if enabled
    if (logToFile) {
      const logDir =
        process.env.NODE_ENV === "production" ? "/app/data" : "./data";
      const logFile = path.join(logDir, "musicspree.log");

      transports.push(
        new winston.transports.File({
          filename: logFile,
          format: winston.format.combine(
            winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
            winston.format.json()
          ),
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 5,
        })
      );
    }

    return winston.createLogger({
      level: logLevel,
      transports,
      handleExceptions: true,
      handleRejections: true,
      exitOnError: false,
    });
  }

  // Utility method to reconfigure logger if needed
  public static reconfigure(options: {
    level?: string;
    logToFile?: boolean;
  }): void {
    if (Logger.instance) {
      if (options.level) {
        Logger.instance.level = options.level;
      }
      // For more complex reconfigurations, recreate the instance
      Logger.instance = Logger.createLogger();
    }
  }
}
