# Aether — guide complet

> Présentation rapide : [README](../README.md).

Aether est une application Windows indépendante qui sert d’interface graphique au **moteur officiel Claude Code**.
Claude Code reste le moteur d’intelligence et d’exécution (outils, permissions, sessions, authentification) ;
Aether fournit l’ergonomie : conversations multiples, projets, reprise des sessions existantes, sélection du modèle,
approbations, tableau de bord de consommation et gestion automatique des limites d’usage.

> Le nom est centralisé dans `src/shared/appConfig.ts` (et `productName` / `appId` dans `package.json` et `electron-builder.yml` pour l’installateur).

---

## 1. Prérequis

| Élément | Version testée | Remarque |
|---|---|---|
| Windows | 11 Pro (26200) | |
| Claude Code CLI | 2.1.319 | **Obligatoire.** Installation : `irm https://claude.ai/install.ps1 \| iex` |
| Node.js | 22.17 | Pour développer / construire uniquement |
| pnpm | 10 (via `npx pnpm@10`) | Aucune installation globale nécessaire |

Aether **n’installe pas** Claude Code et ne suppose pas qu’il est présent : il le détecte (préférence utilisateur → `PATH` → emplacements standard)
et affiche la procédure d’installation sinon. Un exécutable personnalisé peut être choisi dans *Paramètres › Moteur*.

## 2. Démarrage rapide

```bash
npx -y pnpm@10 install
npx -y pnpm@10 dev
```

Ou double-cliquez sur `scripts\start-dev.cmd` (mode développement) / `scripts\start-prod.cmd` (build local de production).

Si `node_modules\electron\dist\electron.exe` est absent après l’installation (scripts de post-installation bloqués par pnpm) :

```bash
node node_modules/electron/install.js
```

## 3. Authentification

L’authentification reste celle de Claude Code. *Paramètres › Authentification* :

- affiche l’état réel (`claude auth status --json`) ;
- **Se connecter** ouvre la commande officielle `claude auth login` dans une fenêtre de terminal séparée ; vous terminez la connexion OAuth dans votre navigateur, puis cliquez sur *Vérifier*.

Aether ne voit, ne stocke et ne transmet aucun identifiant, cookie ni jeton. Il n’y a donc aucun secret à chiffrer côté Aether (safeStorage n’est pas utilisé faute de secret à protéger).

## 4. Fonctionnalités

### Conversations
Création, conversations multiples indépendantes (une session Claude Code par conversation, exécutées en parallèle), changement instantané,
renommage, archivage, suppression avec confirmation, recherche (titre, dossier, projet), menus contextuels.
Chaque conversation conserve son **identifiant de session Claude Code** (reçu dans `system/init`) et tout l’historique des identifiants vus (`session_mappings`).

### Dialogue avec Claude
- **Questions de Claude** (`AskUserQuestion`) : une fenêtre propose les choix, éventuellement multiples, avec leur aperçu et une réponse libre « Autre ». Ça marche aussi en mode « Tout autoriser ». « Ne pas répondre » le dit à Claude.
- **Plan** (`ExitPlanMode`, mode Planification) : le plan s’affiche en Markdown, avec trois choix :
  - *Approuver* ;
  - *Approuver + modifs auto*, qui passe aussi la conversation en « Accepter les modifications » ;
  - *Revoir le plan*, avec vos remarques transmises à Claude.
- **Tâches** (`TodoWrite`, `TaskCreate`/`TaskUpdate`) : une liste cochée dans la conversation, et un résumé épinglé au-dessus de la saisie (avancement, tâche en cours).

### Zone de saisie
- **Messages en file** (comme dans Claude Code) : pendant que Claude travaille, *Entrée* met le message en file. Il s’affiche au-dessus de la saisie, où vous pouvez le modifier (✎) ou le retirer (✕). Aether le transmet à la prochaine étape de Claude, c’est-à-dire à la fin d’un appel d’outil, et Claude le lit dans le même tour. S’il n’y a plus d’étape, il part à la fin du tour. Plusieurs messages en file partent ensemble.
- **Interrompre et envoyer** (*Alt+Entrée*, ou le bouton) : Aether arrête le tour en cours et envoie le message dès que Claude s’est arrêté. *Échap* ou *Arrêter* interrompt sans envoyer. Un tour interrompu s’affiche « Tour interrompu », sans fausse erreur, et met le pilote en pause plutôt qu’en erreur.
- **Images** : collez une capture (Ctrl+V), glissez une image ou utilisez le bouton image. Formats PNG, JPEG, GIF ou WebP, 5 images de 5 Mo au plus par message.
- **`@fichier`** : en tapant `@`, Aether propose les fichiers du dossier (ceux de git, sans les ignorés). Claude Code joint alors le contenu du fichier au message.
- **Effort** (comme `/effort`) : un réglage par conversation, à côté du modèle (Auto, Faible → Maximum), appliqué en direct. L’effort par défaut se choisit dans Paramètres.

