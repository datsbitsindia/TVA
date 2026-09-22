const path = require('path');
const {
    db,
    createTaskAtomic
} = require('../database/init');
const activity = require('../services/activityService');
const notifications = require('../services/notificationService');
const routineService = require('../services/routineService');
const config = require('../config');

const baseQuery = `
    SELECT DISTINCT t.*,
        COALESCE(
            (SELECT name FROM priorities WHERE id = t.priority_id LIMIT 1),
            (SELECT name FROM priorities WHERE normalized_name = LOWER(t.priority) COLLATE utf8mb4_unicode_ci LIMIT 1),
            t.priority, 'Medium'
        ) AS priority,
        COALESCE(
            (SELECT name FROM statuses WHERE id = ta_sub.status_id LIMIT 1),
            (SELECT name FROM statuses WHERE normalized_name = LOWER(CAST(ta_sub.status AS CHAR)) COLLATE utf8mb4_unicode_ci LIMIT 1),
            (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
            (SELECT name FROM statuses WHERE normalized_name = LOWER(CAST(t.status AS CHAR)) COLLATE utf8mb4_unicode_ci LIMIT 1),
            CAST(t.status AS CHAR) COLLATE utf8mb4_unicode_ci, 'Pending'
        ) AS status,
        COALESCE(
            (SELECT name FROM statuses WHERE id = ta_sub.status_id LIMIT 1),
            (SELECT name FROM statuses WHERE normalized_name = LOWER(CAST(ta_sub.status AS CHAR)) COLLATE utf8mb4_unicode_ci LIMIT 1),
            (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
            CAST(t.status AS CHAR) COLLATE utf8mb4_unicode_ci, 'Pending'
        ) AS user_status,
        COALESCE(ta_sub.completed_at, t.completed_at) AS completed_at,
        COALESCE(
            (SELECT GROUP_CONCAT(u.name ORDER BY u.name SEPARATOR ', ') FROM task_assignees ta2 JOIN users u ON u.id=ta2.user_id WHERE ta2.task_id=t.id),
            (SELECT GROUP_CONCAT(u.name ORDER BY u.id SEPARATOR ', ') FROM users u WHERE FIND_IN_SET(u.id, t.assigned_to) > 0),
            a.name
        ) AS assigned_name,
        c.name creator_name, p.name project_name, COALESCE(t.project_id, p.id) AS project_id, p.manager_id, v.name verifier_name,
        CASE WHEN t.due_date<CURDATE() AND COALESCE(
            (SELECT name FROM statuses WHERE id = ta_sub.status_id LIMIT 1),
            (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
            CAST(t.status AS CHAR) COLLATE utf8mb4_unicode_ci, '' COLLATE utf8mb4_unicode_ci
        ) NOT IN ('Completed' COLLATE utf8mb4_unicode_ci,'Cancelled' COLLATE utf8mb4_unicode_ci) THEN 1 ELSE 0 END is_overdue
    FROM tasks t
    LEFT JOIN task_assignees ta_sub ON ta_sub.task_id=t.id AND ta_sub.user_id=?
    LEFT JOIN users a ON a.id=t.assigned_to
    LEFT JOIN users c ON c.id=t.created_by
    LEFT JOIN projects p ON p.id=t.project_id
    LEFT JOIN users v ON v.id=t.verified_by
`;


const canView = async (u, t) => {
    if (u.role === 'admin') return true;
    if (String(t.created_by) === String(u.id)) return true;
    const assignedArr = String(t.assigned_to || '').split(',').map(x => x.trim());
    if (assignedArr.includes(String(u.id))) return true;
    const isAssignee = await db.prepare('SELECT 1 FROM task_assignees WHERE task_id=? AND user_id=?').get(t.id, u.id);
    if (isAssignee) return true;
    const forwardLog = await db.prepare('SELECT 1 FROM task_forward_logs WHERE task_id=? AND (from_user_id=? OR to_user_id=?)').get(t.id, u.id, u.id);
    if (forwardLog) return true;
    return false;
};

const statusRank = (statusStr) => {
    const s = String(statusStr || '').toLowerCase().trim();
    if (s === 'planned' || s === '4') return 1;
    if (s === 'pending' || s === '0') return 2;
    if (s === 'in progress' || s === '1') return 3;
    if (s === 'completed' || s === '2') return 4;
    if (s === 'cancelled' || s === '3') return 5;
    return 6;
};

const priorityRank = (priorityStr) => {
    const p = String(priorityStr || '').toLowerCase().trim();
    if (p === 'critical') return 1;
    if (p === 'high') return 2;
    if (p === 'medium') return 3;
    if (p === 'low') return 4;
    return 5;
};

