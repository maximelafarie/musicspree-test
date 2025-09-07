import dotenv from "dotenv";
import cron from "node-cron";
import { MusicSpree } from "./core/MusicSpree";
import { Logger } from "./utils/Logger";
import { Config } from "./config/Config";

// Load environment variables
dotenv.config();

async function main() {
  const logger = Logger.getInstance();
  const config = Config.getInstance();

  logger.info("🎵 MusicSpree starting up...");

  try {
    const musicSpree = new MusicSpree();

    // Validate configuration
    logger.info("🔍 Validating configuration and connections...");
    await musicSpree.validateConfig();
    logger.info("✅ All connections validated successfully");

    logger.info(`📅 Scheduling cron job: ${config.cronSchedule}`);

    // Schedule the main task
    cron.schedule(
      config.cronSchedule,
      async () => {
        logger.info("🔄 Starting scheduled music sync...");
        try {
          const result = await musicSpree.syncRecommendations();
          logger.info("✅ Scheduled sync completed successfully", {
            totalRecommendations: result.totalRecommendations,
            newDownloads: result.newDownloads,
            addedToPlaylist: result.addedToPlaylist,
            errors: result.errors.length,
          });
        } catch (error) {
          logger.error("❌ Scheduled sync failed:", error);
        }
      },
      {
        scheduled: true,
        timezone: process.env.TZ || "UTC",
      }
    );

    // Run once on startup if not in production or if explicitly requested
    const shouldRunOnStartup =
      process.env.RUN_ON_STARTUP !== "false" &&
      process.env.NODE_ENV !== "production";

    if (shouldRunOnStartup) {
      logger.info("🚀 Running initial sync...");
      try {
        const result = await musicSpree.syncRecommendations();
        logger.info("✅ Initial sync completed", {
          totalRecommendations: result.totalRecommendations,
          newDownloads: result.newDownloads,
          addedToPlaylist: result.addedToPlaylist,
        });
      } catch (error) {
        logger.warn("⚠️ Initial sync failed (will retry on schedule):", error);
      }
    }

    logger.info("🎶 MusicSpree is running! Use CLI commands to interact.");
    logger.info(
      `📋 Next scheduled sync: ${getNextCronTime(config.cronSchedule)}`
    );

    // Keep the process alive and handle graceful shutdown
    const shutdown = (signal: string) => {
      logger.info(`📴 Received ${signal}, shutting down gracefully...`);
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      logger.error("💥 Uncaught exception:", error);
      process.exit(1);
    });

    process.on("unhandledRejection", (reason, promise) => {
      logger.error(
        "💥 Unhandled promise rejection at:",
        promise,
        "reason:",
        reason
      );
      process.exit(1);
    });
  } catch (error) {
    logger.error("💥 Failed to start MusicSpree:", error);
    process.exit(1);
  }
}

function getNextCronTime(cronExpression: string): string {
  try {
    // Simple next run calculation for common cron patterns
    const now = new Date();

    // Parse basic patterns like "0 */6 * * *" (every 6 hours)
    const parts = cronExpression.split(" ");
    if (parts.length >= 5) {
      const hourPattern = parts[1];

      if (hourPattern.includes("*/")) {
        const interval = parseInt(hourPattern.split("*/")[1]);
        const nextHour = Math.ceil(now.getHours() / interval) * interval;
        const nextRun = new Date(now);
        nextRun.setHours(nextHour, 0, 0, 0);

        if (nextRun <= now) {
          nextRun.setDate(nextRun.getDate() + 1);
        }

        return nextRun.toISOString();
      }
    }

    return "Next scheduled run (pattern not parsed)";
  } catch (error) {
    return "Unable to calculate next run time";
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error("💥 Fatal error:", error);
    process.exit(1);
  });
}
