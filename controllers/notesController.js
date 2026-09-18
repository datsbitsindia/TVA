const { db } = require('../database/init');

exports.list = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const searchQuery = req.query.q ? String(req.query.q).trim() : '';

        let notes;
        if (searchQuery) {
            const term = `%${searchQuery.toLowerCase()}%`;
            notes = await db.prepare("SELECT * FROM notes WHERE user_id=? AND (LOWER(title) LIKE ? OR LOWER(details) LIKE ?) ORDER BY updated_at DESC").all(userId, term, term);
        } else {
            notes = await db.prepare("SELECT * FROM notes WHERE user_id=? ORDER BY updated_at DESC").all(userId);
        }

        res.render('notes-list', {
            notes: notes || [],
            searchQuery,
            page: 'notes'
        });
    } catch (err) {
        console.error('Error listing notes:', err);
        res.status(500).render('error', { message: 'Failed to load personal notes.' });
    }
};

exports.detail = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const noteId = Number(req.params.id);

        const note = await db.prepare("SELECT * FROM notes WHERE id=? AND user_id=?").get(noteId, userId);
        if (!note) {
            return res.redirect('/notes');
        }

        res.render('note-detail', {
            note,
            page: 'notes'
        });
    } catch (err) {
        console.error('Error loading note detail:', err);
        res.status(500).render('error', { message: 'Failed to load note details.' });
    }
};

exports.create = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const result = await db.prepare("INSERT INTO notes(user_id, title, details, created_at, updated_at) VALUES(?, '', '', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE))").run(userId);
        res.redirect(`/notes/${result.lastInsertRowid}`);
    } catch (err) {
        console.error('Error creating note:', err);
        res.status(500).render('error', { message: 'Failed to create new note.' });
    }
};

exports.autoSave = async (req, res) => {
    try {
        const noteId = Number(req.params.id);
        const userId = req.session.user.id;
        
        let title = '';
        let details = '';

        if (req.body) {
            if (typeof req.body === 'string') {
                try {
                    const parsed = JSON.parse(req.body);
                    title = parsed.title || '';
                    details = parsed.details || '';
                } catch(e) {
                    title = '';
                    details = req.body;
                }
            } else {
                title = req.body.title || '';
                details = req.body.details || '';
            }
        }

        if (!noteId) {
            return res.status(400).json({ success: false, message: 'Invalid note ID' });
        }

        const existing = await db.prepare("SELECT id FROM notes WHERE id=? AND user_id=?").get(noteId, userId);
        if (!existing) {
            return res.status(403).json({ success: false, message: 'Note not found or access denied' });
        }

        await db.prepare("UPDATE notes SET title=?, details=?, updated_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL 330 MINUTE) WHERE id=? AND user_id=?").run(
            String(title).substring(0, 250),
            String(details),
            noteId,
            userId
        );

        return res.json({ success: true, updated_at: new Date().toISOString() });
    } catch (err) {
        console.error('Auto-save error:', err);
        return res.status(500).json({ success: false, message: 'Auto-save failed: ' + err.message });
    }
};

exports.deleteNote = async (req, res) => {
    try {
        const noteId = Number(req.params.id);
        const userId = req.session.user.id;

        await db.prepare("DELETE FROM notes WHERE id=? AND user_id=?").run(noteId, userId);
        res.redirect('/notes');
    } catch (err) {
        console.error('Error deleting note:', err);
        res.status(500).render('error', { message: 'Failed to delete note.' });
    }
};
