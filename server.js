// =====================================================================
//  GutachtAI – Backend (Express)
//  - serviert das Frontend (index.html mobil + dashboard.html)
//  - nimmt Audio entgegen, lässt Gemini strukturieren, speichert in Supabase
//  - liefert Befund-Liste, Update-Route und White-Label-PDF
// =====================================================================

const path = require('path');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config(); // liest .env LOKAL; im Container kommen die Werte aus Coolify

const app = express();
const PORT = process.env.PORT || 3000;

// Model per Env überschreibbar – Default ist ein aktuelles, GA-Audio-faehiges Flash-Model
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Audio max 20 MB (Gemini-Inline-Limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ---------------------------------------------------------------------
//  Env-Check OHNE Crash: Server bootet IMMER (Container bleibt "running"),
//  damit Frontend erreichbar ist. Fehlende Keys -> klare Fehlermeldung pro Request.
// ---------------------------------------------------------------------
const missingEnv = [];
if (!process.env.GEMINI_API_KEY) missingEnv.push('GEMINI_API_KEY');
if (!process.env.SUPABASE_URL) missingEnv.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
if (missingEnv.length) {
  console.warn('⚠️  WARNUNG – folgende Umgebungsvariablen fehlen: ' + missingEnv.join(', '));
  console.warn('    -> in Coolify unter "Environment Variables" eintragen. Server läuft trotzdem an.');
}

// Clients nur bauen, wenn Keys da sind (sonst null -> sauberer Fehler statt Boot-Crash)
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function ensureClients(res) {
  if (!ai || !supabase) {
    res.status(503).json({
      success: false,
      error: 'Server nicht konfiguriert. Fehlende Env-Variablen: ' + (missingEnv.join(', ') || 'unbekannt'),
    });
    return false;
  }
  return true;
}

// JSON aus Gemini robust parsen (falls doch mal ```json-Fences drumstehen)
function parseGeminiJson(text) {
  if (!text) throw new Error('Leere KI-Antwort');
  const clean = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

// =====================================================================
//  STATIC FRONTEND
// =====================================================================
app.use(express.static(path.join(__dirname, 'public')));

// Komfort-Routen
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Healthcheck (praktisch für Coolify)
app.get('/health', (_req, res) => {
  res.json({ ok: true, model: GEMINI_MODEL, configured: !!(ai && supabase) });
});

// =====================================================================
//  1) AUDIO -> GEMINI -> SUPABASE
// =====================================================================
app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const audioFile = req.file;
    const { projectId, userId, roomOrSection } = req.body;

    if (!audioFile || !projectId) {
      return res.status(400).json({ success: false, error: 'Fehlende Parameter (Audio oder projectId).' });
    }

    // WICHTIG: echten Mime-Type des Recorders nehmen (Browser liefert meist webm/opus,
    // NICHT mp3). Falsches Label = Gemini bekommt Müll. Fallback auf audio/webm.
    const mimeType = audioFile.mimetype && audioFile.mimetype !== 'application/octet-stream'
      ? audioFile.mimetype
      : 'audio/webm';

    const prompt = `Du bist ein präziser KI-Assistent für Bausachverständige.
Höre dir das Audio genau an, erstelle einen strukturierten Befund und gib das Ergebnis
AUSSCHLIESSLICH als valides JSON in exakt diesem Format zurück (keine weiteren Felder, kein Markdown):
{
  "befund": "Professionelle Beschreibung des Mangels im Fachjargon",
  "ursache": "Mutmaßliche Ursache (oder 'Noch zu prüfen')",
  "dringlichkeit": "Hoch | Mittel | Niedrig",
  "massnahme": "Konkrete Sanierungsempfehlung"
}`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        { text: prompt },
        { inlineData: { mimeType, data: audioFile.buffer.toString('base64') } },
      ],
      config: { responseMimeType: 'application/json' },
    });

    const structured = parseGeminiJson(response.text);

    const { data, error: dbError } = await supabase
      .from('reports')
      .insert({
        project_id: projectId,
        user_id: userId || null,
        room_or_section: roomOrSection || 'Allgemein',
        raw_transcript: 'Direkt via Gemini-Audio verarbeitet',
        structured_content: structured,
      })
      .select();

    if (dbError) throw dbError;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('process-audio:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
//  2) ALLE BEFUNDE EINES PROJEKTS LISTEN  (vom Dashboard genutzt)
// =====================================================================
app.get('/api/reports', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { projectId } = req.query;
    if (!projectId) {
      return res.status(400).json({ success: false, error: 'projectId fehlt.' });
    }
    const { data, error } = await supabase
      .from('reports')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (error) {
    console.error('reports:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
//  3) BEFUND BEARBEITEN / SPEICHERN  (vom Dashboard genutzt)
// =====================================================================
app.post('/api/update-report', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { id, room_or_section, structured_content } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id fehlt.' });

    const { data, error } = await supabase
      .from('reports')
      .update({ room_or_section, structured_content })
      .eq('id', id)
      .select();

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (error) {
    console.error('update-report:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
//  4) WHITE-LABEL-PDF GENERIEREN  (vom Dashboard genutzt)
// =====================================================================
app.get('/api/generate-pdf', async (req, res) => {
  if (!ensureClients(res)) return;
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ success: false, error: 'projectId fehlt.' });

    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Gutachten_${projectId}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    // ---- Kopf ----
    doc.fontSize(20).fillColor('#1e293b').text('Mängelbericht / Gutachten', { align: 'left' });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor('#64748b')
      .text(`Projekt: ${projectId}`)
      .text(`Erstellt: ${new Date().toLocaleString('de-DE')}`)
      .text(`Anzahl Befunde: ${reports ? reports.length : 0}`);
    doc.moveDown(0.5);
    doc.strokeColor('#e2e8f0').lineWidth(1)
      .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.8);

    if (!reports || reports.length === 0) {
      doc.fontSize(12).fillColor('#1e293b').text('Keine Befunde vorhanden.');
    }

    (reports || []).forEach((r, i) => {
      const c = r.structured_content || {};

      // Seitenumbruch falls wenig Platz
      if (doc.y > 700) doc.addPage();

      doc.fontSize(13).fillColor('#2563eb')
        .text(`${i + 1}. ${r.room_or_section || 'Allgemein'}`, { continued: true });
      doc.fontSize(9).fillColor('#94a3b8')
        .text(`   [Dringlichkeit: ${c.dringlichkeit || 'Mittel'}]`);
      doc.moveDown(0.3);

      const row = (label, value) => {
        doc.fontSize(9).fillColor('#64748b').text(label.toUpperCase());
        doc.fontSize(11).fillColor('#1e293b').text(value || '–', { paragraphGap: 4 });
        doc.moveDown(0.2);
      };

      row('Befund', c.befund);
      row('Ursache', c.ursache);
      row('Empfohlene Maßnahme', c.massnahme);

      doc.moveDown(0.3);
      doc.strokeColor('#f1f5f9').lineWidth(1)
        .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.6);
    });

    // ---- Fuß ----
    doc.fontSize(8).fillColor('#cbd5e1')
      .text('Erstellt mit GutachtAI', 50, 800, { align: 'center', width: 495 });

    doc.end();
  } catch (error) {
    console.error('generate-pdf:', error);
    if (!res.headersSent) res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ GutachtAI läuft auf Port ${PORT}  (Model: ${GEMINI_MODEL})`);
  console.log(`   Mobil:     http://localhost:${PORT}/`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
});
