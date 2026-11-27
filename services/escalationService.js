const { db } = require('../database/init');
const notifications = require('./notificationService');

let lastRadarRunMs = 0;

/**
 * Formats a MySQL DATE / Date object into YYYY-MM-DD in IST (+05:30) without timezone drift.
 */
function toYMD(val) {
    if (!val) return null;
    if (val instanceof Date) {
        const ist = new Date(val.getTime() + (5.5 * 60 * 60 * 1000));
        return ist.toISOString().slice(0, 10);
    }
    const str = String(val).trim();
    return str.length >= 10 ? str.slice(0, 10) : null;
}

/**
 * Converts a YYYY-MM-DD date string to end-of-day timestamp (23:59:59 IST) in epoch ms.
 */
function getDeadlineEndOfDayMs(ymd) {
    if (!ymd) return null;
    const d = new Date(`${ymd}T23:59:59+05:30`);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Smart Escalation & Blocker Radar:
 * 1. 24h Stagnant Nudge: Task is due within 24h, still Pending/Planned (not started), not blocked -> nudge assignee(s).
 * 2. 4h Risk of Delay Escalation: Task has <= 4h remaining before deadline & no recent update in >= 4h -> alert Manager/Creator/Admin.
 */
async function checkSmartEscalations(options = {}) {
    const {
        force = false,
        orgId = null,
        taskId = null,
        simulateHoursLeft = null,
        ignoreIdleWindow = false
    } = options;

    try {
        const nowMs = Date.now();
        if (!force && (nowMs - lastRadarRunMs < 60 * 1000)) {
            return { skipped: true, nudgesSent: 0, escalationsSent: 0 };
        }
        lastRadarRunMs = nowMs;

        const whereClauses = [
            "t.due_date IS NOT NULL",
            "t.is_blocked = 0",
            "LOWER(COALESCE((SELECT name FROM statuses WHERE id=t.status_id LIMIT 1), t.status, 'Pending')) NOT IN ('completed', 'cancelled', '2', '3')"
        ];
        const params = [];

        if (orgId) {
            whereClauses.push("t.organization_id = ?");
            params.push(Number(orgId));
        }
        if (taskId) {
            whereClauses.push("t.id = ?");
            params.push(Number(taskId));
        }

        const tasks = await db.prepare(`
            SELECT t.id, t.task_number, t.organization_id, t.title, t.due_date, t.status, t.status_id,
                   t.assigned_to, t.created_by, t.created_at, t.updated_at,
                   t.nudge_24h_sent, t.escalation_4h_sent,
                   p.manager_id,
                   COALESCE(
                       (SELECT GROUP_CONCAT(u.name ORDER BY u.name SEPARATOR ', ') FROM task_assignees ta2 JOIN users u ON u.id=ta2.user_id WHERE ta2.task_id=t.id),
                       (SELECT GROUP_CONCAT(u.name ORDER BY u.id SEPARATOR ', ') FROM users u WHERE FIND_IN_SET(u.id, REPLACE(t.assigned_to, ' ', '')) > 0),
                       'Employee'
                   ) AS assigned_name,
                   (SELECT MAX(c.created_at) FROM comments c WHERE c.task_id = t.id) AS last_comment_at
            FROM tasks t
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE ${whereClauses.join(' AND ')}
        `).all(...params);

        // Preload active admins per org for escalation alerts
        const adminRows = await db.prepare("SELECT id, organization_id FROM users WHERE role='admin' AND active=1").all();
        const orgAdminsMap = {};
        for (const adm of adminRows) {
            const oid = adm.organization_id || 1;
            if (!orgAdminsMap[oid]) orgAdminsMap[oid] = [];
            orgAdminsMap[oid].push(adm.id);
        }

        let nudgesSent = 0;
        let escalationsSent = 0;

        for (const task of tasks) {
            const ymd = toYMD(task.due_date);
            const deadlineMs = getDeadlineEndOfDayMs(ymd);
            if (!deadlineMs && simulateHoursLeft === null) continue;

            const hoursLeft = simulateHoursLeft !== null
                ? Number(simulateHoursLeft)
                : (deadlineMs - nowMs) / (60 * 60 * 1000);

            // Skip tasks already past deadline (handled by syncOverdue) or > 24h away
            if (hoursLeft <= 0 || hoursLeft > 24) continue;

            const statusLower = String(task.status || '').toLowerCase().trim();
            const isNotStarted = ['pending', 'planned', '0', '4', ''].includes(statusLower);
            const taskLabel = task.task_number ? `#${task.task_number} ${task.title}` : task.title;
            const link = `/tasks/${task.id}`;

            // Collect unique assignee IDs
            const assigneeRows = await db.prepare("SELECT user_id FROM task_assignees WHERE task_id=?").all(task.id);
            const assigneeIds = [...new Set([
                ...String(task.assigned_to || '').split(',').map(x => Number(x.trim())).filter(Boolean),
                ...assigneeRows.map(r => Number(r.user_id)).filter(Boolean)
            ])];

            // 1. 24-Hour Stagnant Task Nudge (still Pending/Planned with <= 24h left)
            if (hoursLeft <= 24 && isNotStarted && !task.nudge_24h_sent) {
                if (assigneeIds.length > 0) {
                    const msg = `👋 Nudge: "${taskLabel}" is due within 24 hours and is still Pending. Are you stuck? Need help?`;
                    await notifications.notifyOnce(assigneeIds.join(','), msg, link, task.created_by);
                }
                await db.prepare('UPDATE tasks SET nudge_24h_sent=1 WHERE id=?').run(task.id);
                nudgesSent++;
            }

            // 2. 4-Hour Risk of Delay Escalation (<= 4h left & no update in last 4h)
            if (hoursLeft <= 4 && !task.escalation_4h_sent) {
                const updatedTime = task.updated_at ? new Date(task.updated_at).getTime() : 0;
                const createdTime = task.created_at ? new Date(task.created_at).getTime() : 0;
                const commentTime = task.last_comment_at ? new Date(task.last_comment_at).getTime() : 0;
                const latestActivityMs = Math.max(updatedTime, createdTime, commentTime);
                const hoursSinceUpdate = latestActivityMs > 0 ? (nowMs - latestActivityMs) / (60 * 60 * 1000) : 999;

                if (ignoreIdleWindow || hoursSinceUpdate >= 4) {
                    const orgAdmins = orgAdminsMap[task.organization_id || 1] || [];
                    const projManagers = String(task.manager_id || '').split(',').map(x => Number(x.trim())).filter(Boolean);
                    const supervisors = [...new Set([
                        Number(task.created_by),
                        ...projManagers,
                        ...orgAdmins
                    ])].filter(uid => uid && !assigneeIds.includes(uid));

                    const supervisorMsg = `🚨 Risk of Delay Detected: "${taskLabel}" (Assigned to ${task.assigned_name}) has under 4 hours left with no recent update.`;
                    if (supervisors.length > 0) {
                        await notifications.notifyOnce(supervisors.join(','), supervisorMsg, link, assigneeIds[0] || task.created_by);
                    }
                    if (assigneeIds.length > 0) {
                        const empMsg = `🚨 Risk of Delay: "${taskLabel}" is due in under 4 hours! Please post an update or flag "I am Blocked".`;
                        await notifications.notifyOnce(assigneeIds.join(','), empMsg, link, task.created_by);
                    }

                    await db.prepare('UPDATE tasks SET escalation_4h_sent=1 WHERE id=?').run(task.id);
                    escalationsSent++;
                }
            }
        }

        return { skipped: false, nudgesSent, escalationsSent };
    } catch (err) {
        console.error('checkSmartEscalations error:', err);
        return { skipped: false, error: err.message, nudgesSent: 0, escalationsSent: 0 };
    }
}

module.exports = {
    checkSmartEscalations
};