### Suivre ce que Claude change
- **Modifications** (bouton dans l’en-tête de la conversation) : fichiers modifiés, nouveaux ou supprimés du dépôt, avec le nombre de lignes, et le diff de chaque fichier par rapport au dernier commit. Le panneau se met à jour à la fin de chaque tour. Hors dépôt git, il liste les fichiers écrits par Claude.
- **Fichier** : une visionneuse en lecture seule, avec numéros de ligne. Elle s’ouvre depuis les modifications ou un outil de Claude (*Ouvrir le fichier*).
- **Retour arrière** (*Annuler les modifs depuis ici*, au survol d’un de vos messages) :
  - les fichiers modifiés par Claude reviennent à leur état d’avant ce message ;
  - Aether montre d’abord la liste des fichiers et demande confirmation ;
  - la conversation est conservée, et un message prérempli prévient Claude.

  Seuls les messages envoyés depuis cette version d’Aether peuvent être annulés, car Claude Code sauvegarde les fichiers à partir de là.

### Branches isolées et pull requests
- **Conversation isolée** (bouton à côté de « Nouvelle conversation », ou menu d’une conversation) : la nouvelle conversation travaille dans son propre worktree git, sur sa propre branche `aether/<sujet>-<date>`, créée depuis ce qu’a la conversation d’origine. Deux conversations d’un même dépôt ne se marchent donc plus dessus.
  - Les worktrees sont rangés dans `<dépôt>/.aether/worktrees/`, exclus de git par `.git/info/exclude` : aucun fichier suivi n’est modifié.
- **Branche et PR** : le badge de branche dans l’en-tête ouvre ce panneau, qui permet de :
  - voir la branche, l’avance ou le retard sur origin et les fichiers non commités ;
  - **pousser**, avec confirmation, jamais en force, jamais une branche principale ;
  - **ouvrir une PR** (titre, description, brouillon).
- **Avec GitHub CLI** (`winget install GitHub.cli`, puis `gh auth login`) :
  - la PR est créée depuis Aether ;
  - le panneau suit ses vérifications CI, actualisées toutes les 45 s pendant qu’elles tournent ;
  - *Faire corriger par Claude* prépare un message avec les vérifications en échec.
- **Sans GitHub CLI** : Aether pousse la branche puis ouvre la page GitHub de création de la PR, mais ne suit pas la CI. Aether ne manipule jamais de token GitHub.
- **Supprimer le worktree** (menu de la conversation) : retire le dossier et archive la conversation, en gardant la branche. Git refuse s’il reste des modifications non commitées.

### Moteur
- Envoi de messages et réponses **en streaming** (`includePartialMessages`), texte, réflexion (si exposée), appels d’outils et résultats, erreurs, résumé de tour (durée, tokens).
- **Interruption** (`Query.interrupt()`, bouton *Arrêter* ou Échap).
- **Permissions explicites** via `canUseTool` : dialogue avec outil, action, conséquences possibles, paramètres complets, *Autoriser* / *Refuser* (avec motif transmis à Claude).
  Modes proposés : *Demander* (par défaut), *Accepter les modifications*, *Planification* et *Tout autoriser* (comme `claude --dangerously-skip-permissions`, jamais activé sans votre confirmation explicite).
- Changement de modèle en cours de conversation (`Query.setModel`) et de mode de permission (`Query.setPermissionMode`).
- Le moteur tourne dans un **processus utilitaire Electron isolé** (`engineHost`) : un crash ne ferme pas l’application, redémarrage automatique borné (5 / minute, backoff), nettoyage des processus Claude Code orphelins (`taskkill /T`), délais d’expiration sur les appels, reprise de session au message suivant.