const getTasksWithPaginationAndCounts = async (req) => {
    const u = req.session.user;
    const orgId = u.organization_id || 1;

    let baseFilter = 't.organization_id=?';
    let baseParams = [orgId];

    if (u.role === 'employee' || u.role === 'manager') {
        baseFilter += ' AND (t.created_by=? OR FIND_IN_SET(?, t.assigned_to) > 0 OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id=?) OR t.id IN (SELECT task_id FROM task_forward_logs WHERE from_user_id=? OR to_user_id=?))';
        baseParams.push(u.id, u.id, u.id, u.id, u.id);
    }

    const taskStatusSql = `COALESCE(
        (SELECT name FROM statuses WHERE id = ta_sub.status_id LIMIT 1),
        (SELECT name FROM statuses WHERE normalized_name = LOWER(CAST(ta_sub.status AS CHAR)) COLLATE utf8mb4_unicode_ci LIMIT 1),
        (SELECT name FROM statuses WHERE id = t.status_id LIMIT 1),
        (SELECT name FROM statuses WHERE normalized_name = LOWER(CAST(t.status AS CHAR)) COLLATE utf8mb4_unicode_ci LIMIT 1),
        CAST(t.status AS CHAR) COLLATE utf8mb4_unicode_ci, 'Pending'
    )`;

    // 1. Calculate overall top KPI counts directly from database
    const kpiCountSql = `
        SELECT 
            COUNT(DISTINCT t.id) AS total,
            COUNT(DISTINCT CASE WHEN LOWER(${taskStatusSql}) IN ('completed', '2') THEN t.id END) AS completed,
            COUNT(DISTINCT CASE WHEN LOWER(${taskStatusSql}) IN ('pending', 'planned', '0', '4') THEN t.id END) AS pending,
            COUNT(DISTINCT CASE WHEN LOWER(${taskStatusSql}) IN ('in progress', '1') THEN t.id END) AS progress,
            COUNT(DISTINCT CASE WHEN t.due_date < CURDATE() AND LOWER(${taskStatusSql}) NOT IN ('completed', 'cancelled', '2', '3') THEN t.id END) AS overdueCount
        FROM tasks t
        LEFT JOIN task_assignees ta_sub ON ta_sub.task_id = t.id AND ta_sub.user_id = ?
        WHERE ${baseFilter}
    `;
    const kpiRow = (await db.prepare(kpiCountSql).get(u.id, ...baseParams)) || {};
    const kpiCounts = {
        total: Number(kpiRow.total || 0),
        completed: Number(kpiRow.completed || 0),
        pending: Number(kpiRow.pending || 0),
        progress: Number(kpiRow.progress || 0),
        overdueCount: Number(kpiRow.overdueCount || 0)
    };

    // 2. Build task list filters
    const filters = [baseFilter];
    const queryParams = [u.id, ...baseParams];

    if (req.query.forwarded === '1') {
        filters.push('t.is_forwarded=1');
    }

    // Filter by KPI status
    if (req.query.status) {
        const val = req.query.status.trim().toLowerCase();
        if (val === 'pending') {
            filters.push(`LOWER(${taskStatusSql}) IN ('pending', 'planned', '0', '4')`);
        } else if (val === 'in progress' || val === 'in-progress') {
            filters.push(`LOWER(${taskStatusSql}) IN ('in progress', '1')`);
        } else if (val === 'completed') {
            filters.push(`LOWER(${taskStatusSql}) IN ('completed', '2')`);
        } else if (val === 'overdue') {
            filters.push(`(t.due_date < CURDATE() AND LOWER(${taskStatusSql}) NOT IN ('completed', 'cancelled', '2', '3'))`);
        } else if (val !== 'all' && val !== '') {
            filters.push(`LOWER(${taskStatusSql}) = ?`);
            queryParams.push(val);
        }
    }

    if (req.query.priority) {
        filters.push("LOWER(t.priority) = ?");
        queryParams.push(req.query.priority.trim().toLowerCase());
    }

    if (req.query.employee) {
        filters.push("FIND_IN_SET(?, t.assigned_to) > 0");
        queryParams.push(req.query.employee.trim().toLowerCase());
    }

    if (req.query.project && req.query.project.toLowerCase() !== 'all projects' && req.query.project.toLowerCase() !== 'all') {
        filters.push("(LOWER(p.name) = ? OR CAST(t.project_id AS CHAR) = ?)");
        const projVal = req.query.project.trim().toLowerCase();
        queryParams.push(projVal, projVal);
    }

    const tab = (req.query.task_tab && req.query.task_tab.trim() !== '') ? req.query.task_tab.trim().toLowerCase() : 'assigned-to-me';
    if (tab === 'assigned-to-me') {
        filters.push("(FIND_IN_SET(?, t.assigned_to) > 0 OR t.id IN (SELECT task_id FROM task_assignees WHERE user_id=?))");
        queryParams.push(u.id, u.id);
    } else if (tab === 'assigned-by-me') {
        filters.push("(t.created_by = ? AND (NOT FIND_IN_SET(?, t.assigned_to) > 0 OR (LENGTH(t.assigned_to) - LENGTH(REPLACE(t.assigned_to, ',', '')) + 1) > 1))");
        queryParams.push(u.id, u.id);
    }

    if (req.query.q) {
        filters.push('(t.title LIKE ? OR t.description LIKE ? OR CAST(t.id AS CHAR) LIKE ? OR CAST(t.task_number AS CHAR) LIKE ?)');
        const qVal = `%${req.query.q.trim()}%`;
        queryParams.push(qVal, qVal, qVal, qVal);
    }

    // Filtered Total Count for Pagination
    const totalFilteredRow = (await db.prepare(`
        SELECT COUNT(DISTINCT t.id) AS count
        FROM tasks t
        LEFT JOIN task_assignees ta_sub ON ta_sub.task_id = t.id AND ta_sub.user_id = ?
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE ` + filters.join(' AND ')
    ).get(...queryParams)) || {};

    const totalFiltered = Number(totalFilteredRow.count || 0);

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const sql = baseQuery + " WHERE " + filters.join(' AND ') + " ORDER BY t.created_at DESC LIMIT " + limit + " OFFSET " + offset;
    const tasks = await db.prepare(sql).all(...queryParams);

    // Apply exact ordering logic expected
    tasks.sort((a, b) => {
        const sA = String(a.status || a.user_status || '').toLowerCase().trim();
        const sB = String(b.status || b.user_status || '').toLowerCase().trim();
        const rA = statusRank(sA);
        const rB = statusRank(sB);
        if (rA !== rB) return rA - rB;

        if (sA === 'completed' || sA === '2') {
            const compA = a.completed_at ? new Date(a.completed_at).getTime() : 0;
            const compB = b.completed_at ? new Date(b.completed_at).getTime() : 0;
            if (compA !== compB) return compB - compA;
        } else {
            const pA = priorityRank(a.priority);
            const pB = priorityRank(b.priority);
            if (pA !== pB) return pA - pB;
        }

        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });

    const hasMore = (page * limit) < totalFiltered;

    return {
        tasks,
        kpiCounts,
        pagination: {
            page,
            limit,
            totalFiltered,
            hasMore
        }
    };
};

