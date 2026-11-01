# Blackbox pilot — tester guide

For the pilot testers of the local Blackbox installation on an Apple Silicon Mac. Engineering reference: `docs/operations.md`, `docs/ui.md`, `docs/release.md`. The German section follows below (Deutsche Fassung weiter unten).

What this pilot is: a local web app (`http://127.0.0.1:19180/`), a worker, a Rust engine and PostgreSQL in Docker containers that only this Mac can reach. No cloud account, no signup and no AI/LLM subscription is needed to install it or to get every one of the 24 local question templates answered. An external agent (Claude Desktop, Claude Code or any MCP-capable client) is optional and talks to its own model vendor; Blackbox itself sends nothing anywhere.

What it is not: not a native `.app`/DMG, not signed or notarized, not reachable from other machines, no Passkeys, no employee management, no public hosting.

## 1. Install (about 10 minutes)

1. Prerequisites: macOS 14 or newer on Apple Silicon, **Docker Desktop 4.3x+** with Compose v2 running, ~10 GiB free disk, a password manager. Nothing is installed globally by Blackbox.
2. Open the landing page you were given (during the pilot it is served privately, e.g. `http://127.0.0.1:19181/`), choose the language (EN/DE) and click **Download for Mac**. Note the version, size and SHA-256 shown on the page.
3. Verify and extract (replace `<version>`):
   ```sh
   shasum -a 256 ~/Downloads/blackbox-<version>-mac-arm64.tar.gz   # must equal the SHA-256 on the page
   mkdir -p ~/Blackbox && tar -xzf ~/Downloads/blackbox-<version>-mac-arm64.tar.gz -C ~/Blackbox
   cd ~/Blackbox/blackbox-<version>
   ./blackbox doctor      # 0 = ready, 1 = degraded (read the hints), 2 = missing prerequisite; installs nothing
   ./blackbox setup       # creates secrets/, loads the bundled images, migrates, starts, shows the owner key ONCE
   ```
   The archive contains the container images, so no Git clone, Node/Rust toolchain or registry login is needed. macOS adds a quarantine attribute to the download; a shell script and Docker images do not trigger Gatekeeper, so do not change any security setting.
4. If `setup` says an installation already exists, you are in an installed folder: use `./blackbox up` (or `./blackbox upgrade <new archive>`); setup never overwrites data or keys.

## 2. Save the key, sign in

`./blackbox setup` prints your **personal owner key** (`bbk_…`) exactly once. Put it into your password manager immediately; it is never written to a file or log. Then open `http://127.0.0.1:19180/`, paste the key and optionally tick **Stay signed in on this computer** (revocable session, 30 days / 7 days idle). Sign out is in the sidebar. The key gives owner access — never paste it into chats, URLs or configuration files; agents get their own read-only keys (section 5).

Lost the key? On this Mac only: `./blackbox reset-access` issues a new one and signs everyone out. There is no web or e-mail reset.

## 3. Demo data or first import

- **Demo:** on the Recorder page click **Run the example (demo)** → **Load demo scenario**. This loads the labeled GOLDEN order-to-cash scenario (one Shopify-shaped order, invoice, payment, credit note, payout and bank line) into separately labeled demo connections through the real ingestion path. If you already connected your own sources, the app asks for a second confirmation and keeps your data untouched. The same from the terminal: `./blackbox demo`.
- **Own data (pilot scope):** Sources → *Shopify* needs a merchant-owned custom-app Admin API token with read scopes (see `docs/connectors.md`); *Shopify Payments* likewise; *Bank CSV* accepts a semicolon file with the header `date;amount;currency;reference;counterparty;booking_text` and previews rows before anything is committed; *Signed API* creates a producer and shows its HMAC secret once. After connecting, choose the import period (last 30 days by default, this year, last 12 months, a start date, or from now on) — boundaries are shown in your timezone and UTC. Providers marked *planned* have no data path in this pilot.