### Sessions Claude Code existantes
- Découverte via l’API officielle `listSessions()` du SDK (lecture seule du stockage local `~/.claude/projects`), actualisation périodique (60 s) et manuelle.
- Titre, aperçu, dossier, branche git, date de dernière activité, identifiant, lien éventuel avec une conversation Aether.
- **Reprise** par le mécanisme officiel `resume` : l’historique est relu avec `getSessionMessages()` et le contexte complet est conservé par Claude Code.
- Les fichiers d’historique d’origine ne sont jamais modifiés, copiés ni écrasés. Supprimer une conversation Aether ne supprime pas le transcript Claude Code.
- Une session dont le dossier de travail n’existe plus est signalée comme non reprenable (Claude Code rattache chaque session à son dossier).

### Projets
Ajout d’un répertoire local, conversations associées, mémorisation du dernier dossier, projets récents. Retirer un projet ne supprime aucun fichier.

### Modèles
La liste provient de Claude Code (`supportedModels()` / initialisation du SDK) — **jamais codée en dur**. Sélecteur par conversation, modèle actif affiché,
modèle par défaut configurable, signalement d’un modèle enregistré qui n’est plus proposé.

### Consommation et quotas
Trois familles **distinctes, jamais mélangées** :

1. **Tokens consommés** par les tours exécutés depuis Aether (messages `result` : entrée, sortie, cache) + coût estimé par Claude Code (estimation, pas une facture ; inconnu pour le premier tour d’une session reprise).
2. **Limites de l’abonnement Claude** (fenêtre de 5 heures, hebdomadaire, Opus/Sonnet) : pourcentage et heure de réinitialisation **tels que communiqués par Claude Code** —
   événements `rate_limit_event` pendant les conversations et API d’usage du SDK (bouton *Vérifier maintenant*).
3. **Limites d’API** (comptes clé API : HTTP 429).

Un nombre de tokens n’est jamais présenté comme un pourcentage de quota. Sans donnée officielle, l’interface affiche « Quota non disponible via l’interface officielle ».

### Pause et reprise automatiques
1. Détection : `rate_limit_event` rejeté, erreur `rate_limit` de l’assistant, ou message d’erreur commençant par l’un des préfixes officiels `USAGE_LIMIT_ERROR_PREFIXES`.
2. Identification du type de limite (5 h, hebdomadaire…).
3. Heure de reprise **uniquement** depuis une source fiable (timestamp du moteur ou de l’API d’usage) — jamais calculée depuis le démarrage de l’application, jamais extraite du texte libre.
4. Suspension des nouveaux envois (les conversations restent consultables), bannière et compte à rebours, notification Windows.
5. À l’heure communiquée : envois réactivés + notification, puis vérification via l’API d’usage. Heure inconnue : vérification toutes les 15 minutes via l’interface officielle, **sans jamais renvoyer la requête refusée**.
6. Les erreurs d’authentification et les pannes réseau/serveur sont classées à part et ne déclenchent pas de pause.
7. Réactivation manuelle possible (consignée comme telle dans l’historique des événements).

### Interface modulable
Le terminal et les panneaux des mods sont des fenêtres déplaçables :
- **ancrées** à gauche, à droite (verticales) ou en bas. Un même bord peut contenir **plusieurs sections** (empilées sur les côtés, côte à côte en bas), par exemple Arbo sous le terminal à droite ; chaque section peut elle-même regrouper des panneaux en onglets ;
- ou **flottantes** (micro-fenêtres déplaçables et redimensionnables au-dessus de l’interface).

Pour déplacer un panneau, glissez son titre :
- sur une section existante : son premier tiers place le panneau **au-dessus** (à gauche en bas), son dernier tiers **en dessous** (à droite), le milieu l’ajoute **en onglet** ;
- sur un bord libre : il s’y ancre ;
- ailleurs : il devient flottant.

Le bouton ⊞ de son en-tête propose les mêmes placements (« À droite, en dessous », « À droite, en onglet »…). Les bords et les sections se redimensionnent en tirant leurs séparateurs. La disposition est enregistrée dans les préférences. Un terminal garde son contenu quand on le déplace.

