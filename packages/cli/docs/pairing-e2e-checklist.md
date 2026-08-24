# Pairing E2E checklist

Validation manuelle du pairing CLI ↔ backend ↔ browser. Chaque scénario est indépendant — cocher au fil de l'eau.

## Pré-requis

- Backend up : `pnpm db:up` + backend running (port 4000)
- Frontend up : `pnpm --filter @sqlnest/frontend dev` (port 3000)
- CLI buildé : `pnpm --filter @sqlnest/cli build` (bundle `packages/cli/dist/sqlnest.mjs`)
- User avec team perso + au moins une DSN locale (`sqlnest add-connection`)
- DevTools ouvert (cookie `sqlnest.session_token` visible dans Application → Cookies)

Reset config CLI si besoin : `rm ~/.sqlnest/config.toml` (perd la keypair + tous les tunnels).

## 1. Premier pair same-device (happy path)

**Setup** : CLI vierge (pas de tunnel dans `config.toml`), session Better Auth valide dans le browser, 1 DSN locale.

**Steps**
1. `sqlnest connect --connection <ta-dsn>`
2. Observer output CLI : header + code Crockford + spinner Braille « En attente d'approbation… »
3. Le browser s'ouvre sur `http://localhost:3000/pair?code=XXXX-XXXX`
4. Page affiche code prefilled + banner identité (`Connecté comme <email>`) + icon `IconArtboard` + bouton « Autoriser »
5. Click « Autoriser » — après 1-3 s, skeleton « Configuration du tunnel — <nom>… » puis toast vert « Tunnel prêt : `<nom>` » + navigate direct au canvas

