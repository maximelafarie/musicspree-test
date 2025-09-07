#!/usr/bin/env node

import dotenv from "dotenv";
import { Command } from "commander";
import { MusicSpree } from "./core/MusicSpree";
import { Logger } from "./utils/Logger";
import { Config } from "./config/Config";
import { BeetsService } from "./services/BeetsService";

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name("musicspree-cli")
  .description(
    "MusicSpree CLI for managing music recommendations and playlists"
  )
  .version("1.0.0");

// Global error handler
const handleError = (error: any, operation: string) => {
  const logger = Logger.getInstance();
  logger.error(`❌ ${operation} failed:`, error);

  if (error.message) {
    console.error(`Error: ${error.message}`);
  }

  if (error.response?.status) {
    console.error(`HTTP Status: ${error.response.status}`);
  }

  process.exit(1);
};

// Global success handler
const logSuccess = (message: string, details?: any) => {
  console.log(`✅ ${message}`);
  if (details) {
    Object.entries(details).forEach(([key, value]) => {
      console.log(`   ${key}: ${value}`);
    });
  }
};

program
  .command("sync")
  .description("Run full sync process")
  .option("--force", "Force sync even if recently synced")
  .option(
    "--limit <number>",
    "Limit number of recommendations to process",
    "50"
  )
  .action(async (options) => {
    const logger = Logger.getInstance();

    try {
      logger.info("🎵 Starting full sync via CLI...");
      console.log("🎵 Starting full sync process...\n");

      const musicSpree = new MusicSpree();

      console.log("🔍 Validating connections...");
      await musicSpree.validateConfig();
      console.log("✅ All services connected\n");

      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit <= 0) {
        throw new Error("Invalid limit value. Must be a positive number.");
      }

      const result = await musicSpree.syncRecommendations(limit);

      console.log("📊 Sync Results:");
      logSuccess("Sync completed successfully", {
        "Total recommendations": result.totalRecommendations,
        "Already in library": result.alreadyInLibrary,
        "New downloads": result.newDownloads,
        "Failed downloads": result.failedDownloads,
        "Added to playlist": result.addedToPlaylist,
      });

      if (result.errors.length > 0) {
        console.log(`\n⚠️ Errors (${result.errors.length}):`);
        result.errors.slice(0, 5).forEach((error, index) => {
          console.log(`   ${index + 1}. ${error}`);
        });
        if (result.errors.length > 5) {
          console.log(`   ... and ${result.errors.length - 5} more errors`);
        }
      }

      logger.info("✅ Sync completed successfully");
    } catch (error) {
      handleError(error, "Sync");
    }
  });

program
  .command("dry")
  .description("Dry run - show what would be downloaded")
  .option("--limit <number>", "Limit number of recommendations to check", "50")
  .action(async (options) => {
    const logger = Logger.getInstance();

    try {
      logger.info("🏃‍♂️ Starting dry run via CLI...");
      console.log("🏃‍♂️ Starting dry run...\n");

      const musicSpree = new MusicSpree();

      console.log("🔍 Validating connections...");
      await musicSpree.validateConfig();
      console.log("✅ All services connected\n");

      const limit = parseInt(options.limit, 10);
      if (isNaN(limit) || limit <= 0) {
        throw new Error("Invalid limit value. Must be a positive number.");
      }

      const tracks = await musicSpree.dryRun(limit);

      if (tracks.length === 0) {
        console.log(
          "🎉 No new tracks to download! Your library is up to date."
        );
      } else {
        console.log(`📋 Would download ${tracks.length} tracks:\n`);
        tracks.forEach((track, index) => {
          const albumInfo = track.album ? ` (${track.album})` : "";
          console.log(
            `   ${(index + 1).toString().padStart(2)}. ${track.artist} - ${
              track.title
            }${albumInfo}`
          );
        });
      }
    } catch (error) {
      handleError(error, "Dry run");
    }
  });

