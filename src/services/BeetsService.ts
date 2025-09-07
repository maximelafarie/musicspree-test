import axios, { AxiosInstance } from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import winston from "winston";

const execAsync = promisify(exec);

export class BeetsService {
  private config: Config;
  private logger: winston.Logger;
  private client?: AxiosInstance;

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();

    // Initialize HTTP client if beets web plugin is available
    try {
      this.client = axios.create({
        baseURL: this.config.beetsUrl,
        timeout: 30000,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      this.logger.debug("Beets HTTP client not initialized:", error);
    }
  }

  async testConnection(): Promise<void> {
    try {
      // Try HTTP connection first (if beets web plugin is enabled)
      if (this.client) {
        try {
          const response = await this.client.get("/stats");
          if (response.status === 200) {
            this.logger.debug("Beets HTTP connection test successful");
            return;
          }
        } catch (httpError) {
          this.logger.debug(
            "Beets HTTP connection failed, trying CLI:",
            httpError
          );
        }
      }

      // Fallback to CLI test
      const { stdout } = await execAsync("beet version", {
        timeout: 10000,
        env: { ...process.env, BEETSDIR: this.config.beetsConfigPath },
      });

      if (stdout.includes("beets")) {
        this.logger.debug("Beets CLI connection test successful");
        return;
      }

      throw new Error("Beets not responding via HTTP or CLI");
    } catch (error) {
      this.logger.error("Beets connection test failed:", error);
      throw error;
    }
  }

  async importNewTracks(importPath?: string): Promise<void> {
    try {
      const pathToImport = importPath || "/downloads";

      this.logger.info(`🏷️ Starting beets import from: ${pathToImport}`);

      // Try HTTP import first
      if (this.client) {
        try {
          await this.httpImport(pathToImport);
          return;
        } catch (httpError) {
          this.logger.debug(
            "HTTP import failed, falling back to CLI:",
            httpError
          );
        }
      }

      // Fallback to CLI import
      await this.cliImport(pathToImport);
    } catch (error) {
      this.logger.error("Failed to import tracks with beets:", error);
      throw error;
    }
  }

  async updateLibrary(): Promise<void> {
    try {
      this.logger.info("🔄 Updating beets library...");

      if (this.client) {
        try {
          await this.client.post("/update");
          this.logger.info("✅ Library updated via HTTP");
          return;
        } catch (httpError) {
          this.logger.debug(
            "HTTP update failed, falling back to CLI:",
            httpError
          );
        }
      }

      // Fallback to CLI
      await execAsync("beet update", {
        timeout: 60000,
        env: { ...process.env, BEETSDIR: this.config.beetsConfigPath },
      });
      this.logger.info("✅ Library updated via CLI");
    } catch (error) {
      this.logger.error("Failed to update beets library:", error);
      throw error;
    }
  }

  async searchTracks(query: string): Promise<any[]> {
    try {
      if (this.client) {
        try {
          const response = await this.client.get(
            `/item/query/${encodeURIComponent(query)}`
          );
          return response.data.items || [];
        } catch (httpError) {
          this.logger.debug(
            "HTTP search failed, falling back to CLI:",
            httpError
          );
        }
      }

      // Fallback to CLI search
      const escapedQuery = query.replace(/"/g, '\\"');
      const { stdout } = await execAsync(
        `beet list "${escapedQuery}" -f '$id|$artist|$title|$album|$path'`,
        {
          timeout: 30000,
          env: { ...process.env, BEETSDIR: this.config.beetsConfigPath },
        }
      );

      return stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const [id, artist, title, album, path] = line.split("|");
          return { id, artist, title, album, path };
        });
    } catch (error) {
      this.logger.error("Failed to search tracks:", error);
      return [];
    }
  }

  async getLibraryStats(): Promise<any> {
    try {
      if (this.client) {
        try {
          const response = await this.client.get("/stats");
          return response.data;
        } catch (httpError) {
          this.logger.debug(
            "HTTP stats failed, falling back to CLI:",
            httpError
          );
        }
      }

      // Fallback to CLI
      const { stdout } = await execAsync("beet stats", {
        timeout: 30000,
        env: { ...process.env, BEETSDIR: this.config.beetsConfigPath },
      });

      // Parse CLI output
      const lines = stdout.split("\n");
      const stats: any = {};

      for (const line of lines) {
        const match = line.match(/(.+?):\s*(.+)/);
        if (match) {
          const [, key, value] = match;
          stats[key.toLowerCase().replace(/\s+/g, "_")] = value.trim();
        }
      }

      return stats;
    } catch (error) {
      this.logger.error("Failed to get library stats:", error);
      return {};
    }
  }