### ChatGPT
Le bouton ChatGPT de la barre de navigation affiche un panneau **chatgpt.com**, déplaçable comme le terminal (à droite par défaut). Vous vous connectez vous-même sur la page officielle d’OpenAI.
- La session ChatGPT est **isolée** (`%APPDATA%\Aether\Partitions\chatgpt`, sur ce PC uniquement) : séparée d’Aether et des mods, sans Node.js, sans pont vers Aether. Aether ne lit ni vos identifiants, ni vos cookies, ni vos conversations.
- Le panneau ne navigue que sur chatgpt.com, openai.com et les pages de connexion Google, Microsoft et Apple ; tout autre lien s’ouvre dans votre navigateur. Aucune autre page web ne peut être intégrée.
- Le bouton ↗ du panneau ouvre l’application ChatGPT de Windows si elle est installée (sinon chatgpt.com dans le navigateur).
- Pour vous déconnecter, utilisez le menu de votre compte dans ChatGPT.

### Pilote Codex (GPT pilote, Claude exécute)
Dans l’en-tête d’une conversation, **Lier Codex** relie la conversation à Codex CLI, l’outil officiel d’OpenAI, connecté à votre compte ChatGPT (`codex login` › « Sign in with ChatGPT », sans clé API). **Détacher** coupe le lien (le pilote en cours est arrêté, le journal est gardé). Le panneau **Pilote Codex** (déplaçable, à droite par défaut) sert à lancer et suivre la session.

La boucle :
1. Vous donnez l’objectif, les critères de fin et les vérifications (ex. `pnpm test`).
2. GPT choisit la tâche suivante (`codex exec`, bac à sable en lecture seule).
3. Claude l’exécute dans la conversation, avec ses permissions habituelles, et termine par un rapport structuré.
4. Aether lance lui-même les vérifications.
5. GPT juge (il peut lire le projet et `git diff` pour vérifier le rapport) puis donne la suite.

Pas de limite de tours. La boucle s’arrête quand GPT juge l’objectif atteint, ou se met en pause :
- quand GPT pose une question (vous répondez dans le panneau) ;
- sur toute erreur de Claude, de Codex ou de git : jamais de relance automatique ;
- quand elle tourne en rond : 3 tâches sans changement, la même instruction ou la même erreur 3 fois ;
- quand la limite ChatGPT est atteinte ;
- à votre demande (Pause, Arrêter).

Une limite Claude est attendue, puis la boucle reprend d’elle-même sur les vraies données de quota. Si Aether est fermé pendant le pilotage, le pilote est en pause au redémarrage.

