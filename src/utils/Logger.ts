import winston from "winston";
import { Config } from "../config/Config";

export class Logger {
  private static instance: winston.Logger;

  public static getInstance(): winston.Logger {
    if (!Logger.instance) {
      const config = Config.getInstance();

      const transports: winston.transport[] = [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
            winston.format.printf(({ timestamp, level, message, ...rest }) => {
              const restStr =
                Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
              return `${timestamp} [${level}]: ${message}${restStr}`;
            })
          ),
        }),
      ];

      if (config.logToFile) {
        transports.push(
          new winston.transports.File({
            filename: "/app/data/musicspree.log",
            format: winston.format.combine(
              winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
              winston.format.json()
            ),
          })
        );
      }

      Logger.instance = winston.createLogger({
        level: config.logLevel,
        transports,
      });
    }

    return Logger.instance;
  }
}