exports.listApi = async (req, res) => {
    try {
        const data = await getTasksWithPaginationAndCounts(req);
        res.json({
            success: true,
            tasks: data.tasks,
            kpiCounts: data.kpiCounts,
            pagination: data.pagination
        });
    } catch (err) {
        console.error('listApi error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
};

exports.list = async (req, res) => {
    const u = req.session.user;
    const orgId = u.organization_id || 1;
    
    // Auto sync daily routine tasks for today
    routineService.syncDailyRoutines().catch(e => console.error('syncDailyRoutines bg error:', e));

    const { tasks, kpiCounts, pagination } = await getTasksWithPaginationAndCounts(req);

    const employees = await db.prepare("SELECT id,name,designation FROM users WHERE role='employee' AND active=1 AND (organization_id=? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY name").all(orgId, orgId);
    const managers = await db.prepare("SELECT id,name,designation FROM users WHERE role='manager' AND active=1 AND (organization_id=? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY name").all(orgId, orgId);

    const reportingUsers = await db.prepare("SELECT id,name,role,designation FROM users WHERE role IN ('manager','admin') AND active=1 AND (organization_id=? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY role, name").all(orgId, orgId);
    const projects = await db.prepare("SELECT id,name FROM projects WHERE organization_id=? AND ((status NOT IN (2, 3, '2', '3', 'Completed', 'Cancelled') AND status_id NOT IN (2, 3)) OR name='Self Task') ORDER BY CASE WHEN name='Self Task' THEN 0 ELSE 1 END, name").all(orgId);
    
    let dailyRoutines = [];
    if (u.role === 'manager') {
        dailyRoutines = await db.prepare(`
            SELECT r.*, p.name project_name, u.name assigned_name 
            FROM daily_routines r 
            JOIN projects p ON p.id=r.project_id 
            JOIN users u ON u.id=r.assigned_to 
            WHERE r.created_by=? AND r.organization_id=?
            ORDER BY r.created_at DESC
        `).all(u.id, orgId);
    }

    res.render('tasks', {
        tasks,
        kpiCounts,
        pagination,
        employees,
        managers,
        reportingUsers,
        projects,
        dailyRoutines,
        filters: req.query
    });
};

exports.detail = async (req, res) => {
    const orgId = req.session.user.organization_id || 1;
    const task = await db.prepare(baseQuery + ' WHERE t.id=? AND t.organization_id=?').get(req.session.user.id, req.params.id, orgId);
    if (!task || !(await canView(req.session.user, task))) {
        return res.redirect('/tasks?error=deleted');
    }
    const comments = await db.prepare('SELECT c.*,u.name FROM comments c JOIN users u ON u.id=c.user_id WHERE task_id=? ORDER BY c.created_at').all(task.id);
    const attachments = await db.prepare('SELECT * FROM attachments WHERE task_id=? ORDER BY created_at DESC').all(task.id);
    const employees = await db.prepare("SELECT id,name,designation FROM users WHERE role='employee' AND active=1 AND (organization_id=? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY name").all(orgId, orgId);
    const managers = await db.prepare("SELECT id,name,designation FROM users WHERE role='manager' AND active=1 AND (organization_id=? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY name").all(orgId, orgId);
    const projects = req.session.user.role === 'admin' ? await db.prepare("SELECT id,name FROM projects WHERE organization_id=? ORDER BY name").all(orgId) : await db.prepare("SELECT id,name FROM projects WHERE organization_id=? AND FIND_IN_SET(?, manager_id) > 0 ORDER BY name").all(orgId, req.session.user.id);
    const forwardLogs = await db.prepare(`
        SELECT f.*, ufrom.name as from_name, uto.name as to_name
        FROM task_forward_logs f
        JOIN users ufrom ON ufrom.id = f.from_user_id
        JOIN users uto ON uto.id = f.to_user_id
        WHERE f.task_id = ?
        ORDER BY f.created_at ASC
    `).all(task.id);

    const taskAssignees = await db.prepare(`
        SELECT ta.*,
            u.name, u.role, u.designation,
            COALESCE(
                (SELECT name FROM statuses WHERE id = ta.status_id LIMIT 1),
                (SELECT name FROM statuses WHERE normalized_name = LOWER(CAST(ta.status AS CHAR) COLLATE utf8mb4_unicode_ci) LIMIT 1),
                CASE CAST(ta.status AS CHAR) COLLATE utf8mb4_unicode_ci
                    WHEN 'Pending' THEN 'Pending'
                    WHEN 'In Progress' THEN 'In Progress'
                    WHEN 'Completed' THEN 'Completed'
                    WHEN 'Cancelled' THEN 'Cancelled'
                    ELSE CAST(ta.status AS CHAR) COLLATE utf8mb4_unicode_ci
                END
            ) AS status
        FROM task_assignees ta
        JOIN users u ON u.id=ta.user_id
        WHERE ta.task_id=?
    `).all(task.id);

    // Auto mark notifications for this task as read when user opens the task
    try {
        await db.prepare(
            'UPDATE notifications SET is_read=1 WHERE user_id=? AND (link=? OR link LIKE ?) AND is_read=0'
        ).run(req.session.user.id, `/tasks/${req.params.id}`, `/tasks/${req.params.id}%`);
    } catch(e) {}

    res.render('task-detail', {
        task,
        comments,
        attachments,
        employees,
        managers,
        projects,
        forwardLogs,
        taskAssignees,
        success: req.query.success || ''
    });
};

exports.forward = async (req, res) => {
    try {
        const taskId = Number(req.params.id);
        const toUserId = Number(req.body.to_user_id);
        const reason = String(req.body.reason || '').trim();
        const user = req.session.user;

        if (!taskId || !toUserId) {
            return res.status(400).render('error', { message: 'Invalid task or target colleague selected.' });
        }

        const task = await db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
        if (!task) return res.status(404).render('error', { message: 'Task not found' });

        if (user.role === 'admin') {
            return res.status(403).render('error', { message: 'Admin can only view tasks. Forwarding is disabled in Updates.' });
        }

        const targetUser = await db.prepare("SELECT * FROM users WHERE id=? AND role IN ('employee', 'manager') AND active=1").get(toUserId);
        if (!targetUser) return res.status(400).render('error', { message: 'Selected colleague not found or inactive.' });

        const fromUser = await db.prepare("SELECT name FROM users WHERE id=?").get(user.id);
        const noteText = reason || 'Handover';

        await db.prepare('INSERT INTO task_forward_logs(task_id, from_user_id, to_user_id, reason) VALUES(?,?,?,?)')
            .run(taskId, Number(user.id), Number(targetUser.id), noteText);

        await db.prepare('INSERT IGNORE INTO task_assignees(task_id, user_id, status) VALUES(?,?,?)')
            .run(taskId, Number(targetUser.id), 'Pending');

        const currentAssignees = String(task.assigned_to || '').split(',').filter(Boolean);
        if (!currentAssignees.includes(String(targetUser.id))) {
            currentAssignees.push(String(targetUser.id));
        }
        const updatedAssignedToStr = currentAssignees.join(',');

        await db.prepare('UPDATE tasks SET assigned_to=?, is_forwarded=1, updated_by=? WHERE id=?')
            .run(updatedAssignedToStr, Number(user.id), taskId);

        await activity.log(user.id, 'Task Forwarded', `${fromUser?.name || 'User'} -> ${targetUser.name}: ${task.title}`);

        await notifications.notify(
            targetUser.id,
            `Task Forwarded: ${fromUser?.name || 'User'} has forwarded '${task.title}' to you with note: '${noteText}'`,
            `/tasks/${taskId}`
        );

        res.redirect(`/tasks/${taskId}?success=forwarded`);
    } catch (err) {
        console.error('Task forward error:', err);
        res.status(500).render('error', { message: 'Failed to forward task: ' + err.message });
    }
};

exports.save = async (req, res) => {
  try {
    const {
        id,
        title,
        description = '',
        priority = 'Medium',
        due_date,
        assigned_to,
        report_to,
        estimated_hours = 0,
        project_id
    } = req.body;

    const orgId = req.session.user.organization_id || 1;
    let pid = project_id ? Number(project_id) : null;
    if (!pid) {
        const selfTaskProj = await db.prepare("SELECT id FROM projects WHERE name='Self Task' AND organization_id=? LIMIT 1").get(orgId);
        if (selfTaskProj) pid = selfTaskProj.id;
    }

    if (id) {
        let rawAssignees = [];
        if (Array.isArray(assigned_to)) rawAssignees = assigned_to;
        else if (assigned_to) rawAssignees = String(assigned_to).split(',');
        else rawAssignees = [req.session.user.id];

        const assignees = [...new Set(rawAssignees.map(x => Number(x)).filter(Boolean))];
        const assignedToStr = assignees.join(',');

        if (req.session.user.role === 'admin') {
            return res.status(403).render('error', { message: 'Admin can only view tasks. Task editing is disabled in Updates.' });
        }

        const existingTask = await db.prepare('SELECT t.*, p.manager_id FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?').get(id);
        if (!existingTask) return res.status(404).render('error', { message: 'Task not found' });

        const isAssigneeInList = String(existingTask.assigned_to || '').split(',').map(x => x.trim()).includes(String(req.session.user.id));
        const isAssigneeInTable = await db.prepare('SELECT 1 FROM task_assignees WHERE task_id=? AND user_id=?').get(id, req.session.user.id);
        const canEdit = Number(req.session.user.id) === Number(existingTask.created_by) ||
                       isAssigneeInList || !!isAssigneeInTable;

        if (!canEdit) {
            return res.status(403).render('error', { message: 'Only the task creator, manager, or assigned user can edit this task.' });
        }

        const isSelfTask = assignees.length === 1 && Number(assignees[0]) === Number(req.session.user.id) ? 1 : 0;

        let updPriorityId = 1;
        let updPriorityName = 'Medium';
        try {
            const pVal = String(priority || '').toLowerCase().trim();
            const pRow = await db.prepare('SELECT id, name FROM priorities WHERE normalized_name=? OR id=?').get(pVal, Number(pVal) || -1);
            if (pRow && pRow.id !== undefined) {
                updPriorityId = Number(pRow.id);
                updPriorityName = pRow.name || priority;
            } else {
                updPriorityName = priority; // keep original text if not found in master
            }
        } catch(e) { updPriorityName = priority; }

        await db.prepare('UPDATE tasks SET project_id=?,title=?,description=?,priority=?,priority_id=?,due_date=?,assigned_to=?,estimated_hours=?,is_self_task=?,updated_by=? WHERE id=?').run(
            pid, title, description, updPriorityName, updPriorityId, due_date || null, assignedToStr, Number(estimated_hours) || 0, isSelfTask, Number(req.session.user.id), id
        );

        for (const targetAssignee of assignees) {
            await db.prepare('INSERT IGNORE INTO task_assignees(task_id, user_id) VALUES(?,?)').run(id, targetAssignee);
            await activity.log(req.session.user.id, 'Task Updated', title);
            await notifications.notify(targetAssignee, `Task Updated: ${req.session.user.name} updated task details for '${title}'`, `/tasks/${id}`);
        }
        res.redirect(`/tasks/${id}`);
    } else {
        let rawAssignees = [];
        if (Array.isArray(assigned_to)) {
            rawAssignees = assigned_to;
        } else if (assigned_to) {
            rawAssignees = [assigned_to];
        } else if (req.session.user.role === 'employee') {
            rawAssignees = [req.session.user.id];
        }

        const assignees = [...new Set(rawAssignees.map(x => Number(x)).filter(Boolean))];
        if (!assignees.length) {
            assignees.push(req.session.user.id);
        }

        if (!title) return res.status(400).render('error', { message: 'Task title is required' });

        let createdBy = req.session.user.id;
        if (report_to && Number(report_to)) {
            createdBy = Number(report_to);
        }

        // assigned_to column in tasks table stores all assigned IDs as comma-separated string: "6,7"
        const assignedToStr = assignees.join(',');
        const isSelfTask = assignees.length === 1 && Number(assignees[0]) === Number(req.session.user.id) ? 1 : 0;
        
        let priorityId = 1; // Default Medium (1)
        let priorityName = 'Medium';
        try {
            const pVal = String(priority || '').toLowerCase().trim();
            const priorityRow = await db.prepare('SELECT id, name FROM priorities WHERE normalized_name=? OR id=?').get(pVal, Number(pVal) || -1);
            if (priorityRow && priorityRow.id !== undefined) {
                priorityId = Number(priorityRow.id);
                priorityName = priorityRow.name || priority;
            } else {
                priorityName = priority;
            }
        } catch(e) { priorityName = priority; }

        let statusId = 0; // Default Pending (0)
        let statusName = 'Pending';
        try {
            const statusRow = await db.prepare("SELECT id, name FROM statuses WHERE normalized_name='pending' OR id=0").get();
            if (statusRow && statusRow.id !== undefined) {
                statusId = Number(statusRow.id);
                statusName = statusRow.name || 'Pending';
            }
        } catch(e) {}

        const orgId = req.session.user.organization_id || 1;
        const taskCreationResult = await createTaskAtomic({
            organization_id: orgId,
            project_id: pid,
            title,
            description,
            priority: priorityName,
            priority_id: priorityId,
            status: statusName,
            status_id: statusId,
            due_date: due_date || null,
            created_by: createdBy,
            assigned_to: assignedToStr,
            estimated_hours: Number(estimated_hours) || 0,
            is_self_task: isSelfTask
        });
        const taskId = taskCreationResult.id;

        try {
            if (assignees.length > 1) {
                for (const targetAssignee of assignees) {
                    await db.prepare('INSERT IGNORE INTO task_assignees(task_id, user_id, status, status_id) VALUES(?,?,?,?)').run(taskId, targetAssignee, statusId, statusId);
                    try { await activity.log(req.session.user.id, 'Task Created', title); } catch(e) {}
                    if (Number(targetAssignee) !== Number(req.session.user.id)) {
                        try { await notifications.notify(targetAssignee, `New task assigned: ${title}`, `/tasks/${taskId}`); } catch(e) {}
                    }
                }
            } else {
                const singleAssignee = assignees[0];
                try { await activity.log(req.session.user.id, 'Task Created', title); } catch(e) {}
                if (Number(singleAssignee) !== Number(req.session.user.id)) {
                    try { await notifications.notify(singleAssignee, `New task assigned: ${title}`, `/tasks/${taskId}`); } catch(e) {}
                }
            }
        } catch(e) {
            console.error('Task notification error:', e);
        }

        return res.redirect(`/tasks/${taskId}`);
    }
  } catch(saveErr) {
    console.error('Task save error:', saveErr);
    return res.status(500).render('error', { message: 'Failed to save task: ' + saveErr.message });
  }
};




exports.saveRoutine = async (req, res) => {
    const {
        project_id,
        title,
        description = '',
        priority = 'High',
        assigned_to,
        estimated_hours = 0,
        start_date,
        end_date,
        daily_time = '09:00 AM',
        mandatory = 1
    } = req.body;

    const pid = project_id ? Number(project_id) : null;
    let rawAssignees = [];
    if (Array.isArray(assigned_to)) {
        rawAssignees = assigned_to;
    } else if (assigned_to) {
        rawAssignees = [assigned_to];
    }
    const assignees = [...new Set(rawAssignees.map(x => Number(x)).filter(Boolean))];

    if (!title || !assignees.length || !start_date || !end_date) {
        return res.status(400).render('error', {
            message: 'At least one assignee, title, start date and end date are required for daily routine task.'
        });
    }

    const priorityMap = { 'Low': 0, 'Medium': 1, 'High': 2, 'Critical': 3 };
    const priorityInt = priorityMap[priority] ?? 2; // Default to 2 (High)

    const orgId = req.session.user.organization_id || 1;
    for (const assigneeId of assignees) {
        await db.prepare(`
            INSERT INTO daily_routines
            (project_id, created_by, assigned_to, title, description, priority, priority_id, estimated_hours, start_date, end_date, daily_time, mandatory, active, organization_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `).run(
            pid,
            req.session.user.id,
            assigneeId,
            title,
            description,
            priorityInt,
            priorityInt,
            Number(estimated_hours) || 0,
            start_date,
            end_date,
            daily_time,
            mandatory ? 1 : 0,
            orgId
        );

        await activity.log(req.session.user.id, 'Daily Routine Created', title);
        await notifications.notify(assigneeId, `New Daily Routine assigned: ${title} (${start_date} to ${end_date})`, '/tasks');
    }

    await routineService.syncDailyRoutines();
    res.redirect('/tasks');
};

exports.toggleRoutine = async (req, res) => {
    const routine = await db.prepare('SELECT * FROM daily_routines WHERE id=? AND created_by=?').get(req.params.id, req.session.user.id);
    if (!routine) return res.status(404).render('error', { message: 'Daily Routine not found' });
    await db.prepare('UPDATE daily_routines SET active=? WHERE id=?').run(routine.active ? 0 : 1, routine.id);
    res.redirect('/tasks');
};

exports.deleteRoutine = async (req, res) => {
    const routine = await db.prepare('SELECT * FROM daily_routines WHERE id=? AND created_by=?').get(req.params.id, req.session.user.id);
    if (!routine) return res.status(404).render('error', { message: 'Daily Routine not found' });
    await db.prepare('DELETE FROM daily_routine_logs WHERE routine_id=?').run(routine.id);
    await db.prepare('DELETE FROM tasks WHERE routine_id=?').run(routine.id);
    await db.prepare('DELETE FROM daily_routines WHERE id=?').run(routine.id);
    res.redirect('/tasks');
};

exports.status = async (req, res) => {
    try {
        const task = await db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
        if (!task || !(await canView(req.session.user, task))) return res.status(403).render('error', {
            message: 'Only assigned users or admin can update this task status'
        });
        if (!['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(req.body.status)) return res.status(400).render('error', {
            message: 'Invalid status'
        });

        const newStatusStr = req.body.status;
        const myStatusRow = await db.prepare('SELECT id, name FROM statuses WHERE normalized_name=?').get(String(newStatusStr).toLowerCase());
        const myStatusId = (myStatusRow && myStatusRow.id !== undefined) ? Number(myStatusRow.id) : 0;
        const myStatusName = myStatusRow ? myStatusRow.name : newStatusStr;

        // Update specific assignee status in junction table
        await db.prepare('INSERT INTO task_assignees(task_id, user_id, status, status_id, completed_at) VALUES(?,?,?,?,CASE WHEN ?=2 THEN NOW() ELSE NULL END) ON DUPLICATE KEY UPDATE status=?, status_id=?, completed_at=CASE WHEN ?=2 THEN NOW() ELSE NULL END')
            .run(task.id, req.session.user.id, myStatusId, myStatusId, myStatusId, myStatusId, myStatusId, myStatusId);

        // Calculate overall task completion status for multi-assignees or single assignee
        const assignedUserIds = String(task.assigned_to || '').split(',').map(x => Number(x.trim())).filter(Boolean);
        let overallStatusId = myStatusId;

        if (assignedUserIds.length > 1) {
            const stats = await db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status=2 OR status_id=2 THEN 1 ELSE 0 END) completed FROM task_assignees WHERE task_id=?").get(task.id);
            const total = stats ? Number(stats.total) : 0;
            const completed = stats ? Number(stats.completed) : 0;
            const isAllCompleted = total > 0 && total === completed;
            overallStatusId = isAllCompleted ? 2 : 1;
        }

        // Resolve overall status name from id
        const overallStatusRow = await db.prepare('SELECT name FROM statuses WHERE id=? LIMIT 1').get(overallStatusId);
        const overallStatusName = overallStatusRow ? overallStatusRow.name : (overallStatusId === 2 ? 'Completed' : (overallStatusId === 1 ? 'In Progress' : 'Pending'));

        await db.prepare("UPDATE tasks SET status=?, status_id=?, completed_at=CASE WHEN ?=2 THEN NOW() ELSE NULL END, is_verified=CASE WHEN ?=2 THEN is_verified ELSE 0 END, verified_by=CASE WHEN ?=2 THEN verified_by ELSE NULL END, verified_at=CASE WHEN ?=2 THEN verified_at ELSE NULL END, updated_by=? WHERE id=?")
            .run(overallStatusName, overallStatusId, overallStatusId, overallStatusId, overallStatusId, overallStatusId, req.session.user.id, task.id);

        if (task.is_routine) {
            try { await routineService.updateRoutineLogStatus(task.id, overallStatusName); } catch(e) {}
        }

        try { await activity.log(req.session.user.id, myStatusName === 'Completed' ? 'Task Completed' : 'Task Updated', task.title); } catch(e) {}
        // Notify creator (only if commenter is not the creator themselves)
        if (Number(task.created_by) !== Number(req.session.user.id)) {
            try { await notifications.notify(task.created_by, `${req.session.user.name} changed status of ${task.title} to ${myStatusName}`, `/tasks/${task.id}`); } catch(e) {}
        }

        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.json({
                success: true,
                overallStatus: overallStatusName,
                myStatus: myStatusName
            });
        }

        res.redirect(`/tasks/${task.id}?success=status`);
    } catch (err) {
        console.error('Task status update error:', err);
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.status(500).render('error', { message: 'Failed to update task status: ' + err.message });
    }
};

