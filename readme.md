# 🎵 MusicSpree

MusicSpree est un orchestrateur automatisé qui synchronise vos recommandations LastFM avec votre stack musicale (Navidrome, Slskd, Beets). Il télécharge automatiquement les morceaux manquants et les organise dans des playlists Navidrome.

## ✨ Fonctionnalités

- 🎯 **Recommandations LastFM** : Récupère automatiquement vos recommandations LastFM
- 📥 **Téléchargement automatique** : Utilise Slskd pour télécharger les morceaux manquants
- 🏷️ **Métadonnées automatiques** : Traite les fichiers avec Beets pour les métadonnées
- 📝 **Playlists synchronisées** : Crée/met à jour automatiquement les playlists Navidrome
- ⚡ **Smart déduplication** : Évite de retélécharger les morceaux existants
- 🔄 **Synchronisation programmée** : Exécution automatique via cron
- 🛠️ **CLI complet** : Interface en ligne de commande pour toutes les opérations

## 🏗️ Architecture

```
LastFM API ──► MusicSpree ──► Slskd (téléchargement)
                   │              │
                   ▼              ▼
               Navidrome ◄── Beets (métadonnées)
               (playlists)
```

## 🚀 Installation

### Avec Docker Compose (Recommandé)

1. **Cloner le projet**
```bash
git clone https://github.com/votre-username/musicspree
cd musicspree
```

2. **Configuration**
```bash
cp .env.example .env
# Éditer .env avec vos configurations
```

3. **Lancer les services**
```bash
docker-compose up -d
```

### Installation manuelle

1. **Prérequis**
```bash
node >= 20
npm >= 9
```

2. **Installation**
```bash
npm install
npm run build
```

3. **Configuration**
```bash
cp .env.example .env
# Configurer les variables d'environnement
```

4. **Lancement**
```bash
npm start
```

## ⚙️ Configuration

### Variables d'environnement principales

```bash
# LastFM API
LASTFM_API_KEY=your_api_key
LASTFM_USERNAME=your_username
LASTFM_SHARED_SECRET=your_shared_secret

# Navidrome
NAVIDROME_URL=http://navidrome:4533
NAVIDROME_USERNAME=admin
NAVIDROME_PASSWORD=your_password

# Soulseek
SLSKD_URL=http://slskd:5030
SLSKD_API_KEY=your_api_key

# Beets
BEETS_URL=http://beets:8337

# Planification
CRON_SCHEDULE=0 */6 * * *  # Toutes les 6 heures

# Options
PLAYLIST_NAME=LastFM Recommendations
CLEAN_PLAYLISTS_ON_REFRESH=true
KEEP_DOWNLOADED_TRACKS=true
MAX_DOWNLOAD_RETRIES=5
```

### Configuration des services