program
  .command("clear")
  .description("Clear/delete the current playlist")
  .option("-f, --force", "Force deletion without confirmation")
  .action(async (options) => {
    const logger = Logger.getInstance();
    const config = Config.getInstance();

    try {
      logger.info("🗑️ Clearing playlist via CLI...");

      const musicSpree = new MusicSpree();
      await musicSpree.validateConfig();

      if (!options.force) {
        // In a real CLI, you'd use readline for input
        console.log(
          `⚠️ This will delete the playlist: "${config.playlistName}"`
        );
        console.log("Use --force flag to skip this confirmation");
        return;
      }

      await musicSpree.clearPlaylist();
      logSuccess(`Playlist "${config.playlistName}" cleared successfully`);
    } catch (error) {
      handleError(error, "Clear playlist");
    }
  });

program
  .command("status")
  .description("Show service status and configuration")
  .action(async () => {
    const logger = Logger.getInstance();
    const config = Config.getInstance();

    try {
      console.log("📊 MusicSpree Status\n");

      const musicSpree = new MusicSpree();

      console.log("🔍 Testing connections...");

      try {
        await musicSpree.validateConfig();
        console.log("✅ All services are connected and responding\n");
      } catch (error) {
        console.log(
          `❌ Service connection issues: ${
            error instanceof Error ? error.message : error
          }\n`
        );
      }

      // Show current configuration (sanitized)
      const sanitizedConfig = config.getSanitizedConfig();

      console.log("⚙️ Configuration:");
      console.log(`   Playlist: ${sanitizedConfig.playlist.name}`);
      console.log(`   Cron: ${sanitizedConfig.schedule}`);
      console.log(
        `   Clean on refresh: ${sanitizedConfig.playlist.cleanOnRefresh}`
      );
      console.log(
        `   Keep downloaded tracks: ${sanitizedConfig.playlist.keepDownloaded}`
      );
      console.log(`   Max retries: ${sanitizedConfig.download.maxRetries}`);
      console.log(
        `   Timeout: ${sanitizedConfig.download.timeoutMinutes} minutes`
      );
      console.log(
        `   Concurrent downloads: ${sanitizedConfig.download.concurrent}`
      );
      console.log(`   Log level: ${sanitizedConfig.logging.level}`);
      console.log(`   Dry run mode: ${sanitizedConfig.dryRun ? "ON" : "OFF"}`);

      console.log("\n🌐 Service URLs:");
      console.log(`   LastFM User: ${sanitizedConfig.lastfm.username}`);
      console.log(`   Navidrome: ${sanitizedConfig.navidrome.url}`);
      console.log(`   Slskd: ${sanitizedConfig.slskd.url}`);
      console.log(`   Beets: ${sanitizedConfig.beets.url}`);
    } catch (error) {
      handleError(error, "Status check");
    }
  });

program
  .command("test")
  .description("Test all service connections")
  .action(async () => {
    const logger = Logger.getInstance();

    try {
      console.log("🧪 Testing service connections...\n");

      const musicSpree = new MusicSpree();

      // Test each service individually for better feedback
      console.log("Testing LastFM...");
      try {
        await musicSpree["lastfmService"].testConnection();
        console.log("✅ LastFM connection successful");
      } catch (error) {
        console.log(
          `❌ LastFM connection failed: ${
            error instanceof Error ? error.message : error
          }`
        );
      }

      console.log("Testing Navidrome...");
      try {
        await musicSpree["navidromeService"].testConnection();
        console.log("✅ Navidrome connection successful");
      } catch (error) {
        console.log(
          `❌ Navidrome connection failed: ${
            error instanceof Error ? error.message : error
          }`
        );
      }

      console.log("Testing Slskd...");
      try {
        await musicSpree["slskdService"].testConnection();
        console.log("✅ Slskd connection successful");
      } catch (error) {
        console.log(
          `❌ Slskd connection failed: ${
            error instanceof Error ? error.message : error
          }`
        );
      }

      console.log("Testing Beets...");
      try {
        await musicSpree["beetsService"].testConnection();
        console.log("✅ Beets connection successful");
      } catch (error) {
        console.log(
          `⚠️ Beets connection failed (optional): ${
            error instanceof Error ? error.message : error
          }`
        );
      }

      console.log("\n🎉 Connection test completed!");
    } catch (error) {
      handleError(error, "Connection test");
    }
  });

