const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai'); // Das offizielle Google API Modul
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// Clients initialisieren
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
    try {
        const audioFile = req.file;
        const { projectId, userId, roomOrSection } = req.body;

        if (!audioFile || !projectId || !userId) {
            return res.status(400).json({ success: false, error: 'Fehlende Parameter.' });
        }

        // Gemini kann Audio direkt als Base64-Daten verarbeiten! Kein Whisper nötig.
        const audioPart = {
            inlineData: {
                data: audioFile.buffer.toString("base64"),
                mimeType: "audio/mp3"
            },
        };

        const prompt = `Du bist ein präziser KI-Assistent für Bausachverständige. 
        Höre dir das Audio genau an, erstelle einen strukturierten Befund und gib das Ergebnis AUSSCHLIESSLICH als valides JSON-Objekt in folgendem Format zurück:
        {
          "befund": "Professionelle Beschreibung des Mangels im Fachjargon",
          "ursache": "Mutmaßliche Ursache (oder 'Noch zu prüfen')",
          "dringlichkeit": "Hoch, Mittel oder Niedrig",
          "massnahme": "Sanierungsempfehlung"
        }`;

        // Wir nutzen das extrem schnelle und clevere Gemini 1.5 Flash
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: [prompt, audioPart],
            // Zwingt Gemini, echtes JSON auszugeben
            config: { responseMimeType: "application/json" } 
        });

        const structuredData = JSON.parse(response.text);

        // In Supabase speichern
        const { data, error: dbError } = await supabase
            .from('reports')
            .insert({
                project_id: projectId,
                user_id: userId,
                room_or_section: roomOrSection || 'Allgemein',
                raw_transcript: "Direkt via Gemini Audio verarbeitet", // Da Gemini Audio direkt liest
                structured_content: structuredData
            });

        if (dbError) throw dbError;

        return res.json({ success: true, data });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(port, () => {
    console.log(`GutachtAI Gemini-Server läuft auf Port ${port}`);
});