<div align="center">

<img src="resources/icon.png" alt="Logo d’Aether" width="112" />

# Aether

**Un poste de travail Windows pour Claude Code.**
Plusieurs conversations, vos limites d’usage sous les yeux, un pilote GPT qui enchaîne les tâches,
des branches isolées jusqu’à la pull request, et des mods pour façonner l’interface.

![Windows](https://img.shields.io/badge/Windows-11-0078D4?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-211%20unitaires-6E9F7B)

[Fonctionnalités](#fonctionnalités) · [Installation](#installation) · [Développement](#développement) · [Architecture](#architecture) · [Guide complet](docs/GUIDE.md)

</div>

---

Aether ne remplace pas Claude Code : il le pilote. Le **moteur officiel Claude Code** installé sur votre machine reste seul responsable de l’intelligence, des outils, des permissions, des sessions et de l’authentification. Aether s’y branche par le [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) et apporte tout ce qui rend le travail quotidien plus confortable.

## Fonctionnalités

### 💬 Conversations

- **Plusieurs conversations en parallèle**, une session Claude Code chacune, avec recherche, archives et reprise des **sessions Claude Code existantes** (sans jamais toucher à leurs fichiers).
- **Streaming** du texte, de la réflexion et des outils, avec un résumé de chaque tour (durée, tokens).
- **Questions de Claude** dans une vraie fenêtre de choix, **validation du plan** en Markdown, **liste de tâches** cochée et épinglée au-dessus de la saisie.
- **File de messages** comme dans Claude Code : écrivez pendant que Claude travaille, il lit le message à sa prochaine étape. *Alt+Entrée* l’interrompt et envoie tout de suite.
- **Saisie riche** : images collées ou glissées, mentions `@fichier` avec autocomplétion, **effort de réflexion** par conversation, modèle et mode de permission à la volée.

### 🧭 Suivre ce que Claude change

- Panneau **Modifications** : fichiers touchés, lignes ajoutées et retirées, diff de chaque fichier.
- **Visionneuse** de fichiers en lecture seule, ouverte depuis les outils de Claude.
- **Retour arrière** : remettez les fichiers dans leur état d’avant n’importe quel message, après avoir vu la liste de ce qui change.

### 🌿 Branches et pull requests

- **Conversations isolées** : chacune dans son propre worktree git et sa propre branche, pour que deux conversations ne se marchent jamais dessus.
- **Push** (jamais forcé, jamais sur la branche principale), **ouverture de PR**, suivi de la **CI** et bouton *Faire corriger par Claude* quand une vérification échoue (avec [GitHub CLI](https://cli.github.com/)).

### 📊 Limites d’usage

- Jauges **session de 5 heures** et **semaine**, avec l’heure de remise à zéro, d’après les seuls chiffres de Claude Code.
- **Pause automatique** quand une limite est atteinte et **reprise** à l’heure annoncée, sans jamais relancer une requête refusée.
- Tableau de bord de la consommation de tokens, distinct des quotas.

### 🧑‍✈️ Pilote Codex

Donnez un objectif : **GPT** (via Codex CLI, en lecture seule) choisit la tâche suivante, **Claude** l’exécute, **Aether** lance vos vérifications, puis GPT juge et enchaîne. La boucle se met en pause sur la moindre erreur, question ou boucle infinie. Elle peut commiter et pousser sur une branche dédiée, avec détection des secrets avant chaque commit.

### 🧩 Mods

Étendez l’interface avec de simples pages HTML/CSS/JS, isolées dans un bac à sable sans accès au réseau ni à Node.js :

- des **panneaux** ancrés, flottants, sous la liste des conversations, au-dessus de la saisie, ou en page entière ;
- des **commandes** `/nom`, et des **permissions** explicites pour lire l’activité, les limites ou le dépôt git, ou pour agir (toujours avec votre accord) ;
- un **rechargement à chaud** : modifiez les fichiers d’un mod, son panneau se recharge aussitôt.

Mods intégrés : **Arbo** (`/arbo`, graphe git) et **Limites Claude**. Le guide décrit [comment écrire un mod](docs/GUIDE.md#écrire-un-mod).

### 🪟 Et aussi

Panneaux déplaçables (terminal intégré, ChatGPT, pilote, modifications), deux thèmes sombres, notifications Windows.

## Installation

1. Installez **Claude Code** et connectez-vous :

   ```powershell
   irm https://claude.ai/install.ps1 | iex
   claude auth login
   ```

2. Construisez l’installateur (voir [Développement](#développement)) puis lancez `dist\Aether-Setup-<version>.exe`.
   L’installateur n’est pas signé : Windows SmartScreen affichera un avertissement.

Facultatif :
- [GitHub CLI](https://cli.github.com/) (`winget install GitHub.cli`, puis `gh auth login`) pour créer les PR et suivre la CI depuis Aether ;
- [Codex CLI](https://github.com/openai/codex) pour le pilote.

Aether détecte Claude Code tout seul, et vous guide s’il est absent. Il ne voit, ne stocke ni ne transmet aucun identifiant : la connexion reste celle de Claude Code.

## Développement

Prérequis : Node.js 22 et Windows. pnpm est lancé via `npx`, rien à installer globalement.

```bash
npx -y pnpm@10 install
npx -y pnpm@10 dev          # application en mode développement
```

| Commande | Rôle |
| --- | --- |
| `npx -y pnpm@10 typecheck` | TypeScript strict (main, renderer, e2e) |
| `npx -y pnpm@10 lint` | ESLint |
| `npx -y pnpm@10 test` | Tests unitaires et d’intégration (Vitest) |
| `npx -y pnpm@10 build` | Build de production dans `out/` |
| `npx -y pnpm@10 test:e2e` | Tests d’interface Playwright (après le build) |
| `npx -y pnpm@10 package` | Installateur Windows dans `dist/` |

## Architecture

```
src/
  shared/        Types, contrat IPC (zod), protocole moteur, logique pure et testée
  main/          Processus principal : base SQLite, quotas, pilote, git, mods, services
  engine-host/   Processus isolé, le seul à appeler le Claude Agent SDK
  preload/       Pont minimal window.aether (liste blanche)
  renderer/      Interface React 19, Tailwind 4, Zustand
resources/
  mods/          Mods intégrés (Arbo, Limites Claude)
  mods-sdk/      Pont aether-mod.js servi aux panneaux des mods
tests/           Vitest (unitaires) et Playwright (interface)
docs/GUIDE.md    Guide complet
```

Chaque action suit le même chemin : interface → IPC validé (zod + origine de l’appelant) → processus principal → hôte moteur isolé → SDK → **Claude Code installé**. Un plantage du moteur ne ferme pas l’application : l’hôte redémarre tout seul.

## Sécurité et vie privée

- Electron verrouillé : `contextIsolation`, `sandbox`, pas de Node.js dans l’interface, IPC en liste blanche validé des deux côtés, CSP stricte, navigation bloquée.
- Aucun identifiant manipulé par Aether, ni jeton GitHub, ni cookie ChatGPT. La session ChatGPT est isolée de tout le reste.
- Les historiques de Claude Code ne sont jamais modifiés. La base locale (`%APPDATA%\Aether`) est sauvegardée avant chaque migration.
- Rien de destructeur sans confirmation : push, retour arrière, suppression d’un worktree, commande envoyée par un mod.

## Limites connues

- Windows uniquement ; pas de mise à jour automatique ; installateur non signé.
- Les conversations de Claude Desktop et de claude.ai ne sont pas accessibles : seules les sessions Claude Code locales le sont.
- La lecture des limites d’usage passe par une API du SDK marquée **expérimentale** par Anthropic : elle peut changer.
- Les panneaux des mods Claude Code (`$.ui.open`) ne peuvent pas encore s’afficher dans Aether.

La liste complète et le détail de chaque fonction se trouvent dans le [guide](docs/GUIDE.md).

---

<div align="center">
<sub>Aether n’est pas un produit d’Anthropic ni d’OpenAI. Claude et Claude Code sont des marques d’Anthropic ; ChatGPT et Codex sont des marques d’OpenAI.</sub>
</div>
