import axios, { AxiosInstance } from 'axios';
import { Config } from '../config/Config';
import { Logger } from '../utils/Logger';
import { Track, LastFMTrack } from '../types/Track';
import winston from 'winston';

export class LastFMService {
  private config: Config;
  private logger: winston.Logger;
  private client: AxiosInstance;
  
  constructor() {
    this.config = Config.getInstance();
    this.logger = Logger.getInstance();
    this.client = axios.create({
      baseURL: 'http://ws.audioscrobbler.com/2.0/',
      timeout: 10000,
      params: {
        api_key: this.config.lastfmApiKey,
        format: 'json'
      }
    });
  }
  
  async testConnection(): Promise<void> {
    try {
      const response = await this.client.get('/', {
        params: {
          method: 'user.getinfo',
          user: this.config.lastfmUsername
        }
      });
      
      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }
      
      this.logger.debug('LastFM connection test successful');
    } catch (error) {
      this.logger.error('LastFM connection test failed:', error);
      throw error;
    }
  }
  
  async getRecommendations(limit: number = 50): Promise<Track[]> {
    try {
      this.logger.info(`📡 Fetching ${limit} recommendations from LastFM...`);
      
      // Get user's recommended tracks
      const response = await this.client.get('/', {
        params: {
          method: 'user.getRecommendedEvents', // Vous pouvez changer cette méthode selon vos besoins
          user: this.config.lastfmUsername,
          limit: limit
        }
      });
      
      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }
      
      // Alternative: Get top tracks from charts (recommendations)
      const topTracksResponse = await this.client.get('/', {
        params: {
          method: 'chart.gettoptracks',
          limit: limit
        }
      });
      
      if (topTracksResponse.data.error) {
        // Fallback to user's loved tracks
        const lovedTracksResponse = await this.client.get('/', {
          params: {
            method: 'user.getlovedtracks',
            user: this.config.lastfmUsername,
            limit: limit
          }
        });
        
        if (lovedTracksResponse.data.error) {
          throw new Error(`LastFM API Error: ${lovedTracksResponse.data.message}`);
        }
        
        return this.parseLovedTracks(lovedTracksResponse.data);
      }
      
      return this.parseTopTracks(topTracksResponse.data);
      
    } catch (error) {
      this.logger.error('Failed to fetch LastFM recommendations:', error);
      throw error;
    }
  }
  
  async getUserTopTracks(period: 'overall' | '7day' | '1month' | '3month' | '6month' | '12month' = 'overall', limit: number = 50): Promise<Track[]> {
    try {
      const response = await this.client.get('/', {
        params: {
          method: 'user.gettoptracks',
          user: this.config.lastfmUsername,
          period: period,
          limit: limit
        }
      });
      
      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }
      
      return this.parseUserTopTracks(response.data);
      
    } catch (error) {
      this.logger.error('Failed to fetch user top tracks:', error);
      throw error;
    }
  }
  
  async getSimilarTracks(artist: string, track: string, limit: number = 10): Promise<Track[]> {
    try {
      const response = await this.client.get('/', {
        params: {
          method: 'track.getsimilar',
          artist: artist,
          track: track,
          limit: limit
        }
      });
      
      if (response.data.error) {
        throw new Error(`LastFM API Error: ${response.data.message}`);
      }
      
      return this.parseSimilarTracks(response.data);
      
    } catch (error) {
      this.logger.error('Failed to fetch similar tracks:', error);
      throw error;
    }
  }
  
  private parseTopTracks(data: any): Track[] {
    const tracks: Track[] = [];
    
    if (data.tracks && data.tracks.track) {
      const trackList = Array.isArray(data.tracks.track) ? data.tracks.track : [data.tracks.track];
      
      for (const track of trackList) {
        tracks.push(this.mapLastFMTrackToTrack(track));
      }
    }
    
    this.logger.info(`📋 Parsed ${tracks.length} top tracks`);
    return tracks;
  }
  
  private parseUserTopTracks(data: any): Track[] {
    const tracks: Track[] = [];
    
    if (data.toptracks && data.toptracks.track) {
      const trackList = Array.isArray(data.toptracks.track) ? data.toptracks.track : [data.toptracks.track];
      
      for (const track of trackList) {
        tracks.push(this.mapLastFMTrackToTrack(track));
      }
    }
    
    this.logger.info(`📋 Parsed ${tracks.length} user top tracks`);
    return tracks;
  }
  
  private parseLovedTracks(data: any): Track[] {
    const tracks: Track[] = [];
    
    if (data.lovedtracks && data.lovedtracks.track) {
      const trackList = Array.isArray(data.lovedtracks.track) ? data.lovedtracks.track : [data.lovedtracks.track];
      
      for (const track of trackList) {
        tracks.push(this.mapLastFMTrackToTrack(track));
      }
    }
    
    this.logger.info(`📋 Parsed ${tracks.length} loved tracks`);
    return tracks;
  }
  
  private parseSimilarTracks(data: any): Track[] {
    const tracks: Track[] = [];
    
    if (data.similartracks && data.similartracks.track) {
      const trackList = Array.isArray(data.similartracks.track) ? data.similartracks.track : [data.similartracks.track];
      
      for (const track of trackList) {
        tracks.push(this.mapLastFMTrackToTrack(track));
      }
    }
    
    this.logger.info(`📋 Parsed ${tracks.length} similar tracks`);
    return tracks;
  }
  
  private mapLastFMTrackToTrack(lastfmTrack: LastFMTrack): Track {
    return {
      title: lastfmTrack.name,
      artist: typeof lastfmTrack.artist === 'string' ? lastfmTrack.artist : lastfmTrack.artist['#text'],
      album: lastfmTrack.album?.['#text'],
      url: lastfmTrack.url,
      duration: lastfmTrack.duration ? parseInt(lastfmTrack.duration) : undefined
    };
  }
}