Garde-fous :
- **Pré-autorisations** au choix, pour la session de pilotage seulement : modifier les fichiers du dossier (mode « Accepter les modifications ») et des règles Claude Code précises comme `Bash(pnpm test:*)`. Les règles trop larges tapées à la main (`Bash`, `Bash(*)`, `Write`…) sont refusées.
- **Tout autoriser, sans aucune demande** (désactivé par défaut) : le mode « bypassPermissions » de Claude Code, comme `claude --dangerously-skip-permissions`, pendant la session de pilotage seulement. Il existe aussi pour toute conversation dans le sélecteur de mode (avec confirmation). Vos règles « deny » et les politiques de votre organisation restent appliquées.
- **Branche de travail** au choix : la branche actuelle, une nouvelle branche `aether/pilote-…`, une nouvelle branche nommée, ou une branche existante (locale ou d’origin, via `git switch`). Les commits automatiques sur une branche principale (main, master, develop, trunk) demandent une autorisation explicite ; jamais de push forcé.
- **Commits et push automatiques** (case décochée par défaut) : le pilote crée une branche `aether/pilote-…` sur un dossier sans modifications en attente. Il ne commite que si Claude déclare la tâche terminée, que les vérifications passent et que GPT l’accepte, puis pousse cette branche vers `origin`. Jamais de force-push, jamais la branche principale, jamais de changement de branche. Si un secret est détecté (clé, jeton, `.env`…), rien n’est commité ni poussé et le pilote se met en pause. La fusion dans `main` reste à vous.
- **Codex** tourne en lecture seule, sans approbation, sans votre `config.toml` : ses serveurs MCP et plugins pourraient agir hors du bac à sable. Seuls le modèle, l’effort et le type de bac à sable Windows sont repris. Si vous décochez « GPT peut lire le projet », il travaille dans un dossier vide et ne voit que les rapports.
- Journal de chaque pilote : `%APPDATA%\Aether\pilots\`. Codex est cherché sur le PATH (installation npm), puis dans l’application Codex.

## 4 bis. Mods Aether

Les mods Aether étendent l’interface d’Aether elle-même (à ne pas confondre avec les mods de Claude Code, qui modifient le moteur). Un mod peut ajouter :
- des **panneaux** (pages HTML/CSS/JS) qui se placent comme le terminal, ou s’intègrent à un emplacement fixe (sous la liste des conversations, au-dessus de la saisie, ou comme une page de la barre de gauche) ;
- des **commandes** `/nom` dans la zone de saisie : elles ouvrent un panneau et ne sont **pas** envoyées à Claude.

Exemples intégrés :
- **`/arbo`** ouvre un graphe des commits, branches et tags du dépôt git de la conversation ;
- **Limites Claude** affiche, sous la liste des conversations, où vous en êtes dans vos limites d’usage (session de 5 heures, semaine, et par modèle si Claude Code les donne) avec l’heure de remise à zéro. Ce sont les chiffres de Claude Code uniquement : ceux qui arrivent avec chaque réponse, plus l’API d’usage officielle interrogée toutes les 5 minutes.

**Sans rebuild :** les fichiers d’un mod du dossier des mods sont surveillés. Dès qu’ils changent, Aether relit le catalogue et recharge les panneaux de ce mod. Seule une capacité vraiment nouvelle d’Aether demande une nouvelle version.

### Installer un mod
*Extensions › Mods Aether › Dossier des mods* ouvre `%APPDATA%\Aether\mods`. Placez-y le dossier du mod, puis *Actualiser*. Un mod installé à la main reste **désactivé** tant que vous ne l’activez pas (Aether affiche alors ses permissions). Les mods intégrés sont actifs par défaut et peuvent être désactivés.

### Écrire un mod
```
mon-mod/
  aether-mod.json
  panel.html   (+ css, js, images…)
```
```json
{
  "id": "mon-mod",
  "name": "Mon mod",
  "version": "1.0.0",
  "description": "Ce que fait le mod",
  "permissions": ["context.read", "ui.toast"],
  "panels": [{ "id": "main", "title": "Mon panneau", "entry": "panel.html", "defaultPosition": "right", "defaultSize": { "width": 480, "height": 360 } }],
  "commands": [{ "name": "monmod", "description": "Ouvre mon panneau", "opensPanel": "main" }]
}
```
- `defaultPosition` : `left`, `right`, `bottom` ou `floating` (par défaut).
- `embed` (facultatif), pour un panneau intégré plutôt que placé dans le dock :
  - `conversation-list` : bandeau sous la liste des conversations ;
  - `composer-top` : bandeau au-dessus de la zone de saisie ;
  - `page` : page entière, avec son icône dans la barre de gauche. Une commande peut l’ouvrir.

  `embedHeight` (20 à 400 px) fixe la hauteur d’un bandeau.

**Permissions de lecture** (jamais le contenu des messages) :

| Permission | Ce qu’elle donne |
| --- | --- |
| `context.read` | Conversation active, liste des conversations (titres, dossiers, occupée ou non) |
| `git.read` | Historique git du dossier de la conversation |
| `usage.read` | Tokens consommés, réponse par réponse, en direct |
| `quota.read` | Limites d’usage Claude : pourcentage de chaque fenêtre, heure de remise à zéro, blocage en cours (`quota.get`, `quota.refresh` au plus une fois par minute, événement `quota`) |
| `events.read` | Activité : état des tours, modèle, **noms** des outils appelés, fin de tour (durée, coût, tokens), demandes d’autorisation, limites, avertissements |

**Permissions d’action** :

| Permission | Ce qu’elle permet |
| --- | --- |
| `ui.toast` | Notifications |
| `composer.write` | Préremplir la zone de saisie (vous relisez et envoyez vous-même) |
| `panels.open` | Ouvrir ses panneaux, le terminal, ChatGPT ou le pilote |
| `commands.run` | Envoyer une commande `/…` d’une ligne à Claude, après **votre confirmation à chaque fois** |
| `orion.connect` | Se connecter à ORION (ORION APPS) par le processus principal d’Aether : `orion.status`, `orion.test`, `orion.configure`, `orion.pair`, `orion.connect`, `orion.disconnect`, `orion.forget`, `orion.preferences`, `orion.request` (routes clientes `/api/connect/v1/…` seulement). Le secret du client est chiffré par Windows (DPAPI, `orion-connect.json`) ; la session reste en mémoire ; le mod ne voit ni l’un ni l’autre. ORION décide des permissions et confirmations |

Dans la page du panneau :
```html
<script src="aether-mod://sdk/aether-mod.js"></script>
<script>
  aether.context().then((context) => console.log(context.workingDirectory))
  aether.onContext((context) => { /* l’utilisateur a changé de conversation */ })
  aether.call('git.log', { limit: 200 }).then((graph) => { /* graph.commits, graph.currentBranch… */ })
  aether.call('ui.toast', { text: 'Bonjour' })
  aether.call('usage.get').then(({ samples }) => { /* 30 dernières minutes */ })
  aether.on('usage', (sample) => { /* chaque réponse de l’API */ })
  aether.call('events.recent', { limit: 100 }).then((events) => { /* … */ })
  aether.on('events', (event) => { /* event.type : runner_state, model, tool_use, tool_result, turn_end, token_usage… */ })
  aether.call('conversations.list').then((conversations) => { /* … */ })
  aether.call('composer.insert', { text: 'Relis ce fichier', replace: false })
  aether.call('panel.open', { panel: 'terminal' })
  aether.call('command.run', { text: '/compact' })
