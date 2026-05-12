# TASSILI — Visualisation d'Itinéraires

Application de visualisation et d'optimisation d'itinéraires logistiques en Algérie.

## Fonctionnalités
- **Géocodage** : Recherche d'adresses via OpenStreetMap (Nominatim).
- **Optimisation** :
  - **TSP (Traveling Salesman Problem)** : Optimisation de tournée unique.
  - **VRP (Vehicle Routing Problem)** : Gestion de flotte avec fenêtres de temps.
- **Visualisation** :
  - Carte interactive (Leaflet).
  - Graphe dynamique des connexions.
  - Matrice de distances complète.
- **Export** :
  - Génération de code **LaTeX (TikZ)** pour l'intégration dans des documents scientifiques (mémoires, articles).
  - Sauvegarde/Chargement au format JSON.

## Installation
1. Clonez ce dépôt.
2. Ouvrez le fichier `index.html` dans n'importe quel navigateur web moderne.

## Utilisation
1. Fixez un **Dépôt central**.
2. Ajoutez des **Adresses de livraison**.
3. Cliquez sur **Calculer tous les itinéraires**.
4. Utilisez les outils d'optimisation (TSP ou VRP) selon vos besoins.
5. Exportez les résultats en LaTeX pour votre mémoire.

---
*Développé dans le cadre d'un projet de recherche logistique.*