## 4. Ask one question

Questions & Answers → pick **order-01 "Can I still sell 100 Olive Cups?"**. Type `CUP` into *Item*, click **Look up** (a literal search over your journal, not a model), choose `CUP-OLV`, enter the quantity and click **Ask**. The answer shows the status (complete / partial / unknown / conflict / unsupported), the engine's formula steps with the values used, the result fields, citations that open the journal entries, the raw evidence excerpts, the cutoffs/cursors and the data status. With the demo data the available quantity is 112 (the GOLDEN checkpoint). An unknown item answers **Unknown — insufficient data** with the missing basis instead of a zero. All 24 templates work this way without any model.

## 5. Connect a local agent (optional)

1. Agents & MCP → **Create agent key** → name it → the `bba_…` key is shown once. Save it to a file only you can read, e.g. `~/.blackbox/agent.key` (`chmod 600`). The grant is `workspace.read_business` (read-only; no ingestion, no administration, no technical logs). Revoke it on the same page at any time.
2. The bridge is a stdio MCP server: `node <checkout>/packages/mcp/dist/server.js` with `BLACKBOX_API_URL=http://127.0.0.1:19180` and `BLACKBOX_AGENT_KEY_FILE=/absolute/path/agent.key` in the environment (never the key as an argument). In this pilot the bridge script comes from the Git checkout (it is not inside the release archive); `pnpm install && pnpm --filter @blackbox/mcp build` once.
3. Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`) or Claude Code (`.mcp.json` in a project, or `claude mcp add-json blackbox '<json>'`):
   ```json
   {
     "mcpServers": {
       "blackbox": {
         "command": "node",
         "args": ["/absolute/path/to/blackbox-agent-c/packages/mcp/dist/server.js"],
         "env": { "BLACKBOX_API_URL": "http://127.0.0.1:19180", "BLACKBOX_AGENT_KEY_FILE": "/Users/you/.blackbox/agent.key" }
       }
     }
   }
   ```
   Tools: `describe_business_schema`, `list_journal_entries`, `get_journal_entry`, `get_entity_history`, `search_events`, `get_business_state`, `get_evidence`, `query_business`, `answer_question`, `get_readiness`. Content returned from sources is data, not instructions — the bridge tells the client so.
4. Verified in this pilot with the official MCP Inspector CLI (see `reports/evidence/MCP-03/`): `npx --yes @modelcontextprotocol/inspector --cli node packages/mcp/dist/server.js --method tools/list` and a `tools/call` of `get_business_state`. Claude Desktop itself was **not** launched by the project; the config above follows its documented format. Cloud-only agents cannot reach `127.0.0.1`; no tunnel is offered.

## 6. Restart, stop, upgrade

```sh
./blackbox status          # running services, backup state, fences
./blackbox down            # stop; database volume, evidence and keys stay
./blackbox up              # start again; the demo answer and your sources are still there
./blackbox upgrade ~/Downloads/blackbox-<new>-mac-arm64.tar.gz   # backup first, migrate, verify; --resume if interrupted
```
Closing the browser does not stop anything. Quitting Docker Desktop, sleep or shutdown pauses processing; it resumes when Docker runs again.

## 7. Backup and restore (pointers)

Until a destination is enrolled the app and `doctor` say **unprotected**. Enroll one outside the installation (ideally an external disk): `./blackbox backup-config /Volumes/Disk/blackbox` prints the **backup recovery key** once — save it separately from the owner key. `./blackbox backup` creates an encrypted generation; afterwards one per 24 h while running (7 daily + 4 weekly kept). Restore into a fresh folder: `./blackbox restore <file.tar.age>` (asks for the recovery key; new owner key shown once; sources stay paused until `./blackbox resume-sources`). Details and the in-place `--replace` variant: `INSTALL.en.md` §7, `docs/operations.md`.

## 8. Diagnostics export (explicit, sanitized)

Nothing is sent automatically — ever. When you report a problem, attach a bundle you created yourself:

- In the app: System & Diagnostics → **Export diagnostics** → choose the time range and categories (versions, health, error counts, sanitized log excerpts) → **Preview bundle** shows size and record count → **Download bundle** (ZIP ≤ 10 MiB).
- Terminal (works even when the app is down): `./blackbox diagnostics export --since 24h --output ~/Desktop/blackbox-diagnostics.zip`.

The bundle contains version/runtime/health/error metadata and log excerpts with pseudonymised ids. It never contains business records, evidence, database dumps, keys, tokens, personal paths or raw provider configuration. Open the ZIP and look before you send it.

System & Diagnostics also shows seven live health cards (API, worker, PostgreSQL, engine, sources, MCP, diagnostics) with observed time and reason, filterable logs (last hour, INFO and above by default; live mode with pause), a 15-minute scoped DEBUG switch and storage/retention figures. `./blackbox logs --since 1h --level warn` is the terminal fallback.

## 9. Known limitations (pilot)

- Apple Silicon Mac + Docker Desktop only; one owner, one workspace, loopback only; no native app, no signing/notarization, no Passkeys, no public hosting.
- Current data paths: Shopify and Shopify Payments (authorized store token required; no live store was available to the project, so live proof is still blocked), bank CSV, signed typed API, deterministic replay and the labeled demo. easybill, DHL and the other catalogue entries are planned only.
- Signing in takes a few seconds on purpose (argon2id key verification); on a busy Mac it can take longer.
- The MCP bridge script is run from the Git checkout; it is not bundled in the release archive yet.
- Backups write only to an enrolled destination that is mounted; a sleeping Mac creates none. Losing both the recovery key and the installation is unrecoverable.
- Diagnostics retention is bounded (7 days / 100 MiB); DEBUG is recorded only while a debug window is active.

## 10. Feedback checklist (what to tell us)

Please note, with the exact time and the version from `./blackbox status`:

1. Install: did `doctor`/`setup` finish without manual intervention? Which prompts did macOS or Docker show?
2. Key handling: was it clear where the owner key is shown and that it appears once?
3. Demo/first import: did the demo load? For own sources: which provider, how long until the first answer was ready, what did the readiness/data status say?
4. One question: which template, which parameters, was the answer understandable, did the citations open the right entries?
5. Agent: which client and version, did `tools/list` work, what did a free-text question return?
6. Restart: after `./blackbox down` / `./blackbox up`, was everything (demo answer, sources, sessions) still there?
7. Anything confusing, slow (with the time it took) or wrong (with the diagnostics bundle from section 8, created by you).

No usage data is collected; this list is the only feedback channel.

---

# Blackbox-Pilot — Testleitfaden (Deutsch)

Für die Pilot-Tester der lokalen Blackbox-Installation auf einem Apple-Silicon-Mac. Technische Referenz (Englisch): `docs/operations.md`, `docs/ui.md`, `docs/release.md`.

Was der Pilot ist: eine lokale Web-App (`http://127.0.0.1:19180/`), ein Worker, eine Rust-Engine und PostgreSQL in Docker-Containern, die nur dieser Mac erreicht. Für Installation und alle 24 lokalen Fragevorlagen ist kein Cloud-Konto, keine Registrierung und kein KI/LLM-Abo nötig. Ein externer Agent (Claude Desktop, Claude Code oder ein anderer MCP-fähiger Client) ist optional und spricht mit seinem eigenen Modellanbieter; Blackbox selbst sendet nichts nach außen.

