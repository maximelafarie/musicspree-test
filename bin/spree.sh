#!/bin/bash

# MusicSpree CLI Script
# This script provides command-line interface for MusicSpree operations

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

# Load environment variables
if [ -f "$APP_DIR/.env" ]; then
    source "$APP_DIR/.env"
fi

# Helper functions
print_header() {
    echo -e "${PURPLE}🎵 MusicSpree CLI${NC}"
    echo -e "${PURPLE}==================${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Command implementations
cmd_help() {
    print_header
    echo
    echo -e "${CYAN}Available commands:${NC}"
    echo
    echo -e "  ${GREEN}spree:sync${NC}        - Run full sync process"
    echo -e "  ${GREEN}spree:dry${NC}         - Dry run (show what would be downloaded)"
    echo -e "  ${GREEN}spree:clear${NC}       - Clear/delete the current playlist"
    echo -e "  ${GREEN}spree:status${NC}      - Show service status and configuration"
    echo -e "  ${GREEN}spree:test${NC}        - Test all service connections"
    echo -e "  ${GREEN}spree:logs${NC}        - Show recent logs"
    echo -e "  ${GREEN}spree:stats${NC}       - Show library statistics"
    echo -e "  ${GREEN}spree:config${NC}      - Show current configuration"
    echo -e "  ${GREEN}spree:import${NC}      - Manually trigger beets import"
    echo -e "  ${GREEN}spree:cleanup${NC}     - Cleanup empty directories"
    echo
    echo -e "${CYAN}Examples:${NC}"
    echo -e "  spree:dry                  # See what would be downloaded"
    echo -e "  spree:sync                 # Run full sync"
    echo -e "  spree:clear                # Clear playlist"
    echo -e "  spree:logs --tail 50       # Show last 50 log lines"
    echo
}

cmd_sync() {
    print_header
    print_info "Starting full sync process..."
    
    node "$APP_DIR/dist/cli.js" sync "$@"
}

cmd_dry() {
    print_header
    print_info "Running dry run..."
    
    node "$APP_DIR/dist/cli.js" dry "$@"
}

cmd_clear() {
    print_header
    print_warning "This will delete the current playlist: $PLAYLIST_NAME"
    
    if [ "$1" != "--force" ] && [ "$1" != "-f" ]; then
        echo -n "Are you sure? (y/N): "
        read -r confirm
        if [[ ! $confirm =~ ^[Yy]$ ]]; then
            print_info "Operation cancelled"
            exit 0
        fi
    fi
    
    node "$APP_DIR/dist/cli.js" clear "$@"
}

cmd_status() {
    print_header
    print_info "Checking service status..."
    
    node "$APP_DIR/dist/cli.js" status "$@"
}

cmd_test() {
    print_header
    print_info "Testing service connections..."
    
    node "$APP_DIR/dist/cli.js" test "$@"
}

cmd_logs() {
    print_header
    
    local tail_lines=100
    local follow=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --tail)
                tail_lines="$2"
                shift 2
                ;;
            --follow|-f)
                follow=true
                shift
                ;;
            *)
                shift
                ;;
        esac
    done
    
    if [ -f "$APP_DIR/data/musicspree.log" ]; then
        if [ "$follow" = true ]; then
            print_info "Following logs (Ctrl+C to stop)..."
            tail -f -n "$tail_lines" "$APP_DIR/data/musicspree.log"
        else
            print_info "Showing last $tail_lines log lines..."
            tail -n "$tail_lines" "$APP_DIR/data/musicspree.log"
        fi
    else
        print_warning "Log file not found at $APP_DIR/data/musicspree.log"
        print_info "Container logs:"
        docker logs musicspree --tail "$tail_lines" 2>/dev/null || echo "Container not found or not accessible"
    fi
}

cmd_stats() {
    print_header
    print_info "Fetching library statistics..."
    
    node "$APP_DIR/dist/cli.js" stats "$@"
}

cmd_config() {
    print_header
    print_info "Current configuration:"
    echo
    
    # Show sanitized config (hide sensitive data)
    echo -e "${CYAN}LastFM:${NC}"
    echo -e "  API Key: ${LASTFM_API_KEY:0:8}***"
    echo -e "  Username: $LASTFM_USERNAME"
    echo
    echo -e "${CYAN}Navidrome:${NC}"
    echo -e "  URL: $NAVIDROME_URL"
    echo -e "  Username: $NAVIDROME_USERNAME"
    echo
    echo -e "${CYAN}Slskd:${NC}"
    echo -e "  URL: $SLSKD_URL"
    echo -e "  API Key: ${SLSKD_API_KEY:0:8}***"
    echo
    echo -e "${CYAN}Beets:${NC}"
    echo -e "  URL: $BEETS_URL"
    echo -e "  Config Path: $BEETS_CONFIG_PATH"
    echo
    echo -e "${CYAN}Settings:${NC}"
    echo -e "  Cron Schedule: $CRON_SCHEDULE"
    echo -e "  Playlist Name: $PLAYLIST_NAME"
    echo -e "  Clean on Refresh: $CLEAN_PLAYLISTS_ON_REFRESH"
    echo -e "  Keep Downloaded: $KEEP_DOWNLOADED_TRACKS"
    echo -e "  Max Retries: $MAX_DOWNLOAD_RETRIES"
    echo -e "  Download Timeout: $DOWNLOAD_TIMEOUT_MINUTES minutes"
    echo -e "  Concurrent Downloads: $CONCURRENT_DOWNLOADS"
    echo -e "  Log Level: $LOG_LEVEL"
}

cmd_import() {
    print_header
    print_info "Manually triggering beets import..."
    
    node "$APP_DIR/dist/cli.js" import "$@"
}

cmd_cleanup() {
    print_header
    print_info "Cleaning up empty directories..."
    
    node "$APP_DIR/dist/cli.js" cleanup "$@"
}

# Main command dispatcher
main() {
    local command=""
    
    if [ $# -eq 0 ]; then
        cmd_help
        exit 0
    fi
    
    command="$1"
    shift
    
    case "$command" in
        sync|spree:sync)
            cmd_sync "$@"
            ;;
        dry|spree:dry)
            cmd_dry "$@"
            ;;
        clear|spree:clear)
            cmd_clear "$@"
            ;;
        status|spree:status)
            cmd_status "$@"
            ;;
        test|spree:test)
            cmd_test "$@"
            ;;
        logs|spree:logs)
            cmd_logs "$@"
            ;;
        stats|spree:stats)
            cmd_stats "$@"
            ;;
        config|spree:config)
            cmd_config "$@"
            ;;
        import|spree:import)
            cmd_import "$@"
            ;;
        cleanup|spree:cleanup)
            cmd_cleanup "$@"
            ;;
        help|spree:help|--help|-h)
            cmd_help
            ;;
        *)
            print_error "Unknown command: $command"
            echo
            cmd_help
            exit 1
            ;;
    esac
}

# Run main function
main "$@"