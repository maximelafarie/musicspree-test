#!/bin/bash

# Script pour push manuel sur Docker Hub
# Usage: ./scripts/docker-push.sh [tag]

set -e

# Configuration
DOCKER_USERNAME=${DOCKER_USERNAME:-"votre-username"}
IMAGE_NAME="musicspree"
DEFAULT_TAG="latest"

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
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

# Vérifier les prérequis
check_prerequisites() {
    print_info "Vérification des prérequis..."
    
    if ! command -v docker &> /dev/null; then
        print_error "Docker n'est pas installé"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        print_error "Docker n'est pas démarré"
        exit 1
    fi
    
    print_success "Prérequis OK"
}

# Login Docker Hub
docker_login() {
    print_info "Connexion à Docker Hub..."
    
    if [ -z "$DOCKER_PASSWORD" ] && [ -z "$DOCKER_TOKEN" ]; then
        print_warning "Variables DOCKER_PASSWORD ou DOCKER_TOKEN non définies"
        print_info "Connexion interactive..."
        docker login
    elif [ -n "$DOCKER_TOKEN" ]; then
        echo "$DOCKER_TOKEN" | docker login --username "$DOCKER_USERNAME" --password-stdin
    else
        echo "$DOCKER_PASSWORD" | docker login --username "$DOCKER_USERNAME" --password-stdin
    fi
    
    print_success "Connexion Docker Hub OK"
}

# Build de l'image
build_image() {
    local tag=${1:-$DEFAULT_TAG}
    local full_tag="$DOCKER_USERNAME/$IMAGE_NAME:$tag"
    
    print_info "Construction de l'image: $full_tag"
    
    # Build multi-platform
    docker buildx create --use --name musicspree-builder 2>/dev/null || true
    
    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        --tag "$full_tag" \
        --push \
        --build-arg VERSION="$tag" \
        --build-arg COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')" \
        .
    
    print_success "Image construite et pushée: $full_tag"
}

# Build de plusieurs tags
build_multiple_tags() {
    local version=${1:-$DEFAULT_TAG}
    
    # Tag principal
    build_image "$version"
    
    # Tag latest si c'est une version
    if [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        print_info "Version détectée, création du tag 'latest'"
        
        # Re-tag et push latest
        local versioned_tag="$DOCKER_USERNAME/$IMAGE_NAME:$version"
        local latest_tag="$DOCKER_USERNAME/$IMAGE_NAME:latest"
        
        docker buildx build \
            --platform linux/amd64,linux/arm64 \
            --tag "$latest_tag" \
            --push \
            --build-arg VERSION="$version" \
            --build-arg COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')" \
            .
        
        print_success "Tag 'latest' créé"
    fi
}

# Nettoyage
cleanup() {
    print_info "Nettoyage..."
    docker buildx rm musicspree-builder 2>/dev/null || true
    print_success "Nettoyage terminé"
}

# Fonction principale
main() {
    local tag=${1:-$DEFAULT_TAG}
    
    echo "🐳 MusicSpree Docker Push"
    echo "=========================="
    
    check_prerequisites
    docker_login
    build_multiple_tags "$tag"
    cleanup
    
    print_success "Push Docker terminé avec succès!"
    print_info "Image disponible: docker pull $DOCKER_USERNAME/$IMAGE_NAME:$tag"
}

# Gestion des erreurs
trap cleanup EXIT

# Point d'entrée
main "$@"