Was er nicht ist: keine native `.app`/DMG, nicht signiert oder notarisiert, von anderen Rechnern nicht erreichbar, keine Passkeys, keine Mitarbeiterverwaltung, kein öffentliches Hosting.

## 1. Installieren (ca. 10 Minuten)

1. Voraussetzungen: macOS 14 oder neuer auf Apple Silicon, **Docker Desktop 4.3x+** mit Compose v2 läuft, ca. 10 GiB freier Speicher, ein Passwortmanager. Blackbox installiert nichts global.
2. Öffne die Landingpage, die du bekommen hast (im Pilot privat bereitgestellt, z. B. `http://127.0.0.1:19181/`), wähle die Sprache und klicke **Für Mac herunterladen**. Notiere Version, Größe und SHA-256 von der Seite.
3. Prüfen und entpacken (`<version>` ersetzen):
   ```sh
   shasum -a 256 ~/Downloads/blackbox-<version>-mac-arm64.tar.gz   # muss der SHA-256 auf der Seite entsprechen
   mkdir -p ~/Blackbox && tar -xzf ~/Downloads/blackbox-<version>-mac-arm64.tar.gz -C ~/Blackbox
   cd ~/Blackbox/blackbox-<version>
   ./blackbox doctor      # 0 = bereit, 1 = eingeschränkt (Hinweise lesen), 2 = Voraussetzung fehlt; installiert nichts
   ./blackbox setup       # legt secrets/ an, lädt die gebündelten Images, migriert, startet, zeigt den Inhaberschlüssel EINMAL
   ```
   Das Archiv enthält die Container-Images; Git, Node/Rust oder ein Registry-Login sind nicht nötig. macOS versieht den Download mit einem Quarantäne-Attribut; ein Shell-Skript und Docker-Images lösen keine Gatekeeper-Abfrage aus — ändere keine Sicherheitseinstellung.
