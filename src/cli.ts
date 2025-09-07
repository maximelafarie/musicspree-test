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

program
  .command("sync")
  .description("Run full sync process")
  .option("--force", "Force sync even if recently synced")
  .action(async (options) => {
    const logger = Logger.getInstance();

    try {
      logger.info("🎵 Starting full sync via CLI...");

      const musicSpree = new MusicSpree();
      await musicSpree.validateConfig();

      const result = await musicSpree.syncRecommendations();

      console.log("\n📊 Sync Results:");
      console.log(`   Total recommendations: ${result.totalRecommendations}`);
      console.log(`   Already in library: ${result.alreadyInLibrary}`);
      console.log(`   New downloads: ${result.newDownloads}`);
      console.log(`   Failed downloads: ${result.failedDownloads}`);
      console.log(`   Added to playlist: ${result.addedToPlaylist}`);

      if (result.errors.length > 0) {
        console.log(`   Errors: ${result.errors.length}`);
        result.errors.forEach((error) => console.log(`     - ${error}`));
      }

      logger.info("✅ Sync completed successfully");
    } catch (error) {
      logger.error("❌ Sync failed:", error);
      process.exit(1);
    }
  });

program
  .command("dry")
  .description("Dry run - show what would be downloaded")
  .action(async () => {
    const logger = Logger.getInstance();

    try {
      logger.info("🏃‍♂️ Starting dry run via CLI...");

      const musicSpree = new MusicSpree();
      await musicSpree.validateConfig();

      const tracks = await musicSpree.dryRun();

      console.log(`\n📋 Would download ${tracks.length} tracks:`);
      tracks.forEach((track, index) => {
        console.log(
          `   ${index + 1}. ${track.artist} - ${track.title}${
            track.album ? ` (${track.album})` : ""
          }`
        );
      });

      if (tracks.length === 0) {
        console.log("   No new tracks to download!");
      }
    } catch (error) {
      logger.error("❌ Dry run failed:", error);
      process.exit(1);
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

      await musicSpree.clearPlaylist();

      console.log(`✅ Playlist "${config.playlistName}" cleared successfully`);
    } catch (error) {
      logger.error("❌ Failed to clear playlist:", error);
      process.exit(1);
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
        console.log("✅ All services are connected and responding");
      } catch (error) {
        console.log(`❌ Service connection issues: ${error}`);
      }

      // Show current configuration (sanitized)
      console.log("\n⚙️ Configuration:");
      console.log(`   Playlist: ${config.playlistName}`);
      console.log(`   Cron: ${config.cronSchedule}`);
      console.log(`   Clean on refresh: ${config.cleanPlaylistsOnRefresh}`);
      console.log(`   Keep downloaded tracks: ${config.keepDownloadedTracks}`);
      console.log(`   Max retries: ${config.maxDownloadRetries}`);
      console.log(`   Timeout: ${config.downloadTimeoutMinutes} minutes`);
      console.log(`   Concurrent downloads: ${config.concurrentDownloads}`);
    } catch (error) {
      logger.error("❌ Failed to get status:", error);
      process.exit(1);
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
      await musicSpree.validateConfig();

      console.log("✅ All service connections successful!");
    } catch (error) {
      console.log(`❌ Connection test failed: ${error}`);
      process.exit(1);
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

        console.log("📚 Beets Library:");
        Object.entries(stats).forEach(([key, value]) => {
          console.log(`   ${key.replace(/_/g, " ")}: ${value}`);
        });
      } catch (error) {
        console.log("⚠️ Could not fetch library statistics from Beets");
        console.log(`   Error: ${error}`);
      }
    } catch (error) {
      logger.error("❌ Failed to get statistics:", error);
      process.exit(1);
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

      console.log("✅ Import completed successfully");
    } catch (error) {
      logger.error("❌ Import failed:", error);
      process.exit(1);
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

      console.log("✅ Cleanup completed successfully");
    } catch (error) {
      logger.error("❌ Cleanup failed:", error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