#### LastFM
1. Créer un compte API sur [LastFM API](https://www.last.fm/api)
2. Récupérer votre API Key et Shared Secret
3. Renseigner votre username LastFM

#### Navidrome
- Configurer un utilisateur admin
- S'assurer que l'API est activée
- Le service doit être accessible depuis le conteneur MusicSpree

#### Slskd
- Configurer les credentials Soulseek
- Activer l'API avec une clé
- Configurer le répertoire de téléchargement

#### Beets
- Configuration automatique via le conteneur
- Plugin web optionnel pour l'API HTTP

## 🎛️ Interface CLI

MusicSpree fournit une interface en ligne de commande complète :

### Commandes principales

```bash
# Exécuter une synchronisation complète
spree:sync

# Simulation (dry run) - voir ce qui serait téléchargé
spree:dry

# Vider la playlist actuelle
spree:clear

# Voir le statut des services
spree:status

# Tester les connexions
spree:test

# Voir les logs
spree:logs --tail 100

# Statistiques de la bibliothèque
spree:stats

# Configuration actuelle
spree:config

# Import manuel Beets
spree:import

# Nettoyage des répertoires vides
spree:cleanup
```

### Exemples d'utilisation

```bash
# Vérifier ce qui serait téléchargé
docker exec -it musicspree spree:dry

# Forcer une synchronisation
docker exec -it musicspree spree:sync

# Suivre les logs en temps réel
docker exec -it musicspree spree:logs --follow

# Vider la playlist sans confirmation
docker exec -it musicspree spree:clear --force
```

## 📊 Monitoring

### Logs

Les logs sont disponibles via :
- CLI : `spree:logs`
- Fichier : `/app/data/musicspree.log` (dans le conteneur)
- Docker : `docker logs musicspree`

### Métriques

Le service expose des informations sur :
- Nombre de recommandations traitées
- Succès/échecs de téléchargement
- Temps d'exécution
- Erreurs de connexion

## 🔧 Personnalisation

### Logique de recommandations

Vous pouvez modifier `src/services/LastFMService.ts` pour changer la source des recommandations :
- Top tracks utilisateur
- Tracks similaires
- Charts globaux
- Tracks aimés

### Critères de téléchargement

Dans `src/services/SlskdService.ts`, personnalisez :
- Qualité audio minimale
- Formats acceptés
- Algorithme de sélection

### Traitement Beets

Configurez le traitement des métadonnées dans `src/services/BeetsService.ts` :
- Auto-tagging
- Organisation des fichiers
- Formats de nommage

## 🐛 Dépannage

### Problèmes courants

#### Connexion LastFM échoue
```bash
# Vérifier les credentials
spree:test

# Logs détaillés
LOG_LEVEL=debug spree:sync
```

#### Téléchargements échouent
```bash
# Vérifier Slskd
curl http://localhost:5030/api/v0/session

# Augmenter les tentatives
MAX_DOWNLOAD_RETRIES=10
```

#### Navidrome ne trouve pas les tracks
```bash
# Forcer l'import Beets
spree:import

# Rescan Navidrome
# Via l'interface web ou API
```

### Logs de débogage

```bash
# Activer les logs détaillés
LOG_LEVEL=debug

# Logs spécifiques
docker logs musicspree | grep ERROR
docker logs musicspree | grep "Failed to"
```

## 🔒 Sécurité

### Recommandations

1. **Variables d'environnement** : Ne jamais commiter les fichiers `.env`
2. **Réseau** : Utiliser un réseau Docker privé
3. **Volumes** : Permissions appropriées sur les volumes
4. **API Keys** : Rotation régulière des clés API

### Réseau

```yaml
# Configuration réseau sécurisée
networks:
  musicspree-network:
    driver: bridge
    internal: true  # Réseau interne uniquement
```

## 🚦 Performance

### Optimisations

#### Téléchargements
```bash
# Augmenter la concurrence
CONCURRENT_DOWNLOADS=5

# Réduire les timeouts
DOWNLOAD_TIMEOUT_MINUTES=5
```

#### Synchronisation
```bash
# Fréquence de sync adaptée
CRON_SCHEDULE="0 */12 * * *"  # 2x par jour

# Dry run régulier
CRON_SCHEDULE="0 */2 * * *"   # Toutes les 2h
```

### Monitoring des ressources

```bash
# Usage CPU/RAM
docker stats musicspree

# Espace disque
docker exec musicspree df -h

# Logs de performance
spree:stats
```

## 🔄 Maintenance

### Sauvegardes

```bash
# Sauvegarder les données
docker run --rm -v musicspree_music:/data -v $(pwd):/backup alpine tar czf /backup/music-backup.tar.gz /data

# Sauvegarder les playlists Navidrome
docker exec navidrome sqlite3 /data/navidrome.db ".backup /data/backup.db"
```

### Mises à jour

```bash
# Mise à jour MusicSpree
git pull origin main
docker-compose build musicspree
docker-compose up -d musicspree

# Mise à jour services
docker-compose pull
docker-compose up -d
```

### Nettoyage

```bash
# Nettoyer les téléchargements échoués
spree:cleanup

# Nettoyer Docker
docker system prune -a

# Nettoyer les logs
truncate -s 0 /app/data/musicspree.log
```

## 🤝 Contribution

### Développement

```bash
# Mode développement
npm run dev

# Tests de type
npm run type-check

# Build de production
npm run build
```

### Structure du projet

```
src/
├── config/         # Configuration
├── core/          # Logique principale
├── services/      # Services externes
├── types/         # Définitions TypeScript
├── utils/         # Utilitaires
├── cli.ts         # Interface CLI
└── index.ts       # Point d'entrée
```

### Guidelines

1. **TypeScript** : Typage strict obligatoire
2. **Logging** : Utiliser Winston avec niveaux appropriés
3. **Erreurs** : Gestion gracieuse avec retry
4. **Tests** : Couvrir les fonctions critiques

## 📋 Roadmap

### Version 1.1
- [ ] Interface web simple
- [ ] Webhooks pour notifications
- [ ] Support multi-utilisateurs
- [ ] Métriques Prometheus

### Version 1.2
- [ ] Plugin system
- [ ] Sources multiples (Spotify, etc.)
- [ ] Intelligence artificielle pour recommandations
- [ ] Cache intelligent

### Version 2.0
- [ ] Interface web complète
- [ ] API REST publique
- [ ] Support Kubernetes
- [ ] Clustering multi-nœuds

## 📜 Licence

MIT License - voir [LICENSE](LICENSE) pour les détails.

## 🙏 Remerciements

- [Navidrome](https://www.navidrome.org/) - Serveur de streaming musical
- [slskd](https://github.com/slskd/slskd) - Client Soulseek moderne
- [Beets](https://beets.io/) - Gestionnaire de bibliothèque musicale
- [LastFM](https://www.last.fm/) - Service de recommandations musicales

## 📞 Support

- **Issues** : [GitHub Issues](https://github.com/votre-username/musicspree/issues)
- **Discussions** : [GitHub Discussions](https://github.com/votre-username/musicspree/discussions)
- **Documentation** : [Wiki](https://github.com/votre-username/musicspree/wiki)

---

**🎵 Fait avec ❤️ pour les mélomanes**