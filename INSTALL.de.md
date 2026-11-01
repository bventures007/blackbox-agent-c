# Blackbox — Installationsanleitung (macOS, Apple Silicon)

Blackbox läuft vollständig auf Ihrem Mac: eine lokale Web-App unter `http://127.0.0.1:19180/`, ein Hintergrund-Worker, eine Rust-Engine und eine PostgreSQL-Datenbank – alles in Docker-Containern, die nur von diesem Mac aus erreichbar sind. Es gibt kein Cloud-Konto, keine Registrierung und keinen KI-/LLM-Schlüssel.

Der Download ist ein versioniertes `.tar.gz`-Archiv mit einem Shell-Skript (`blackbox`), der Container-Konfiguration und den vorgebauten Container-Images. Es ist **keine** native `.app`/DMG und weder signiert noch notarisiert; Sie benötigen Docker Desktop. Die Prüfsumme auf der Download-Seite erkennt einen beschädigten Download, sie ist keine Signatur.

## 1. Voraussetzungen (werden nicht automatisch installiert)

- Mac mit Apple Silicon (M1 oder neuer), macOS 14 oder neuer.
- **Docker Desktop 4.3x oder neuer** mit Compose v2 (`docker compose version`). Von docker.com installieren und starten, bevor es weitergeht. Blackbox installiert oder verändert niemals Docker oder andere globale Software.
- Etwa 10 GiB freier Speicherplatz (Images, Datenbank, Belege, Sicherungen).
- Ein Passwort-Manager für zwei Schlüssel (Zugangsschlüssel, Wiederherstellungsschlüssel für Sicherungen).

Nichts lauscht in Ihrem Netzwerk: Nur `127.0.0.1:19180` wird veröffentlicht. Eine andere Adresse wird bewusst abgelehnt.

## 2. Herunterladen und entpacken

1. Auf der Download-Seite **Für Mac herunterladen** wählen. Version, Datum, Größe und SHA-256 mit der erhaltenen Datei vergleichen:
   ```sh
   shasum -a 256 ~/Downloads/blackbox-<version>-mac-arm64.tar.gz
   ```
2. In einen Ordner entpacken, den Sie behalten (er wird Ihre Installation; später nicht verschieben):
   ```sh
   mkdir -p ~/Blackbox && tar -xzf ~/Downloads/blackbox-<version>-mac-arm64.tar.gz -C ~/Blackbox
   cd ~/Blackbox/blackbox-<version>
   ```
   macOS versieht Browser-Downloads mit einem Quarantäne-Attribut. Ein Shell-Skript und Docker-Images werden von Gatekeeper nicht wie ein App-Bundle behandelt; Sie müssen keine Sicherheitseinstellung ändern. Fragt das Terminal nach Zugriff auf Ordner (Downloads, externe Volumes), erlauben Sie ihn für die Ordner, die Sie verwenden. Deaktivieren Sie niemals macOS-Sicherheitsfunktionen global.

## 3. Voraussetzungen prüfen

```sh
./blackbox doctor
```
Exit-Code 0 bedeutet bereit, 1 bedeutet eingeschränkt (die `→`-Hinweise lesen), 2 bedeutet, dass eine Voraussetzung fehlt. `doctor` installiert oder verändert nie etwas.

## 4. Einrichten (einmalig)

```sh
./blackbox setup
```
Das erstellt die Konfiguration und die Schlüsseldateien (`secrets/`, nur für Ihren Benutzer lesbar), lädt die gebündelten Images, startet PostgreSQL, führt die Datenbank-Migrationen aus, startet alle Dienste und zeigt zum Schluss Ihren **persönlichen Zugangsschlüssel** (`bbk_…`) **genau einmal** im Terminal.

**Speichern Sie den Zugangsschlüssel jetzt im Passwort-Manager.** Er wird in keine Datei und kein Protokoll geschrieben. Bei Verlust hilft `./blackbox reset-access` (Abschnitt 9).

`setup` läuft nicht über eine bestehende Installation und ersetzt nie Zugangsdaten oder Daten. Die Phasen werden (ohne Werte) in `logs/setup.log` protokolliert.

## 5. App öffnen

Öffnen Sie `http://127.0.0.1:19180/` im Browser und melden Sie sich mit dem Zugangsschlüssel an. Das Schließen des Browsers stoppt Blackbox **nicht**: Die Datenübernahme läuft im Hintergrund weiter, solange Docker läuft. Nur `./blackbox down`, das Beenden von Docker Desktop oder das Herunterfahren des Macs stoppt die Verarbeitung; im ausgeschalteten oder schlafenden Zustand wird nichts verarbeitet, und die Arbeit wird nach dem Start fortgesetzt.

Beispieldaten ausprobieren: `./blackbox demo` (berührt nie Ihre eigenen Daten; die Demo ist gekennzeichnet).

## 6. Stoppen, neu starten, aktualisieren

```sh
./blackbox down      # stoppt die Container; Datenbank, Belege und Schlüssel bleiben
./blackbox up        # startet erneut und setzt fort
./blackbox status    # was läuft, Sicherungsstatus, Wartungssperren
./blackbox logs --since 1h --level warn    # funktioniert auch, wenn App oder Datenbank gestoppt sind
```

Aktualisieren ohne Datenverlust: neues Archiv herunterladen, dann aus dem **aktuellen** Installationsordner:
```sh
./blackbox upgrade ~/Downloads/blackbox-<neue-version>-mac-arm64.tar.gz
```
Das Update prüft Versionen und freien Speicher, erstellt zuerst eine Sicherung (es bricht ab, wenn keine Sicherung konfiguriert ist, außer Sie geben mit `--use-backup` eine geprüfte Sicherung an), pausiert die Verarbeitung, migriert die Datenbank, startet die neue Version und prüft sie. Wird es unterbrochen, setzt `./blackbox upgrade --resume` fort. Das Zurückwechseln auf alte Images macht keine Datenbank-Migration rückgängig; die Wiederherstellung erfolgt über die vor dem Update erstellte Sicherung.