exports.verify = async (req, res) => {
    try {
        const u = req.session.user;
        const orgId = u.organization_id || 1;
        const task = await db.prepare(baseQuery + ' WHERE t.id=? AND t.organization_id=?').get(u.id, req.params.id, orgId);

        if (!task) return res.status(404).render('error', { message: 'Task not found' });

        const isCreator = Number(task.created_by) === Number(u.id);
        const assignedUserIds = String(task.assigned_to || '').split(',').map(x => Number(x.trim())).filter(Boolean);
        const isAssignedToMe = assignedUserIds.includes(Number(u.id));
        const isAdmin = u.role === 'admin';
        const managerIds = String(task.manager_id || '').split(',').map(x => Number(x.trim()));
        const isProjectManager = managerIds.includes(Number(u.id));
        const isManagerReviewer = (u.role === 'manager' || isProjectManager) && !isAssignedToMe;
        const canVerify = isAdmin || isCreator || isManagerReviewer;

        if (!canVerify) {
            return res.status(403).render('error', { message: 'Only creator, independent manager, or admin can verify this task. Assignees cannot verify their own task.' });
        }

        const action = req.body.action || 'verify';
        if (action === 'unverify') {
            await db.prepare('UPDATE tasks SET is_verified=0, verified_by=NULL, verified_at=NULL, updated_by=? WHERE id=?')
                .run(u.id, task.id);
            try { await activity.log(u.id, 'Task Unverified', task.title); } catch(e) {}
        } else {
            await db.prepare('UPDATE tasks SET is_verified=1, verified_by=?, verified_at=NOW(), updated_by=? WHERE id=?')
                .run(u.id, u.id, task.id);
            try { await activity.log(u.id, 'Task Verified', task.title); } catch(e) {}

            // Notify assignees
            const assignees = String(task.assigned_to || '').split(',').map(x => Number(x.trim())).filter(Boolean);
            for (const uid of assignees) {
                if (uid !== u.id) {
                    try {
                        await notifications.notify(uid, `Task Verified: ${u.name} verified '${task.title}'`, `/tasks/${task.id}`);
                    } catch(e) {}
                }
            }
        }

        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.json({
                success: true,
                is_verified: action === 'verify' ? 1 : 0,
                verifier_name: u.name,
                verified_at: new Date().toISOString()
            });
        }

        res.redirect(`/tasks/${task.id}?success=${action === 'verify' ? 'verified' : 'unverified'}`);
    } catch (err) {
        console.error('Task verify error:', err);
        if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.status(500).render('error', { message: 'Failed to verify task: ' + err.message });
    }
};

