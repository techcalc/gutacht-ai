# GutachtAI

Mängelaufnahme per Sprache → Gemini strukturiert → Supabase speichert → Dashboard editiert → White-Label-PDF.

Ein einziger Node-Service liefert **Frontend + API** aus.
- `/` → mobiler Rekorder
- `/dashboard` → Büro-Zentrale
- `/health` → Status (zeigt, ob Env-Variablen gesetzt sind)

## Routen
| Methode | Pfad | Zweck |
|---|---|---|
| POST | `/api/process-audio` | Audio → Gemini → Supabase |
| GET | `/api/reports?projectId=…` | Befunde eines Projekts |
| POST | `/api/update-report` | Befund bearbeiten |
| GET | `/api/generate-pdf?projectId=…` | White-Label-PDF |

## 1. Supabase
`supabase-schema.sql` im SQL-Editor ausführen. Legt Tabelle `reports` an.

## 2. Env-Variablen (in Coolify, NICHT committen)
```
GEMINI_API_KEY=…
SUPABASE_URL=https://…supabase.co
SUPABASE_SERVICE_ROLE_KEY=…
# optional: GEMINI_MODEL=gemini-2.5-flash
```

## 3. Coolify-Deployment
1. **New Resource → Application → Public/Private Repository** → dein GitHub-Repo.
2. **Build Pack: `Dockerfile`** (das Dockerfile liegt im Repo-Root).
3. **Ports Exposes: `3000`**.
4. Unter **Environment Variables** die drei Keys oben eintragen (Runtime).
5. Deploy. Im Log muss stehen: `✅ GutachtAI läuft auf Port 3000`.
6. Domain in Coolify zuweisen (Traefik macht HTTPS automatisch).

> Der Server bootet auch OHNE Keys (Container bleibt „running“). Fehlen Keys,
> sagt `/health` `configured:false` und die API antwortet mit klarem Fehler statt zu crashen.

## Lokal testen
```
npm install
GEMINI_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm start
```

## Was gefixt wurde (ggü. erster Version)
- Server serviert jetzt das Frontend (vorher gab's nur die Audio-Route).
- Fehlende Routen `/api/reports`, `/api/update-report`, `/api/generate-pdf` ergänzt.
- `@google/genai` von `^0.1.0` (uralt) auf `^2.x`; Model `gemini-1.5-flash` → `gemini-2.5-flash`.
- Audio-Mime-Bug: Recorder labelte `audio/mp3`, schickte aber webm → jetzt echtes Format.
- Frontend nutzt relative URLs (gleiche Origin) → keine hardcoded IP, kein Mixed-Content.
- Boot crasht nicht mehr bei fehlenden Env-Variablen (klare Logs statt „Exited“).
- `npm install` statt `npm ci` im Dockerfile → kein Lockfile-Zwang.
- `multer` auf 2.x (Sicherheits-Patches).
```