## 7. Sicherungen (dringend empfohlen)

Bis Sicherungen konfiguriert sind, ist die Installation **ungeschützt**, und `doctor` sagt das auch.

1. Wählen Sie ein Ziel außerhalb der Installation, idealerweise auf einem separaten Volume (externe Festplatte). Ein Ordner auf derselben Festplatte funktioniert, schützt aber nicht vor dem Verlust des Macs.
2. Ziel registrieren:
   ```sh
   ./blackbox backup-config /Volumes/MeineSicherung/blackbox
   ```
   Dabei wird der **Wiederherstellungsschlüssel** (`AGE-SECRET-KEY-1…`) **einmal** angezeigt. Speichern Sie ihn im Passwort-Manager, getrennt vom Zugangsschlüssel. Ohne ihn lassen sich Sicherungen nicht entschlüsseln. Blackbox speichert nur den passenden öffentlichen Teil.
3. Erste Sicherung jetzt erstellen: `./blackbox backup`. Danach wird automatisch alle 24 Stunden eine verschlüsselte Sicherung erstellt, solange Blackbox läuft; 7 tägliche und 4 wöchentliche Generationen werden behalten. Ist der Mac aus oder das Ziel nicht eingehängt, wird nichts geschrieben, und die App zeigt, wie alt die neueste Sicherung ist.

Wiederherstellen (z. B. auf einem neuen Mac mit Docker und derselben Blackbox-Version):
```sh
./blackbox restore /Volumes/MeineSicherung/blackbox/blackbox-backup-<zeitstempel>.tar.age
```
Sie werden nach dem Wiederherstellungsschlüssel gefragt (verdeckte Eingabe; alternativ `BLACKBOX_RECOVERY_KEY_FILE` auf eine Datei mit dem Schlüssel setzen). Die Daten werden standardmäßig in einen **neuen, separaten** Installationsordner auf Port 19184 wiederhergestellt; die aktuelle Installation bleibt unberührt. Die wiederhergestellte Installation erhält einen **neuen Zugangsschlüssel** (einmal angezeigt), alle alten Sitzungen und Agenten-Schlüssel werden widerrufen. Die Quellenverarbeitung bleibt pausiert, bis Sie die Quellen geprüft haben: `./blackbox resume-sources`. Um stattdessen die aktuelle Installation zu überschreiben, verwenden Sie `--replace`; es zeigt an, was zerstört wird, und verlangt eine getippte Bestätigung.

## 8. Wo liegt was

| Pfad (im Installationsordner) | Inhalt |
| --- | --- |
| `.env` | nicht geheime Konfiguration (Port, Pfade) |
| `secrets/` | Schlüsseldateien, nur für Ihren Benutzer (0700/0600). Wer Zugriff auf diesen Ordner hat, kann Ihren Datenschlüssel lesen: FileVault verwenden, Ordner nicht teilen. |
| `data/logs/` | Anwendungsprotokolle (bereinigt), ohne App lesbar |
| `data/evidence/`, `data/snapshots/` | Rohbelege und Engine-Snapshots |
| `data/backups/status.json` | Sicherungsstatus, wie in der App angezeigt |
| `logs/setup.log` | Setup-Phasen (ohne Werte) |

Die Datenbank liegt im Docker-Volume `blackbox-agent-c_pgdata`. `./blackbox down` behält es; nur `./blackbox destroy --i-understand` löscht Volumes, nach einer getippten Bestätigung.

## 9. Zugangsschlüssel verloren

```sh
./blackbox reset-access
```
Funktioniert nur auf diesem Mac mit Zugriff auf den Ordner `secrets/` (es gibt keinen Web- oder E-Mail-Reset). Es wird ein neuer Zugangsschlüssel ausgegeben (einmal angezeigt), alle Sitzungen werden beendet, Agenten-Schlüssel widerrufen; alle Geschäftsdaten und Quellen bleiben erhalten.

## 10. Fehlerbehebung

| Symptom | Maßnahme |
| --- | --- |
| `doctor` Exit 2, `DOC-DOCKER` | Docker Desktop starten (oder installieren). |
| `DOC-PORT … in use` | Ein anderes Programm nutzt 19180: beenden oder vor `setup`/`up` `BLACKBOX_PORT=19181` in `.env` setzen. |
| `DOC-DISK` Warnung/kritisch | Speicherplatz freigeben; Sicherungen/Importe pausieren auf der kritischen Stufe. |
| `public/LAN binding is unsupported` | Nur `127.0.0.1` wird unterstützt; `BLACKBOX_BIND` entfernen. |
| `an installation already exists` | `setup` wurde in einem installierten Ordner ausgeführt: `up` oder `upgrade` verwenden. |
| App nach `up` nicht erreichbar | `./blackbox status`, dann `./blackbox logs --component api --level error`. |
| Sicherung `overdue`/`failed` | Ziel einhängen, `./blackbox backup` ausführen, Fehler in `status.json` lesen. |
| Wiederherstellung meldet `decryption failed` | Falscher oder fehlender Wiederherstellungsschlüssel. Daran führt kein Weg vorbei. |

Bereinigte Diagnosedaten für eine Support-Anfrage (lokale Datei, nichts wird hochgeladen):
```sh
./blackbox diagnostics export --since 24h --output ~/Desktop/blackbox-diagnostics.zip
```
