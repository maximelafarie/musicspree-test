# MusicSpree Makefile
# Commandes utiles pour le développement et le déploiement

.PHONY: help install build dev test clean docker-build docker-up docker-down logs cli

# Configuration par défaut
DOCKER_IMAGE = musicspree
DOCKER_TAG = latest
CONTAINER_NAME = musicspree

# Couleurs pour l'affichage
GREEN = \033[0;32m
YELLOW = \033[1;33m
RED = \033[0;31m
NC = \033[0m # No Color

help: ## Afficher cette aide
	@echo "🎵 MusicSpree - Commandes disponibles:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Installer les dépendances
	@echo "$(GREEN)📦 Installation des dépendances...$(NC)"
	npm ci
	@echo "$(GREEN)✅ Dépendances installées$(NC)"

build: ## Construire l'application
	@echo "$(GREEN)🔨 Construction de l'application...$(NC)"
	npm run type-check
	npm run build
	@echo "$(GREEN)✅ Application construite$(NC)"

dev: ## Lancer en mode développement
	@echo "$(GREEN)🚀 Lancement en mode développement...$(NC)"
	npm run dev

test: ## Exécuter les tests
	@echo "$(GREEN)🧪 Exécution des tests...$(NC)"
	npm run type-check
	@echo "$(GREEN)✅ Tests passés$(NC)"

clean: ## Nettoyer les fichiers temporaires
	@echo "$(YELLOW)🧹 Nettoyage...$(NC)"
	rm -rf dist/
	rm -rf node_modules/
	rm -rf data/*.log
	@echo "$(GREEN)✅ Nettoyage terminé$(NC)"

# Commandes Docker

docker-build: ## Construire l'image Docker
	@echo "$(GREEN)🐳 Construction de l'image Docker...$(NC)"
	docker build -t $(DOCKER_IMAGE):$(DOCKER_TAG) .
	@echo "$(GREEN)✅ Image Docker construite$(NC)"

docker-up: ## Lancer tous les services avec Docker Compose
	@echo "$(GREEN)🚀 Lancement des services Docker...$(NC)"
	docker-compose up -d
	@echo "$(GREEN)✅ Services lancés$(NC)"
	@echo "$(YELLOW)📋 Services disponibles:$(NC)"
	@echo "  - MusicSpree: http://localhost:3000"
	@echo "  - Navidrome: http://localhost:4533"
	@echo "  - Slskd: http://localhost:5030"
	@echo "  - Beets: http://localhost:8337"

docker-down: ## Arrêter tous les services Docker
	@echo "$(YELLOW)🛑 Arrêt des services Docker...$(NC)"
	docker-compose down
	@echo "$(GREEN)✅ Services arrêtés$(NC)"

docker-restart: docker-down docker-up ## Redémarrer tous les services

docker-logs: ## Voir les logs de MusicSpree
	@echo "$(GREEN)📄 Logs de MusicSpree:$(NC)"
	docker logs -f $(CONTAINER_NAME)

docker-shell: ## Ouvrir un shell dans le conteneur MusicSpree
	@echo "$(GREEN)🐚 Ouverture du shell dans MusicSpree...$(NC)"
	docker exec -it $(CONTAINER_NAME) /bin/bash

# Commandes CLI

cli-help: ## Afficher l'aide CLI
	docker exec -it $(CONTAINER_NAME) spree:help

cli-sync: ## Exécuter une synchronisation complète
	@echo "$(GREEN)🎵 Synchronisation en cours...$(NC)"
	docker exec -it $(CONTAINER_NAME) spree:sync

cli-dry: ## Simulation de synchronisation
	@echo "$(GREEN)🏃‍♂️ Simulation en cours...$(NC)"
	docker exec -it $(CONTAINER_NAME) spree:dry

cli-status: ## Voir le statut des services
	@echo "$(GREEN)📊 Statut des services:$(NC)"
	docker exec -it $(CONTAINER_NAME) spree:status

cli-clear: ## Vider la playlist
	@echo "$(YELLOW)🗑️ Vidage de la playlist...$(NC)"
	docker exec -it $(CONTAINER_NAME) spree:clear

cli-test: ## Tester les connexions
	@echo "$(GREEN)🧪 Test des connexions...$(NC)"
	docker exec -it $(CONTAINER_NAME) spree:test

cli-logs: ## Voir les logs applicatifs
	@echo "$(GREEN)📄 Logs applicatifs:$(NC)"
	docker exec -it $(CONTAINER_NAME) spree:logs --tail 50

cli-stats: ## Statistiques de la bibliothèque
	@echo "$(GREEN)📊 Statistiques:$(NC)"
	docker exec -it $(CONTAINER_NAME) spree:stats

# Commandes de maintenance

backup: ## Sauvegarder les données importantes
	@echo "$(GREEN)💾 Sauvegarde en cours...$(NC)"
	mkdir -p ./backups
	docker run --rm \
		-v musicspree_music:/data/music \
		-v musicspree_navidrome-data:/data/navidrome \
		-v $(PWD)/backups:/backup \
		alpine tar czf /backup/musicspree-backup-$(shell date +%Y%m%d-%H%M%S).tar.gz /data
	@echo "$(GREEN)✅ Sauvegarde terminée$(NC)"

restore: ## Restaurer depuis une sauvegarde (BACKUP_FILE=path/to/backup.tar.gz)
	@if [ -z "$(BACKUP_FILE)" ]; then \
		echo "$(RED)❌ Veuillez spécifier BACKUP_FILE=path/to/backup.tar.gz$(NC)"; \
		exit 1; \
	fi
	@echo "$(YELLOW)🔄 Restauration depuis $(BACKUP_FILE)...$(NC)"
	docker run --rm \
		-v musicspree_music:/data/music \
		-v musicspree_navidrome-data:/data/navidrome \
		-v $(PWD)/backups:/backup \
		alpine tar xzf /backup/$(BACKUP_FILE) -C /
	@echo "$(GREEN)✅ Restauration terminée$(NC)"

update: ## Mettre à jour MusicSpree
	@echo "$(GREEN)🔄 Mise à jour de MusicSpree...$(NC)"
	git pull origin main
	make docker-build
	make docker-down
	make docker-up
	@echo "$(GREEN)✅ Mise à jour terminée$(NC)"

health-check: ## Vérifier la santé de tous les services
	@echo "$(GREEN)🏥 Vérification de la santé des services...$(NC)"
	@echo "$(YELLOW)MusicSpree:$(NC)"
	@docker exec $(CONTAINER_NAME) spree:test || echo "$(RED)❌ MusicSpree KO$(NC)"
	@echo "$(YELLOW)Navidrome:$(NC)"
	@curl -sf http://localhost:4533/ping > /dev/null && echo "$(GREEN)✅ Navidrome OK$(NC)" || echo "$(RED)❌ Navidrome KO$(NC)"
	@echo "$(YELLOW)Slskd:$(NC)"
	@curl -sf http://localhost:5030/api/v0/session > /dev/null && echo "$(GREEN)✅ Slskd OK$(NC)" || echo "$(RED)❌ Slskd KO$(NC)"

monitor: ## Surveiller les ressources système
	@echo "$(GREEN)📊 Monitoring des ressources:$(NC)"
	docker stats --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"

# Commandes de développement

dev-setup: ## Configuration de l'environnement de développement
	@echo "$(GREEN)🛠️ Configuration de l'environnement de développement...$(NC)"
	@if [ ! -f .env ]; then \
		echo "$(YELLOW)📝 Création du fichier .env...$(NC)"; \
		cp .env.example .env; \
		echo "$(YELLOW)⚠️  Veuillez éditer le fichier .env avec vos configurations$(NC)"; \
	fi
	make install
	@echo "$(GREEN)✅ Environnement de développement configuré$(NC)"

dev-reset: clean dev-setup ## Reset complet de l'environnement de dev

lint: ## Vérifier le code (linting)
	@echo "$(GREEN)🔍 Vérification du code...$(NC)"
	npm run type-check
	@echo "$(GREEN)✅ Code vérifié$(NC)"

# Targets par défaut
.DEFAULT_GOAL := help