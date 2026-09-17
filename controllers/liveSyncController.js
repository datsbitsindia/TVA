const { db } = require('../database/init');

exports.checkUpdates = async (req, res) => {
    try {
        const u = req.session.user;
        if (!u) return res.json({ success: false, message: 'Not authenticated' });

        const lastTaskId = Number(req.query.last_task_id) || 0;
        const lastNotifId = Number(req.query.last_notif_id) || 0;

        let newTasks = [];
        if (lastTaskId > 0) {
            const baseQuery = `
                SELECT t.*, p.name project_name, c.name creator_name,
                       CASE WHEN t.due_date < CURDATE() AND t.status NOT IN ('Completed','Cancelled','2','3') THEN 1 ELSE 0 END is_overdue
                FROM tasks t
                LEFT JOIN projects p ON p.id=t.project_id
                LEFT JOIN users c ON c.id=t.created_by
            `;

            let filter = 't.id > ? AND (t.created_by=? OR FIND_IN_SET(?, t.assigned_to) > 0 OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id=?) OR t.id IN (SELECT task_id FROM task_forward_logs WHERE from_user_id=? OR to_user_id=?))';
            let params = [lastTaskId, u.id, u.id, u.id, u.id, u.id];
            if (u.role === 'admin') {
                filter = 't.id > ?';
                params = [lastTaskId];
            }

            newTasks = await db.prepare(`${baseQuery} WHERE ${filter} ORDER BY t.id DESC`).all(...params);
        }

        const formattedTasks = newTasks.map(t => {
            const assignedIds = String(t.assigned_to || '').split(',').map(x => Number(x.trim()));
            const isPureSelf = t.is_self_task || String(t.project_name || '').toLowerCase() === 'self task' || (Number(t.created_by) === u.id && assignedIds.length === 1 && assignedIds[0] === u.id);
            const isAssignedByMe = Number(t.created_by) === u.id && !isPureSelf;
            const isAssignedToMe = assignedIds.includes(u.id);
            const filterGroup = isPureSelf ? 'self' : isAssignedByMe ? 'assigned-by-me' : 'assigned-to-me';

            return {
                id: t.id,
                title: t.title,
                status: t.status,
                priority: t.priority,
                project_name: t.project_name || 'No project',
                project_id: t.project_id || null,
                creator_name: t.creator_name || 'System',
                created_by: t.created_by,
                due_date: t.due_date,
                created_at: t.created_at,
                is_overdue: t.is_overdue,
                is_routine: t.is_routine,
                is_forwarded: t.is_forwarded,
                is_verified: t.is_verified || 0,
                verifier_name: t.verifier_name || '',
                isPureSelf,
                isAssignedByMe,
                isAssignedToMe,
                filterGroup
            };
        });

        const unreadCountObj = await db.prepare('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND is_read=0').get(u.id);
        const unreadCount = unreadCountObj ? unreadCountObj.count : 0;

        const newNotifications = lastNotifId > 0
            ? await db.prepare('SELECT * FROM notifications WHERE user_id=? AND id > ? ORDER BY id DESC').all(u.id, lastNotifId)
            : [];

        const maxTaskObj = await db.prepare('SELECT COALESCE(MAX(id), 0) max_id FROM tasks').get();
        const maxTaskId = maxTaskObj ? maxTaskObj.max_id : 0;

        const maxNotifObj = await db.prepare('SELECT COALESCE(MAX(id), 0) max_id FROM notifications WHERE user_id=?').get(u.id);
        const maxNotifId = maxNotifObj ? maxNotifObj.max_id : 0;

        const activeTaskId = Number(req.query.active_task_id) || 0;
        const lastCommentId = Number(req.query.last_comment_id) || 0;

        let activeTaskData = null;
        let newComments = [];

        if (activeTaskId > 0) {
            const taskObj = await db.prepare(`
                SELECT t.id,
                    COALESCE(
                        (SELECT s.name FROM statuses s WHERE s.id = t.status_id LIMIT 1),
                        CASE t.status
                            WHEN '0' THEN 'Pending'
                            WHEN '1' THEN 'In Progress'
                            WHEN '2' THEN 'Completed'
                            WHEN '3' THEN 'Cancelled'
                            WHEN '4' THEN 'Planned'
                            ELSE t.status
                        END
                    ) AS status
                FROM tasks t WHERE t.id=?
            `).get(activeTaskId);
            if (taskObj) {
                const assignees = await db.prepare(`
                    SELECT ta.user_id, u.name, u.role,
                        COALESCE(
                            (SELECT name FROM statuses WHERE id = ta.status_id LIMIT 1),
                            ta.status,
                            'Pending'
                        ) AS status
                    FROM task_assignees ta
                    JOIN users u ON u.id=ta.user_id
                    WHERE ta.task_id=?
                `).all(activeTaskId);

                activeTaskData = {
                    id: taskObj.id,
                    status: taskObj.status,
                    assignees
                };

                newComments = await db.prepare(`
                    SELECT c.id, c.user_id, c.message, c.created_at, u.name
                    FROM comments c
                    JOIN users u ON u.id = c.user_id
                    WHERE c.task_id = ? AND c.id > ?
                    ORDER BY c.id ASC
                `).all(activeTaskId, lastCommentId);
            }
        }

        res.json({
            success: true,
            maxTaskId,
            maxNotifId,
            newTasks: formattedTasks,
            newNotifications,
            unreadCount,
            activeTaskData,
            newComments
        });
    } catch (err) {
        console.error('liveSync error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
};