</script>
```

### Sécurité des mods
- Chaque panneau tourne dans un cadre **isolé** (`sandbox="allow-scripts"`, origine opaque) : aucun accès à Node.js, au pont d’Aether, au stockage ni aux autres panneaux.
- Ses fichiers sont servis par le protocole `aether-mod://<id>/`, uniquement depuis le dossier du mod (chemins `..`, absolus ou liens sortants refusés), avec une politique de sécurité stricte : **aucun accès réseau**, scripts du mod et du pont seulement, navigation hors du mod bloquée.
- Le panneau ne peut demander à Aether que ce que ses permissions autorisent, vérifié deux fois (interface et processus principal). `git.read` n’exécute que des commandes git de lecture (`rev-parse`, `log`, `remote get-url`), dans le dossier d’une conversation ou d’un projet d’Aether uniquement ; les identifiants éventuellement présents dans l’URL du dépôt distant sont retirés.
- Un mod n’envoie jamais rien à Claude sans vous :
  - `composer.write` ne fait que préremplir la saisie ;
  - `commands.run` n’accepte qu’une commande `/…` d’une ligne, refusée pendant que Claude travaille, et vous demande confirmation à chaque envoi.
- `events.read` ne transmet ni le texte des messages, ni les entrées et sorties des outils : seulement des noms, des états et des nombres.
- `orion.connect` ne donne pas le réseau au mod : c’est Aether qui appelle **une** adresse d’ORION, choisie par vous (changer d’adresse oublie l’appairage), et seulement les routes clientes d’ORION APPS (`src/shared/orionConnect.ts`). Un client ORION CONNECT n’a aucun droit d’administration : il ne peut ni accorder de permission, ni confirmer une action.

## 5. Architecture

```
src/
  shared/          Types, contrat IPC (zod), protocole moteur, logique pure (quotas, timeline)
  main/            Processus principal Electron
    database/      SQLite (sql.js/WASM), migrations, dépôts
    engine/        Détection de Claude Code, superviseur du processus moteur
    quota/         QuotaManager (pause / reprise)
    services/      ChatService, SessionService, logger, contrôle des chemins
    ipc/           Validation des expéditeurs et des charges utiles
  engine-host/     Processus utilitaire isolé : seul à appeler le Claude Agent SDK
  preload/         Pont minimal `window.aether` (liste blanche)
  renderer/        React 19 + Tailwind 4 + Zustand
tests/
  unit/            Vitest (211 tests)
  e2e/             Playwright/Electron : interface (7 tests), panneaux et mods (7 tests), test « live » optionnel (6 tests)
resources/
  mods/arbo/       Mod intégré « Arbo » (/arbo)
  mods/limites/    Mod intégré « Limites Claude »
  mods-sdk/        Pont aether-mod.js servi à tous les panneaux
```

