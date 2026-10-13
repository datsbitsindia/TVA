const aiService = require('../services/aiService');

async function handleChatMessage(req, res) {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized. Please login to use AI Task Assistant.'
            });
        }

        const { message } = req.body;
        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({
                success: false,
                error: 'Message parameter is required.'
            });
        }

        // Initialize session chat history if missing
        if (!req.session.aiChatHistory) {
            req.session.aiChatHistory = [];
        }

        // Limit conversation history to last 15 messages to prevent overflow
        const historyContext = req.session.aiChatHistory.slice(-15);

        let result = null;
        try {
            result = await aiService.processUserMessage(req.session.user, message.trim(), historyContext);
        } catch (aiErr) {
            console.error('aiService.processUserMessage Error:', aiErr);
        }
        const replyMessage = (result && result.reply) ? result.reply : "Sorry, AI service encountered an issue. Please try again in a moment.";

        // Store user prompt and assistant response in session history
        req.session.aiChatHistory.push({ role: 'user', content: message.trim() });
        req.session.aiChatHistory.push({ role: 'model', content: replyMessage });

        return res.json({
            success: true,
            reply: replyMessage,
            history: req.session.aiChatHistory
        });
    } catch (err) {
        console.error('aiController Error:', err);
        return res.status(500).json({
            success: false,
            error: 'Internal server error while processing AI message.'
        });
    }
}

async function getChatHistory(req, res) {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }
        return res.json({
            success: true,
            history: req.session.aiChatHistory || []
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
}

async function clearChatHistory(req, res) {
    try {
        if (req.session) {
            req.session.aiChatHistory = [];
        }
        return res.json({ success: true, message: 'Chat history cleared.' });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
}

async function handleVoiceMessage(req, res) {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, error: 'Audio recording file is required.' });
        }

        // Transcribe audio via Groq Whisper API (whisper-large-v3-turbo)
        const transcribedText = await aiService.transcribeAudioWithGroq(req.file.buffer, req.file.originalname || 'speech.webm');
        if (!transcribedText) {
            return res.status(500).json({ success: false, error: 'Failed to recognize speech. Please speak clearly and try again.' });
        }

        if (!req.session.aiChatHistory) req.session.aiChatHistory = [];
        const historyContext = req.session.aiChatHistory.slice(-15);

        const result = await aiService.processUserMessage(req.session.user, transcribedText, historyContext);

        req.session.aiChatHistory.push({ role: 'user', content: transcribedText });
        req.session.aiChatHistory.push({ role: 'model', content: result.reply });

        return res.json({
            success: true,
            transcription: transcribedText,
            reply: result.reply,
            history: req.session.aiChatHistory
        });
    } catch (err) {
        console.error('handleVoiceMessage Error:', err);
        return res.status(500).json({ success: false, error: 'Voice processing error: ' + err.message });
    }
}

async function handleAudioTranscription(req, res) {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, error: 'Audio recording file is required.' });
        }

        // Transcribe audio via Groq Whisper API (whisper-large-v3-turbo)
        const transcribedText = await aiService.transcribeAudioWithGroq(req.file.buffer, req.file.originalname || 'speech.webm');

        return res.json({
            success: true,
            transcription: transcribedText || ''
        });
    } catch (err) {
        console.error('handleAudioTranscription Error:', err);
        return res.json({ success: true, transcription: '' });
    }
}

module.exports = {
    handleChatMessage,
    getChatHistory,
    clearChatHistory,
    handleVoiceMessage,
    handleAudioTranscription
};