exports.comment = async (req, res) => {
    const task = await db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    const message = String(req.body.message || '').trim();
    if (!task || !(await canView(req.session.user, task)) || !message) return res.status(403).render('error', {
        message: 'Not allowed'
    });
    const result = await db.prepare('INSERT INTO comments(task_id,user_id,message) VALUES(?,?,?)').run(task.id, req.session.user.id, message);
    await activity.log(req.session.user.id, 'Comment Added', task.title);
    // Notify everyone on the task (creator + all assignees) except the person who commented
    const commenterId = Number(req.session.user.id);
    const notifyIds = new Set();
    if (Number(task.created_by) !== commenterId) notifyIds.add(Number(task.created_by));
    String(task.assigned_to || '').split(',').map(x => Number(x.trim())).filter(Boolean).forEach(uid => {
        if (uid !== commenterId) notifyIds.add(uid);
    });
    if (notifyIds.size > 0) {
        await notifications.notify([...notifyIds].join(','), `New comment on: ${task.title}`, `/tasks/${task.id}`);
    }

    if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest' || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.json({
            success: true,
            comment: {
                id: result.lastInsertRowid,
                user_id: req.session.user.id,
                name: req.session.user.name,
                message: message,
                created_at: new Date()
            }
        });
    }

    res.redirect(`/tasks/${task.id}?success=comment`);
};