Flux : Renderer → IPC validé (zod + contrôle de l’expéditeur) → main → `EngineSupervisor` → `utilityProcess` → `@anthropic-ai/claude-agent-sdk` → **Claude Code CLI installé**.

Le SDK embarque son propre binaire Claude Code (340 Mo) ; il est exclu de l’installateur et Aether utilise le Claude Code de la machine (`pathToClaudeCodeExecutable`).

### Données
`%APPDATA%\Aether\aether.sqlite` — tables `projects`, `conversations`, `session_mappings`, `preferences`, `usage_events`, `quota_events`, `application_logs`.
Migrations versionnées (`PRAGMA user_version`), **sauvegarde automatique avant toute migration** (`backups\`), écriture atomique (fichier temporaire + renommage),
sauvegarde manuelle depuis *Paramètres › Diagnostic*. Les transcripts restent dans le stockage de Claude Code et ne sont pas dupliqués.
Variable `AETHER_USER_DATA_DIR` : dossier de données alternatif (tests).

### Sécurité Electron
`contextIsolation`, `sandbox`, `nodeIntegration: false`, preload minimal, IPC en liste blanche (preload **et** main), validation zod de chaque appel,
vérification de l’origine de l’appelant, CSP stricte (injectée au build), navigation et nouvelles fenêtres bloquées, liens externes limités à https vers des hôtes officiels,
contrôle des chemins (absolus, existants, sans octet NUL), Markdown rendu sans HTML brut.

## 6. Commandes

```bash
npx -y pnpm@10 typecheck        # TypeScript strict (main + renderer)
npx -y pnpm@10 lint             # ESLint
npx -y pnpm@10 test             # Tests unitaires et d’intégration (Vitest)
npx -y pnpm@10 build            # Build de production (out/)
npx -y pnpm@10 test:e2e         # Tests d’interface Playwright (après build)
npx -y pnpm@10 package          # Installateur Windows -> dist\Aether-Setup-<version>.exe
```

Test live contre le vrai moteur (consomme un peu d’usage Claude, crée une session Claude Code dans un dossier temporaire) :

```powershell
$env:AETHER_E2E_LIVE=1; npx playwright test tests/e2e/live.spec.ts
```

Tests d’interface sur l’application empaquetée : `$env:AETHER_E2E_EXECUTABLE="dist\win-unpacked\Aether.exe"; npx playwright test tests/e2e/app.spec.ts`

## 7. Installateur

`dist\Aether-Setup-<version>.exe` (NSIS, x64, installation par utilisateur, choix du dossier, raccourcis Bureau et menu Démarrer).
Les données utilisateur sont conservées à la désinstallation. L’installateur n’est pas signé (Windows SmartScreen affichera un avertissement).

NSIS ne lit pas ses fichiers d’inclusion depuis un chemin très long : `scripts\package-win.ps1` construit alors dans un dossier temporaire court et écrit l’installateur dans `dist\`.

Version : `version` dans `package.json`. Icône : `build/icon.ico` / `resources/icon.png`, régénérables avec `python build/generate-icons.py` (Pillow).

## 8. Limites connues (honnêtes)

- **Conversations Claude Desktop / claude.ai** : non accessibles par les interfaces officielles de Claude Code ; seules les sessions Claude Code locales sont découvertes et reprenables.
- **Quotas d’abonnement** : le pourcentage et l’heure de réinitialisation ne sont connus que lorsque Claude Code les communique. La lecture à la demande utilise
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` du SDK, explicitement marquée **expérimentale** par Anthropic : elle peut changer ou disparaître (Aether affiche alors l’erreur et se rabat sur les événements de limite).
- L’unité de `resetsAt` dans `rate_limit_event` n’est pas documentée : Aether accepte secondes et millisecondes (normalisation testée).
- Le coût affiché est l’estimation de Claude Code, pas une facture.
- Changer le dossier d’une conversation déjà liée à une session est refusé (une session Claude Code est rattachée à son dossier).
- Thème : deux variantes sombres (Forêt, Charbon) ; pas de thème clair.
- Installateur non signé ; pas de mise à jour automatique.
- Le mode développement n’a été vérifié qu’au démarrage (les tests automatisés portent sur le build de production et l’exécutable empaqueté).