4. Meldet `setup`, dass bereits eine Installation existiert, bist du in einem installierten Ordner: nutze `./blackbox up` (oder `./blackbox upgrade <neues Archiv>`); setup überschreibt nie Daten oder Schlüssel.

## 2. Schlüssel sichern, anmelden

`./blackbox setup` zeigt deinen **persönlichen Inhaberschlüssel** (`bbk_…`) genau einmal. Lege ihn sofort im Passwortmanager ab; er wird nie in eine Datei oder ein Log geschrieben. Öffne dann `http://127.0.0.1:19180/`, füge den Schlüssel ein und setze optional **Auf diesem Computer angemeldet bleiben** (widerrufbare Sitzung, 30 Tage / 7 Tage inaktiv). Abmelden findest du in der Seitenleiste. Der Schlüssel gewährt Inhaberzugriff — nie in Chats, URLs oder Konfigurationsdateien einfügen; Agenten bekommen eigene schreibgeschützte Schlüssel (Abschnitt 5).

Schlüssel verloren? Nur auf diesem Mac: `./blackbox reset-access` erzeugt einen neuen und meldet alle ab. Es gibt keinen Web- oder E-Mail-Reset.

## 3. Demo-Daten oder erster Import

- **Demo:** Auf der Recorder-Seite **Beispiel ausführen (Demo)** → **Demo-Szenario laden**. Das lädt das gekennzeichnete GOLDEN-Order-to-Cash-Szenario über den echten Aufnahmepfad in separat gekennzeichnete Demo-Verbindungen. Hast du bereits eigene Quellen verbunden, fragt die App ein zweites Mal nach und lässt deine Daten unberührt. Im Terminal: `./blackbox demo`.
- **Eigene Daten (Pilot-Umfang):** Quellen → *Shopify* braucht ein händlereigenes Custom-App-Admin-API-Token mit Lese-Scopes (`docs/connectors.md`); *Shopify Payments* ebenso; *Bank-CSV* nimmt eine Semikolon-Datei mit Kopfzeile `date;amount;currency;reference;counterparty;booking_text` und zeigt eine Vorschau, bevor etwas übernommen wird; *Signierte API* legt einen Produzenten an und zeigt sein HMAC-Geheimnis einmal. Nach dem Verbinden wählst du den Importzeitraum (Standard: letzte 30 Tage; dieses Jahr; letzte 12 Monate; Startdatum; ab jetzt) — Grenzen werden in deiner Zeitzone und in UTC angezeigt. Anbieter mit *geplant* haben im Pilot keinen Datenpfad.