**Expected**
- [ ] Code visible CLI et browser (matchent)
- [ ] Banner identité au-dessus du form
- [ ] Titre header : `Nouveau canvas`
- [ ] Spinner CLI transitionne : `⠋ En attente d'approbation…` → `⠋ Approuvé — ouverture du tunnel…` → `✓ Pairing OK : « <nom> » — <tunnelId>`
- [ ] Redirect browser sur `/team/<slug>/canvas/<connId>` avec schema rendu immédiat (pas d'écran noir 1-3 s)
- [ ] Toast vert `Tunnel prêt : \`<nom>\`` ~3 s
- [ ] CLI bloque sur `▶ Tunnel actif — Ctrl-C pour arrêter.`

**Failure signals**
- Écran canvas noir > 1 s post-navigate → prefetch canvas KO
- Toast en style Mantine default (bande couleur gauche) au lieu du custom compact → mauvais notify
- CLI output sur plusieurs lignes empilées au lieu d'une ligne spinner → détection TTY cassée

---

## 2. Reconnaissance same-device (post-révocation)

**Setup** : CLI avec 1 tunnel valide (scénario 1 shipped). Révoquer le tunnel via gallery (menu contextuel « Révoquer ») ou `sqlnest revoke-connection --name <nom>`. Relancer `sqlnest connect --connection <même-dsn>` — `findResumableTunnel` ne trouve rien (session_token invalide), device flow relance.

**Steps**
1. Le CLI ouvre `/pair?code=XXXX-XXXX`
2. Debounce 350 ms → GET `/status` surface `existingConnection: { id, name }` via cascade fp/checksum
3. UI bascule reconnaissance : titre header `Reconnexion à <nom>`, icon `IconRefresh` accent, code preview verrouillé (chip mono grand), bouton `Confirmer & ouvrir <nom>`
4. Click « Confirmer & ouvrir » — spinner CLI + skeleton browser → toast vert `Reconnecté à \`<nom>\`` + navigate direct canvas

**Expected**
- [ ] Titre header change en `Reconnexion à <nom>` ~350 ms après mount
- [ ] Icon `IconRefresh` accent color (distinct du premier pair)
- [ ] Code Crockford visible et lisible dans le chip (ancre anti-phishing)
- [ ] Plus d'input `Nom` (autofillé backend)
- [ ] Toast est bien `Reconnecté à \`<nom>\`` (pas `Tunnel prêt`)
- [ ] Canvas ouvert = celui de la db_connection matched (mêmes frames/positions que la session précédente)

**Failure signals**
- Toast `Tunnel prêt` au lieu de `Reconnecté à` → mauvais branch `isReconnect`
- Titre reste `Nouveau canvas` → useEffect debounce n'a pas fire (check network `/status`)

---

## 3. Cross-device Mac ↔ Windows (cascade fp → checksum)

**Setup**
- Machine A (Mac) : DB Apollon dans docker A, tunnel actif shipped scénario 1
- Machine B (Windows) : même DB Apollon dans docker B (`system_identifier` PG différent, même seed → même `db_schema_checksum`)
- Sur B : CLI vierge, session Better Auth valide (même user)

**Steps**
1. Sur B, terminal : `sqlnest connect --connection apollon`
2. Le CLI ouvre `/pair?code=XXXX-XXXX`
3. Backend cascade : fp (level 1) miss, `db_fingerprint` (level 2) miss, `db_schema_checksum` (level 3) **match** la db_connection existante créée depuis A
4. UI reconnaissance : titre `Reconnexion à Apollon`, icon `IconRefresh`
5. Click Confirmer → redirect direct au canvas — même `connId` que sur A

**Expected**
- [ ] Sur B, l'UI bascule bien en mode reconnaissance (pas premier pair)
- [ ] Gallery sur B affiche **1** seule entry Apollon (pas 2 dupliquées)
- [ ] Canvas sur B rend avec les mêmes frames/positions que sur A (`canvas_state` shared via cascade)
- [ ] Sur A, le tunnel A reste actif (les 2 sessions coexistent, `tunnel_session` distinctes attachées à la même `db_connection`)

**Failure signals**
- Gallery sur B affiche 2 entries Apollon → cascade backend broken
- Canvas frames vides sur B → `canvas_state` pas migré (bug backend)

---

## 4. Session Better Auth expirée pile pendant pair

**Setup** : CLI vierge, session Better Auth valide, browser ouvert sur `/pair?code=XXXX-XXXX`. Avant de cliquer Autoriser, DevTools → Application → Cookies → supprimer `sqlnest.session_token` (simule expiration).

**Steps**
1. Click « Autoriser »
2. `queryClient.fetchQuery(sessionQueryOptions())` retourne `null`
3. Frontend redirect vers `/login?redirect=/team/<slug>/pair?code=XXXX-XXXX` — le code est préservé
4. `LoginPage` affiche form login, `search.redirect` visible
5. Re-login → navigate vers le `redirect` → retour sur `/pair` avec le code toujours prefilled

**Expected**
- [ ] Redirect vers `/login?redirect=…` observable dans l'URL
- [ ] Path `?redirect=` contient bien `/team/<slug>/pair?code=<vrai-code>` (URL-encoded)
- [ ] Après re-login, retour sur `/pair` avec code prefilled (pas de re-saisie)
- [ ] Le CLI en poll `/status` continue à tourner (pas timeout pendant l'écart)
- [ ] Un nouveau click Autoriser complète le flow normalement

**Failure signals**
- Redirect vers `/login` **sans** `?redirect=` → path perdu
- Après re-login retour sur `/` (gallery) → LoginPage n'a pas lu `search.redirect`

---

## 5. Stale fingerprint post `docker down/up` (fp match, checksum ≠)

**Setup** : Sur A, tunnel Apollon actif shipped. Révoquer le tunnel local (scénario 2). `sqlnest connect --connection apollon` — UI bascule reconnaissance. **NE PAS** cliquer Confirmer. Dans un autre terminal : `docker compose -f infra/docker-compose.yml down apollon && docker compose -f infra/docker-compose.yml up -d apollon` — nouveau `system_identifier` donc nouveau `db_fingerprint` + nouveau `db_schema_checksum`. Revenir sur l'onglet browser, click « Confirmer & ouvrir Apollon ».

**Steps**
1. `handleSubmit` refetch session OK
2. `handleSubmit` re-poll `/status` — backend recompute cascade avec les fp du POST /pairings initial (stale)
3. Downgrade transparent : `setExistingConnection(null)` + `setError("La DB a changé côté CLI — indique un nom pour la nouvelle connexion.")` → UI bascule variant premier pair, input `Nom` apparait
4. L'user tape un nom, click Autoriser → premier pairing normal

**Expected**
- [ ] Message d'erreur `La DB a changé côté CLI — indique un nom pour la nouvelle connexion.` visible
- [ ] Titre header re-devient `Nouveau canvas`
- [ ] Icon change `IconRefresh` → `IconArtboard`
- [ ] Input `Nom` apparait
- [ ] Aucun submit /approve fait sur le stale existing (pas de db_connection stale attachée)

**Failure signals**
- Approve OK avec `existingConnection` stale → race loupée, db_connection dupliquée
- UI reste bloquée en mode reconnaissance → `setExistingConnection(null)` pas appliqué
- ⚠️ Ce scénario peut ne pas trigger le downgrade si le CLI n'envoie pas les fp fresh au re-poll `/status` (le status re-lookup avec les fp du pairing row initial). À investiguer.

---

## 6. Fallback checksum staging vs prod (récup via renommer gallery)

**Setup** : 2 DBs dans la même team perso : `staging` et `prod`, chacune seedée avec **le même dump SQL** → même `db_schema_checksum` mais `system_identifier` PG différents. CLI vierge.

**Steps**
1. `sqlnest add-connection --name prod --url postgres://…/prod`
2. `sqlnest connect --connection prod`
3. Backend cascade : fp miss, db_fingerprint miss, `db_schema_checksum` **match** `staging`
4. UI reconnaissance : titre `Reconnexion à staging` — l'user réalise que c'est SA DB staging alors qu'il voulait prod
5. Récupération : pas d'escape hatch dédié. L'user doit :
   - Soit renommer la db_connection matched via gallery
   - Soit annuler et relancer CLI avec une DB au schéma différencié
6. Ctrl-C sur le CLI, ouvrir gallery, renommer `staging` → `staging-shared` via l'UI, relancer `sqlnest connect --connection prod`
7. Nouveau pair : cascade re-match `staging-shared` (checksum identique) — titre `Reconnexion à staging-shared`

**Expected**
- [ ] UI bascule bien reconnaissance vers `staging` (cascade level 3 déclenchée)
- [ ] Rename via gallery marche (pas de crash, nouvelle name persiste)
- [ ] Pas de « Ce n'est pas ma DB ? » (pas d'escape hatch prévu)
- [ ] Documenter : rare, aucun user path clean sans `?force_new=1` backend — laisser tel quel jusqu'à future hardening

**Failure signals** — aucun (scénario limite documenté).

---

## 7. TTY vs pipe (fallback spinner)

### 7a — TTY normal
1. `sqlnest connect --connection <dsn>` dans un terminal interactif
2. Observer les frames Braille (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) qui tournent sur UNE ligne

### 7b — Pipe
1. `sqlnest connect --connection <dsn> | tee /tmp/sqlnest.log`
2. Observer sortie plain-log, chaque transition sur une nouvelle ligne

### 7c — GitHub Actions style
1. `NODE_ENV=development node --enable-source-maps packages/cli/dist/sqlnest.mjs connect --connection <dsn> 2>&1 | cat`
2. Idem 7b

**Expected**
- [ ] 7a : spinner Braille fluide, transitions in-place
- [ ] 7b : lignes plain préfixées `[sqlnest]` :
  ```
  [sqlnest] En attente d'approbation…
  [sqlnest] Approuvé — ouverture du tunnel…
  ✓ Pairing OK : « <nom> » — <id>
  ```
- [ ] 7c : identique 7b, aucun caractère binaire dans `/tmp/sqlnest.log` (pas de `\r` ni escape ANSI)
- [ ] Aucun crash lié à `!process.stdout.isTTY`

**Failure signals**
- 7b/7c : caractères binaires (`\r`, `⠋`, `\x1b[K`) dans le pipe → détection TTY cassée
- 7a : plusieurs lignes empilées → `\r` pas honoré (rare, dépend du terminal)

---

## 8. Redirect direct canvas + prefetch

Couvert implicitement par scénarios 1, 2, 3, mais explicitement à vérifier :

**Expected**
- [ ] Post-click Autoriser, l'onglet browser attend `isOnline: true` du CLI avant de rediriger (skeleton `Configuration du tunnel — <nom>…` visible pendant les 1-3 s de WSS handshake)
- [ ] Canvas rend sans écran noir intermédiaire (prefetch schema + layout + canvas_state avant navigate)
- [ ] Timeout : si le CLI est killé (Ctrl-C) juste après le click Autoriser, après ~15 s le skeleton disparait, toast neutre `Configuration en cours. \`<nom>\` apparaîtra dans la gallery.` + fallback gallery

**Failure signals**
- Écran canvas noir > 1 s → prefetch bypass
- Redirect avant `isOnline: true` → poll ne check pas `c.isOnline`
- Timeout 15 s ne bascule pas gallery → boucle infinie

---

## 9. Prefill `?code=`

**Setup** : CLI vierge, session valide.

**Steps**
1. `sqlnest connect --connection <dsn>`
2. Vérifier l'URL browser : `http://localhost:3000/pair?code=XXXX-XXXX` (le code est dans la query, pas juste dans le CLI)
3. Le champ `Code` du form est déjà rempli avec `XXXX-XXXX`

**Expected**
- [ ] URL browser contient `?code=<vrai-code>` (URL-encoded, dash préservé)
- [ ] Champ code prefilled dès le mount
- [ ] Route legacy `/pair` (sans `/team/:slug`) forwarde le `?code=` dans le redirect vers `/team/<default>/pair` — vérifier via `curl -L "http://localhost:3000/pair?code=ABCD-1234"`

**Failure signals**
- URL browser = `/pair` sans query → regression cli/connect
- Champ code vide → `PairRoute.useSearch()` cassé ou `validateSearch` bug