program
  .command("stats")
  .description("Show library statistics")
  .action(async () => {
    const logger = Logger.getInstance();

    try {
      console.log("📊 Library Statistics\n");

      const beetsService = new BeetsService();

      try {
        await beetsService.testConnection();
        const stats = await beetsService.getLibraryStats();

        if (Object.keys(stats).length > 0) {
          console.log("📚 Beets Library:");
          Object.entries(stats).forEach(([key, value]) => {
            const displayKey = key
              .replace(/_/g, " ")
              .replace(/\b\w/g, (l) => l.toUpperCase());
            console.log(`   ${displayKey}: ${value}`);
          });
        } else {
          console.log("📚 No library statistics available");
        }
      } catch (error) {
        console.log("⚠️ Could not fetch library statistics from Beets");
        console.log(
          `   Error: ${error instanceof Error ? error.message : error}`
        );
      }
    } catch (error) {
      handleError(error, "Statistics");
    }
  });

program
  .command("import")
  .description("Manually trigger beets import")
  .option("--path <path>", "Specific path to import", "/downloads")
  .action(async (options) => {
    const logger = Logger.getInstance();

    try {
      console.log(`🏷️ Importing tracks from: ${options.path}`);

      const beetsService = new BeetsService();
      await beetsService.testConnection();
      await beetsService.importNewTracks(options.path);

      logSuccess("Import completed successfully");
    } catch (error) {
      handleError(error, "Import");
    }
  });

program
  .command("cleanup")
  .description("Cleanup empty directories")
  .action(async () => {
    const logger = Logger.getInstance();

    try {
      console.log("🧹 Cleaning up empty directories...");

      const beetsService = new BeetsService();
      await beetsService.cleanupEmptyDirectories();

      logSuccess("Cleanup completed successfully");
    } catch (error) {
      handleError(error, "Cleanup");
    }
  });

// Add config validation command
program
  .command("validate")
  .description("Validate configuration without running sync")
  .action(async () => {
    try {
      console.log("🔍 Validating configuration...\n");

      const config = Config.getInstance();
      console.log("✅ Configuration loaded successfully");

      const musicSpree = new MusicSpree();
      await musicSpree.validateConfig();

      console.log("✅ All service connections validated");
      console.log(
        "\n🎉 Configuration is valid and all services are reachable!"
      );
    } catch (error) {
      handleError(error, "Configuration validation");
    }
  });

// Add logs command for better log viewing
program
  .command("logs")
  .description("Show recent logs")
  .option("--tail <lines>", "Number of lines to show", "50")
  .option("--follow", "Follow logs in real time")
  .action(async (options) => {
    try {
      const { spawn } = require("child_process");
      const logFile = "/app/data/musicspree.log";

      const tailLines = parseInt(options.tail, 10) || 50;

      if (options.follow) {
        console.log(`📄 Following logs (Ctrl+C to stop)...\n`);
        const tail = spawn("tail", ["-f", "-n", tailLines.toString(), logFile]);

        tail.stdout.on("data", (data: Buffer) => {
          process.stdout.write(data);
        });

        tail.on("error", () => {
          console.log("⚠️ Log file not found or not accessible");
        });
      } else {
        console.log(`📄 Showing last ${tailLines} log lines...\n`);
        const tail = spawn("tail", ["-n", tailLines.toString(), logFile]);

        tail.stdout.on("data", (data: Buffer) => {
          process.stdout.write(data);
        });

        tail.on("error", () => {
          console.log("⚠️ Log file not found or not accessible");
        });
      }
    } catch (error) {
      console.log("⚠️ Could not access log file");
    }
  });

// Parse command line arguments
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
