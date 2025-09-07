import axios, { AxiosInstance } from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Config } from '../config/Config';
import { Logger } from '../utils/Logger';
import winston from 'winston';

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
          'Content-Type': 'application/json'
        }
      });
    } catch (error) {
      this.logger.debug('Beets HTTP client not initialized:', error);
    }
  }
  
  async testConnection(): Promise<void> {
    try {
      // Try HTTP connection first (if beets web plugin is enabled)
      if (this.client) {
        try {
          const response = await this.client.get('/stats');
          if (response.status === 200) {
            this.logger.debug('Beets HTTP connection test successful');
            return;
          }
        } catch (httpError) {
          this.logger.debug('Beets HTTP connection failed, trying CLI:', httpError);
        }
      }
      
      // Fallback to CLI test
      const { stdout } = await execAsync('beets version');
      if (stdout.includes('beets')) {
        this.logger.debug('Beets CLI connection test successful');
        return;
      }
      
      throw new Error('Beets not responding via HTTP or CLI');
      
    } catch (error) {
      this.logger.error('Beets connection test failed:', error);
      throw error;
    }
  }
  
  async importNewTracks(importPath?: string): Promise<void> {
    try {
      const pathToImport = importPath || '/downloads'; // Default download path
      
      this.logger.info(`🏷️ Starting beets import from: ${pathToImport}`);
      
      // Try HTTP import first
      if (this.client) {
        try {
          await this.httpImport(pathToImport);
          return;
        } catch (httpError) {
          this.logger.debug('HTTP import failed, falling back to CLI:', httpError);
        }
      }
      
      // Fallback to CLI import
      await this.cliImport(pathToImport);
      
    } catch (error) {
      this.logger.error('Failed to import tracks with beets:', error);
      throw error;
    }
  }
  
  async updateLibrary(): Promise<void> {
    try {
      this.logger.info('🔄 Updating beets library...');
      
      if (this.client) {
        try {
          await this.client.post('/update');
          this.logger.info('✅ Library updated via HTTP');
          return;
        } catch (httpError) {
          this.logger.debug('HTTP update failed, falling back to CLI:', httpError);
        }
      }
      
      // Fallback to CLI
      await execAsync('beets update');
      this.logger.info('✅ Library updated via CLI');
      
    } catch (error) {
      this.logger.error('Failed to update beets library:', error);
      throw error;
    }
  }
  
  async searchTracks(query: string): Promise<any[]> {
    try {
      if (this.client) {
        try {
          const response = await this.client.get(`/item/query/${encodeURIComponent(query)}`);
          return response.data.items || [];
        } catch (httpError) {
          this.logger.debug('HTTP search failed, falling back to CLI:', httpError);
        }
      }
      
      // Fallback to CLI
      const { stdout } = await execAsync('beets stats');
      
      // Parse CLI output (basic parsing)
      const lines = stdout.split('\n');
      const stats: any = {};
      
      for (const line of lines) {
        const match = line.match(/(.+?):\s*(.+)/);
        if (match) {
          const [, key, value] = match;
          stats[key.toLowerCase().replace(/\s+/g, '_')] = value.trim();
        }
      }
      
      return stats;
      
    } catch (error) {
      this.logger.error('Failed to get library stats:', error);
      return {};
    }
  }
  
  private async httpImport(path: string): Promise<void> {
    if (!this.client) {
      throw new Error('HTTP client not available');
    }
    
    const response = await this.client.post('/import', {
      path: path,
      options: {
        autotag: true,
        write: true,
        copy: true,
        quiet: false,
        timid: false
      }
    });
    
    if (response.status !== 200) {
      throw new Error(`HTTP import failed with status: ${response.status}`);
    }
    
    this.logger.info('✅ Tracks imported via HTTP');
  }
  
  private async cliImport(path: string): Promise<void> {
    const importCommand = [
      'beets import',
      '--autotag',     // Auto-tag files
      '--write',       // Write tags to files
      '--copy',        // Copy files to library
      '--quiet',       // Reduce output
      `"${path}"`
    ].join(' ');
    
    this.logger.debug(`Executing: ${importCommand}`);
    
    try {
      const { stdout, stderr } = await execAsync(importCommand);
      
      if (stderr && !stderr.includes('Sending event')) {
        this.logger.warn('Beets import warnings:', stderr);
      }
      
      if (stdout) {
        this.logger.debug('Beets import output:', stdout);
      }
      
      this.logger.info('✅ Tracks imported via CLI');
      
    } catch (error: any) {
      // Beets sometimes returns non-zero exit codes even on success
      if (error.code === 0 || (error.stdout && error.stdout.includes('items imported'))) {
        this.logger.info('✅ Tracks imported via CLI (with warnings)');
        return;
      }
      
      throw error;
    }
  }
  
  async cleanupEmptyDirectories(): Promise<void> {
    try {
      this.logger.info('🧹 Cleaning up empty directories...');
      
      // Use beets' built-in cleanup if available
      try {
        await execAsync('beets modify --yes album:""');
      } catch (error) {
        this.logger.debug('Beets cleanup command not available:', error);
      }
      
      // Manual cleanup of common download directories
      const cleanupCommands = [
        'find /downloads -type d -empty -delete 2>/dev/null || true',
        'find /music -type d -empty -delete 2>/dev/null || true'
      ];
      
      for (const command of cleanupCommands) {
        try {
          await execAsync(command);
        } catch (error) {
          this.logger.debug(`Cleanup command failed: ${command}`, error);
        }
      }
      
      this.logger.info('✅ Directory cleanup completed');
      
    } catch (error) {
      this.logger.error('Failed to cleanup directories:', error);
    }
  }
  
  async validateImport(artist: string, title: string): Promise<boolean> {
    try {
      const query = `artist:"${artist}" title:"${title}"`;
      const results = await this.searchTracks(query);
      
      return results.length > 0;
      
    } catch (error) {
      this.logger.debug(`Failed to validate import for ${artist} - ${title}:`, error);
      return false;
    }
  }
}(`beets list "${query}" -f '$id|$artist|$title|$album|$path'`);
      
      return stdout.split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [id, artist, title, album, path] = line.split('|');
          return { id, artist, title, album, path };
        });
        
    } catch (error) {
      this.logger.error('Failed to search tracks:', error);
      return [];
    }
  }
  
  async getLibraryStats(): Promise<any> {
    try {
      if (this.client) {
        try {
          const response = await this.client.get('/stats');
          return response.data;
        } catch (httpError) {
          this.logger.debug('HTTP stats failed, falling back to CLI:', httpError);
        }
      }
      
      // Fallback to CLI
      const { stdout } = await execAsync('beets stats -f json');
      return JSON.parse(stdout);