# Tonspur – persönlicher Musik-Player (iOS-PWA)

Dunkles UI im Stil von Apple Music/Spotify, Suche über den kompletten Deezer-Katalog, Sofort-Wiedergabe und automatischer Download in voller Qualität in die Jellyfin-Bibliothek auf dem Mac Mini.

```
iPhone (PWA)  ──HTTPS──▶  Tonspur-Backend (Node, Port 3000)
                               ├─ Deezer-API ........ Suche, Cover, Metadaten, 30-s-Vorschau
                               ├─ Jellyfin :8096 .... Bibliothek, Streaming, Scan
                               ├─ yt-dlp ............ Sofort-Stream kompletter Songs
                               └─ Deemix :6595 ...... FLAC-Download → ~/jellyfin-app/media/music
```

## Empfohlener Dauerbetrieb: native App + Spotify-Sync

Für den Alltag auf dem iPhone brauchst du die Tonspur-Web-App nicht. Stabiler ist eine native Jellyfin-App aus dem App Store, empfohlen: **Finamp** (kostenlos, Open Source, Offline-Downloads, CarPlay). Tonspur läuft dann als Dienst im Hintergrund und sorgt dafür, dass in Jellyfin alles liegt, was du hören willst:

- **Spotify-Playlists** werden als echte Jellyfin-Playlists gespiegelt. Neue Titel bei Spotify landen automatisch in der Bibliothek und in der Playlist, entfernte verschwinden aus der Playlist (die Datei bleibt). Abgleich alle `SYNC_INTERVAL_HOURS` Stunden (Standard 6) und nach jedem Download-Schub.
- Titel holt Deemix von Deezer. Kann Deemix einen Titel nicht liefern oder gibt es ihn bei Deezer nicht, kommt er über YouTube Music als M4A mit Tags und Cover in den Musikordner.
- Das Spotify-Cover wird als Bild der Jellyfin-Playlist gesetzt (und erneuert, wenn es sich bei Spotify ändert).
- Die Playlist behält in Jellyfin dieselbe ID. Finamp aktualisiert sie also, statt eine neue anzulegen, auch wenn du sie offline geladen hast.

**Playlists einrichten**, zwei Wege:

1. In der Tonspur-Web-App: Spotify-Link (Teilen → Link kopieren) ins Suchfeld → „Übernehmen" → auf der Playlist-Seite „Synchronisieren".
2. Ohne Oberfläche in der `.env`:
   ```
   SYNC_SPOTIFY_PLAYLISTS=https://open.spotify.com/playlist/AAA,https://open.spotify.com/playlist/BBB
   ```
   Nach `pm2 restart tonspur` bzw. `docker compose … up -d` legt der Dienst die Playlists innerhalb einer Minute an.

Die Playlists gehören dem Jellyfin-Benutzer, mit dem Tonspur arbeitet (erster Admin oder `JELLYFIN_USER_ID`), und sind als öffentlich markiert. Melde dich in Finamp mit diesem Benutzer an.

