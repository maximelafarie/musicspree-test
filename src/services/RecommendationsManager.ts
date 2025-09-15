import { promises as fs } from "fs";
import { join, basename, dirname } from "path";
import { Config } from "../config/Config";
import { Logger } from "../utils/Logger";
import { Track, NavidromeTrack } from "../types/Track";
import winston from "winston";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface RecommendationStats {
  currentCount: number;
  archiveCount: number;
  totalSize: number;
  oldestFile?: Date;
  newestFile?: Date;
  byFormat: Record<string, number>;
}

export interface RecommendationFile {
  path: string;
  name: string;
  size: number;
  modified: Date;
  format: string;
  artist?: string;
  title?: string;
}

export class RecommendationsManager {
  private config: Config;
  private logger: winston.Logger;

  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
  }

  async initialize(): Promise<void> {
    this.logger.info("🚀 Initializing recommendations manager...");

    try {
      // Créer la structure de dossiers
      await this.ensureDirectoryStructure();

      // Nettoyage au démarrage si activé
      if (this.config.enableCleanupOnStartup) {
        await this.performStartupCleanup();
      }

      this.logger.info("✅ Recommendations manager initialized successfully");
    } catch (error) {
      this.logger.error(
        "❌ Failed to initialize recommendations manager:",
        error
      );
      throw error;
    }
  }

  async moveToRecommendations(
    sourcePath: string,
    track: Track
  ): Promise<string> {
    try {
      const fileName = basename(sourcePath);
      const targetPath = join(
        this.config.recommendationsProcessingPath,
        fileName
      );

      this.logger.debug(`Moving ${sourcePath} -> ${targetPath}`);

      // S'assurer que le dossier processing existe
      await fs.mkdir(this.config.recommendationsProcessingPath, {
        recursive: true,
      });

      // Déplacer le fichier
      await fs.rename(sourcePath, targetPath);

      this.logger.debug(`✅ File moved to processing: ${fileName}`);
      return targetPath;
    } catch (error) {
      this.logger.error(`Failed to move file to recommendations:`, error);
      throw error;
    }
  }

  async processToCurrentRecommendations(
    processingPath: string,
    track: Track
  ): Promise<string> {
    try {
      const fileName = basename(processingPath);
      const finalPath = join(this.config.recommendationsCurrentPath, fileName);

      this.logger.debug(`Processing ${processingPath} -> ${finalPath}`);

      // S'assurer que le dossier current existe
      await fs.mkdir(this.config.recommendationsCurrentPath, {
        recursive: true,
      });

      // Déplacer vers current
      await fs.rename(processingPath, finalPath);

      // Créer un fichier de métadonnées
      await this.createMetadataFile(finalPath, track);

      this.logger.info(
        `✅ Track processed to current: ${track.artist} - ${track.title}`
      );
      return finalPath;
    } catch (error) {
      this.logger.error(`Failed to process to current recommendations:`, error);
      throw error;
    }
  }

  async rotateOldTracks(): Promise<{ rotated: number; deleted: number }> {
    this.logger.info("🔄 Starting track rotation...");

    let rotatedCount = 0;
    let deletedCount = 0;

    try {
      const currentFiles = await this.getCurrentRecommendationFiles();
      const filesToRotate = await this.selectFilesForRotation(currentFiles);

      if (filesToRotate.length === 0) {
        this.logger.info("No files need rotation");
        return { rotated: 0, deleted: 0 };
      }

      this.logger.info(`Rotating ${filesToRotate.length} files to archive...`);

      // Déplacer vers l'archive si activée
      if (this.config.enableArchive) {
        await fs.mkdir(this.config.recommendationsArchivePath, {
          recursive: true,
        });

        for (const file of filesToRotate) {
          try {
            const archivePath = join(
              this.config.recommendationsArchivePath,
              file.name
            );
            await fs.rename(file.path, archivePath);

            // Déplacer aussi les métadonnées si elles existent
            const metadataPath = this.getMetadataPath(file.path);
            const archiveMetadataPath = this.getMetadataPath(archivePath);

            try {
              await fs.rename(metadataPath, archiveMetadataPath);
            } catch (metaError) {
              // Ignorer si les métadonnées n'existent pas
              this.logger.debug(`No metadata to move for ${file.name}`);
            }

            rotatedCount++;
            this.logger.debug(`✅ Rotated to archive: ${file.name}`);
          } catch (error) {
            this.logger.warn(`Failed to rotate ${file.name}:`, error);
          }
        }

        // Nettoyer l'archive si nécessaire
        const archiveDeleted = await this.cleanupArchive();
        deletedCount += archiveDeleted;
      } else {
        // Supprimer directement si l'archive est désactivée
        for (const file of filesToRotate) {
          try {
            await fs.unlink(file.path);

            // Supprimer aussi les métadonnées
            try {
              await fs.unlink(this.getMetadataPath(file.path));
            } catch (metaError) {
              // Ignorer si les métadonnées n'existent pas
            }

            deletedCount++;
            this.logger.debug(`✅ Deleted: ${file.name}`);
          } catch (error) {
            this.logger.warn(`Failed to delete ${file.name}:`, error);
          }
        }
      }

      this.logger.info(
        `🔄 Rotation completed: ${rotatedCount} rotated, ${deletedCount} deleted`
      );
      return { rotated: rotatedCount, deleted: deletedCount };
    } catch (error) {
      this.logger.error("❌ Track rotation failed:", error);
      throw error;
    }
  }

  async cleanupArchive(): Promise<number> {
    if (!this.config.enableArchive) {
      return 0;
    }

    try {
      const archiveFiles = await this.getArchiveFiles();

      if (archiveFiles.length <= this.config.archiveMaxTracks) {
        return 0;
      }

      const filesToDelete = archiveFiles.length - this.config.archiveMaxTracks;
      const oldestFiles = archiveFiles
        .sort((a, b) => a.modified.getTime() - b.modified.getTime())
        .slice(0, filesToDelete);

      let deletedCount = 0;

      for (const file of oldestFiles) {
        try {
          await fs.unlink(file.path);

          // Supprimer aussi les métadonnées
          try {
            await fs.unlink(this.getMetadataPath(file.path));
          } catch (metaError) {
            // Ignorer si les métadonnées n'existent pas
          }

          deletedCount++;
          this.logger.debug(`✅ Deleted from archive: ${file.name}`);
        } catch (error) {
          this.logger.warn(
            `Failed to delete from archive ${file.name}:`,
            error
          );
        }
      }

      this.logger.info(`🗑️ Archive cleanup: deleted ${deletedCount} files`);
      return deletedCount;
    } catch (error) {
      this.logger.error("Failed to cleanup archive:", error);
      return 0;
    }
  }

  async getRecommendationStats(): Promise<RecommendationStats> {
    try {
      const currentFiles = await this.getCurrentRecommendationFiles();
      const archiveFiles = this.config.enableArchive
        ? await this.getArchiveFiles()
        : [];

      const allFiles = [...currentFiles, ...archiveFiles];
      const totalSize = allFiles.reduce((sum, file) => sum + file.size, 0);

      const byFormat: Record<string, number> = {};
      allFiles.forEach((file) => {
        byFormat[file.format] = (byFormat[file.format] || 0) + 1;
      });

      const dates = allFiles.map((f) => f.modified);
      const oldestFile =
        dates.length > 0
          ? new Date(Math.min(...dates.map((d) => d.getTime())))
          : undefined;
      const newestFile =
        dates.length > 0
          ? new Date(Math.max(...dates.map((d) => d.getTime())))
          : undefined;

      return {
        currentCount: currentFiles.length,
        archiveCount: archiveFiles.length,
        totalSize,
        oldestFile,
        newestFile,
        byFormat,
      };
    } catch (error) {
      this.logger.error("Failed to get recommendation stats:", error);
      return {
        currentCount: 0,
        archiveCount: 0,
        totalSize: 0,
        byFormat: {},
      };
    }
  }

  async clearAllRecommendations(): Promise<{ deleted: number }> {
    this.logger.info("🗑️ Clearing all recommendations...");

    let deletedCount = 0;

    try {
      // Nettoyer current
      const currentFiles = await this.getCurrentRecommendationFiles();
      for (const file of currentFiles) {
        try {
          await fs.unlink(file.path);
          try {
            await fs.unlink(this.getMetadataPath(file.path));
          } catch {}
          deletedCount++;
        } catch (error) {
          this.logger.warn(`Failed to delete ${file.name}:`, error);
        }
      }

      // Nettoyer archive si demandé
      if (this.config.enableArchive) {
        const archiveFiles = await this.getArchiveFiles();
        for (const file of archiveFiles) {
          try {
            await fs.unlink(file.path);
            try {
              await fs.unlink(this.getMetadataPath(file.path));
            } catch {}
            deletedCount++;
          } catch (error) {
            this.logger.warn(`Failed to delete ${file.name}:`, error);
          }
        }
      }

      // Nettoyer processing
      try {
        const processingFiles = await fs.readdir(
          this.config.recommendationsProcessingPath
        );
        for (const fileName of processingFiles) {
          const filePath = join(
            this.config.recommendationsProcessingPath,
            fileName
          );
          try {
            await fs.unlink(filePath);
            deletedCount++;
          } catch (error) {
            this.logger.warn(
              `Failed to delete processing file ${fileName}:`,
              error
            );
          }
        }
      } catch (error) {
        this.logger.debug("No processing files to clean:", error);
      }

      this.logger.info(`🗑️ Cleared ${deletedCount} recommendation files`);
      return { deleted: deletedCount };
    } catch (error) {
      this.logger.error("Failed to clear recommendations:", error);
      throw error;
    }
  }

  private async ensureDirectoryStructure(): Promise<void> {
    const directories = [
      this.config.recommendationsCurrentPath,
      this.config.recommendationsProcessingPath,
    ];

    if (this.config.enableArchive) {
      directories.push(this.config.recommendationsArchivePath);
    }

    for (const dir of directories) {
      try {
        await fs.mkdir(dir, { recursive: true });
        this.logger.debug(`✅ Directory ensured: ${dir}`);
      } catch (error) {
        this.logger.error(`Failed to create directory ${dir}:`, error);
        throw error;
      }
    }
  }

  private async performStartupCleanup(): Promise<void> {
    this.logger.info("🧹 Performing startup cleanup...");

    try {
      // Nettoyer les fichiers de processing orphelins
      await this.cleanupProcessingFiles();

      // Vérifier si rotation nécessaire
      const stats = await this.getRecommendationStats();

      if (stats.currentCount > this.config.recommendationsMaxTracks) {
        this.logger.info(
          `Current count (${stats.currentCount}) exceeds limit (${this.config.recommendationsMaxTracks}), performing rotation...`
        );
        await this.rotateOldTracks();
      }

      // Nettoyer les fichiers corrompus ou invalides
      await this.cleanupInvalidFiles();

      this.logger.info("✅ Startup cleanup completed");
    } catch (error) {
      this.logger.error("Startup cleanup failed:", error);
      // Ne pas faire échouer l'initialisation pour ça
    }
  }

  private async cleanupProcessingFiles(): Promise<void> {
    try {
      const processingFiles = await fs.readdir(
        this.config.recommendationsProcessingPath
      );

      for (const fileName of processingFiles) {
        const filePath = join(
          this.config.recommendationsProcessingPath,
          fileName
        );
        const stats = await fs.stat(filePath);

        // Supprimer les fichiers de processing de plus de 1 heure
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (stats.mtime < oneHourAgo) {
          try {
            await fs.unlink(filePath);
            this.logger.debug(`Removed stale processing file: ${fileName}`);
          } catch (error) {
            this.logger.debug(
              `Failed to remove stale file ${fileName}:`,
              error
            );
          }
        }
      }
    } catch (error) {
      this.logger.debug("No processing files to cleanup:", error);
    }
  }

  private async cleanupInvalidFiles(): Promise<void> {
    const currentFiles = await this.getCurrentRecommendationFiles();

    for (const file of currentFiles) {
      try {
        // Vérifier que le fichier n'est pas corrompu (taille minimale)
        if (file.size < 1024) {
          // Moins de 1KB
          this.logger.warn(`Removing suspiciously small file: ${file.name}`);
          await fs.unlink(file.path);
          continue;
        }

        // Autres vérifications possibles...
      } catch (error) {
        this.logger.debug(`Error checking file ${file.name}:`, error);
      }
    }
  }

  private async getCurrentRecommendationFiles(): Promise<RecommendationFile[]> {
    return this.getFilesInDirectory(this.config.recommendationsCurrentPath);
  }

  private async getArchiveFiles(): Promise<RecommendationFile[]> {
    if (!this.config.enableArchive) {
      return [];
    }
    return this.getFilesInDirectory(this.config.recommendationsArchivePath);
  }

  private async getFilesInDirectory(
    directory: string
  ): Promise<RecommendationFile[]> {
    try {
      const files: RecommendationFile[] = [];
      const fileNames = await fs.readdir(directory);

      for (const fileName of fileNames) {
        // Ignorer les fichiers de métadonnées
        if (fileName.endsWith(".metadata.json")) {
          continue;
        }

        const filePath = join(directory, fileName);
        const stats = await fs.stat(filePath);

        if (stats.isFile()) {
          const format = this.getFileFormat(fileName);
          if (format) {
            const metadata = await this.readMetadataFile(filePath);

            files.push({
              path: filePath,
              name: fileName,
              size: stats.size,
              modified: stats.mtime,
              format,
              artist: metadata?.artist,
              title: metadata?.title,
            });
          }
        }
      }

      return files;
    } catch (error) {
      this.logger.debug(`Directory ${directory} not accessible:`, error);
      return [];
    }
  }

  private async selectFilesForRotation(
    files: RecommendationFile[]
  ): Promise<RecommendationFile[]> {
    const maxTracks = this.config.recommendationsMaxTracks;
    const maxAge = new Date(
      Date.now() - this.config.recommendationsMaxAgeDays * 24 * 60 * 60 * 1000
    );

    // Filtrer par âge
    const oldFiles = files.filter((file) => file.modified < maxAge);

    // Si on dépasse la limite de nombre de fichiers
    const excessFiles = files.length > maxTracks ? files.length - maxTracks : 0;

    let filesToRotate = [...oldFiles];

    // Si on a besoin de plus de fichiers pour respecter la limite
    if (excessFiles > oldFiles.length) {
      const remainingFiles = files.filter((file) => !oldFiles.includes(file));
      const additionalFiles = this.selectFilesByStrategy(
        remainingFiles,
        excessFiles - oldFiles.length
      );
      filesToRotate.push(...additionalFiles);
    }

    return filesToRotate;
  }

  private selectFilesByStrategy(
    files: RecommendationFile[],
    count: number
  ): RecommendationFile[] {
    if (count <= 0 || files.length === 0) return [];

    const sorted = [...files];

    switch (this.config.rotationStrategy) {
      case "oldest_first":
        sorted.sort((a, b) => a.modified.getTime() - b.modified.getTime());
        break;

      case "random":
        for (let i = sorted.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
        }
        break;

      case "least_played":
        // Pour l'instant, utiliser oldest_first comme fallback
        // TODO: Implémenter le tracking de lecture si Navidrome expose ces stats
        sorted.sort((a, b) => a.modified.getTime() - b.modified.getTime());
        break;

      default:
        sorted.sort((a, b) => a.modified.getTime() - b.modified.getTime());
    }

    return sorted.slice(0, count);
  }

  private getFileFormat(fileName: string): string | null {
    const extension = fileName.toLowerCase().split(".").pop();
    const audioFormats = ["mp3", "flac", "wav", "m4a", "ogg", "aac", "wma"];

    if (extension && audioFormats.includes(extension)) {
      return extension;
    }

    return null;
  }

  private async createMetadataFile(
    filePath: string,
    track: Track
  ): Promise<void> {
    try {
      const metadataPath = this.getMetadataPath(filePath);
      const metadata = {
        artist: track.artist,
        title: track.title,
        album: track.album,
        url: track.url,
        addedAt: new Date().toISOString(),
        source: "musicspree",
      };

      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      this.logger.debug(`✅ Metadata created: ${basename(metadataPath)}`);
    } catch (error) {
      this.logger.debug(
        `Failed to create metadata for ${basename(filePath)}:`,
        error
      );
      // Ne pas faire échouer l'opération principale
    }
  }

  private async readMetadataFile(filePath: string): Promise<any | null> {
    try {
      const metadataPath = this.getMetadataPath(filePath);
      const content = await fs.readFile(metadataPath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  private getMetadataPath(filePath: string): string {
    const dir = dirname(filePath);
    const name = basename(filePath, join(filePath).split(".").pop() || "");
    return join(dir, `${name}.metadata.json`);
  }

  async validateRecommendationsStructure(): Promise<{
    valid: boolean;
    issues: string[];
    suggestions: string[];
  }> {
    const issues: string[] = [];
    const suggestions: string[] = [];

    try {
      // Vérifier que les dossiers existent
      const directories = [
        this.config.recommendationsCurrentPath,
        this.config.recommendationsProcessingPath,
      ];

      if (this.config.enableArchive) {
        directories.push(this.config.recommendationsArchivePath);
      }

      for (const dir of directories) {
        try {
          await fs.access(dir);
        } catch (error) {
          issues.push(`Directory missing: ${dir}`);
          suggestions.push(`Create directory: mkdir -p ${dir}`);
        }
      }

      // Vérifier les permissions d'écriture
      for (const dir of directories) {
        try {
          await fs.access(dir, fs.constants.W_OK);
        } catch (error) {
          issues.push(`No write permission: ${dir}`);
          suggestions.push(`Fix permissions: chmod 755 ${dir}`);
        }
      }

      // Vérifier l'espace disque
      try {
        const { stdout } = await execAsync(
          `df -h "${this.config.recommendationsFolder}" | tail -1`
        );
        const usage = stdout.split(/\s+/);
        const usagePercent = parseInt(usage[4]?.replace("%", "") || "0");

        if (usagePercent > 90) {
          issues.push(`Disk usage high: ${usagePercent}%`);
          suggestions.push(
            "Consider cleaning up old files or increasing disk space"
          );
        } else if (usagePercent > 80) {
          suggestions.push(`Disk usage at ${usagePercent}%, monitor space`);
        }
      } catch (error) {
        this.logger.debug("Could not check disk usage:", error);
      }

      // Vérifier les fichiers orphelins
      const processingFiles = await this.getFilesInDirectory(
        this.config.recommendationsProcessingPath
      );
      if (processingFiles.length > 0) {
        suggestions.push(
          `${processingFiles.length} files stuck in processing, consider cleanup`
        );
      }

      return {
        valid: issues.length === 0,
        issues,
        suggestions,
      };
    } catch (error) {
      this.logger.error("Failed to validate recommendations structure:", error);
      return {
        valid: false,
        issues: ["Validation failed: " + error],
        suggestions: ["Check system permissions and disk space"],
      };
    }
  }

  async getProcessingFiles(): Promise<RecommendationFile[]> {
    return this.getFilesInDirectory(this.config.recommendationsProcessingPath);
  }

  async forceCleanupProcessing(): Promise<number> {
    this.logger.info("🧹 Force cleaning processing directory...");

    try {
      const processingFiles = await this.getProcessingFiles();
      let cleanedCount = 0;

      for (const file of processingFiles) {
        try {
          await fs.unlink(file.path);
          cleanedCount++;
          this.logger.debug(`Removed processing file: ${file.name}`);
        } catch (error) {
          this.logger.warn(
            `Failed to remove processing file ${file.name}:`,
            error
          );
        }
      }

      this.logger.info(`✅ Cleaned ${cleanedCount} files from processing`);
      return cleanedCount;
    } catch (error) {
      this.logger.error("Failed to force cleanup processing:", error);
      return 0;
    }
  }
}
