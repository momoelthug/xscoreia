# xScore IA — version GitHub

Site de pronostics foot qui se met à jour tout seul, gratuitement :
- **GitHub Actions** lance `scripts/update.mjs` toutes les heures (à la 7e minute) ;
- **GitHub Pages** héberge le site (`public/index.html` + les fichiers JSON générés) ;
- les données sont gardées d'un passage à l'autre dans le cache de GitHub Actions.

Sources : football-data.org (12 grandes compétitions), Highlightly (les autres championnats), API-Football (hier, aujourd'hui, demain, et cotes).

## Installation (une seule fois)

1. Le dépôt doit être **public** (GitHub Pages et GitHub Actions sont gratuits et illimités pour les dépôts publics). Tes clés ne sont jamais dans le code : elles sont rangées dans les secrets.
2. **Settings → Secrets and variables → Actions → New repository secret**, trois fois :
   - `API_FOOTBALL_KEY`
   - `FOOTBALL_DATA_KEY`
   - `HIGHLIGHTLY_KEY`
3. **Settings → Pages → Build and deployment → Source : GitHub Actions**.
4. **Actions → Mise à jour des pronos → Run workflow** pour lancer la première mise à jour.

Le site est ensuite à l'adresse `https://TON-PSEUDO.github.io/xscoreia/`.

## Mise à jour manuelle

**Actions → Mise à jour des pronos → Run workflow.**

## Nom de domaine (plus tard)

1. **Settings → Secrets and variables → Actions → onglet Variables → New repository variable** : `CUSTOM_DOMAIN` = `xscoreia.com`.
2. **Settings → Pages → Custom domain** : `xscoreia.com`, puis suis les instructions DNS de GitHub chez ton registraire.

## Bon à savoir

- GitHub peut décaler les mises à jour programmées de quelques minutes quand ses serveurs sont chargés.
- Sur un dépôt public, GitHub suspend les tâches programmées après 60 jours sans aucune modification du dépôt : un petit changement de temps en temps (même dans ce README) suffit à les garder actives.