  private async httpImport(path: string): Promise<void> {
    if (!this.client) {
      throw new Error("HTTP client not available");
    }

    const response = await this.client.post("/import", {
      path: path,
      options: {
        autotag: true,
        write: true,
        copy: true,
        quiet: false,
        timid: false,
      },
    });

    if (response.status !== 200) {
      throw new Error(`HTTP import failed with status: ${response.status}`);
    }

    this.logger.info("✅ Tracks imported via HTTP");
  }

  private async cliImport(path: string): Promise<void> {
    const importCommand = [
      "beet import",
      "--autotag", // Auto-tag files
      "--write", // Write tags to files
      "--copy", // Copy files to library
      "--quiet", // Reduce output
      "--noincremental", // Don't skip already imported albums
      `"${path}"`,
    ].join(" ");

    this.logger.debug(`Executing: ${importCommand}`);

    try {
      const { stdout, stderr } = await execAsync(importCommand, {
        timeout: 300000, // 5 minutes timeout
        env: {
          ...process.env,
          BEETSDIR: this.config.beetsConfigPath,
          // Ensure non-interactive mode
          BEETS_AUTO: "1",
        },
      });

      if (stderr && !stderr.includes("Sending event")) {
        this.logger.warn("Beets import warnings:", stderr);
      }

      if (stdout) {
        this.logger.debug("Beets import output:", stdout);
      }

      this.logger.info("✅ Tracks imported via CLI");
    } catch (error: any) {
      // Beets sometimes returns non-zero exit codes even on success
      if (
        error.stdout &&
        (error.stdout.includes("items imported") ||
          error.stdout.includes("albums imported"))
      ) {
        this.logger.info("✅ Tracks imported via CLI (with warnings)");
        return;
      }

      this.logger.error("Beets import command failed:", {
        code: error.code,
        stdout: error.stdout,
        stderr: error.stderr,
      });
      throw error;
    }
  }

  async cleanupEmptyDirectories(): Promise<void> {
    try {
      this.logger.info("🧹 Cleaning up empty directories...");

      // Manual cleanup of common download and music directories
      const cleanupCommands = [
        "find /downloads -type d -empty -delete 2>/dev/null || true",
        "find /music -type d -empty -delete 2>/dev/null || true",
        // Clean up any temporary beets files
        'find /tmp -name "beets_*" -type f -mtime +1 -delete 2>/dev/null || true',
      ];

      for (const command of cleanupCommands) {
        try {
          await execAsync(command, { timeout: 30000 });
          this.logger.debug(`Executed cleanup command: ${command}`);
        } catch (error) {
          this.logger.debug(
            `Cleanup command failed (non-critical): ${command}`,
            error
          );
        }
      }

      this.logger.info("✅ Directory cleanup completed");
    } catch (error) {
      this.logger.error("Failed to cleanup directories:", error);
      // Don't throw as this is not critical
    }
  }

  async validateImport(artist: string, title: string): Promise<boolean> {
    try {
      const query = `artist:"${artist}" title:"${title}"`;
      const results = await this.searchTracks(query);

      return results.length > 0;
    } catch (error) {
      this.logger.debug(
        `Failed to validate import for ${artist} - ${title}:`,
        error
      );
      return false;
    }
  }

  async moveToLibrary(sourcePath: string, targetPath?: string): Promise<void> {
    try {
      this.logger.info(`📁 Moving files from ${sourcePath} to library...`);

      // Use beets' built-in move command if available
      const moveCommand = targetPath
        ? `beet move -d "${targetPath}" "${sourcePath}"`
        : `beet import --copy --delete "${sourcePath}"`;

      await execAsync(moveCommand, {
        timeout: 120000, // 2 minutes timeout
        env: { ...process.env, BEETSDIR: this.config.beetsConfigPath },
      });

      this.logger.info("✅ Files moved to library successfully");
    } catch (error) {
      this.logger.error("Failed to move files to library:", error);
      throw error;
    }
  }
}