exports.upload = async (req, res) => {
    const task = await db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
    if (!task || !(await canView(req.session.user, task)) || !req.file) return res.status(400).render('error', {
        message: 'Upload failed'
    });
    await db.prepare('INSERT INTO attachments(task_id,user_id,original_name,stored_name) VALUES(?,?,?,?)').run(task.id, req.session.user.id, req.file.originalname, req.file.filename);
    res.redirect(`/tasks/${task.id}?success=comment`);
};

exports.download = async (req, res) => {
    const attachment = await db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.id);
    if (!attachment) return res.status(404).render('error', { message: 'File not found' });
    const task = await db.prepare('SELECT * FROM tasks WHERE id=?').get(attachment.task_id);
    if (!task || !(await canView(req.session.user, task))) return res.status(404).render('error', {
        message: 'File not found'
    });
    res.download(path.join(config.uploadDir, attachment.stored_name), attachment.original_name);
};

exports.duplicate = async (req, res) => res.status(403).render('error', {
    message: 'Duplicate is disabled'
});

exports.remove = async (req, res) => {
    const taskId = req.params.id;
    const task = await db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) return res.status(404).render('error', { message: 'Task not found' });
    
    if (req.session.user.role === 'admin') {
        return res.status(403).render('error', { message: 'Admin can only view tasks. Task deletion is disabled in Updates.' });
    }

    const canDelete = req.session.user.id === task.created_by ||
                      String(task.assigned_to || '').split(',').includes(String(req.session.user.id));

    if (!canDelete) {
        return res.status(403).render('error', { message: 'Only the task creator, manager, or assigned user can delete this task.' });
    }

    // Delete comments, attachments & assignees
    await db.prepare('DELETE FROM task_assignees WHERE task_id=?').run(taskId);
    await db.prepare('DELETE FROM comments WHERE task_id=?').run(taskId);
    await db.prepare('DELETE FROM attachments WHERE task_id=?').run(taskId);
    await db.prepare('DELETE FROM tasks WHERE id=?').run(taskId);

    await activity.log(req.session.user.id, 'Task Deleted', task.title);

    const assigneesList = String(task.assigned_to || '').split(',').filter(Boolean);
    for (const uid of assigneesList) {
        await notifications.notify(
            uid,
            `Task Deleted: ${req.session.user.name} has deleted the task "${task.title}".`,
            '/tasks'
        );
    }

    res.redirect('/tasks');
};