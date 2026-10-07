const { db } = require('../database/init');

exports.list = async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'admin') {
        return res.status(403).render('error', { message: 'Access denied. Admin only.' });
    }

    const orgId = user.organization_id || 1;

    const {
        date_filter = 'today',
        start_date = '',
        end_date = '',
        project_id = '',
        status = ''
    } = req.query;

    let whereClause = "WHERE t.organization_id = ? AND (a.role IN ('manager', 'employee') OR a.role IS NULL)";
    let params = [orgId];

    // Date Filter logic
    if (date_filter === 'today') {
        whereClause += " AND (DATE(t.created_at) = CURDATE() OR DATE(t.due_date) = CURDATE())";
    } else if (date_filter === 'yesterday') {
        whereClause += " AND (DATE(t.created_at) = SUBDATE(CURDATE(), INTERVAL 1 DAY) OR DATE(t.due_date) = SUBDATE(CURDATE(), INTERVAL 1 DAY))";
    } else if (date_filter === 'last_week') {
        whereClause += " AND t.created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
    } else if (date_filter === 'custom' && start_date && end_date) {
        whereClause += " AND (DATE(t.created_at) BETWEEN ? AND ? OR DATE(t.due_date) BETWEEN ? AND ?)";
        params.push(start_date, end_date, start_date, end_date);
    }

    // Project sub-filter
    if (project_id) {
        whereClause += " AND t.project_id = ?";
        params.push(Number(project_id));
    }

    // Status sub-filter
    if (status) {
        const cleanStatus = status.trim().toLowerCase();
        if (cleanStatus === 'overdue') {
            whereClause += " AND t.due_date < CURDATE() AND t.status NOT IN ('Completed', 'Cancelled', '2', '3')";
        } else if (cleanStatus === 'pending') {
            whereClause += " AND LOWER(CAST(t.status AS CHAR)) IN ('pending', 'planned', '0', '4')";
        } else {
            whereClause += " AND LOWER(CAST(t.status AS CHAR)) = ?";
            params.push(cleanStatus);
        }
    }

    const sql = `
        SELECT 
            t.*,
            COALESCE(
                (SELECT GROUP_CONCAT(u.name ORDER BY u.name SEPARATOR ', ') FROM task_assignees ta2 JOIN users u ON u.id=ta2.user_id WHERE ta2.task_id=t.id),
                (SELECT GROUP_CONCAT(u.name ORDER BY u.id SEPARATOR ', ') FROM users u WHERE FIND_IN_SET(u.id, t.assigned_to) > 0),
                a.name, 'Unassigned'
            ) AS assigned_name,
            COALESCE(a.role, 'employee') AS assigned_role,
            a.department AS assigned_dept,
            c.name AS creator_name,
            c.role AS creator_role,
            p.name AS project_name,
            CASE WHEN t.due_date < CURDATE() AND t.status NOT IN ('Completed','Cancelled','2','3') THEN 1 ELSE 0 END AS is_overdue
        FROM tasks t
        LEFT JOIN users a ON a.id = t.assigned_to
        LEFT JOIN users c ON c.id = t.created_by
        LEFT JOIN projects p ON p.id = t.project_id
        ${whereClause}
        ORDER BY t.created_at DESC
    `;

    const tasks = await db.prepare(sql).all(...params);
    const projects = await db.prepare("SELECT id, name FROM projects WHERE organization_id=? ORDER BY CASE WHEN name='Self Task' THEN 0 ELSE 1 END, name").all(orgId);
    const users = await db.prepare("SELECT id, name, role, designation FROM users WHERE active=1 AND (organization_id=? OR id IN (SELECT user_id FROM user_organizations WHERE organization_id=?)) ORDER BY name ASC").all(orgId, orgId);

    res.render('updates', {
        tasks,
        projects,
        users,
        date_filter,
        start_date,
        end_date,
        project_id,
        status
    });
};