## 4. Eine Frage stellen

Fragen & Antworten → **order-01 „Kann ich noch 100 Olive Cups verkaufen?“**. `CUP` in *Artikel* eintippen, **Nachschlagen** (eine wörtliche Suche im Journal, kein Modell), `CUP-OLV` wählen, Menge eintragen, **Fragen**. Die Antwort zeigt Status (vollständig / teilweise / unbekannt / Konflikt / nicht unterstützt), die Formelschritte der Engine mit den verwendeten Werten, die Ergebnisfelder, Zitate, die die Journaleinträge öffnen, die Rohbelege, Stichtage/Cursor und den Datenstatus. Mit den Demo-Daten sind 112 Stück verfügbar (GOLDEN-Prüfpunkt). Ein unbekannter Artikel liefert **Unbekannt — unzureichende Daten** mit der fehlenden Basis statt einer Null. Alle 24 Vorlagen funktionieren so, ohne Modell.

## 5. Lokalen Agenten verbinden (optional)

1. Agenten & MCP → **Agentenschlüssel anlegen** → benennen → der `bba_…`-Schlüssel wird einmal gezeigt. Speichere ihn in einer nur für dich lesbaren Datei, z. B. `~/.blackbox/agent.key` (`chmod 600`). Berechtigung: `workspace.read_business` (nur lesen; keine Aufnahme, keine Verwaltung, keine technischen Logs). Widerrufen jederzeit auf derselben Seite.
2. Die Bridge ist ein stdio-MCP-Server: `node <checkout>/packages/mcp/dist/server.js` mit `BLACKBOX_API_URL=http://127.0.0.1:19180` und `BLACKBOX_AGENT_KEY_FILE=/absoluter/pfad/agent.key` in der Umgebung (nie als Argument). Im Pilot stammt das Bridge-Skript aus dem Git-Checkout (es liegt nicht im Release-Archiv); einmal `pnpm install && pnpm --filter @blackbox/mcp build`.
3. Konfiguration für Claude Desktop oder Claude Code: siehe den JSON-Block in Abschnitt 5 der englischen Fassung.
4. Im Pilot mit dem offiziellen MCP Inspector CLI verifiziert (`reports/evidence/MCP-03/`). Claude Desktop selbst wurde vom Projekt **nicht** gestartet. Reine Cloud-Agenten erreichen `127.0.0.1` nicht; es gibt keinen Tunnel.

## 6. Neustart, Stopp, Aktualisierung

```sh
./blackbox status          # laufende Dienste, Sicherungsstatus, Sperren
./blackbox down            # stoppen; Datenbank-Volume, Belege und Schlüssel bleiben
./blackbox up              # wieder starten; Demo-Antwort und Quellen sind noch da
./blackbox upgrade ~/Downloads/blackbox-<neu>-mac-arm64.tar.gz   # erst Sicherung, dann Migration und Prüfung; --resume bei Abbruch
```
Das Schließen des Browsers stoppt nichts. Docker Desktop beenden, Ruhezustand oder Herunterfahren pausieren die Verarbeitung; sie läuft weiter, sobald Docker wieder läuft.

## 7. Sicherung und Wiederherstellung (Verweise)

Bis ein Ziel eingerichtet ist, zeigen App und `doctor` **ungeschützt**. Richte ein Ziel außerhalb der Installation ein (ideal: externe Platte): `./blackbox backup-config /Volumes/Disk/blackbox` zeigt den **Wiederherstellungsschlüssel** einmal — getrennt vom Inhaberschlüssel aufbewahren. `./blackbox backup` erzeugt eine verschlüsselte Generation; danach eine pro 24 h, solange Blackbox läuft (7 tägliche + 4 wöchentliche). Wiederherstellen in einen neuen Ordner: `./blackbox restore <datei.tar.age>` (fragt nach dem Wiederherstellungsschlüssel; neuer Inhaberschlüssel einmal angezeigt; Quellen bleiben pausiert bis `./blackbox resume-sources`). Details und `--replace`: `INSTALL.de.md` §7, `docs/operations.md`.