Ohne Spotify-Zugangsdaten liest Tonspur höchstens etwa 100 Titel pro Playlist (siehe „Spotify-Playlists übernehmen").

## So funktioniert die Wiedergabe

Tippst du auf einen Song, entscheidet das Backend in dieser Reihenfolge:

1. Song liegt schon in Jellyfin → Stream direkt vom Mac Mini (FLAC, volle Qualität). Badge im Player: „Bibliothek".
2. Sonst kompletter Song über yt-dlp (YouTube Music, offizielle Audio-Version, per Dauer und Titel abgeglichen). Badge: „Stream". Die ersten Treffer jeder Suche, Album- und Künstlerseite werden schon beim Anzeigen vorgeladen, deshalb startet der Song nach dem Tippen ohne Wartezeit.
3. Braucht yt-dlp länger als 8 s → zuerst die 30-Sekunden-Vorschau von Deezer (Badge: „Vorschau · 30 s"). Sobald der ganze Song bereit ist, wechselt der Player automatisch darauf und meldet „Ganzer Song geladen". Endet die Vorschau vorher, wartet er auf den ganzen Song, statt weiterzuspringen. Ohne yt-dlp bleibt es bei der Vorschau.

YouTube drosselt Downloads ohne festes Ende auf etwa doppelte Abspielgeschwindigkeit. Der Server holt die Audiodatei deshalb in festen 10-MB-Stücken (wie yt-dlp selbst) und reicht sie an das iPhone weiter – damit kommt sie mit voller Bandbreite.

Turbo: Beim Öffnen einer Playlist, eines Albums oder einer Künstlerseite werden die Stream-Adressen der ersten 30 Titel vorab geholt, während der Wiedergabe immer die nächsten 5. Ein angetippter Song wartet nie auf vorgeladene Songs. Gefundene YouTube-Videos merkt sich das Backend dauerhaft (`data/yt-ids.json`), beim zweiten Abspielen entfällt die Suche. Wenn der Stream hakt, zeigt Bibliothek → Status den letzten yt-dlp-Fehler.

Nach 5 Sekunden Wiedergabe schickt die App lautlos `POST /api/download` ans Backend. Die 5 Sekunden sind Absicht: Wer durch Charts skippt, soll nicht 40 Songs auf die Platte laden. Das Backend prüft, ob der Song schon in Jellyfin liegt, und schickt ihn sonst an Deemix. Es fragt den Fortschritt alle 3 s ab und startet nach dem letzten fertigen Download (15 s Puffer, damit mehrere Downloads nur einen Scan auslösen) den Jellyfin-Scan. Ab dann kommt derselbe Song automatisch aus der Bibliothek.

Das Herz bei einem Song oder Album macht dasselbe sofort, beim Album für das komplette Album. Öffentliche Deezer-Playlists findest du in der Suche unter „Playlists"; der Download-Knopf auf der Playlist-Seite lädt jeden Titel einzeln, damit die Ordnerstruktur nach Künstler/Album sauber bleibt. Favoriten liegen in `data/favorites.json` auf dem Mac Mini, nicht im Browser.

## SoundCloud

Die Suche zeigt SoundCloud-Treffer unter „Alle" und im Reiter „SoundCloud", dazu SoundCloud-Playlists. Kein Konto nötig; Tonspur nutzt dieselbe Schnittstelle wie soundcloud.com. Abgespielt wird über yt-dlp: Der Song wird in 1–3 s komplett als MP3 auf den Mac geladen (Zwischenspeicher `data/cache/sc`, begrenzt auf `CACHE_LIMIT_MB`) und von dort gestreamt. Go+-Titel (bei SoundCloud nur 30-s-Ausschnitt) werden ausgeblendet.

Gehörte oder gelikte SoundCloud-Songs landen mit Titel, Künstler und Cover als `<Künstler>/<Titel>/<Titel>.mp3` in `MUSIC_DIR` (Standard `~/jellyfin-app/media/music`), danach folgt der Jellyfin-Scan. SoundCloud liefert meist 128–160 kbps, nicht FLAC.

Voraussetzung: `brew install ffmpeg`.

## Spotify-Playlists übernehmen

Spotify-Link einer Playlist oder eines Albums (Teilen → Link kopieren) in die Suche einfügen → „Übernehmen". Tonspur sucht jeden Titel bei Deezer (über ISRC, sonst Künstler + Titel + Dauer) und legt die Playlist unter Bibliothek → Playlists ab. Abgespielt und geladen wird dann ganz normal über Deezer/YouTube; Spotify selbst lässt sich nicht abspielen (DRM). „Neu abgleichen" holt den aktuellen Stand der Playlist.

Ohne Zugangsdaten liest Tonspur die öffentliche Einbettungsseite von Spotify. Das klappt auch für Spotifys eigene Playlists (Today's Top Hits, RapCaviar …), liefert aber höchstens etwa 100 Titel. Für längere Playlists: auf developer.spotify.com eine App anlegen (Redirect-URI egal, z. B. `http://localhost`) und `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` in die `.env` eintragen. Spotifys eigene Playlists sperrt die offizielle Schnittstelle für fremde Apps; dafür fällt Tonspur automatisch auf die Einbettungsseite zurück.

## Deezer-Qualität

Tonspur fordert bei Deemix zuerst `DEEMIX_BITRATE` an (Standard FLAC). Lehnt Deemix mit „CantStream" ab, weil das Konto diese Qualität nicht laden darf, geht es automatisch auf MP3 320 und dann MP3 128 herunter. Die tatsächlich genutzte Qualität steht unter Bibliothek → Status.

## Homeserver mit Docker (z. B. ThinkCentre)

`homeserver.compose.yml` startet Jellyfin, Deemix und Tonspur zusammen. Sie teilen sich den Musikordner (`./music` oder `MUSIC_HOST_DIR` in der `.env`).

```bash
git clone https://github.com/mywifisucks123/tonspur.git ~/tonspur
cd ~/tonspur
cp .env.example .env          # JELLYFIN_API_KEY bleibt erst mal leer
docker compose -f homeserver.compose.yml up -d --build
```

Ist Port 3000 auf dem Server schon belegt, in der `.env` z. B. `TONSPUR_PORT=8787` setzen.

Danach:

1. `http://<server>:8096`: Jellyfin einrichten, Musikbibliothek mit dem Ordner `/media/music` anlegen, unter Dashboard → API-Schlüssel einen Schlüssel erzeugen.
2. `http://<server>:6595`: In Deemix mit dem ARL anmelden. Download-Ordner ist `/downloads`, das ist bereits der Musikordner.
3. In der `.env` `JELLYFIN_API_KEY`, `DEEMIX_ARL` und optional `SYNC_SPOTIFY_PLAYLISTS` eintragen, dann `docker compose -f homeserver.compose.yml up -d`.
4. Tailscale auf dem Server installieren und Jellyfin per HTTPS freigeben: `sudo tailscale serve --bg 8096`. In Finamp dann die angezeigte Adresse `https://<server>.<tailnet>.ts.net` eintragen. Die Tonspur-Web-App ist parallel erreichbar über `sudo tailscale serve --bg --https=8443 3000`.

Hardware-Transcoding mit Intel Quick Sync: Die `devices`-Zeilen bei Jellyfin einkommentieren, wenn `/dev/dri` existiert.

## Vorab: zwei Punkte, an denen es sonst hakt

HTTPS ist Pflicht für den Service Worker. Über `http://192.168.0.104:3000` läuft die App zwar und lässt sich auch als Vollbild-App auf den Home-Bildschirm legen, aber iOS registriert ohne HTTPS keinen Service Worker. Die saubere Lösung ist Tailscale Serve (siehe unten): echtes Zertifikat, funktioniert zu Hause und unterwegs, nichts wird ins Internet geöffnet.

Der Deemix-Container muss in den Jellyfin-Ordner schreiben. Das Backend sagt Deemix nur *was* geladen wird, *wohin* bestimmt der Container. Prüfen:

```bash
docker inspect deemix --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Dort muss `~/jellyfin-app/media/music -> /downloads` auftauchen (bzw. der Pfad, den Deemix in den Einstellungen als Download-Ordner nutzt). Wenn nicht, den Container mit `-v ~/jellyfin-app/media/music:/downloads` neu anlegen. In den Deemix-Einstellungen „Ordner für Künstler" und „Ordner für Alben" anlassen, dann sortiert Jellyfin sauber.

## Einrichtung

```bash
git clone https://github.com/mywifisucks123/tonspur.git ~/tonspur
cd ~/tonspur
cp .env.example .env
```

In der `.env` drei Werte setzen:

- `JELLYFIN_API_KEY`: Jellyfin → Dashboard → API-Schlüssel → „+" → Name „Tonspur".
- `DEEMIX_ARL`: dasselbe ARL, das Deemix nutzt. Aus dem Container lesen: `docker exec deemix cat /config/.arl` (Containername ggf. anpassen).
- `DEEMIX_BITRATE`: `9` = FLAC (Standard), `3` = MP3 320.

Optional `JELLYFIN_MUSIC_LIBRARY_ID`, damit nur die Musikbibliothek gescannt wird statt aller Bibliotheken (die ID steht in der Jellyfin-URL, wenn du die Bibliothek öffnest: `...&topParentId=<ID>`).

### Variante A: PM2 (empfohlen, nativ auf dem Mac)

```bash
brew install node yt-dlp deno ffmpeg
npm install -g pm2

cd ~/tonspur
npm install --omit=dev
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # gibt einen sudo-Befehl aus → den ausführen, dann startet alles nach Reboot
```

Logs: `pm2 logs tonspur`. Neustart nach Änderungen an der `.env`: `pm2 restart tonspur`.

Falls die Status-Seite nach einem Reboot „yt-dlp nicht installiert" meldet, fehlt Homebrew im PATH von launchd. Dann in der `.env` `YTDLP_BIN=/opt/homebrew/bin/yt-dlp` setzen und `pm2 restart tonspur`.

yt-dlp regelmäßig aktualisieren, YouTube ändert ständig etwas: `brew upgrade yt-dlp`. Die JavaScript-Runtime, die yt-dlp seit Ende 2025 für YouTube braucht, setzt das Backend selbst (Deno, falls installiert, sonst das vorhandene Node).

### Variante B: Docker

```bash
cd ~/tonspur
docker compose up -d --build
docker compose logs -f
```

`docker-compose.yml` biegt `JELLYFIN_URL` und `DEEMIX_URL` automatisch auf `host.docker.internal` um, weil Jellyfin und Deemix aus Sicht des Containers auf dem Host laufen. yt-dlp ist im Image enthalten; aktualisieren mit `docker compose build --no-cache && docker compose up -d`.

### Läuft es?

`http://192.168.0.104:3000` im Browser öffnen → Bibliothek → Status. Alle fünf Punkte sollten grün sein (Service Worker wird erst unter HTTPS grün).

## Aufs iPhone

1. Tailscale-Adminkonsole → DNS: MagicDNS und „HTTPS Certificates" aktivieren.
2. Auf dem Mac Mini:
   ```bash
   tailscale serve --bg 3000
   ```
   Mit der Tailscale-App aus dem App Store heißt der Befehl `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3000`. Die Ausgabe zeigt die Adresse, etwa `https://mac-mini.tailXXXX.ts.net`.
3. Auf dem iPhone Tailscale aktivieren (auch zu Hause), die Adresse in Safari öffnen.
4. Teilen → „Zum Home-Bildschirm". Ab jetzt startet Tonspur ohne Safari-Leisten, mit Sperrbildschirm-Steuerung, AirPlay und Hintergrund-Wiedergabe.

## Projektstruktur

```
tonspur/
├── src/
│   ├── server.js       Express-Server, alle API-Routen, liefert das Frontend aus
│   ├── config.js       liest .env
│   ├── resolver.js     wählt die Audioquelle (Jellyfin → yt-dlp → Vorschau)
│   ├── ytdlp.js        YouTube-Music-Suche, Treffer-Scoring, Audio-URL
│   ├── proxy.js        Range-fähiger Stream-Proxy (iOS braucht 206-Antworten)
│   ├── downloads.js    Download-Queue, Deemix-Polling, Jellyfin-Scan
│   ├── deemix.js       Deemix-API (Login per ARL, addToQueue, getQueue)
│   ├── jellyfin.js     Jellyfin-API (Suche, Abgleich, Stream, Scan)
│   ├── deezer.js       öffentliche Deezer-API
│   ├── soundcloud.js   SoundCloud-Suche, -Audio, Ablage im Musikordner
│   ├── spotify.js      Spotify-Import und Abgleich mit Deezer
│   ├── imports.js      gespeicherte Spotify-Importe
│   ├── sync.js         Spotify-Playlists → Jellyfin-Playlists
│   ├── media.js        ffmpeg, schneller Download, Tags/Cover, Zwischenspeicher
│   ├── favorites.js    Favoriten als JSON
│   └── util.js
├── public/             PWA: index.html, manifest, Service Worker, CSS, JS, Icons
├── data/               favorites.json, downloads.json (wird angelegt)
├── Dockerfile, docker-compose.yml, ecosystem.config.cjs
└── .env.example
```

## API

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/search?q=` | Deezer-Songs/Alben/Künstler + Treffer aus Jellyfin |
| GET | `/api/charts` | Startseite |
| GET | `/api/album/:id`, `/api/artist/:id`, `/api/playlist/:id` | Deezer-Details |
| GET | `/api/stream/dz/:id` | Audio für einen Deezer-Track (Quelle automatisch) |
| GET | `/api/stream/jf/:id` | Audio direkt aus Jellyfin |
| GET | `/api/source/dz/:id` | welche Quelle gerade genutzt wird |
| POST | `/api/prefetch` `{ids}` | yt-dlp-Auflösung vorwärmen |
| POST | `/api/download` `{type, id, reason, source}` | Track/Album/Playlist laden (`type: sc` für SoundCloud) |
| GET | `/api/sc/playlist/:id`, `/api/stream/sc/:id` | SoundCloud-Playlist / -Audio |
| POST | `/api/import` `{url}` | Spotify-Playlist/-Album übernehmen oder SoundCloud-Link auflösen |
| GET/DELETE | `/api/imports`, `/api/imports/:id` | übernommene Spotify-Playlists |
| GET/POST | `/api/sync`, `/api/sync/:id` `{enabled}` | Spotify → Jellyfin-Sync ein/aus, Status |
| POST | `/api/sync/:id/run` | sofort abgleichen |
| GET/DELETE | `/api/downloads` | Download-Status / erledigte ausblenden |
| GET/POST/DELETE | `/api/favorites` | Favoriten |
| GET | `/api/library/albums`, `/api/jf/album/:id` | Jellyfin-Bibliothek |
| GET | `/api/health` | Status aller Dienste |

## Grenzen

- Das Backend hat keinen Login. Es gehört nur ins LAN bzw. Tailnet, keine Portfreigabe im Router.
- Der Abgleich Deezer ↔ Jellyfin läuft über Titel + Künstler bzw. Dauer. Da Deemix die Tags aus Deezer schreibt, passt das fast immer; bei Dateien aus anderen Quellen kann ein Song doppelt geladen werden.
- iOS kann eine Home-Bildschirm-App nach langer Zeit im Hintergrund beenden. Läuft Musik, passiert das praktisch nicht; nach dem Pausieren über Nacht startet die App neu, Warteschlange und Position bleiben gespeichert.
- yt-dlp und Deemix verstoßen gegen die Nutzungsbedingungen von YouTube bzw. Deezer. Für den privaten Gebrauch ist das dein Risiko, nicht weiterverbreiten.
