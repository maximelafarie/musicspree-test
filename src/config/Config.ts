export class Config {
  private static instance: Config;

  // LastFM Configuration
  public readonly lastfmApiKey: string;
  public readonly lastfmUsername: string;
  public readonly lastfmSharedSecret: string;

  // Navidrome Configuration
  public readonly navidromeUrl: string;
  public readonly navidromeUsername: string;
  public readonly navidromePassword: string;

  // Soulseek Configuration
  public readonly slskdUrl: string;
  public readonly slskdApiKey: string;

  // Beets Configuration
  public readonly beetsUrl: string;
  public readonly beetsConfigPath: string;

  // Cron Configuration
  public readonly cronSchedule: string;

  // Playlist Configuration
  public readonly playlistName: string;
  public readonly cleanPlaylistsOnRefresh: boolean;
  public readonly keepDownloadedTracks: boolean;

  // Download Configuration
  public readonly maxDownloadRetries: number;
  public readonly downloadTimeoutMinutes: number;
  public readonly concurrentDownloads: number;

  // Logging
  public readonly logLevel: string;
  public readonly logToFile: boolean;

  // Other
  public readonly dryRun: boolean;

  private constructor() {
    this.validateEnvironment();

    // LastFM - Required
    this.lastfmApiKey = this.getEnvVar("LASTFM_API_KEY");
    this.lastfmUsername = this.getEnvVar("LASTFM_USERNAME");
    this.lastfmSharedSecret = this.getEnvVar("LASTFM_SHARED_SECRET");

    // Navidrome - Required
    this.navidromeUrl = this.validateUrl(this.getEnvVar("NAVIDROME_URL"));
    this.navidromeUsername = this.getEnvVar("NAVIDROME_USERNAME");
    this.navidromePassword = this.getEnvVar("NAVIDROME_PASSWORD");

    // Soulseek - Required
    this.slskdUrl = this.validateUrl(this.getEnvVar("SLSKD_URL"));
    this.slskdApiKey = this.getEnvVar("SLSKD_API_KEY");

    // Beets - Optional
    this.beetsUrl = this.validateUrl(
      this.getEnvVar("BEETS_URL", "http://beets:8337")
    );
    this.beetsConfigPath = this.getEnvVar("BEETS_CONFIG_PATH", "/config");

    // Cron - Optional with validation
    this.cronSchedule = this.validateCronSchedule(
      this.getEnvVar("CRON_SCHEDULE", "0 */6 * * *")
    );

    // Playlist - Optional
    this.playlistName = this.getEnvVar(
      "PLAYLIST_NAME",
      "LastFM Recommendations"
    );
    this.cleanPlaylistsOnRefresh = this.getBooleanEnvVar(
      "CLEAN_PLAYLISTS_ON_REFRESH",
      true
    );
    this.keepDownloadedTracks = this.getBooleanEnvVar(
      "KEEP_DOWNLOADED_TRACKS",
      true
    );

    // Download - Optional with validation
    this.maxDownloadRetries = this.validatePositiveInteger(
      this.getEnvVar("MAX_DOWNLOAD_RETRIES", "5"),
      "MAX_DOWNLOAD_RETRIES",
      1,
      10
    );
    this.downloadTimeoutMinutes = this.validatePositiveInteger(
      this.getEnvVar("DOWNLOAD_TIMEOUT_MINUTES", "10"),
      "DOWNLOAD_TIMEOUT_MINUTES",
      1,
      60
    );
    this.concurrentDownloads = this.validatePositiveInteger(
      this.getEnvVar("CONCURRENT_DOWNLOADS", "3"),
      "CONCURRENT_DOWNLOADS",
      1,
      10
    );

    // Logging - Optional with validation
    this.logLevel = this.validateLogLevel(this.getEnvVar("LOG_LEVEL", "info"));
    this.logToFile = this.getBooleanEnvVar("LOG_TO_FILE", true);

    // Other
    this.dryRun = this.getBooleanEnvVar("DRY_RUN", false);

    // Log configuration only in debug mode and only after logger is ready
    if (this.logLevel === "debug") {
      // Use setTimeout to avoid circular dependency during initialization
      setTimeout(() => {
        this.logConfiguration();
      }, 0);
    }
  }

  public static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  private validateEnvironment(): void {
    const requiredVars = [
      "LASTFM_API_KEY",
      "LASTFM_USERNAME",
      "LASTFM_SHARED_SECRET",
      "NAVIDROME_URL",
      "NAVIDROME_USERNAME",
      "NAVIDROME_PASSWORD",
      "SLSKD_URL",
      "SLSKD_API_KEY",
    ];

    const missingVars = requiredVars.filter((varName) => !process.env[varName]);

    if (missingVars.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missingVars.join(", ")}\n` +
          "Please check your .env file or environment configuration."
      );
    }
  }

  private getEnvVar(name: string, defaultValue?: string): string {
    const value = process.env[name];
    if (!value) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Environment variable ${name} is required`);
    }
    return value.trim();
  }

  private getBooleanEnvVar(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];
    if (!value) {
      return defaultValue;
    }
    const lowerValue = value.toLowerCase().trim();
    if (lowerValue === "true" || lowerValue === "1" || lowerValue === "yes") {
      return true;
    }
    if (lowerValue === "false" || lowerValue === "0" || lowerValue === "no") {
      return false;
    }
    throw new Error(
      `Invalid boolean value for ${name}: ${value}. Use true/false, 1/0, or yes/no.`
    );
  }

  private validateUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("URL must use HTTP or HTTPS protocol");
      }
      // Remove trailing slash
      return url.replace(/\/$/, "");
    } catch (error) {
      throw new Error(
        `Invalid URL: ${url}. ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  private validatePositiveInteger(
    value: string,
    varName: string,
    min: number = 1,
    max?: number
  ): number {
    const num = parseInt(value, 10);
    if (isNaN(num)) {
      throw new Error(`${varName} must be a valid integer, got: ${value}`);
    }
    if (num < min) {
      throw new Error(`${varName} must be at least ${min}, got: ${num}`);
    }
    if (max && num > max) {
      throw new Error(`${varName} must be at most ${max}, got: ${num}`);
    }
    return num;
  }

  private validateLogLevel(level: string): string {
    const validLevels = [
      "error",
      "warn",
      "info",
      "http",
      "verbose",
      "debug",
      "silly",
    ];
    const lowerLevel = level.toLowerCase().trim();
    if (!validLevels.includes(lowerLevel)) {
      throw new Error(
        `Invalid log level: ${level}. Valid levels are: ${validLevels.join(
          ", "
        )}`
      );
    }
    return lowerLevel;
  }

  private validateCronSchedule(schedule: string): string {
    // Basic cron validation - 5 parts separated by spaces
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(
        `Invalid cron schedule: ${schedule}. Must have 5 parts (minute hour day month weekday)`
      );
    }

    // Validate each part is not empty
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) {
        throw new Error(
          `Invalid cron schedule: ${schedule}. Part ${i + 1} is empty`
        );
      }
    }

    return schedule.trim();
  }

  private async logConfiguration(): Promise<void> {
    // Import Logger here to avoid circular dependency
    try {
      const { Logger } = await import("../utils/Logger");
      const logger = Logger.getInstance();

      logger.debug("Configuration loaded:", {
        lastfm: {
          username: this.lastfmUsername,
          apiKeyLength: this.lastfmApiKey.length,
        },
        navidrome: {
          url: this.navidromeUrl,
          username: this.navidromeUsername,
        },
        slskd: {
          url: this.slskdUrl,
          apiKeyLength: this.slskdApiKey.length,
        },
        beets: {
          url: this.beetsUrl,
          configPath: this.beetsConfigPath,
        },
        playlist: {
          name: this.playlistName,
          cleanOnRefresh: this.cleanPlaylistsOnRefresh,
          keepDownloaded: this.keepDownloadedTracks,
        },
        download: {
          maxRetries: this.maxDownloadRetries,
          timeoutMinutes: this.downloadTimeoutMinutes,
          concurrent: this.concurrentDownloads,
        },
        schedule: this.cronSchedule,
        dryRun: this.dryRun,
      });
    } catch (error) {
      // Ignore logging errors during initialization
      console.debug("Could not log configuration:", error);
    }
  }

  // Utility method to get sanitized config for CLI display
  public getSanitizedConfig(): Record<string, any> {
    return {
      lastfm: {
        username: this.lastfmUsername,
        apiKey: this.lastfmApiKey.substring(0, 8) + "***",
      },
      navidrome: {
        url: this.navidromeUrl,
        username: this.navidromeUsername,
      },
      slskd: {
        url: this.slskdUrl,
        apiKey: this.slskdApiKey.substring(0, 8) + "***",
      },
      beets: {
        url: this.beetsUrl,
        configPath: this.beetsConfigPath,
      },
      playlist: {
        name: this.playlistName,
        cleanOnRefresh: this.cleanPlaylistsOnRefresh,
        keepDownloaded: this.keepDownloadedTracks,
      },
      download: {
        maxRetries: this.maxDownloadRetries,
        timeoutMinutes: this.downloadTimeoutMinutes,
        concurrent: this.concurrentDownloads,
      },
      schedule: this.cronSchedule,
      logging: {
        level: this.logLevel,
        toFile: this.logToFile,
      },
      dryRun: this.dryRun,
    };
  }
}