## 8. Diagnose exportieren (explizit, bereinigt)

Es wird nie etwas automatisch gesendet. Wenn du ein Problem meldest, hänge ein selbst erzeugtes Paket an:

- In der App: System & Diagnose → **Diagnose exportieren** → Zeitraum und Kategorien wählen (Versionen, Gesundheit, Fehlerzähler, bereinigte Log-Auszüge) → **Paket vorab prüfen** zeigt Größe und Anzahl → **Paket herunterladen** (ZIP ≤ 10 MiB).
- Terminal (auch wenn die App nicht läuft): `./blackbox diagnostics export --since 24h --output ~/Desktop/blackbox-diagnostics.zip`.

Das Paket enthält Versions-/Laufzeit-/Gesundheits-/Fehler-Metadaten und Log-Auszüge mit pseudonymisierten IDs. Es enthält nie Geschäftsdatensätze, Belege, Datenbank-Dumps, Schlüssel, Tokens, persönliche Pfade oder rohe Anbieterkonfiguration. Öffne das ZIP und schau hinein, bevor du es sendest.

## 9. Bekannte Einschränkungen (Pilot)

- Nur Apple-Silicon-Mac mit Docker Desktop; ein Inhaber, ein Workspace, nur Loopback; keine native App, keine Signatur/Notarisierung, keine Passkeys, kein öffentliches Hosting.
- Aktuelle Datenpfade: Shopify und Shopify Payments (autorisiertes Shop-Token nötig; dem Projekt stand kein Live-Shop zur Verfügung, der Live-Nachweis bleibt blockiert), Bank-CSV, signierte typisierte API, deterministischer Replay und die gekennzeichnete Demo. easybill, DHL und die übrigen Katalogeinträge sind nur geplant.
- Die Anmeldung dauert absichtlich einige Sekunden (argon2id-Prüfung); auf einem ausgelasteten Mac länger.
- Das MCP-Bridge-Skript läuft aus dem Git-Checkout; es ist noch nicht im Release-Archiv gebündelt.
- Sicherungen gehen nur auf ein eingerichtetes, eingehängtes Ziel; ein schlafender Mac erzeugt keine. Verlust von Wiederherstellungsschlüssel und Installation ist nicht reparierbar.
- Diagnose-Aufbewahrung ist begrenzt (7 Tage / 100 MiB); DEBUG wird nur während eines aktiven Debug-Fensters aufgezeichnet.

## 10. Feedback-Checkliste

Bitte mit genauer Uhrzeit und der Version aus `./blackbox status` notieren:

1. Installation: liefen `doctor`/`setup` ohne manuellen Eingriff? Welche Abfragen zeigten macOS oder Docker?
2. Schlüssel: war klar, wo der Inhaberschlüssel erscheint und dass er nur einmal erscheint?
3. Demo/erster Import: hat die Demo geladen? Bei eigenen Quellen: welcher Anbieter, wie lange bis zur ersten Antwort, was sagte der Datenstatus?
4. Eine Frage: welche Vorlage, welche Parameter, war die Antwort verständlich, öffneten die Zitate die richtigen Einträge?
5. Agent: welcher Client und welche Version, lief `tools/list`, was lieferte eine Freitextfrage?
6. Neustart: war nach `./blackbox down` / `./blackbox up` alles (Demo-Antwort, Quellen, Sitzungen) noch da?
7. Alles, was verwirrend, langsam (mit Dauer) oder falsch war (mit dem Diagnosepaket aus Abschnitt 8, von dir erzeugt).

Es werden keine Nutzungsdaten erhoben; diese Liste ist der einzige Feedback-Kanal.
