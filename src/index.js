import dotenv from 'dotenv';
import cron from 'node-cron';
import { MusicSpree } from './core/MusicSpree';
import { Logger } from './utils/Logger';
import { Config } from './config/Config';

// Load environment variables
dotenv.config();

async function main() {
    const logger = Logger.getInstance();
    const config = Config.getInstance();

    logger.info('🎵 MusicSpree starting up...');

    try {
        const musicSpree = new MusicSpree();

        // Validate configuration
        await musicSpree.validateConfig();

        logger.info(`📅 Scheduling cron job: ${config.cronSchedule}`);

        // Schedule the main task
        cron.schedule(config.cronSchedule, async () => {
            logger.info('🔄 Starting scheduled music sync...');
            try {
                await musicSpree.syncRecommendations();
                logger.info('✅ Scheduled sync completed successfully');
            } catch (error) {
                logger.error('❌ Scheduled sync failed:', error);
            }
        });

        // Run once on startup if not in production
        if (process.env.NODE_ENV !== 'production') {
            logger.info('🚀 Running initial sync...');
            await musicSpree.syncRecommendations();
        }

        logger.info('🎶 MusicSpree is running! Use CLI commands to interact.');

        // Keep the process alive
        process.on('SIGTERM', () => {
            logger.info('📴 Received SIGTERM, shutting down gracefully...');
            process.exit(0);
        });

        process.on('SIGINT', () => {
            logger.info('📴 Received SIGINT, shutting down gracefully...');
            process.exit(0);
        });

    } catch (error) {
        logger.error('💥 Failed to start MusicSpree:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}